/**
 * Servidor HTTP real del hub LAN sobre `node:http` (sin Express).
 *
 * Solo transporta: el protocolo, la autenticación y la idempotencia viven en
 * `handler.ts`. Aquí se aplican los límites del cable (tamaño de cuerpo,
 * métodos y content-type), se escucha por defecto en loopback y se registra
 * un acceso sin cuerpos, tokens ni firmas.
 */
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { HubHandler } from "./handler";
import {
  HUB_MAX_BODY_BYTES,
  HUB_PROTOCOL_VERSION,
  HUB_ROUTES,
  errorResponse,
  type HubChangesResponse,
  type HubMethod,
  type HubRequest,
  type HubResponse
} from "./protocol";
import { HUB_EVENTS_ROUTE } from "./events";
import { HUB_AUTH_HEADERS } from "./shared";

export interface HubNodeServerOptions {
  handler: HubHandler;
  /** Por defecto 0: puerto efímero; el llamador decide el puerto del hub. */
  port?: number;
  /** Por defecto `127.0.0.1`; otro host exige `allowLan: true`. */
  host?: string;
  /** Tope del cuerpo; por defecto `HUB_MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
  /** Sin esto, un host que no sea loopback se rechaza. */
  allowLan?: boolean;
  /** Cada cuánto reconsulta el journal el canal SSE (por defecto 2000 ms). */
  eventsPollMs?: number;
  /** Cada cuánto envía un `: ping` el canal SSE (por defecto 20000 ms). */
  eventsPingMs?: number;
  /**
   * Fuente de páginas del journal para el canal SSE. Se llama en cada sondeo
   * con el cursor ya confirmado y SIN volver a firmar; si falta, el canal
   * responde 503 `events_unavailable`. Normalmente es `readChangeFeed`.
   */
  changes?: (input: { since: number; limit: number }) => Promise<HubChangesResponse>;
  /**
   * Material del certificado autofirmado. Sin esto el servidor sigue siendo
   * HTTP puro; con esto escucha en https y publica la huella del certificado.
   */
  tls?: { certPem: string; keyPem: string; fingerprint: string };
  log?: (line: string) => void;
}

export interface HubNodeServer {
  url: string;
  port: number;
  /** Huella sha256 (hex) del certificado servido; vacía sin TLS. */
  fingerprint: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1"
]);
/** Únicos parámetros de query que se registran con valor. */
const LOGGABLE_QUERY_KEYS = ["since", "limit", "table"];

const DEFAULT_EVENTS_POLL_MS = 2_000;
const DEFAULT_EVENTS_PING_MS = 20_000;
/** Filas por consulta interna del canal SSE. */
const EVENTS_PAGE_LIMIT = 200;
/** Páginas seguidas que se vacían sin esperar el intervalo de sondeo. */
const MAX_DRAIN_PAGES = 20;

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no"
};

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  if (normalized.startsWith("::ffff:")) return isLoopbackHost(normalized.slice(7));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function normalizeHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // Node ya entrega las cabeceras en minúsculas; se normaliza por si acaso.
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function isJsonContentType(value: string): boolean {
  const type = value.split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/** Ruta apta para el log: descarta cualquier query no listada (tokens, códigos…). */
function safeLogPath(rawUrl: string): string {
  const cut = rawUrl.indexOf("?");
  if (cut === -1) return rawUrl;
  const path = rawUrl.slice(0, cut);
  const params = new URLSearchParams(rawUrl.slice(cut + 1));
  const kept: string[] = [];
  for (const key of LOGGABLE_QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null) kept.push(`${key}=${value}`);
  }
  return kept.length > 0 ? `${path}?${kept.join("&")}` : path;
}

interface BodyRead {
  ok: boolean;
  text: string;
}

/**
 * Acumula el cuerpo y corta en `limit`. Al excederse deja de acopiar y drena
 * el resto: la respuesta 413 ya lleva `connection: close` y el socket se
 * destruye después de vaciarla.
 */
function readBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onClose);
      req.off("close", onClose);
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limit) {
        finish({ ok: false, text: "" });
        // Sin acumular el resto y sin bloquear el socket.
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    const onClose = (): void => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") });

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onClose);
    req.on("close", onClose);
  });
}

function responseHeaders(
  response: HubResponse,
  extra: Record<string, string> | undefined
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    headers[key.toLowerCase()] = String(value);
  }
  if (!headers["content-type"]) headers["content-type"] = JSON_CONTENT_TYPE;
  if (!headers["cache-control"]) headers["cache-control"] = "no-store";
  headers["x-palmyra-protocol"] = String(HUB_PROTOCOL_VERSION);
  return { ...headers, ...extra };
}

export async function createHubNodeServer(options: HubNodeServerOptions): Promise<HubNodeServer> {
  const handler = options.handler;
  if (typeof handler !== "function") {
    throw new Error("createHubNodeServer requiere un HubHandler");
  }

  const host = (options.host ?? DEFAULT_HOST).trim();
  if (!host) throw new Error("host del hub vacío");
  if (!isLoopbackHost(host) && options.allowLan !== true) {
    throw new Error(
      `LAN deshabilitada: ${host} no es loopback; usa allowLan: true para exponer el hub en la red`
    );
  }

  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`puerto inválido: ${String(options.port)}`);
  }
  const maxBodyBytes = options.maxBodyBytes ?? HUB_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes debe ser un entero positivo");
  }
  const eventsPollMs =
    Number.isInteger(options.eventsPollMs) && (options.eventsPollMs as number) > 0
      ? (options.eventsPollMs as number)
      : DEFAULT_EVENTS_POLL_MS;
  const eventsPingMs =
    Number.isInteger(options.eventsPingMs) && (options.eventsPingMs as number) > 0
      ? (options.eventsPingMs as number)
      : DEFAULT_EVENTS_PING_MS;
  const log = options.log;

  const tls = options.tls;
  if (tls) {
    if (!tls.certPem?.trim() || !tls.keyPem?.trim() || !tls.fingerprint?.trim()) {
      throw new Error("TLS del hub incompleto: faltan certificado, clave o huella");
    }
  }

  /** Un cierre por equipo: el mapa limita a una conexión SSE por dispositivo. */
  const eventStreams = new Map<string, (reason: string) => void>();

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res);
  };
  const server: Server = tls
    ? createHttpsServer({ cert: tls.certPem, key: tls.keyPem }, listener)
    : createHttpServer(listener);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = (req.method ?? "").toUpperCase();
    const path = req.url ?? "/";
    const remoteAddr = req.socket.remoteAddress ?? "";
    const headers = normalizeHeaders(req.headers);

    function respond(
      response: HubResponse,
      extra?: Record<string, string>,
      onFlushed?: () => void
    ): void {
      if (log) {
        log(
          `[lan-hub] ${method || "-"} ${safeLogPath(path)} ${response.status} ` +
            `${Date.now() - startedAt}ms ${remoteAddr || "-"}`
        );
      }
      if (res.writableEnded || res.destroyed) return;
      const payload = Buffer.from(response.body ?? "", "utf8");
      const outgoing = responseHeaders(response, extra);
      outgoing["content-length"] = String(payload.length);
      try {
        res.writeHead(response.status, outgoing);
        res.end(payload, onFlushed);
      } catch {
        // El cliente se fue antes de poder responder: no hay nada que hacer.
      }
    }

    /**
     * Canal SSE (`GET /lan/v1/events`).
     *
     * Se autentica UNA sola vez con el handler usando las mismas cabeceras
     * firmadas por el cliente (la firma canónica cubre `/lan/v1/changes`):
     * `health` confirma que el hub responde y una única consulta a `changes`
     * valida de verdad la firma (la salud es pública y no consume el nonce).
     * A partir de ahí cada sondeo usa `options.changes` —sin firmar, sin
     * consumir nonces y sin caducar con la ventana de reloj—, de modo que la
     * conexión permanece abierta hasta que el cliente se va.
     */
    async function handleEventStream(
      req: IncomingMessage,
      res: ServerResponse,
      reqHeaders: Record<string, string>,
      rawPath: string,
      remoteAddr: string
    ): Promise<void> {
      const startedAt = Date.now();
      const feed = options.changes;
      const deviceId = (reqHeaders[HUB_AUTH_HEADERS.device] ?? "").trim();
      if (!deviceId) {
        req.resume();
        respond(errorResponse(401, "unauthorized"));
        return;
      }
      // Sin la firma completa no se abre el stream: el hub no re-firma.
      const hasSignature =
        Boolean(reqHeaders[HUB_AUTH_HEADERS.timestamp]?.trim()) &&
        Boolean(reqHeaders[HUB_AUTH_HEADERS.nonce]?.trim()) &&
        Boolean(reqHeaders[HUB_AUTH_HEADERS.signature]?.trim());
      if (!hasSignature) {
        req.resume();
        respond(errorResponse(401, "unauthorized"));
        return;
      }
      if (typeof feed !== "function") {
        req.resume();
        respond(errorResponse(503, "events_unavailable"));
        return;
      }

      let cursor = 0;
      try {
        const url = new URL(rawPath, "http://hub.local");
        const parsed = Number(url.searchParams.get("since") ?? "");
        if (Number.isFinite(parsed) && parsed > 0) cursor = Math.floor(parsed);
      } catch {
        cursor = 0;
      }

      // Autenticación única con el handler. `health` primero (según el
      // protocolo del cable) y luego una consulta real a `changes`, que es la
      // única que verifica la firma porque `health` no está protegida.
      let probe: HubResponse;
      try {
        probe = await handler({
          method: "GET",
          path: HUB_ROUTES.health,
          headers: reqHeaders,
          bodyText: "",
          remoteAddr
        });
      } catch {
        probe = errorResponse(500, "internal_error");
      }
      if (probe.status !== 200) {
        respond(probe);
        return;
      }
      let auth: HubResponse;
      try {
        auth = await handler({
          method: "GET",
          path: `${HUB_ROUTES.changes}?since=${cursor}&limit=1`,
          headers: reqHeaders,
          bodyText: "",
          remoteAddr
        });
      } catch {
        auth = errorResponse(500, "internal_error");
      }
      if (auth.status !== 200) {
        respond(auth);
        return;
      }
      if (res.destroyed || res.writableEnded) return;

      // Una sola conexión viva por equipo: la segunda se rechaza y la primera
      // sigue intacta. El mapa se limpia en `finish` cuando el stream se cierra.
      if (eventStreams.has(deviceId)) {
        req.resume();
        respond(errorResponse(409, "events_already_open"));
        return;
      }

      res.writeHead(200, { ...SSE_HEADERS, "x-palmyra-protocol": String(HUB_PROTOCOL_VERSION) });
      // Un GET sin cuerpo no debe quedar sujeto al timeout del socket.
      try {
        req.socket?.setTimeout?.(0);
      } catch {
        // El socket ya está cerrado; el write de abajo lo detectará.
      }
      res.write(": conectado\n\n");

      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      const finish = (reason: string): void => {
        if (closed) return;
        closed = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        if (pingTimer !== undefined) clearInterval(pingTimer);
        if (eventStreams.get(deviceId) === finish) eventStreams.delete(deviceId);
        if (log) {
          log(
            `[lan-hub] GET ${HUB_EVENTS_ROUTE} cerrado(${reason}) ` +
              `${Date.now() - startedAt}ms ${remoteAddr || "-"}`
          );
        }
        try {
          if (!res.writableEnded && !res.destroyed) res.end();
        } catch {
          // El cliente ya había cerrado la conexión.
        }
      };

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          if (res.writableEnded || res.destroyed) {
            finish("socket");
            return false;
          }
          res.write(chunk);
          return true;
        } catch {
          finish("write_error");
          return false;
        }
      };

      eventStreams.set(deviceId, finish);
      req.on("close", () => finish("cliente"));
      res.on("close", () => finish("cliente"));
      res.on("error", () => finish("error"));

      // Comentario periódico: mantiene viva la conexión sin enviar cambios falsos.
      pingTimer = setInterval(() => write(": ping\n\n"), eventsPingMs);

      /**
       * Sondeo sin firmar. Si la página declara `hasMore`, se encadena la
       * siguiente de inmediato (con un tope) para vaciar el retraso; después se
       * vuelve al intervalo normal. Cada página viaja como un `data:` propio.
       */
      const poll = async (drain = 0): Promise<void> => {
        if (closed) return;
        let page: HubChangesResponse;
        try {
          page = await feed({ since: cursor, limit: EVENTS_PAGE_LIMIT });
        } catch {
          finish("feed_error");
          return;
        }
        if (closed) return;
        if (!page || !Array.isArray(page.changes)) {
          finish("invalid_page");
          return;
        }

        const latestSeq =
          typeof page.latestSeq === "number" && Number.isSafeInteger(page.latestSeq) && page.latestSeq > 0
            ? page.latestSeq
            : 0;
        // Journal reiniciado o reemplazado: el cliente debe volver a empezar.
        if (latestSeq > 0 && latestSeq < cursor) {
          if (!write(`event: reset\ndata: ${JSON.stringify({ since: 0, latestSeq })}\n\n`)) return;
          cursor = 0;
        }

        let lastSeq = cursor;
        for (const change of page.changes) {
          const seq = change && typeof change === "object"
            ? (change as { seq?: unknown }).seq
            : undefined;
          if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > lastSeq) {
            lastSeq = seq;
          }
        }
        if (page.changes.length > 0) {
          if (lastSeq <= cursor) {
            finish("invalid_change");
            return;
          }
          // Solo hay `data:` cuando el journal trae cambios de verdad.
          const wire = JSON.stringify({
            changes: page.changes,
            latestSeq: page.latestSeq,
            serverTime: page.serverTime,
            hasMore: page.hasMore === true
          });
          if (!write(`data: ${wire}\n\n`)) return;
          cursor = lastSeq;
          if (page.hasMore === true && drain < MAX_DRAIN_PAGES) {
            pollTimer = setTimeout(() => {
              void poll(drain + 1);
            }, 0);
            return;
          }
        }
        pollTimer = setTimeout(() => {
          void poll(0);
        }, eventsPollMs);
      };

      void poll();
    }

    try {
      if (method !== "GET" && method !== "POST") {
        req.resume();
        respond(errorResponse(405, "method_not_allowed"), { allow: "GET, POST" });
        return;
      }

      let routePath = "";
      try {
        routePath = new URL(path, "http://hub.local").pathname.replace(/\/+$/, "") || "/";
      } catch {
        routePath = "";
      }
      if (routePath === HUB_EVENTS_ROUTE) {
        if (method !== "GET") {
          req.resume();
          respond(errorResponse(405, "method_not_allowed"), { allow: "GET" });
          return;
        }
        await handleEventStream(req, res, headers, path, remoteAddr);
        return;
      }

      const body = await readBody(req, maxBodyBytes);
      if (!body.ok) {
        respond(errorResponse(413, "body_too_large"), { connection: "close" }, () => {
          req.destroy();
        });
        return;
      }

      if (body.text.trim() !== "" && !isJsonContentType(headers["content-type"] ?? "")) {
        respond(errorResponse(415, "unsupported_media_type"));
        return;
      }

      const hubRequest: HubRequest = {
        method: (method === "GET" ? "GET" : "POST") as HubMethod,
        path,
        headers,
        bodyText: body.text,
        remoteAddr
      };

      let response: HubResponse;
      try {
        response = await handler(hubRequest);
      } catch {
        // Nunca se filtra el error: mismo JSON genérico que el handler.
        response = errorResponse(500, "internal_error");
      }
      respond(response);
    } catch {
      respond(errorResponse(500, "internal_error"));
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const protocol = tls ? "https" : "http";

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    if (closing) return closing;
    // Los streams SSE no terminan solos: se cierran antes de apagar el servidor.
    for (const finish of Array.from(eventStreams.values())) finish("shutdown");
    eventStreams.clear();
    closing = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
      // Corta keep-alive y conexiones colgadas para que el puerto quede libre.
      server.closeAllConnections?.();
    });
    return closing;
  }

  return {
    url: `${protocol}://${urlHost}:${actualPort}`,
    port: actualPort,
    fingerprint: tls ? tls.fingerprint.trim().toLowerCase() : "",
    close
  };
}
