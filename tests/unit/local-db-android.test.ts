import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalDbError,
  type LocalDbDriver,
  type LocalRow,
  type QuerySpec
} from "../../src/services/localDb/contract";
import { LOCAL_DB_TABLE_NAMES } from "../../src/services/localDb/schema";
import type { SqlValue } from "../../src/services/localDb/sqlite/adapter";
import {
  androidSqliteBridgeAvailable,
  createAndroidSqliteAdapter,
  createAndroidSqliteDriver,
  type AndroidSqliteBridge
} from "../../src/services/localDb/sqlite/androidAdapter";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

interface NativeStatement {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface NativeSqliteModule {
  DatabaseSync: new (path: string) => NativeDatabase;
}

let nativeSqlite: Promise<NativeSqliteModule> | null = null;

/** @types/node 22 no declara node:sqlite; se carga como el binding de Node. */
function loadNativeSqlite(): Promise<NativeSqliteModule> {
  if (!nativeSqlite) {
    nativeSqlite = import("node:sqlite") as unknown as Promise<NativeSqliteModule>;
  }
  return nativeSqlite;
}

function failEnvelope(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error ? error.name : "Error";
  return JSON.stringify({ ok: false, error: code, message });
}

function decodeParams(paramsJson: string): unknown[] {
  if (!paramsJson) return [];
  const parsed = JSON.parse(paramsJson) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Parámetros JSON inválidos");
  return parsed.map((value) => {
    if (value === null || typeof value === "string" || typeof value === "number") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const encoded = (value as { b64?: unknown }).b64;
      if (typeof encoded === "string") return new Uint8Array(Buffer.from(encoded, "base64"));
      throw new Error("Parámetro no soportado");
    }
    throw new Error("Parámetro no soportado");
  });
}

function encodeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return { b64: Buffer.from(value).toString("base64") };
  return String(value);
}

function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    encoded[key] = encodeValue(value);
  }
  return encoded;
}

type FakeBridge = AndroidSqliteBridge & { close(): void };

/**
 * Puente falso que habla exactamente el protocolo de NativeDb.java sobre
 * node:sqlite: exec/run/all reciben SQL + params JSON y devuelven el envelope.
 */
async function createFakeBridge(dbPath: string): Promise<FakeBridge> {
  const { DatabaseSync } = await loadNativeSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");
  let closed = false;

  return {
    exec(sql: string): string {
      try {
        db.exec(sql);
        return JSON.stringify({ ok: true });
      } catch (error) {
        return failEnvelope(error);
      }
    },
    run(sql: string, paramsJson: string): string {
      try {
        const statement = db.prepare(sql);
        const result = statement.run(...decodeParams(paramsJson));
        return JSON.stringify({ ok: true, changes: Number(result.changes ?? 0) });
      } catch (error) {
        return failEnvelope(error);
      }
    },
    all(sql: string, paramsJson: string): string {
      try {
        const statement = db.prepare(sql);
        const rows = statement.all(...decodeParams(paramsJson)).map((row) => encodeRow(row));
        return JSON.stringify({ ok: true, rows });
      } catch (error) {
        return failEnvelope(error);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    }
  };
}

function makeRow(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: "co-1",
    version: 1,
    updated_at: FIXED_NOW,
    origin_device: "dev-1",
    deleted_at: null,
    ...fields
  };
}

function ids(rows: LocalRow[]): string[] {
  return rows.map((row) => row.id);
}

interface Harness {
  readonly driver: LocalDbDriver;
  readonly bridge: FakeBridge;
  readonly dbPath: string;
  reopen(): Promise<LocalDbDriver>;
}

async function harness(t: TestContext): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "palmyra-android-"));
  const dbPath = join(dir, "palmyra.db");
  let bridge = await createFakeBridge(dbPath);
  let driver = await createAndroidSqliteDriver({ bridge, filePath: dbPath, now: () => FIXED_NOW });
  t.after(async () => {
    try {
      await driver.close();
    } catch {
      // El driver ya estaba cerrado.
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    get driver() {
      return driver;
    },
    get bridge() {
      return bridge;
    },
    dbPath,
    async reopen() {
      await driver.close();
      bridge = await createFakeBridge(dbPath);
      driver = await createAndroidSqliteDriver({ bridge, filePath: dbPath, now: () => FIXED_NOW });
      return driver;
    }
  };
}

test("abre palmyra.db y crea el esquema completo, el journal y la meta", async (t) => {
  const h = await harness(t);

  const tables = JSON.parse(
    h.bridge.all("SELECT name FROM sqlite_master WHERE type = 'table'", "[]")
  ) as { rows: Array<{ name: string }> };
  const names = new Set(tables.rows.map((row) => row.name));
  assert.equal(LOCAL_DB_TABLE_NAMES.length, 33);
  for (const table of LOCAL_DB_TABLE_NAMES) {
    assert.ok(names.has(table), `falta la tabla ${table}`);
  }
  assert.ok(names.has("_changes"));
  assert.ok(names.has("_meta"));

  const version = JSON.parse(h.bridge.all("PRAGMA user_version", "[]")) as {
    rows: Array<{ user_version: number }>;
  };
  assert.equal(version.rows[0].user_version, 1);
});

test("put y query respetan filtros, orden, límites y deleted_at", async (t) => {
  const h = await harness(t);
  await h.driver.put("products", [
    makeRow("p1", { name: "Arroz", qty: 5, status: "a" }),
    makeRow("p2", { name: "Frijol", qty: 10, status: "b", version: 3 }),
    makeRow("p3", { name: "Aceite", qty: 15, status: "a" }),
    makeRow("p4", { name: "Azucar", qty: 20, status: "c", deleted_at: "2026-02-01T00:00:00.000Z" })
  ]);

  const run = async (where: QuerySpec["where"], extra: Partial<QuerySpec> = {}): Promise<string[]> =>
    ids(
      await h.driver.query({
        table: "products",
        where,
        orderBy: { field: "id", direction: "asc" },
        ...extra
      })
    );

  assert.deepEqual(await run([{ field: "status", op: "eq", value: "a" }]), ["p1", "p3"]);
  assert.deepEqual(await run([{ field: "status", op: "neq", value: "a" }]), ["p2"]);
  assert.deepEqual(await run([{ field: "status", op: "in", value: ["b", "c"] }]), ["p2"]);
  assert.deepEqual(await run([{ field: "qty", op: "gt", value: 10 }]), ["p3"]);
  assert.deepEqual(await run([{ field: "qty", op: "lte", value: 10 }]), ["p1", "p2"]);
  assert.deepEqual(await run([{ field: "version", op: "eq", value: 3 }]), ["p2"]);
  assert.deepEqual(await run([{ field: "qty", op: "gt", value: "10" }]), []);

  // deleted_at se excluye salvo includeDeleted.
  assert.deepEqual(await run([{ field: "qty", op: "gte", value: 20 }]), []);
  const withDeleted = await h.driver.query({
    table: "products",
    where: [{ field: "qty", op: "gte", value: 20 }],
    includeDeleted: true
  });
  assert.deepEqual(ids(withDeleted), ["p4"]);

  const page = await h.driver.query({
    table: "products",
    orderBy: { field: "qty", direction: "desc" },
    limit: 2,
    offset: 1
  });
  // p4 está borrado; orden desc: p3 (15), p2 (10), p1 (5).
  assert.deepEqual(ids(page), ["p2", "p1"]);
});

test("journal de cambios con seq monótono, changes(since) y latestSeq", async (t) => {
  const h = await harness(t);
  await h.driver.put("products", [makeRow("p1"), makeRow("p2")]);
  await h.driver.remove("products", ["p1", "inexistente"], {
    company_id: "co-9",
    origin_device: "dev-9",
    at: "2026-02-02T00:00:00.000Z"
  });

  const journal = await h.driver.changes();
  assert.deepEqual(
    journal.map((change) => change.seq),
    [1, 2, 3]
  );
  assert.deepEqual(
    journal.map((change) => change.op),
    ["upsert", "upsert", "delete"]
  );
  assert.equal(journal[2].row_id, "p1");
  assert.equal(journal[2].company_id, "co-9");
  assert.equal(journal[0].recorded_at, FIXED_NOW);
  assert.deepEqual(
    (await h.driver.changes(2)).map((change) => change.seq),
    [3]
  );
  assert.equal(await h.driver.latestSeq(), 3);
});

test("transaction confirma filas y journal", async (t) => {
  const h = await harness(t);
  const result = await h.driver.transaction(async (tx) => {
    await tx.put("products", [makeRow("p1")]);
    await tx.put("products", [makeRow("p2")]);
    assert.equal((await tx.get("products", "p1"))?.id, "p1");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal((await h.driver.get<LocalRow>("products", "p1"))?.id, "p1");
  assert.equal(await h.driver.latestSeq(), 2);
  assert.deepEqual(ids(await h.driver.query({ table: "products" })), ["p1", "p2"]);
});

test("transaction revertida con ROLLBACK no deja filas ni journal", async (t) => {
  const h = await harness(t);
  await h.driver.put("products", [makeRow("p1")]);
  const beforeSeq = await h.driver.latestSeq();

  await assert.rejects(
    () =>
      h.driver.transaction(async (tx) => {
        await tx.put("products", [makeRow("p2")]);
        await tx.remove("products", ["p1"], { company_id: "co-1", origin_device: "dev-1" });
        assert.equal((await tx.get("products", "p2"))?.id, "p2");
        throw new Error("boom");
      }),
    /boom/
  );

  assert.equal(await h.driver.latestSeq(), beforeSeq);
  assert.equal((await h.driver.changes()).length, 1);
  assert.equal((await h.driver.get<LocalRow>("products", "p1"))?.id, "p1");
  assert.equal(await h.driver.get("products", "p2"), null);
  assert.deepEqual(ids(await h.driver.query({ table: "products" })), ["p1"]);

  await h.driver.put("products", [makeRow("p3")]);
  assert.deepEqual(
    (await h.driver.changes()).map((change) => change.seq),
    [1, 2]
  );
});

test("persiste filas y journal al cerrar y reabrir el archivo", async (t) => {
  const h = await harness(t);
  await h.driver.put("products", [makeRow("p1", { name: "Arroz", nested: { x: 1 } })]);
  await h.driver.put("hub_receipts", [makeRow("r1", { action_id: "act-1", payload: { total: 3 } })]);

  const reopened = await h.reopen();
  const product = await reopened.get<LocalRow>("products", "p1");
  assert.equal(product?.name, "Arroz");
  assert.deepEqual(product?.nested, { x: 1 });
  assert.equal((await reopened.get<LocalRow>("hub_receipts", "r1"))?.action_id, "act-1");
  assert.equal(await reopened.latestSeq(), 2);
  assert.deepEqual(
    (await reopened.changes()).map((change) => change.seq),
    [1, 2]
  );
});

test("un error SQL del envelope llega como Error legible en TS", async (t) => {
  const h = await harness(t);
  const adapter = createAndroidSqliteAdapter(h.bridge);

  assert.throws(
    () => adapter.all("SELECT * FROM tabla_inexistente"),
    (error: unknown) =>
      error instanceof LocalDbError && /no such table/i.test((error as Error).message)
  );
  assert.throws(
    () => adapter.run("INSERT INTO tabla_inexistente (id) VALUES (?)", ["x"]),
    (error: unknown) => error instanceof Error && /tabla_inexistente/i.test((error as Error).message)
  );
});

test("blob roundtrip y escalares en ambos sentidos", async (t) => {
  const h = await harness(t);
  const adapter = createAndroidSqliteAdapter(h.bridge);

  adapter.exec(
    "CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, payload BLOB, note TEXT, amount REAL, missing TEXT)"
  );
  const payload = new Uint8Array([0, 1, 2, 250, 255]);
  const inserted = adapter.run(
    "INSERT INTO blobs (id, payload, note, amount, missing) VALUES (?, ?, ?, ?, ?)",
    ["b1", payload, "texto", 12.5, null]
  );
  assert.equal(inserted.changes, 1);

  const rows = adapter.all<{
    id: string;
    payload: Uint8Array;
    note: string;
    amount: number;
    missing: null;
  }>("SELECT id, payload, note, amount, missing FROM blobs WHERE id = ?", ["b1"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload instanceof Uint8Array, true);
  assert.deepEqual(Array.from(rows[0].payload), [0, 1, 2, 250, 255]);
  assert.equal(rows[0].note, "texto");
  assert.equal(rows[0].amount, 12.5);
  assert.equal(rows[0].missing, null);

  // close es idempotente y deja el adaptador no disponible.
  adapter.close();
  adapter.close();
  assert.throws(() => adapter.all("SELECT 1"), /cerrado/);
});

test("un booleano no se acepta como parámetro del contrato", () => {
  const bridge: AndroidSqliteBridge = {
    exec: () => JSON.stringify({ ok: true }),
    run: () => JSON.stringify({ ok: true, changes: 0 }),
    all: () => JSON.stringify({ ok: true, rows: [] })
  };
  const adapter = createAndroidSqliteAdapter(bridge);
  assert.throws(
    () => adapter.run("SELECT ?", [true as unknown as SqlValue]),
    (error: unknown) => error instanceof LocalDbError && /no soportado/i.test((error as Error).message)
  );
  assert.throws(
    () => adapter.all("SELECT ?", [{ nope: 1 } as unknown as SqlValue]),
    (error: unknown) => error instanceof LocalDbError && /no soportado/i.test((error as Error).message)
  );
});

test("sin puente PALMYRA_DB el driver lanza driver_unavailable", async () => {
  assert.equal(androidSqliteBridgeAvailable(), false);
  await assert.rejects(
    () => createAndroidSqliteDriver(),
    (error: unknown) => error instanceof LocalDbError && error.code === "driver_unavailable"
  );
});
