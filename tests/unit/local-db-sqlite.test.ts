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
import { createNodeSqliteAdapter } from "../../src/services/localDb/sqlite/bindingNode";
import { createSqliteDriver } from "../../src/services/localDb/sqlite/driver";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

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

function openDriver(dir: string): Promise<LocalDbDriver> {
  const dbPath = join(dir, "local-db.sqlite");
  return createNodeSqliteAdapter(dbPath).then((adapter) =>
    createSqliteDriver({ adapter, filePath: dbPath, now: () => FIXED_NOW })
  );
}

interface Harness {
  readonly driver: LocalDbDriver;
  readonly dbPath: string;
  reopen(): Promise<LocalDbDriver>;
}

async function harness(t: TestContext): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "palmyra-sqlite-"));
  let driver = await openDriver(dir);
  t.after(async () => {
    await driver.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    get driver() {
      return driver;
    },
    dbPath: join(dir, "local-db.sqlite"),
    async reopen() {
      await driver.close();
      driver = await openDriver(dir);
      return driver;
    }
  };
}

function ids(rows: LocalRow[]): string[] {
  return rows.map((row) => row.id);
}

test("persiste filas y journal tras cerrar y reabrir, incluidas hub_devices y hub_receipts", async (t) => {
  const h = await harness(t);

  await h.driver.put("products", [
    makeRow("p1", { name: "Arroz", price: 10, tags: ["a", "b"], nested: { x: 1 } })
  ]);
  await h.driver.put("hub_devices", [
    makeRow("d1", { device_id: "dev-1", name: "Caja 1", token_hash: "hash-abc" })
  ]);
  await h.driver.put("hub_receipts", [
    makeRow("r1", { action_id: "act-1", status: "ok", payload: { total: 3, lines: [1, 2] } })
  ]);

  const reopened = await h.reopen();
  const product = await reopened.get<LocalRow>("products", "p1");
  assert.equal(product?.name, "Arroz");
  assert.equal(product?.price, 10);
  assert.deepEqual(product?.tags, ["a", "b"]);
  assert.deepEqual(product?.nested, { x: 1 });
  assert.equal(product?.version, 1);
  assert.equal(product?.origin_device, "dev-1");
  assert.equal(product?.deleted_at, null);

  const device = await reopened.get<LocalRow>("hub_devices", "d1");
  assert.equal(device?.device_id, "dev-1");
  assert.equal(device?.token_hash, "hash-abc");

  const receipt = await reopened.get<LocalRow>("hub_receipts", "r1");
  assert.equal(receipt?.action_id, "act-1");
  assert.deepEqual(receipt?.payload, { total: 3, lines: [1, 2] });

  const byAction = await reopened.query({
    table: "hub_receipts",
    where: [{ field: "action_id", op: "eq", value: "act-1" }]
  });
  assert.deepEqual(ids(byAction), ["r1"]);

  assert.equal(await reopened.latestSeq(), 3);
  assert.deepEqual(
    (await reopened.changes()).map((change) => change.seq),
    [1, 2, 3]
  );
});

test("query traduce eq/neq/in/numéricos, columnas reales y campos JSON", async (t) => {
  const h = await harness(t);
  const driver = h.driver;

  await driver.put("products", [
    makeRow("p1", { name: "Arroz", qty: 5, status: "a", warehouse_id: "w1" }),
    makeRow("p2", { name: "Frijol", qty: 10, status: "b", warehouse_id: "w2", version: 3 }),
    makeRow("p3", { name: "Aceite", qty: 15, status: "a", warehouse_id: "w1" }),
    makeRow("p4", {
      name: "Azucar",
      qty: 20,
      status: "c",
      warehouse_id: "w2",
      deleted_at: "2026-02-01T00:00:00.000Z"
    })
  ]);

  const run = async (
    where: QuerySpec["where"],
    extra: Partial<QuerySpec> = {}
  ): Promise<string[]> => {
    const rows = await driver.query({
      table: "products",
      where,
      orderBy: { field: "id", direction: "asc" },
      ...extra
    });
    return ids(rows);
  };

  assert.deepEqual(await run([{ field: "status", op: "eq", value: "a" }]), ["p1", "p3"]);
  assert.deepEqual(await run([{ field: "status", op: "neq", value: "a" }]), ["p2"]);
  assert.deepEqual(await run([{ field: "status", op: "in", value: ["b", "c"] }]), ["p2"]);
  assert.deepEqual(await run([{ field: "qty", op: "gt", value: 10 }]), ["p3"]);
  assert.deepEqual(await run([{ field: "qty", op: "gte", value: 10 }]), ["p2", "p3"]);
  assert.deepEqual(await run([{ field: "qty", op: "lt", value: 10 }]), ["p1"]);
  assert.deepEqual(await run([{ field: "qty", op: "lte", value: 10 }]), ["p1", "p2"]);
  assert.deepEqual(
    await run([
      { field: "status", op: "eq", value: "a" },
      { field: "qty", op: "gte", value: 10 }
    ]),
    ["p3"]
  );

  // Campo JSON indexado (warehouse_id) y columna real numérica (version).
  assert.deepEqual(
    await run([{ field: "warehouse_id", op: "eq", value: "w1" }]),
    ["p1", "p3"]
  );
  assert.deepEqual(await run([{ field: "version", op: "eq", value: 3 }]), ["p2"]);
  assert.deepEqual(await run([{ field: "company_id", op: "eq", value: "co-1" }]), [
    "p1",
    "p2",
    "p3"
  ]);
  assert.deepEqual(await run([{ field: "company_id", op: "eq", value: "co-2" }]), []);
  assert.deepEqual(
    await run([{ field: "qty", op: "gt", value: "10" }]),
    [],
    "un filtro numérico con texto no coincide con ninguna fila"
  );

  // deleted_at se excluye salvo includeDeleted.
  const withDeleted = await driver.query({
    table: "products",
    where: [{ field: "qty", op: "gte", value: 20 }],
    includeDeleted: true
  });
  assert.deepEqual(ids(withDeleted), ["p4"]);
  assert.deepEqual(await run([{ field: "qty", op: "gte", value: 20 }]), []);

  // limit/offset sobre un orden determinista.
  const page = await driver.query({
    table: "products",
    orderBy: { field: "qty", direction: "asc" },
    limit: 2,
    offset: 1
  });
  assert.deepEqual(ids(page), ["p2", "p3"]);

  const beyond = await driver.query({ table: "products", offset: 10 });
  assert.deepEqual(beyond, []);
});

test("orderBy ordena asc/desc y desempata por id en la misma dirección", async (t) => {
  const h = await harness(t);
  await h.driver.put("products", [
    makeRow("p3", { qty: 7 }),
    makeRow("p1", { qty: 7 }),
    makeRow("p2", { qty: 7 }),
    makeRow("p4", { qty: 1 })
  ]);

  const asc = await h.driver.query({
    table: "products",
    orderBy: { field: "qty", direction: "asc" }
  });
  assert.deepEqual(ids(asc), ["p4", "p1", "p2", "p3"]);

  const desc = await h.driver.query({
    table: "products",
    orderBy: { field: "qty", direction: "desc" }
  });
  assert.deepEqual(ids(desc), ["p3", "p2", "p1", "p4"]);

  // get devuelve una copia: mutar el resultado no altera el almacén.
  const row = await h.driver.get<LocalRow>("products", "p1");
  row!.qty = 999;
  assert.equal((await h.driver.get<LocalRow>("products", "p1"))?.qty, 7);
});

test("journal: seq monótono, changes(since), remove y latestSeq tras reabrir", async (t) => {
  const h = await harness(t);
  const driver = h.driver;

  await driver.put("products", [makeRow("p1"), makeRow("p2")]);
  await driver.remove("products", ["p1", "inexistente"], {
    company_id: "co-9",
    origin_device: "dev-9",
    at: "2026-02-02T00:00:00.000Z"
  });

  const journal = await driver.changes();
  assert.deepEqual(
    journal.map((change) => change.seq),
    [1, 2, 3]
  );
  assert.deepEqual(
    journal.map((change) => change.op),
    ["upsert", "upsert", "delete"]
  );
  assert.equal(journal[0].table, "products");
  assert.equal(journal[0].company_id, "co-1");
  assert.equal(journal[0].origin_device, "dev-1");
  assert.equal(journal[0].recorded_at, FIXED_NOW);

  const deletion = journal[2];
  assert.equal(deletion.row_id, "p1");
  assert.equal(deletion.company_id, "co-9");
  assert.equal(deletion.origin_device, "dev-9");
  assert.equal(deletion.updated_at, "2026-02-02T00:00:00.000Z");
  assert.equal(deletion.recorded_at, "2026-02-02T00:00:00.000Z");

  assert.equal(await driver.get("products", "p1"), null);
  assert.equal((await driver.get<LocalRow>("products", "p2"))?.id, "p2");
  assert.deepEqual(
    (await driver.changes(2)).map((change) => change.seq),
    [3]
  );
  assert.deepEqual(
    (await driver.changes(0, 1)).map((change) => change.seq),
    [1]
  );
  assert.equal(await driver.latestSeq(), 3);

  const reopened = await h.reopen();
  assert.equal(await reopened.latestSeq(), 3);
  assert.deepEqual(
    (await reopened.changes(1)).map((change) => change.seq),
    [2, 3]
  );
  assert.equal(await reopened.get("products", "p1"), null);
});

test("put con deleted_at registra op delete y sigue oculto en query", async (t) => {
  const h = await harness(t);
  await h.driver.put("products", [
    makeRow("p1"),
    makeRow("p2", { deleted_at: "2026-02-01T00:00:00.000Z" })
  ]);

  const journal = await h.driver.changes();
  assert.deepEqual(
    journal.map((change) => change.op),
    ["upsert", "delete"]
  );
  assert.deepEqual(ids(await h.driver.query({ table: "products" })), ["p1"]);
  assert.equal((await h.driver.get<LocalRow>("products", "p2"))?.deleted_at, "2026-02-01T00:00:00.000Z");
});

test("transaction revierte filas y journal cuando el callback lanza", async (t) => {
  const h = await harness(t);
  const driver = h.driver;
  await driver.put("products", [makeRow("p1")]);
  const beforeSeq = await driver.latestSeq();

  await assert.rejects(
    () =>
      driver.transaction(async (tx) => {
        await tx.put("products", [makeRow("p2")]);
        await tx.remove("products", ["p1"], { company_id: "co-1", origin_device: "dev-1" });
        // Dentro de la transacción los cambios son visibles.
        assert.equal((await tx.get("products", "p2"))?.id, "p2");
        assert.equal(await tx.get("products", "p1"), null);
        throw new Error("boom");
      }),
    /boom/
  );

  assert.equal(await driver.latestSeq(), beforeSeq);
  assert.equal((await driver.changes()).length, 1);
  assert.equal((await driver.get<LocalRow>("products", "p1"))?.id, "p1");
  assert.equal(await driver.get("products", "p2"), null);
  assert.deepEqual(ids(await driver.query({ table: "products" })), ["p1"]);

  // Tras el rollback se pueden seguir asignando seq sin huecos.
  await driver.put("products", [makeRow("p3")]);
  assert.deepEqual(
    (await driver.changes()).map((change) => change.seq),
    [1, 2]
  );
});

test("transaction confirma y serializa transacciones concurrentes", async (t) => {
  const h = await harness(t);
  const driver = h.driver;
  const timeline: string[] = [];

  const first = driver.transaction(async (tx) => {
    timeline.push("a-start");
    await tx.put("products", [makeRow("p1")]);
    await Promise.resolve();
    timeline.push("a-end");
    return "a";
  });
  const second = driver.transaction(async (tx) => {
    timeline.push("b-start");
    await tx.put("products", [makeRow("p2")]);
    timeline.push("b-end");
    return "b";
  });

  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(timeline, ["a-start", "a-end", "b-start", "b-end"]);
  assert.equal(await driver.latestSeq(), 2);
  assert.deepEqual(
    ids(
      await driver.query({
        table: "products",
        orderBy: { field: "id", direction: "asc" }
      })
    ),
    ["p1", "p2"]
  );
});

test("un lote con una fila inválida no escribe nada", async (t) => {
  const h = await harness(t);
  await h.driver.put("products", [makeRow("keep")]);

  const broken = {
    id: "bad",
    company_id: "co-1",
    updated_at: FIXED_NOW
  } as unknown as LocalRow;

  await assert.rejects(
    () => h.driver.put("products", [makeRow("p2"), broken]),
    (error: unknown) => error instanceof LocalDbError && error.code === "invalid_row"
  );

  assert.equal(await h.driver.get("products", "p2"), null);
  assert.equal(await h.driver.latestSeq(), 1);
  assert.equal((await h.driver.changes()).length, 1);
  assert.deepEqual(ids(await h.driver.query({ table: "products" })), ["keep"]);
});

test("crea las 33 tablas lógicas, el journal y los índices JSON declarados", async (t) => {
  const h = await harness(t);

  // Segunda conexión al mismo archivo (WAL) solo para inspeccionar el esquema.
  const inspect = await createNodeSqliteAdapter(h.dbPath);
  try {
    assert.equal(LOCAL_DB_TABLE_NAMES.length, 33);
    const tables = inspect.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    const names = new Set(tables.map((table) => table.name));
    for (const table of LOCAL_DB_TABLE_NAMES) {
      assert.ok(names.has(table), `falta la tabla ${table}`);
    }
    assert.ok(names.has("_changes"));
    assert.ok(names.has("_meta"));

    const version = inspect.all<{ user_version: number }>("PRAGMA user_version");
    assert.equal(version[0].user_version, 1);

    const indexes = inspect.all<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_movements'"
    );
    assert.ok(
      indexes.some((index) => index.sql?.includes("json_extract(data, '$.warehouse_id')")),
      "los índices de campos extra usan json_extract"
    );
    assert.ok(
      indexes.some((index) => index.sql?.includes("json_extract(data, '$.created_at')")),
      "los campos extra del esquema también se indexan como expresión"
    );
  } finally {
    inspect.close();
  }
});

test("close deja el driver no disponible", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "palmyra-sqlite-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const driver = await openDriver(dir);

  await driver.put("products", [makeRow("p1")]);
  await driver.close();

  const unavailable = (error: unknown) =>
    error instanceof LocalDbError && error.code === "driver_unavailable";
  await assert.rejects(() => driver.get("products", "p1"), unavailable);
  await assert.rejects(() => driver.query({ table: "products" }), unavailable);
  await assert.rejects(() => driver.put("products", [makeRow("p2")]), unavailable);
  await assert.rejects(() => driver.changes(), unavailable);
  await assert.rejects(() => driver.latestSeq(), unavailable);
  await assert.rejects(() => driver.transaction(async () => 1), unavailable);
});
