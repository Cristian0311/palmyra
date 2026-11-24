/**
 * Distribución de la tasa de elTOQUE a través del hub LAN.
 *
 * El hub consulta elTOQUE y publica las cotizaciones firmadas en
 * `GET /lan/v1/rates`. Aquí el cliente las pide con la sesión de emparejamiento
 * (misma firma HMAC que el resto del protocolo), valida la forma del cable y
 * resuelve el respaldo local cuando el hub no responde. El token de elTOQUE
 * nunca llega a este lado: solo viajan las tasas ya capturadas.
 */
import {
  canonicalizeRates,
  canonicalRateCode,
  EXCHANGE_RATE_CACHE_KEY,
  isElToquePayload,
  parseExchangeRates,
  type ExchangePayload
} from "../lib/exchangeRates";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { createHubClient, type HubClientOptions } from "./lanHub/client";
import { HUB_ROUTES, LAN_HUB_ENABLED, type HubRateQuote, type HubRatesResponse } from "./lanHub/protocol";
import { createHubRatesProvider, hubQuotesToPayload, localExchangeRatesUrl, normalizeLocalRatesPayload, windowOriginHint } from "./lanHub/rates";
import { RATE_MAX_MS } from "./lanHub/rateScheduler";
import { getHubSession, type HubSession } from "./lanHub/session";
import { recordRequest } from "./requestBudget";

export { hubQuotesToPayload };

/** El hub está en la misma red: 4 s bastan antes de caer al respaldo. */
export const HUB_RATES_TIMEOUT_MS = 4_000;
/** Una consulta de nube deja de considerarse fresca a los 30 minutos. */
export const RATE_SOURCE_FRESH_MS = 30 * 60 * 1000;
/**
 * Ventana de la copia verificada de Supabase: se consultan las últimas horas
 * del cron y se fusionan los grupos por código. Los códigos estables (p. ej.
 * BNB) solo se graban cuando se mueven o en su muestra horaria, así que un
 * código puede traer su última observación con horas de antigüedad; el
 * conjunto completo solo se acepta si su captura más reciente cumple
 * `RATE_SOURCE_FRESH_MS`. Un código ausente toda la ventana está inactivo.
 */
const VERIFIED_RATE_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * Una copia repartida por el hub se considera vigente hasta 60 minutos: su
 * cadencia es de 45 min (± jitter) y así la pantalla no parpadea entre ciclos.
 */
export const RATE_HUB_FRESH_MS = RATE_MAX_MS;
const RATE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{1,19}$/;
const MAX_LOCAL_PORT = 65535;

/**
 * `navigator.onLine === false` es la señal temprana de que no hay Internet:
 * evita consultas que no pueden responder y permite mostrar el aviso offline
 * al instante. Sin navegador (pruebas/SSR) se asume red disponible; un falso
 * positivo (Wi-Fi sin salida) se resuelve con los tiempos de espera normales.
 */
export function isDeviceOffline(): boolean {
  try {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  } catch {
    return false;
  }
}

/**
 * Avisos de pantalla cuando la consulta automática falla. Copy neutral: nunca
 * menciona hub, LAN, IP ni «servidor local». Siempre accionable: qué se muestra
 * ahora, cómo reintentar y dónde ajustar las tasas a mano.
 */
export const RATE_REFRESH_FALLBACK_NOTICE =
  "No se pudo actualizar la tasa automática. Se muestra la última tasa conocida; pulsa Reintentar o ajústala manualmente en Configuración → Monedas y tasas.";
export const RATE_UNAVAILABLE_NOTICE =
  "No se pudo obtener la tasa de cambio automática. Pulsa Reintentar para volver a consultar elTOQUE o guarda tus tasas a mano en Configuración → Monedas y tasas.";
/** Aviso de pantalla cuando el dispositivo está sin Internet. */
export const RATE_OFFLINE_NOTICE =
  "Sin conexión a Internet. Se muestra la última tasa conocida; se consultará elTOQUE automáticamente al reconectar.";

export interface HubRatesOptions {
  /** `fetch` inyectable para pruebas del hub. */
  fetchImpl?: typeof fetch;
  /** Reloj inyectable para firmar y fechar. */
  now?: () => number;
  /** Milisegundos; 4 s por defecto. */
  timeoutMs?: number;
  /** Sesión inyectable en pruebas; por defecto se lee la del equipo. */
  session?: HubSession | null;
  /**
   * Fuerza el camino del hub (solo pruebas/pruebas del módulo retenido). Por
   * defecto manda `LAN_HUB_ENABLED`, que está en `false`: sin hub en producto.
   */
  hubEnabled?: boolean;
  /**
   * Copia verificada de la nube (historial que publica el cron de elTOQUE en
   * Supabase) inyectable en pruebas. Es la vía CORS-abierta que usan escritorio
   * y APK; por defecto se lee de Supabase y se descarta si está vencida.
   */
  verifiedQuotes?: () => Promise<HubRateQuote[]>;
}

/**
 * Hub apagado por defecto (`LAN_HUB_ENABLED = false`). Cuando está apagado,
 * `fetchHubRates` devuelve `null` y la resolución cae siempre a
 * `/api/exchange-rates`.
 */
export function isLanHubRatesEnabled(options: { hubEnabled?: boolean } = {}): boolean {
  return typeof options.hubEnabled === "boolean" ? options.hubEnabled : LAN_HUB_ENABLED;
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
 * Consulta `GET /lan/v1/rates` con la sesión del equipo. Devuelve `null` sin
 * tocar la red cuando el hub está apagado (`LAN_HUB_ENABLED = false`). Lanza un
 * error en español —sin el token y sin nombres de red— si no hay sesión, el hub
 * no responde o responde mal.
 */
export async function fetchHubRates(options: HubRatesOptions = {}): Promise<HubRateQuote[] | null> {
  if (!isLanHubRatesEnabled(options)) return null;
  const session = hasOwnSession(options) ? (options.session ?? null) : await getHubSession();
  if (!session) {
    throw new Error("No hay una fuente de tasas emparejada; se usará la tasa guardada.");
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
    throw new Error(`La fuente de tasas ${sessionLabel(session)} respondió sin cotizaciones válidas; se usará la tasa guardada.`);
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
  // Hub apagado: la superficie siempre es autónoma y usa su propia ruta.
  if (!isLanHubRatesEnabled(options)) return true;
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
      // El error crudo nunca se reenvía; antes de la primera consulta no se
      // anuncia un fallo que aún no ocurrió.
      detail: result ? RATE_UNAVAILABLE_NOTICE : "Aún no hay una consulta en esta sesión; se muestra la última tasa guardada en este dispositivo.",
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
    detail: "Consulta automática a elTOQUE.",
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
 * Última tasa ya guardada por la pantalla (`localStorage`). Es el respaldo
 * final cuando la consulta automática falla: así nunca se sustituye una tasa
 * usable por una pantalla vacía. Devuelve cotizaciones marcadas `stale`; sin
 * almacenamiento o sin datos válidos devuelve `[]` y nunca lanza.
 */
export function readStoredRateQuotes(nowMs = Date.now()): HubRateQuote[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const stored: unknown = JSON.parse(localStorage.getItem(EXCHANGE_RATE_CACHE_KEY) || "null");
    if (!isElToquePayload(stored)) return [];
    const captured = Date.parse(stored.capturedAt);
    const capturedAt = new Date(Number.isFinite(captured) ? captured : nowMs).toISOString();
    return canonicalizeRates(parseExchangeRates(stored.data)).flatMap(rate => {
      const value = rate.value ?? rate.buy ?? rate.sell;
      if (value === undefined || !Number.isFinite(value) || value <= 0) return [];
      return [{ code: rate.code, rate: value, capturedAt, source: stored.source, stale: true }];
    });
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Respaldo de nube: la fuente de producción                           */
/* ------------------------------------------------------------------ */

/**
 * Endpoint de tasas de la nube de producción. La credencial de elTOQUE vive
 * solo en ese servidor; las instalaciones autónomas (Windows, APK) lo consultan
 * como respaldo cuando su servidor local no puede responder. Nunca se
 * construye una URL de elTOQUE: el renderer solo habla con la nube de PALMYRA.
 */
export const DEFAULT_CLOUD_RATES_URL = "https://palmyracrm.onrender.com/api/exchange-rates";

export function cloudExchangeRatesUrl(): string {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
    const raw = env?.VITE_APP_ORIGIN;
    const origin = typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/+$/, "") : "https://palmyracrm.onrender.com";
    return `${origin}/api/exchange-rates`;
  } catch {
    return DEFAULT_CLOUD_RATES_URL;
  }
}

/** true cuando esta superficie ya ES la nube: su propia ruta acaba de fallar. */
function isCloudSurface(): boolean {
  try {
    const win = windowOriginHint();
    if (!win) return false;
    return new URL(cloudExchangeRatesUrl()).origin === win;
  } catch {
    return false;
  }
}

/**
 * El cron solo escribe los códigos cuyo valor cambió en cada corrida (más una
 * muestra horaria del resto), así que cada punto del historial de Supabase es
 * PARCIAL. Esta función fusiona los puntos (del más antiguo al más nuevo)
 * tomando por código el valor más reciente y su captura: devuelve el set
 * completo de monedas activas en lugar del subconjunto del último punto.
 * También canonicaliza los códigos compactados por el cron (`ECU`→`EUR`,
 * `USDTTRC20`→`USDT_TRC20`) para que coincidan con el payload vivo de elTOQUE.
 */
export function mergeVerifiedHistoryRows(rows: unknown[]): HubRateQuote[] {
  const byCode = new Map<string, HubRateQuote>();
  for (const raw of rows) {
    const row = raw as { captured_at?: unknown; rates?: unknown } | null;
    const captured = typeof row?.captured_at === "string" ? Date.parse(row.captured_at) : Number.NaN;
    if (!Number.isFinite(captured) || !row?.rates) continue;
    const quotes = canonicalizeRates(parseExchangeRates(row.rates)).flatMap(rate => {
      const value = rate.value ?? rate.buy ?? rate.sell;
      if (value === undefined || !Number.isFinite(value) || value <= 0) return [];
      return [{ code: rate.code, rate: value, capturedAt: new Date(captured).toISOString(), source: "elTOQUE API", stale: false }];
    });
    for (const quote of quotes) byCode.set(quote.code, quote);
  }
  return [...byCode.values()];
}

/**
 * Copia verificada que publica el cron de elTOQUE en Supabase (cada ~10 min).
 * Es la vía principal del respaldo de nube para escritorio y APK: Supabase
 * responde con `Access-Control-Allow-Origin: *` desde cualquier origen,
 * mientras que la ruta de Render no publica CORS y un `fetch` desde
 * `http://127.0.0.1:<puerto>` (escritorio) o `http://localhost` (APK) queda
 * bloqueado por el navegador aunque haya Internet. La credencial de elTOQUE
 * sigue viviendo solo en el servidor: aquí solo llegan tasas ya capturadas.
 * Devuelve `[]` sin lanzar si falta el cliente, la red o la copia.
 */
async function fetchVerifiedSupabaseQuotes(): Promise<HubRateQuote[]> {
  try {
    // Carga perezosa: en Node/pruebas este módulo no está disponible y la vía
    // se ignora para caer a la consulta directa (o al respaldo guardado).
    const { getSupabase } = await import("../lib/supabase");
    const client = getSupabase();
    if (!client) return [];
    const startedAt = Date.now();
    // 40 grupos cubren la ventana de 6 h con la cadencia real del cron.
    // `p_since` nulo: la ventana la aplica el servidor (now() - 6 h). Así la
    // consulta no depende del reloj del equipo, que puede estar desajustado.
    const { data, error } = await client.rpc("get_verified_exchange_rate_history", {
      p_since: null,
      p_limit: 40
    });
    if (error || !Array.isArray(data) || !data.length) {
      recordRequest("rates/cloud", { ms: Date.now() - startedAt, ok: false });
      return [];
    }
    // La función devuelve los puntos ordenados del más antiguo al más nuevo.
    const quotes = mergeVerifiedHistoryRows(data);
    recordRequest("rates/cloud", { ms: Date.now() - startedAt, ok: quotes.length > 0 });
    return quotes;
  } catch {
    return [];
  }
}

/**
 * Copia verificada fresca: la captura más reciente del conjunto debe tener
 * ≤ 30 min (la misma frescura que la nube directa), mientras cada código puede
 * conservar su última observación hasta el final de la ventana consultada.
 * Devuelve `[]` solo cuando el dispositivo está sin Internet, no hay copia,
 * está claramente vencida (más de 6 h por el reloj del equipo) o el proveedor
 * inyectado falla. Las cotizaciones presentes pero no frescas se devuelven
 * marcadas `stale` para que el llamador decida: la nube directa primero y la
 * copia vencida como último recurso antes de fallar. Un reloj de equipo
 * atrasado hace que la copia parezca «del futuro»: se acepta igual, porque el
 * RPC ya devuelve los grupos más nuevos del servidor.
 */
async function readVerifiedRateQuotes(options: HubRatesOptions): Promise<HubRateQuote[]> {
  if (isDeviceOffline()) return [];
  const provider = options.verifiedQuotes ?? fetchVerifiedSupabaseQuotes;
  try {
    const quotes = await provider();
    if (!Array.isArray(quotes) || !quotes.length) return [];
    const nowMs = (options.now ?? (() => Date.now()))();
    const capturedTimes = quotes
      .map(quote => Date.parse(quote && quote.capturedAt ? quote.capturedAt : ""))
      .filter(Number.isFinite);
    const newest = capturedTimes.reduce((latest, t) => Math.max(latest, t), 0);
    if (newest <= 0 || (newest < nowMs && nowMs - newest > VERIFIED_RATE_WINDOW_MS)) return [];
    return quotes
      .filter(quote => {
        const captured = Date.parse(quote && quote.capturedAt ? quote.capturedAt : "");
        return Number.isFinite(captured) && nowMs - captured <= VERIFIED_RATE_WINDOW_MS;
      })
      .map(quote => {
        const captured = Date.parse(quote && quote.capturedAt ? quote.capturedAt : "");
        return nowMs - captured > RATE_SOURCE_FRESH_MS ? { ...quote, stale: true } : quote;
      });
  } catch {
    return [];
  }
}

/**
 * Respaldo de nube: primero la copia verificada de Supabase (CORS abierto,
 * funciona en escritorio y APK). Si está fresca se usa sin tocar Render; si
 * falta o está vencida se hace una sola consulta directa a la nube de
 * producción (que sí tiene la credencial de elTOQUE) y, solo si esa consulta
 * falla o no trae cotizaciones, se conserva la copia verificada vencida como
 * último recurso en lugar de fallar: con Internet el dueño siempre ve tasas.
 * El tiempo de espera de la consulta directa es generoso porque una instancia
 * gratuita de Render puede tardar decenas de segundos en despertar; sin
 * reintento para no duplicar esa espera. Lanza con un mensaje neutro (sin
 * credenciales ni nombres de red) solo cuando no hay respuesta válida de
 * ninguna fuente.
 */
export const CLOUD_RATES_TIMEOUT_MS = 30_000;

export async function fetchCloudRateQuotes(options: HubRatesOptions = {}): Promise<HubRateQuote[]> {
  if (isCloudSurface()) return [];
  const verified = await readVerifiedRateQuotes(options);
  if (verified.some(quote => !quote.stale)) return verified;
  const doFetch = options.fetchImpl
    ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const clock = options.now ?? (() => Date.now());
  const endpoint = cloudExchangeRatesUrl();
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(CLOUD_RATES_TIMEOUT_MS)
    : undefined;
  const startedAt = Date.now();
  try {
    const response = await doFetch(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      recordRequest("rates/cloud", { ms: Date.now() - startedAt, ok: false });
      if (verified.length) return verified;
      throw new Error(
        response.status === 429
          ? "Se alcanzó el límite de consultas de tasa; se reintentará más tarde."
          : "La consulta de tasa no está disponible en este momento; se conserva la última tasa conocida."
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const rates = normalizeLocalRatesPayload(body, clock());
    recordRequest("rates/cloud", { ms: Date.now() - startedAt, ok: rates.length > 0 });
    if (!rates.length) {
      if (verified.length) return verified;
      throw new Error("La consulta de tasa respondió sin cotizaciones válidas; se conserva la última tasa conocida.");
    }
    return rates;
  } catch {
    // Fallo de red o CORS en la consulta directa: la copia verificada vencida
    // (si existe) evita la pantalla vacía; sin ella se conserva el aviso claro.
    if (verified.length) {
      recordRequest("rates/cloud", { ms: Date.now() - startedAt, ok: true });
      return verified;
    }
    recordRequest("rates/cloud", { ms: Date.now() - startedAt, ok: false });
    throw new Error("No se pudo consultar la tasa automática en la nube; se conserva la última tasa conocida.");
  }
}

/* ------------------------------------------------------------------ */
/* Diagnóstico accionable del fallo                                    */
/* ------------------------------------------------------------------ */

/** La sonda extra no debe esperar más que la consulta principal (4 s). */
const LOCAL_RATE_PROBE_TIMEOUT_MS = 4_000;

/**
 * Limpia el motivo que publica la ruta de tasas para mostrarlo en pantalla:
 * sin HTML, sin credenciales y sin nombres de red («servidor local», «LAN»,
 * «hub» se sustituyen). Corto, para que el aviso siga siendo una sola línea.
 */
function sanitizeRateFailureDetail(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(servidor\s+local|lan\b|hub\b)/gi, "la fuente")
    .trim();
  if (!text) return "";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * Cuando la consulta automática falla, un único intento adicional para leer el
 * motivo real que publica la ruta de tasas (credencial ausente o rechazada,
 * límite temporal, fuente caída). Nunca inventa cotizaciones ni muestra
 * credenciales; si la lectura falla devuelve `undefined` y la pantalla usa el
 * aviso genérico. Solo se usa tras un fallo, nunca en el camino feliz.
 */
export async function probeLocalRateFailure(options: HubRatesOptions = {}): Promise<string | undefined> {
  try {
    const doFetch = options.fetchImpl
      ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const endpoint = localExchangeRatesUrl(await resolvedLocalBaseUrl());
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(LOCAL_RATE_PROBE_TIMEOUT_MS)
      : undefined;
    const response = await doFetch(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      ...(signal ? { signal } : {})
    });
    const body: unknown = await response.json().catch(() => null);
    const detail = sanitizeRateFailureDetail(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).error
        : undefined
    );
    if (detail) return detail;
    if (!response.ok) {
      if (response.status === 429) return "La fuente limitó temporalmente las consultas de tasa; espera unos minutos y reintenta.";
      if (response.status >= 500) return "La fuente de tasas no está disponible en este momento.";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Servidor propio primero (con el hub apagado siempre es el único camino);
 * respaldo del hub retenido solo si se fuerza con `hubEnabled: true`. Nunca
 * lanza: si no hay tasas nuevas devuelve la última guardada y, solo si tampoco
 * existe, un aviso accionable con el motivo real del fallo y cómo reintentar.
 */
export async function resolveExchangeRates(
  options: HubRatesOptions & { fallback?: () => Promise<HubRateQuote[]> } = {}
): Promise<ResolvedExchangeRates> {
  const hubEnabled = isLanHubRatesEnabled(options);
  let session: HubSession | null = null;
  if (hubEnabled) {
    try {
      session = hasOwnSession(options) ? (options.session ?? null) : await getHubSession();
    } catch {
      session = null;
    }
    try {
      const hubRates = await fetchHubRates({ ...options, session });
      if (hubRates && hubRates.length) {
        return { source: "hub", rates: hubRates, stale: hubRates.some(rate => rate.stale) };
      }
    } catch {
      // Hub caído o sin sesión: se sigue con el servidor propio.
    }
  }

  // Sin Internet y sin hub: nada que consultar en vivo. La última tasa
  // guardada se devuelve al instante con un aviso claro y la pantalla la
  // marca como «Sin conexión en vivo»; nunca se muestra la credencial del
  // servidor local como si fuera la causa. El camino inyectado (pruebas)
  // conserva su propio flujo.
  if (!options.fallback && isDeviceOffline()) {
    const stored = readStoredRateQuotes((options.now ?? (() => Date.now()))());
    if (stored.length) return { source: "fallback", rates: stored, stale: true };
    return { source: "fallback", rates: [], stale: true, error: RATE_OFFLINE_NOTICE };
  }

  const fallback = options.fallback ?? (() => defaultLocalFallback(options));
  let quotes: HubRateQuote[] | null = null;
  try {
    const rates = await fallback();
    quotes = Array.isArray(rates) && rates.length ? rates : null;
  } catch {
    // Sin respuesta del servidor propio: se intenta el respaldo de nube abajo.
  }

  // Sin cotizaciones por la ruta propia, una sola consulta de respaldo a la
  // nube de producción (que sí tiene la credencial de elTOQUE). Con un
  // `fallback` inyectado (pruebas/camino alternativo) no se toca la red.
  let cloudFailure: string | undefined;
  if (!quotes && !options.fallback) {
    try {
      const cloudRates = await fetchCloudRateQuotes(options);
      if (cloudRates.length) quotes = cloudRates;
    } catch (error) {
      cloudFailure = sanitizeRateFailureDetail(error instanceof Error ? error.message : error);
    }
  }

  // Sin cotizaciones nuevas, una única lectura del motivo real para un aviso
  // accionable. El fallo de la nube manda: si no hay Internet es la causa real,
  // mientras que una credencial ausente en el servidor local no es accionable
  // desde la app. Con un `fallback` inyectado no se duplica ninguna petición.
  let failureDetail: string | undefined;
  if (!quotes && !options.fallback) {
    const localDetail = await probeLocalRateFailure(options);
    failureDetail = cloudFailure || localDetail;
  }
  if (quotes) {
    return { source: "fallback", rates: quotes, stale: quotes.some(rate => rate.stale) };
  }

  // Sin consulta nueva: la última tasa guardada sigue siendo usable.
  const stored = readStoredRateQuotes((options.now ?? (() => Date.now()))());
  if (stored.length) {
    return { source: "fallback", rates: stored, stale: true };
  }
  return {
    source: "fallback",
    rates: [],
    stale: true,
    error: failureDetail
      ? `${failureDetail} Pulsa Reintentar o guarda tus tasas a mano en Configuración → Monedas y tasas.`
      : RATE_UNAVAILABLE_NOTICE
  };
}

/**
 * Atajo para la sincronización automática de tasas: payload del hub si está
 * habilitado y responde, `null` en cualquier otro caso (incluido el hub
 * apagado), sin lanzar, para que el llamador siga con `/api/exchange-rates`.
 */
export async function fetchHubAutoRatePayload(
  options: HubRatesOptions & { rates?: () => Promise<HubRateQuote[]>; clock?: () => number } = {}
): Promise<ExchangePayload | null> {
  if (!options.rates && !isLanHubRatesEnabled(options)) return null;
  try {
    const rates = options.rates ? await options.rates() : await fetchHubRates(options);
    if (!rates || !rates.length) return null;
    return hubQuotesToPayload(rates, (options.clock ?? options.now ?? (() => Date.now()))());
  } catch {
    return null;
  }
}
