import assert from "node:assert/strict";
import test from "node:test";
import type {
  CashRegisterSession,
  InventoryLevel,
  Product,
  StoreConfig,
  Supplier,
  Transaction
} from "../../src/types";
import type { LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createRepositories } from "../../src/services/localDb/repositories";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const DEVICE = "device-a";
const AT = "2026-11-23T12:00:00.000Z";

function product(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    name: "Arroz",
    sku: "A-1",
    costPrice: 90,
    price: 120,
    margin: 30,
    categoryId: "c-1",
    color: "bg-white",
    commissionValue: 0,
    ...overrides
  };
}

function stock(productId: string, overrides: Partial<InventoryLevel> = {}): InventoryLevel {
  return {
    productId,
    branchId: "wh-1",
    warehouseId: "wh-1",
    quantity: 10,
    minQuantity: 2,
    ...overrides
  };
}

function sale(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    branchId: "wh-1",
    warehouseId: "wh-1",
    userId: "u-1",
    date: "2026-11-20T10:00:00.000Z",
    total: 240,
    status: "completed",
    items: [{ id: "line-1", product: product("p-1"), quantity: 2, price: 120, total: 240 }],
    payments: [{ currencyCode: "CUP", amount: 240, exchangeRate: 1, method: "cash" }],
    ...overrides
  };
}

function cashSession(id: string): CashRegisterSession {
  return {
    id,
    branchId: "wh-1",
    warehouseId: "wh-1",
    userId: "u-1",
    openedAt: "2026-11-20T08:00:00.000Z",
    openingBalance: 100,
    status: "open",
    movements: [
      {
        id: "mv-1",
        type: "expense",
        amount: 25,
        currencyCode: "CUP",
        description: "Hielo",
        date: "2026-11-20T09:00:00.000Z"
      }
    ]
  };
}

const config: StoreConfig = { storeName: "Bodega Central", address: "Calle 1", phone: "555" };

async function setup(companyId = COMPANY_A) {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  const repos = createRepositories(driver, { companyId, deviceId: DEVICE, now: () => AT });
  return { driver, repos };
}

test("products: cada escritura firma las columnas comunes y sube la versión", async () => {
  const { driver, repos } = await setup();

  await repos.products.save(product("p-1"));
  const first = await driver.get<LocalRow>("products", "p-1");
  assert.equal(first?.company_id, COMPANY_A);
  assert.equal(first?.origin_device, DEVICE);
  assert.equal(first?.updated_at, AT);
  assert.equal(first?.version, 1);
  assert.equal(first?.name, "Arroz");
  // El mapeo legado se reutiliza: camelCase → columnas snake_case.
  assert.equal(first?.cost_price, 90);
  assert.equal(first?.category_id, "c-1");

  await repos.products.save(product("p-1", { price: 130 }));
  const second = await driver.get<LocalRow>("products", "p-1");
  assert.equal(second?.version, 2);
  assert.equal(second?.price, 130);

  // Una versión entrante mayor manda: max(2, 5) + 1.
  const versioned = { ...product("p-1"), version: 5 } as unknown as Product;
  await repos.products.save(versioned);
  const third = await driver.get<LocalRow>("products", "p-1");
  assert.equal(third?.version, 6);
});

test("products: lee solo la empresa activa y excluye tombstones", async () => {
  const { driver, repos } = await setup();
  const other = createRepositories(driver, { companyId: COMPANY_B, deviceId: "device-b", now: () => AT });

  await repos.products.save(product("p-a"));
  await other.products.save(product("p-b"));

  assert.deepEqual((await repos.products.list()).map((item) => item.id), ["p-a"]);
  assert.deepEqual((await other.products.list()).map((item) => item.id), ["p-b"]);
  // Una fila de otra empresa no es visible aunque el id exista.
  assert.equal(await repos.products.get("p-b"), null);

  await repos.products.remove("p-a");
  assert.deepEqual(await repos.products.list(), []);
  assert.equal(await repos.products.get("p-a"), null);

  const tombstone = await driver.get<LocalRow>("products", "p-a");
  assert.equal(tombstone?.deleted_at, AT);
  assert.equal(tombstone?.version, 2);
  // La otra empresa sigue intacta.
  assert.equal((await other.products.list()).length, 1);
});

test("inventory: id derivado estable, cantidades y variantes", async () => {
  const { driver, repos } = await setup();

  const saved = await repos.inventory.save(stock("p-1"));
  assert.equal(saved.id, "stock:p-1:wh-1:base");
  const row = await driver.get<LocalRow>("stock_balances", "stock:p-1:wh-1:base");
  assert.equal(row?.quantity, 10);
  assert.equal(row?.min_quantity, 2);
  assert.equal(row?.company_id, COMPANY_A);

  const variant = await repos.inventory.save(stock("p-1", { variantLabel: "Talla 42", quantity: 3 }));
  assert.equal(variant.id, "stock:p-1:wh-1:Talla 42");

  const all = await repos.inventory.list();
  assert.equal(all.length, 2);
  assert.equal(all.find((item) => item.variantLabel === "Talla 42")?.quantity, 3);
  assert.equal(all.find((item) => !item.variantLabel)?.branchId, "wh-1");

  await repos.inventory.save(stock("p-1", { quantity: 12 }));
  assert.equal((await driver.get<LocalRow>("stock_balances", saved.id))?.version, 2);
});

test("sales: escribe venta, líneas y pagos en una sola empresa", async () => {
  const { driver, repos } = await setup();
  const full = sale("sale-1", {
    items: [
      { id: "line-1", product: product("p-1"), quantity: 1, price: 120, total: 120 },
      { id: "line-2", product: product("p-2"), quantity: 1, price: 120, total: 120 }
    ],
    payments: [
      { currencyCode: "CUP", amount: 120, exchangeRate: 1, method: "cash" },
      { currencyCode: "USD", amount: 1, exchangeRate: 120, method: "cash" }
    ]
  });

  await repos.sales.save(full);
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))?.version, 1);

  const items = await driver.query<LocalRow>({ table: "sale_items" });
  const payments = await driver.query<LocalRow>({ table: "sale_payments" });
  assert.equal(items.length, 2);
  assert.equal(payments.length, 2);
  assert.ok(items.every((row) => row.company_id === COMPANY_A && row.origin_device === DEVICE));
  assert.ok(payments.every((row) => row.company_id === COMPANY_A));

  const listed = await repos.sales.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].items.length, 2);
  assert.equal(listed[0].payments.length, 2);
  assert.equal(listed[0].branchId, "wh-1");

  const fetched = await repos.sales.get("sale-1");
  assert.equal(fetched?.total, 240);
  assert.equal(fetched?.items[0].product.id, "p-1");

  // Quitar una línea deja tombstone en la tabla hija, no un huérfano activo.
  await repos.sales.save({ ...full, items: [full.items[0]] });
  const active = await driver.query<LocalRow>({ table: "sale_items" });
  assert.equal(active.length, 1);
  const withDeleted = await driver.query<LocalRow>({ table: "sale_items", includeDeleted: true });
  assert.equal(withDeleted.length, 2);
  assert.equal(withDeleted.find((row) => row.deleted_at)?.deleted_at, AT);
});

test("cashSessions: guarda el turno y sus movimientos", async () => {
  const { driver, repos } = await setup();
  const session = cashSession("turno-1");

  await repos.cashSessions.save(session);
  const row = await driver.get<LocalRow>("cash_sessions", "turno-1");
  assert.equal(row?.company_id, COMPANY_A);
  assert.equal(row?.status, "open");

  const movements = await driver.query<LocalRow>({ table: "cash_movements" });
  assert.equal(movements.length, 1);
  assert.equal(movements[0].session_id, "turno-1");
  assert.equal(movements[0].amount, 25);
  assert.equal(movements[0].type, "expense");
  assert.equal(movements[0].company_id, COMPANY_A);

  const fetched = await repos.cashSessions.get("turno-1");
  assert.equal(fetched?.status, "open");
  assert.equal(fetched?.movements?.length, 1);
  assert.equal(fetched?.branchId, "wh-1");

  await repos.cashSessions.save({ ...session, status: "closed", closedAt: "2026-11-20T20:00:00.000Z" });
  assert.equal((await driver.get<LocalRow>("cash_sessions", "turno-1"))?.version, 2);
});

test("storeConfig: guarda ajustes y nombre de empresa con versión propia", async () => {
  const { driver, repos } = await setup();

  const saved = await repos.storeConfig.save(config);
  assert.equal(saved.storeName, "Bodega Central");

  const settings = await driver.get<LocalRow>("company_settings", COMPANY_A);
  assert.equal(settings?.store_name, "Bodega Central");
  assert.equal((settings?.config as StoreConfig).address, "Calle 1");
  assert.equal((await driver.get<LocalRow>("companies", COMPANY_A))?.name, "Bodega Central");

  const fetched = await repos.storeConfig.get();
  assert.equal(fetched?.phone, "555");

  await repos.storeConfig.save({ ...config, storeName: "Bodega Este" });
  assert.equal((await driver.get<LocalRow>("company_settings", COMPANY_A))?.version, 2);
  assert.equal((await repos.storeConfig.get())?.storeName, "Bodega Este");
});

test("customers y suppliers: CRUD con borrado lógico", async () => {
  const { driver, repos } = await setup();
  const supplier: Supplier = { id: "sup-1", name: "Mayorista", phone: "777" };

  await repos.customers.save({ id: "cus-1", name: "Ana", email: "ana@example.com", phone: "555" });
  await repos.suppliers.save(supplier);

  assert.equal((await repos.customers.list())[0].name, "Ana");
  assert.equal((await repos.suppliers.list())[0].name, "Mayorista");

  await repos.customers.remove("cus-1");
  await repos.suppliers.remove("sup-1");

  assert.deepEqual(await repos.customers.list(), []);
  assert.deepEqual(await repos.suppliers.list(), []);
  assert.equal((await driver.get<LocalRow>("customers", "cus-1"))?.deleted_at, AT);
  assert.equal((await driver.get<LocalRow>("suppliers", "sup-1"))?.deleted_at, AT);
});

test("sin companyId los repositorios rechazan cualquier operación", async () => {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  const repos = createRepositories(driver, { deviceId: DEVICE, now: () => AT });

  await assert.rejects(() => repos.products.list(), /companyId/);
  await assert.rejects(() => repos.products.save(product("p-1")), /companyId/);
});
