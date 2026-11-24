import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalDbError,
  type LocalRow,
  type QuerySpec
} from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";

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

async function readyDriver() {
  const driver = createMemoryDriver({ now: () => FIXED_NOW });
  await driver.ready();
  return driver;
}

function ids(rows: LocalRow[]): string[] {
  return rows.map((row) => row.id);
}

test("put escribe filas y get/query devuelven copias", async () => {
  const driver = await readyDriver();
  const original = makeRow("p1", { name: "Arroz", price: 10 });
  const written = await driver.put("products", [original, makeRow("p2")]);
  assert.equal(written, 2);

  // Mutar el objeto original no altera el almacén.
  original.name = "Mutado";
  const first = await driver.get<LocalRow>("products", "p1");
  assert.equal(first?.name, "Arroz");

  // Mutar el resultado tampoco altera el almacén.
  first!.name = "Otra vez";
  assert.equal((await driver.get<LocalRow>("products", "p1"))?.name, "Arroz");
  assert.equal(await driver.get("products", "inexistente"), null);

  const all = await driver.query({
    table: "products",
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(ids(all), ["p1", "p2"]);
});

test("query aplica filtros eq/neq/in/gt/gte/lt/lte", async () => {
  const driver = await readyDriver();
  await driver.put("products", [
    makeRow("p1", { name: "Arroz", qty: 5, status: "a" }),
    makeRow("p2", { name: "Frijol", qty: 10, status: "b" }),
    makeRow("p3", { name: "Aceite", qty: 15, status: "a" }),
    makeRow("p4", { name: "Azucar", qty: 20, status: "c" })
  ]);

  const run = async (where: QuerySpec["where"]): Promise<string[]> => {
    const rows = await driver.query({
      table: "products",
      where,
      orderBy: { field: "id", direction: "asc" }
    });
    return ids(rows);
  };

  assert.deepEqual(await run([{ field: "status", op: "eq", value: "a" }]), ["p1", "p3"]);
  assert.deepEqual(await run([{ field: "status", op: "neq", value: "a" }]), ["p2", "p4"]);
  assert.deepEqual(await run([{ field: "status", op: "in", value: ["b", "c"] }]), ["p2", "p4"]);
  assert.deepEqual(await run([{ field: "qty", op: "gt", value: 10 }]), ["p3", "p4"]);
  assert.deepEqual(await run([{ field: "qty", op: "gte", value: 10 }]), ["p2", "p3", "p4"]);
  assert.deepEqual(await run([{ field: "qty", op: "lt", value: 10 }]), ["p1"]);
  assert.deepEqual(await run([{ field: "qty", op: "lte", value: 10 }]), ["p1", "p2"]);
  assert.deepEqual(
    await run([
      { field: "status", op: "eq", value: "a" },
      { field: "qty", op: "gte", value: 10 }
    ]),
    ["p3"]
  );
});

test("query ordena asc/desc y desempata por id", async () => {
  const driver = await readyDriver();
  await driver.put("products", [
    makeRow("p3", { qty: 7 }),
    makeRow("p1", { qty: 7 }),
    makeRow("p2", { qty: 7 }),
    makeRow("p4", { qty: 1 })
  ]);

  const asc = await driver.query({
    table: "products",
    orderBy: { field: "qty", direction: "asc" }
  });
  assert.deepEqual(ids(asc), ["p4", "p1", "p2", "p3"]);

  const desc = await driver.query({
    table: "products",
    orderBy: { field: "qty", direction: "desc" }
  });
  assert.deepEqual(ids(desc), ["p3", "p2", "p1", "p4"]);
});

test("query aplica limit y offset", async () => {
  const driver = await readyDriver();
  await driver.put(
    "products",
    [1, 2, 3, 4, 5].map((qty) => makeRow(`p${qty}`, { qty }))
  );

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

test("query excluye filas con deleted_at salvo includeDeleted", async () => {
  const driver = await readyDriver();
  await driver.put("products", [
    makeRow("p1"),
    makeRow("p2", { version: 2, deleted_at: "2026-03-03T00:00:00.000Z" })
  ]);

  const visible = await driver.query({
    table: "products",
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(ids(visible), ["p1"]);

  const withDeleted = await driver.query({
    table: "products",
    includeDeleted: true,
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(ids(withDeleted), ["p1", "p2"]);
});

test("un lote con una fila inválida no escribe nada", async () => {
  const driver = await readyDriver();
  await driver.put("products", [makeRow("keep")]);

  const broken = {
    id: "bad",
    company_id: "co-1",
    updated_at: FIXED_NOW
  } as unknown as LocalRow;

  await assert.rejects(
    () => driver.put("products", [makeRow("p2"), broken]),
    (error: unknown) => error instanceof LocalDbError && error.code === "invalid_row"
  );

  assert.equal(await driver.get("products", "p2"), null);
  assert.equal(await driver.latestSeq(), 1);
  assert.equal((await driver.changes()).length, 1);
  assert.deepEqual(ids(await driver.query({ table: "products" })), ["keep"]);
});

test("journal registra upserts/updates con seq creciente y delete", async () => {
  const driver = await readyDriver();
  await driver.put("products", [makeRow("p1"), makeRow("p2")]);
  await driver.remove("products", ["p1", "inexistente"], {
    company_id: "co-9",
    origin_device: "dev-9",
    at: "2026-02-02T00:00:00.000Z"
  });

  const journal = await driver.changes();
  assert.deepEqual(journal.map((change) => change.seq), [1, 2, 3]);
  assert.deepEqual(journal.map((change) => change.op), ["upsert", "upsert", "delete"]);
  assert.equal(journal[0].company_id, "co-1");
  assert.equal(journal[0].origin_device, "dev-1");
  assert.equal(journal[0].recorded_at, FIXED_NOW);

  const deletion = journal[2];
  assert.equal(deletion.table, "products");
  assert.equal(deletion.row_id, "p1");
  assert.equal(deletion.company_id, "co-9");
  assert.equal(deletion.origin_device, "dev-9");
  assert.equal(deletion.updated_at, "2026-02-02T00:00:00.000Z");
  assert.equal(deletion.recorded_at, "2026-02-02T00:00:00.000Z");
  assert.equal(journal.filter((change) => change.op === "delete").length, 1);

  assert.deepEqual((await driver.changes(2)).map((change) => change.seq), [3]);
  assert.deepEqual((await driver.changes(0, 1)).map((change) => change.seq), [1]);
  assert.equal(await driver.latestSeq(), 3);
  assert.equal(await driver.get("products", "p1"), null);
});

test("transaction revierte filas y seq cuando fn falla", async () => {
  const driver = await readyDriver();
  await driver.put("products", [makeRow("p1")]);
  const beforeSeq = await driver.latestSeq();

  await assert.rejects(
    () =>
      driver.transaction(async (tx) => {
        await tx.put("products", [makeRow("p2")]);
        await tx.remove("products", ["p1"], { company_id: "co-1", origin_device: "dev-1" });
        // Dentro de la transacción los cambios son visibles.
        assert.equal((await tx.get("products", "p2"))?.id, "p2");
        throw new Error("boom");
      }),
    /boom/
  );

  assert.equal(await driver.latestSeq(), beforeSeq);
  assert.equal((await driver.changes()).length, 1);
  assert.equal((await driver.get("products", "p1"))?.id, "p1");
  assert.equal(await driver.get("products", "p2"), null);
});

test("transaction serializa transacciones y devuelve el resultado", async () => {
  const driver = await readyDriver();
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

  const rows = await driver.query({
    table: "products",
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(ids(rows), ["p1", "p2"]);
});

test("exige ready() y falla con driver_unavailable tras close()", async () => {
  const driver = createMemoryDriver({ now: () => FIXED_NOW });
  const notReady = (error: unknown) => error instanceof LocalDbError && error.code === "not_ready";
  const unavailable = (error: unknown) =>
    error instanceof LocalDbError && error.code === "driver_unavailable";

  await assert.rejects(() => driver.get("products", "p1"), notReady);
  await assert.rejects(() => driver.query({ table: "products" }), notReady);
  await assert.rejects(() => driver.put("products", [makeRow("p1")]), notReady);
  await assert.rejects(
    () => driver.remove("products", ["p1"], { company_id: "co-1", origin_device: "dev-1" }),
    notReady
  );
  await assert.rejects(() => driver.changes(), notReady);
  await assert.rejects(() => driver.latestSeq(), notReady);
  await assert.rejects(() => driver.transaction(async () => 1), notReady);

  await driver.ready();
  await driver.put("products", [makeRow("p1")]);
  await driver.close();

  await assert.rejects(() => driver.get("products", "p1"), unavailable);
  await assert.rejects(() => driver.query({ table: "products" }), unavailable);
  await assert.rejects(() => driver.put("products", [makeRow("p2")]), unavailable);
  await assert.rejects(
    () => driver.remove("products", ["p1"], { company_id: "co-1", origin_device: "dev-1" }),
    unavailable
  );
  await assert.rejects(() => driver.changes(), unavailable);
  await assert.rejects(() => driver.latestSeq(), unavailable);
  await assert.rejects(() => driver.transaction(async () => 1), unavailable);
});
