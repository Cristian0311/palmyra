/**
 * Persistencia en disco de los respaldos del hub (solo Node).
 *
 * La cripto y la serialización viven en `backup.ts` (WebCrypto puro); aquí solo
 * hay carpeta, clave y rotación. Nada de este módulo entra en el bundle web: es
 * el proceso principal del escritorio o el hub de escritorio quien lo usa.
 *
 * Disposición en disco:
 *   <dir>/hub-backup.key             clave base64url, 0600, carpeta 0700
 *   <dir>/backups/palmyra-AAAA-MM-DD.pbak    un archivo por día (7 últimos)
 *   <dir>/backups/weekly-AAAA-Wss.pbak       copia semanal ISO (4 últimas)
 *
 * El IO es inyectable para poder probar la rotación sin tocar el disco real.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
  HubBackupError,
  createBackupKey,
  importBackupKey,
  type BackupEnvelope
} from "./backup";

export const BACKUP_KEY_FILE = "hub-backup.key";
export const BACKUPS_DIR_NAME = "backups";
/** 32 bytes en base64url (43 caracteres) más el salto de línea. */
export const BACKUP_KEY_FILE_BYTES = 44;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DAILY_KEEP = 7;
const WEEKLY_KEEP = 4;

const DAILY_PATTERN = /^palmyra-(\d{4})-(\d{2})-(\d{2})\.pbak$/;
const WEEKLY_PATTERN = /^weekly-(\d{4})-W(\d{2})\.pbak$/;

export interface BackupStoreIo {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  unlink(path: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  writeFile(
    path: string,
    data: string,
    options?: { mode?: number; flag?: string }
  ): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readFile(path: string): Promise<string>;
}

/** Implementación real con `fs/promises`. */
export const nodeBackupIo: BackupStoreIo = {
  async readdir(dir) {
    const entries = await fsp.readdir(dir, { encoding: "utf8" });
    return entries as string[];
  },
  async stat(path) {
    const info = await fsp.stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  },
  unlink: (path) => fsp.unlink(path),
  copyFile: (from, to) => fsp.copyFile(from, to),
  mkdir: async (path, options) => {
    // `mkdir` recursivo devuelve la primera ruta creada; aquí no interesa.
    await fsp.mkdir(path, { ...(options ?? {}), recursive: options?.recursive !== false });
  },
  rename: (from, to) => fsp.rename(from, to),
  writeFile: (path, data, options) => fsp.writeFile(path, data, options),
  chmod: (path, mode) => fsp.chmod(path, mode),
  readFile: (path) => fsp.readFile(path, "utf8")
};

export interface BackupKeyHandle {
  key: CryptoKey;
  /** Ruta del archivo de clave; nunca contiene la clave. */
  path: string;
  /** true si se generó en esta llamada. */
  created: boolean;
}

export interface BackupStoreOptions {
  io?: BackupStoreIo;
  /** Reloj inyectable; por defecto la hora del sistema. */
  now?: () => string;
}

function ioOf(options: BackupStoreOptions | undefined): BackupStoreIo {
  return options?.io ?? nodeBackupIo;
}

function requireDir(dir: unknown): string {
  const value = typeof dir === "string" ? dir.trim() : "";
  if (!value) {
    throw new HubBackupError("restore_failed", "Falta la carpeta de respaldos del hub");
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "error desconocido";
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Carga la clave del hub o la crea si no existe. La clave no se reescribe
 * nunca: si el archivo existe pero no se puede importar, se aborta con un error
 * claro (regenerarla dejaría ilegibles los respaldos anteriores).
 */
export async function loadOrCreateBackupKey(
  dir: string,
  options: BackupStoreOptions = {}
): Promise<BackupKeyHandle> {
  const root = requireDir(dir);
  const io = ioOf(options);
  try {
    await io.mkdir(root, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    throw new HubBackupError(
      "restore_failed",
      `No se pudo preparar la carpeta de respaldos (${errorText(error)})`
    );
  }

  const keyPath = join(root, BACKUP_KEY_FILE);

  let raw: string | null = null;
  try {
    raw = await io.readFile(keyPath);
  } catch (error) {
    if (!isMissing(error)) {
      throw new HubBackupError(
        "restore_failed",
        `No se pudo leer la clave del respaldo (${errorText(error)})`
      );
    }
  }

  if (raw !== null && raw.trim() !== "") {
    const key = await importBackupKey(raw.trim());
    // En Windows los permisos POSIX no aplican; el intento no debe romper nada.
    try {
      await io.chmod(keyPath, FILE_MODE);
    } catch {
      // Permisos no soportados por el sistema de archivos.
    }
    return { key, path: keyPath, created: false };
  }

  const created = await createBackupKey();
  try {
    await io.writeFile(keyPath, created + "\n", { mode: FILE_MODE, flag: "wx" });
  } catch (error) {
    // Otra instancia pudo crearla entre la lectura y la escritura: se reusa.
    try {
      const existing = (await io.readFile(keyPath)).trim();
      if (existing) {
        return { key: await importBackupKey(existing), path: keyPath, created: false };
      }
    } catch {
      // Se informa el fallo original, que es el que explica el problema.
    }
    throw new HubBackupError(
      "restore_failed",
      `No se pudo crear la clave del respaldo (${errorText(error)})`
    );
  }
  try {
    await io.chmod(keyPath, FILE_MODE);
  } catch {
    // Permisos no soportados por el sistema de archivos.
  }
  return { key: await importBackupKey(created), path: keyPath, created: true };
}

export interface WriteBackupResult {
  path: string;
  fileName: string;
  bytes: number;
}

function dayStamp(moment: string): string {
  const parsed = Date.parse(moment);
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return date.toISOString().slice(0, 10);
}

/**
 * Escribe el sobre cifrado de forma atómica (tmp + rename) y con un archivo por
 * día: el respaldo del mismo día se sobrescribe.
 */
export async function writeBackupFile(
  dir: string,
  envelope: BackupEnvelope,
  options: BackupStoreOptions = {}
): Promise<WriteBackupResult> {
  const root = requireDir(dir);
  const io = ioOf(options);
  if (!envelope || envelope.format !== "palmyra-backup-v1" || !envelope.data) {
    throw new HubBackupError("invalid_format", "El respaldo no tiene un sobre válido");
  }
  const backupsDir = join(root, BACKUPS_DIR_NAME);
  try {
    await io.mkdir(backupsDir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    throw new HubBackupError(
      "restore_failed",
      `No se pudo preparar la carpeta de respaldos (${errorText(error)})`
    );
  }

  const moment = options.now ? options.now() : envelope.createdAt;
  const fileName = `palmyra-${dayStamp(moment)}.pbak`;
  const target = join(backupsDir, fileName);
  const temp = target + ".tmp";
  const text = JSON.stringify(envelope);

  try {
    await io.writeFile(temp, text, { mode: FILE_MODE });
    await io.rename(temp, target);
  } catch (error) {
    try {
      await io.unlink(temp);
    } catch {
      // El temporal pudo no llegar a crearse.
    }
    throw new HubBackupError(
      "restore_failed",
      `No se pudo escribir el respaldo (${errorText(error)})`
    );
  }

  return { path: target, fileName, bytes: new TextEncoder().encode(text).length };
}

/** Año y semana ISO-8601 de una fecha (la semana empieza el lunes). */
function isoWeek(moment: Date): { year: number; week: number } {
  const thursday = new Date(
    Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate())
  );
  const dayOfWeek = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayOfWeek);
  const year = thursday.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year, week };
}

function weekStamp(day: string): string {
  const { year, week } = isoWeek(new Date(`${day}T00:00:00.000Z`));
  return `weekly-${year}-W${String(week).padStart(2, "0")}.pbak`;
}

interface DatedFile {
  name: string;
  day: string;
}

function dailyFiles(names: string[]): DatedFile[] {
  const files: DatedFile[] = [];
  for (const name of names) {
    const match = DAILY_PATTERN.exec(name);
    if (!match) continue;
    files.push({ name, day: `${match[1]}-${match[2]}-${match[3]}` });
  }
  // Más reciente primero.
  return files.sort((left, right) => (left.day < right.day ? 1 : left.day > right.day ? -1 : 0));
}

interface WeeklyFile {
  name: string;
  year: number;
  week: number;
}

function weeklyFiles(names: string[]): WeeklyFile[] {
  const files: WeeklyFile[] = [];
  for (const name of names) {
    const match = WEEKLY_PATTERN.exec(name);
    if (!match) continue;
    files.push({ name, year: Number(match[1]), week: Number(match[2]) });
  }
  return files.sort((left, right) =>
    left.year !== right.year ? right.year - left.year : right.week - left.week
  );
}

export interface RotateBackupsResult {
  dailyKept: number;
  weeklyKept: number;
  removed: number;
}

/**
 * Rotación: 7 diarios y 4 semanales. El respaldo del día se copia a la semana
 * ISO a la que pertenece (cada pasada refresca la copia semanal con el último
 * respaldo de esa semana) y se purga lo que sobra. Los archivos ajenos al
 * patrón no se tocan.
 */
export async function rotateBackups(
  dir: string,
  options: BackupStoreOptions = {}
): Promise<RotateBackupsResult> {
  const root = requireDir(dir);
  const io = ioOf(options);
  const backupsDir = join(root, BACKUPS_DIR_NAME);

  let names: string[];
  try {
    names = await io.readdir(backupsDir);
  } catch (error) {
    if (isMissing(error)) return { dailyKept: 0, weeklyKept: 0, removed: 0 };
    throw new HubBackupError(
      "restore_failed",
      `No se pudo leer la carpeta de respaldos (${errorText(error)})`
    );
  }

  let removed = 0;
  const daily = dailyFiles(names);

  // El semanal se copia del respaldo diario más reciente con contenido.
  let source: DatedFile | null = null;
  for (const candidate of daily) {
    try {
      const info = await io.stat(join(backupsDir, candidate.name));
      if (info.size > 0) {
        source = candidate;
        break;
      }
    } catch {
      // Si no se puede medir, se usa igual: es el más reciente por nombre.
      source = candidate;
      break;
    }
  }
  if (source) {
    const weeklyName = weekStamp(source.day);
    try {
      await io.copyFile(join(backupsDir, source.name), join(backupsDir, weeklyName));
    } catch (error) {
      throw new HubBackupError(
        "restore_failed",
        `No se pudo crear la copia semanal (${errorText(error)})`
      );
    }
  }

  const dailyKeptList = daily.slice(0, DAILY_KEEP);
  for (const stale of daily.slice(DAILY_KEEP)) {
    try {
      await io.unlink(join(backupsDir, stale.name));
      removed += 1;
    } catch {
      // Un archivo ya borrado no cambia el resultado.
    }
  }

  const weeklies = weeklyFiles(await io.readdir(backupsDir));
  const weeklyKeptList = weeklies.slice(0, WEEKLY_KEEP);
  for (const stale of weeklies.slice(WEEKLY_KEEP)) {
    try {
      await io.unlink(join(backupsDir, stale.name));
      removed += 1;
    } catch {
      // Idem.
    }
  }

  return {
    dailyKept: dailyKeptList.length,
    weeklyKept: weeklyKeptList.length,
    removed
  };
}
