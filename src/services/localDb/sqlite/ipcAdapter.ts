import type {
  DesktopDbInvoke,
  DesktopDbParam,
  DesktopDbRequest,
  DesktopDbResult
} from "../../../lib/desktopRuntime";
import type { SqlValue } from "./adapter";

/**
 * Adaptador SQLite sobre el puente IPC del escritorio.
 *
 * El proceso principal es el único dueño de la base: el renderer solo pide
 * `exec`/`run`/`all` y recibe filas planas. Los binarios viajan como `{b64}`
 * porque el puente no acepta objetos de Node.
 *
 * El adaptador responde con promesas, como cualquier puente IPC; el driver
 * SQLite espera cada operación, así que el contrato encaja sin conversiones.
 */

export const IPC_SQLITE_TIMEOUT_MS = 15_000;
const BASE64_CHUNK = 0x8000;

export interface IpcSqliteBridge {
  invoke: DesktopDbInvoke;
}

export interface IpcSqliteAdapterOptions {
  /** Tiempo máximo por invocación; por defecto 15 s. */
  timeoutMs?: number;
}

export interface IpcSqliteAdapter {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  close(): void;
}

function isBlobPayload(value: unknown): value is { b64: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "b64") return false;
  return typeof (value as { b64?: unknown }).b64 === "string";
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("Este entorno no puede codificar base64 para el puente SQLite de escritorio");
  }
  let binary = "";
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Este entorno no puede decodificar base64 del puente SQLite de escritorio");
  }
  // Tolera base64url y la falta de relleno sin alterar el contenido.
  let normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  if (padding > 0) normalized += "=".repeat(4 - padding);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function encodeParam(value: SqlValue): DesktopDbParam {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Parámetro numérico no finito para SQLite");
    }
    return value;
  }
  return { b64: bytesToBase64(value) };
}

function encodeParams(params: SqlValue[] | undefined): DesktopDbParam[] | undefined {
  return params ? params.map((value) => encodeParam(value)) : undefined;
}

/** Las filas del puente son planas, pero se decodifica en profundidad por si llega un arreglo. */
function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeValue(item));
  if (isBlobPayload(value)) return base64ToBytes(value.b64);
  if (value && typeof value === "object") {
    const decoded: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      decoded[key] = decodeValue(field);
    }
    return decoded;
  }
  return value;
}

function unexpected(action: string): Error {
  return new Error(`El puente SQLite de escritorio devolvió una respuesta inesperada en ${action}`);
}

function rejectionText(result: DesktopDbResult | null | undefined, action: string): string {
  if (result && typeof result === "object" && result.ok === false) {
    const text = typeof result.error === "string" ? result.error.trim() : "";
    if (text) return text;
  }
  return `El puente SQLite de escritorio rechazó ${action}`;
}

async function invokeBridge(
  bridge: IpcSqliteBridge,
  request: DesktopDbRequest,
  timeoutMs: number,
  action: string
): Promise<DesktopDbResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`La base de datos de escritorio no respondió en ${timeoutMs} ms (${action})`));
    }, timeoutMs);
  });

  try {
    let result: DesktopDbResult;
    try {
      result = await Promise.race([bridge.invoke(request), timeout]);
    } catch (error) {
      // Un rechazo del puente se propaga con su propio texto, sin inventarlo.
      throw error instanceof Error ? error : new Error(String(error ?? "error desconocido"));
    }
    if (!result || typeof result !== "object") throw unexpected(action);
    if (result.ok !== true) throw new Error(rejectionText(result, action));
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readTimeout(options: IpcSqliteAdapterOptions): number {
  const value = options.timeoutMs ?? IPC_SQLITE_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("El tiempo máximo del puente SQLite de escritorio debe ser positivo");
  }
  return value;
}

export function createIpcSqliteAdapter(
  bridge: IpcSqliteBridge,
  options: IpcSqliteAdapterOptions = {}
): IpcSqliteAdapter {
  if (!bridge || typeof bridge.invoke !== "function") {
    throw new Error("El puente SQLite de escritorio no expone invoke");
  }
  const timeoutMs = readTimeout(options);

  return {
    async exec(sql: string): Promise<void> {
      await invokeBridge(bridge, { op: "exec", sql }, timeoutMs, "exec");
    },

    async run(sql: string, params?: SqlValue[]): Promise<{ changes: number }> {
      const result = await invokeBridge(
        bridge,
        { op: "run", sql, params: encodeParams(params) },
        timeoutMs,
        "run"
      );
      if (!("changes" in result) || typeof result.changes !== "number" || !Number.isFinite(result.changes)) {
        throw unexpected("run");
      }
      return { changes: result.changes };
    },

    async all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]> {
      const result = await invokeBridge(
        bridge,
        { op: "all", sql, params: encodeParams(params) },
        timeoutMs,
        "all"
      );
      if (!("rows" in result) || !Array.isArray(result.rows)) throw unexpected("all");
      return result.rows.map((row) => decodeValue(row)) as T[];
    },

    close(): void {
      // No-op: la conexión la posee el proceso principal; cerrarla aquí dejaría
      // sin base al hub LAN y a la propia app.
    }
  };
}
