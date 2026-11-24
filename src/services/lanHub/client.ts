import { HUB_AUTH_HEADERS, canonicalPath } from "./shared";
import {
  HUB_DEFAULT_PAGE_LIMIT,
  HUB_MAX_PAGE_LIMIT,
  HUB_ROUTES,
  type HubChangesResponse,
  type HubHealthResponse,
  type HubOpInput,
  type HubOpsResponse,
  type HubSnapshotResponse
} from "./protocol";
import { LOCAL_DB_TABLE_NAMES } from "../localDb/schema";
import type { LocalRow, LocalTable } from "../localDb/contract";

/**
 * Cliente HTTP del hub LAN v1.
 *
 * Replica la firma de `auth.ts` con WebCrypto para poder correr tanto en el
 * renderer de Electron como en Node: la clave HMAC es el sha256 (hex) del
 * token, exactamente lo que el hub guarda al emparejar. El token nunca sale de
 * este módulo: no viaja en la URL, ni en el cuerpo, ni en los mensajes de error.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const INTERNAL_TABLES = new Set<string>(["hub_devices", "hub_receipts"]);

interface WebCryptoLike {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export interface HubClientOptions {
  /** Raíz del hub, p. ej. `http://192.168.1.10:48900`; puede venir con barra final. */
  baseUrl: string;
  deviceId: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Milisegundos; se inyecta en pruebas. */
  now?: () => number;
  timeoutMs?: number;
}

export interface HubClient {
  readonly baseUrl: string;
  readonly deviceId: string;
  request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
  health(): Promise<HubHealthResponse>;
  changes(input?: { since?: number; limit?: number }): Promise<HubChangesResponse>;
  pushOps(input: { ops: HubOpInput[] }): Promise<HubOpsResponse>;
  snapshot(input?: { tables?: LocalTable[] }): Promise<HubSnapshotResponse>;
}

export class HubClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HubClientError";
    this.status = status;
    this.code = code;
  }
}

function webCrypto(): WebCryptoLike {
  const api = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!api || !api.subtle || typeof api.getRandomValues !== "function") {
    throw new Error("WebCrypto no está disponible en este entorno para firmar peticiones al hub LAN");
  }
  return api;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  webCrypto().getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Firmador reutilizable con WebCrypto. Lo comparten el cliente HTTP y el
 * cliente de operaciones: la clave HMAC es el sha256 (hex) del token, igual
 * que en el servidor, pero sin arrastrar `node:crypto` al bundle web.
 */
export interface HubRequestSigner {
  nonce(): string;
  sign(method: string, path: string, timestamp: number, nonce: string, body: string): Promise<string>;
}

export function createHubRequestSigner(token: string): HubRequestSigner {
  const secret = requireText(token, "Falta el token del equipo para el hub LAN");
  let key: Promise<CryptoKey> | null = null;

  function signingKey(): Promise<CryptoKey> {
    if (!key) {
      key = (async () => {
        const tokenHash = await sha256Hex(secret);
        return webCrypto().subtle.importKey(
          "raw",
          new TextEncoder().encode(tokenHash),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
      })();
    }
    return key;
  }

  return {
    nonce: randomNonce,
    async sign(method, path, timestamp, nonce, body) {
      const canonical = [
        method.toUpperCase(),
        canonicalPath(path),
        String(timestamp),
        nonce,
        await sha256Hex(body)
      ].join("\n");
      const signed = await webCrypto().subtle.sign(
        "HMAC",
        await signingKey(),
        new TextEncoder().encode(canonical)
      );
      return bytesToHex(new Uint8Array(signed));
    }
  };
}

function normalizeBaseUrl(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error("La dirección del hub LAN es obligatoria");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("La dirección del hub LAN no es válida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("El hub LAN debe usar http o https");
  }
  if (url.username || url.password) {
    throw new Error("La dirección del hub LAN no debe incluir credenciales");
  }
  if (url.search || url.hash) {
    throw new Error("La dirección del hub LAN no debe incluir query ni fragmento");
  }
  return value.replace(/\/+$/, "");
}

function requireText(value: string, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function errorCodeOf(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const code = (payload as { error?: unknown }).error;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return "";
}

function statusMessage(method: string, route: string, status: number, code: string): string {
  const suffix = code ? `: ${code}` : "";
  if (status === 401) {
    return `El hub LAN rechazó la autenticación de ${method} ${route} (401${suffix})`;
  }
  if (status === 409) {
    return `El hub LAN rechazó ${method} ${route} por conflicto (409${suffix})`;
  }
  return `El hub LAN rechazó ${method} ${route} (${status}${suffix})`;
}

function integerOption(value: number | undefined, fallback: number, name: string, min = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} debe ser un entero mayor o igual que ${min}`);
  }
  return Math.floor(value);
}

function snapshotTables(tables: LocalTable[] | undefined): LocalTable[] {
  const requested = tables && tables.length > 0
    ? tables
    : (LOCAL_DB_TABLE_NAMES.filter((name) => !INTERNAL_TABLES.has(name)) as LocalTable[]);
  const seen = new Set<string>();
  const result: LocalTable[] = [];
  for (const table of requested) {
    if (!(LOCAL_DB_TABLE_NAMES as string[]).includes(table)) {
      throw new Error(`Tabla desconocida para la copia del hub: ${String(table)}`);
    }
    if (INTERNAL_TABLES.has(table)) {
      throw new Error(`La tabla ${table} es interna del hub y no se puede copiar`);
    }
    if (seen.has(table)) continue;
    seen.add(table);
    result.push(table);
  }
  return result;
}

export function createHubClient(options: HubClientOptions): HubClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const deviceId = requireText(options.deviceId, "Falta el identificador del equipo para el hub LAN");
  const token = requireText(options.token, "Falta el token del equipo para el hub LAN");
  const clock = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("El tiempo máximo de espera del hub LAN debe ser positivo");
  }
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  // La clave HMAC se deriva y se importa una sola vez por cliente.
  let signingKey: Promise<CryptoKey> | null = null;
  function key(): Promise<CryptoKey> {
    if (!signingKey) {
      signingKey = (async () => {
        const tokenHash = await sha256Hex(token);
        return webCrypto().subtle.importKey(
          "raw",
          new TextEncoder().encode(tokenHash),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
      })();
    }
    return signingKey;
  }

  async function signature(
    method: string,
    path: string,
    timestamp: number,
    nonce: string,
    body: string
  ): Promise<string> {
    // Misma cadena canónica que auth.ts: la ruta firmada excluye query y fragmento.
    const canonical = [
      method.toUpperCase(),
      canonicalPath(path),
      String(timestamp),
      nonce,
      await sha256Hex(body)
    ].join("\n");
    const signed = await webCrypto().subtle.sign("HMAC", await key(), new TextEncoder().encode(canonical));
    return bytesToHex(new Uint8Array(signed));
  }

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error("La ruta del hub LAN debe empezar por /");
    }
    const route = canonicalPath(path);
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const timestamp = clock();
    if (!Number.isFinite(timestamp)) throw new Error("El reloj del equipo no es válido para firmar al hub LAN");
    const nonce = randomNonce();
    const signatureHex = await signature(method, path, timestamp, nonce, bodyText);

    const headers: Record<string, string> = {
      [HUB_AUTH_HEADERS.device]: deviceId,
      [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
      [HUB_AUTH_HEADERS.nonce]: nonce,
      [HUB_AUTH_HEADERS.signature]: signatureHex,
      accept: "application/json"
    };
    if (bodyText) headers["content-type"] = "application/json";

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutError = new HubClientError(
      0,
      "timeout",
      `El hub LAN no respondió en ${timeoutMs} ms (${method} ${route})`
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // El fetch ya terminó; el rechazo por timeout sobra.
        }
        reject(timeoutError);
      }, timeoutMs);
    });

    let response: Response;
    try {
      response = await Promise.race([
        doFetch(baseUrl + path, {
          method,
          headers,
          body: bodyText || undefined,
          signal: controller?.signal,
          cache: "no-store"
        }),
        timeout
      ]);
    } catch (error) {
      if (error instanceof HubClientError) throw error;
      if (controller?.signal.aborted) throw timeoutError;
      throw new HubClientError(0, "network_error", `No se pudo contactar con el hub LAN (${method} ${route})`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const code = errorCodeOf(payload) || `http_${response.status}`;
      throw new HubClientError(response.status, code, statusMessage(method, route, response.status, code));
    }
    if (payload === null) {
      throw new HubClientError(
        response.status,
        "invalid_response",
        `El hub LAN devolvió una respuesta no válida en ${method} ${route}`
      );
    }
    return payload as T;
  }

  return {
    baseUrl,
    deviceId,
    request,

    health(): Promise<HubHealthResponse> {
      return request<HubHealthResponse>("GET", HUB_ROUTES.health);
    },

    changes(input = {}): Promise<HubChangesResponse> {
      const since = integerOption(input.since, 0, "since");
      const limit = integerOption(input.limit, HUB_DEFAULT_PAGE_LIMIT, "limit", 1);
      const capped = Math.min(HUB_MAX_PAGE_LIMIT, limit);
      return request<HubChangesResponse>(
        "GET",
        `${HUB_ROUTES.changes}?since=${since}&limit=${capped}`
      );
    },

    pushOps(input: { ops: HubOpInput[] }): Promise<HubOpsResponse> {
      const ops = input && Array.isArray(input.ops) ? input.ops : null;
      if (!ops) throw new Error("Las operaciones para el hub LAN deben ser una lista");
      return request<HubOpsResponse>("POST", HUB_ROUTES.ops, { deviceId, ops });
    },

    async snapshot(input = {}): Promise<HubSnapshotResponse> {
      const tables = snapshotTables(input.tables);
      const rows: LocalRow[] = [];
      let latestSeq = 0;
      // Una petición por tabla: el protocolo v1 copia de a una, así el hub no
      // arma respuestas gigantes ni bloquea su cola.
      for (const table of tables) {
        const page = await request<HubSnapshotResponse>(
          "GET",
          `${HUB_ROUTES.snapshot}?table=${encodeURIComponent(table)}`
        );
        if (Array.isArray(page.rows)) rows.push(...page.rows);
        if (Number.isFinite(page.latestSeq)) latestSeq = Math.max(latestSeq, page.latestSeq);
      }
      return { rows, latestSeq };
    }
  };
}
