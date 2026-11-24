import {
  LocalDbError,
  applyQuerySpec,
  assertLocalRow,
  nowIso,
  type ChangeRecord,
  type LocalDbDriver,
  type LocalDbTransaction,
  type LocalRow,
  type LocalTable,
  type MutationMeta,
  type QuerySpec
} from "./contract";

interface MemoryDriverOptions {
  now?: () => string;
}

interface Snapshot {
  tables: Map<LocalTable, Map<string, LocalRow>>;
  journal: ChangeRecord[];
  seq: number;
}

const MIN_CHANGES_LIMIT = 1;
const MAX_CHANGES_LIMIT = 5000;
const DEFAULT_CHANGES_LIMIT = 500;

/**
 * Driver de referencia en memoria. Simula el journal de cambios del almacén
 * normalizado para que el resto de la capa se pruebe sin IndexedDB.
 */
export function createMemoryDriver(options: MemoryDriverOptions = {}): LocalDbDriver {
  const clock = options.now ?? (() => new Date().toISOString());

  const tables = new Map<LocalTable, Map<string, LocalRow>>();
  let journal: ChangeRecord[] = [];
  let seq = 0;
  let ready = false;
  let closed = false;
  /** Mutex: toda transacción se encola tras la anterior. */
  let queue: Promise<unknown> = Promise.resolve();

  function assertAvailable(): void {
    if (closed) {
      throw new LocalDbError("driver_unavailable", "El driver en memoria está cerrado");
    }
    if (!ready) {
      throw new LocalDbError("not_ready", "El driver en memoria aún no está listo");
    }
  }

  function tableRows(table: LocalTable): Map<string, LocalRow> {
    let rows = tables.get(table);
    if (!rows) {
      rows = new Map<string, LocalRow>();
      tables.set(table, rows);
    }
    return rows;
  }

  function appendChange(change: Omit<ChangeRecord, "seq">): void {
    seq += 1;
    journal.push({ seq, ...change });
  }

  async function get<T extends LocalRow>(table: LocalTable, id: string): Promise<T | null> {
    assertAvailable();
    const stored = tables.get(table)?.get(id);
    return stored ? ({ ...stored } as T) : null;
  }

  async function query<T extends LocalRow>(spec: QuerySpec): Promise<T[]> {
    assertAvailable();
    const rows = Array.from(tables.get(spec.table)?.values() ?? []);
    // Copia superficial: el llamador no puede alterar el almacén.
    return applyQuerySpec<LocalRow>(rows, spec).map((row) => ({ ...row })) as T[];
  }

  async function put<T extends LocalRow>(table: LocalTable, rows: T[]): Promise<number> {
    assertAvailable();
    // Validar todo el lote antes de escribir: una fila inválida aborta sin cambios.
    for (const row of rows) {
      assertLocalRow(table, row);
    }
    const target = tableRows(table);
    for (const row of rows) {
      target.set(row.id, { ...row });
      appendChange({
        table,
        row_id: row.id,
        op: "upsert",
        company_id: row.company_id,
        updated_at: row.updated_at,
        origin_device: row.origin_device,
        recorded_at: clock()
      });
    }
    return rows.length;
  }

  async function remove(table: LocalTable, ids: string[], meta: MutationMeta): Promise<void> {
    assertAvailable();
    const target = tables.get(table);
    if (!target) return;
    const at = nowIso(meta.at ?? clock());
    for (const id of ids) {
      if (!target.has(id)) continue;
      target.delete(id);
      appendChange({
        table,
        row_id: id,
        op: "delete",
        company_id: meta.company_id,
        updated_at: at,
        origin_device: meta.origin_device,
        recorded_at: at
      });
    }
  }

  function snapshotState(): Snapshot {
    const tablesCopy = new Map<LocalTable, Map<string, LocalRow>>();
    for (const [table, rows] of tables) {
      const rowsCopy = new Map<string, LocalRow>();
      for (const [id, row] of rows) rowsCopy.set(id, { ...row });
      tablesCopy.set(table, rowsCopy);
    }
    return { tables: tablesCopy, journal: journal.map((change) => ({ ...change })), seq };
  }

  function restoreState(snapshot: Snapshot): void {
    tables.clear();
    for (const [table, rows] of snapshot.tables) tables.set(table, rows);
    journal = snapshot.journal;
    seq = snapshot.seq;
  }

  async function transaction<T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T> {
    assertAvailable();
    const run = async (): Promise<T> => {
      // El driver pudo cerrarse mientras esta transacción esperaba su turno.
      assertAvailable();
      const snapshot = snapshotState();
      try {
        return await fn(tx);
      } catch (error) {
        restoreState(snapshot);
        throw error;
      }
    };
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function changes(sinceSeq = 0, limit = DEFAULT_CHANGES_LIMIT): Promise<ChangeRecord[]> {
    assertAvailable();
    const requested = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_CHANGES_LIMIT;
    const take = Math.min(MAX_CHANGES_LIMIT, Math.max(MIN_CHANGES_LIMIT, requested));
    return journal
      .filter((change) => change.seq > sinceSeq)
      .slice(0, take)
      .map((change) => ({ ...change }));
  }

  async function latestSeq(): Promise<number> {
    assertAvailable();
    return seq;
  }

  const tx: LocalDbTransaction = {
    get: (table, id) => get(table, id),
    query: (spec) => query(spec),
    put: (table, rows) => put(table, rows),
    remove: (table, ids, meta) => remove(table, ids, meta)
  };

  return {
    kind: "memory",
    async ready(): Promise<void> {
      if (closed) {
        throw new LocalDbError("driver_unavailable", "El driver en memoria está cerrado");
      }
      ready = true;
    },
    get,
    query,
    put,
    remove,
    transaction,
    changes,
    latestSeq,
    async close(): Promise<void> {
      closed = true;
      ready = false;
      tables.clear();
      journal = [];
      seq = 0;
    }
  };
}
