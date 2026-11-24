import { describeNetworkError, fetchJsonWithRetry } from '../lib/http';
import {
  EXCHANGE_RATE_CACHE_KEY,
  isElToquePayload,
  type ExchangePayload
} from '../lib/exchangeRates';
import {
  AUTO_RATE_CODES,
  collectCupRates,
  decideAutoRate,
  normalizeAutoRateThreshold,
  rateToBaseFromCup
} from '../lib/autoRatePolicy';
import { hubQuotesToPayload } from './lanHub/rates';
import { RATE_SNAPSHOT_MAX_AGE_MS, RATE_TARGET_MS } from './lanHub/rateScheduler';
import type { HubRateQuote } from './lanHub/protocol';
import { formatRateAge, readOwnServerRateRouteAllowed } from './exchangeRatesHub';
import { recordRequest } from './requestBudget';

export const AUTO_RATE_STATE_KEY = 'palmyra:auto-rate-state.v1';
export const AUTO_RATE_EVENT = 'palmyra:auto-rates-updated';

/** Una consulta de nube más vieja que esto no se aplica. */
const MAX_PAYLOAD_AGE_MS = 30 * 60 * 1000;
/** Una copia del hub vale hasta 60 min: su cadencia es de 45 min. */
const HUB_PAYLOAD_MAX_AGE_MS = RATE_SNAPSHOT_MAX_AGE_MS;
/**
 * Separación mínima entre ciclos: algo menos que la cadencia del hub (45 min)
 * para alcanzar cada refresco sin bucles de 25 minutos.
 */
export const AUTO_RATE_MIN_GAP_MS = RATE_TARGET_MS - 5 * 60 * 1000;
const MIN_RUN_GAP_MS = AUTO_RATE_MIN_GAP_MS;

/**
 * Ruta relativa del servidor PALMYRA. El renderer nunca construye una URL
 * externa de elTOQUE: si esta superficie no es autónoma, conserva la última
 * tasa válida que le repartió el hub.
 */
export const CLIENT_RATE_ROUTE = '/api/exchange-rates';

/** Endpoint que usa el cliente; exportado para verificar que no apunta afuera. */
export function clientRateEndpoint(): string {
  return CLIENT_RATE_ROUTE;
}

export type AutoRateChange = { code: string; from: number; to: number; confirmed: boolean };
export type AutoRateSkip = { code: string; from: number; to: number; delta: number };

export type AutoRateRun = {
  at: string;
  capturedAt?: string;
  applied: AutoRateChange[];
  skipped: AutoRateSkip[];
  error?: string;
};

/** Lo mínimo del store que la sincronización necesita (inyectable en pruebas). */
export type AutoRateStoreView = {
  storeConfig?: { autoRateSync?: boolean; autoRateThreshold?: number } | null;
  currencies: Array<{ code: string; rateToBase: number }>;
  getBaseCurrency?: () => { code?: string | null } | null | undefined;
  updateCurrencyRate: (code: string, rate: number) => Promise<boolean> | boolean;
};

export type AutoRateSyncOptions = {
  force?: boolean;
  /** Cotizaciones del hub inyectadas en pruebas; por defecto se piden a la sesión LAN. */
  hubRates?: () => Promise<HubRateQuote[]>;
  /** Reloj inyectable en pruebas. */
  clock?: () => number;
  /**
   * Permite (o niega) la ruta `/api/exchange-rates` del propio servidor. Por
   * defecto se decide con la sesión de hub: un cliente nunca consulta elTOQUE
   * por su cuenta.
   */
  allowOwnServerRoute?: boolean;
};

export function readAutoRateRun(): AutoRateRun | null {
  try {
    const value = JSON.parse(localStorage.getItem(AUTO_RATE_STATE_KEY) || 'null');
    return value && typeof value === 'object' && Array.isArray(value.applied) ? value as AutoRateRun : null;
  } catch {
    return null;
  }
}

function saveRun(run: AutoRateRun): AutoRateRun {
  try { localStorage.setItem(AUTO_RATE_STATE_KEY, JSON.stringify(run)); } catch { /* almacenamiento lleno */ }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTO_RATE_EVENT, { detail: run }));
  }
  return run;
}

function readCachedPayload(): ExchangePayload | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(EXCHANGE_RATE_CACHE_KEY) || 'null');
    return isElToquePayload(value) ? value : null;
  } catch {
    return null;
  }
}

/** Antigüedad legible de la última captura, para los avisos en español. */
function rateAgeMs(capturedAt: string, now: number = Date.now()): number | null {
  const parsed = Date.parse(capturedAt);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

async function fetchLatestPayload(): Promise<{ payload?: ExchangePayload; error?: string }> {
  const startedAt = Date.now();
  try {
    // Un reintento cubre el cold start de Render sin duplicar el trabajo del
    // usuario: la consulta corre en segundo plano con la cadencia del hub.
    const { response, body } = await fetchJsonWithRetry<any>(clientRateEndpoint(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    }, { timeoutMs: 12_000, retries: 1 });
    recordRequest('rates/client', { ms: Date.now() - startedAt, ok: response.ok });
    if (!response.ok) {
      return { error: typeof body?.error === 'string' ? body.error : 'No se pudo consultar la tasa de cambio. Se reintentará automáticamente.' };
    }
    if (!isElToquePayload(body)) return { error: 'La fuente de tasas respondió sin cotizaciones válidas. Se conservan las últimas guardadas.' };
    return { payload: body };
  } catch (error) {
    recordRequest('rates/client', { ms: Date.now() - startedAt, ok: false });
    return { error: describeNetworkError(error) };
  }
}

/**
 * Tasas del hub LAN si este equipo está emparejado; `null` si no hay sesión o
 * el hub falla, para seguir con la consulta directa sin romper el flujo. El hub
 * ya consultó elTOQUE: aquí no viajan credenciales de elTOQUE.
 */
async function fetchHubPayload(options: AutoRateSyncOptions): Promise<ExchangePayload | null> {
  const clock = options.clock ?? (() => Date.now());
  if (options.hubRates) {
    try { return hubQuotesToPayload(await options.hubRates(), clock()); } catch { return null; }
  }
  try {
    // Carga perezosa: si no hay hub emparejado, la importación falla o no
    // devuelve tasas, la sincronización continúa por la ruta directa.
    const hub = await import('./exchangeRatesHub');
    return await hub.fetchHubAutoRatePayload({ clock });
  } catch {
    return null;
  }
}

/**
 * Respaldo de nube para superficies autónomas sin credencial local (Windows y
 * APK): una sola consulta al endpoint de producción, que sí tiene la credencial
 * de elTOQUE. Devuelve `null` sin lanzar; si falla, el error de la ruta local
 * se conserva para el aviso.
 */
async function fetchCloudPayload(options: AutoRateSyncOptions): Promise<ExchangePayload | null> {
  const clock = options.clock ?? (() => Date.now());
  try {
    const hub = await import("./exchangeRatesHub");
    const quotes = await hub.fetchCloudRateQuotes({ now: clock });
    if (!quotes || !quotes.length) return null;
    return hubQuotesToPayload(quotes, clock());
  } catch {
    return null;
  }
}

/**
 * Aplica la cotización del hub LAN (o de elTOQUE si no hay hub) solo cuando la
 * diferencia alcanza el umbral configurado. Nunca escribe tasas con datos
 * viejos, cacheados o inválidos.
 */
export async function runAutoRateSync(options: AutoRateSyncOptions = {}): Promise<AutoRateRun> {
  const { useStore } = await import('../store/useStore');
  return syncAutoRates(useStore.getState() as unknown as AutoRateStoreView, options);
}

/** Núcleo de la sincronización, independiente del store para poder probarlo. */
export async function syncAutoRates(
  state: AutoRateStoreView,
  options: AutoRateSyncOptions = {}
): Promise<AutoRateRun> {
  const at = new Date().toISOString();
  const config: NonNullable<AutoRateStoreView['storeConfig']> = state.storeConfig || {};
  const baseRun = (error?: string): AutoRateRun => ({ at, applied: [], skipped: [], ...(error ? { error } : {}) });

  if (!config.autoRateSync) return baseRun('La sincronización automática está desactivada.');

  const previous = readAutoRateRun();
  // Un ciclo fallido no bloquea el reintento del hub: solo se evita repetir un
  // ciclo exitoso antes de que el hub haya publicado una tasa nueva.
  const recentlyRan = Boolean(previous?.at) && Date.now() - Date.parse(previous!.at) < MIN_RUN_GAP_MS;
  if (!options.force && recentlyRan && !previous?.error) return previous!;

  // Hub LAN primero: un solo equipo consulta elTOQUE y reparte la tasa.
  const hubPayload = await fetchHubPayload(options);
  let payload: ExchangePayload | undefined = hubPayload ?? undefined;
  const fromHub = payload !== undefined;
  let error: string | undefined;
  if (!payload) {
    // Sin sesión de hub la superficie es autónoma y puede pedir su propia ruta;
    // un cliente de hub se queda con la última tasa válida. Nunca se consulta
    // elTOQUE directamente desde aquí.
    const allowed = options.allowOwnServerRoute ?? await readOwnServerRateRouteAllowed();
    if (allowed) {
      ({ payload, error } = await fetchLatestPayload());
      // Sin tasas por la ruta propia, una consulta de respaldo a la nube de
      // producción (desktop/APK sin credencial local). Si tampoco responde,
      // se conserva el error de la ruta local para el aviso.
      if (!payload) {
        payload = (await fetchCloudPayload(options)) ?? undefined;
      }
    } else {
      const last = readCachedPayload();
      if (!last) {
        return saveRun(baseRun('Sin conexión con el hub LAN y sin una tasa guardada; no se consulta elTOQUE desde este equipo.'));
      }
      return saveRun({
        ...baseRun(`Sin conexión con el hub LAN. Se conserva la última tasa válida (${formatRateAge(rateAgeMs(last.capturedAt))}).`),
        capturedAt: last.capturedAt
      });
    }
  }
  if (!payload) return saveRun(baseRun(error));

  try { localStorage.setItem(EXCHANGE_RATE_CACHE_KEY, JSON.stringify(payload)); } catch { /* sin almacenamiento */ }

  const captured = Date.parse(payload.capturedAt);
  if (payload.stale) {
    return saveRun({
      ...baseRun(`elTOQUE no respondió en vivo. Se conserva la última tasa válida (${formatRateAge(rateAgeMs(payload.capturedAt))}).`),
      capturedAt: payload.capturedAt
    });
  }
  const maxAgeMs = fromHub ? HUB_PAYLOAD_MAX_AGE_MS : MAX_PAYLOAD_AGE_MS;
  if (!Number.isFinite(captured) || Date.now() - captured > maxAgeMs) {
    return saveRun({
      ...baseRun(`La última cotización tiene más de ${Math.round(maxAgeMs / 60_000)} minutos; no se aplicó.`),
      capturedAt: payload.capturedAt
    });
  }

  const threshold = normalizeAutoRateThreshold(config.autoRateThreshold);
  const ratesCup = collectCupRates(payload.data);
  const baseCode = (typeof state.getBaseCurrency === 'function' ? state.getBaseCurrency()?.code : null) || 'CUP';
  const applied: AutoRateChange[] = [];
  const skipped: AutoRateSkip[] = [];

  for (const code of AUTO_RATE_CODES) {
    if (code === baseCode) continue;
    const currency = state.currencies.find(item => item.code === code);
    if (!currency) continue;
    const candidate = rateToBaseFromCup(ratesCup, code, baseCode);
    const decision = decideAutoRate(currency.rateToBase, candidate, threshold);
    if (!decision) continue;
    if (!decision.apply) {
      skipped.push({ code, from: decision.from, to: decision.to, delta: decision.delta });
      continue;
    }
    const confirmed = await state.updateCurrencyRate(code, decision.to);
    applied.push({ code, from: decision.from, to: decision.to, confirmed });
  }

  return saveRun({ at, capturedAt: payload.capturedAt, applied, skipped });
}

export { readCachedPayload as readCachedAutoRatePayload };
