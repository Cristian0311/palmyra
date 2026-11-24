import assert from "node:assert/strict";
import test from "node:test";
import type { LocalRow, LocalTable } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createLegacyShadowWriter, shadowRowHash } from "../../src/services/localDb/legacyShadow";
import { SALE_VOID_REASONS, isSaleVoided } from "../../src/services/localDb/saleLifecycle";
import { createMemoryShadowIndexStore } from "../../src/services/localDb/shadowIndex";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-a";
const SALE_VOIDS = "sale_voids" as unknown as LocalTable;

/** Anulaciones almacenadas; la tabla aún no está en `LocalTable`. */
function readVoids(driver: ReturnType<typeof createMemoryDriver>): Promise<LocalRow[]> {
  return driver.query<LocalRow>({ table: SALE_VOIDS, includeDeleted: true });
}

function legacyState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: {
      storeConfig: { storeName: "Bodega Central", address: "Calle 1", phone: "555" },
      branches: [{ id: "wh-1", name: "Almacén", isMain: true }],
      products: [
        { id: "p-1", name: "Arroz", sku: "A-1", price: 120, costPrice: 90, categoryId: "c-1" },
        { id: "p-2", name: "Frijol", sku: "F-1", price: 200, costPrice: 150, categoryId: "c-1" }
      ],
      inventory: [
        { productId: "p-1", warehouseId: "wh-1", quantity: 10, minQuantity: 2 },
        { productId: "p-2", warehouseId: "wh-1", quantity: 4, minQuantity: 1 }
      ],
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
      cashSessions: [{ id: "turno-1", warehouseId: "wh-1", status: "open", openedAt: "2026-11-20T08:00:00.000Z" }],
      cart: [{ id: "cart-line", productId: "p-1", quantity: 1 }],
      ...overrides
    },
    version: 2
  });
}

function setup(now = () => "2026-11-23T12:00:00.000Z") {
  const driver = createMemoryDriver({ now });
  const index = createMemoryShadowIndexStore();
  const writer = createLegacyShadowWriter({
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    index,
    now
  });
  return { driver, writer, index };
}

test("la primera pasada crea la empresa, el almacén y las filas de negocio", async () => {
  const { driver, writer } = setup();
  await driver.ready();

  const report = await writer.sync(legacyState());
  assert.ok(report);
  assert.equal(report.rawChanged, true);
  assert.equal(report.written.companies, 1);
  assert.equal(report.written.company_settings, 1);
  assert.equal(report.written.warehouses, 1);
  assert.equal(report.written.products, 2);
  assert.equal(report.written.stock_balances, 2);
  assert.equal(report.written.sales, 1);
  assert.equal(report.written.cash_sessions, 1);

  const company = await driver.get("companies", COMPANY);
  assert.equal(company?.name, "Bodega Central");
  assert.equal(company?.company_id, COMPANY);

  const product = await driver.get<LocalRow>("products", "p-1");
  assert.equal(product?.name, "Arroz");
  assert.equal(product?.version, 1);
  assert.equal(product?.origin_device, DEVICE);

  const stock = await driver.get<LocalRow>("stock_balances", "stock:p-1:wh-1:base");
  assert.equal(stock?.quantity, 10);

  assert.ok((await driver.latestSeq()) > 0);
});

test("volver a sincronizar el mismo JSON no escribe nada", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());
  const seqAfterFirst = await driver.latestSeq();

  const second = await writer.sync(legacyState());
  assert.equal(second?.rawChanged, false);
  assert.equal(await driver.latestSeq(), seqAfterFirst);
});

test("un cambio puntual incrementa versión solo en la fila afectada", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());
  const before = await driver.latestSeq();

  const changed = JSON.parse(legacyState());
  changed.state.products[0].name = "Arroz Premium";
  const report = await writer.sync(JSON.stringify(changed));

  assert.equal(report?.written.products, 1);
  // Una fila escrita = un registro en el journal.
  assert.equal((await driver.latestSeq()) - before, 1);

  const updated = await driver.get<LocalRow>("products", "p-1");
  const untouched = await driver.get<LocalRow>("products", "p-2");
  assert.equal(updated?.name, "Arroz Premium");
  assert.equal(updated?.version, 2);
  assert.equal(untouched?.version, 1);
});

test("cambiar solo el carrito no toca el almacén", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());
  const before = await driver.latestSeq();

  const changed = JSON.parse(legacyState());
  changed.state.cart = [
    { id: "cart-line", productId: "p-1", quantity: 3 },
    { id: "cart-line-2", productId: "p-2", quantity: 1 }
  ];
  const report = await writer.sync(JSON.stringify(changed));

  assert.equal(report?.rawChanged, true);
  assert.deepEqual(report?.written, {});
  assert.equal(await driver.latestSeq(), before);
});

test("quitar una venta del JSON legado registra una anulación sin borrarla", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const changed = JSON.parse(legacyState());
  changed.state.transactions = [];
  const report = await writer.sync(JSON.stringify(changed));

  // La venta es un libro de solo anexado: se conserva y se compensa con un void.
  assert.equal(report?.removed.sales ?? 0, 0);
  assert.deepEqual(report?.voided, ["sale-1"]);
  const sale = await driver.get<LocalRow>("sales", "sale-1");
  assert.equal(sale?.total, 240);
  assert.equal(sale?.version, 1);
  assert.ok(await driver.get("sale_items", "sale-1:item:line-1"));
  assert.ok(await driver.get("sale_payments", "sale-1:pay:0"));

  // La anulación es un documento nuevo, con el motivo estable del retiro.
  const voids = await readVoids(driver);
  assert.equal(voids.length, 1);
  assert.equal(voids[0].sale_id, "sale-1");
  assert.equal(voids[0].reason, SALE_VOID_REASONS.legacy_removed);
  assert.equal(isSaleVoided(voids, "sale-1"), true);

  const changes = await driver.changes(0, 500);
  const deletions = changes.filter((change) => change.op === "delete");
  assert.deepEqual(deletions, []);
  const voidRow = changes.find(
    (change) => (change.table as string) === "sale_voids" && change.op === "upsert"
  );
  assert.ok(voidRow);
});

test("una venta modificada en el JSON no reescribe la cabecera almacenada", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());
  const before = await driver.latestSeq();

  const changed = JSON.parse(legacyState());
  changed.state.transactions[0].total = 999;
  changed.state.transactions[0].status = "refunded";
  changed.state.transactions[0].items[0].price = 999;
  const report = await writer.sync(JSON.stringify(changed));

  const sale = await driver.get<LocalRow>("sales", "sale-1");
  const item = await driver.get<LocalRow>("sale_items", "sale-1:item:line-1");
  assert.equal(sale?.total, 240, "la cabecera conserva el importe original");
  assert.equal(sale?.status, "completed", "la cabecera conserva el estado original");
  assert.equal(sale?.version, 1);
  assert.equal(item?.price, 120, "la línea conserva su precio");
  assert.equal(item?.version, 1);

  // La fila existente se cuenta como no escrita y se avisa con código estable.
  assert.equal(report?.written.sales ?? 0, 0);
  assert.equal(report?.skipped.sales, 1);
  assert.ok((report?.unchanged ?? 0) >= 1);
  assert.ok(report?.warnings.includes("append_only_skipped:sales"));
  // Ni reescritura ni borrado: el journal no avanza.
  assert.equal(await driver.latestSeq(), before);
});

test("una segunda pasada sin cambios no duplica la anulación", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const removed = JSON.parse(legacyState());
  removed.state.transactions = [];
  await writer.sync(JSON.stringify(removed));
  const seqAfterVoid = await driver.latestSeq();
  assert.equal((await readVoids(driver)).length, 1);

  // Mismo JSON exacto: la pasada ni siquiera entra.
  const identical = await writer.sync(JSON.stringify(removed));
  assert.equal(identical?.rawChanged, false);

  // Un cambio en otra colección vuelve a recorrer ventas sin anular de nuevo.
  const again = JSON.parse(JSON.stringify(removed));
  again.state.products[0].price = 130;
  const report = await writer.sync(JSON.stringify(again));

  assert.deepEqual(report?.voided, []);
  assert.equal(report?.removed.sales ?? 0, 0);
  assert.equal((await readVoids(driver)).length, 1, "la anulación es idempotente");
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))?.version, 1);
  const laterVoids = (await driver.changes(seqAfterVoid, 500)).filter(
    (change) => (change.table as string) === "sale_voids"
  );
  assert.deepEqual(laterVoids, []);
});

test("las tablas mutables se actualizan y se borran cuando el JSON las retira", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());
  const before = await driver.latestSeq();

  const changed = JSON.parse(legacyState());
  changed.state.products[0].price = 130;
  changed.state.products = [changed.state.products[0]];
  changed.state.cashSessions[0].status = "closed";
  const report = await writer.sync(JSON.stringify(changed));

  const updated = await driver.get<LocalRow>("products", "p-1");
  assert.equal(updated?.price, 130);
  assert.equal(updated?.version, 2);
  assert.equal(await driver.get("products", "p-2"), null, "la fila retirada se borra");
  assert.equal(report?.removed.products, 1);
  assert.equal((await driver.get<LocalRow>("cash_sessions", "turno-1"))?.status, "closed");

  const changes = await driver.changes(before, 500);
  assert.ok(
    changes.some(
      (change) => change.table === "products" && change.op === "delete" && change.row_id === "p-2"
    )
  );
  // El libro de ventas sigue intacto aunque el catálogo cambie.
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))?.version, 1);
});

test("una fila modificada fuera de la sombra no se borra al desaparecer del JSON", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const external = (await driver.get<LocalRow>("products", "p-2"))!;
  await driver.put("products", [{ ...external, name: "Frijol importado", version: 7 }]);

  const changed = JSON.parse(legacyState());
  changed.state.products = [changed.state.products[0]];
  const report = await writer.sync(JSON.stringify(changed));

  assert.equal(report?.removed.products ?? 0, 0);
  const stillThere = await driver.get<LocalRow>("products", "p-2");
  assert.equal(stillThere?.name, "Frijol importado");
  assert.equal(stillThere?.version, 7);
});

test("un JSON inválido se descarta sin escribir ni perder el índice", async () => {
  const { driver, writer, index } = setup();
  await driver.ready();
  await writer.sync(legacyState());
  const before = await driver.latestSeq();
  const saved = await index.load();

  const report = await writer.sync("{ esto no es json");
  assert.equal(report?.rawChanged, false);
  assert.equal(await driver.latestSeq(), before);
  assert.deepEqual(await index.load(), saved);
});

test("la huella ignora versión, fecha y dispositivo", () => {
  const base: LocalRow = {
    id: "p-1",
    company_id: COMPANY,
    version: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
    origin_device: "a",
    deleted_at: null,
    name: "Arroz"
  };
  assert.equal(
    shadowRowHash(base),
    shadowRowHash({ ...base, version: 9, updated_at: "2026-11-23T00:00:00.000Z", origin_device: "b" })
  );
  assert.notEqual(shadowRowHash(base), shadowRowHash({ ...base, name: "Arroz Premium" }));
});

test("una fila con versión del hub no pierde la escritura local por LWW", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  await writer.sync(legacyState());

  const external = (await driver.get<LocalRow>("products", "p-1"))!;
  await driver.put("products", [{ ...external, version: 7, name: "Arroz hub" }]);

  const changed = JSON.parse(legacyState());
  changed.state.products[0].price = 130;
  await writer.sync(JSON.stringify(changed));

  const row = await driver.get<LocalRow>("products", "p-1");
  assert.equal(row?.price, 130);
  assert.equal(row?.version, 8);
});

test("las pasadas concurrentes se serializan y no duplican escrituras", async () => {
  const { driver, writer } = setup();
  await driver.ready();
  const [first, second] = await Promise.all([writer.sync(legacyState()), writer.sync(legacyState())]);

  assert.equal(first?.rawChanged, true);
  assert.equal(second?.rawChanged, false);
  const products = await driver.query<LocalRow>({ table: "products" });
  assert.equal(products.length, 2);
});
