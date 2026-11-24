/**
 * Cadencia con la que el hub consulta elTOQUE y reparte la tasa a sus equipos.
 *
 * Módulo puro: no programa temporizadores ni toca la red. El proceso principal
 * de Electron (dueño del hub) usa estas funciones para decidir cuándo
 * consultar, con cuánto reintentar y cómo persistir la última copia válida.
 *
 * Reglas acordadas (plan F6):
 * - Éxito: cada 45 min objetivo, con jitter determinista de ±3 min para que
 *   cinco equipos del mismo negocio no consulten a la vez. Siempre entre 30 y
 *   60 minutos.
 * - Fallo: 5 → 10 → 20 → 30 min (tope 30) y se reinicia al primer éxito.
 * - El renderer nunca usa estas funciones para llamar a elTOQUE: solo lee la
 *   copia que el hub ya capturó.
 */
import type { HubRateQuote } from "./protocol";

/** Nunca se consulta más seguido que esto (salvo reintento tras fallo). */
export const RATE_MIN_MS = 30 * 60 * 1000;
/** Cadencia objetivo del hub: 45 minutos. */
export const RATE_TARGET_MS = 45 * 60 * 1000;
/** Tope de la cadencia normal: 60 minutos. */
export const RATE_MAX_MS = 60 * 60 * 1000;
/** Jitter máximo por ciclo (±3 min) para no alinear equipos. */
export const RATE_JITTER_MS = 3 * 60 * 1000;
/** Primer reintento tras un fallo: 5 minutos (se duplica hasta el tope). */
export const RATE_FAILURE_MIN_MS = 5 * 60 * 1000;
/** Tope del retroceso exponencial: 30 minutos. */
export const RATE_FAILURE_MAX_MS = 30 * 60 * 1000;
/** Consulta inmediata después del arranque, sin bloquear la ventana. */
export const RATE_BOOT_DELAY_MS = 10 * 1000;
/**
 * Una copia del hub deja de considerarse útil pasados 60 minutos: ya debería
 * haber habido al menos una consulta nueva.
 */
export const RATE_SNAPSHOT_MAX_AGE_MS = RATE_MAX_MS;
/** Frescura por defecto de cualquier copia cuando no se indica otra edad. */
export const RATE_DEFAULT_FRESH_MS = 30 * 60 * 1000;

export type RateSnapshotSource = "hub" | "cloud";

/**
 * Forma persistida junto a la base local: cotizaciones ya normalizadas, hora de
 * la captura y de dónde salieron. `stale` es el aviso de la última copia.
 */
export interface HubRateSnapshot {
  quotes: HubRateQuote[];
  fetchedAt: string;
  source: RateSnapshotSource;
  stale: boolean;
}

export interface RateRunState {
  /** Época (ms) del último éxito; null si nunca hubo. */
  lastSuccessAt?: number | null;
  /** Época (ms) del último intento, exitoso o no. */
  lastAttemptAt?: number | null;
  /** Fallos consecutivos desde el último éxito. */
  failures?: number;
  /** 0..1 para el jitter; inyectable para pruebas y para repartir equipos. */
  random?: number;
}

export interface RateRunPlan {
  /** Si ya toca consultar en `now`. */
  shouldRun: boolean;
  /** Espera que corresponde a este estado. */
  delayMs: number;
  /** Época (ms) en la que vuelve a tocar. */
  dueAt: number;
}

const RATE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{1,19}$/;

export function normalizeRateFailures(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/** Cadencia normal acotada a [30, 60] minutos; nunca lanza. */
export function clampRateDelayMs(ms: number): number {
  const value = Number.isFinite(ms) ? ms : RATE_TARGET_MS;
  return Math.min(RATE_MAX_MS, Math.max(RATE_MIN_MS, Math.trunc(value)));
}

/** Retroceso por fallos consecutivos: 5, 10, 20, 30, 30… minutos. */
export function rateFailureDelayMs(failures: number): number {
  const count = Math.max(1, normalizeRateFailures(failures));
  const delay = RATE_FAILURE_MIN_MS * 2 ** (count - 1);
  return Math.min(RATE_FAILURE_MAX_MS, delay);
}

/** Jitter determinista en [-3, +3] minutos a partir de un 0..1. */
export function rateJitterMs(random: unknown = 0.5): number {
  const value = typeof random === "number" && Number.isFinite(random)
    ? Math.min(1, Math.max(0, random))
    : 0.5;
  return Math.round((value - 0.5) * 2 * RATE_JITTER_MS);
}

/**
 * Espera hasta la próxima consulta. Con fallos usa el retroceso (que puede ser
 * menor que 30 min a propósito); sin fallos, 45 min ± jitter acotado.
 */
export function nextRateDelayMs(state: RateRunState = {}): number {
  const failures = normalizeRateFailures(state.failures);
  if (failures > 0) return rateFailureDelayMs(failures);
  return clampRateDelayMs(RATE_TARGET_MS + rateJitterMs(state.random));
}

/**
 * Plan para un instante dado: usa el último intento como ancla (un fallo ya
 * programó su reintento) y cae en `lastSuccessAt` si no hay intentos.
 */
export function planRateRun(state: RateRunState = {}, now: number): RateRunPlan {
  const at = Number.isFinite(now) ? now : Date.now();
  const anchor = Math.max(
    Number.isFinite(state.lastAttemptAt as number) ? (state.lastAttemptAt as number) : 0,
    Number.isFinite(state.lastSuccessAt as number) ? (state.lastSuccessAt as number) : 0
  );
  const delayMs = nextRateDelayMs(state);
  const dueAt = anchor > 0 ? anchor + delayMs : at;
  return { shouldRun: at >= dueAt, delayMs, dueAt };
}

function positiveRate(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Valida las cotizaciones de una copia leída de disco o de memoria. */
export function normalizeSnapshotQuotes(value: unknown): HubRateQuote[] {
  if (!Array.isArray(value)) return [];
  const quotes = new Map<string, HubRateQuote>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const code = String(row.code ?? "").trim().toUpperCase();
    if (!RATE_CODE_PATTERN.test(code)) continue;
    const rate = positiveRate(row.rate);
    const captured = typeof row.capturedAt === "string" ? Date.parse(row.capturedAt) : Number.NaN;
    if (rate === null || !Number.isFinite(captured)) continue;
    quotes.set(code, {
      code,
      rate,
      capturedAt: new Date(captured).toISOString(),
      source: typeof row.source === "string" && row.source.trim() ? row.source.trim() : "elTOQUE API",
      stale: row.stale === true
    });
  }
  return [...quotes.values()];
}

/** Copia lista para persistir; `null` si no hay ninguna tasa utilizable. */
export function buildRateSnapshot(
  quotes: HubRateQuote[],
  fetchedAtMs: number,
  source: RateSnapshotSource = "hub"
): HubRateSnapshot | null {
  const normalized = normalizeSnapshotQuotes(quotes);
  if (!normalized.length) return null;
  const at = Number.isFinite(fetchedAtMs) ? fetchedAtMs : Date.now();
  return {
    quotes: normalized,
    fetchedAt: new Date(at).toISOString(),
    source: source === "cloud" ? "cloud" : "hub",
    stale: normalized.some(quote => quote.stale)
  };
}

/**
 * Lee la forma persistida sin confiar en el archivo: cualquier campo inválido
 * hace que la copia completa se descarte (nunca se inventan tasas).
 */
export function readRateSnapshot(value: unknown): HubRateSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const fetchedAt = typeof body.fetchedAt === "string" ? Date.parse(body.fetchedAt) : Number.NaN;
  const quotes = normalizeSnapshotQuotes(body.quotes);
  if (!Number.isFinite(fetchedAt) || !quotes.length) return null;
  return {
    quotes,
    fetchedAt: new Date(fetchedAt).toISOString(),
    source: body.source === "cloud" ? "cloud" : "hub",
    stale: body.stale === true
  };
}

/**
 * Fusiona la copia nueva con la anterior: gana la captura más reciente y, por
 * código, sus cotizaciones pisan a las viejas. Una copia sin tasas no borra la
 * última válida.
 */
export function mergeRateSnapshot(
  previous: HubRateSnapshot | null | undefined,
  fresh: HubRateSnapshot | null | undefined
): HubRateSnapshot | null {
  const before = readRateSnapshot(previous);
  const after = readRateSnapshot(fresh);
  if (!before) return after;
  if (!after) return before;
  const beforeAt = Date.parse(before.fetchedAt);
  const afterAt = Date.parse(after.fetchedAt);
  const winner = afterAt >= beforeAt ? after : before;
  const loser = afterAt >= beforeAt ? before : after;
  const quotes = new Map<string, HubRateQuote>(loser.quotes.map(quote => [quote.code, quote]));
  for (const quote of winner.quotes) quotes.set(quote.code, quote);
  return { ...winner, quotes: [...quotes.values()] };
}

/** `true` mientras la captura no supere `maxAgeMs` (30 min por defecto). */
export function isRateFresh(
  snapshot: HubRateSnapshot | null | undefined,
  now: number,
  maxAgeMs: number = RATE_DEFAULT_FRESH_MS
): boolean {
  const parsed = snapshot ? Date.parse(snapshot.fetchedAt) : Number.NaN;
  if (!Number.isFinite(parsed)) return false;
  const at = Number.isFinite(now) ? now : Date.now();
  const age = at - parsed;
  const limit = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : RATE_DEFAULT_FRESH_MS;
  return age >= 0 && age <= limit;
}

/** Antigüedad en ms de una copia; `null` si no se puede interpretar. */
export function rateSnapshotAgeMs(
  snapshot: HubRateSnapshot | null | undefined,
  now: number
): number | null {
  const parsed = snapshot ? Date.parse(snapshot.fetchedAt) : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const at = Number.isFinite(now) ? now : Date.now();
  return Math.max(0, at - parsed);
}
