import { pruneBackups, type BackupRetentionPlan } from "./retention";

/**
 * Metadatos de los respaldos creados en este equipo.
 *
 * Los archivos cifrados los guarda el usuario donde quiera; aquí solo se
 * conserva la ficha (fecha, tamaño, conteos y hash) para la lista de la
 * interfaz y para aplicar la retención 7+4. Vive en IndexedDB
 * `palmyra-backups-v1`; si IndexedDB no está disponible (pruebas, modo privado
 * antiguo) se usa un mapa en memoria de la sesión sin romper la app.
 */

export const BACKUP_META_DB = "palmyra-backups-v1";
export const BACKUP_META_STORE = "backups";

const MAX_MEMORY_ENTRIES = 50;

export interface BackupEntry {
  id: string;
  createdAt: string;
  sizeBytes: number;
  schemaVersion: number;
  latestSeq: number;
  totalRows: number;
  counts: Record<string, number>;
  hash: string;
  fileName: string;
  origin: "manual" | "automatic";
  encrypted: true;
}

export interface BackupMetaStore {
  readonly kind: "indexeddb" | "memory";
  list(): Promise<BackupEntry[]>;
  save(entry: BackupEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface BackupMetaStoreOptions {
  factory?: IDBFactory;
  dbName?: string;
}

const memoryFallback = new Map<string, BackupEntry>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : -1;
}

/**
 * Normaliza una ficha leída del almacén. Devuelve null si le falta lo esencial:
 * una entrada corrupta no puede aparecer en la lista ni ocupar un cupo.
 */
export function sanitizeBackupEntry(raw: unknown): BackupEntry | null {
  if (!isPlainRecord(raw)) return null;
  const candidate = raw as Partial<BackupEntry>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 120) {
    return null;
  }
  if (typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt))) {
    return null;
  }
  const sizeBytes = finiteCount(candidate.sizeBytes);
  const schemaVersion = finiteCount(candidate.schemaVersion);
  const latestSeq = finiteCount(candidate.latestSeq);
  const totalRows = finiteCount(candidate.totalRows);
  if (sizeBytes < 0 || schemaVersion < 0 || latestSeq < 0 || totalRows < 0) return null;
  if (typeof candidate.hash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.hash)) return null;

  const counts: Record<string, number> = {};
  if (isPlainRecord(candidate.counts)) {
    let keys = 0;
    for (const [table, value] of Object.entries(candidate.counts)) {
      if (keys >= 64) break;
      const count = finiteCount(value);
      if (count < 0) continue;
      counts[table.slice(0, 80)] = count;
      keys += 1;
    }
  }

  return {
    id: candidate.id,
    createdAt: candidate.createdAt,
    sizeBytes,
    schemaVersion,
    latestSeq,
    totalRows,
    counts,
    hash: candidate.hash,
    fileName: typeof candidate.fileName === "string" ? candidate.fileName.slice(0, 160) : "",
    origin: candidate.origin === "automatic" ? "automatic" : "manual",
    encrypted: true
  };
}

function sortNewestFirst(entries: BackupEntry[]): BackupEntry[] {
  return entries
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
}

/** Identificador estable y legible: bk-AAAAMMDD-HHmmss-random. */
export function newBackupId(now: Date | number = new Date()): string {
  const ms = now instanceof Date ? now.getTime() : now;
  const stamp = new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let suffix = "";
  try {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    suffix = Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return `bk-${stamp}-${suffix}`;
}

function memoryStore(): BackupMetaStore {
  return {
    kind: "memory",
    async list() {
      return sortNewestFirst(Array.from(memoryFallback.values()));
    },
    async save(entry) {
      memoryFallback.set(entry.id, entry);
      while (memoryFallback.size > MAX_MEMORY_ENTRIES) {
        const oldest = oldestMemoryId();
        if (!oldest) break;
        memoryFallback.delete(oldest);
      }
    },
    async delete(id) {
      memoryFallback.delete(id);
    }
  };
}

function oldestMemoryId(): string | null {
  let oldestId: string | null = null;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const [id, entry] of memoryFallback) {
    const ms = Date.parse(entry.createdAt);
    if (Number.isFinite(ms) && ms < oldestMs) {
      oldestMs = ms;
      oldestId = id;
    }
  }
  return oldestId;
}

/**
 * Almacén IndexedDB con un object store `backups` (clave `id`). Si la apertura
 * falla se degrada a memoria: la lista se pierde al cerrar, nunca la app.
 */
export function createBackupMetaStore(options: BackupMetaStoreOptions = {}): BackupMetaStore {
  const factory = options.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!factory) return memoryStore();

  const dbName = options.dbName ?? BACKUP_META_DB;
  let opening: Promise<IDBDatabase | null> | null = null;

  function ready(): Promise<IDBDatabase | null> {
    if (opening) return opening;
    opening = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(dbName, 1);
      } catch {
        opening = null;
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BACKUP_META_STORE)) {
          const store = db.createObjectStore(BACKUP_META_STORE, { keyPath: "id" });
          store.createIndex("idx_created_at", "createdAt", { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        opening = null;
        resolve(null);
      };
      request.onblocked = () => {
        opening = null;
        resolve(null);
      };
    });
    return opening;
  }

  async function list(): Promise<BackupEntry[]> {
    const db = await ready();
    if (!db || !db.objectStoreNames.contains(BACKUP_META_STORE)) {
      return memoryStore().list();
    }
    return new Promise<BackupEntry[]>((resolve) => {
      try {
        const tx = db.transaction(BACKUP_META_STORE, "readonly");
        const request = tx.objectStore(BACKUP_META_STORE).getAll();
        request.onsuccess = () => {
          const rows = Array.isArray(request.result) ? request.result : [];
          const entries = rows
            .map((row) => sanitizeBackupEntry(row))
            .filter((entry): entry is BackupEntry => entry !== null);
          resolve(sortNewestFirst(entries));
        };
        request.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async function mutate(entry: BackupEntry | null, removeId: string | null): Promise<void> {
    const db = await ready();
    if (!db || !db.objectStoreNames.contains(BACKUP_META_STORE)) {
      const fallback = memoryStore();
      if (entry) await fallback.save(entry);
      if (removeId) await fallback.delete(removeId);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(BACKUP_META_STORE, "readwrite");
        const store = tx.objectStore(BACKUP_META_STORE);
        if (removeId) store.delete(removeId);
        if (entry) store.put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Error escribiendo metadatos de respaldo"));
        tx.onabort = () => reject(tx.error ?? new Error("Escritura de metadatos abortada"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Error escribiendo metadatos de respaldo"));
      }
    });
  }

  return {
    kind: "indexeddb",
    list,
    async save(entry) {
      await mutate(entry, null);
    },
    async delete(id) {
      await mutate(null, id);
    }
  };
}

let defaultStore: BackupMetaStore | null = null;

/** Almacén por defecto de la sesión (IndexedDB o memoria). */
export function getBackupMetaStore(options: BackupMetaStoreOptions = {}): BackupMetaStore {
  if (!defaultStore) defaultStore = createBackupMetaStore(options);
  return defaultStore;
}

/** Solo para pruebas: permite inyectar un almacén limpio. */
export function setBackupMetaStore(store: BackupMetaStore | null): void {
  defaultStore = store;
}

/** Lista las fichas guardadas, de la más reciente a la más antigua. */
export async function listBackups(options: BackupMetaStoreOptions = {}): Promise<BackupEntry[]> {
  try {
    return await getBackupMetaStore(options).list();
  } catch {
    return [];
  }
}

/** Guarda (o reemplaza) la ficha de un respaldo. Valida antes de escribir. */
export async function saveBackupMeta(
  entry: BackupEntry,
  options: BackupMetaStoreOptions = {}
): Promise<BackupEntry> {
  const clean = sanitizeBackupEntry(entry);
  if (!clean) throw new Error("La ficha del respaldo no es válida.");
  await getBackupMetaStore(options).save(clean);
  return clean;
}

/** Borra la ficha de un respaldo. Idempotente y silenciosa ante fallos. */
export async function deleteBackupMeta(
  id: string,
  options: BackupMetaStoreOptions = {}
): Promise<void> {
  if (typeof id !== "string" || id.length === 0) return;
  try {
    await getBackupMetaStore(options).delete(id);
  } catch {
    // La retención es bookkeeping: un fallo no bloquea al usuario.
  }
}

/**
 * Aplica la retención 7 diarios + 4 semanales a las fichas guardadas y
 * devuelve el plan ejecutado.
 */
export async function pruneBackupMetadata(
  now: Date | string | number = new Date(),
  options: BackupMetaStoreOptions = {}
): Promise<BackupRetentionPlan<BackupEntry>> {
  const entries = await listBackups(options);
  const plan = pruneBackups(entries, now);
  for (const stale of plan.remove) {
    await deleteBackupMeta(stale.id, options);
  }
  return plan;
}
