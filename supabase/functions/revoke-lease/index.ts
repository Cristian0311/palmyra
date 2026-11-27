import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * revoke-lease: consulta pública de revocación y revocación administrativa.
 *
 * GET  /revoke-lease?leaseId=...   -> público, sin datos personales.
 *      { revoked: boolean, revokedAt?, reason? }
 * POST /revoke-lease               -> solo service_role o admin de plataforma.
 *      body { leaseId, companyId?, reason? } -> idempotente + auditoría.
 *
 * Secretos requeridos: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (o
 * SUPABASE_SECRET_KEYS). Nunca se registran tokens ni claves.
 *
 * Rechazos del POST: 400 leaseId/companyId inválidos; 403 sin service_role ni
 * admin de plataforma; 404 lease sin empresa resoluble; 409 companyId no
 * coincide con el lease. La revocación es idempotente (unique lease_id).
 */

const MAX_REASON_LENGTH = 200;
const LEASE_ID_RE = /^[\w.:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

/**
 * Motivo acotado y sin caracteres de control: se guarda en
 * license_revocations y en la auditoría de plataforma.
 */
function sanitizeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text ? text.slice(0, MAX_REASON_LENGTH) : null;
}

function normalizeLeaseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const leaseId = value.trim();
  return LEASE_ID_RE.test(leaseId) ? leaseId : null;
}

async function handleGet(req: Request, admin: ReturnType<typeof createClient>): Promise<Response> {
  const leaseId = normalizeLeaseId(new URL(req.url).searchParams.get("leaseId"));
  if (!leaseId) return json({ revoked: false }, 200);

  const { data, error } = await admin
    .from("license_revocations")
    .select("revoked_at,reason")
    .eq("lease_id", leaseId)
    .maybeSingle();

  // Error de servidor: no se puede afirmar revocación; el cliente falla abierto.
  if (error) return json({ revoked: false }, 200);
  if (!data) return json({ revoked: false }, 200);

  return json({
    revoked: true,
    revokedAt: data.revoked_at ?? undefined,
    reason: data.reason ?? undefined
  });
}

/** Comparación en tiempo constante: no filtra el prefijo de la clave. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function isServiceRoleCaller(req: Request, serviceKey: string): Promise<boolean> {
  const header = req.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ") || !serviceKey) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  // La comparación no registra ni devuelve el token.
  return safeEqual(token, serviceKey);
}

async function resolvePlatformAdmin(
  req: Request,
  url: string,
  publishable: string,
  admin: ReturnType<typeof createClient>
): Promise<string | null> {
  const header = req.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;

  const userClient = createClient(url, publishable, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: header } }
  });
  const { data, error } = await userClient.auth.getUser();
  const caller = data?.user;
  if (error || !caller) return null;

  const { data: platformAdmin, error: adminError } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", caller.id)
    .maybeSingle();
  if (adminError || !platformAdmin) return null;
  return caller.id;
}

async function handlePost(
  req: Request,
  url: string,
  publishable: string,
  serviceKey: string,
  admin: ReturnType<typeof createClient>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const leaseId = normalizeLeaseId(body?.leaseId);
  if (!leaseId) return json({ error: "invalid_lease_id" }, 400);

  const bodyCompanyId = typeof body?.companyId === "string" ? body.companyId.trim() : "";

  // 1. Autorización: service_role o admin de plataforma.
  const serviceCaller = await isServiceRoleCaller(req, serviceKey);
  let actorId: string | null = null;
  if (!serviceCaller) {
    actorId = await resolvePlatformAdmin(req, url, publishable || serviceKey, admin);
    if (!actorId) return json({ error: "permission_denied" }, 403);
  }

  // 2. Empresa del lease: la del cuerpo (validada) o la guardada en el lease.
  let companyId = bodyCompanyId;
  const { data: lease, error: leaseError } = await admin
    .from("license_leases")
    .select("company_id")
    .eq("id", leaseId)
    .maybeSingle();
  if (leaseError && UUID_RE.test(leaseId)) return json({ error: "server_error" }, 500);
  const leaseCompanyId = typeof lease?.company_id === "string" ? lease.company_id : null;

  if (companyId) {
    if (!UUID_RE.test(companyId)) return json({ error: "invalid_company_id" }, 400);
    // Un admin de plataforma no puede revocar un lease de otra empresa.
    if (leaseCompanyId && leaseCompanyId !== companyId) {
      return json({ error: "company_mismatch" }, 409);
    }
  } else if (leaseCompanyId) {
    companyId = leaseCompanyId;
  }

  if (!companyId) return json({ error: "lease_not_found" }, 404);

  const reason = sanitizeReason(body?.reason);

  // 3. Revocación idempotente (unique lease_id).
  const { error: insertError } = await admin.from("license_revocations").upsert(
    {
      lease_id: leaseId,
      company_id: companyId,
      reason,
      revoked_at: new Date().toISOString()
    },
    { onConflict: "lease_id", ignoreDuplicates: true }
  );
  if (insertError) return json({ error: "server_error" }, 500);

  // 4. Sellar el lease emitido, si existe (best-effort, no bloquea la revocación).
  //    Se acota por empresa para no tocar filas de otra empresa.
  if (UUID_RE.test(leaseId)) {
    await admin
      .from("license_leases")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .eq("id", leaseId)
      .eq("company_id", companyId);
  }

  // 5. Auditoría de plataforma (service_role escribe sin RLS).
  await admin.from("platform_admin_audit").insert({
    actor_id: actorId,
    action: "license_lease_revoked",
    target_company_id: companyId,
    detail: { lease_id: leaseId, reason }
  });

  return json({ revoked: true, leaseId, companyId }, 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = getServiceKey();
  if (!url || !serviceKey) return json({ error: "server_not_configured" }, 500);

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    if (req.method === "GET") return await handleGet(req, admin);
    if (req.method === "POST") {
      const publishable = getPublishableKey();
      return await handlePost(req, url, publishable, serviceKey, admin);
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    // Sin datos del request, tokens ni claves en el log.
    console.error("[revoke-lease] error interno", error instanceof Error ? error.name : "unknown");
    // GET público: fallar abierto (nunca revocar por un error interno).
    if (req.method === "GET") return json({ revoked: false }, 200);
    return json({ error: "server_error" }, 500);
  }
});
