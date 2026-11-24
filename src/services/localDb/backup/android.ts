/**
 * Respaldo del dispositivo Android (Descargas públicas y restauración desde archivo).
 *
 * Wrapper puro sobre el puente `PALMYRA_BACKUP` del APK: el shell escribe el
 * archivo, pero aquí se decide el Base64, se leen los trozos del archivo
 * importado y se traducen todos los envelopes a un resultado estable. Ninguna
 * función lanza: un puente ausente o roto devuelve `{ ok:false, error }`.
 */
import {
  ANDROID_BACKUP_IMPORTED_EVENT,
  getAndroidBackupBridge,
  type AndroidBackupBridge,
  type AndroidBackupImportedDetail
} from "../../../lib/nativeApp";
import { fromBase64, toBase64 } from "./format";

/** El shell acepta hasta 1 MB por readPending; se pide la mitad para no bloquear la WebView. */
const READ_CHUNK_BYTES = 512 * 1024;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Un trozo de 1 MB en Base64 ronda 1,4 MB: más que eso no es una respuesta válida. */
const MAX_ENVELOPE_CHARS = 2 * 1024 * 1024;
/** Mismo techo que valida el shell al guardar e importar. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

export type AndroidBackupSaveResult = { ok: boolean; location?: string; error?: string };

export type AndroidBackupListItem = { name: string; bytes: number; savedAt: string | null };

export type AndroidBackupListResult = {
  ok: boolean;
  backups: AndroidBackupListItem[];
  error?: string;
};

export type AndroidBackupRemoveResult = { ok: boolean; error?: string };

export type AndroidBackupPickResult = {
  ok: boolean;
  bytes?: Uint8Array;
  name?: string;
  error?: string;
};

export function isAndroidBackupAvailable(): boolean {
  try {
    return getAndroidBackupBridge() !== null;
  } catch {
    return false;
  }
}

/**
 * Guarda el sobre cifrado en Descargas. El nombre lo sanea el shell; aquí solo
 * se rechaza lo que el puente rechazaría para no escribir archivos inútiles.
 */
export async function saveBackupToDevice(
  bytes: Uint8Array,
  fileName: string
): Promise<AndroidBackupSaveResult> {
  const bridge = getAndroidBackupBridge();
  if (!bridge) return { ok: false, error: "unavailable" };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { ok: false, error: "empty_data" };
  if (bytes.length > MAX_BACKUP_BYTES) return { ok: false, error: "too_large" };

  try {
    const envelope = parseEnvelope(await bridge.save(String(fileName ?? ""), toBase64(bytes), ""));
    if (!envelope) return { ok: false, error: "invalid_response" };
    if (envelope.ok !== true) return { ok: false, error: errorCode(envelope.error, "save_failed") };
    const location = typeof envelope.location === "string" ? envelope.location : "";
    return location ? { ok: true, location } : { ok: true };
  } catch {
    return { ok: false, error: "save_failed" };
  }
}

/** Respaldos `palmyra-backup-*.bin` presentes en Descargas. */
export async function listDeviceBackups(): Promise<AndroidBackupListResult> {
  const bridge = getAndroidBackupBridge();
  if (!bridge) return { ok: false, backups: [], error: "unavailable" };

  try {
    const envelope = parseEnvelope(await bridge.list());
    if (!envelope) return { ok: false, backups: [], error: "invalid_response" };
    if (envelope.ok !== true) {
      return { ok: false, backups: [], error: errorCode(envelope.error, "list_failed") };
    }
    const backups: AndroidBackupListItem[] = [];
    const raw = envelope.backups;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (typeof record.name !== "string" || record.name.length === 0) continue;
        const size = Number(record.bytes);
        backups.push({
          name: record.name,
          bytes: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
          // El shell devuelve null cuando el sistema no expone la fecha.
          savedAt:
            typeof record.savedAt === "string" && record.savedAt.length > 0
              ? record.savedAt
              : null
        });
      }
    }
    return { ok: true, backups };
  } catch {
    return { ok: false, backups: [], error: "list_failed" };
  }
}

export async function removeDeviceBackup(name: string): Promise<AndroidBackupRemoveResult> {
  const bridge = getAndroidBackupBridge();
  if (!bridge) return { ok: false, error: "unavailable" };
  if (typeof name !== "string" || name.length === 0) return { ok: false, error: "invalid_name" };

  try {
    const envelope = parseEnvelope(await bridge.remove(name));
    if (!envelope) return { ok: false, error: "invalid_response" };
    if (envelope.ok !== true) return { ok: false, error: errorCode(envelope.error, "delete_failed") };
    return { ok: true };
  } catch {
    return { ok: false, error: "delete_failed" };
  }
}

/**
 * Abre el selector del sistema y devuelve el archivo elegido ya ensamblado.
 *
 * El shell no puede devolver un archivo por el puente JavascriptInterface:
 * copia el elegido a su caché privada y avisa con `palmyra-backup-imported`.
 * Aquí se sondea `pendingInfo` hasta que aparece (o hasta 5 minutos), se lee
 * por trozos de 512 KB y se limpia siempre el temporal al terminar.
 */
export async function pickBackupFromDevice(): Promise<AndroidBackupPickResult> {
  const bridge = getAndroidBackupBridge();
  if (!bridge) return { ok: false, error: "unavailable" };

  const cancel = watchImportCancellation();
  try {
    // Un temporal de una elección anterior no debe confundirse con la nueva.
    await clearPendingQuietly(bridge);
    try {
      await bridge.openPicker();
    } catch {
      return { ok: false, error: "picker_failed" };
    }

    const pending = await waitForPending(bridge, cancel);
    if (pending.ok !== true) return { ok: false, error: pending.error };

    const assembled = await readPendingBytes(bridge, pending.bytes);
    if (assembled.ok !== true) return { ok: false, error: assembled.error };
    return { ok: true, bytes: assembled.bytes, name: pending.name };
  } finally {
    cancel.dispose();
    await clearPendingQuietly(bridge);
  }
}

// ---------------------------------------------------------------------------
// Sondeo del archivo importado
// ---------------------------------------------------------------------------

type PendingInfo =
  | { ok: true; name: string; bytes: number }
  | { ok: false; error: string };

type PendingBytes =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

async function waitForPending(
  bridge: AndroidBackupBridge,
  cancel: { error: () => string | null }
): Promise<PendingInfo> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    let envelope: Record<string, unknown> | null;
    try {
      envelope = parseEnvelope(await bridge.pendingInfo());
    } catch {
      envelope = null;
    }
    if (envelope && envelope.ok === true) {
      const name =
        typeof envelope.name === "string" && envelope.name.length > 0
          ? envelope.name
          : "respaldo.bin";
      const size = Number(envelope.bytes);
      if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "invalid_response" };
      if (size > MAX_BACKUP_BYTES) return { ok: false, error: "too_large" };
      return { ok: true, name, bytes: Math.floor(size) };
    }
    // "no_pending" es la respuesta normal mientras el usuario elige el archivo.
    const code = envelope ? errorCode(envelope.error, "") : "";
    if (code && code !== "no_pending") return { ok: false, error: code };
    const canceled = cancel.error();
    if (canceled) return { ok: false, error: canceled };
    if (Date.now() >= deadline) return { ok: false, error: "timeout" };
    await delay(POLL_INTERVAL_MS);
  }
}

async function readPendingBytes(
  bridge: AndroidBackupBridge,
  totalBytes: number
): Promise<PendingBytes> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < totalBytes) {
    const length = Math.min(READ_CHUNK_BYTES, totalBytes - offset);
    let envelope: Record<string, unknown> | null;
    try {
      envelope = parseEnvelope(await bridge.readPending(offset, length));
    } catch {
      return { ok: false, error: "read_failed" };
    }
    if (!envelope) return { ok: false, error: "invalid_response" };
    if (envelope.ok !== true) return { ok: false, error: errorCode(envelope.error, "read_failed") };
    if (typeof envelope.dataBase64 !== "string") return { ok: false, error: "invalid_response" };
    // Cada trozo se decodifica por separado: su Base64 puede llevar relleno.
    let chunk: Uint8Array;
    try {
      chunk = fromBase64(envelope.dataBase64);
    } catch {
      return { ok: false, error: "invalid_response" };
    }
    if (chunk.length === 0) return { ok: false, error: "incomplete" };
    chunks.push(chunk);
    offset += chunk.length;
    if (envelope.eof === true && offset < totalBytes) return { ok: false, error: "incomplete" };
  }

  const bytes = new Uint8Array(totalBytes);
  let written = 0;
  for (const chunk of chunks) {
    if (written + chunk.length > totalBytes) return { ok: false, error: "incomplete" };
    bytes.set(chunk, written);
    written += chunk.length;
  }
  if (written !== totalBytes) return { ok: false, error: "incomplete" };
  return { ok: true, bytes };
}

/** Escucha el aviso de cancelación del shell para no esperar los 5 minutos. */
function watchImportCancellation(): { error: () => string | null; dispose: () => void } {
  let failure: string | null = null;
  const target = typeof window === "undefined" ? null : window;
  if (
    !target ||
    typeof target.addEventListener !== "function" ||
    typeof target.removeEventListener !== "function"
  ) {
    return { error: () => failure, dispose: () => undefined };
  }
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<AndroidBackupImportedDetail>).detail;
    if (detail && detail.ok === false && !failure) {
      failure = errorCode(detail.error, "cancelled");
    }
  };
  target.addEventListener(ANDROID_BACKUP_IMPORTED_EVENT, listener as EventListener);
  return {
    error: () => failure,
    dispose: () => {
      try {
        target.removeEventListener(ANDROID_BACKUP_IMPORTED_EVENT, listener as EventListener);
      } catch {
        // La limpieza del oyente nunca debe romper la restauración.
      }
    }
  };
}

async function clearPendingQuietly(bridge: AndroidBackupBridge): Promise<void> {
  try {
    await bridge.clearPending();
  } catch {
    // Sin temporal que borrar el puente responde igualmente ok.
  }
}

function parseEnvelope(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ENVELOPE_CHARS) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
