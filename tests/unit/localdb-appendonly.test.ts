import test from "node:test";
import assert from "node:assert/strict";
import type { LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  APPEND_ONLY_TABLES,
  AppendOnlyError,
  INVENTORY_LEDGER_TABLE,
  assertAppendOnly,
  assertAppendOnlyInsert,
  guardOperation,
  isAppendOnly,
  resolvePhysicalTable
} from "../../src/services/localDb/appendOnly";

const FIXED_NOW = "2026-05-01T12:00:00.000Z";

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

test("APPEND_ONLY_TABLES cubre venta, anulación, caja e inventario", () => {
  assert.deepEqual(
    [...APPEND_ONLY_TABLES].sort(),
    ["cash_movements", "inventory_movements", "sale_items", "sale_payments", "sale_voids", "sales"].sort()
  );
});

test("el libro de inventario se resuelve al nombre físico del esquema", () => {
  // El esquema v1 se llama stock_movements; un esquema futuro podrá usar
  // inventory_movements sin cambiar la API lógica.
  assert.ok(["stock_movements", "inventory_movements"].includes(INVENTORY_LEDGER_TABLE));
  assert.equal(resolvePhysicalTable("inventory_movements"), INVENTORY_LEDGER_TABLE);
  assert.equal(resolvePhysicalTable("sales"), "sales");

  assert.equal(isAppendOnly("inventory_movements"), true);
  assert.equal(isAppendOnly("stock_movements"), true);
  assert.equal(isAppendOnly("cash_movements"), true);
  // La anulación de venta es un libro: se anexa, no se corrige ni se borra.
  assert.equal(isAppendOnly("sale_voids"), true);
  // stock_balances es un saldo: se actualiza y no es de solo anexado.
  assert.equal(isAppendOnly("stock_balances"), false);
});

test("assertAppendOnly rechaza borrados y actualizaciones con código append_only", () => {
  const isAppendOnlyError = (error: unknown) =>
    error instanceof AppendOnlyError && error.code === "append_only";

  assert.throws(() => assertAppendOnly("sales", "delete"), isAppendOnlyError);
  assert.throws(() => assertAppendOnly("sale_items", "delete"), isAppendOnlyError);
  assert.throws(() => assertAppendOnly("sale_payments", "update"), isAppendOnlyError);
  assert.throws(() => assertAppendOnly("sale_voids", "delete"), isAppendOnlyError);
  assert.throws(() => assertAppendOnly("sale_voids", "update"), isAppendOnlyError);
  assert.throws(() => assertAppendOnly("cash_movements", "delete"), isAppendOnlyError);
  assert.throws(() => assertAppendOnly("stock_movements", "update"), isAppendOnlyError);

  // Insertar y anexar sí se permiten; el id nuevo lo comprueba la transacción.
  assert.doesNotThrow(() => assertAppendOnly("sales", "insert"));
  assert.doesNotThrow(() => assertAppendOnly("sales", "upsert"));
  // Una tabla que no es de solo anexado no se bloquea.
  assert.doesNotThrow(() => assertAppendOnly("stock_balances", "delete"));
  assert.doesNotThrow(() => assertAppendOnly("products", "update"));
});

test("guardOperation no ejecuta la escritura bloqueada", async () => {
  let executed = false;
  await assert.rejects(
    () =>
      guardOperation("sales", "delete", async () => {
        executed = true;
        return "borrado";
      }),
    (error: unknown) => error instanceof AppendOnlyError && error.code === "append_only"
  );
  assert.equal(executed, false);

  const allowed = await guardOperation("sale_items", "insert", async () => "anexado");
  assert.equal(allowed, "anexado");
});

test("assertAppendOnlyInsert rechaza reescribir una fila que ya existe", async () => {
  const driver = await readyDriver();
  await driver.put("sales", [makeRow("s1", { total: 100 })]);
  const beforeSeq = await driver.latestSeq();

  await assert.rejects(
    () =>
      driver.transaction(async (tx) => {
        await assertAppendOnlyInsert(tx, "sales", [makeRow("s1", { total: 999 })]);
      }),
    (error: unknown) => error instanceof AppendOnlyError && error.code === "append_only"
  );

  // La transacción no dejó rastro: ni fila modificada ni cambios nuevos.
  assert.equal((await driver.get<LocalRow>("sales", "s1"))?.total, 100);
  assert.equal(await driver.latestSeq(), beforeSeq);

  // Un id nuevo sí pasa la guarda.
  await driver.transaction(async (tx) => {
    await assertAppendOnlyInsert(tx, "sales", [makeRow("s2", { total: 50 })]);
    await tx.put("sales", [makeRow("s2", { total: 50 })]);
  });
  assert.equal((await driver.get<LocalRow>("sales", "s2"))?.total, 50);
});

test("assertAppendOnlyInsert deja pasar tablas que no son de solo anexado", async () => {
  const driver = await readyDriver();
  await driver.put("stock_balances", [makeRow("b1", { quantity: 5 })]);
  await driver.transaction(async (tx) => {
    // El saldo se actualiza: la guarda de anexado no participa.
    await assertAppendOnlyInsert(tx, "stock_balances", [makeRow("b1", { quantity: 7 })]);
    await tx.put("stock_balances", [makeRow("b1", { quantity: 7 })]);
  });
  assert.equal((await driver.get<LocalRow>("stock_balances", "b1"))?.quantity, 7);
  assert.equal(await driver.latestSeq(), 2);
});

test("sale_voids se resuelve y se anexa igual que el resto de libros", async () => {
  assert.equal(resolvePhysicalTable("sale_voids"), "sale_voids");

  const driver = await readyDriver();
  const voidRow = makeRow("void:s1", {
    sale_id: "s1",
    branch_id: "w1",
    reason: "user_void",
    voided_at: FIXED_NOW,
    created_by: null
  });
  await driver.transaction(async (tx) => {
    await assertAppendOnlyInsert(tx, "sale_voids", [voidRow]);
    await tx.put("sale_voids", [voidRow]);
  });
  assert.equal((await driver.get<LocalRow>("sale_voids", "void:s1"))?.reason, "user_void");
  const seqBefore = await driver.latestSeq();

  // Reescribir la misma anulación (aunque cambie el motivo) sigue prohibido.
  await assert.rejects(
    () =>
      driver.transaction(async (tx) => {
        await assertAppendOnlyInsert(tx, "sale_voids", [{ ...voidRow, reason: "corregido" }]);
      }),
    (error: unknown) => error instanceof AppendOnlyError && error.code === "append_only"
  );
  assert.equal((await driver.get<LocalRow>("sale_voids", "void:s1"))?.reason, "user_void");
  assert.equal(await driver.latestSeq(), seqBefore);
  // La guarda es por id; la unicidad por venta la garantiza `saleLifecycle`.
  await driver.transaction(async (tx) => {
    const extra = makeRow("void:s1:reintento", { ...voidRow, id: "void:s1:reintento" });
    await assertAppendOnlyInsert(tx, "sale_voids", [extra]);
    await tx.put("sale_voids", [extra]);
  });
  assert.equal(
    (await driver.query<LocalRow>({ table: "sale_voids", includeDeleted: true })).length,
    2
  );
});
