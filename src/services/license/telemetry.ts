import type { ClockTamperDraft, ClockTamperKind, ClockTamperSource } from "./clock";
import {
  LICENSE_CLOCK_TELEMETRY_MAX_EVENTS,
  LICENSE_STORE_KEYS,
  drainClockTamperEvents,
  loadClockTamperEvents,
  recordClockTamperEvent,
  type ClockTamperEvent,
  type LicenseKeyValueStore
} from "./storage";

/**
 * Telemetría de manipulación del reloj: puente entre la detección local y la
 * Edge Function `license-telemetry` (tabla `public.clock_tamper_reports`).
 *
 * Dos colas, dos responsabilidades:
 *  - Los eventos locales (`storage.ts`) son la evidencia cruda y acotada que
 *    deja la guarda de reloj al detectar una anomalía.
 *  - El buzón de reportes de este módulo es la cola durable de envío: máximo
 *    50 filas, deduplicadas por empresa + dispositivo + día + motivo, para que
 *    reintentar no genere filas repetidas ni un registro que crezca sin límite.
 *
 * Contrato de envío (implementado por la Edge Function `license-telemetry`):
 *   POST `${SUPABASE_URL}/functions/v1/license-telemetry`
 *   Authorization: Bearer <access_token del usuario>
 *   { reports: [{ company_id, device_id, lease_id, kind, source, skew_ms,
 *                 detected_at }, ...] }   (ruta por lotes, máximo 50)
 *   -> 202 { accepted, inserted, duplicates }  (también se descarta un 409)
 *   -> 400/413/422: se aísla el lote fila a fila y se descarta solo la inválida
 *   -> 401/403 (o el SQLSTATE 42501 reenviado): descarte definitivo del lote;
 *      el servidor ya rechazó ese token/permiso y reintentar no lo arregla
 *   -> 429: se conserva y se detiene el ciclo (sin martillar)
 *   -> red/5xx: se conserva y se reintenta hasta el tope acotado.
 *
 * La función aplica cupo por equipo/hora (20) y rechaza el lote completo si lo
 * excede, así que cada ciclo envía como mucho
 * `CLOCK_TELEMETRY_MAX_REPORTS_PER_FLUSH` filas, muy por debajo del cupo.
 * La Edge Function es el ÚNICO camino válido: la tabla
 * `clock_tamper_reports` ya no concede INSERT a los clientes (migración
 * 20261123180000), así que cualquier inserción directa devolvería 42501 y
 * dejaría el reporte en reintento eterno. No existe respaldo de tabla.
 *
 * Privacidad: ni el token ni la respuesta se registran en consola. El cuerpo
 * solo lleva columnas de la tabla, nunca claves, JWT ni datos personales.
 */

export const CLOCK_TAMPER_REPORTS_TABLE = "clock_tamper_reports";
/** Nombre de la Edge Function que recibe la telemetría. */
export const CLOCK_TELEMETRY_FUNCTION = "license-telemetry";
/** Reintentos acotados dentro de un mismo vaciado; no se hace backoff largo. */
export const CLOCK_TELEMETRY_MAX_ATTEMPTS = 3;
/** Tope del buzón de envío: la telemetría es una señal, no un historial. */
export const CLOCK_TELEMETRY_QUEUE_MAX = 50;
/** Clave local del buzón (no toca lease, marca de agua ni identidad). */
export const CLOCK_TELEMETRY_QUEUE_KEY = "clock-telemetry-reports";
/** Cadencia mínima entre intentos suaves de vaciado (5 min). */
export const CLOCK_TELEMETRY_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** La función acepta un lote: tope de filas por vaciado (cupo del servidor: 20/h). */
export const CLOCK_TELEMETRY_MAX_REPORTS_PER_FLUSH = 10;
/** Tiempo máximo de una petición de telemetría. */
const CLOCK_TELEMETRY_TIMEOUT_MS = 15_000;

/** Fila de la tabla: es también el elemento del lote de la Edge Function. */
export interface ClockTamperReportRow {
  company_id: string;
  device_id: string | null;
  lease_id: string | null;
  kind: string;
  source: string;
  skew_ms: number;
  detected_at: string;
}

/** Entrada del buzón: fila + metadatos locales (no se envían). */
export interface ClockTamperQueuedReport extends ClockTamperReportRow {
  /** Clave de deduplicación: empresa + dispositivo + día (UTC) + motivo. */
  key: string;
  /** Veces agrupadas en el mismo día (solo local). */
  count: number;
}

export type ClockTelemetryFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Forma mínima del cliente Supabase que necesita la telemetría. `auth` y
 * `supabaseUrl` son opcionales y solo se usan para resolver token y endpoint
 * de la Edge Function. `from` se conserva por compatibilidad con clientes ya
 * existentes, pero la telemetría NUNCA escribe en tablas: el INSERT directo
 * fue revocado y solo la Edge Function es un camino válido.
 */
export interface ClockTamperTelemetryClient {
  /** Compatibilidad: presente en el cliente Supabase, deliberadamente sin uso. */
  from?(table: string): unknown;
  auth?: {
    getSession(): Promise<unknown>;
  };
  supabaseUrl?: string;
}

export interface DrainClockTelemetryInput {
  store: LicenseKeyValueStore;
  client: ClockTamperTelemetryClient | null;
  /** Empresa dueña de la telemetría. Sin ella no se envía ni se descarta nada. */
  companyId: string;
  deviceId?: string | null;
  leaseId?: string | null;
  maxAttempts?: number;
  /** Inyectable en pruebas; por defecto el `fetch` global. */
  fetchImpl?: ClockTelemetryFetch | null;
  /** URL del proyecto Supabase o de sus funciones (por defecto, el entorno). */
  baseUrl?: string | null;
  accessToken?: string | null;
}

export interface DrainClockTelemetryResult {
  sent: number;
  pending: number;
}

export interface FlushClockTelemetryInput {
  store: LicenseKeyValueStore;
  companyId: string;
  client?: ClockTamperTelemetryClient | null;
  fetchImpl?: ClockTelemetryFetch | null;
  baseUrl?: string | null;
  /** Endpoint completo de la función; si falta, se arma con `baseUrl`. */
  endpoint?: string | null;
  accessToken?: string | null;
  maxAttempts?: number;
}

export interface FlushClockTelemetryResult {
  sent: number;
  pending: number;
  /** Estado HTTP del último intento; null si no hubo red (offline). */
  status: number | null;
}

const QUEUED_KINDS: readonly ClockTamperKind[] = ["wall-rollback", "monotonic-regression"];
const QUEUED_SOURCES: readonly ClockTamperSource[] = ["watermark", "server-anchor", "monotonic"];
/** Respuestas que conservan el reporte pero detienen el ciclo (sin martillar). */
const STOP_FLUSH_STATUS = new Set([429]);
/**
 * Reportes que el servidor nunca aceptará: se descartan para no bloquear la
 * cola. Incluye el rechazo de autorización (401/403): un token revocado o un
 * rol sin permiso no se arregla reintentando el mismo lote cada 5 minutos.
 */
const DISCARD_REPORT_STATUS = new Set([400, 401, 403, 413, 422]);
/** El 42501 (RLS/permiso denegado) se reenvía en el cuerpo; nunca es un HTTP válido. */
const PERMISSION_DENIED_STATUS = 42501;
/** Solo estas respuestas justifican aislar el lote fila a fila (payload inválido). */
const ISOLATE_REPORT_STATUS = new Set([400, 413, 422]);

/**
 * Encola una detección de reloj. Delegado a `recordClockTamperEvent`, que ya
 * agrupa repeticiones, recorta al tope y nunca lanza.
 */
export async function queueClockTamperEvent(
  store: LicenseKeyValueStore,
  draft: ClockTamperDraft
): Promise<void> {
  await recordClockTamperEvent(store, draft);
}

function clampAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CLOCK_TELEMETRY_MAX_ATTEMPTS;
  return Math.min(5, Math.max(1, Math.floor(value)));
}

function isCompanyId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function safeDetectedAt(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Base de las Edge Functions: la explícita, `VITE_SUPABASE_URL` o la URL del
 * cliente Supabase. Sin base no se hace red (la telemetría es best-effort).
 */
export function resolveClockTelemetryBaseUrl(
  explicit?: string | null,
  clientUrl?: string | null
): string | null {
  const normalize = (value: string) => {
    const trimmed = trimBase(value.trim());
    return trimmed.endsWith("/functions/v1") ? trimmed : `${trimmed}/functions/v1`;
  };
  if (typeof explicit === "string" && explicit.trim()) return normalize(explicit);
  try {
    const env = (
      import.meta as ImportMeta & { env?: { VITE_SUPABASE_URL?: unknown } }
    ).env;
    const url = env?.VITE_SUPABASE_URL;
    if (typeof url === "string" && url.trim()) return normalize(url);
  } catch {
    // Sin import.meta.env (Node, pruebas) se usan las otras fuentes.
  }
  if (typeof clientUrl === "string" && clientUrl.trim()) return normalize(clientUrl);
  return null;
}

function buildEndpoint(baseUrl?: string | null, endpoint?: string | null): string | null {
  if (typeof endpoint === "string" && endpoint.trim()) return endpoint.trim();
  const base = resolveClockTelemetryBaseUrl(baseUrl, null);
  return base ? `${base}/${CLOCK_TELEMETRY_FUNCTION}` : null;
}

/** Token del usuario, leído sin registrarlo jamás. Nunca lanza. */
async function resolveAccessToken(
  client: ClockTamperTelemetryClient | null | undefined
): Promise<string | null> {
  const getSession = client?.auth?.getSession;
  if (typeof getSession !== "function") return null;
  try {
    const result = (await getSession.call(client?.auth)) as {
      data?: { session?: { access_token?: unknown } | null } | null;
    } | null;
    const token = result?.data?.session?.access_token;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Buzón durable de reportes                                          */
/* ------------------------------------------------------------------ */

/**
 * Serializa las operaciones sobre el buzón dentro de la pestaña: dos vaciados
 * simultáneos (refresco + evento online) no deben perder ni duplicar filas.
 */
let queueTail: Promise<unknown> = Promise.resolve();

function withQueueLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => undefined);
  return run;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function queueKey(input: {
  companyId: string;
  deviceId?: string | null;
  kind: string;
  detectedAt: string;
}): string {
  return [input.companyId, input.deviceId || "-", dayKey(input.detectedAt), input.kind].join("|");
}

function sanitizeQueuedReport(raw: unknown): ClockTamperQueuedReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<ClockTamperQueuedReport>;
  if (!isCompanyId(candidate.company_id)) return null;
  if (!QUEUED_KINDS.includes(candidate.kind as ClockTamperKind)) return null;
  if (!QUEUED_SOURCES.includes(candidate.source as ClockTamperSource)) return null;
  const detectedMs = Date.parse(String(candidate.detected_at ?? ""));
  if (!Number.isFinite(detectedMs)) return null;
  const companyId = candidate.company_id.trim();
  const deviceId =
    typeof candidate.device_id === "string" && candidate.device_id.trim()
      ? candidate.device_id.trim()
      : null;
  const leaseId =
    typeof candidate.lease_id === "string" && candidate.lease_id.trim()
      ? candidate.lease_id.trim()
      : null;
  const skew = typeof candidate.skew_ms === "number" && Number.isFinite(candidate.skew_ms)
    ? Math.max(0, Math.round(candidate.skew_ms))
    : 0;
  const count = typeof candidate.count === "number" && Number.isFinite(candidate.count) && candidate.count >= 1
    ? Math.floor(candidate.count)
    : 1;
  const detectedAt = new Date(detectedMs).toISOString();
  return {
    key: queueKey({ companyId, deviceId, kind: String(candidate.kind), detectedAt }),
    company_id: companyId,
    device_id: deviceId,
    lease_id: leaseId,
    kind: String(candidate.kind),
    source: String(candidate.source),
    skew_ms: skew,
    detected_at: detectedAt,
    count
  };
}

async function readQueue(store: LicenseKeyValueStore): Promise<ClockTamperQueuedReport[]> {
  let raw: unknown;
  try {
    raw = await store.get<unknown>(CLOCK_TELEMETRY_QUEUE_KEY);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const queue: ClockTamperQueuedReport[] = [];
  for (const item of raw) {
    const entry = sanitizeQueuedReport(item);
    if (entry) queue.push(entry);
  }
  return queue.slice(-CLOCK_TELEMETRY_QUEUE_MAX);
}

async function writeQueue(
  store: LicenseKeyValueStore,
  queue: ClockTamperQueuedReport[]
): Promise<void> {
  const trimmed = queue.slice(-CLOCK_TELEMETRY_QUEUE_MAX);
  if (trimmed.length === 0) await store.delete(CLOCK_TELEMETRY_QUEUE_KEY);
  else await store.set(CLOCK_TELEMETRY_QUEUE_KEY, trimmed);
}

/**
 * Fusiona un reporte en el buzón: misma empresa, dispositivo, día y motivo se
 * agrupa (cuenta, magnitud máxima y la detección más antigua, para que un
 * reintento sea idempotente). El más antiguo se descarta al superar el tope.
 */
function mergeReport(
  queue: ClockTamperQueuedReport[],
  next: ClockTamperQueuedReport
): ClockTamperQueuedReport[] {
  const index = queue.findIndex((entry) => entry.key === next.key);
  if (index >= 0) {
    const current = queue[index];
    current.count += next.count;
    current.skew_ms = Math.max(current.skew_ms, next.skew_ms);
    if (Date.parse(next.detected_at) < Date.parse(current.detected_at)) {
      current.detected_at = next.detected_at;
      current.key = next.key;
    }
    if (!current.lease_id && next.lease_id) current.lease_id = next.lease_id;
    return queue;
  }
  queue.push(next);
  while (queue.length > CLOCK_TELEMETRY_QUEUE_MAX) queue.shift();
  return queue;
}

function fromDraft(
  draft: ClockTamperDraft,
  context: { companyId: string; deviceId?: string | null; leaseId?: string | null }
): ClockTamperQueuedReport | null {
  const detectedAt = safeDetectedAt(draft?.detectedAtMs);
  const base = sanitizeQueuedReport({
    company_id: context.companyId,
    device_id: context.deviceId ?? null,
    lease_id: context.leaseId ?? null,
    kind: draft?.kind,
    source: draft?.source,
    skew_ms: draft?.skewMs,
    detected_at: detectedAt,
    count: 1
  });
  return base;
}

/**
 * Encola un reporte para el servidor. Máximo 50 filas y dedupe por empresa +
 * dispositivo + día + motivo. Nunca lanza: la telemetría no rompe la app.
 */
export async function queueClockTamperReport(
  store: LicenseKeyValueStore,
  draft: ClockTamperDraft,
  context: { companyId: string; deviceId?: string | null; leaseId?: string | null }
): Promise<void> {
  if (!isCompanyId(context?.companyId)) return;
  const entry = fromDraft(draft, context);
  if (!entry) return;
  try {
    await withQueueLock(async () => {
      const queue = await readQueue(store);
      mergeReport(queue, entry);
      await writeQueue(store, queue);
    });
  } catch {
    // Un fallo de almacenamiento no puede bloquear la operación ni la licencia.
  }
}

/** Copia de los reportes pendientes de envío (para diagnóstico y pruebas). */
export async function loadQueuedClockTamperReports(
  store: LicenseKeyValueStore
): Promise<ClockTamperQueuedReport[]> {
  return withQueueLock(() => readQueue(store));
}

/** Devuelve los eventos no enviados al almacén si el buzón no se pudo escribir. */
async function restoreEvents(
  store: LicenseKeyValueStore,
  events: ClockTamperEvent[]
): Promise<void> {
  if (events.length === 0) return;
  try {
    const current = await loadClockTamperEvents(store);
    const merged = [...events, ...current];
    while (merged.length > LICENSE_CLOCK_TELEMETRY_MAX_EVENTS) merged.shift();
    await store.set(LICENSE_STORE_KEYS.clockTelemetry, merged);
  } catch {
    // Si ni restaurar se puede, la telemetría se pierde: nunca rompe la app.
  }
}

/**
 * Pasa los eventos locales al buzón de envío. Los eventos ya no llevan
 * identificadores; el contexto (empresa, equipo, lease) se añade aquí.
 * No duplica detección: solo traduce lo que la guarda ya registró.
 */
async function foldPendingEvents(
  store: LicenseKeyValueStore,
  context: { companyId: string; deviceId?: string | null; leaseId?: string | null }
): Promise<void> {
  const events = await drainClockTamperEvents(store);
  if (events.length === 0) return;
  try {
    await withQueueLock(async () => {
      const queue = await readQueue(store);
      for (const event of events) {
        const entry = fromDraft(
          {
            kind: event.kind,
            source: event.source,
            skewMs: event.skewMs,
            detectedAtMs: event.firstSeenAt
          },
          context
        );
        if (entry) {
          entry.count = Math.max(1, Math.floor(event.count) || 1);
          mergeReport(queue, entry);
        }
      }
      await writeQueue(store, queue);
    });
  } catch {
    await restoreEvents(store, events);
  }
}

/* ------------------------------------------------------------------ */
/* Vaciado                                                            */
/* ------------------------------------------------------------------ */

function toRow(entry: ClockTamperQueuedReport): ClockTamperReportRow {
  // Solo columnas del contrato: nada de clave local, token ni datos extra.
  return {
    company_id: entry.company_id,
    device_id: entry.device_id,
    lease_id: entry.lease_id,
    kind: entry.kind,
    source: entry.source,
    skew_ms: entry.skew_ms,
    detected_at: entry.detected_at
  };
}

type SendVerdict = "sent" | "discard" | "stop" | "retry";

interface SendOutcome {
  verdict: SendVerdict;
  status: number | null;
}

function classifyStatus(status: number | null): SendVerdict {
  if (status === null) return "retry";
  if (status >= 200 && status <= 299) return "sent";
  if (status === 409) return "sent"; // ya existía: idempotente
  if (status === PERMISSION_DENIED_STATUS) return "discard"; // RLS cerrada: nunca entrará
  if (DISCARD_REPORT_STATUS.has(status)) return "discard";
  if (STOP_FLUSH_STATUS.has(status)) return "stop";
  return "retry";
}

async function postReports(
  rows: ClockTamperReportRow[],
  input: {
    endpoint: string;
    token: string;
    fetchImpl: ClockTelemetryFetch;
  }
): Promise<SendOutcome> {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), CLOCK_TELEMETRY_TIMEOUT_MS)
    : null;
  try {
    const response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.token}`
      },
      body: JSON.stringify({ reports: rows }),
      ...(controller ? { signal: controller.signal } : {})
    });
    const status = typeof response?.status === "number" ? response.status : 0;
    return { verdict: classifyStatus(status), status };
  } catch {
    return { verdict: "retry", status: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function removeSent(
  store: LicenseKeyValueStore,
  sentKeys: Set<string>
): Promise<ClockTamperQueuedReport[]> {
  return withQueueLock(async () => {
    const queue = await readQueue(store);
    const remaining = queue.filter((entry) => !sentKeys.has(entry.key));
    await writeQueue(store, remaining);
    return remaining;
  });
}

/**
 * Envía los reportes del buzón de la empresa indicada por la Edge Function.
 * No hay respaldo de tabla: sin endpoint y token no se envía nada y la cola se
 * conserva. Un 2xx/409 confirma el lote; 400/413/422 se aíslan fila a fila;
 * 401/403/42501 descartan el lote de forma definitiva (reintentar el mismo
 * permiso revocado solo produce un bucle) y red/5xx se reintenta con tope.
 * Nunca lanza.
 */
export async function flushClockTamperReports(
  input: FlushClockTelemetryInput
): Promise<FlushClockTelemetryResult> {
  const { store, companyId } = input;
  if (!isCompanyId(companyId)) return { sent: 0, pending: 0, status: null };

  let queue: ClockTamperQueuedReport[] = [];
  try {
    queue = await withQueueLock(() => readQueue(store));
  } catch {
    return { sent: 0, pending: 0, status: null };
  }
  const mine = queue.filter((entry) => entry.company_id === companyId);
  if (mine.length === 0) return { sent: 0, pending: queue.length, status: null };

  const fetchImpl =
    input.fetchImpl ??
    (typeof fetch === "function" ? ((value, init) => fetch(value, init)) : null);
  const client = input.client ?? null;
  const token = (input.accessToken ?? "").trim() || (await resolveAccessToken(client));
  // Base explícita > URL del proyecto del cliente > `VITE_SUPABASE_URL`.
  const base =
    (input.baseUrl ?? "").trim() || (client?.supabaseUrl ?? "").trim() || null;
  const endpoint = buildEndpoint(base, input.endpoint ?? null);
  // La Edge Function es el único camino: sin endpoint, token o fetch no se
  // intenta ninguna escritura (la tabla ya no admite INSERT de clientes).
  if (!endpoint || !token || !fetchImpl) return { sent: 0, pending: queue.length, status: null };

  const attempts = clampAttempts(input.maxAttempts);
  const batch = mine.slice(0, CLOCK_TELEMETRY_MAX_REPORTS_PER_FLUSH);
  const processed = new Set<string>();
  let sent = 0;
  let status: number | null = null;

  const edge = { endpoint, token, fetchImpl };
  let isolate = false;
  for (let attempt = 0; attempt < attempts && !isolate; attempt += 1) {
    const outcome = await postReports(batch.map(toRow), edge);
    status = outcome.status;
    if (outcome.verdict === "sent") {
      batch.forEach((entry) => processed.add(entry.key));
      sent = batch.length;
      break;
    }
    if (outcome.verdict === "stop") break;
    if (outcome.verdict === "discard") {
      if (outcome.status !== null && ISOLATE_REPORT_STATUS.has(outcome.status)) {
        // 400/413/422: puede haber una fila corrupta; se aísla una por una.
        isolate = true;
      } else {
        // Autorización denegada (401/403/42501): el lote completo es
        // irrecuperable con esta sesión; se descarta para no reintentar eterno.
        batch.forEach((entry) => processed.add(entry.key));
      }
      break;
    }
  }

  if (isolate) {
    let stop = false;
    for (const entry of batch) {
      if (stop) break;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const outcome = await postReports([toRow(entry)], edge);
        status = outcome.status;
        if (outcome.verdict === "sent") {
          processed.add(entry.key);
          sent += 1;
          break;
        }
        if (outcome.verdict === "discard") {
          // Fila inválida o sin permiso para siempre: se descarta para no
          // bloquear la cola (el descarte es explícito, no un reintento oculto).
          processed.add(entry.key);
          break;
        }
        if (outcome.verdict === "stop") {
          stop = true;
          break;
        }
      }
    }
  }

  let remaining = queue;
  if (processed.size > 0) {
    try {
      remaining = await removeSent(store, processed);
    } catch {
      // El servidor ya tiene los datos; el índice único evita duplicados.
    }
  }
  return { sent, pending: remaining.length, status };
}

/**
 * Vaciado completo: traduce los eventos locales al buzón y envía lo pendiente.
 * Es la única entrada que usa el runtime (y la integración de React).
 * Nunca lanza y devuelve cuántos se enviaron y cuántos quedan.
 */
export async function drainClockTelemetry(
  input: DrainClockTelemetryInput
): Promise<DrainClockTelemetryResult> {
  const { store, client, companyId } = input;
  if (!client || !isCompanyId(companyId)) return { sent: 0, pending: 0 };

  try {
    await foldPendingEvents(store, {
      companyId,
      deviceId: input.deviceId,
      leaseId: input.leaseId
    });
  } catch {
    // Sin eventos traducidos, igualmente se intenta vaciar lo que ya hubiera.
  }

  const result = await flushClockTamperReports({
    store,
    companyId,
    client,
    maxAttempts: input.maxAttempts,
    fetchImpl: input.fetchImpl,
    baseUrl: input.baseUrl,
    accessToken: input.accessToken
  });
  return { sent: result.sent, pending: result.pending };
}
