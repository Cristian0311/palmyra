/**
 * Respaldo programado del almacén local en Android.
 *
 * La tablet debe respaldarse sola, sin PC ni intervención: cada 24 h se crea el
 * sobre cifrado, se guarda en Descargas del dispositivo y se rotan los archivos
 * viejos. La decisión y la rotación son puras y reciben el reloj, para poder
 * probarlas sin esperar un día; la ejecución recibe crear/guardar/listar/borrar
 * porque en el APK viven detrás del puente nativo.
 *
 * Ninguna función lanza: un fallo se devuelve en `error` para que el runtime
 * montado en la app nunca se caiga por un respaldo fallido.
 */

/** Cadencia real de creación. Comprobar más a menudo no crea respaldos extra. */
export const SCHEDULED_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Archivos que se conservan en Descargas (el más reciente manda). */
export const ANDROID_BACKUP_KEEP_LIMIT = 7;

/** Único patrón que el shell lista y que la retención puede borrar. */
export const ANDROID_BACKUP_FILE_PATTERN = /^palmyra-backup-[\w.-]+\.bin$/i;

export type ScheduledBackupReason = "no-backup" | "stale" | "fresh";

export interface ScheduledBackupDecision {
  due: boolean;
  reason: ScheduledBackupReason;
}

export type BackupTimeInput = string | number | Date | null | undefined;

export interface DecideScheduledBackupInput {
  lastBackupAt?: BackupTimeInput;
  now?: BackupTimeInput;
  intervalMs?: number;
}

export interface ScheduledBackupFile {
  name: string;
  bytes?: number;
  savedAt?: string | null;
}

export interface ScheduledBackupListing {
  ok: boolean;
  backups: ScheduledBackupFile[];
  error?: string;
}

export interface ScheduledBackupCreated {
  bytes: Uint8Array;
  summary: { fileName: string };
}

export interface ScheduledBackupDeps {
  /** Fecha del último respaldo correcto; admite función para leer el valor vigente. */
  lastBackupAt?: BackupTimeInput | (() => BackupTimeInput);
  now?: () => BackupTimeInput;
  intervalMs?: number;
  create: () => Promise<ScheduledBackupCreated>;
  save: (bytes: Uint8Array, fileName: string) => Promise<{ ok: boolean; error?: string }>;
  list: () => Promise<ScheduledBackupListing>;
  remove: (name: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface ScheduledBackupResult {
  ran: boolean;
  reason: ScheduledBackupReason;
  fileName?: string;
  removed: string[];
  error?: string;
}

function toMs(value: BackupTimeInput): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) return Date.parse(value);
  return NaN;
}

function normalizeInterval(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return SCHEDULED_BACKUP_INTERVAL_MS;
  }
  return Math.max(60_000, Math.trunc(value));
}

function describeError(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim().length > 0) return error.trim().slice(0, 200);
  if (error instanceof Error && error.message) return error.message.slice(0, 200);
  return fallback;
}

/**
 * Decide si toca respaldar.
 *
 * Un `lastBackupAt` inválido o vacío se trata como «nunca se respaldó». Una
 * fecha futura (reloj adelantado o zona mal ajustada) también obliga a
 * respaldar: esperar a que el reloj alcance esa marca podría posponer el
 * respaldo durante días.
 */
export function decideScheduledBackup(
  input: DecideScheduledBackupInput = {}
): ScheduledBackupDecision {
  const nowCandidate = toMs(input.now);
  const nowMs = Number.isFinite(nowCandidate) ? nowCandidate : Date.now();
  const interval = normalizeInterval(input.intervalMs);
  const lastMs = toMs(input.lastBackupAt);

  if (!Number.isFinite(lastMs)) return { due: true, reason: "no-backup" };
  if (lastMs > nowMs) return { due: true, reason: "stale" };
  if (nowMs - lastMs >= interval) return { due: true, reason: "stale" };
  return { due: false, reason: "fresh" };
}

/**
 * Nombres a borrar para conservar los `limit` archivos más recientes.
 *
 * No se reutiliza `pruneBackups` del hub porque su política es otra (un archivo
 * por día de los últimos 7 días y uno por semana de las últimas 4); en Descargas
 * manda el listado nativo, que solo puede ordenar por fecha y nombre: se
 * conservan los 7 archivos más recientes, sin agrupar por día.
 *
 * `keepName` es el archivo recién guardado: siempre queda primero y jamás entra
 * en la lista de borrado, aunque el sistema no le dé `savedAt`.
 */
export function selectBackupsToRemove(
  backups: ScheduledBackupFile[],
  keepName?: string | null,
  limit: number = ANDROID_BACKUP_KEEP_LIMIT
): string[] {
  const protectedName = typeof keepName === "string" && keepName ? keepName : "";
  const max = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : ANDROID_BACKUP_KEEP_LIMIT;

  // Los archivos ajenos al patrón (fotos, otros documentos en Descargas) no se
  // tocan nunca: solo el respaldo de PALMYRA entra en la rotación.
  const candidates = (Array.isArray(backups) ? backups : [])
    .filter(
      (item): item is ScheduledBackupFile =>
        !!item && typeof item.name === "string" && ANDROID_BACKUP_FILE_PATTERN.test(item.name)
    )
    .map((item) => ({ name: item.name, at: toMs(item.savedAt) }));

  candidates.sort((a, b) => {
    if (a.name === protectedName && b.name !== protectedName) return -1;
    if (b.name === protectedName && a.name !== protectedName) return 1;
    const aHas = Number.isFinite(a.at);
    const bHas = Number.isFinite(b.at);
    if (aHas && bHas && a.at !== b.at) return b.at - a.at;
    if (aHas !== bHas) return aHas ? -1 : 1;
    // El sello YYYYMMDD-HHMMSS del nombre ordena igual que el tiempo.
    return b.name.localeCompare(a.name);
  });

  return candidates
    .slice(max)
    .map((item) => item.name)
    .filter((name) => name !== protectedName);
}

function safeFileName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  // Un nombre con separadores de ruta escribiría fuera de Descargas.
  if (!name || name.length > 96 || /[\\/\u0000]/.test(name) || name.startsWith(".")) return "";
  return name;
}

/**
 * Ejecuta un ciclo completo: decide, crea, guarda y rota.
 *
 * Si el guardado falla no se toca la retención: los respaldos anteriores siguen
 * siendo la única copia y borrar alguno dejaría al equipo sin red.
 */
export async function runScheduledBackup(
  deps: ScheduledBackupDeps
): Promise<ScheduledBackupResult> {
  const removed: string[] = [];
  let decision: ScheduledBackupDecision = { due: false, reason: "fresh" };

  try {
    const lastBackupAt =
      typeof deps.lastBackupAt === "function" ? deps.lastBackupAt() : deps.lastBackupAt;
    const now = typeof deps.now === "function" ? deps.now() : new Date();
    decision = decideScheduledBackup({ lastBackupAt, now, intervalMs: deps.intervalMs });
  } catch {
    // Sin decisión fiable se respalda: es la opción que nunca pierde datos.
    decision = { due: true, reason: "no-backup" };
  }

  if (!decision.due) return { ran: false, reason: decision.reason, removed };

  let created: ScheduledBackupCreated | null = null;
  try {
    created = await deps.create();
  } catch (error) {
    return {
      ran: false,
      reason: decision.reason,
      removed,
      error: describeError(error, "No se pudo crear el respaldo.")
    };
  }

  const fileName = safeFileName(created?.summary?.fileName);
  const bytes = created?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || !fileName) {
    return {
      ran: false,
      reason: decision.reason,
      removed,
      error: "El respaldo creado llegó vacío o sin nombre válido."
    };
  }

  try {
    const saved = await deps.save(bytes, fileName);
    if (!saved || saved.ok !== true) {
      return {
        ran: false,
        reason: decision.reason,
        fileName,
        removed,
        error: describeError(saved?.error, "No se pudo guardar el respaldo en el dispositivo.")
      };
    }
  } catch (error) {
    return {
      ran: false,
      reason: decision.reason,
      fileName,
      removed,
      error: describeError(error, "No se pudo guardar el respaldo en el dispositivo.")
    };
  }

  let retentionError: string | undefined;
  try {
    const listing = await deps.list();
    if (!listing || listing.ok !== true) {
      retentionError = describeError(listing?.error, "No se pudo revisar la retención.");
    } else {
      for (const name of selectBackupsToRemove(listing.backups, fileName)) {
        try {
          const result = await deps.remove(name);
          if (result && result.ok === true) removed.push(name);
          else if (!retentionError) {
            retentionError = describeError(result?.error, "No se pudo borrar un respaldo antiguo.");
          }
        } catch (error) {
          if (!retentionError) {
            retentionError = describeError(error, "No se pudo borrar un respaldo antiguo.");
          }
        }
      }
    }
  } catch (error) {
    retentionError = describeError(error, "No se pudo revisar la retención.");
  }

  return {
    ran: true,
    reason: decision.reason,
    fileName,
    removed,
    ...(retentionError ? { error: retentionError } : {})
  };
}
