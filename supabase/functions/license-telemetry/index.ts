import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * license-telemetry: registra evidencia de manipulación del reloj del equipo.
 *
 * Ruta canónica (POST, JWT de usuario):
 *   { companyId, deviceId, reason, detectedAt,
 *     effectiveNow?, anchor?, appVersion?, platform?, detail? }
 *   -> 202 { accepted: true, duplicate, reportId }
 *
 * Ruta por lotes (compatibilidad con el cliente que ya vacía su buzón):
 *   { reports: [{ company_id, device_id, lease_id, kind, source, skew_ms,
 *                 detected_at }, ...] }   (máximo 50 elementos)
 *   -> 202 { accepted: true, inserted, duplicates }
 *
 * Flujo común: CORS + POST -> JWT del usuario -> membresía activa en la
 * empresa -> validación y saneado -> cupo de 20 reportes/hora por equipo ->
 * insert con service_role en public.clock_tamper_reports.
 *
 * La tabla tiene RLS sin políticas: solo esta función (service_role) escribe y
 * solo el service_role lee. Nunca se registran ni se devuelven tokens, claves
 * ni parámetros de firma; los campos con nombre sensible del detalle se
 * descartan antes de guardar.
 *
 * Un plan vencido NO bloquea la telemetría: la evidencia debe llegar incluso en
 * solo lectura o con la cuenta suspendida. Por eso se valida la membresía, no
 * el estado del plan.
 *
 * Secretos requeridos: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (o
 * SUPABASE_SECRET_KEYS), más SUPABASE_ANON_KEY (o SUPABASE_PUBLISHABLE_KEYS).
 */

const HOUR_MS = 60 * 60 * 1000;
/** Tope de reportes por equipo y hora; el cliente agrupa y vacía por lotes. */
const MAX_REPORTS_PER_HOUR = 20;
/** Tope de elementos por lote (igual que el buzón del cliente). */
const MAX_BATCH_REPORTS = 50;
/** Cuerpo máximo aceptado antes de parsear (evita JSON gigantes). */
const MAX_BODY_BYTES = 64 * 1024;
/** Tamaño máximo del jsonb `detail` ya saneado. */
const MAX_DETAIL_BYTES = 8 * 1024;
const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_KEYS = 40;
const MAX_DETAIL_ITEMS = 20;
const MAX_TEXT = 256;
const MAX_KEY_LENGTH = 64;
const MIN_INSTANT_MS = Date.UTC(2000, 0, 1);
const MAX_INSTANT_MS = Date.UTC(2100, 0, 1);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID_RE = /^[\w.:-]{1,128}$/;
const REASON_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const APP_VERSION_RE = /^[A-Za-z0-9.+_-]{1,40}$/;
const PLATFORM_RE = /^[A-Za-z0-9._-]{1,32}$/;
const LEASE_ID_RE = /^[\w.:-]{1,128}$/;
/** Claves del detalle que jamás se persisten (tokens, claves, credenciales). */
const SENSITIVE_KEY_RE =
  /(token|secret|password|passwd|authorization|apikey|api[-_]?key|jwt|private[-_]?key|credential|signature|bearer)/i;
/** Valores admitidos por los CHECK de la tabla para el contrato anterior. */
const LEGACY_KINDS = new Set(["wall-rollback", "monotonic-regression"]);
const LEGACY_SOURCES = new Set(["watermark", "server-anchor", "monotonic"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
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

/* ------------------------------------------------------------------ */
/* Validación                                                          */
/* ------------------------------------------------------------------ */

type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413 };

async function readBody(req: Request): Promise<BodyResult> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return { ok: false, status: 413 };
  if (!raw.trim()) return { ok: false, status: 400 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400 };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Instante ISO válido y dentro de una ventana razonable (2000–2100). */
function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < MIN_INSTANT_MS || ms > MAX_INSTANT_MS) return null;
  return ms;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Recorta el detalle a tipos JSON simples: sin claves sensibles, sin objetos
 * profundos, con topes de longitud para que no crezca sin control.
 */
function pruneDetail(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (depth >= MAX_DETAIL_DEPTH) return undefined;

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, MAX_DETAIL_ITEMS)) {
      const pruned = pruneDetail(item, depth + 1);
      if (pruned !== undefined) items.push(pruned);
    }
    return items;
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (Object.keys(output).length >= MAX_DETAIL_KEYS) break;
      const cleanKey = key.trim();
      if (!cleanKey || cleanKey.length > MAX_KEY_LENGTH) continue;
      if (SENSITIVE_KEY_RE.test(cleanKey)) continue;
      const pruned = pruneDetail(item, depth + 1);
      if (pruned !== undefined) output[cleanKey] = pruned;
    }
    return output;
  }

  return undefined;
}

/** Fila preparada para public.clock_tamper_reports. */
interface PreparedRow {
  company_id: string;
  device_id: string | null;
  reason: string | null;
  kind: string | null;
  source: string | null;
  lease_id: string | null;
  skew_ms: number;
  detected_at: string;
  effective_now: string | null;
  anchor: string | null;
  app_version: string | null;
  platform: string | null;
  detail: unknown;
}

type PrepareResult = { ok: true; rows: PreparedRow[] } | { ok: false; error: string };

/** Ruta canónica: un reporte con el contexto completo del equipo. */
function prepareSingle(body: Record<string, unknown>): PrepareResult {
  const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().toLowerCase() : "";
  if (!UUID_RE.test(companyId)) return { ok: false, error: "invalid_company_id" };
  if (!DEVICE_ID_RE.test(deviceId)) return { ok: false, error: "invalid_device_id" };
  if (!REASON_RE.test(reason)) return { ok: false, error: "invalid_reason" };

  const detectedMs = parseInstant(body.detectedAt);
  if (detectedMs === null) return { ok: false, error: "invalid_detected_at" };

  let effectiveMs = detectedMs;
  if (body.effectiveNow !== undefined && body.effectiveNow !== null) {
    const value = parseInstant(body.effectiveNow);
    if (value === null) return { ok: false, error: "invalid_effective_now" };
    effectiveMs = value;
  }

  let anchorIso: string | null = null;
  if (body.anchor !== undefined && body.anchor !== null) {
    const value = parseInstant(body.anchor);
    if (value === null) return { ok: false, error: "invalid_anchor" };
    anchorIso = toIso(value);
  }

  let appVersion: string | null = null;
  if (body.appVersion !== undefined && body.appVersion !== null) {
    const value = typeof body.appVersion === "string" ? body.appVersion.trim() : "";
    if (!APP_VERSION_RE.test(value)) return { ok: false, error: "invalid_app_version" };
    appVersion = value;
  }

  let platform: string | null = null;
  if (body.platform !== undefined && body.platform !== null) {
    const value = typeof body.platform === "string" ? body.platform.trim().toLowerCase() : "";
    if (!PLATFORM_RE.test(value)) return { ok: false, error: "invalid_platform" };
    platform = value;
  }

  let detail: unknown = null;
  if (body.detail !== undefined && body.detail !== null) {
    if (typeof body.detail !== "object" || Array.isArray(body.detail)) {
      return { ok: false, error: "invalid_detail" };
    }
    detail = pruneDetail(body.detail, 0) ?? null;
    try {
      if (JSON.stringify(detail).length > MAX_DETAIL_BYTES) {
        return { ok: false, error: "invalid_detail" };
      }
    } catch {
      return { ok: false, error: "invalid_detail" };
    }
  }

  return {
    ok: true,
    rows: [
      {
        company_id: companyId,
        device_id: deviceId,
        reason,
        kind: null,
        source: null,
        lease_id: null,
        skew_ms: 0,
        detected_at: toIso(detectedMs),
        effective_now: toIso(effectiveMs),
        anchor: anchorIso,
        app_version: appVersion,
        platform,
        detail
      }
    ]
  };
}

/** Ruta por lotes del contrato anterior (kind/source/skew_ms). */
function prepareBatch(reports: unknown): PrepareResult {
  if (!Array.isArray(reports) || reports.length === 0) {
    return { ok: false, error: "invalid_reports" };
  }
  if (reports.length > MAX_BATCH_REPORTS) {
    return { ok: false, error: "invalid_reports" };
  }

  const rows: PreparedRow[] = [];
  for (const item of reports) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "invalid_reports" };
    }
    const raw = item as Record<string, unknown>;
    const companyId = typeof raw.company_id === "string" ? raw.company_id.trim() : "";
    if (!UUID_RE.test(companyId)) return { ok: false, error: "invalid_company_id" };

    const deviceRaw = typeof raw.device_id === "string" ? raw.device_id.trim() : "";
    if (deviceRaw && !DEVICE_ID_RE.test(deviceRaw)) {
      return { ok: false, error: "invalid_device_id" };
    }

    const leaseRaw = typeof raw.lease_id === "string" ? raw.lease_id.trim() : "";
    if (leaseRaw && !LEASE_ID_RE.test(leaseRaw)) {
      return { ok: false, error: "invalid_lease_id" };
    }

    const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
    const source = typeof raw.source === "string" ? raw.source.trim() : "";
    if (!LEGACY_KINDS.has(kind) || !LEGACY_SOURCES.has(source)) {
      return { ok: false, error: "invalid_reports" };
    }

    const skew = typeof raw.skew_ms === "number" && Number.isFinite(raw.skew_ms)
      ? Math.min(Math.max(0, Math.round(raw.skew_ms)), Number.MAX_SAFE_INTEGER)
      : 0;

    const detectedMs = parseInstant(raw.detected_at);
    if (detectedMs === null) return { ok: false, error: "invalid_detected_at" };

    rows.push({
      company_id: companyId,
      device_id: deviceRaw || null,
      reason: kind,
      kind,
      source,
      lease_id: leaseRaw || null,
      skew_ms: skew,
      detected_at: toIso(detectedMs),
      effective_now: null,
      anchor: null,
      app_version: null,
      platform: null,
      detail: null
    });
  }

  return { ok: true, rows };
}

/* ------------------------------------------------------------------ */
/* Escritura                                                           */
/* ------------------------------------------------------------------ */

type ServiceClient = ReturnType<typeof createClient>;

/**
 * Cuenta los reportes del equipo en la última hora usando created_at del
 * servidor (no la fecha del cliente, que es justo lo que puede estar falseado).
 */
async function reportsInLastHour(
  admin: ServiceClient,
  companyId: string,
  deviceId: string | null
): Promise<number | null> {
  const base = admin
    .from("clock_tamper_reports")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .gte("created_at", new Date(Date.now() - HOUR_MS).toISOString());
  const { count, error } =
    deviceId === null
      ? await base.is("device_id", null)
      : await base.eq("device_id", deviceId);
  if (error) return null;
  return typeof count === "number" ? count : 0;
}

interface InsertOutcome {
  inserted: number;
  duplicates: number;
  failed: boolean;
  firstId: string | null;
}

/** Inserción idempotente: un choque de la clave única no descarta el resto. */
async function insertRows(admin: ServiceClient, rows: PreparedRow[]): Promise<InsertOutcome> {
  if (rows.length === 0) return { inserted: 0, duplicates: 0, failed: false, firstId: null };

  if (rows.length === 1) {
    const { data, error } = await admin
      .from("clock_tamper_reports")
      .insert(rows[0])
      .select("id")
      .maybeSingle();
    if (!error) {
      return {
        inserted: 1,
        duplicates: 0,
        failed: false,
        firstId: typeof data?.id === "string" ? data.id : null
      };
    }
    if (error.code === "23505") {
      return { inserted: 0, duplicates: 1, failed: false, firstId: null };
    }
    return { inserted: 0, duplicates: 0, failed: true, firstId: null };
  }

  const { error } = await admin.from("clock_tamper_reports").insert(rows);
  if (!error) return { inserted: rows.length, duplicates: 0, failed: false, firstId: null };
  if (error.code !== "23505") return { inserted: 0, duplicates: 0, failed: true, firstId: null };

  // El lote chocó con filas ya reportadas: se reintenta fila a fila.
  let inserted = 0;
  let duplicates = 0;
  for (const row of rows) {
    const { error: rowError } = await admin.from("clock_tamper_reports").insert(row);
    if (!rowError) inserted += 1;
    else if (rowError.code === "23505") duplicates += 1;
    else return { inserted, duplicates, failed: true, firstId: null };
  }
  return { inserted, duplicates, failed: false, firstId: null };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

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

  const parsedBody = await readBody(req);
  if (!parsedBody.ok) {
    return parsedBody.status === 413
      ? json({ error: "payload_too_large" }, 413)
      : json({ error: "invalid_body" }, 400);
  }

  const isBatch = Object.prototype.hasOwnProperty.call(parsedBody.body, "reports");
  const prepared = isBatch
    ? prepareBatch(parsedBody.body.reports)
    : prepareSingle(parsedBody.body);
  if (!prepared.ok) return json({ error: prepared.error }, 400);
  const rows = prepared.rows;

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

    // 2. Pertenencia: misma tabla que usan las políticas RLS, una vez por empresa.
    const companies = Array.from(new Set(rows.map((row) => row.company_id)));
    for (const companyId of companies) {
      const { data: membership, error: membershipError } = await admin
        .from("company_memberships")
        .select("status")
        .eq("company_id", companyId)
        .eq("user_id", caller.id)
        .maybeSingle();
      if (membershipError) return json({ error: "server_error" }, 500);
      if (!membership || membership.status !== "active") {
        return json({ error: "permission_denied" }, 403);
      }
    }

    // 3. Cupo por equipo y hora: el lote entero cabe o se rechaza completo para
    //    que el cliente conserve su buzón y reintente más tarde.
    const perDevice = new Map<string, { companyId: string; deviceId: string | null; count: number }>();
    for (const row of rows) {
      const key = `${row.company_id}|${row.device_id ?? ""}`;
      const entry = perDevice.get(key);
      if (entry) entry.count += 1;
      else {
        perDevice.set(key, { companyId: row.company_id, deviceId: row.device_id, count: 1 });
      }
    }
    for (const entry of perDevice.values()) {
      const used = await reportsInLastHour(admin, entry.companyId, entry.deviceId);
      if (used === null) return json({ error: "server_error" }, 500);
      if (used + entry.count > MAX_REPORTS_PER_HOUR) {
        return json({ error: "rate_limited", retryAfterSeconds: 600 }, 429);
      }
    }

    // 4. Inserción con service_role.
    const outcome = await insertRows(admin, rows);
    if (outcome.failed) return json({ error: "server_error" }, 500);

    if (!isBatch) {
      return json(
        {
          accepted: true,
          duplicate: outcome.duplicates > 0,
          reportId: outcome.firstId
        },
        202
      );
    }

    return json(
      { accepted: true, inserted: outcome.inserted, duplicates: outcome.duplicates },
      202
    );
  } catch (error) {
    // Sin datos del request, tokens ni claves en el log.
    console.error("[license-telemetry] error interno", error instanceof Error ? error.name : "unknown");
    return json({ error: "server_error" }, 500);
  }
});
