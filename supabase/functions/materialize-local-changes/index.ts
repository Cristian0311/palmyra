import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * materialize-local-changes: convierte la bandeja `local_change_inbox` en filas
 * de negocio llamando a la RPC `materialize_local_change_inbox(p_limit)`.
 *
 * La RPC es idempotente por (company_id, seq) y por `id` destino, y aísla los
 * errores por fila: una fila que falla queda `failed` con su motivo en
 * `error`, y una hija que llega antes que su padre queda `pending` para
 * reintentarse (máximo 5 intentos). Por eso el worker ejecuta la RPC en lotes
 * mientras quede trabajo pendiente y avance real.
 *
 * Autenticación:
 *  - `x-worker-secret` igual a `MATERIALIZE_WORKER_SECRET` o a
 *    `PALMYRA_NOTIFICATION_WORKER_SECRET` (nombre que usa el cron), o
 *  - `Authorization: Bearer <service role key>` (ejecución manual del equipo).
 * La RPC está revocada para anon/authenticated: solo corre con service_role.
 *
 * No se registran payloads, claves ni tokens; los errores se reportan por
 * código SQL. Respuesta: { processed, failed, skipped, remaining, batches }.
 */

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_BATCHES = 20;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function serviceRoleKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (direct) return direct;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed.default || Object.values(parsed)[0] || "";
    } catch {
      /* clave malformada: se trata como no configurada */
    }
  }
  return "";
}

/**
 * Secreto del worker. Se aceptan los nombres que usan el planificador y los
 * despliegues existentes, en este orden de prioridad (solo nombres, nunca
 * valores):
 *  1. MATERIALIZE_WORKER_SECRET
 *  2. PALMYRA_NOTIFICATION_WORKER_SECRET (nombre que envía el cron
 *     20261124092000_materialize_cron.sql desde Vault)
 *  3. PALMYRA_MATERIALIZE_SECRET (compatibilidad histórica)
 */
function workerSecret(): string {
  return (
    Deno.env.get("MATERIALIZE_WORKER_SECRET") ||
    Deno.env.get("PALMYRA_NOTIFICATION_WORKER_SECRET") ||
    Deno.env.get("PALMYRA_MATERIALIZE_SECRET") ||
    ""
  ).trim();
}

/** Comparación de longitud constante para no filtrar el secreto por tiempo. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function readCount(data: unknown, key: string): number {
  if (!data || typeof data !== "object") return 0;
  const value = (data as Record<string, unknown>)[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const secret = serviceRoleKey();
  if (!url || !secret) return json({ error: "server_not_configured" }, 503);

  const authorization = req.headers.get("Authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const expectedWorker = workerSecret();
  const providedWorker = (req.headers.get("x-worker-secret") || "").trim();
  const authorized =
    (bearer !== "" && sameSecret(bearer, secret)) ||
    (expectedWorker !== "" && sameSecret(providedWorker, expectedWorker));
  if (!authorized) return json({ error: "authentication_required" }, 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const limit = clampInt(body?.p_limit ?? body?.limit, DEFAULT_LIMIT, 1, 1000);
  const maxBatches = clampInt(body?.max_batches ?? body?.maxBatches, DEFAULT_MAX_BATCHES, 1, 50);

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let remaining = 0;
  let batches = 0;

  try {
    while (batches < maxBatches) {
      const { data, error } = await admin.rpc("materialize_local_change_inbox", {
        p_limit: limit
      });
      if (error) {
        // Solo el código: el mensaje puede incluir valores de la fila.
        console.error("[materialize-local-changes] rpc_failed", error.code || "unknown");
        return json(
          { error: "materialize_failed", processed, failed, skipped, remaining, batches },
          500
        );
      }

      const batchProcessed = readCount(data, "processed");
      const batchFailed = readCount(data, "failed");
      const batchSkipped = readCount(data, "skipped");
      processed += batchProcessed;
      failed += batchFailed;
      skipped += batchSkipped;
      remaining = readCount(data, "remaining");
      batches += 1;

      // Los reintentos vuelven a 'pending' sin contar como avance: si un lote
      // no movió nada, se corta para no repetir el mismo ciclo.
      const advanced = batchProcessed + batchFailed + batchSkipped;
      if (remaining <= 0 || advanced <= 0) break;
    }
  } catch (error) {
    console.error(
      "[materialize-local-changes] unexpected",
      error instanceof Error ? error.name : "unknown"
    );
    return json({ error: "server_error", processed, failed, skipped, remaining, batches }, 500);
  }

  return json({ processed, failed, skipped, remaining, batches, limit }, 200);
});
