import { LocalDbError, type LocalDbDriver } from "../contract";
import type { SqliteAdapter, SqlValue } from "./adapter";
import { createSqliteDriver } from "./driver";

/**
 * Adaptador SQLite para el shell Android.
 *
 * El APK expone `window.PALMYRA_DB` (NativeDb.java) con tres métodos síncronos
 * que reciben y devuelven JSON. Este archivo traduce ese protocolo al
 * `SqliteAdapter` que ya consume `createSqliteDriver`, de modo que la tablet
 * reutiliza exactamente la misma lógica de almacén que Node/Electron.
 *
 * Protocolo de respuesta: `{"ok":true,...}` en éxito y
 * `{"ok":false,"error":"...","message":"..."}` en error. Nunca hay excepciones
 * cruzando el puente; aquí se convierten en `LocalDbError` legibles.
 */

export type AndroidSqliteBridge = {
  exec(sql: string): string;
  run(sql: string, paramsJson: string): string;
  all(sql: string, paramsJson: string): string;
};

export interface AndroidSqliteDriverOptions {
  now?: () => string;
  /** Ruta lógica para diagnóstico en `_meta`; el archivo lo decide el APK. */
  filePath?: string;
  /** Permite inyectar el puente (pruebas); por defecto `window.PALMYRA_DB`. */
  bridge?: AndroidSqliteBridge;
}

interface JsonEnvelope {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  changes?: unknown;
  rows?: unknown;
}

type BridgeScope = { PALMYRA_DB?: unknown };

const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new LocalDbError("driver_unavailable", "Este entorno no puede codificar base64");
  }
  let binary = "";
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new LocalDbError("driver_unavailable", "Este entorno no puede decodificar base64");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function encodeParam(value: SqlValue): string | number | null | { b64: string } {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LocalDbError("invalid_row", "Parámetro numérico no finito para SQLite");
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    return { b64: bytesToBase64(value) };
  }
  const kind = value === undefined ? "undefined" : typeof value;
  throw new LocalDbError(
    "invalid_row",
    `Parámetro SQLite no soportado (${kind}); usa string, number, null o Uint8Array`
  );
}

function encodeParams(params: SqlValue[] | undefined): string {
  if (!params || params.length === 0) return "[]";
  return JSON.stringify(params.map((value) => encodeParam(value)));
}

function isBlobPayload(value: unknown): value is { b64: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "b64") return false;
  return typeof (value as { b64?: unknown }).b64 === "string";
}

function decodeRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const decoded: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    decoded[key] = isBlobPayload(field) ? base64ToBytes(field.b64) : field;
  }
  return decoded;
}

function readEnvelope(raw: unknown, operation: string): JsonEnvelope {
  if (typeof raw !== "string") {
    throw new LocalDbError(
      "transaction_failed",
      `El puente SQLite de Android no devolvió JSON en ${operation}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalDbError(
      "transaction_failed",
      `El puente SQLite de Android devolvió una respuesta inválida en ${operation}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalDbError(
      "transaction_failed",
      `El puente SQLite de Android devolvió una respuesta inválida en ${operation}`
    );
  }
  const envelope = parsed as JsonEnvelope;
  if (envelope.ok !== true) {
    const code = typeof envelope.error === "string" && envelope.error ? envelope.error : "error";
    const message = typeof envelope.message === "string" && envelope.message ? envelope.message : "";
    throw new LocalDbError(
      "transaction_failed",
      message ? `SQLite nativo (${code}): ${message}` : `SQLite nativo (${code}) rechazó ${operation}`
    );
  }
  return envelope;
}

function isAndroidSqliteBridge(value: unknown): value is AndroidSqliteBridge {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AndroidSqliteBridge>;
  return (
    typeof candidate.exec === "function" &&
    typeof candidate.run === "function" &&
    typeof candidate.all === "function"
  );
}

function bridgeScope(): BridgeScope | null {
  if (typeof window !== "undefined") return window as unknown as BridgeScope;
  if (typeof globalThis !== "undefined") return globalThis as unknown as BridgeScope;
  return null;
}

/** `true` cuando la app corre dentro del APK con el puente PALMYRA_DB. */
export function androidSqliteBridgeAvailable(): boolean {
  const scope = bridgeScope();
  return scope !== null && isAndroidSqliteBridge(scope.PALMYRA_DB);
}

export function createAndroidSqliteAdapter(bridge: AndroidSqliteBridge): SqliteAdapter {
  if (!isAndroidSqliteBridge(bridge)) {
    throw new LocalDbError(
      "driver_unavailable",
      "El puente SQLite de Android no expone exec/run/all"
    );
  }
  let closed = false;
  return {
    exec(sql: string): void {
      if (closed) throw new LocalDbError("driver_unavailable", "El adaptador SQLite de Android está cerrado");
      readEnvelope(bridge.exec(sql), "exec");
    },
    run(sql: string, params?: SqlValue[]): { changes: number } {
      if (closed) throw new LocalDbError("driver_unavailable", "El adaptador SQLite de Android está cerrado");
      const envelope = readEnvelope(bridge.run(sql, encodeParams(params)), "run");
      const changes = Number(envelope.changes ?? 0);
      return { changes: Number.isFinite(changes) ? changes : 0 };
    },
    all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): T[] {
      if (closed) throw new LocalDbError("driver_unavailable", "El adaptador SQLite de Android está cerrado");
      const envelope = readEnvelope(bridge.all(sql, encodeParams(params)), "all");
      if (!Array.isArray(envelope.rows)) return [];
      return envelope.rows.map((row) => decodeRow(row)) as T[];
    },
    close(): void {
      if (closed) return;
      closed = true;
      // NativeDb.close() es idempotente, pero no forma parte del contrato del
      // puente que consume el driver: si existe se libera la base nativa.
      const closeBridge = (bridge as AndroidSqliteBridge & { close?: () => void }).close;
      if (typeof closeBridge === "function") {
        try {
          closeBridge.call(bridge);
        } catch {
          // Ya estaba cerrada.
        }
      }
    }
  };
}

/**
 * Abre el almacén local sobre la base nativa del APK. Sin `window.PALMYRA_DB`
 * (navegador, PWA, tests) falla con `driver_unavailable` para que el arranque
 * elija otro driver en vez de quedarse a medias.
 */
export async function createAndroidSqliteDriver(
  options: AndroidSqliteDriverOptions = {}
): Promise<LocalDbDriver> {
  const bridge = options.bridge ?? bridgeScope()?.PALMYRA_DB;
  if (!isAndroidSqliteBridge(bridge)) {
    throw new LocalDbError(
      "driver_unavailable",
      "El puente SQLite nativo de Android (PALMYRA_DB) no está disponible"
    );
  }
  return createSqliteDriver({
    adapter: createAndroidSqliteAdapter(bridge),
    now: options.now,
    filePath: options.filePath
  });
}
