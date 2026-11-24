import test from "node:test";
import assert from "node:assert/strict";
import type { LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { INVENTORY_LEDGER_TABLE } from "../../src/services/localDb/appendOnly";
import {
  HotPathError,
  recordCashMovement,
  recordSale,
  type HotSaleInput,
  type HotSaleItemInput,
  type HotSalePaymentInput,
  type RecordSaleInput
} from "../../src/services/localDb/hotPaths";
import {
  createHubOutbox,
  createMemoryCursorStore,
  deleteGroupActionId,
  operationActionId
} from "../../src/services/localDb/hubOutbox";

const AT = "2026-05-01T12:00:00.000Z";
const COMPANY = "co-1";
const DEVICE = "dev-1";

function makeRow(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: AT,
    origin_device: DEVICE,
    deleted_at: null,
    ...fields
  };
}

async function readyDriver() {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  return driver;
}

function saleOf(id: string): {
  sale: HotSaleInput;
  items: HotSaleItemInput[];
  payments: HotSalePaymentInput[];
} {
  return {
    sale: {
      id,
      warehouseId: "w1",
      sessionId: "s1",
      date: AT,
      subtotal: 300,
      tax: 0,
      total: 300,
      userId: "u1",
      status: "completed"
    },
    items: [
      { id: "l1", productId: "p1", productName: "Arroz", quantity: 2, unitPrice: 100, total: 200 },
      {
        id: "l2",
        productId: "p2",
        productName: "Camisa",
        quantity: 1,
        unitPrice: 100,
        total: 100,
        variantLabel: "Talla M",
        serialNumber: "SN-1"
      }
    ],
    payments: [
      { id: "pay1", method: "cash", currencyCode: "CUP", amount: 400, exchangeRate: 1 },
      { id: "pay2", method: "transfer", currencyCode: "USD", amount: 0, exchangeRate: 320 }
    ]
  };
}

function saleInput(id: string, overrides: Partial<RecordSaleInput> = {}): RecordSaleInput {
  return {
    driver: undefined as unknown as RecordSaleInput["driver"],
    companyId: COMPANY,
    deviceId: DEVICE,
    at: AT,
    ...saleOf(id),
    ...overrides
  };
}

test("recordSale escribe venta, líneas, pagos, inventario y saldos en una transacción", async () => {
  const driver = await readyDriver();
  await driver.put("stock_balances", [
    makeRow("stock:p1:w1:base", {
      product_id: "p1",
      warehouse_id: "w1",
      quantity: 10,
      min_quantity: 2
    }),
    makeRow("stock:p2:w1:Talla M", {
      product_id: "p2",
      warehouse_id: "w1",
      variant_label: "Talla M",
      quantity: 5,
      min_quantity: 1
    })
  ]);

  const result = await recordSale({ ...saleInput("s1"), driver });
  assert.equal(result.saleId, "s1");
  assert.equal(result.created, true);
  assert.equal(result.actionId, operationActionId(DEVICE, "sales", "s1", 1));

  const sale = await driver.get<LocalRow>("sales", "s1");
  assert.ok(sale);
  assert.equal(sale?.total, 300);
  assert.equal(sale?.subtotal, 300);
  assert.equal(sale?.warehouse_id, "w1");
  assert.equal(sale?.company_id, COMPANY);
  assert.equal(sale?.origin_device, DEVICE);
  assert.equal(sale?.version, 1);
  // El detalle vive en sus tablas: la cabecera no duplica los arreglos.
  assert.equal(sale?.items, undefined);
  assert.equal(sale?.payments, undefined);

  const items = await driver.query<LocalRow>({
    table: "sale_items",
    where: [{ field: "sale_id", op: "eq", value: "s1" }],
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(items.map((row) => row.id), ["s1:item:l1", "s1:item:l2"]);
  assert.equal(items[0].product_id, "p1");
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].price, 100);
  assert.equal(items[0].total, 200);
  assert.equal(items[1].variant_label, "Talla M");
  assert.equal(items[1].serial_number, "SN-1");

  const payments = await driver.query<LocalRow>({
    table: "sale_payments",
    where: [{ field: "sale_id", op: "eq", value: "s1" }],
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(payments.map((row) => row.id), ["s1:pay:pay1", "s1:pay:pay2"]);
  assert.equal(payments[0].method, "cash");
  assert.equal(payments[0].amount, 400);
  assert.equal(payments[1].currency_code, "USD");
  assert.equal(payments[1].exchange_rate, 320);

  const movements = await driver.query<LocalRow>({
    table: INVENTORY_LEDGER_TABLE,
    where: [{ field: "reference_id", op: "eq", value: "s1" }],
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(movements.map((row) => row.product_id), ["p1", "p2"]);
  assert.deepEqual(movements.map((row) => row.quantity_delta), [-2, -1]);
  assert.equal(movements[0].movement_type, "sale");
  assert.equal(movements[0].warehouse_id, "w1");

  const p1 = await driver.get<LocalRow>("stock_balances", "stock:p1:w1:base");
  assert.equal(p1?.quantity, 8);
  assert.equal(p1?.min_quantity, 2);
  assert.equal(p1?.version, 2);
  assert.equal(p1?.updated_at, AT);

  const p2 = await driver.get<LocalRow>("stock_balances", "stock:p2:w1:Talla M");
  assert.equal(p2?.quantity, 4);
  assert.equal(p2?.min_quantity, 1);
});

test("recordSale es idempotente por id de venta", async () => {
  const driver = await readyDriver();
  const first = await recordSale({ ...saleInput("s1"), driver });
  const seqAfterFirst = await driver.latestSeq();
  const journalAfterFirst = (await driver.changes()).length;

  const second = await recordSale({ ...saleInput("s1"), driver });
  assert.equal(second.created, false);
  assert.equal(second.actionId, first.actionId);
  assert.equal(await driver.latestSeq(), seqAfterFirst);
  assert.equal((await driver.changes()).length, journalAfterFirst);

  // El id manda: un reintento con el cuerpo desactualizado no valida ni escribe.
  const staleInput = saleInput("s1");
  staleInput.sale.total = 999;
  const staleRetry = await recordSale({ ...staleInput, driver });
  assert.equal(staleRetry.created, false);
  assert.equal(staleRetry.actionId, first.actionId);
  assert.equal((await driver.get<LocalRow>("sales", "s1"))?.total, 300);

  const sales = await driver.query<LocalRow>({ table: "sales" });
  assert.equal(sales.length, 1);
  const items = await driver.query<LocalRow>({ table: "sale_items" });
  assert.equal(items.length, 2);
  const payments = await driver.query<LocalRow>({ table: "sale_payments" });
  assert.equal(payments.length, 2);
  const movements = await driver.query<LocalRow>({ table: INVENTORY_LEDGER_TABLE });
  assert.equal(movements.length, 2);
  // El stock se descontó una sola vez (la línea de pago 0 no alteró nada).
  const p1 = await driver.get<LocalRow>("stock_balances", "stock:p1:w1:base");
  assert.equal(p1?.quantity, -2);
});

test("recordSale valida totales e ítems antes de escribir", async () => {
  const driver = await readyDriver();
  const mismatched = saleOf("s1");
  mismatched.sale.total = 999;

  await assert.rejects(
    () => recordSale({ ...saleInput("s1"), ...mismatched, driver }),
    (error: unknown) => error instanceof HotPathError && error.code === "totals_mismatch"
  );
  assert.equal(await driver.latestSeq(), 0);
  assert.deepEqual(await driver.query({ table: "sales" }), []);

  const shortPaid = saleOf("s2");
  shortPaid.payments = [
    { id: "pay1", method: "cash", currencyCode: "CUP", amount: 100, exchangeRate: 1 }
  ];
  await assert.rejects(
    () => recordSale({ ...saleInput("s2"), ...shortPaid, driver }),
    (error: unknown) => error instanceof HotPathError && error.code === "totals_mismatch"
  );

  const brokenLine = saleOf("s3");
  brokenLine.items[0] = { ...brokenLine.items[0], quantity: 0 };
  await assert.rejects(
    () => recordSale({ ...saleInput("s3"), ...brokenLine, driver }),
    (error: unknown) => error instanceof HotPathError && error.code === "invalid_input"
  );

  const noPayments = saleOf("s4");
  noPayments.payments = [];
  await assert.rejects(
    () => recordSale({ ...saleInput("s4"), ...noPayments, driver }),
    (error: unknown) => error instanceof HotPathError && error.code === "invalid_input"
  );

  // Ninguna validación fallida dejó rastro.
  assert.equal(await driver.latestSeq(), 0);
});

test("recordSale acumula saldos y respeta movimientos de inventario explícitos", async () => {
  const driver = await readyDriver();
  await recordSale({ ...saleInput("s1"), driver });
  await recordSale({ ...saleInput("s2"), driver });

  const p1 = await driver.get<LocalRow>("stock_balances", "stock:p1:w1:base");
  assert.equal(p1?.quantity, -4);
  assert.equal(p1?.version, 2);

  const custom = saleOf("s3");
  await recordSale({
    ...saleInput("s3"),
    ...custom,
    driver,
    inventoryMovements: [
      {
        id: "mv-custom",
        productId: "p1",
        warehouseId: "w1",
        quantityDelta: -3,
        movementType: "sale_adjustment"
      }
    ]
  });

  const movement = await driver.get<LocalRow>(INVENTORY_LEDGER_TABLE, "s3:stock:mv-custom");
  assert.ok(movement);
  assert.equal(movement?.movement_type, "sale_adjustment");
  assert.equal(movement?.quantity_delta, -3);
  const p1After = await driver.get<LocalRow>("stock_balances", "stock:p1:w1:base");
  assert.equal(p1After?.quantity, -7);
});

test("recordCashMovement abre el turno y anexa movimientos sin duplicar", async () => {
  const driver = await readyDriver();
  const base = {
    driver,
    companyId: COMPANY,
    deviceId: DEVICE,
    at: AT,
    session: { id: "s1", warehouseId: "w1", openedAt: AT, openingBalance: 100, userId: "u1" }
  };

  const first = await recordCashMovement({
    ...base,
    movements: [
      { id: "m1", type: "expense", amount: 25, currencyCode: "CUP", description: "Hielo" },
      { id: "m2", type: "income", amount: 50, currencyCode: "CUP", description: "Fondo extra" }
    ]
  });
  assert.equal(first.sessionId, "s1");
  assert.deepEqual(first.movementIds, ["s1:mov:m1", "s1:mov:m2"]);
  assert.equal(first.created, true);
  assert.equal(first.actionId, operationActionId(DEVICE, "cash_movements", "s1:mov:m1", 1));

  const seqAfterFirst = await driver.latestSeq();
  const retry = await recordCashMovement({
    ...base,
    movements: [
      { id: "m1", type: "expense", amount: 25, currencyCode: "CUP", description: "Hielo" },
      { id: "m2", type: "income", amount: 50, currencyCode: "CUP", description: "Fondo extra" }
    ]
  });
  assert.equal(retry.created, false);
  assert.deepEqual(retry.movementIds, []);
  assert.equal(retry.actionId, first.actionId);
  assert.equal(await driver.latestSeq(), seqAfterFirst);

  const session = await driver.get<LocalRow>("cash_sessions", "s1");
  assert.equal(session?.opening_balance, 100);
  assert.equal(session?.warehouse_id, "w1");
  assert.equal(session?.status, "open");

  const movements = await driver.query<LocalRow>({
    table: "cash_movements",
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(movements.map((row) => row.id), ["s1:mov:m1", "s1:mov:m2"]);
  assert.equal(movements[0].type, "expense");
  assert.equal(movements[0].amount, 25);
  assert.equal(movements[0].currency_code, "CUP");
  assert.equal(movements[0].session_id, "s1");
  assert.equal(movements[0].description, "Hielo");

  // Un movimiento nuevo sí se anexa al mismo turno.
  const extra = await recordCashMovement({
    ...base,
    movements: [{ id: "m3", type: "expense", amount: 10, currencyCode: "CUP" }]
  });
  assert.deepEqual(extra.movementIds, ["s1:mov:m3"]);
  assert.equal((await driver.query({ table: "cash_movements" })).length, 3);
  // El turno existente no se reescribe.
  assert.equal((await driver.get<LocalRow>("cash_sessions", "s1"))?.version, 1);
});

test("recordCashMovement rechaza movimientos inválidos sin escribir nada", async () => {
  const driver = await readyDriver();
  await assert.rejects(
    () =>
      recordCashMovement({
        driver,
        companyId: COMPANY,
        deviceId: DEVICE,
        movements: [{ id: "m1", type: "income", amount: 0, currencyCode: "CUP" }]
      }),
    (error: unknown) => error instanceof HotPathError && error.code === "invalid_input"
  );

  // Turno inexistente y sin datos para abrirlo: la transacción se revierte.
  await assert.rejects(
    () =>
      recordCashMovement({
        driver,
        companyId: COMPANY,
        deviceId: DEVICE,
        movements: [{ id: "m1", sessionId: "ghost", type: "income", amount: 5, currencyCode: "CUP" }]
      }),
    (error: unknown) => error instanceof HotPathError && error.code === "invalid_input"
  );
  assert.equal(await driver.latestSeq(), 0);
});

test("el outbox arma lotes estables con actionId determinista y borrados agrupados", async () => {
  const driver = await readyDriver();
  await driver.put("products", [makeRow("p1", { name: "Arroz" }), makeRow("p2", { name: "Frijol" })]);
  await recordSale({ ...saleInput("s1"), driver });
  await driver.remove("products", ["p1", "p2"], {
    company_id: COMPANY,
    origin_device: DEVICE,
    at: AT
  });

  const outbox = createHubOutbox(driver, { deviceId: DEVICE, limit: 1000 });
  const first = await outbox.collect(0, 1000);
  const second = await outbox.collect(0, 1000);

  // Repetir la misma ventana produce exactamente el mismo lote.
  assert.deepEqual(second, first);
  assert.ok(first.ops.length > 0);
  assert.ok(first.nextSeq > 0);
  assert.equal(first.nextSeq, await driver.latestSeq());

  // Todos los actionId llevan el formato determinista y no se repiten.
  const actionIds = first.ops.map((op) => op.actionId);
  assert.equal(new Set(actionIds).size, actionIds.length);
  const saleOp = first.ops.find((op) => op.table === "sales");
  assert.ok(saleOp);
  assert.match(saleOp!.actionId, new RegExp(`^${DEVICE}:sales:s1:\\d+$`));
  assert.equal(saleOp!.rows.length, 1);
  assert.deepEqual(saleOp!.deletes, []);

  // Borrados de una misma tabla: una sola operación con ids ordenados.
  const deleteOp = first.ops.find((op) => op.table === "products");
  assert.ok(deleteOp);
  assert.deepEqual(deleteOp!.deletes, ["p1", "p2"]);
  assert.deepEqual(deleteOp!.rows, []);
  const deleteSeq = (await driver.changes()).find(
    (change) => change.table === "products" && change.op === "delete"
  )?.seq;
  assert.equal(deleteOp!.actionId, deleteGroupActionId(DEVICE, "products", deleteSeq!));
});

test("el outbox deduplica escrituras repetidas y persiste el cursor inyectado", async () => {
  const driver = await readyDriver();
  await driver.put("products", [makeRow("p1", { name: "Arroz", price: 10 })]);
  await driver.put("products", [makeRow("p1", { name: "Arroz", price: 12, version: 2 })]);

  const cursor = createMemoryCursorStore(0);
  const outbox = createHubOutbox(driver, { deviceId: DEVICE, cursor });
  const batch = await outbox.collect(0, 500);

  const productOps = batch.ops.filter((op) => op.table === "products");
  assert.equal(productOps.length, 1);
  assert.equal(productOps[0].rows[0].price, 12);
  const lastSeq = (await driver.changes()).filter((change) => change.table === "products").pop()?.seq;
  assert.equal(productOps[0].actionId, operationActionId(DEVICE, "products", "p1", lastSeq!));
  assert.equal(firstDeleteGuard(batch.ops), true);

  // Antes del acuse el cursor no se mueve y el lote se repite igual.
  assert.equal(await outbox.loadCursor(), 0);
  assert.deepEqual((await outbox.collect()).ops, batch.ops);

  await outbox.saveCursor(batch.nextSeq);
  assert.equal(await outbox.loadCursor(), batch.nextSeq);
  const after = await outbox.collect();
  assert.deepEqual(after.ops, []);
  assert.equal(after.nextSeq, batch.nextSeq);
});

/** Todos los lotes de este caso son altas: ningún borrado agrupado. */
function firstDeleteGuard(ops: { deletes: string[] }[]): boolean {
  return ops.every((op) => op.deletes.length === 0);
}
