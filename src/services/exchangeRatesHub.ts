/**
 * Distribución de la tasa de elTOQUE a través del hub LAN.
 *
 * El hub consulta elTOQUE y publica las cotizaciones firmadas en
 * `GET /lan/v1/rates`. Aquí el cliente las pide con la sesión de emparejamiento
 * (misma firma HMAC que el resto del protocolo), valida la forma del cable y
 * resuelve el respaldo local cuando el hub no responde. El token de elTOQUE
 * nunca llega a este lado: solo viajan las tasas ya capturadas.
 */
import { canonicalRateCode, type ExchangePayload } from "../lib/exchangeRates";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { createHubClient, type HubClientOptions } from "./lanHub/client";
import { HUB_ROUTES, type HubRateQuote, type HubRatesResponse } from "./lanHub/protocol";
import { createHubRatesProvider, hubQuotesToPayload } from "./lanHub/rates";
import { RATE_MAX_MS } from "./lanHub/rateScheduler";
import { getHubSession, type HubSession } from "./lanHub/session";
import { recordRequest } from "./requestBudget";

export { hubQuotesToPayload };

/** El hub está en la misma red: 4 s bastan antes de caer al respaldo. */
export const HUB_RATES_TIMEOUT_MS = 4_000;
/** Una consulta de nube deja de considerarse fresca a los 30 minutos. */
export const RATE_SOURCE_FRESH_MS = 30 * 60 * 1000;
/**
 * Una copia repartida por el hub se considera vigente hasta 60 minutos: su
 * cadencia es de 45 min (± jitter) y así la pantalla no parpadea entre ciclos.
 */
export const RATE_HUB_FRESH_MS = RATE_MAX_MS;
const RATE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{1,19}$/;
const MAX_LOCAL_PORT = 65535;

export interface HubRatesOptions {
  /** `fetch` inyectable para pruebas del hub. */
  fetchImpl?: typeof fetch;
  /** Reloj inyectable para firmar y fechar. */
  now?: () => number;
  /** Milisegundos; 4 s por defecto. */
  timeoutMs?: number;
  /** Sesión inyectable en pruebas; por defecto se lee la del equipo. */
  session?: HubSession | null;
}

export interface ResolvedExchangeRates {
  source: "hub" | "fallback";
  rates: HubRateQuote[];
  /** true cuando las cotizaciones no son una consulta en vivo. */
  stale: boolean;
  error?: string;
}

function hasOwnSession(options: HubRatesOptions): boolean {
  return options.session !== undefined;
}

function sessionLabel(session: HubSession): string {
  // Solo la dirección; el token jamás se incluye en mensajes.
  return session.baseUrl.replace(/\/+$/, "");
}

/**
 * Valida y normaliza la lista que llega del hub: códigos canónicos (ECU → EUR),
 * tasas positivas y `capturedAt` interpretable. Una cotización repetida se
 * queda con la más fresca y en vivo.
 */
export function normalizeHubQuotes(payload: unknown): HubRateQuote[] {
  const list = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { rates?: unknown }).rates
    : undefined;
  if (!Array.isArray(list)) return [];
  const quotes = new Map<string, HubRateQuote>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const code = canonicalRateCode(String(row.code ?? ""));
    if (!RATE_CODE_PATTERN.test(code)) continue;
    const rate = Number(row.rate);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const captured = typeof row.capturedAt === "string" ? Date.parse(row.capturedAt) : Number.NaN;
    if (!Number.isFinite(captured)) continue;
    const quote: HubRateQuote = {
      code,
      rate,
      capturedAt: new Date(captured).toISOString(),
      source: typeof row.source === "string" && row.source.trim() ? row.source.trim() : "hub",
      stale: row.stale === true
    };
    const previous = quotes.get(code);
    const fresher = !previous
      || (previous.stale && !quote.stale)
      || (previous.stale === quote.stale && Date.parse(quote.capturedAt) >= Date.parse(previous.capturedAt));
    if (fresher) quotes.set(code, quote);
  }
  return [...quotes.values()];
}

/**
 * Consulta `GET /lan/v1/rates` con la sesión del equipo. Lanza un error en
 * español —sin el token— si no hay sesión, el hub no responde o responde mal.
 */
export async function fetchHubRates(options: HubRatesOptions = {}): Promise<HubRateQuote[]> {
  const session = hasOwnSession(options) ? (options.session ?? null) : await getHubSession();
  if (!session) {
    throw new Error("Este equipo no tiene sesión con el hub LAN; se usará la tasa local.");
  }
  const clientOptions: HubClientOptions = {
    baseUrl: session.baseUrl,
    deviceId: session.deviceId,
    token: session.token,
    fetchImpl: options.fetchImpl,
    now: options.now,
    timeoutMs: Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? (options.timeoutMs as number)
      : HUB_RATES_TIMEOUT_MS
  };
  const client = createHubClient(clientOptions);
  const startedAt = Date.now();
  let payload: HubRatesResponse;
  try {
    payload = await client.request<HubRatesResponse>("GET", HUB_ROUTES.rates);
  } catch (error) {
    recordRequest("rates/client", { ms: Date.now() - startedAt, ok: false });
    throw error;
  }
  const rates = normalizeHubQuotes(payload);
  recordRequest("rates/client", { ms: Date.now() - startedAt, ok: rates.length > 0 });
  if (!rates.length) {
    throw new Error(`El hub LAN (${sessionLabel(session)}) respondió sin cotizaciones válidas; se usará la tasa local.`);
  }
  return rates;
}

/**
 * Decide si el renderer puede pedir `/api/exchange-rates` a su propio servidor.
 *
 * Un equipo con sesión de hub es un cliente: su única fuente es el hub y nunca
 * consulta elTOQUE por su cuenta. Sin sesión la superficie es autónoma
 * (web/PWA/APK o escritorio sin hub) y usa la ruta del servidor, que resuelve
 * elTOQUE del lado servidor. El renderer jamás consulta la fuente externa.
 */
export function canUseOwnServerRateRoute(context: { hasHubSession: boolean }): boolean {
  return context.hasHubSession !== true;
}

/** Contexto real del equipo; sin almacenamiento de sesión se asume autónomo. */
export async function readOwnServerRateRouteAllowed(options: HubRatesOptions = {}): Promise<boolean> {
  try {
    const session = hasOwnSession(options) ? (options.session ?? null) : await getHubSession();
    return canUseOwnServerRateRoute({ hasHubSession: session !== null });
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Servidor local: puerto resuelto en tiempo de ejecución              */
/* ------------------------------------------------------------------ */

/** Pistas que el runtime conoce sobre el servidor local de este equipo. */
export interface LocalServerHint {
  /** Puerto publicado por el estado del runtime de escritorio. */
  port?: number | null;
  /** Origen desde el que se sirve la ventana (p. ej. `http://127.0.0.1:10000`). */
  origin?: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function validLocalPort(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_LOCAL_PORT ? parsed : null;
}

/** Solo se acepta un origen absoluto http(s); el resto se descarta. */
function loopbackOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Raíz del servidor local sin asumir 10000.
 *
 * El origen de la ventana manda porque es justo el servidor que sirve
 * `/api/exchange-rates` (en Electron, `http://127.0.0.1:<puerto real>`). Si la
 * ventana no se sirve desde el propio equipo se usa el puerto que publica el
 * runtime de escritorio; sin ninguna pista se devuelve `undefined` y el
 * proveedor conserva su último recurso (env `PORT` o 10000).
 */
export function resolveLocalHubBaseUrl(hint: LocalServerHint = {}): string | undefined {
  const origin = loopbackOrigin(hint.origin);
  if (origin) return origin;
  const port = validLocalPort(hint.port);
  return port ? `http://127.0.0.1:${port}` : undefined;
}

let localBaseUrlPromise: Promise<string | undefined> | null = null;

/** Lee las pistas reales del runtime (ventana y estado del hub de escritorio). */
async function readRuntimeLocalBaseUrl(): Promise<string | undefined> {
  const origin = typeof window !== "undefined" && window.location ? window.location.origin : null;
  let port: number | null = null;
  if (isDesktopRuntime()) {
    try {
      const { getHubStatus } = await import("./lanHub/hostRuntime");
      const status = await getHubStatus();
      port = status && typeof status.port === "number" ? status.port : null;
    } catch {
      port = null;
    }
  }
  return resolveLocalHubBaseUrl({ origin, port });
}

function resolvedLocalBaseUrl(): Promise<string | undefined> {
  if (!localBaseUrlPromise) {
    localBaseUrlPromise = readRuntimeLocalBaseUrl().catch(() => undefined);
  }
  return localBaseUrlPromise;
}

/* ------------------------------------------------------------------ */
/* Origen real de las tasas mostradas en la pantalla                   */
/* ------------------------------------------------------------------ */

export type ExchangeRateSourceKind = "hub" | "cloud" | "cached";

export interface ExchangeRateSourceView {
  kind: ExchangeRateSourceKind;
  label: string;
  detail: string;
  stale: boolean;
  /** ISO-8601 de la captura más reciente usada; null sin cotizaciones. */
  capturedAt: string | null;
  /** Antigüedad de esa captura en ms; null sin cotizaciones. */
  ageMs: number | null;
}

/**
 * Antigüedad legible en español para la pantalla: «hace menos de 1 min»,
 * «hace 12 min», «hace 3 h», «hace 2 días». Sin fecha devuelve «sin fecha».
 */
export function formatRateAge(ageMs: number | null | undefined): string {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) return "sin fecha";
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return "hace menos de 1 min";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} días`;
}

/**
 * Fuente real de una resolución, lista para la pantalla: hub LAN, servidor
 * local o la última tasa guardada. Marca `stale` cuando no hay cotizaciones,
 * cuando la fuente lo advierte o cuando la captura supera la frescura de su
 * origen (60 min para el hub con su cadencia de 45; 30 min para la nube).
 * Nunca lanza.
 */
export function describeExchangeRateSource(
  result: ResolvedExchangeRates | null | undefined,
  nowMs = Date.now()
): ExchangeRateSourceView {
  const rates = result && Array.isArray(result.rates) ? result.rates : [];
  const newest = rates.reduce((latest, quote) => {
    const parsed = Date.parse(quote && quote.capturedAt ? quote.capturedAt : "");
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
  const capturedAt = newest > 0 ? new Date(newest).toISOString() : null;
  const ageMs = newest > 0 ? Math.max(0, nowMs - newest) : null;
  const freshFor = result && result.source === "hub" ? RATE_HUB_FRESH_MS : RATE_SOURCE_FRESH_MS;
  const tooOld = newest <= 0 || nowMs - newest > freshFor;
  const stale = !rates.length || Boolean(result && result.stale) || tooOld;
  const ageLabel = formatRateAge(ageMs);

  if (!rates.length) {
    return {
      kind: "cached",
      label: "Última tasa guardada",
      detail: (result && result.error) || "No hubo una consulta nueva; se muestra la última tasa guardada en este dispositivo.",
      stale: true,
      capturedAt,
      ageMs
    };
  }
  if (result && result.source === "hub") {
    return {
      kind: "hub",
      label: "Hub LAN",
      detail: stale
        ? `El hub de la red local entregó su última tasa válida (${ageLabel}); no es una consulta en vivo.`
        : "Tasa repartida por el hub de la red local.",
      stale,
      capturedAt,
      ageMs
    };
  }
  if (stale) {
    return {
      kind: "cached",
      label: "Última tasa guardada",
      detail: `La consulta no es en vivo; se conserva la última tasa válida conocida (${ageLabel}).`,
      stale: true,
      capturedAt,
      ageMs
    };
  }
  return {
    kind: "cloud",
    label: "elTOQUE · nube",
    detail: "Consulta directa al servidor de tasas.",
    stale: false,
    capturedAt,
    ageMs
  };
}

/* ------------------------------------------------------------------ */
/* Respaldo local                                                      */
/* ------------------------------------------------------------------ */

/**
 * Respaldo por defecto: la ruta local que ya usa el POS. Se crea un proveedor
 * por raíz resuelta para que la caché de 30 minutos y la última tasa válida
 * sobrevivan entre consultas aunque el hub siga caído.
 */
const localProviders = new Map<string, () => Promise<HubRateQuote[]>>();
function defaultLocalFallback(options: HubRatesOptions): Promise<HubRateQuote[]> {
  return resolvedLocalBaseUrl().then(baseUrl => {
    const key = baseUrl || "default";
    let provider = localProviders.get(key);
    if (!provider) {
      provider = createHubRatesProvider({
        fetchImpl: options.fetchImpl,
        now: options.now,
        ...(baseUrl ? { localBaseUrl: baseUrl } : {})
      });
      localProviders.set(key, provider);
    }
    return provider();
  });
}

/**
 * Hub primero; respaldo después. Nunca lanza.
 *
 * Un equipo con sesión de hub es un cliente: si el hub no responde se conserva
 * la última tasa válida (lista vacía + `stale`) y NO se consulta elTOQUE desde
 * este equipo. Sin sesión, la superficie es autónoma y puede usar la ruta de su
 * propio servidor. Un respaldo inyectado por el llamador siempre se respeta.
 */
export async function resolveExchangeRates(
  options: HubRatesOptions & { fallback?: () => Promise<HubRateQuote[]> } = {}
): Promise<ResolvedExchangeRates> {
  let session: HubSession | null = null;
  try {
    session = hasOwnSession(options) ? (options.session ?? null) : await getHubSession();
  } catch {
    session = null;
  }

  try {
    const rates = await fetchHubRates({ ...options, session });
    return { source: "hub", rates, stale: rates.some(rate => rate.stale) };
  } catch {
    if (!options.fallback && session) {
      return {
        source: "fallback",
        rates: [],
        stale: true,
        error: "Sin conexión con el hub LAN; se conserva la última tasa válida y no se consulta elTOQUE desde este equipo."
      };
    }
    const fallback = options.fallback ?? (() => defaultLocalFallback(options));
    try {
      const rates = await fallback();
      const quotes = Array.isArray(rates) ? rates : [];
      return {
        source: "fallback",
        rates: quotes,
        stale: !quotes.length || quotes.some(rate => rate.stale)
      };
    } catch (fallbackError) {
      return {
        source: "fallback",
        rates: [],
        stale: true,
        error: fallbackError instanceof Error ? fallbackError.message : "No se pudo obtener la tasa de cambio."
      };
    }
  }
}

/**
 * Atajo para la sincronización automática de tasas: hub si hay sesión, `null`
 * si no la hay o si el hub falla (sin lanzar, para no interrumpir el respaldo).
 */
export async function fetchHubAutoRatePayload(
  options: HubRatesOptions & { rates?: () => Promise<HubRateQuote[]>; clock?: () => number } = {}
): Promise<ExchangePayload | null> {
  try {
    const rates = options.rates ? await options.rates() : await fetchHubRates(options);
    return hubQuotesToPayload(rates, (options.clock ?? options.now ?? (() => Date.now()))());
  } catch {
    return null;
  }
}
