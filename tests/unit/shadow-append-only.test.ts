/**
 * La escritura en sombra nunca reescribe ni borra los libros de solo anexado:
 * una venta que cambia en el JSON se ignora y una venta que desaparece se anula
 * con una fila nueva en `sale_voids`, conservando la venta, sus líneas y pagos.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { LocalRow, LocalTable } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createLegacyShadowWriter } from "../../src/services/localDb/legacyShadow";
import { createMemoryShadowIndexStore } from "../../src/services/localDb/shadowIndex";
import { SALE_VOID_REASONS, isSaleVoided } from "../../src/services/localDb/saleLifecycle";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-a";
const NOW = "2026-11-23T12:00:00.000Z";
const SALE_VOIDS = "sale_voids" as unknown as LocalTable;

function legacyState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: {
      storeConfig: { storeName: "Bodega Central" },
      branches: [{ id: "wh-1", name: "Almacén", isMain: true }],
      products: [
        { id: "p-1", name: "Arroz", sku: "A-1", price: 120, costPrice: 90 },
        { id: "p-2", name: "Frijol", sku: "F-1", price: 200, costPrice: 150 }
      ],
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
      cart: [{ id: "cart-line", productId: "p-1", quantity: 1 }],
      ...overrides
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

function readVoids(driver: ReturnType<typeof createMemoryDriver>): Promise<LocalRow[]> {
  return driver.query<LocalRow>({ table: SALE_VOIDS, includeDeleted: true });
}

test("cambiar el precio de una venta en el JSON no reescribe la venta ni sus líneas", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());
  const before = await driver.latestSeq();

  const changed = cloneState();
  changed.state.transactions[0].total = 999;
  changed.state.transactions[0].items[0].price = 999;
  changed.state.transactions[0].items[0].total = 1998;
  const report = await writer.sync(JSON.stringify(changed));

  const sale = await driver.get<LocalRow>("sales", "sale-1");
  const item = await driver.get<LocalRow>("sale_items", "sale-1:item:line-1");
  assert.equal(sale?.total, 240, "la cabecera no se reescribe");
  assert.equal(item?.price, 120, "la línea no se reescribe");
  assert.equal(sale?.version, 1);
  assert.equal(item?.version, 1);

  assert.equal(report?.skipped.sales, 1);
  assert.equal(report?.skipped.sale_items, 1);
  assert.ok(report?.warnings.includes("append_only_skipped:sales"));
  assert.ok(report?.warnings.includes("append_only_skipped:sale_items"));
  // Ninguna reescritura: el journal no avanza.
  assert.equal(await driver.latestSeq(), before);
});

test("quitar una venta del JSON crea UNA anulación y conserva venta, líneas y pagos", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const changed = cloneState();
  changed.state.transactions = [];
  const report = await writer.sync(JSON.stringify(changed));

  assert.deepEqual(report?.voided, ["sale-1"]);
  assert.equal(report?.removed.sales ?? 0, 0, "la venta nunca se borra");
  assert.equal(report?.removed.sale_items ?? 0, 0);
  assert.equal(report?.removed.sale_payments ?? 0, 0);

  assert.ok(await driver.get("sales", "sale-1"), "la cabecera se conserva");
  assert.ok(await driver.get("sale_items", "sale-1:item:line-1"), "la línea se conserva");
  assert.ok(await driver.get("sale_payments", "sale-1:pay:0"), "el pago se conserva");

  const voids = await readVoids(driver);
  assert.equal(voids.length, 1, "una sola anulación");
  assert.equal(isSaleVoided(voids, "sale-1"), true);
  assert.equal(voids[0].reason, SALE_VOID_REASONS.legacy_removed);

  const changes = await driver.changes(0, 1000);
  assert.equal(
    changes.filter((change) => change.table === "sales" && change.op === "delete").length,
    0,
    "no se registra un borrado en el journal"
  );
  const voidChange = changes.find((change) => change.table === SALE_VOIDS && change.op === "upsert");
  assert.ok(voidChange, "la anulación queda en el journal como anexo");
});

test("una segunda pasada no duplica la anulación", async () => {
  const { driver, writer, index } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const removed = cloneState();
  removed.state.transactions = [];
  await writer.sync(JSON.stringify(removed));

  // Otra pasada con el JSON aún distinto (carrito nuevo) vuelve a no ver la venta.
  const again = cloneState();
  again.state.transactions = [];
  again.state.cart = [{ id: "cart-line", productId: "p-1", quantity: 5 }];
  const report = await writer.sync(JSON.stringify(again));

  assert.equal(report?.rawChanged, true);
  assert.deepEqual(report?.voided, []);
  const voids = await readVoids(driver);
  assert.equal(voids.length, 1, "la anulación es idempotente");

  // El índice conserva la venta y aprende la anulación: ni fantasmas ni repetición.
  const saved = await index.load();
  assert.ok(saved.tables.sales?.["sale-1"], "la fila anulada sigue indexada");
  assert.ok(
    Object.keys(saved.tables[SALE_VOIDS] ?? {}).length >= 1,
    "el id de la anulación entra en el índice"
  );
});

test("una venta modificada por el hub no se anula ni se reescribe", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const external = (await driver.get<LocalRow>("sales", "sale-1"))!;
  await driver.put("sales", [{ ...external, total: 500, version: 7 }]);

  const changed = cloneState();
  changed.state.transactions = [];
  const report = await writer.sync(JSON.stringify(changed));

  assert.deepEqual(report?.voided, [], "una fila que la sombra no dejó no se anula");
  assert.equal(report?.removed.sales ?? 0, 0);
  const preserved = await driver.get<LocalRow>("sales", "sale-1");
  assert.equal(preserved?.total, 500);
  assert.equal(preserved?.version, 7);
  assert.equal((await readVoids(driver)).length, 0);
});

test("el catálogo y los saldos siguen actualizándose con normalidad", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const changed = cloneState();
  changed.state.products[0].price = 130;
  changed.state.inventory[0].quantity = 7;
  const report = await writer.sync(JSON.stringify(changed));

  assert.equal(report?.written.products, 1);
  assert.equal(report?.written.stock_balances, 1);
  const product = await driver.get<LocalRow>("products", "p-1");
  const stock = await driver.get<LocalRow>("stock_balances", "stock:p-1:wh-1:base");
  assert.equal(product?.price, 130);
  assert.equal(product?.version, 2);
  assert.equal(stock?.quantity, 7);
});

test("una venta nueva del JSON se anexa aunque las existentes no se toquen", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const changed = cloneState();
  changed.state.transactions.push({
    id: "sale-2",
    warehouseId: "wh-1",
    date: "2026-11-21T10:00:00.000Z",
    total: 120,
    status: "completed",
    items: [{ id: "line-2", product: { id: "p-1" }, quantity: 1, price: 120, total: 120 }],
    payments: [{ currencyCode: "CUP", amount: 120, exchangeRate: 1, method: "cash" }]
  });
  const report = await writer.sync(JSON.stringify(changed));

  assert.equal(report?.written.sales, 1);
  assert.equal((await driver.get<LocalRow>("sales", "sale-2"))?.total, 120);
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))?.version, 1);
});
