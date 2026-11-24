import {
  applyQuerySpec,
  assertLocalRow,
  LocalDbError,
  nowIso
} from "./contract";
import type {
  ChangeRecord,
  LocalDbDriver,
  LocalDbTransaction,
  LocalRow,
  LocalTable,
  MutationMeta,
  QuerySpec
} from "./contract";
import { LOCAL_DB_TABLES, LOCAL_DB_VERSION } from "./schema";

/**
 * Driver IndexedDB del almacén local normalizado.
 *
 * Diseño físico: un object store por tabla (clave "id"), un journal de cambios
 * en "_changes" (clave "seq") y una meta con el último seq asignado.
 * El journal permite que el sincronizador pida solo lo nuevo con changes(since).
 */

export interface IndexedDbDriverOptions {
  factory?: IDBFactory;
  dbName?: string;
  version?: number;
}

const DEFAULT_DB_NAME = "palmyra-local-db-v1";
const CHANGES_STORE = "_changes";
const META_STORE = "_meta";
const SEQ_KEY = "seq";
const DEFAULT_CHANGES_LIMIT = 500;
const MAX_CHANGES_LIMIT = 5000;

interface SeqRecord {
  key: typeof SEQ_KEY;
  value: number;
}

/** Crea todos los stores e índices que falten durante el upgrade. */
function upgradeSchema(db: IDBDatabase): void {
  for (const schema of Object.values(LOCAL_DB_TABLES)) {
    if (db.objectStoreNames.contains(schema.name)) continue;
    const store = db.createObjectStore(schema.name, { keyPath: "id" });
    for (const fields of schema.indexes) {
      const indexName = "idx_" + fields.join("_");
      if (store.indexNames.contains(indexName)) continue;
      store.createIndex(indexName, fields.length === 1 ? fields[0] : fields.slice(), { unique: false });
    }
  }
  if (!db.objectStoreNames.contains(CHANGES_STORE)) {
    db.createObjectStore(CHANGES_STORE, { keyPath: "seq" });
  }
  if (!db.objectStoreNames.contains(META_STORE)) {
    db.createObjectStore(META_STORE, { keyPath: "key" });
  }
}

/** Valida el lote completo antes de abrir cualquier transacción. */
function assertBatch(table: LocalTable, rows: LocalRow[]): void {
  if (!Array.isArray(rows)) {
    throw new LocalDbError("invalid_row", `Lote inválido para ${table}`);
  }
  for (const row of rows) assertLocalRow(table, row);
}

function toLocalDbError(error: unknown, message: string): LocalDbError {
  if (error instanceof LocalDbError) return error;
  const detail = error instanceof Error ? error.message : String(error ?? "error desconocido");
  return new LocalDbError("transaction_failed", message + ": " + detail);
}

function clampChangesLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_CHANGES_LIMIT;
  return Math.min(MAX_CHANGES_LIMIT, Math.max(1, Math.trunc(limit)));
}

class IndexedDbDriver implements LocalDbDriver {
  readonly kind = "indexeddb" as const;

  private readonly providedFactory?: IDBFactory;
  private readonly dbName: string;
  private readonly version: number;
  private dbPromise: Promise<IDBDatabase> | null = null;
  /** Serializa escrituras y transacciones para asignar seq sin carreras. */
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;
  private seqReady = false;

  constructor(options: IndexedDbDriverOptions = {}) {
    this.providedFactory = options.factory;
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.version = options.version ?? LOCAL_DB_VERSION;
  }

  async ready(): Promise<void> {
    await this.ensureDb();
  }

  async get<T extends LocalRow>(table: LocalTable, id: string): Promise<T | null> {
    const db = await this.ensureDb();
    return this.getInternal<T>(db, table, id);
  }

  async query<T extends LocalRow>(spec: QuerySpec): Promise<T[]> {
    const db = await this.ensureDb();
    return this.queryInternal<T>(db, spec);
  }

  async put<T extends LocalRow>(table: LocalTable, rows: T[]): Promise<number> {
    // Un lote inválido no debe tocar la base: se valida antes de la transacción.
    assertBatch(table, rows);
    return this.enqueue(async () => this.putInternal(await this.ensureDb(), table, rows));
  }

  remove(table: LocalTable, ids: string[], meta: MutationMeta): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.enqueue(async () => this.removeInternal(await this.ensureDb(), table, ids, meta));
  }

  /**
   * Agrupa operaciones en una unidad serializada. El rollback atómico
   * multi-store llegará con el driver SQLite: aquí cada put/remove es su
   * propia transacción y una transacción de usuario no revierte lo anterior.
   */
  transaction<T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const db = await this.ensureDb();
      const tx: LocalDbTransaction = {
        get: <R extends LocalRow>(table: LocalTable, id: string) => this.getInternal<R>(db, table, id),
        query: <R extends LocalRow>(spec: QuerySpec) => this.queryInternal<R>(db, spec),
        put: <R extends LocalRow>(table: LocalTable, rows: R[]) => this.putInternal(db, table, rows),
        remove: (table: LocalTable, ids: string[], meta: MutationMeta) =>
          this.removeInternal(db, table, ids, meta)
      };
      return fn(tx);
    });
  }

  async changes(sinceSeq = 0, limit = DEFAULT_CHANGES_LIMIT): Promise<ChangeRecord[]> {
    const db = await this.ensureDb();
    let records: ChangeRecord[];
    try {
      records = await this.readAll<ChangeRecord>(db, CHANGES_STORE);
    } catch (error) {
      throw toLocalDbError(error, "No se pudo leer el journal de cambios");
    }
    return records
      .filter((record) => typeof record?.seq === "number" && record.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, clampChangesLimit(limit));
  }

  async latestSeq(): Promise<number> {
    const db = await this.ensureDb();
    const seq = await this.readMetaSeq(db);
    if (seq > this.seq) this.seq = seq;
    return seq;
  }

  async close(): Promise<void> {
    await this.writeChain;
    const pending = this.dbPromise;
    this.dbPromise = null;
    this.seqReady = false;
    this.seq = 0;
    if (!pending) return;
    try {
      const db = await pending;
      db.close();
    } catch {
      // Nunca llegó a abrirse o ya estaba cerrada.
    }
  }

  /** Encola la operación; un fallo no envenena las siguientes. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(() => operation(), () => operation());
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const factory =
      this.providedFactory ??
      (typeof globalThis !== "undefined" ? globalThis.indexedDB : undefined);
    if (!factory) {
      return Promise.reject(
        new LocalDbError("driver_unavailable", "IndexedDB no está disponible en este entorno")
      );
    }
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.dbName, this.version);
      } catch (error) {
        reject(toLocalDbError(error, "No se pudo abrir " + this.dbName));
        return;
      }
      request.onupgradeneeded = () => upgradeSchema(request.result);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
          this.seqReady = false;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.dbPromise = null;
        reject(toLocalDbError(request.error, "No se pudo abrir " + this.dbName));
      };
      request.onblocked = () => {
        this.dbPromise = null;
        reject(
          new LocalDbError(
            "transaction_failed",
            "La base " + this.dbName + " está bloqueada por otra pestaña"
          )
        );
      };
    });
    this.dbPromise = promise;
    return promise;
  }

  private async ensureDb(): Promise<IDBDatabase> {
    const db = await this.openDb();
    if (!this.seqReady) {
      this.seq = await this.readMetaSeq(db);
      this.seqReady = true;
    }
    return db;
  }

  private readMetaSeq(db: IDBDatabase): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let tx: IDBTransaction;
      let request: IDBRequest;
      try {
        tx = db.transaction([META_STORE], "readonly");
        request = tx.objectStore(META_STORE).get(SEQ_KEY);
      } catch (error) {
        reject(toLocalDbError(error, "No se pudo leer la meta del journal"));
        return;
      }
      let settled = false;
      const finish = (value: number) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(toLocalDbError(error, "No se pudo leer la meta del journal"));
      };
      request.onsuccess = () => {
        const record = request.result as SeqRecord | undefined;
        const value = record?.value;
        finish(typeof value === "number" && Number.isFinite(value) ? value : 0);
      };
      request.onerror = () => fail(request.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  private readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      let tx: IDBTransaction;
      let request: IDBRequest;
      try {
        tx = db.transaction([storeName], "readonly");
        request = tx.objectStore(storeName).getAll();
      } catch (error) {
        reject(toLocalDbError(error, "No se pudo leer " + storeName));
        return;
      }
      let settled = false;
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        const rows = request.result as unknown;
        resolve(Array.isArray(rows) ? (rows as T[]) : []);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(toLocalDbError(request.error, "No se pudo leer " + storeName));
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        reject(toLocalDbError(tx.error, "Lectura abortada en " + storeName));
      };
    });
  }

  private async getInternal<T extends LocalRow>(
    db: IDBDatabase,
    table: LocalTable,
    id: string
  ): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      let tx: IDBTransaction;
      let request: IDBRequest;
      try {
        tx = db.transaction([table], "readonly");
        request = tx.objectStore(table).get(id);
      } catch (error) {
        reject(toLocalDbError(error, "No se pudo leer " + table));
        return;
      }
      let settled = false;
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        resolve((request.result as T | undefined) ?? null);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(toLocalDbError(request.error, "No se pudo leer " + table));
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        reject(toLocalDbError(tx.error, "Lectura abortada en " + table));
      };
    });
  }

  private async queryInternal<T extends LocalRow>(
    db: IDBDatabase,
    spec: QuerySpec
  ): Promise<T[]> {
    let rows: LocalRow[];
    try {
      rows = await this.readAll<LocalRow>(db, spec.table);
    } catch (error) {
      // Solo los fallos de lectura se traducen a "sin resultados";
      // las filas mal formadas se propagan al aplicar el spec.
      // Se avisa en consola para no confundir un fallo real con "no hay datos".
      console.warn(`[PALMYRA] Almacén local: consulta fallida en «${spec.table}»; se devuelve vacío.`, error);
      return [];
    }
    return applyQuerySpec(rows as T[], spec);
  }

  /** Única transacción readwrite: filas + journal + meta juntos. */
  private writeTransaction(
    db: IDBDatabase,
    storeNames: string[],
    body: (tx: IDBTransaction) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeNames, "readwrite");
      } catch (error) {
        reject(toLocalDbError(error, "No se pudo abrir la transacción de escritura"));
        return;
      }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(toLocalDbError(error, "La transacción de escritura falló"));
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
      try {
        body(tx);
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // La transacción ya estaba inactiva.
        }
        fail(error);
      }
    });
  }

  private async putInternal<T extends LocalRow>(
    db: IDBDatabase,
    table: LocalTable,
    rows: T[]
  ): Promise<number> {
    assertBatch(table, rows);
    if (rows.length === 0) return 0;
    const recordedAt = nowIso();
    const records: ChangeRecord[] = [];
    let seq = this.seq;
    for (const row of rows) {
      seq += 1;
      records.push({
        seq,
        table,
        row_id: row.id,
        op: "upsert",
        company_id: row.company_id,
        updated_at: row.updated_at,
        origin_device: typeof row.origin_device === "string" ? row.origin_device : "",
        recorded_at: recordedAt
      });
    }
    await this.writeTransaction(db, [table, CHANGES_STORE, META_STORE], (tx) => {
      const data = tx.objectStore(table);
      for (const row of rows) data.put(row);
      const journal = tx.objectStore(CHANGES_STORE);
      for (const record of records) journal.put(record);
      tx.objectStore(META_STORE).put({ key: SEQ_KEY, value: seq } satisfies SeqRecord);
    });
    // Solo se avanza si la transacción confirmó.
    this.seq = seq;
    return rows.length;
  }

  private async removeInternal(
    db: IDBDatabase,
    table: LocalTable,
    ids: string[],
    meta: MutationMeta
  ): Promise<void> {
    if (ids.length === 0) return;
    const at = nowIso(meta.at);
    const recordedAt = nowIso();
    const records: ChangeRecord[] = [];
    let seq = this.seq;
    for (const id of ids) {
      seq += 1;
      records.push({
        seq,
        table,
        row_id: id,
        op: "delete",
        company_id: meta.company_id,
        updated_at: at,
        origin_device: meta.origin_device,
        recorded_at: recordedAt
      });
    }
    await this.writeTransaction(db, [table, CHANGES_STORE, META_STORE], (tx) => {
      const data = tx.objectStore(table);
      for (const id of ids) data.delete(id);
      const journal = tx.objectStore(CHANGES_STORE);
      for (const record of records) journal.put(record);
      tx.objectStore(META_STORE).put({ key: SEQ_KEY, value: seq } satisfies SeqRecord);
    });
    this.seq = seq;
  }
}

export function createIndexedDbDriver(options: IndexedDbDriverOptions = {}): LocalDbDriver {
  return new IndexedDbDriver(options);
}
