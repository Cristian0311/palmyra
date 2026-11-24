/**
 * Equivalentes en divisas para las cifras del inventario.
 *
 * El inventario siempre se expresa en CUP (moneda base): estas utilidades no
 * sustituyen ninguna cifra, solo añaden una referencia «≈ $X USD · €Y EUR».
 * `value` es la tasa activa en CUP por unidad (p. ej. 1 USD = 320 CUP), la
 * misma que usa el POS para cobrar. Sin tasa válida el equivalente es `null`
 * y la pantalla muestra «—»: nunca se inventa una conversión.
 */

export interface CurrencyRate {
  /** Código canónico de la divisa (USD, EUR…). */
  code: string;
  /** CUP por unidad. Debe ser finito y mayor que 0 para usarse. */
  value: number;
}

export interface CurrencyEquivalents {
  USD: number | null;
  EUR: number | null;
}

export interface StoreCurrencyLike {
  code: string;
  rateToBase?: number | null;
  isBase?: boolean;
}

export interface ServiceRatesOptions {
  /** Reloj inyectable (pruebas). */
  now?: () => number;
  /** Ventana mínima entre consultas al servicio de tasas. */
  cooldownMs?: number;
}

/** Dos consultas del servicio en 15 min son suficientes: el hub publica cada 45. */
export const SERVICE_RATES_COOLDOWN_MS = 15 * 60 * 1000;
const DISPLAY_CODES = ['USD', 'EUR'] as const;
const DISPLAY_SYMBOLS: Record<(typeof DISPLAY_CODES)[number], string> = { USD: '$', EUR: '€' };

function normalizeCode(code: unknown): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

/**
 * Convierte un importe en CUP a USD y EUR con las tasas dadas (CUP por unidad).
 * Acepta importes negativos. Tasa ausente, cero, negativa o no numérica → null.
 */
export function currencyEquivalents(
  amountCup: number,
  rates: readonly CurrencyRate[] | null | undefined
): CurrencyEquivalents {
  const amount = Number.isFinite(amountCup) ? amountCup : 0;
  const byCode = new Map<string, number>();
  for (const rate of rates || []) {
    const code = normalizeCode(rate?.code);
    const value = Number(rate?.value);
    if (!code || !Number.isFinite(value) || value <= 0) continue;
    if (!byCode.has(code)) byCode.set(code, value);
  }
  const convert = (code: string): number | null => {
    const value = byCode.get(code);
    return value && Number.isFinite(value) ? amount / value : null;
  };
  return { USD: convert('USD'), EUR: convert('EUR') };
}

/**
 * Cada divisa por separado: `['$1.234,56 USD', '€1.100,00 EUR']`. Sirve para
 * pintar USD y EUR en líneas independientes cuando la columna es estrecha
 * (tablas de inventario) y así no se corta ni desborda la segunda divisa.
 * Sin ninguna tasa devuelve un arreglo vacío.
 */
export function formatCurrencyEquivalentParts(
  equivalents: CurrencyEquivalents | null | undefined,
  options: { signed?: boolean; compact?: boolean } = {}
): string[] {
  const parts: string[] = [];
  for (const code of DISPLAY_CODES) {
    const value = equivalents ? equivalents[code] : null;
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const sign = value < 0 ? '-' : options.signed && value > 0 ? '+' : '';
    // `compact` es para las tarjetas KPI: sin decimales entra en una sola línea.
    const formatted = Math.abs(value).toLocaleString('es-CU', options.compact
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    parts.push(`${sign}${DISPLAY_SYMBOLS[code]}${formatted} ${code}`);
  }
  return parts;
}

/**
 * Línea secundaria lista para la pantalla: «≈ $1.234,56 USD · €1.100,00 EUR».
 * Con una sola divisa se muestra solo esa. Sin ninguna tasa devuelve «—».
 * Con `signed` conserva el signo del importe (ganancia negativa incluida).
 */
export function formatCurrencyEquivalents(
  equivalents: CurrencyEquivalents | null | undefined,
  options: { signed?: boolean; compact?: boolean } = {}
): string {
  const parts = formatCurrencyEquivalentParts(equivalents, options);
  return parts.length ? `≈ ${parts.join(' · ')}` : '—';
}

/**
 * Tasas activas del negocio a partir de `currencies` (manuales o escritas por
 * la sincronización automática). `rateToBase` ya es CUP por unidad cuando la
 * moneda base es CUP. Se ignoran la base y las tasas inválidas.
 */
export function ratesFromCurrencies(
  currencies: readonly StoreCurrencyLike[] | null | undefined,
  baseCode?: string | null
): CurrencyRate[] {
  const base = normalizeCode(baseCode);
  const rates: CurrencyRate[] = [];
  for (const currency of currencies || []) {
    const code = normalizeCode(currency?.code);
    if (!code || currency?.isBase === true || code === base) continue;
    const value = Number(currency?.rateToBase);
    if (!Number.isFinite(value) || value <= 0) continue;
    rates.push({ code, value });
  }
  return rates;
}

/**
 * Mezcla tasas: las de `primary` (tasas activas del negocio) mandan; las de
 * `fallback` solo rellenan divisas ausentes. Así una tasa manual nunca se
 * reemplaza por una cotización de mercado.
 */
export function mergeCurrencyRates(
  primary: readonly CurrencyRate[] | null | undefined,
  fallback: readonly CurrencyRate[] | null | undefined
): CurrencyRate[] {
  const merged = new Map<string, number>();
  for (const rate of fallback || []) {
    const code = normalizeCode(rate?.code);
    const value = Number(rate?.value);
    if (code && Number.isFinite(value) && value > 0) merged.set(code, value);
  }
  for (const rate of primary || []) {
    const code = normalizeCode(rate?.code);
    const value = Number(rate?.value);
    if (code && Number.isFinite(value) && value > 0) merged.set(code, value);
  }
  return [...merged].map(([code, value]) => ({ code, value }));
}

/* ------------------------------------------------------------------ */
/* Carga diferida desde el servicio de tasas existente                 */
/* ------------------------------------------------------------------ */

let serviceRatesCache: { at: number; rates: CurrencyRate[] } | null = null;
let serviceRatesInFlight: Promise<CurrencyRate[]> | null = null;

/**
 * Pide las cotizaciones al servicio de tasas (`resolveExchangeRates`, que ya
 * resuelve hub/respaldo/última guardada) con un enfriamiento módulo-level para
 * que abrir el inventario varias veces no repita la consulta. Nunca lanza y
 * nunca bloquea el render: sin tasas devuelve `[]` y la pantalla sigue en CUP.
 */
export function loadServiceCurrencyRates(options: ServiceRatesOptions = {}): Promise<CurrencyRate[]> {
  const clock = options.now ?? (() => Date.now());
  const cooldown = Number.isFinite(options.cooldownMs) ? Math.max(0, options.cooldownMs as number) : SERVICE_RATES_COOLDOWN_MS;
  const now = clock();
  if (serviceRatesCache && now - serviceRatesCache.at < cooldown) {
    return Promise.resolve(serviceRatesCache.rates);
  }
  if (serviceRatesInFlight) return serviceRatesInFlight;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve([]);

  serviceRatesInFlight = (async () => {
    let rates: CurrencyRate[] = [];
    try {
      const { resolveExchangeRates } = await import('../../../services/exchangeRatesHub');
      const resolved = await resolveExchangeRates();
      rates = (resolved?.rates || [])
        .map(quote => ({ code: normalizeCode(quote?.code), value: Number(quote?.rate) }))
        .filter(rate => rate.code && Number.isFinite(rate.value) && rate.value > 0);
    } catch {
      rates = [];
    } finally {
      // También se cachea el fallo: el enfriamiento evita reintentos en bucle.
      serviceRatesCache = { at: clock(), rates };
      serviceRatesInFlight = null;
    }
    return rates;
  })();

  return serviceRatesInFlight;
}
