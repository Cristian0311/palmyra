/**
 * Tasas para los equipos de la red local.
 *
 * El hub es el único que habla con elTOQUE (cada 45 min, acotado 30-60) y
 * guarda la última copia válida junto a su base local. Este módulo sirve esa
 * copia a `GET /lan/v1/rates` sin tocar la red: el proceso principal inyecta un
 * `cacheReader`. Solo si la caché está vacía y hay credencial de elTOQUE
 * (`tokenProvider`) el hub consulta su propio servidor local; el renderer de un
 * cliente nunca usa este camino ni habla con elTOQUE.
 */
import { canonicalizeRates, parseExchangeRates, type ExchangePayload } from "../../lib/exchangeRates";
import {
  RATE_FAILURE_MIN_MS,
  RATE_SNAPSHOT_MAX_AGE_MS,
  RATE_TARGET_MS,
  normalizeSnapshotQuotes,
  readRateSnapshot,
  type HubRateSnapshot
} from "./rateScheduler";
import type { HubRateQuote } from "./protocol";

/** Cadencia del hub: la copia se considera vigente hasta su próximo ciclo. */
export const HUB_RATES_TTL_MS = RATE_TARGET_MS;
/** Tras un intento fallido sin caché no se reintenta enseguida. */
const HUB_RATES_FAILURE_COOLDOWN_MS = RATE_FAILURE_MIN_MS;
const DEFAULT_LOCAL_PORT = 10000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LOCAL_PORT = 65535;

export interface HubRatesProviderOptions {
  /** `fetch` inyectable para pruebas; nunca se llama a Internet desde aquí. */
  fetchImpl?: typeof fetch;
  /** Raíz del servidor local, p. ej. `http://127.0.0.1:10000`. */
  localBaseUrl?: string;
  /** `VITE_DESKTOP_SERVER_URL` inyectable en pruebas. */
  envUrl?: string;
  /** Estado del puente de escritorio inyectable en pruebas. */
  desktopStatus?: () => Promise<unknown> | unknown;
  /** Milisegundos que una consulta se considera fresca. 45 min por defecto. */
  ttlMs?: number;
  /** Reloj inyectable para pruebas. */
  now?: () => number;
  /** Tiempo máximo de espera de la consulta local. */
  timeoutMs?: number;
  /**
   * Copia que mantiene el dueño del hub (proceso principal). Cuando se inyecta,
   * se sirve siempre sin red; es la vía normal del hub.
   */
  cacheReader?: () => HubRateSnapshot | HubRateQuote[] | null | undefined
    | Promise<HubRateSnapshot | HubRateQuote[] | null | undefined>;
  /**
   * Credencial de elTOQUE disponible en el servidor local. Solo con ella el
   * hub se permite una consulta propia cuando la caché está vacía. Nunca se
   * entrega al renderer.
   */
  tokenProvider?: () => string | null | undefined;
  /** Antigüedad máxima de la copia antes de marcarla `stale`. 60 min. */
  maxAgeMs?: number;
}

function environmentPort(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const parsed = Number(env?.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_LOCAL_PORT ? parsed : DEFAULT_LOCAL_PORT;
}

function validPort(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_LOCAL_PORT ? parsed : null;
}

/** Solo orígenes http(s) absolutos; cualquier otra pista se descarta. */
function absoluteHttpOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (!value) return `http://127.0.0.1:${environmentPort()}`;
  return value;
}

/** Pistas disponibles para localizar el servidor local de este equipo. */
export interface LocalServerHints {
  /** Raíz explícita (la que ya resolvió otra capa). */
  localBaseUrl?: string;
  /** `VITE_DESKTOP_SERVER_URL` tal cual venga del build. */
  envUrl?: string;
  /** Origen de la ventana: el shell se sirve desde el propio servidor local. */
  windowOrigin?: string;
  /** Puerto del servidor local publicado por el runtime de escritorio. */
  runtimePort?: number | null;
}

/**
 * Raíz del servidor local sin asumir el puerto 10000.
 *
 * Orden: URL explícita, `VITE_DESKTOP_SERVER_URL`, origen de la ventana y
 * puerto del runtime; si nada sirve, `undefined` para que el llamador aplique
 * su último recurso (`PORT` o 10000). Nunca lanza: una pista corrupta se
 * ignora.
 */
export function resolveLocalServerBaseUrl(hints: LocalServerHints = {}): string | undefined {
  const explicit = absoluteHttpOrigin(hints.localBaseUrl);
  if (explicit) return explicit;
  const fromEnv = absoluteHttpOrigin(hints.envUrl);
  if (fromEnv) return fromEnv;
  const fromWindow = absoluteHttpOrigin(hints.windowOrigin);
  if (fromWindow) return fromWindow;
  const port = validPort(hints.runtimePort);
  return port ? `http://127.0.0.1:${port}` : undefined;
}

/** `VITE_DESKTOP_SERVER_URL` del build; ausente en Node y en pruebas. */
export function viteDesktopServerUrl(): string | undefined {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
    const value = env?.VITE_DESKTOP_SERVER_URL;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Puerto del servidor local dentro del estado del runtime. El campo `port` del
 * estado es el del hub LAN (48900), que no sirve `/api/exchange-rates`; solo se
 * aceptan nombres explícitos del servidor HTTP.
 */
export function serverPortFromStatus(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) return null;
  const nested = record.status && typeof record.status === "object" && !Array.isArray(record.status)
    ? (record.status as Record<string, unknown>)
    : record;
  return validPort(nested.serverPort) ?? validPort(nested.httpPort) ?? null;
}

/** Origen http(s) de la ventana actual, si esta corre en web o escritorio. */
export function windowOriginHint(): string | undefined {
  try {
    const location = (globalThis as { location?: { origin?: unknown } }).location;
    return typeof location?.origin === "string" ? location.origin : undefined;
  } catch {
    return undefined;
  }
}

type DesktopStatusProbe = () => Promise<unknown> | unknown;

/** Puente del preload de Electron, si existe en esta ventana. */
function desktopHubProbe(): DesktopStatusProbe | null {
  if (typeof window === "undefined") return null;
  try {
    const bridge = (window as unknown as { palmyraDesktopHub?: { status?: unknown } }).palmyraDesktopHub;
    const status = bridge?.status;
    if (!bridge || typeof status !== "function") return null;
    return () => Promise.resolve().then(() => (status as () => Promise<unknown>).call(bridge));
  } catch {
    return null;
  }
}

/** Lee el puerto del runtime sin romper si el puente falla o no existe. */
async function runtimeDesktopPort(probe: DesktopStatusProbe | undefined): Promise<number | null> {
  const source = probe ?? desktopHubProbe();
  if (!source) return null;
  try {
    return serverPortFromStatus(await source());
  } catch {
    return null;
  }
}

/** URL de la ruta de tasas del servidor local (la misma que usa el POS). */
export function localExchangeRatesUrl(baseUrl?: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/exchange-rates`;
}

function isoOrNow(value: unknown, nowMs: number): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(nowMs).toISOString();
}

function sourceOf(payload: Record<string, unknown>): string {
  return typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : "elTOQUE API";
}

/**
 * Convierte la respuesta del servidor local (payload de elTOQUE, con la misma
 * forma que `/api/exchange-rates`) en cotizaciones normalizadas del hub.
 * Devuelve `[]` cuando la respuesta no trae tasas válidas.
 */
export function normalizeLocalRatesPayload(payload: unknown, nowMs: number): HubRateQuote[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const body = payload as Record<string, unknown>;
  if (!body.data || typeof body.data !== "object") return [];
  const capturedAt = isoOrNow(body.capturedAt, nowMs);
  const stale = body.stale === true;
  const source = sourceOf(body);
  return canonicalizeRates(parseExchangeRates(body.data)).flatMap(rate => {
    const value = rate.value ?? rate.buy ?? rate.sell;
    if (value === undefined || !Number.isFinite(value) || value <= 0) return [];
    return [{ code: rate.code, rate: value, capturedAt, source, stale }];
  });
}

/**
 * Adapta las cotizaciones normalizadas al payload que ya consume el resto del
 * POS (misma forma que `/api/exchange-rates`), sin volver a consultar elTOQUE
 * desde el cliente. Devuelve `null` si no hay ninguna tasa utilizable.
 */
export function hubQuotesToPayload(quotes: HubRateQuote[], nowMs = Date.now()): ExchangePayload | null {
  const data: Record<string, number> = {};
  let captured = 0;
  let stale = false;
  for (const quote of quotes) {
    if (!Number.isFinite(quote.rate) || quote.rate <= 0) continue;
    data[quote.code] = quote.rate;
    const parsed = Date.parse(quote.capturedAt);
    if (Number.isFinite(parsed)) captured = Math.max(captured, parsed);
    stale = stale || quote.stale;
  }
  if (!Object.keys(data).length) return null;
  return {
    provider: "eltoque",
    source: "elTOQUE API",
    market: "informal",
    capturedAt: new Date(captured || nowMs).toISOString(),
    data: { tasas: data },
    ...(stale
      ? { stale: true, notice: "El hub LAN entregó su última tasa válida; no es una consulta en vivo." }
      : {})
  };
}

/** Copia inyectada -> cotizaciones válidas; `null` si no hay nada usable. */
function quotesFromCache(value: HubRateSnapshot | HubRateQuote[] | null | undefined): HubRateQuote[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const quotes = normalizeSnapshotQuotes(value);
    return quotes.length ? quotes : null;
  }
  const snapshot = readRateSnapshot(value);
  return snapshot ? snapshot.quotes : null;
}

/** Marca `stale` cuando la captura más reciente supera la antigüedad máxima. */
function markRatesByAge(quotes: HubRateQuote[], nowMs: number, maxAgeMs: number): HubRateQuote[] {
  const newest = quotes.reduce((latest, quote) => {
    const parsed = Date.parse(quote.capturedAt);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
  const tooOld = newest <= 0 || nowMs - newest > maxAgeMs;
  if (!tooOld) return quotes;
  return quotes.map(quote => (quote.stale ? quote : { ...quote, stale: true }));
}

/**
 * Proveedor de tasas del hub.
 *
 * - Con `cacheReader` (proceso principal): sirve la copia persistida siempre,
 *   sin red ni TTL por demanda. Solo si está vacía y hay credencial consulta su
 *   propio servidor local, con enfriamiento de 5 min tras un fallo.
 * - Sin `cacheReader` (superficie autónoma): comportamiento anterior — consulta
 *   el servidor local como máximo una vez por TTL y comparte la consulta en
 *   vuelo; si falla con copia previa la devuelve con `stale: true`.
 * Nunca inventa tasas: sin copia y sin consulta posible, lanza.
 */
export function createHubRatesProvider(
  options: HubRatesProviderOptions = {}
): () => Promise<HubRateQuote[]> {
  const doFetch = options.fetchImpl
    ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const clock = options.now ?? (() => Date.now());
  const ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs as number) > 0
    ? (options.ttlMs as number)
    : HUB_RATES_TTL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
    ? (options.timeoutMs as number)
    : DEFAULT_TIMEOUT_MS;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && (options.maxAgeMs as number) > 0
    ? (options.maxAgeMs as number)
    : RATE_SNAPSHOT_MAX_AGE_MS;
  const cacheReader = typeof options.cacheReader === "function" ? options.cacheReader : null;
  // Una base explícita respeta la ruta; las pistas del runtime dan solo origen.
  let url: string | null = options.localBaseUrl ? localExchangeRatesUrl(options.localBaseUrl) : null;

  let cached: { at: number; rates: HubRateQuote[] } | null = null;
  let pending: Promise<HubRateQuote[]> | null = null;
  let lastFailureAt: number | null = null;

  function tokenText(): string {
    if (typeof options.tokenProvider !== "function") return "";
    try {
      return String(options.tokenProvider() ?? "").trim();
    } catch {
      return "";
    }
  }

  /** URL efectiva: explícita → VITE_DESKTOP_SERVER_URL → ventana → runtime → PORT/10000. */
  async function resolveUrl(): Promise<string> {
    if (url) return url;
    const base = resolveLocalServerBaseUrl({
      envUrl: options.envUrl ?? viteDesktopServerUrl(),
      windowOrigin: windowOriginHint(),
      runtimePort: await runtimeDesktopPort(options.desktopStatus)
    });
    if (base) {
      url = `${base}/api/exchange-rates`;
      return url;
    }
    // Último recurso sin memorizar: si el hub arranca luego, se redescubre.
    return localExchangeRatesUrl();
  }

  async function request(): Promise<HubRateQuote[]> {
    const endpoint = await resolveUrl();
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        ...(signal ? { signal } : {})
      });
    } catch {
      throw new Error("No se pudo consultar la tasa en el servidor local del hub; revisa que esté en ejecución.");
    }
    if (!response.ok) {
      throw new Error(
        response.status === 429
          ? "El servidor local está limitando las consultas de tasa; se reintentará más tarde."
          : "El servidor local no pudo entregar la tasa de cambio en este momento."
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const rates = normalizeLocalRatesPayload(body, clock());
    if (!rates.length) {
      throw new Error("El servidor local respondió sin cotizaciones válidas; se conserva la última tasa conocida.");
    }
    return rates;
  }

  async function readInjectedCache(): Promise<HubRateQuote[] | null> {
    if (!cacheReader) return null;
    try {
      return quotesFromCache(await Promise.resolve(cacheReader()));
    } catch {
      return null;
    }
  }

  return async () => {
    const current = clock();
    const injected = await readInjectedCache();
    // La copia del hub manda: ni TTL por demanda ni red en el camino normal.
    if (injected) return markRatesByAge(injected, current, maxAgeMs);

    if (cached && current - cached.at >= 0 && current - cached.at < ttlMs) return cached.rates;

    if (cacheReader) {
      // Sin copia todavía: solo una credencial configurada permite consultar y
      // nunca más de una vez cada 5 minutos tras un fallo.
      if (!tokenText()) {
        throw new Error("El hub LAN todavía no tiene una tasa válida; se conserva la última tasa conocida.");
      }
      if (lastFailureAt !== null && current - lastFailureAt < HUB_RATES_FAILURE_COOLDOWN_MS) {
        throw new Error("El hub LAN está reintentando obtener la tasa; se conserva la última tasa conocida.");
      }
    }

    if (!pending) {
      pending = request()
        .then(rates => {
          cached = { at: clock(), rates };
          lastFailureAt = null;
          return rates;
        })
        .catch(error => {
          lastFailureAt = clock();
          throw error;
        })
        .finally(() => { pending = null; });
    }
    try {
      return await pending;
    } catch (error) {
      // La última tasa válida sigue disponible para vender aunque el hub calle.
      if (cached) return markRatesByAge(cached.rates.map(rate => ({ ...rate, stale: true })), current, maxAgeMs);
      throw error instanceof Error
        ? error
        : new Error("No se pudo consultar la tasa local del hub LAN.");
    }
  };
}
