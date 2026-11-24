/**
 * Escritura directa del POS en el almacén normalizado.
 *
 * Fija el contrato: la venta cerrada produce exactamente las mismas filas que
 * la sombra (sales, sale_items, sale_payments), la anulación anexa sale_voids,
 * el movimiento de caja se anexa a cash_movements, todo es idempotente por id,
 * la bandera de corte desactiva la escritura y ningún fallo del driver llega
 * al llamador.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CartItem, CashMovement, CashRegisterSession, Payment, Transaction } from "../../src/types";
import type { LocalDbDriver, LocalRow, LocalTable } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { SALE_VOID_REASONS, assertSaleNotVoided, isSaleVoided } from "../../src/services/localDb/saleLifecycle";
import {
  mirrorCashMovement,
  mirrorCompletedSale,
  mirrorSaleVoid
} from "../../src/services/localDb/posWriteThrough";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-a";
const AT = "2026-11-25T10:00:00.000Z";
const SALE_VOIDS = "sale_voids" as LocalTable;

function cartItem(id: string, productId: string, name: string): CartItem {
  return {
    id,
    product: {
      id: productId,
      name,
      sku: `SKU-${productId}`,
      costPrice: 90,
      price: 120,
      margin: 30,
      categoryId: "cat-1",
      color: "bg-white",
      commissionValue: 0
    },
    quantity: 2,
    price: 120,
    total: 240,
    variantLabel: "M"
  };
}

function cashPayment(amount: number): Payment {
  return { currencyCode: "CUP", amount, exchangeRate: 1, method: "cash" };
}

function completedSale(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "sale-1",
    remoteId: "22222222-2222-4222-8222-222222222222",
    ticketNumber: "TK-0001",
    warehouseId: "wh-1",
    branchId: "wh-1",
    userId: "user-1",
    cashierName: "Ana",
    date: AT,
    subtotal: 480,
    tax: 0,
    discount: 0,
    total: 480,
    payments: [cashPayment(300), cashPayment(180)],
    items: [cartItem("line-1", "p-1", "Arroz"), cartItem("line-2", "p-2", "Frijol")],
    status: "completed",
    sessionId: "turno-1",
    ...overrides
  };
}

function session(): CashRegisterSession {
  return {
    id: "turno-1",
    warehouseId: "wh-1",
    branchId: "wh-1",
    openedAt: AT,
    openingBalance: 100,
    status: "open",
    userId: "user-1",
    workerName: "Ana",
    movements: []
  };
}

function movement(id: string): CashMovement {
  return {
    id,
    type: "income",
    amount: 50,
    currencyCode: "CUP",
    description: "Fondo adicional",
    date: AT,
    sessionId: "turno-1",
    branchId: "wh-1"
  };
}

async function readyDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  return driver;
}

function options(driver: LocalDbDriver) {
  return { driver, companyId: COMPANY, deviceId: DEVICE, now: AT };
}

async function count(driver: LocalDbDriver, table: LocalTable): Promise<number> {
  const rows = await driver.query<LocalRow>({ table });
  return rows.length;
}

test("mirrorCompletedSale escribe la venta, sus líneas y sus pagos una sola vez", async () => {
  const driver = await readyDriver();
  const sale = completedSale();

  const first = await mirrorCompletedSale(sale, options(driver));
  assert.equal(first.written, true);
  assert.equal(await count(driver, "sales"), 1);
  assert.equal(await count(driver, "sale_items"), 2);
  assert.equal(await count(driver, "sale_payments"), 2);

  const stored = await driver.get<LocalRow>("sales", sale.id);
  assert.equal(stored?.company_id, COMPANY);
  assert.equal(stored?.origin_device, DEVICE);
  assert.equal(stored?.total, 480);
  assert.equal(stored?.warehouse_id, "wh-1");
  assert.ok(await driver.get("sale_items", "sale-1:item:line-1"));
  assert.ok(await driver.get("sale_payments", "sale-1:pay:0"));
  // El stock no lo escribe esta capa: la sombra mantiene los saldos.
  assert.equal(await count(driver, "stock_balances"), 0);
  assert.equal(await count(driver, "stock_movements"), 0);

  // Repetir es idempotente por id: ni filas nuevas ni reescrituras.
  const seqBefore = await driver.latestSeq();
  const second = await mirrorCompletedSale(sale, options(driver));
  assert.equal(second.written, false);
  assert.equal(await driver.latestSeq(), seqBefore);
  assert.equal(await count(driver, "sales"), 1);
  assert.equal(await count(driver, "sale_items"), 2);
  assert.equal(await count(driver, "sale_payments"), 2);
});

test("una venta no cerrada o borrada no se escribe", async () => {
  const driver = await readyDriver();

  const pending = await mirrorCompletedSale(completedSale({ status: "pending" as Transaction["status"] }), options(driver));
  const deleted = await mirrorCompletedSale(completedSale({ deletedAt: AT }), options(driver));

  assert.equal(pending.written, false);
  assert.equal(deleted.written, false);
  assert.equal(await count(driver, "sales"), 0);
});

test("la bandera VITE_LOCAL_DB_POS_WRITE=0 y enabled=false desactivan la escritura", async () => {
  const driver = await readyDriver();
  const previous = process.env.VITE_LOCAL_DB_POS_WRITE;
  process.env.VITE_LOCAL_DB_POS_WRITE = "0";
  try {
    const flagged = await mirrorCompletedSale(completedSale(), options(driver));
    assert.equal(flagged.written, false);
    assert.equal(await count(driver, "sales"), 0);
  } finally {
    if (previous === undefined) delete process.env.VITE_LOCAL_DB_POS_WRITE;
    else process.env.VITE_LOCAL_DB_POS_WRITE = previous;
  }

  const disabled = await mirrorCompletedSale(completedSale(), { ...options(driver), enabled: false });
  assert.equal(disabled.written, false);
  assert.equal(await count(driver, "sales"), 0);

  // Sin bandera (o con otro valor) la escritura sigue activa.
  process.env.VITE_LOCAL_DB_POS_WRITE = "1";
  try {
    const enabled = await mirrorCompletedSale(completedSale(), options(driver));
    assert.equal(enabled.written, true);
    assert.equal(await count(driver, "sales"), 1);
  } finally {
    if (previous === undefined) delete process.env.VITE_LOCAL_DB_POS_WRITE;
    else process.env.VITE_LOCAL_DB_POS_WRITE = previous;
  }
});

test("mirrorSaleVoid anexa la anulación en sale_voids y no duplica", async () => {
  const driver = await readyDriver();
  await mirrorCompletedSale(completedSale(), options(driver));
  const voided = completedSale({ deletedAt: AT, deletedBy: "user-9", deleteReason: "Error de cobro" });

  const first = await mirrorSaleVoid(voided, options(driver));
  assert.equal(first.written, true);
  const rows = await driver.query<LocalRow>({ table: SALE_VOIDS, includeDeleted: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "void:sale-1");
  assert.equal(rows[0].sale_id, "sale-1");
  assert.equal(rows[0].branch_id, "wh-1");
  assert.equal(rows[0].reason, SALE_VOID_REASONS.user_void);
  assert.equal(rows[0].created_by, "user-9");
  assert.equal(isSaleVoided(rows, "sale-1"), true);
  assert.equal(await assertSaleNotVoided(driver, "sale-1"), false);
  // La venta original y sus líneas siguen intactas.
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))?.deleted_at, null);
  assert.equal(await count(driver, "sale_items"), 2);

  const seqBefore = await driver.latestSeq();
  const second = await mirrorSaleVoid(voided, options(driver));
  assert.equal(second.written, false);
  assert.equal(await driver.latestSeq(), seqBefore);
  assert.equal(await count(driver, SALE_VOIDS), 1);
});

test("mirrorSaleVoid respeta un motivo válido de SALE_VOID_REASONS", async () => {
  const driver = await readyDriver();
  await mirrorCompletedSale(completedSale(), options(driver));

  const result = await mirrorSaleVoid(completedSale(), { ...options(driver), reason: SALE_VOID_REASONS.refund_full });
  assert.equal(result.written, true);
  const row = await driver.get<LocalRow>(SALE_VOIDS, "void:sale-1");
  assert.equal(row?.reason, SALE_VOID_REASONS.refund_full);
  assert.equal(row?.created_by, "user-1");

  // Sin autor ni fecha de baja el documento se anexa como venta retirada.
  const legacy = completedSale({ id: "sale-2" });
  await mirrorCompletedSale(legacy, options(driver));
  await mirrorSaleVoid(legacy, options(driver));
  assert.equal((await driver.get<LocalRow>(SALE_VOIDS, "void:sale-2"))?.reason, SALE_VOID_REASONS.legacy_removed);
});

test("mirrorCashMovement anexa el movimiento de caja sin duplicar", async () => {
  const driver = await readyDriver();
  const turn = session();
  const cash = movement("mov-1");

  const first = await mirrorCashMovement(turn, cash, options(driver));
  assert.equal(first.written, true);
  assert.equal(await count(driver, "cash_sessions"), 1);
  assert.equal(await count(driver, "cash_movements"), 1);

  const stored = await driver.get<LocalRow>("cash_movements", "turno-1:mov:mov-1");
  assert.ok(stored);
  assert.equal(stored?.session_id, "turno-1");
  assert.equal(stored?.company_id, COMPANY);
  assert.equal(stored?.type, "income");
  assert.equal(stored?.amount, 50);
  assert.equal(stored?.currency_code, "CUP");

  const seqBefore = await driver.latestSeq();
  const second = await mirrorCashMovement(turn, cash, options(driver));
  assert.equal(second.written, false);
  assert.equal(await driver.latestSeq(), seqBefore);
  assert.equal(await count(driver, "cash_sessions"), 1);
  assert.equal(await count(driver, "cash_movements"), 1);

  // Un segundo movimiento del mismo turno se anexa sin tocar el primero.
  const third = await mirrorCashMovement(turn, movement("mov-2"), options(driver));
  assert.equal(third.written, true);
  assert.equal(await count(driver, "cash_movements"), 2);
  assert.equal(await count(driver, "cash_sessions"), 1);
});

test("un driver que lanza no propaga la excepción: resuelve written=false", async () => {
  const base = await readyDriver();
  const failing: LocalDbDriver = {
    ...base,
    transaction: () => Promise.reject(new Error("almacén no disponible")),
    get: () => Promise.reject(new Error("almacén no disponible"))
  };

  const sale = await mirrorCompletedSale(completedSale(), options(failing));
  assert.deepEqual(sale, { written: false });

  const voided = await mirrorSaleVoid(completedSale({ deletedAt: AT }), options(failing));
  assert.deepEqual(voided, { written: false });

  const cash = await mirrorCashMovement(session(), movement("mov-1"), options(failing));
  assert.deepEqual(cash, { written: false });
});
