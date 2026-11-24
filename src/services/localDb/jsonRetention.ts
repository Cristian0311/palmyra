/**
 * Retención del JSON legado.
 *
 * Durante el corte el JSON de Zustand sigue siendo la fuente de la verdad del
 * dispositivo. Este módulo guarda un respaldo diario —como máximo uno por día,
 * sin sobrescribir el del mismo día— y elimina los que superan la retención de
 * 30 días. La clave viva del estado (`zustand` en IndexedDB o su clave de
 * recuperación) nunca se toca: aquí solo viven copias con prefijo propio.
 */
import { getPalmyraLocalScopeKey } from "../localScope";

export const LEGACY_JSON_RETENTION_DAYS = 30;
export const LEGACY_BACKUP_PREFIX = "palmyra_legacy_backup:";
/** Tope por respaldo: por encima de esto el JSON es demasiado grande para localStorage. */
export const LEGACY_BACKUP_MAX_BYTES = 1_500_000;

const DAY_MS = 86_400_000;

/** Subconjunto de Storage que necesitan la poda y la escritura. */
export interface RetentionStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PruneLegacyBackupsOptions {
  /** localStorage inyectable; `null` simula un dispositivo sin almacenamiento. */
  storage?: RetentionStorage | null;
  now?: string | number | Date;
  prefix?: string;
}

export interface WriteLegacyBackupOptions extends PruneLegacyBackupsOptions {
  maxBytes?: number;
}

export interface WriteLegacyBackupResult {
  written: boolean;
  pruned: number;
}

function resolveStorage(storage?: RetentionStorage | null): RetentionStorage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function toMs(value: string | number | Date | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** Día UTC en el formato que se codifica en la clave (`YYYY-MM-DD`). */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** La fecha siempre queda como último segmento de la clave, tras el alcance. */
function backupKey(prefix: string, day: string): string {
  let scope: string | null = null;
  try {
    scope = getPalmyraLocalScopeKey();
  } catch {
    scope = null;
  }
  return `${prefix}${scope ? scope + ":" : ""}${day}`;
}

/**
 * Borra los respaldos más antiguos que la retención. Solo mira claves con el
 * prefijo y fecha válida: la clave viva y cualquier otro dato quedan intactos.
 */
export function pruneLegacyBackups(options: PruneLegacyBackupsOptions = {}): number {
  const storage = resolveStorage(options.storage);
  if (!storage) return 0;

  const prefix = options.prefix ?? LEGACY_BACKUP_PREFIX;
  const cutoff = dayKey(toMs(options.now) - LEGACY_JSON_RETENTION_DAYS * DAY_MS);

  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const key of keys) {
    const day = key.slice(key.lastIndexOf(":") + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day >= cutoff) continue;
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // Un borrado fallido no impide seguir con el resto.
    }
  }
  return removed;
}

/**
 * Guarda el respaldo del día si aún no existe y cabe en el tope. Nunca lanza:
 * sin localStorage, sin cuota o con un JSON enorme simplemente no escribe.
 */
export function writeLegacyBackup(
  raw: string | null | undefined,
  options: WriteLegacyBackupOptions = {}
): WriteLegacyBackupResult {
  const storage = resolveStorage(options.storage);
  if (!storage) return { written: false, pruned: 0 };

  // Primero la poda: libera cuota antes de intentar el respaldo de hoy.
  const pruned = pruneLegacyBackups(options);
  if (typeof raw !== "string" || raw.length === 0) return { written: false, pruned };

  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
      ? Math.max(0, options.maxBytes)
      : LEGACY_BACKUP_MAX_BYTES;
  if (raw.length > maxBytes) return { written: false, pruned };

  const key = backupKey(options.prefix ?? LEGACY_BACKUP_PREFIX, dayKey(toMs(options.now)));
  try {
    // Un respaldo por día: el primero es el que ve el corte.
    if (storage.getItem(key) !== null) return { written: false, pruned };
    storage.setItem(key, raw);
    return { written: true, pruned };
  } catch {
    // Cuota llena: el respaldo es una red de seguridad, no bloquea el arranque.
    return { written: false, pruned };
  }
}
