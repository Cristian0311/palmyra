import {
  LocalDbError,
  assertLocalRow,
  nowIso,
  type ChangeRecord,
  type LocalDbDriver,
  type LocalDbTransaction,
  type LocalRow,
  type LocalTable,
  type MutationMeta,
  type QueryFilter,
  type QuerySpec
} from "../contract";
import { LOCAL_DB_TABLES, LOCAL_DB_TABLE_NAMES, LOCAL_DB_VERSION } from "../schema";
import type { SqliteAdapter, SqlValue } from "./adapter";

/**
 * Driver SQLite del almacén local normalizado.
 *
 * Diseño físico: una tabla real por nombre lógico con las columnas comunes
 * (id, company_id, version, updated_at, origin_device, deleted_at) y `data`
 * como JSON con el resto de campos. Los índices declaran columnas reales y
 * expresiones json_extract solo para los campos que ya indexa el esquema.
 * El journal `_changes` y la meta (último seq y versión de esquema) permiten
 * sincronizar por delta sin cargar toda la base.
 */

export interface SqliteDriverOptions {
  adapter: SqliteAdapter;
  now?: () => string;
  /** Ruta del archivo; se guarda en _meta solo para diagnóstico. */
  filePath?: string;
}

const DEFAULT_CHANGES_LIMIT = 500;
const MAX_CHANGES_LIMIT = 5000;
const META_SEQ = "seq";
const META_SCHEMA_VERSION = "schema_version";
const META_FILE_PATH = "file_path";

const COMMON_COLUMNS = new Set([
  "id",
  "company_id",
  "version",
  "updated_at",
  "origin_device",
  "deleted_at"
]);

const SELECT_COLUMNS = "id, company_id, version, updated_at, origin_device, deleted_at, data";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC_OPERATORS: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

interface Clause {
  sql: string;
  params: SqlValue[];
}

interface BuiltQuery {
  sql: string;
  params: SqlValue[];
}

interface ChangeRow {
  seq: number | bigint;
  table_name: string;
  row_id: string;
  op: string;
  company_id: string | null;
  updated_at: string | null;
  origin_device: string | null;
  recorded_at: string;
}

function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new LocalDbError("invalid_row", `Identificador SQL inválido: ${name}`);
  }
  return `"${name}"`;
}

function isJsonField(field: string): boolean {
  return !COMMON_COLUMNS.has(field);
}

/** Expresión SQL de un campo: columna real o miembro de `data`. */
function fieldExpression(field: string): string {
  if (!IDENTIFIER.test(field)) {
    throw new LocalDbError("invalid_row", `Campo de consulta inválido: ${field}`);
  }
  return isJsonField(field) ? `json_extract(data, '$.${field}')` : quoteIdent(field);
}

function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function buildClause(filter: QueryFilter): Clause {
  const { field, op, value } = filter;
  const expr = fieldExpression(field);
  const json = isJsonField(field);

  switch (op) {
    case "eq":
      if (value === null) {
        return json
          ? { sql: `json_type(data, '$.${field}') = 'null'`, params: [] }
          : { sql: `${expr} IS NULL`, params: [] };
      }
      if (value === undefined) {
        return json
          ? { sql: `json_type(data, '$.${field}') IS NULL`, params: [] }
          : { sql: `${expr} IS NULL`, params: [] };
      }
      return { sql: `${expr} = ?`, params: [toSqlValue(value)] };

    case "neq":
      // Espeja matchesFilters: los campos ausentes/nulos también cuentan como distintos.
      if (value === null || value === undefined) return { sql: `${expr} IS NOT NULL`, params: [] };
      return { sql: `(${expr} IS NULL OR ${expr} <> ?)`, params: [toSqlValue(value)] };

    case "in": {
      if (!Array.isArray(value) || value.length === 0) return { sql: "0", params: [] };
      const parts = value.map((item) => buildClause({ field, op: "eq", value: item }));
      return {
        sql: "(" + parts.map((part) => part.sql).join(" OR ") + ")",
        params: parts.flatMap((part) => part.params)
      };
    }

    default: {
      const operator = NUMERIC_OPERATORS[op];
      // En memoria las comparaciones numéricas exigen dos números; un valor de
      // otro tipo no coincide con ninguna fila.
      if (!operator || typeof value !== "number" || Number.isNaN(value)) {
        return { sql: "0", params: [] };
      }
      // Un JSON almacenado como texto ("5") no debe compararse como número.
      const guard = json ? ` AND typeof(${expr}) IN ('integer','real')` : "";
      return { sql: `${expr} ${operator} ?${guard}`, params: [value] };
    }
  }
}

function limitValue(limit: number | undefined): number {
  if (limit === undefined) return -1;
  if (!Number.isFinite(limit)) return limit > 0 ? -1 : 0;
  return Math.max(0, Math.trunc(limit));
}

function offsetValue(offset: number | undefined): number {
  if (!offset || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

function buildQuerySql(spec: QuerySpec): BuiltQuery {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (!spec.includeDeleted) clauses.push("deleted_at IS NULL");
  for (const filter of spec.where ?? []) {
    const clause = buildClause(filter);
    clauses.push(clause.sql);
    params.push(...clause.params);
  }

  let sql = `SELECT ${SELECT_COLUMNS} FROM ${quoteIdent(spec.table)}`;
  if (clauses.length > 0) sql += " WHERE " + clauses.join(" AND ");

  if (spec.orderBy) {
    const direction = spec.orderBy.direction === "desc" ? "DESC" : "ASC";
    const parts = [`${fieldExpression(spec.orderBy.field)} ${direction}`];
    // compareRows invierte también el desempate por id en desc.
    if (spec.orderBy.field !== "id") parts.push(`"id" ${direction}`);
    sql += " ORDER BY " + parts.join(", ");
  }

  sql += " LIMIT " + limitValue(spec.limit);
  const offset = offsetValue(spec.offset);
  if (offset > 0) sql += " OFFSET " + offset;

  return { sql, params };
}

function serializeRow(row: LocalRow): SqlValue[] {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (COMMON_COLUMNS.has(key) || value === undefined) continue;
    data[key] = value;
  }
  return [
    row.id,
    row.company_id,
    row.version,
    row.updated_at,
    typeof row.origin_device === "string" ? row.origin_device : null,
    typeof row.deleted_at === "string" ? row.deleted_at : null,
    JSON.stringify(data)
  ];
}

function parseData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // JSON corrupto: se conservan al menos las columnas comunes.
  }
  return {};
}

function deserializeRow(raw: Record<string, unknown>): LocalRow {
  return {
    ...parseData(raw.data),
    id: String(raw.id),
    company_id: String(raw.company_id ?? ""),
    version: Number(raw.version ?? 0),
    updated_at: String(raw.updated_at ?? ""),
    origin_device: typeof raw.origin_device === "string" ? raw.origin_device : "",
    deleted_at: typeof raw.deleted_at === "string" ? raw.deleted_at : null
  };
}

function toChangeRecord(row: ChangeRow): ChangeRecord {
  return {
    seq: Number(row.seq),
    table: row.table_name as LocalTable,
    row_id: row.row_id,
    op: row.op === "delete" ? "delete" : "upsert",
    company_id: row.company_id ?? "",
    updated_at: row.updated_at ?? "",
    origin_device: row.origin_device ?? "",
    recorded_at: row.recorded_at
  };
}

function toLocalDbError(error: unknown, message: string): LocalDbError {
  if (error instanceof LocalDbError) return error;
  const detail = error instanceof Error ? error.message : String(error ?? "error desconocido");
  return new LocalDbError("transaction_failed", message + ": " + detail);
}

function assertBatch(table: LocalTable, rows: LocalRow[]): void {
  if (!Array.isArray(rows)) {
    throw new LocalDbError("invalid_row", `Lote inválido para ${table}`);
  }
  for (const row of rows) assertLocalRow(table, row);
}

function clampChangesLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_CHANGES_LIMIT;
  return Math.min(MAX_CHANGES_LIMIT, Math.max(1, Math.trunc(limit)));
}

function upsertSql(table: LocalTable): string {
  return (
    `INSERT INTO ${quoteIdent(table)} ` +
    "(id, company_id, version, updated_at, origin_device, deleted_at, data) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "company_id = excluded.company_id, version = excluded.version, " +
    "updated_at = excluded.updated_at, origin_device = excluded.origin_device, " +
    "deleted_at = excluded.deleted_at, data = excluded.data"
  );
}

/** DDL idempotente de una tabla lógica y sus índices declarados. */
function tableStatements(table: LocalTable): string[] {
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (` +
      "id TEXT PRIMARY KEY, " +
      "company_id TEXT NOT NULL, " +
      "version INTEGER NOT NULL, " +
      "updated_at TEXT NOT NULL, " +
      "origin_device TEXT, " +
      "deleted_at TEXT, " +
      "data TEXT NOT NULL)"
  ];

  const seen = new Set<string>();
  for (const fields of LOCAL_DB_TABLES[table].indexes) {
    const name = "idx_" + table + "_" + fields.join("_");
    if (seen.has(name)) continue;
    seen.add(name);
    const columns = fields.map((field) =>
      isJsonField(field) ? `json_extract(data, '$.${field}')` : quoteIdent(field)
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(table)} (${columns.join(", ")})`
    );
  }
  return statements;
}

async function migrate(adapter: SqliteAdapter, filePath?: string): Promise<void> {
  await adapter.exec("PRAGMA journal_mode = WAL");
  await adapter.exec("PRAGMA synchronous = NORMAL");
  await adapter.exec("PRAGMA busy_timeout = 5000");
  await adapter.exec("PRAGMA foreign_keys = OFF");

  const versionRows = await adapter.all<{ user_version: number }>("PRAGMA user_version");
  const current = Number(versionRows[0]?.user_version ?? 0);
  if (Number.isFinite(current) && current > LOCAL_DB_VERSION) {
    throw new LocalDbError(
      "transaction_failed",
      `La base SQLite usa el esquema ${current}, más nuevo que ${LOCAL_DB_VERSION}`
    );
  }

  await adapter.exec("BEGIN IMMEDIATE");
  try {
    await adapter.exec(
      "CREATE TABLE IF NOT EXISTS _changes (" +
        "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "table_name TEXT NOT NULL, " +
        "row_id TEXT NOT NULL, " +
        "op TEXT NOT NULL, " +
        "company_id TEXT, " +
        "updated_at TEXT, " +
        "origin_device TEXT, " +
        "recorded_at TEXT NOT NULL)"
    );
    await adapter.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");

    for (const table of LOCAL_DB_TABLE_NAMES) {
      for (const sql of tableStatements(table)) await adapter.exec(sql);
    }

    await adapter.run(
      "INSERT INTO _meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [META_SCHEMA_VERSION, String(LOCAL_DB_VERSION)]
    );
    if (filePath) {
      await adapter.run(
        "INSERT INTO _meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [META_FILE_PATH, filePath]
      );
    }

    await adapter.exec("PRAGMA user_version = " + LOCAL_DB_VERSION);
    await adapter.exec("COMMIT");
  } catch (error) {
    try {
      await adapter.exec("ROLLBACK");
    } catch {
      // La transacción ya estaba cerrada.
    }
    throw toLocalDbError(error, "No se pudo migrar el esquema SQLite");
  }
}

class SqliteDriver implements LocalDbDriver {
  readonly kind = "sqlite" as const;

  private readonly adapter: SqliteAdapter;
  private readonly clock: () => string;
  private readonly filePath?: string;
  /** Mutex: put/remove/transacciones se ejecutan en serie. */
  private queue: Promise<unknown> = Promise.resolve();
  private readyState = false;
  private closed = false;

  constructor(options: SqliteDriverOptions) {
    this.adapter = options.adapter;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.filePath = options.filePath;
  }

  async ready(): Promise<void> {
    if (this.closed) {
      throw new LocalDbError("driver_unavailable", "El driver SQLite está cerrado");
    }
    if (this.readyState) return;
    await migrate(this.adapter, this.filePath);
    this.readyState = true;
  }

  get<T extends LocalRow>(table: LocalTable, id: string): Promise<T | null> {
    return this.enqueue(() => {
      this.assertAvailable();
      return this.readRow<T>(table, id);
    });
  }

  query<T extends LocalRow>(spec: QuerySpec): Promise<T[]> {
    return this.enqueue(() => {
      this.assertAvailable();
      return this.queryRows<T>(spec);
    });
  }

  async put<T extends LocalRow>(table: LocalTable, rows: T[]): Promise<number> {
    // Validar el lote completo antes de tocar la base.
    assertBatch(table, rows);
    if (rows.length === 0) {
      this.assertAvailable();
      return 0;
    }
    return this.enqueue(() => {
      this.assertAvailable();
      return this.inTransaction(() => this.applyPut(table, rows));
    });
  }

  async remove(table: LocalTable, ids: string[], meta: MutationMeta): Promise<void> {
    if (ids.length === 0) return;
    return this.enqueue(async () => {
      this.assertAvailable();
      await this.inTransaction(() => this.applyRemove(table, ids, meta));
    });
  }

  transaction<T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.assertAvailable();
      await this.adapter.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.buildTransaction());
        await this.adapter.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          await this.adapter.exec("ROLLBACK");
        } catch {
          // La transacción ya estaba cerrada.
        }
        throw error;
      }
    });
  }

  changes(sinceSeq = 0, limit = DEFAULT_CHANGES_LIMIT): Promise<ChangeRecord[]> {
    return this.enqueue(async () => {
      this.assertAvailable();
      if (!Number.isFinite(sinceSeq)) return [];
      const take = clampChangesLimit(limit);
      try {
        const rows = await this.adapter.all<ChangeRow>(
          "SELECT seq, table_name, row_id, op, company_id, updated_at, origin_device, recorded_at " +
            "FROM _changes WHERE seq > ? ORDER BY seq ASC LIMIT ?",
          [sinceSeq, take]
        );
        return rows.map(toChangeRecord);
      } catch (error) {
        throw toLocalDbError(error, "No se pudo leer el journal de cambios");
      }
    });
  }

  latestSeq(): Promise<number> {
    return this.enqueue(async () => {
      this.assertAvailable();
      try {
        const meta = await this.adapter.all<{ value: string | null }>(
          "SELECT value FROM _meta WHERE key = ?",
          [META_SEQ]
        );
        const journal = await this.adapter.all<{ seq: number | bigint | null }>(
          "SELECT MAX(seq) AS seq FROM _changes"
        );
        const metaSeq = Number(meta[0]?.value ?? 0);
        const journalSeq = Number(journal[0]?.seq ?? 0);
        return Math.max(
          Number.isFinite(metaSeq) ? metaSeq : 0,
          Number.isFinite(journalSeq) ? journalSeq : 0
        );
      } catch (error) {
        throw toLocalDbError(error, "No se pudo leer la secuencia del journal");
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.queue;
    } catch {
      // La cola ya reportó su error en la operación correspondiente.
    }
    this.closed = true;
    this.readyState = false;
    try {
      await this.adapter.close();
    } catch {
      // Ya estaba cerrada.
    }
  }

  private assertAvailable(): void {
    if (this.closed) {
      throw new LocalDbError("driver_unavailable", "El driver SQLite está cerrado");
    }
    if (!this.readyState) {
      throw new LocalDbError("not_ready", "El driver SQLite aún no está listo");
    }
  }

  /** Un fallo no envenena las operaciones siguientes. */
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(() => operation(), () => operation());
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async readRow<T extends LocalRow>(table: LocalTable, id: string): Promise<T | null> {
    try {
      const rows = await this.adapter.all<Record<string, unknown>>(
        `SELECT ${SELECT_COLUMNS} FROM ${quoteIdent(table)} WHERE id = ? LIMIT 1`,
        [id]
      );
      return rows.length > 0 ? (deserializeRow(rows[0]) as T) : null;
    } catch {
      // Igual que IndexedDB: un fallo de lectura se traduce a "sin fila".
      return null;
    }
  }

  private async queryRows<T extends LocalRow>(spec: QuerySpec): Promise<T[]> {
    let built: BuiltQuery;
    try {
      built = buildQuerySql(spec);
    } catch (error) {
      // Campo o tabla inválidos son errores de programación, no lecturas vacías.
      throw toLocalDbError(error, "Consulta inválida");
    }
    try {
      const rows = await this.adapter.all<Record<string, unknown>>(built.sql, built.params);
      return rows.map((row) => deserializeRow(row) as T);
    } catch {
      return [];
    }
  }

  private async applyPut<T extends LocalRow>(table: LocalTable, rows: T[]): Promise<number> {
    if (rows.length === 0) return 0;
    const recordedAt = nowIso(this.clock());
    const insertSql = upsertSql(table);

    for (const row of rows) {
      await this.adapter.run(insertSql, serializeRow(row));
    }

    const entries: Array<Omit<ChangeRecord, "seq">> = rows.map((row) => ({
      table,
      row_id: row.id,
      op: row.deleted_at != null ? "delete" : "upsert",
      company_id: row.company_id,
      updated_at: row.updated_at,
      origin_device: typeof row.origin_device === "string" ? row.origin_device : "",
      recorded_at: recordedAt
    }));
    await this.appendChanges(entries);
    return rows.length;
  }

  private async applyRemove(
    table: LocalTable,
    ids: string[],
    meta: MutationMeta
  ): Promise<void> {
    const at = nowIso(meta.at ?? this.clock());
    const target = quoteIdent(table);
    const entries: Array<Omit<ChangeRecord, "seq">> = [];

    for (const id of ids) {
      const existing = await this.adapter.all<{ id: string }>(
        `SELECT id FROM ${target} WHERE id = ? LIMIT 1`,
        [id]
      );
      if (existing.length === 0) continue;
      await this.adapter.run(`DELETE FROM ${target} WHERE id = ?`, [id]);
      entries.push({
        table,
        row_id: id,
        op: "delete",
        company_id: meta.company_id,
        updated_at: at,
        origin_device: meta.origin_device,
        recorded_at: at
      });
    }

    await this.appendChanges(entries);
  }

  /** Escribe el journal y adelanta la meta dentro de la transacción en curso. */
  private async appendChanges(entries: Array<Omit<ChangeRecord, "seq">>): Promise<void> {
    if (entries.length === 0) return;

    const current = await this.adapter.all<{ seq: number | bigint | null }>(
      "SELECT MAX(seq) AS seq FROM _changes"
    );
    let seq = Number(current[0]?.seq ?? 0);
    if (!Number.isFinite(seq)) seq = 0;

    const insert =
      "INSERT INTO _changes " +
      "(seq, table_name, row_id, op, company_id, updated_at, origin_device, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    for (const entry of entries) {
      seq += 1;
      await this.adapter.run(insert, [
        seq,
        entry.table,
        entry.row_id,
        entry.op,
        entry.company_id,
        entry.updated_at,
        entry.origin_device,
        entry.recorded_at
      ]);
    }

    await this.adapter.run(
      "INSERT INTO _meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [META_SEQ, String(seq)]
    );
  }

  private async inTransaction<T>(body: () => T | Promise<T>): Promise<T> {
    await this.adapter.exec("BEGIN IMMEDIATE");
    try {
      const result = await body();
      await this.adapter.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.adapter.exec("ROLLBACK");
      } catch {
        // La transacción ya estaba cerrada.
      }
      throw toLocalDbError(error, "La transacción SQLite falló");
    }
  }

  private buildTransaction(): LocalDbTransaction {
    return {
      get: <R extends LocalRow>(table: LocalTable, id: string) => this.readRow<R>(table, id),
      query: <R extends LocalRow>(spec: QuerySpec) => this.queryRows<R>(spec),
      put: async <R extends LocalRow>(table: LocalTable, rows: R[]) => {
        assertBatch(table, rows);
        return this.applyPut(table, rows);
      },
      remove: async (table: LocalTable, ids: string[], meta: MutationMeta) => {
        await this.applyRemove(table, ids, meta);
      }
    };
  }
}

export async function createSqliteDriver(options: SqliteDriverOptions): Promise<LocalDbDriver> {
  const driver = new SqliteDriver(options);
  await driver.ready();
  return driver;
}
