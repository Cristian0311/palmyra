import { useCallback, useEffect, useState } from "react";
import {
  isAndroidBackupAvailable,
  listDeviceBackups,
  removeDeviceBackup,
  saveBackupToDevice
} from "../services/localDb/backup/android";
import { createBackupResult } from "../services/localDb/backup/backup";
import { toBase64 } from "../services/localDb/backup/format";
import {
  runScheduledBackup,
  type ScheduledBackupResult
} from "../services/localDb/backup/schedule";
import { getRuntimeDriver } from "../services/localDb/runtimeDriver";

/**
 * Respaldo automático del almacén local en el APK Android.
 *
 * La tablet debe respaldarse sola: se comprueba cada 30 min si pasaron 24 h
 * desde el último respaldo correcto. Comprobar a menudo no crea archivos extra
 * y hace que un respaldo perdido (tablet apagada, app cerrada) se recupere en
 * la siguiente comprobación en lugar de esperar a una hora fija.
 *
 * Fuera de Android el hook no arranca ni toca `localStorage`.
 */

/** Estado visible del respaldo automático (sin secretos). */
export interface AndroidBackupStatus {
  /** Fecha ISO del último respaldo guardado correctamente. */
  lastBackupAt: string | null;
  fileName: string | null;
  location: string | null;
  error: string | null;
  /** Último intento real (con o sin éxito). */
  attemptAt: string | null;
}

export interface AndroidBackupController {
  available: boolean;
  status: AndroidBackupStatus;
  running: boolean;
  backupNow: () => Promise<void>;
}

export const ANDROID_BACKUP_STATUS_KEY = "palmyra-android-backup-status";

/**
 * Clave de cifrado de los respaldos automáticos.
 *
 * Nadie escribe una frase cada día en una tablet, así que el respaldo se cifra
 * con una clave aleatoria que se genera una vez y queda en este dispositivo.
 * Es la única forma de que el respaldo funcione sin intervención; el coste es
 * que el archivo solo se abre donde esté esta clave (se muestra en
 * Configuración para que el dueño pueda guardarla aparte).
 */
const ANDROID_BACKUP_KEY = "palmyra-android-backup-key";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const PASSPHRASE_BYTES = 24;
/** Tras un fallo automático no se reintenta en cada comprobación: gastaría batería. */
const FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;

const EMPTY_STATUS: AndroidBackupStatus = {
  lastBackupAt: null,
  fileName: null,
  location: null,
  error: null,
  attemptAt: null
};

/** Códigos del puente nativo traducidos a algo accionable para el cajero. */
const ERROR_LABELS: Record<string, string> = {
  unavailable: "Este dispositivo no permite guardar respaldos en Descargas.",
  empty_data: "El respaldo salió vacío. Vuelve a intentarlo.",
  too_large: "El respaldo supera el límite de 64 MB.",
  save_failed: "No se pudo escribir el respaldo en Descargas.",
  list_failed: "No se pudo leer la lista de respaldos.",
  delete_failed: "No se pudo borrar un respaldo antiguo.",
  invalid_response: "El almacenamiento del dispositivo respondió algo inesperado."
};

function describeError(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return ERROR_LABELS[value.trim()] || value.trim().slice(0, 200);
  }
  if (value instanceof Error && value.message) return value.message.slice(0, 200);
  return fallback;
}

/** Nombre del respaldo en Descargas: el listado nativo filtra por este patrón. */
function deviceBackupName(createdAt: string): string {
  const date = new Date(createdAt);
  const at = Number.isNaN(date.getTime()) ? new Date() : date;
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `palmyra-backup-${stamp}.bin`;
}

function readPassphrase(): string | null {
  try {
    const stored = window.localStorage.getItem(ANDROID_BACKUP_KEY);
    return stored && stored.length >= 16 ? stored : null;
  } catch {
    return null;
  }
}

function ensurePassphrase(): string {
  const stored = readPassphrase();
  if (stored) return stored;
  const bytes = new Uint8Array(PASSPHRASE_BYTES);
  crypto.getRandomValues(bytes);
  const value = toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    window.localStorage.setItem(ANDROID_BACKUP_KEY, value);
  } catch {
    // Sin localStorage la clave vale para esta sesión; el respaldo igual se crea.
  }
  return value;
}

/**
 * Clave con la que se cifran los respaldos automáticos, para que el dueño pueda
 * anotarla y abrir los archivos en otro equipo. `null` fuera de Android.
 */
export function getAndroidBackupRecoveryKey(): string | null {
  if (!isAndroidBackupAvailable()) return null;
  return readPassphrase();
}

function readStatus(): AndroidBackupStatus {
  try {
    const raw = window.localStorage.getItem(ANDROID_BACKUP_STATUS_KEY);
    if (!raw) return EMPTY_STATUS;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY_STATUS;
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 && value.length <= 300 ? value : null;
    return {
      lastBackupAt: text(parsed.lastBackupAt),
      fileName: text(parsed.fileName),
      location: text(parsed.location),
      error: text(parsed.error),
      attemptAt: text(parsed.attemptAt)
    };
  } catch {
    return EMPTY_STATUS;
  }
}

function writeStatus(status: AndroidBackupStatus): void {
  try {
    window.localStorage.setItem(ANDROID_BACKUP_STATUS_KEY, JSON.stringify(status));
  } catch {
    // Un almacenamiento lleno no debe interrumpir el respaldo ya guardado.
  }
}

// ── Ejecución única compartida ───────────────────────────────────────────────
// El runtime y la tarjeta pueden montar el hook a la vez: el candado y los
// oyentes viven en el módulo para que nunca corran dos respaldos en paralelo.
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Un oyente caído no debe romper el ciclo de respaldo.
    }
  }
}

/**
 * ¿Hay que esperar antes de reintentar solo?
 *
 * Solo se aplica cuando el último intento no dejó respaldo (falló); un error de
 * retención sobre un respaldo ya guardado no bloquea el siguiente ciclo. El
 * botón «Reintentar» / «Respaldar ahora» siempre salta esta espera.
 */
function shouldWaitAfterFailure(status: AndroidBackupStatus): boolean {
  if (!status.error || !status.attemptAt) return false;
  const attemptMs = Date.parse(status.attemptAt);
  if (!Number.isFinite(attemptMs)) return false;
  const lastMs = status.lastBackupAt ? Date.parse(status.lastBackupAt) : NaN;
  if (Number.isFinite(lastMs) && lastMs >= attemptMs) return false;
  const elapsed = Date.now() - attemptMs;
  return elapsed >= 0 && elapsed < FAILURE_RETRY_MS;
}

async function execute(force: boolean): Promise<void> {
  const previous = readStatus();
  const startedAt = new Date().toISOString();
  // Se rellenan dentro de los callbacks de `deps`; un objeto evita que el
  // analizador de tipos los trate como `null` fijo.
  const captured: { createdAt: string | null; location: string | null } = {
    createdAt: null,
    location: null
  };

  if (!force && shouldWaitAfterFailure(previous)) return;

  let result: ScheduledBackupResult;
  try {
    result = await runScheduledBackup({
      lastBackupAt: force ? null : previous.lastBackupAt,
      create: async () => {
        const driver = await getRuntimeDriver();
        const backup = await createBackupResult({
          driver,
          passphrase: ensurePassphrase(),
          meta: { origen: "android-automatico", superficie: "android-app" }
        });
        captured.createdAt = backup.summary.createdAt;
        // El nombre del resumen es el de la descarga del navegador; en Descargas
        // manda el patrón que lista el shell.
        return { bytes: backup.bytes, summary: { fileName: deviceBackupName(backup.summary.createdAt) } };
      },
      save: async (bytes, fileName) => {
        const saved = await saveBackupToDevice(bytes, fileName);
        if (saved.ok && saved.location) captured.location = saved.location;
        return { ok: saved.ok, ...(saved.error ? { error: saved.error } : {}) };
      },
      list: async () => {
        const listing = await listDeviceBackups();
        return {
          ok: listing.ok,
          backups: listing.backups,
          ...(listing.error ? { error: listing.error } : {})
        };
      },
      remove: async (name) => {
        const removal = await removeDeviceBackup(name);
        return { ok: removal.ok, ...(removal.error ? { error: removal.error } : {}) };
      }
    });
  } catch (error) {
    result = {
      ran: false,
      reason: "stale",
      removed: [],
      error: describeError(error, "No se pudo completar el respaldo automático.")
    };
  }

  const attempted = result.ran || Boolean(result.error);
  if (!attempted) return;

  const next: AndroidBackupStatus = {
    lastBackupAt: result.ran ? captured.createdAt || startedAt : previous.lastBackupAt,
    fileName: result.ran ? result.fileName || previous.fileName : previous.fileName,
    location: result.ran ? captured.location || previous.location : previous.location,
    error: result.error ? describeError(result.error, "No se pudo completar el respaldo automático.") : null,
    attemptAt: startedAt
  };
  writeStatus(next);
}

function runOnce(force: boolean): Promise<void> {
  if (!isAndroidBackupAvailable()) return Promise.resolve();
  if (inFlight) return inFlight;
  const task = execute(force).finally(() => {
    inFlight = null;
    emit();
  });
  inFlight = task;
  emit();
  return task;
}

export function useAndroidBackup(): AndroidBackupController {
  const [available] = useState(() => isAndroidBackupAvailable());
  const [status, setStatus] = useState<AndroidBackupStatus>(EMPTY_STATUS);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!available) return;
    const sync = () => {
      setStatus(readStatus());
      setRunning(inFlight !== null);
    };
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, [available]);

  useEffect(() => {
    if (!available) return;
    void runOnce(false);
    const timer = window.setInterval(() => void runOnce(false), CHECK_INTERVAL_MS);
    const onVisibility = () => {
      // La tablet puede estar días suspendida: al volver se reintenta ya.
      if (document.visibilityState === "visible") void runOnce(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [available]);

  const backupNow = useCallback(async () => {
    await runOnce(true);
  }, []);

  return { available, status, running, backupNow };
}
