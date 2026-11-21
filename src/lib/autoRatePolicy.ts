import { parseExchangeRates } from './exchangeRates';

export const AUTO_RATE_THRESHOLD_DEFAULT = 5;
export const AUTO_RATE_MIN_THRESHOLD = 1;
export const AUTO_RATE_MAX_THRESHOLD = 500;
export const AUTO_RATE_CODES = ['USD', 'EUR', 'MLC'] as const;
export type AutoRateCode = typeof AUTO_RATE_CODES[number];

const CODE_ALIASES: Record<string, string[]> = { EUR: ['EUR', 'ECU'], USD: ['USD'], MLC: ['MLC'] };

export function normalizeAutoRateThreshold(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return AUTO_RATE_THRESHOLD_DEFAULT;
  return Math.min(AUTO_RATE_MAX_THRESHOLD, Math.max(AUTO_RATE_MIN_THRESHOLD, Math.round(numeric)));
}

/** CUP por unidad de cada moneda publicada por elTOQUE. */
export function collectCupRates(data: unknown): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const rate of parseExchangeRates(data)) {
    const value = rate.value ?? rate.sell ?? rate.buy;
    if (value === undefined || value <= 0) continue;
    rates[rate.code] = value;
  }
  return rates;
}

function findCupRate(ratesCup: Record<string, number>, code: string): number | undefined {
  for (const alias of CODE_ALIASES[code] || [code]) {
    const value = ratesCup[alias];
    if (value !== undefined && value > 0) return value;
  }
  return undefined;
}

export function rateToBaseFromCup(
  ratesCup: Record<string, number>,
  code: string,
  baseCode: string
): number | undefined {
  if (code === baseCode) return undefined;
  const codeRate = findCupRate(ratesCup, code);
  if (codeRate === undefined) return undefined;
  if (baseCode === 'CUP') return roundRate(codeRate);
  const baseRate = findCupRate(ratesCup, baseCode);
  if (baseRate === undefined || baseRate <= 0) return undefined;
  return roundRate(codeRate / baseRate);
}

export function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

export type AutoRateDecision = {
  from: number;
  to: number;
  delta: number;
  /** true cuando la diferencia alcanza el umbral (o no hay tasa previa). */
  apply: boolean;
};

export function decideAutoRate(
  current: number | null | undefined,
  candidate: number | undefined,
  threshold: number
): AutoRateDecision | null {
  if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) return null;
  const to = roundRate(candidate);
  const from = Number.isFinite(Number(current)) ? Number(current) : 0;
  if (from <= 0) return { from: 0, to, delta: to, apply: true };
  const delta = roundRate(to - from);
  const limit = normalizeAutoRateThreshold(threshold);
  // Los cambios menores al umbral son ruido de la fuente y no deben mover precios.
  return { from, to, delta, apply: Math.abs(delta) >= limit - 1e-9 };
}
