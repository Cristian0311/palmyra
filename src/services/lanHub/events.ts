/**
 * Canal de eventos (SSE) del hub LAN.
 *
 * `openHubEvents` abre `GET /lan/v1/events` en streaming y entrega cada página
 * de cambios ya validada. La conexión se firma con HMAC-SHA256 usando WebCrypto
 * (la misma cadena canónica que `auth.ts`/`client.ts`), de modo que funciona
 * igual en el renderer de Electron y en Node.
 *
 * Detalle del protocolo: la petición SSE se firma sobre la ruta
 * `/lan/v1/changes`, no sobre `/lan/v1/events`. El hub no puede re-firmar (no
 * guarda el token, solo su hash) y valida esa firma UNA sola vez al abrir el
 * canal; después cada sondeo del journal usa la fuente local del servidor, sin
 * reutilizar el nonce. Por eso un stream sano permanece abierto y no se cierra
 * tras la primera página.
 *
 * Si el primer intento falla, `openHubEvents` rechaza y el bucle del cliente
 * cae a sondeo periódico. Una caída posterior a una conexión estable se
 * reintenta con backoff desde el último cursor conocido; un rechazo de
 * autenticación (401/403) no se reintenta.
 */
import { HUB_AUTH_HEADERS, canonicalPath } from "./shared";
import { HUB_ROUTES } from "./protocol";
import { getHubSession, type HubSession } from "./session";
import { HubSyncError, type HubChange } from "./syncClient";

/** Ruta del canal de eventos; `nodeServer` la sirve sin tocar `handler.ts`. */
export const HUB_EVENTS_ROUTE = "/lan/v1/events";

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** Un canal que vive al menos esto se considera sano y reinicia el backoff. */
const STABLE_STREAM_MS = 30_000;
/** Tablas internas del hub: viajan en el journal pero no se replican. */
const INTERNAL_TABLES = new Set<string>(["hub_devices", "hub_receipts"]);

export interface HubEventPage {
  changes: HubChange[];
  /** Último `seq` cubierto por el evento. */
  cursor: number;
  hasMore: boolean;
}

export interface OpenHubEventsInput {
  /** Desde qué `seq` (exclusivo) empezar; por defecto el cursor de la sesión. */
  since?: number;
  /** Se espera su promesa antes de avanzar el cursor del canal. */
  onChanges: (page: HubEventPage) => void | Promise<void>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Intentos iniciales antes de rendirse (el bucle cae a sondeo). */
  maxInitialAttempts?: number;
}

export type HubEventsErrorCode =
  | "no_session"
  | "unsupported"
  | "network"
  | "http"
  | "stream"
  | "invalid_clock";

export class HubEventsError extends Error {
  readonly code: HubEventsErrorCode;
  readonly status: number;

  constructor(code: HubEventsErrorCode, message: string, status = 0) {
    super(message);
    this.name = "HubEventsError";
    this.code = code;
    this.status = status;
  }
}

interface WebCryptoLike {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();
const encoder = new TextEncoder();

function webCrypto(): WebCryptoLike {
  const api = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!api || !api.subtle || typeof api.getRandomValues !== "function") {
    throw new HubEventsError(
      "unsupported",
      "Este equipo no puede firmar la conexión con el hub LAN (WebCrypto no disponible)."
    );
  }
  return api;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await webCrypto().subtle.digest("SHA-256", encoder.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  webCrypto().getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** La clave HMAC es el sha256 del token, igual que guarda el hub. */
function signingKeyFor(token: string): Promise<CryptoKey> {
  const cached = signingKeys.get(token);
  if (cached) return cached;
  const created = (async () => {
    const tokenHash = await sha256Hex(token);
    return webCrypto().subtle.importKey(
      "raw",
      encoder.encode(tokenHash),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  })();
  // Caché acotada: en la práctica solo hay un token vigente por equipo.
  if (signingKeys.size >= 4) signingKeys.clear();
  signingKeys.set(token, created);
  return created;
}

async function buildHeaders(
  session: HubSession,
  timestamp: number
): Promise<Record<string, string>> {
  const nonce = randomNonce();
  const canonical = [
    "GET",
    canonicalPath(HUB_ROUTES.changes),
    String(timestamp),
    nonce,
    await sha256Hex("")
  ].join("\n");
  const signed = await webCrypto().subtle.sign(
    "HMAC",
    await signingKeyFor(session.token),
    encoder.encode(canonical)
  );
  return {
    [HUB_AUTH_HEADERS.device]: session.deviceId,
    [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
    [HUB_AUTH_HEADERS.nonce]: nonce,
    [HUB_AUTH_HEADERS.signature]: bytesToHex(new Uint8Array(signed)),
    accept: "text/event-stream",
    "cache-control": "no-store"
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Normaliza un mensaje `data:`. Solo pasan páginas con lista de cambios y un
 * cursor coherente; el resto se descarta sin romper la conexión.
 */
function parsePage(raw: string, since: number): HubEventPage | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.changes)) return null;

  const received = record.changes.length;
  const changes: HubChange[] = [];
  let lastSeq = since;
  for (const candidate of record.changes) {
    const item = asRecord(candidate);
    const seq = item ? safeSeq(item.seq) : null;
    if (!item || seq === null) continue;
    // El journal del hub también expone tablas internas (hub_devices,
    // hub_receipts). Se descartan aquí, pero su seq sí cuenta para el cursor:
    // de lo contrario el primer cambio interno dejaría el cursor atrás.
    if (seq > lastSeq) lastSeq = seq;
    const table = typeof item.table === "string" ? item.table : "";
    if (INTERNAL_TABLES.has(table)) continue;
    changes.push(candidate as unknown as HubChange);
  }

  const declared = safeSeq(record.cursor) ?? safeSeq(record.latestSeq);
  const cursor =
    lastSeq > since ? lastSeq : received === 0 && declared !== null && declared > since ? declared : since;
  return { changes, cursor, hasMore: record.hasMore === true };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

/** Una conexión completa; resuelve con las páginas entregadas al cerrarse. */
async function runStream(
  session: HubSession,
  state: { since: number },
  input: OpenHubEventsInput
): Promise<number> {
  const clock = input.now ?? (() => Date.now());
  const timestamp = clock();
  if (!Number.isFinite(timestamp)) {
    throw new HubEventsError("invalid_clock", "El reloj de este equipo no es válido para el hub LAN.");
  }
  const headers = await buildHeaders(session, timestamp);
  const url = `${session.baseUrl}${HUB_EVENTS_ROUTE}?since=${state.since}`;
  const doFetch = input.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers,
      signal: input.signal,
      cache: "no-store"
    });
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) throw error;
    throw new HubEventsError("network", "No se pudo abrir el canal de eventos del hub LAN.");
  }

  if (!response.ok) {
    throw new HubEventsError(
      "http",
      `El hub LAN rechazó el canal de eventos (${response.status}).`,
      response.status
    );
  }
  if (!response.body) {
    throw new HubEventsError("stream", "El hub LAN no abrió un stream de eventos.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pages = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (input.signal?.aborted) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // Los eventos SSE se separan por una línea en blanco (\n\n o \r\n\r\n).
      let cut = buffer.search(/\r?\n\r?\n/);
      while (cut !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
        if (await handleBlock(block, state, input)) pages += 1;
        cut = buffer.search(/\r?\n\r?\n/);
      }
    }
    // Un último bloque sin línea en blanco final también es válido.
    if (buffer.trim() && (await handleBlock(buffer, state, input))) pages += 1;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // El stream ya estaba cerrado.
    }
  }
  return pages;
}

async function handleBlock(
  block: string,
  state: { since: number },
  input: OpenHubEventsInput
): Promise<boolean> {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // comentario o ping
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      eventName = value.trim() || "message";
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  // El hub reinició o reemplazó su journal: el cursor viejo ya no significa
  // nada, así que la réplica vuelve a empezar desde cero.
  if (eventName === "reset") {
    state.since = 0;
    return false;
  }
  if (dataLines.length === 0) return false;

  const page = parsePage(dataLines.join("\n"), state.since);
  if (!page) return false;
  // Se espera la aplicación antes de avanzar: el hub no debe servir el
  // siguiente tramo hasta que este equipo confirme el anterior.
  await input.onChanges(page);
  if (page.cursor > state.since) state.since = page.cursor;
  return true;
}

/**
 * Mantiene abierto el canal de eventos hasta que se aborte la señal.
 *
 * Resuelve cuando se aborta. Rechaza solo si el primer intento no llega a
 * abrir el stream (sin sesión, red caída o hub sin la ruta): el llamador
 * decide entonces caer a sondeo. Tras una conexión estable, las caídas se
 * reintentan con backoff desde el último cursor confirmado.
 */
export async function openHubEvents(input: OpenHubEventsInput): Promise<void> {
  if (!input || typeof input.onChanges !== "function") {
    throw new HubEventsError("no_session", "Falta el receptor de cambios del hub LAN.");
  }
  const baseDelayMs = input.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxInitialAttempts = Math.max(1, input.maxInitialAttempts ?? 1);

  const state = { since: safeSeq(input.since) ?? 0 };
  if (typeof input.since !== "number") {
    const session = await getHubSession();
    if (!session) throw new HubEventsError("no_session", "Este equipo no está vinculado a ningún hub LAN.");
    state.since = session.cursor;
  }

  let opened = false;
  let attempt = 0;
  while (!input.signal?.aborted) {
    const session = await getHubSession();
    if (!session) return;
    const startedAt = Date.now();
    try {
      await runStream(session, state, input);
      // El hub cerró el stream por fin del cuerpo: se reconecta desde el
      // cursor ya confirmado (`state.since`) con backoff exponencial. Un canal
      // que duró lo suficiente se considera sano y reinicia el backoff, tenga
      // o no páginas: un stream vivo y ocioso no encadena reconexiones.
      opened = true;
      if (Date.now() - startedAt >= STABLE_STREAM_MS) attempt = 0;
      attempt += 1;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay, input.signal);
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) return;
      if (error instanceof HubSyncError) throw error;
      // 401/403 no son un error de red: reintentar con el mismo token no
      // arregla nada, así que el bucle cae a sondeo con una firma nueva.
      if (
        error instanceof HubEventsError &&
        error.code === "http" &&
        (error.status === 401 || error.status === 403)
      ) {
        throw error;
      }
      attempt += 1;
      if (!opened && attempt >= maxInitialAttempts) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay, input.signal);
    }
  }
}
