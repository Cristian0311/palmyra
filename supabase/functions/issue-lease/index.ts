import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildLeasePayload, signLeasePayload, uuidv4 } from "./lease.ts";
import { inferBillingMonths, isPlanCode } from "./policy.ts";

/**
 * issue-lease: emite un lease firmado ES256 para el dispositivo autenticado.
 *
 * Flujo: CORS + POST -> JWT del usuario -> membresía activa en la empresa ->
 * plan vigente en public.subscriptions/public.plans -> revocación vigente del
 * equipo -> cupo de emisión -> seq del equipo -> insert en public.license_leases
 * -> lease firmado con LEASE_PRIVATE_JWK.
 *
 * Secretos requeridos: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * LEASE_PRIVATE_JWK (JWK EC P-256 privada en JSON) y LEASE_KEY_ID.
 * Nunca se registran ni se devuelven tokens ni claves.
 *
 * Rechazos: 401 sin JWT válido; 403 sin membresía, empresa suspendida o equipo
 * revocado; 409 plan inactivo / pago vencido / plan no soportado; 429 cupo de
 * emisión por equipo; 503 conflicto de secuencia tras los reintentos.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Tope de emisiones por equipo y hora (el cliente renueva como mucho cada 12 h). */
const MAX_ISSUES_PER_HOUR = 20;
/** Ventana de leases del equipo que se cruza con las revocaciones. */
const REVOCATION_LOOKBACK = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^[\w.:-]{1,128}$/;
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
/** Identificador público de la clave de firma; solo para rotación, nunca un secreto. */
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // El SDK de Supabase (supabaseFetch) manda `Cache-Control` y `Pragma` en cada
  // petición; ninguna es cabecera segura para CORS, así que el preflight las
  // rechazaba y el navegador nunca llegaba a POSTear: por eso jamás se emitió
  // un lease desde la app. Deben estar en la lista.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
};

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function getServiceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch {
      /* clave malformada: se intenta la variable clásica */
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

function getPublishableKey(): string {
  const direct = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (direct) return direct;
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed.default || Object.values(parsed)[0] || "";
    } catch {
      /* sin clave publicable: la autenticación fallará con 401 */
    }
  }
  return "";
}

function toMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Ventana vigente, espejo de private.company_has_plan_feature: estado del plan,
 * periodo pagado, prueba o gracia. El plan debe existir y estar activo (trial no
 * emite leases).
 */
function isPlanWindowOpen(
  subscription: Record<string, unknown>,
  planActive: unknown,
  nowMs: number
): boolean {
  if (planActive !== true) return false;
  const status = String(subscription.status || "");
  const periodEnd = toMs(subscription.current_period_end);
  const trialEnd = toMs(subscription.trial_ends_at);
  const graceEnd = toMs(subscription.grace_ends_at);
  const paidUntil = Math.max(trialEnd ?? -Infinity, periodEnd ?? -Infinity);

  if (status === "active" && (periodEnd === null || periodEnd > nowMs)) return true;
  if (status === "trialing" && paidUntil > nowMs) return true;
  if (status === "active" || status === "trialing" || status === "past_due") {
    const effectiveGrace = graceEnd ?? (Number.isFinite(paidUntil) ? paidUntil + 2 * DAY_MS : null);
    if (effectiveGrace !== null && effectiveGrace > nowMs) return true;
  }
  return false;
}

async function readPrivateKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("LEASE_PRIVATE_JWK") || "";
  if (!raw.trim()) throw new Error("lease_private_jwk_missing");
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new Error("lease_private_jwk_malformed");
  }
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error("lease_private_jwk_malformed");
  }
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign"
  ]);
}

type ServiceClient = ReturnType<typeof createClient>;

/**
 * Siguiente secuencia del EQUIPO. El índice único real es
 * (company_id, device_id, seq), así que la secuencia es monótona por
 * dispositivo y no se pisa entre equipos de la misma empresa.
 */
async function nextSeq(admin: ServiceClient, companyId: string, deviceId: string): Promise<number> {
  const { data, error } = await admin
    .from("license_leases")
    .select("seq")
    .eq("company_id", companyId)
    .eq("device_id", deviceId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`license_leases_seq_failed: ${error.message}`);
  const last = typeof data?.seq === "number" ? data.seq : 0;
  return last + 1;
}

/**
 * Una revocación administrativa mata el equipo, no solo el lease concreto:
 * mientras exista una revocación sobre cualquiera de sus leases recientes, no se
 * emiten leases nuevos. Levantar el bloqueo exige borrar la revocación con
 * service_role (decisión explícita de plataforma).
 *
 * Se consulta primero el sello `revoked_at` del propio lease (una sola fila) y
 * después la tabla de revocaciones, por si el sellado best-effort de
 * revoke-lease no llegó a escribirse.
 */
async function deviceHasRevocation(
  admin: ServiceClient,
  companyId: string,
  deviceId: string
): Promise<boolean> {
  const { data: stamped, error: stampedError } = await admin
    .from("license_leases")
    .select("id")
    .eq("company_id", companyId)
    .eq("device_id", deviceId)
    .not("revoked_at", "is", null)
    .limit(1);
  if (stampedError) throw new Error(`license_leases_revocation_lookup_failed: ${stampedError.message}`);
  if (Array.isArray(stamped) && stamped.length > 0) return true;

  const { data: leases, error } = await admin
    .from("license_leases")
    .select("id")
    .eq("company_id", companyId)
    .eq("device_id", deviceId)
    .order("issued_at", { ascending: false })
    .limit(REVOCATION_LOOKBACK);
  if (error) throw new Error(`license_leases_revocation_lookup_failed: ${error.message}`);

  const leaseIds = ((leases ?? []) as Array<{ id?: unknown }>)
    .map((row) => (typeof row?.id === "string" ? row.id : ""))
    .filter((id: string) => UUID_RE.test(id));
  if (leaseIds.length === 0) return false;

  const { data: revocations, error: revocationError } = await admin
    .from("license_revocations")
    .select("lease_id")
    .in("lease_id", leaseIds)
    .limit(1);
  if (revocationError) throw new Error(`license_revocations_lookup_failed: ${revocationError.message}`);
  return Array.isArray(revocations) && revocations.length > 0;
}

/** Cupo de emisión por equipo y hora: evita inundar el historial de leases. */
async function recentIssueCount(
  admin: ServiceClient,
  companyId: string,
  deviceId: string,
  sinceIso: string
): Promise<number> {
  const { count, error } = await admin
    .from("license_leases")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("device_id", deviceId)
    .gte("issued_at", sinceIso);
  if (error) throw new Error(`license_leases_rate_failed: ${error.message}`);
  return typeof count === "number" ? count : 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "authentication_required" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") || "";
  const publishable = getPublishableKey();
  const secret = getServiceKey();
  if (!url || !secret) return json({ error: "server_not_configured" }, 500);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId.trim() : "";
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  const devicePubKeyFp =
    typeof body?.devicePubKeyFp === "string" ? body.devicePubKeyFp.trim() : "";
  if (!UUID_RE.test(companyId)) return json({ error: "invalid_company_id" }, 400);
  if (!DEVICE_ID_RE.test(deviceId)) return json({ error: "invalid_device_id" }, 400);
  if (!FINGERPRINT_RE.test(devicePubKeyFp)) return json({ error: "invalid_device_fingerprint" }, 400);

  try {
    // 1. Identidad: el JWT del usuario se valida contra Supabase Auth.
    const userClient = createClient(url, publishable || secret, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } }
    });
    const { data: callerData, error: callerError } = await userClient.auth.getUser();
    const caller = callerData?.user;
    if (callerError || !caller) return json({ error: "authentication_required" }, 401);

    const admin = createClient(url, secret, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 2. Pertenencia: misma tabla que usan las políticas RLS (company_memberships).
    const { data: membership, error: membershipError } = await admin
      .from("company_memberships")
      .select("is_owner,status")
      .eq("company_id", companyId)
      .eq("user_id", caller.id)
      .maybeSingle();
    if (membershipError) return json({ error: "server_error" }, 500);
    if (!membership || membership.status !== "active") {
      return json({ error: "permission_denied" }, 403);
    }

    const { data: company, error: companyError } = await admin
      .from("companies")
      .select("id,active,account_status")
      .eq("id", companyId)
      .maybeSingle();
    if (companyError) return json({ error: "server_error" }, 500);
    if (!company || company.active !== true || company.account_status === "suspended") {
      return json({ error: "company_access_denied" }, 403);
    }

    // 3. Plan vigente: subscriptions + plans (misma fuente que loadSaaSContext).
    const { data: subscription, error: subscriptionError } = await admin
      .from("subscriptions")
      .select("status,plan_id,current_period_end,trial_ends_at,grace_ends_at,updated_at")
      .eq("company_id", companyId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (subscriptionError) return json({ error: "server_error" }, 500);
    if (!subscription) return json({ error: "plan_not_active" }, 409);

    const { data: plan, error: planError } = await admin
      .from("plans")
      .select("code,active")
      .eq("id", subscription.plan_id)
      .maybeSingle();
    if (planError) return json({ error: "server_error" }, 500);

    const nowMs = Date.now();
    if (!plan || !isPlanWindowOpen(subscription, plan.active, nowMs)) {
      return json({ error: "plan_not_active" }, 409);
    }
    if (!isPlanCode(plan.code)) return json({ error: "plan_not_supported" }, 409);
    const planCode = plan.code;

    const issuedAt = new Date(nowMs).toISOString();
    const periodEndIso =
      typeof subscription.current_period_end === "string"
        ? subscription.current_period_end
        : null;

    let billingMonths = 0;
    let paidThrough: string | undefined;
    if (planCode !== "free") {
      if (periodEndIso) {
        // Un periodo ya vencido (aunque esté en gracia) no emite lease nuevo.
        const periodEndMs = Date.parse(periodEndIso);
        if (!Number.isFinite(periodEndMs) || periodEndMs <= nowMs) {
          return json({ error: "plan_payment_required" }, 409);
        }
        paidThrough = periodEndIso;
        billingMonths = inferBillingMonths(issuedAt, periodEndIso);
      } else {
        // Plan de pago sin fin de periodo (registro legado): mes en curso.
        billingMonths = 1;
      }
    }

    const keyId = (Deno.env.get("LEASE_KEY_ID") || "").trim();
    if (!KEY_ID_RE.test(keyId)) return json({ error: "server_not_configured" }, 500);

    // 4. Revocación administrativa: bloquea cualquier emisión nueva del equipo.
    if (await deviceHasRevocation(admin, companyId, deviceId)) {
      return json({ error: "device_revoked" }, 403);
    }

    // 5. Cupo de emisión por equipo y hora.
    const recent = await recentIssueCount(
      admin,
      companyId,
      deviceId,
      new Date(nowMs - HOUR_MS).toISOString()
    );
    if (recent >= MAX_ISSUES_PER_HOUR) {
      return json({ error: "rate_limited", retryAfterSeconds: 600 }, 429);
    }

    let privateKey: CryptoKey;
    try {
      privateKey = await readPrivateKey();
    } catch {
      return json({ error: "server_not_configured" }, 500);
    }

    // 6. secuencia por equipo con reintento ante carrera de unique(company,device,seq).
    let signed: Awaited<ReturnType<typeof signLeasePayload>> | null = null;
    for (let attempt = 0; attempt < 3 && !signed; attempt += 1) {
      const seq = await nextSeq(admin, companyId, deviceId);
      const payload = buildLeasePayload({
        leaseId: uuidv4(),
        companyId,
        deviceId,
        devicePubKeyFp,
        planCode,
        billingMonths,
        issuedAt,
        paidThrough,
        seq,
        keyId
      });
      const candidate = await signLeasePayload(payload, privateKey);

      const { error: insertError } = await admin.from("license_leases").insert({
        id: payload.leaseId,
        company_id: payload.companyId,
        device_id: payload.deviceId,
        device_pubkey_fp: payload.devicePubKeyFp,
        plan_code: payload.planCode,
        billing_months: payload.billingMonths,
        seq: payload.seq,
        payload,
        signature: candidate.signature,
        issued_at: payload.issuedAt,
        expires_at: payload.expiresAt,
        created_by: caller.id
      });
      if (!insertError) {
        signed = candidate;
        break;
      }
      if (insertError.code !== "23505") {
        return json({ error: "server_error" }, 500);
      }
    }
    if (!signed) return json({ error: "lease_conflict" }, 503);

    return json({ lease: signed }, 200);
  } catch (error) {
    // Sin datos del request ni credenciales en el log.
    console.error("[issue-lease] error interno", error instanceof Error ? error.name : "unknown");
    return json({ error: "server_error" }, 500);
  }
});
