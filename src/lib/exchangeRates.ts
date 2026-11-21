export const EXCHANGE_RATE_CACHE_KEY = 'palmyra.exchange-rate-last-payload.v1';

export type ExchangeRate = { code: string; value?: number; buy?: number; sell?: number };
export type ExchangePayload = {
  provider: 'eltoque';
  source: 'elTOQUE API';
  market: 'informal';
  capturedAt: string;
  data: unknown;
  stale?: boolean;
  notice?: string;
};
export type RateSnapshot = { capturedAt: string; rates: Record<string, number> };

const CONTAINERS = ['tasas', 'rates', 'data', 'result', 'exchangeRates', 'exchange_rates', 'cotizaciones'];
const METADATA = new Set(['DATE', 'TIMESTAMP', 'COUNT', 'TOTAL', 'STATUS', 'SUCCESS', 'VERSION', 'BASE', 'UPDATED_AT', 'CAPTUREDAT']);

function positive(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const number = typeof value === 'number' ? value : Number(value.trim().replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const direct = positive(value);
    if (direct !== undefined) return direct;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const number = positive(nested.value ?? nested.rate ?? nested.valor ?? nested.tasa ?? nested.median ?? nested.mediana);
      if (number !== undefined) return number;
    }
  }
  return undefined;
}

export function parseExchangeRates(data: unknown): ExchangeRate[] {
  let list = data;
  for (let depth = 0; depth < 5 && list && typeof list === 'object' && !Array.isArray(list); depth++) {
    const object = list as Record<string, unknown>;
    const key = CONTAINERS.find(key => object[key] != null);
    if (!key) break;
    list = object[key];
  }
  if (!list || typeof list !== 'object') return [];
  const entries: [string, unknown][] = Array.isArray(list) ? list.map(item => ['', item]) : Object.entries(list);
  const rates = new Map<string, ExchangeRate>();
  for (const [fallback, raw] of entries) {
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const code = String(row?.code ?? row?.currency ?? row?.moneda ?? row?.symbol ?? row?.codigo ?? fallback).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{1,19}$/.test(code) || METADATA.has(code)) continue;
    const value = row
      ? firstNumber(row.rate, row.value, row.valor, row.tasa, row.tasa_referencia, row.reference, row.median, row.mediana, row.trm, row.promedio, row.price, row.precio, row.last, row.rate_mid, row.compra_venta)
      : firstNumber(raw);
    const buy = row ? firstNumber(row.buy, row.compra, row.bid, row.tasa_compra, row.median_buy, row.mediana_compra, row.compra_mediana, row.rate_buy) : undefined;
    const sell = row ? firstNumber(row.sell, row.venta, row.ask, row.tasa_venta, row.median_sell, row.mediana_venta, row.venta_mediana, row.rate_sell) : undefined;
    if (value === undefined && buy === undefined && sell === undefined) continue;
    rates.set(code, { code, value, buy, sell });
  }
  return [...rates.values()];
}

export function isElToquePayload(value: unknown): value is ExchangePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as ExchangePayload;
  return payload.provider === 'eltoque' && payload.source === 'elTOQUE API' && payload.market === 'informal'
    && Number.isFinite(Date.parse(payload.capturedAt)) && parseExchangeRates(payload.data).length > 0;
}

export function readRateSnapshots(value: unknown): RateSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || !Number.isFinite(Date.parse(item.capturedAt)) || !item.rates || typeof item.rates !== 'object') return [];
    const rates = Object.fromEntries(parseExchangeRates(item.rates).filter(rate => rate.value !== undefined).map(rate => [rate.code, rate.value!]));
    return Object.keys(rates).length ? [{ capturedAt: item.capturedAt as string, rates }] : [];
  }).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
}

export function appendRateSnapshot(history: RateSnapshot[], payload: ExchangePayload): RateSnapshot[] {
  if (payload.stale || history.some(item => item.capturedAt === payload.capturedAt)) return history;
  const rates = Object.fromEntries(parseExchangeRates(payload.data).flatMap(rate => rate.value === undefined ? [] : [[rate.code, rate.value]]));
  if (!Object.keys(rates).length) return history;
  return [...history, { capturedAt: payload.capturedAt, rates }].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt)).slice(-2500);
}

export function isCryptoRate(code: string): boolean {
  return /^(BTC|ETH|BNB|TRX|USDT(?:TRC20?|ERC20)?|USDC|LTC|DOGE|SOL|XRP|TON|ADA|BCH|DOT|AVAX|SHIB|LINK|XMR|MATIC|POL)$/.test(code.replace(/[-_\s]/g, ''));
}

export const RATE_NAMES: Record<string, string> = {
  USD: 'Dólar estadounidense', EUR: 'Euro', ECU: 'Euro (código ECU de la fuente)', MLC: 'Moneda libremente convertible',
  CAD: 'Dólar canadiense', MXN: 'Peso mexicano', GBP: 'Libra esterlina', CHF: 'Franco suizo', RUB: 'Rublo ruso', CUP: 'Peso cubano',
  CNY: 'Yuan chino', JPY: 'Yen japonés', BRL: 'Real brasileño', COP: 'Peso colombiano', DOP: 'Peso dominicano', AUD: 'Dólar australiano',
  NZD: 'Dólar neozelandés', ZELLE: 'Zelle · pagos en USD', CLA: 'Clásica', BTC: 'Bitcoin', ETH: 'Ethereum', BNB: 'BNB', TRX: 'TRON',
  USDT: 'Tether', USDTTRC20: 'Tether · TRC-20', USDTTRC: 'Tether · TRC-20', USDC: 'USD Coin', LTC: 'Litecoin', DOGE: 'Dogecoin',
  SOL: 'Solana', XRP: 'XRP', TON: 'Toncoin'
};
