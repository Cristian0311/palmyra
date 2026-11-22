import { useStore } from '../store/useStore';
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

export const AUTO_RATE_STATE_KEY = 'palmyra:auto-rate-state.v1';
export const AUTO_RATE_EVENT = 'palmyra:auto-rates-updated';

const MAX_PAYLOAD_AGE_MS = 30 * 60 * 1000;
const MIN_RUN_GAP_MS = 60 * 1000;

export type AutoRateChange = { code: string; from: number; to: number; confirmed: boolean };
export type AutoRateSkip = { code: string; from: number; to: number; delta: number };

export type AutoRateRun = {
  at: string;
  capturedAt?: string;
  applied: AutoRateChange[];
  skipped: AutoRateSkip[];
  error?: string;
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

async function fetchLatestPayload(): Promise<{ payload?: ExchangePayload; error?: string }> {
  try {
    // Un reintento cubre el cold start de Render sin duplicar el trabajo del
    // usuario: la consulta corre en segundo plano cada 5 minutos.
    const { response, body } = await fetchJsonWithRetry<any>('/api/exchange-rates', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    }, { timeoutMs: 12_000, retries: 1 });
    if (!response.ok) {
      return { error: typeof body?.error === 'string' ? body.error : 'No se pudo consultar la tasa de cambio. Se reintentará automáticamente.' };
    }
    if (!isElToquePayload(body)) return { error: 'La fuente de tasas respondió sin cotizaciones válidas. Se conservan las últimas guardadas.' };
    return { payload: body };
  } catch (error) {
    return { error: describeNetworkError(error) };
  }
}

/**
 * Aplica la cotización de elTOQUE solo cuando la diferencia alcanza el umbral
 * configurado. Nunca escribe tasas con datos viejos, cacheados o inválidos.
 */
export async function runAutoRateSync(options: { force?: boolean } = {}): Promise<AutoRateRun> {
  const at = new Date().toISOString();
  const state = useStore.getState();
  const config = state.storeConfig || ({} as typeof state.storeConfig);
  const baseRun = (error?: string): AutoRateRun => ({ at, applied: [], skipped: [], ...(error ? { error } : {}) });

  if (!config.autoRateSync) return baseRun('La sincronización automática está desactivada.');

  const previous = readAutoRateRun();
  if (!options.force && previous?.at && Date.now() - Date.parse(previous.at) < MIN_RUN_GAP_MS) return previous;

  const { payload, error } = await fetchLatestPayload();
  if (!payload) return saveRun(baseRun(error));

  try { localStorage.setItem(EXCHANGE_RATE_CACHE_KEY, JSON.stringify(payload)); } catch { /* sin almacenamiento */ }

  const captured = Date.parse(payload.capturedAt);
  if (payload.stale) {
    return saveRun({ ...baseRun('elTOQUE no respondió en vivo. Se conservan las tasas actuales.'), capturedAt: payload.capturedAt });
  }
  if (!Number.isFinite(captured) || Date.now() - captured > MAX_PAYLOAD_AGE_MS) {
    return saveRun({ ...baseRun('La última cotización tiene más de 30 minutos; no se aplicó.'), capturedAt: payload.capturedAt });
  }

  const threshold = normalizeAutoRateThreshold(config.autoRateThreshold);
  const ratesCup = collectCupRates(payload.data);
  const baseCode = state.getBaseCurrency()?.code || 'CUP';
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

export const AUTO_RATE_CACHE_KEY = EXCHANGE_RATE_CACHE_KEY;
export { readCachedPayload as readCachedAutoRatePayload };
