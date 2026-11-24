/**
 * Guardas de la escritura en sombra sobre los libros de solo anexado.
 *
 * Estas pruebas fijan la garantía del hub: ventas, líneas, pagos, caja,
 * movimientos de inventario y anulaciones son inmutables. La sombra puede
 * anexar filas nuevas, pero jamás reescribe una existente ni borra una fila;
 * una venta que desaparece del JSON se compensa con `sale_voids`, y si esa
 * anulación falla se avisa y se reintenta sin perder nada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  LocalDbDriver,
  LocalDbTransaction,
  LocalRow,
  LocalTable,
  QuerySpec
} from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createLegacyShadowWriter } from "../../src/services/localDb/legacyShadow";
import { createMemoryShadowIndexStore } from "../../src/services/localDb/shadowIndex";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-a";
const NOW = "2026-11-23T12:00:00.000Z";
const SALE_VOIDS = "sale_voids" as unknown as LocalTable;

/** Libros de negocio que la sombra nunca debe reescribir ni podar. */
const APPEND_ONLY_TABLES: LocalTable[] = [
  "sales",
  "sale_items",
  "sale_payments",
  "cash_movements",
  "stock_movements"
];

function legacyState(): string {
  return JSON.stringify({
    state: {
      storeConfig: { storeName: "Bodega Central" },
      branches: [{ id: "wh-1", name: "Almacén", isMain: true }],
      products: [{ id: "p-1", name: "Arroz", sku: "A-1", price: 120 }],
      inventory: [{ productId: "p-1", warehouseId: "wh-1", quantity: 10, minQuantity: 2 }],
      transactions: [
        {
          id: "sale-1",
          warehouseId: "wh-1",
          userId: "u-1",
          date: "2026-11-20T10:00:00.000Z",
          total: 240,
          status: "completed",
          items: [{ id: "line-1", product: { id: "p-1" }, quantity: 2, price: 120, total: 240 }],
          payments: [{ currencyCode: "CUP", amount: 240, exchangeRate: 1, method: "cash" }]
        }
      ],
      cashSessions: [{ id: "turno-1", warehouseId: "wh-1", status: "open" }],
      cart: []
    },
    version: 2
  });
}

function cloneState(): Record<string, any> {
  return JSON.parse(legacyState());
}

function setup() {
  const driver = createMemoryDriver({ now: () => NOW });
  const index = createMemoryShadowIndexStore();
  const writer = createLegacyShadowWriter({
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    index,
    now: () => NOW
  });
  return { driver, writer, index };
}

function row(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: NOW,
    origin_device: DEVICE,
    deleted_at: null,
    ...fields
  };
}

function readVoids(driver: LocalDbDriver): Promise<LocalRow[]> {
  return driver.query<LocalRow>({ table: SALE_VOIDS, includeDeleted: true });
}

/** Driver que rechaza anexar en `sale_voids` mientras `gate.fail` esté activo. */
function driverWithVoidGate(base: LocalDbDriver, gate: { fail: boolean }): LocalDbDriver {
  return {
    ...base,
    transaction: <T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T> =>
      base.transaction((tx) =>
        fn({
          get: <R extends LocalRow>(table: Parameters<LocalDbTransaction["get"]>[0], id: string) =>
            tx.get<R>(table, id),
          query: <R extends LocalRow>(spec: QuerySpec) => tx.query<R>(spec),
          put: <R extends LocalRow>(table: Parameters<LocalDbTransaction["put"]>[0], rows: R[]) =>
            gate.fail && table === SALE_VOIDS
              ? Promise.reject(new Error("fallo simulado al anexar la anulación"))
              : tx.put(table, rows),
          remove: (table, ids, meta) => tx.remove(table, ids, meta)
        })
      )
  };
}

test("los libros de solo anexado no reciben updates ni deletes de la sombra", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  // Movimientos de caja e inventario escritos por la ruta caliente.
  const cashMovement = row("cm-1", { session_id: "turno-1", amount: 240, type: "sale" });
  const stockMovement = row("sm-1", { product_id: "p-1", quantity: -2, type: "sale" });
  await driver.put("cash_movements", [cashMovement]);
  await driver.put("stock_movements", [stockMovement]);
  const seqAfterSeed = await driver.latestSeq();

  // Primero una venta modificada y después la venta retirada del JSON.
  const edited = cloneState();
  edited.state.transactions[0].total = 999;
  edited.state.transactions[0].status = "refunded";
  edited.state.transactions[0].items[0].price = 999;
  edited.state.transactions[0].payments[0].amount = 999;
  await writer.sync(JSON.stringify(edited));

  const removed = cloneState();
  removed.state.transactions = [];
  const report = await writer.sync(JSON.stringify(removed));

  assert.deepEqual(report?.voided, ["sale-1"], "la venta se compensa con una anulación");

  const sale = await driver.get<LocalRow>("sales", "sale-1");
  const item = await driver.get<LocalRow>("sale_items", "sale-1:item:line-1");
  const payment = await driver.get<LocalRow>("sale_payments", "sale-1:pay:0");
  assert.equal(sale?.total, 240);
  assert.equal(sale?.status, "completed");
  assert.equal(sale?.version, 1);
  assert.equal(item?.price, 120);
  assert.equal(item?.version, 1);
  assert.equal(payment?.amount, 240);
  assert.deepEqual(await driver.get<LocalRow>("cash_movements", "cm-1"), cashMovement);
  assert.deepEqual(await driver.get<LocalRow>("stock_movements", "sm-1"), stockMovement);

  // Ni una sola escritura tardía sobre los libros, y ningún borrado jamás.
  const later = await driver.changes(seqAfterSeed, 1000);
  const bookWrites = later.filter(
    (change) => APPEND_ONLY_TABLES.includes(change.table) || (change.table as string) === "sale_voids"
  );
  assert.deepEqual(bookWrites.map((change) => `${change.table}:${change.op}`), [
    "sale_voids:upsert"
  ]);
  assert.deepEqual(
    later.filter((change) => change.op === "delete"),
    [],
    "la sombra no borra ninguna fila"
  );
});

test("una venta que ya existía en el almacén no se reescribe ni se reclama", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  // Fila previa (hub / cola offline) con el mismo id que la del JSON legado.
  await driver.put("sales", [row("sale-1", { total: 111, status: "completed", version: 3 })]);
  const seqAfterSeed = await driver.latestSeq();

  const report = await writer.sync(legacyState());
  assert.equal(report?.written.sales ?? 0, 0, "la fila existente no se escribe");
  assert.equal(report?.skipped.sales, 1);
  const preserved = await driver.get<LocalRow>("sales", "sale-1");
  assert.equal(preserved?.total, 111);
  assert.equal(preserved?.version, 3);
  const saleWrites = (await driver.changes(seqAfterSeed, 500)).filter(
    (change) => change.table === "sales" || (change.table as string) === "sale_voids"
  );
  assert.deepEqual(saleWrites, [], "la cabecera existente no se toca ni se adopta");

  // Como la sombra no la escribió, retirarla del JSON tampoco la anula.
  const removed = cloneState();
  removed.state.transactions = [];
  const second = await writer.sync(JSON.stringify(removed));
  assert.deepEqual(second?.voided, []);
  assert.equal((await readVoids(driver)).length, 0);
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))?.total, 111);
});

test("una anulación ya registrada por otra capa evita duplicados", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  await driver.put(SALE_VOIDS, [
    row("void:externo", { sale_id: "sale-1", reason: "user_void", voided_at: NOW })
  ]);
  const seqAfterSeed = await driver.latestSeq();

  const removed = cloneState();
  removed.state.transactions = [];
  const report = await writer.sync(JSON.stringify(removed));

  assert.deepEqual(report?.voided, []);
  const voids = await readVoids(driver);
  assert.equal(voids.length, 1);
  assert.equal(voids[0].id, "void:externo", "la anulación existente manda");
  assert.deepEqual(await driver.changes(seqAfterSeed, 500), []);
});

test("si la anulación falla se avisa y la pasada siguiente la reintenta", async () => {
  const base = createMemoryDriver({ now: () => NOW });
  await base.ready();
  const gate = { fail: true };
  const driver = driverWithVoidGate(base, gate);
  const writer = createLegacyShadowWriter({
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    index: createMemoryShadowIndexStore(),
    now: () => NOW
  });

  await writer.sync(legacyState());
  const removed = cloneState();
  removed.state.transactions = [];
  const failed = await writer.sync(JSON.stringify(removed));

  assert.deepEqual(failed?.voided, []);
  assert.ok(failed?.warnings.includes("sale_void_failed:sale-1"));
  assert.equal((await readVoids(base)).length, 0);
  // Nada se pierde: venta, líneas y pagos siguen en el almacén.
  assert.ok(await base.get("sales", "sale-1"));
  assert.ok(await base.get("sale_items", "sale-1:item:line-1"));
  assert.ok(await base.get("sale_payments", "sale-1:pay:0"));

  // El JSON no cambia, pero el índice no avanzó: se reintenta y ahora sí anula.
  gate.fail = false;
  const retry = await writer.sync(JSON.stringify(removed));
  assert.deepEqual(retry?.voided, ["sale-1"]);
  assert.equal(retry?.warnings.includes("sale_void_failed:sale-1"), false);
  assert.equal((await readVoids(base)).length, 1);
});

test("perder el índice no borra las anulaciones ya registradas", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const removed = cloneState();
  removed.state.transactions = [];
  await writer.sync(JSON.stringify(removed));
  assert.equal((await readVoids(driver)).length, 1);

  // Otra instancia arranca con el índice vacío (IndexedDB borrado o nueva
  // instalación) y vuelve a pasar el mismo JSON: el libro no se poda.
  const fresh = createLegacyShadowWriter({
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    index: createMemoryShadowIndexStore(),
    now: () => NOW
  });
  const report = await fresh.sync(JSON.stringify(removed));

  assert.deepEqual(report?.voided, [], "la venta ya estaba anulada");
  assert.equal((await readVoids(driver)).length, 1, "la anulación sobrevive al índice perdido");
  assert.ok(await driver.get("sales", "sale-1"));
});
