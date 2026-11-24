import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CashRegisterSession,
  InventoryLevel,
  Product,
  Transaction
} from "../../src/types";
import type {
  LocalDbDriver,
  LocalRow,
  QuerySpec
} from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createNodeSqliteAdapter } from "../../src/services/localDb/sqlite/bindingNode";
import { createSqliteDriver } from "../../src/services/localDb/sqlite/driver";
import { importLegacyState, applyLegacyImport } from "../../src/services/localDb/importLegacy";
import { createRepositories } from "../../src/services/localDb/repositories";
import {
  LOCAL_DB_SOURCE_EVENT,
  REFRESH_DEBOUNCE_MS,
  hydrateFromLocalDb,
  initLocalDbSource,
  refreshStoreFromLocalDb,
  resetLocalDbRefreshForTests,
  type HydratableState,
  type HydratableStore,
  type LocalDbSnapshot
} from "../../src/services/localDb/bootHydration";
import { getLocalDbSourceMode, isLocalDbSource, isLocalDbSourceForced } from "../../src/services/localDb/cutover";
import { resetStoreBridgeForTests } from "../../src/services/localDb/storeBridge";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-a";
const AT = "2026-11-23T12:00:00.000Z";

function legacyState(): string {
  return JSON.stringify({
    state: {
      storeConfig: { storeName: "Bodega Central", address: "Calle 1", phone: "555" },
      branches: [{ id: "wh-1", name: "Almacén", isMain: true }],
      products: [
        {
          id: "p-1",
          name: "Arroz",
          sku: "A-1",
          price: 120,
          costPrice: 90,
          margin: 30,
          categoryId: "c-1",
          color: "bg-white",
          commissionValue: 0
        },
        {
          id: "p-2",
          name: "Frijol",
          sku: "F-1",
          price: 200,
          costPrice: 150,
          margin: 50,
          categoryId: "c-1",
          color: "bg-white",
          commissionValue: 0
        }
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
          items: [{ id: "line-1", product: { id: "p-1", name: "Arroz" }, quantity: 2, price: 120, total: 240 }],
          payments: [{ currencyCode: "CUP", amount: 240, exchangeRate: 1, method: "cash" }]
        }
      ],
      cashSessions: [
        { id: "turno-1", warehouseId: "wh-1", status: "open", openedAt: "2026-11-20T08:00:00.000Z", openingBalance: 100, userId: "u-1" }
      ],
      cart: [{ id: "cart-line", productId: "p-1", quantity: 1 }]
    },
    version: 2
  });
}

async function seededDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  const imported = importLegacyState(JSON.parse(legacyState()), {
    companyId: COMPANY,
    originDevice: DEVICE,
    now: AT
  });
  await applyLegacyImport(driver, imported);
  // Filas sintéticas de empresa/configuración que la sombra escribe junto al JSON.
  const repos = createRepositories(driver, { companyId: COMPANY, deviceId: DEVICE, now: () => AT });
  await repos.storeConfig.save(JSON.parse(legacyState()).state.storeConfig);
  return driver;
}

function emptyDriver(): LocalDbDriver {
  return createMemoryDriver({ now: () => AT });
}

function fakeStore(initial: HydratableState = {}) {
  const record = { calls: 0, state: { ...initial } as HydratableState };
  const store: HydratableStore = {
    getState: () => record.state,
    setState: (patch: Partial<LocalDbSnapshot>) => {
      record.calls += 1;
      record.state = { ...record.state, ...patch };
    }
  };
  return { store, record };
}

function withQuerySpy(driver: LocalDbDriver) {
  const spy = { queries: 0 };
  const wrapped: LocalDbDriver = {
    ...driver,
    async query<T extends LocalRow>(spec: QuerySpec): Promise<T[]> {
      spy.queries += 1;
      return driver.query<T>(spec);
    }
  };
  return { driver: wrapped, spy };
}

test("cutover: sombra por defecto y local solo con la bandera", () => {
  assert.equal(getLocalDbSourceMode({}), "shadow");
  assert.equal(getLocalDbSourceMode({ VITE_LOCAL_DB_SOURCE: "otra" }), "shadow");
  assert.equal(isLocalDbSource({ VITE_LOCAL_DB_SOURCE: "local" }), true);
  assert.equal(isLocalDbSourceForced({ VITE_LOCAL_DB_SOURCE_FORCE: "1" }), true);
  assert.equal(isLocalDbSourceForced({ VITE_LOCAL_DB_SOURCE_FORCE: "0" }), false);
});

test("hidrata productos, inventario, ventas, caja, sucursales y configuración", async () => {
  const driver = await seededDriver();
  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });

  assert.ok(snapshot);
  assert.equal(snapshot?.products.length, 2);

  const arroz = snapshot?.products.find((item) => item.id === "p-1");
  assert.equal(arroz?.name, "Arroz");
  assert.equal(arroz?.costPrice, 90);
  assert.equal(arroz?.categoryId, "c-1");
  assert.equal(arroz?.commissionValue, 0);

  const stock = snapshot?.inventory.find((item) => item.productId === "p-1");
  assert.equal(stock?.quantity, 10);
  assert.equal(stock?.minQuantity, 2);
  assert.equal(stock?.branchId, "wh-1");
  assert.equal(stock?.warehouseId, "wh-1");

  const sale = snapshot?.transactions[0];
  assert.equal(sale?.id, "sale-1");
  assert.equal(sale?.total, 240);
  assert.equal(sale?.branchId, "wh-1");
  assert.equal(sale?.status, "completed");
  assert.equal(sale?.items.length, 1);
  assert.equal(sale?.items[0].product.id, "p-1");
  assert.equal(sale?.payments[0].currencyCode, "CUP");

  const session = snapshot?.cashSessions[0];
  assert.equal(session?.id, "turno-1");
  assert.equal(session?.status, "open");
  assert.equal(session?.branchId, "wh-1");

  assert.equal(snapshot?.branches[0].id, "wh-1");
  assert.equal(snapshot?.branches[0].name, "Almacén");
  assert.equal(snapshot?.branches[0].isMain, true);

  assert.equal(snapshot?.storeConfig?.storeName, "Bodega Central");
  assert.equal(snapshot?.storeConfig?.phone, "555");
});

test("ida y vuelta: lo escrito por los repositorios se hidrata igual", async () => {
  const driver = await seededDriver();
  const repos = createRepositories(driver, { companyId: COMPANY, deviceId: DEVICE, now: () => AT });

  const product: Product = {
    id: "p-9",
    name: "Café",
    sku: "C-9",
    costPrice: 400,
    price: 500,
    margin: 100,
    categoryId: "c-2",
    color: "bg-black",
    commissionValue: 5
  };
  const level: InventoryLevel = {
    productId: "p-9",
    branchId: "wh-1",
    warehouseId: "wh-1",
    quantity: 7,
    minQuantity: 3,
    variantLabel: "1 kg"
  };
  const transaction: Transaction = {
    id: "sale-9",
    branchId: "wh-1",
    warehouseId: "wh-1",
    userId: "u-1",
    date: "2026-11-21T09:00:00.000Z",
    total: 500,
    status: "completed",
    items: [{ id: "line-9", product, quantity: 1, price: 500, total: 500 }],
    payments: [{ currencyCode: "CUP", amount: 500, exchangeRate: 1, method: "cash" }]
  };
  const session: CashRegisterSession = {
    id: "turno-9",
    branchId: "wh-1",
    warehouseId: "wh-1",
    userId: "u-1",
    openedAt: "2026-11-21T08:00:00.000Z",
    openingBalance: 50,
    status: "open",
    movements: [
      { id: "mv-9", type: "income", amount: 20, currencyCode: "CUP", description: "Propina", date: "2026-11-21T08:30:00.000Z" }
    ]
  };

  await repos.products.save(product);
  await repos.inventory.save(level);
  await repos.sales.save(transaction);
  await repos.cashSessions.save(session);
  await repos.storeConfig.save({ storeName: "Bodega Central", address: "Calle 1", phone: "555" });

  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot);

  const hydratedProduct = snapshot?.products.find((item) => item.id === "p-9");
  assert.equal(hydratedProduct?.price, 500);
  assert.equal(hydratedProduct?.sku, "C-9");

  const hydratedStock = snapshot?.inventory.find((item) => item.productId === "p-9");
  assert.equal(hydratedStock?.quantity, 7);
  assert.equal(hydratedStock?.variantLabel, "1 kg");
  assert.equal(hydratedStock?.minQuantity, 3);

  const hydratedSale = snapshot?.transactions.find((item) => item.id === "sale-9");
  assert.equal(hydratedSale?.total, 500);
  assert.equal(hydratedSale?.items[0].product.id, "p-9");
  assert.equal(hydratedSale?.payments[0].amount, 500);

  const hydratedSession = snapshot?.cashSessions.find((item) => item.id === "turno-9");
  assert.equal(hydratedSession?.openingBalance, 50);
  assert.equal(hydratedSession?.movements?.length, 1);
  assert.equal(hydratedSession?.movements?.[0].amount, 20);
});

test("reconstruye líneas y movimientos desde las tablas hijas si el padre no los trae", async () => {
  const driver = await seededDriver();
  const common = { company_id: COMPANY, version: 1, updated_at: AT, origin_device: DEVICE, deleted_at: null };

  await driver.put("sales", [
    { ...common, id: "sale-2", branch_id: "wh-1", user_id: "u-1", date: "2026-11-22T10:00:00.000Z", total: 120, status: "completed" }
  ]);
  await driver.put("sale_items", [
    { ...common, id: "sale-2:item:0", sale_id: "sale-2", product_id: "p-1", product_name: "Arroz", quantity: 1, price: 120, total: 120 }
  ]);
  await driver.put("sale_payments", [
    { ...common, id: "sale-2:pay:0", sale_id: "sale-2", currency_code: "CUP", amount: 120, exchange_rate: 1, method: "cash" }
  ]);
  await driver.put("cash_sessions", [
    { ...common, id: "turno-2", branch_id: "wh-1", opened_at: "2026-11-22T08:00:00.000Z", opening_balance: 0, status: "open", user_id: "u-1" }
  ]);
  await driver.put("cash_movements", [
    { ...common, id: "mv-2", session_id: "turno-2", type: "income", amount: 50, currency_code: "CUP", description: "Venta", date: "2026-11-22T09:00:00.000Z" }
  ]);

  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  const sale = snapshot?.transactions.find((item) => item.id === "sale-2");
  assert.equal(sale?.items.length, 1);
  assert.equal(sale?.items[0].product.id, "p-1");
  assert.equal(sale?.items[0].total, 120);
  assert.equal(sale?.payments[0].amount, 120);

  const session = snapshot?.cashSessions.find((item) => item.id === "turno-2");
  assert.equal(session?.movements?.length, 1);
  assert.equal(session?.movements?.[0].description, "Venta");
});

test("un almacén vacío o con error devuelve null", async () => {
  const empty = emptyDriver();
  await empty.ready();
  assert.equal(await hydrateFromLocalDb(COMPANY, { driver: empty }), null);

  const broken = await seededDriver();
  broken.query = async () => {
    throw new Error("lectura rota");
  };
  assert.equal(await hydrateFromLocalDb(COMPANY, { driver: broken }), null);
});

test("el mismo contrato hidrata desde SQLite", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "palmyra-localdb-hydrate-"));
  const dbPath = join(dir, "local.sqlite");
  const adapter = await createNodeSqliteAdapter(dbPath);
  const driver = await createSqliteDriver({ adapter, filePath: dbPath, now: () => AT });
  t.after(async () => {
    await driver.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const repos = createRepositories(driver, { companyId: COMPANY, deviceId: DEVICE, now: () => AT });
  const product = {
    id: "p-sql",
    name: "Malta",
    sku: "M-1",
    costPrice: 40,
    price: 60,
    margin: 20,
    categoryId: "c-1",
    color: "bg-amber-500",
    commissionValue: 0
  } as Product;
  await repos.products.save(product);
  await repos.sales.save({
    id: "sale-sql",
    branchId: "wh-1",
    userId: "u-1",
    date: "2026-11-22T10:00:00.000Z",
    total: 60,
    status: "completed",
    items: [{ id: "line-sql", product, quantity: 1, price: 60, total: 60 }],
    payments: [{ currencyCode: "CUP", amount: 60, exchangeRate: 1, method: "cash" }]
  });

  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.equal(snapshot?.products.find((item) => item.id === "p-sql")?.name, "Malta");
  assert.equal(snapshot?.transactions.find((item) => item.id === "sale-sql")?.items[0].product.id, "p-sql");
  assert.equal(await hydrateFromLocalDb("99999999-9999-4999-8999-999999999999", { driver }), null);
});

test("modo sombra no lee ni escribe en la store", async () => {
  const driver = await seededDriver();
  const { store, record } = fakeStore();
  const { driver: spied, spy } = withQuerySpy(driver);

  const diagnostics = await initLocalDbSource({
    companyId: COMPANY,
    driver: spied,
    store,
    env: {}
  });

  assert.equal(diagnostics.mode, "shadow");
  assert.equal(diagnostics.applied, false);
  assert.equal(record.calls, 0);
  assert.equal(spy.queries, 0);
});

test("modo local hidrata una store vacía", async () => {
  const driver = await seededDriver();
  const { store, record } = fakeStore();

  const diagnostics = await initLocalDbSource({
    companyId: COMPANY,
    driver,
    store,
    env: { VITE_LOCAL_DB_SOURCE: "local" }
  });

  assert.equal(diagnostics.mode, "local");
  assert.equal(diagnostics.applied, true);
  assert.equal(record.calls, 1);
  assert.equal((record.state.products ?? []).length, 2);
  assert.equal((record.state.transactions ?? []).length, 1);
  assert.deepEqual(diagnostics.counts, {
    products: 2,
    inventory: 2,
    customers: 0,
    suppliers: 0,
    sales: 1,
    cashSessions: 1,
    branches: 1,
    returns: 0,
    storeConfig: 1
  });
});

test("modo local respeta una store con datos salvo que se fuerce", async () => {
  const driver = await seededDriver();
  const existing = fakeStore({ products: [{ id: "p-local" }], isInitialized: true });

  const skipped = await initLocalDbSource({
    companyId: COMPANY,
    driver,
    store: existing.store,
    env: { VITE_LOCAL_DB_SOURCE: "local" }
  });
  assert.equal(skipped.applied, false);
  assert.equal(existing.record.calls, 0);
  assert.match(String(skipped.reason), /FORCE/);

  const forced = await initLocalDbSource({
    companyId: COMPANY,
    driver,
    store: existing.store,
    env: { VITE_LOCAL_DB_SOURCE: "local", VITE_LOCAL_DB_SOURCE_FORCE: "1" }
  });
  assert.equal(forced.applied, true);
  assert.equal(existing.record.calls, 1);
});

test("sin empresa o sin datos no aplica nada", async () => {
  const { store, record } = fakeStore();
  const noCompany = await initLocalDbSource({
    driver: await seededDriver(),
    store,
    env: { VITE_LOCAL_DB_SOURCE: "local" }
  });
  assert.equal(noCompany.applied, false);
  assert.equal(noCompany.counts.products, undefined);
  assert.match(String(noCompany.reason), /empresa/);

  const noData = await initLocalDbSource({
    companyId: COMPANY,
    driver: emptyDriver(),
    store,
    env: { VITE_LOCAL_DB_SOURCE: "local" }
  });
  assert.equal(noData.applied, false);
  assert.match(String(noData.reason), /vacío/);
  assert.equal(record.calls, 0);
});

test("publica el diagnóstico en palmyra:localdb-source", async () => {
  const target = new EventTarget();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = target;
  const seen: { mode: string; applied: boolean; counts: Record<string, number> }[] = [];
  target.addEventListener(LOCAL_DB_SOURCE_EVENT, (event) => {
    seen.push((event as CustomEvent).detail);
  });

  try {
    await initLocalDbSource({
      companyId: COMPANY,
      driver: await seededDriver(),
      store: fakeStore().store,
      env: { VITE_LOCAL_DB_SOURCE: "local" }
    });
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, "local");
  assert.equal(seen[0].applied, true);
  assert.equal(seen[0].counts.sales, 1);
});

test("la hidratación trae metadatos de sincronización y la sucursal inequívoca", async () => {
  const driver = await seededDriver();
  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot);

  const meta = snapshot!.sync?.products?.["p-1"];
  assert.equal(meta?.version, 1);
  assert.equal(meta?.updatedAt, AT);
  assert.equal(meta?.originDevice, DEVICE);
  assert.ok(snapshot!.sync?.stock_balances, "el inventario también lleva metadatos");

  assert.equal(snapshot!.currentBranchId, "wh-1", "una sola sucursal activa = inequívoca");
  assert.deepEqual(snapshot!.deleted ?? {}, {}, "sin lápidas no hay borrados");

  // Las categorías NO tienen tabla en el esquema v1: el JSON legado conserva
  // nombre/color y el almacén solo guarda category_id, así que quedan fuera.
  assert.equal("categories" in (snapshot as Record<string, unknown>), false);
});

test("refresh desde el hub: aplica la venta ajena una sola vez y emite el diagnóstico", async () => {
  resetStoreBridgeForTests();
  resetLocalDbRefreshForTests();
  const driver = await seededDriver();
  const { store, record } = fakeStore();

  const target = new EventTarget();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = target;
  const seen: Array<{ kind: string; applied: number; skipped: number; reason: string }> = [];
  target.addEventListener(LOCAL_DB_SOURCE_EVENT, (event) => {
    seen.push((event as CustomEvent).detail);
  });

  try {
    // Primera pasada: la store queda al día con el almacén.
    const baseline = await refreshStoreFromLocalDb(COMPANY, { driver, store, reason: "hub-lan" });
    assert.ok(baseline.applied > 0);
    const callsAfterBaseline = record.calls;
    assert.equal((record.state.transactions ?? []).length, 1);

    // Llega del hub una venta normalizada de otro equipo.
    const common = { company_id: COMPANY, version: 5, updated_at: AT, origin_device: "hub", deleted_at: null };
    await driver.put("sales", [
      { ...common, id: "sale-hub", branch_id: "wh-1", warehouse_id: "wh-1", user_id: "u-2", date: "2026-11-22T10:00:00.000Z", total: 120, status: "completed" }
    ]);
    await driver.put("sale_items", [
      { ...common, id: "sale-hub:item:0", sale_id: "sale-hub", product_id: "p-1", product_name: "Arroz", quantity: 1, price: 120, total: 120 }
    ]);

    const result = await refreshStoreFromLocalDb(COMPANY, { driver, store, reason: "hub-lan" });
    assert.deepEqual(result, { applied: 1, skipped: 7 }, `ventana ${REFRESH_DEBOUNCE_MS} ms`);
    assert.equal(record.calls, callsAfterBaseline + 1, "un cambio remoto = un render");
    const sales = (record.state.transactions ?? []) as Transaction[];
    assert.equal(sales.length, 2);
    assert.equal(sales.find((sale) => sale.id === "sale-hub")?.items.length, 1);

    // Repetir el refresco no reescribe nada: el valor es estable.
    const repeat = await refreshStoreFromLocalDb(COMPANY, { driver, store, reason: "hub-lan" });
    assert.equal(repeat.applied, 0);
    assert.equal(record.calls, callsAfterBaseline + 1);

    assert.equal(seen.length, 3);
    assert.equal(seen[2].kind, "refresh");
    assert.equal(seen[2].reason, "hub-lan");
    assert.equal(seen[2].applied, 0);
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});

test("refresh respeta el kill switch VITE_LOCAL_DB_APPLY_REMOTE=0", async () => {
  resetLocalDbRefreshForTests();
  const driver = await seededDriver();
  const { store, record } = fakeStore();
  const result = await refreshStoreFromLocalDb(COMPANY, {
    driver,
    store,
    env: { VITE_LOCAL_DB_APPLY_REMOTE: "0" }
  });
  assert.deepEqual(result, { applied: 0, skipped: 0 });
  assert.equal(record.calls, 0);
});
