import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { Product } from "../../src/types";
import type { LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createLegacyShadowWriter } from "../../src/services/localDb/legacyShadow";
import { createMemoryShadowIndexStore } from "../../src/services/localDb/shadowIndex";
import { importLegacyState } from "../../src/services/localDb/importLegacy";
import {
  applyLocalRowsToStore,
  applyLocalSnapshotToStore,
  bridgeEntityHash,
  isLocalDbRemoteApplyEnabled,
  resetStoreBridgeForTests,
  type BridgeStore,
  type BridgeStoreState
} from "../../src/services/localDb/storeBridge";
import {
  hydrateFromLocalDb,
  LOCAL_DB_SOURCE_EVENT,
  refreshStoreFromLocalDb,
  REFRESH_DEBOUNCE_MS,
  resetLocalDbRefreshForTests,
  type LocalDbSnapshot
} from "../../src/services/localDb/bootHydration";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-a";
const AT = "2026-11-23T12:00:00.000Z";
const LATER = "2026-11-23T13:00:00.000Z";

/** Estado legado con todas las claves que los conversores fila→entidad añaden. */
function legacyState(): string {
  return JSON.stringify({
    state: {
      storeConfig: { storeName: "Bodega Central", address: "Calle 1", phone: "555" },
      branches: [
        { id: "wh-1", name: "Almacén", address: "Calle 1", phone: "555", isMain: true, isActive: true }
      ],
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
        {
          productId: "p-1",
          warehouseId: "wh-1",
          branchId: "wh-1",
          variantLabel: "base",
          quantity: 10,
          minQuantity: 2
        }
      ],
      customers: [{ id: "c-1", name: "Ana", email: "ana@example.com", phone: "5551234" }],
      suppliers: [{ id: "s-1", name: "Proveedor", phone: "5559999" }],
      transactions: [
        {
          id: "sale-1",
          branchId: "wh-1",
          warehouseId: "wh-1",
          userId: "u-1",
          date: "2026-11-20T10:00:00.000Z",
          total: 240,
          status: "completed",
          items: [
            {
              id: "line-1",
              product: { id: "p-1", name: "Arroz" },
              productName: "Arroz",
              quantity: 2,
              price: 120,
              total: 240,
              variantLabel: "base"
            }
          ],
          payments: [{ currencyCode: "CUP", amount: 240, exchangeRate: 1, method: "cash" }]
        }
      ],
      returns: [
        {
          id: "ret-1",
          transactionId: "sale-1",
          productId: "p-1",
          quantity: 1,
          reason: "defective",
          date: "2026-11-21T10:00:00.000Z",
          status: "completed",
          type: "refund",
          branchId: "wh-1",
          variantLabel: "base",
          refundStatus: "paid",
          refundAmount: 120,
          refundCurrencyCode: "CUP",
          refundMethod: "cash"
        }
      ],
      cashSessions: [
        {
          id: "turno-1",
          branchId: "wh-1",
          warehouseId: "wh-1",
          userId: "u-1",
          openedAt: "2026-11-20T08:00:00.000Z",
          openingBalance: 100,
          status: "open",
          movements: []
        }
      ]
    },
    version: 2
  });
}

function fakeStore(initial: Record<string, unknown> = {}) {
  const record = { calls: 0, state: { ...initial } as Record<string, unknown> };
  const store: BridgeStore = {
    getState: () => record.state as BridgeStoreState,
    setState: (patch) => {
      record.calls += 1;
      record.state = { ...record.state, ...patch };
    }
  };
  return { store, record };
}

function emptySnapshot(partial: Record<string, unknown> = {}): LocalDbSnapshot {
  return {
    products: [],
    inventory: [],
    customers: [],
    suppliers: [],
    transactions: [],
    cashSessions: [],
    branches: [],
    returns: [],
    ...partial
  } as unknown as LocalDbSnapshot;
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p-1",
    name: "Arroz",
    sku: "A-1",
    price: 120,
    costPrice: 90,
    margin: 30,
    categoryId: "c-1",
    color: "bg-white",
    commissionValue: 0,
    ...overrides
  };
}

async function seed() {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  const writer = createLegacyShadowWriter({
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    index: createMemoryShadowIndexStore(),
    now: () => AT
  });
  const report = await writer.sync(legacyState());
  assert.ok(report);
  return { driver, writer };
}

function storeLegacyState(record: { state: Record<string, unknown> }): string {
  return JSON.stringify({
    state: {
      storeConfig: record.state.storeConfig,
      branches: record.state.branches ?? [],
      products: record.state.products ?? [],
      inventory: record.state.inventory ?? [],
      customers: record.state.customers ?? [],
      suppliers: record.state.suppliers ?? [],
      transactions: record.state.transactions ?? [],
      returns: record.state.returns ?? [],
      cashSessions: record.state.cashSessions ?? []
    },
    version: 2
  });
}

beforeEach(() => {
  resetStoreBridgeForTests();
  resetLocalDbRefreshForTests();
});

test("fusiona el snapshot por colección: altas, fila más nueva y nada por ausencia", async () => {
  const { driver } = await seed();
  const { store, record } = fakeStore();
  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot);

  const first = applyLocalSnapshotToStore({ snapshot: snapshot!, companyId: COMPANY, store });
  assert.equal(first.skipped, 0);
  assert.equal(first.applied, 9, "productos(2), stock, clientes, proveedores, venta, turno, sucursal y devolución");
  assert.equal((record.state.products as Product[]).length, 2);
  assert.equal((record.state.returns as unknown[]).length, 1);
  assert.equal((record.state.transactions as unknown[]).length, 1);

  // El hub modifica un producto: solo esa fila se aplica.
  const current = (await driver.get<LocalRow>("products", "p-1"))!;
  await driver.put("products", [
    { ...current, version: 6, updated_at: LATER, origin_device: "hub", price: 130 }
  ]);
  const updated = await hydrateFromLocalDb(COMPANY, { driver });
  const second = applyLocalSnapshotToStore({ snapshot: updated!, companyId: COMPANY, store });
  assert.deepEqual(second, { applied: 1, skipped: 8 });
  const p1 = (record.state.products as Product[]).find((item) => item.id === "p-1");
  assert.equal(p1?.price, 130);

  // Un snapshot sin p-2 no borra nada: la ausencia nunca elimina.
  const partial = await hydrateFromLocalDb(COMPANY, { driver });
  partial!.products = partial!.products.filter((item) => item.id !== "p-2");
  delete partial!.sync!.products["p-2"];
  const third = applyLocalSnapshotToStore({ snapshot: partial!, companyId: COMPANY, store });
  assert.equal(third.applied, 0);
  assert.equal((record.state.products as Product[]).length, 2, "p-2 sigue en la store");
});

test("una fila más vieja no degrada lo vigente y el mismo contenido no se reescribe", () => {
  const { store, record } = fakeStore();

  const newer = emptySnapshot({
    products: [product({ price: 130 })],
    sync: { products: { "p-1": { version: 5, updatedAt: LATER } } }
  });
  assert.deepEqual(applyLocalSnapshotToStore({ snapshot: newer, companyId: COMPANY, store }), {
    applied: 1,
    skipped: 0
  });
  assert.equal(record.calls, 1);

  const older = emptySnapshot({
    products: [product({ price: 100 })],
    sync: { products: { "p-1": { version: 4, updatedAt: AT } } }
  });
  assert.deepEqual(applyLocalSnapshotToStore({ snapshot: older, companyId: COMPANY, store }), {
    applied: 0,
    skipped: 1
  });
  assert.equal((record.state.products as Product[])[0].price, 130);

  // Mismo contenido con versión mayor: huella, pero ninguna escritura.
  const bump = emptySnapshot({
    products: [product({ price: 130 })],
    sync: { products: { "p-1": { version: 9, updatedAt: LATER } } }
  });
  assert.deepEqual(applyLocalSnapshotToStore({ snapshot: bump, companyId: COMPANY, store }), {
    applied: 0,
    skipped: 1
  });
  assert.equal(record.calls, 1, "un valor idéntico no debe reescribirse");
});

test("respeta una edición local pendiente de reflejar en el almacén", () => {
  const { store, record } = fakeStore();
  const base = emptySnapshot({
    products: [product({ price: 120 })],
    sync: { products: { "p-1": { version: 2, updatedAt: AT } } }
  });
  applyLocalSnapshotToStore({ snapshot: base, companyId: COMPANY, store });

  // Edición local que la sombra todavía no ha escrito.
  store.setState({ products: [{ ...(record.state.products as Product[])[0], price: 999 }] });

  const remote = emptySnapshot({
    products: [product({ price: 130 })],
    sync: { products: { "p-1": { version: 3, updatedAt: LATER } } }
  });
  assert.deepEqual(applyLocalSnapshotToStore({ snapshot: remote, companyId: COMPANY, store }), {
    applied: 0,
    skipped: 1
  });
  assert.equal((record.state.products as Product[])[0].price, 999);
});

test("nunca toca currentUser, sesión, sucursal activa ni configuración de tienda", async () => {
  const { driver } = await seed();
  const storeConfig = { storeName: "Propia", address: "Calle 9", phone: "000", darkMode: true };
  const currentUser = { id: "user-1", name: "Cajera" };
  const { store, record } = fakeStore({
    currentUser,
    activeSessionId: "turno-local",
    currentBranchId: "wh-local",
    storeConfig
  });

  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot);
  assert.ok(snapshot!.storeConfig, "la hidratación sí trae la configuración");
  assert.ok(snapshot!.currentBranchId, "y la sucursal inequívoca");
  applyLocalSnapshotToStore({ snapshot: snapshot!, companyId: COMPANY, store });

  assert.equal(record.state.currentUser, currentUser);
  assert.equal(record.state.activeSessionId, "turno-local");
  assert.equal(record.state.currentBranchId, "wh-local");
  assert.deepEqual(record.state.storeConfig, storeConfig);
  assert.equal((record.state.products as Product[]).length, 2);
});

test("kill switch VITE_LOCAL_DB_APPLY_REMOTE=0 apaga el puente", () => {
  assert.equal(isLocalDbRemoteApplyEnabled({}), true);
  assert.equal(isLocalDbRemoteApplyEnabled({ VITE_LOCAL_DB_APPLY_REMOTE: "0" }), false);
  assert.equal(isLocalDbRemoteApplyEnabled({ VITE_LOCAL_DB_APPLY_REMOTE: "1" }), true);

  const { store, record } = fakeStore();
  const snapshot = emptySnapshot({
    products: [product()],
    sync: { products: { "p-1": { version: 2, updatedAt: AT } } }
  });
  const result = applyLocalSnapshotToStore({
    snapshot,
    companyId: COMPANY,
    store,
    env: { VITE_LOCAL_DB_APPLY_REMOTE: "0" }
  });
  assert.deepEqual(result, { applied: 0, skipped: 1 });
  assert.equal(record.calls, 0);
});

test("refresh: debounce compartido, un solo render y evento con applied/skipped/reason", async () => {
  const { driver } = await seed();
  const { store, record } = fakeStore();

  const target = new EventTarget();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = target;
  const seen: Array<{ kind: string; applied: number; skipped: number; reason: string }> = [];
  target.addEventListener(LOCAL_DB_SOURCE_EVENT, (event) => {
    seen.push((event as CustomEvent).detail);
  });

  try {
    const [first, second] = await Promise.all([
      refreshStoreFromLocalDb(COMPANY, { driver, store, reason: "hub-lan" }),
      refreshStoreFromLocalDb(COMPANY, { driver, store, reason: "hub-lan" })
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.applied, 9);
    assert.equal(record.calls, 1, `una ventana de ${REFRESH_DEBOUNCE_MS} ms = un solo trabajo`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, "refresh");
    assert.equal(seen[0].applied, 9);
    assert.equal(seen[0].skipped, 0);
    assert.equal(seen[0].reason, "hub-lan");
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});

test("refresh: kill switch y almacén vacío no escriben la store", async () => {
  const { store, record } = fakeStore();
  const disabled = await refreshStoreFromLocalDb(COMPANY, {
    driver: createMemoryDriver({ now: () => AT }),
    store,
    env: { VITE_LOCAL_DB_APPLY_REMOTE: "0" }
  });
  assert.deepEqual(disabled, { applied: 0, skipped: 0 });

  const empty = createMemoryDriver({ now: () => AT });
  await empty.ready();
  const nothing = await refreshStoreFromLocalDb(COMPANY, { driver: empty, store });
  assert.deepEqual(nothing, { applied: 0, skipped: 0 });
  assert.equal(record.calls, 0);
});

test("una lápida explícita sí borra, pero solo lo ya proyectado", async () => {
  const { driver } = await seed();
  const { store, record } = fakeStore();
  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  applyLocalSnapshotToStore({ snapshot: snapshot!, companyId: COMPANY, store });
  assert.equal((record.state.products as Product[]).length, 2);

  // Fila con deleted_at en el almacén: el hub borró el producto.
  const current = (await driver.get<LocalRow>("products", "p-2"))!;
  await driver.put("products", [
    { ...current, version: 7, updated_at: LATER, deleted_at: LATER, origin_device: "hub" }
  ]);
  const afterDelete = await hydrateFromLocalDb(COMPANY, { driver });
  const result = applyLocalSnapshotToStore({ snapshot: afterDelete!, companyId: COMPANY, store });
  assert.equal(result.applied, 1);
  assert.equal((record.state.products as Product[]).length, 1);
  assert.equal((record.state.products as Product[])[0].id, "p-1");
});

test("ida y vuelta: legado → filas → snapshot → store → legado no deja cambios pendientes", async () => {
  const { driver, writer } = await seed();
  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot);

  // La configuración de tienda ya vive en el JSON legado; el puente no la toca.
  const { state: legacyInner } = JSON.parse(legacyState()) as { state: Record<string, unknown> };
  const { store, record } = fakeStore({ storeConfig: legacyInner.storeConfig });
  const applied = applyLocalSnapshotToStore({
    snapshot: snapshot!,
    companyId: COMPANY,
    store,
    originDevice: DEVICE
  });
  assert.equal(applied.applied, 9);

  // La store proyectada se reimporta con los mismos hashes de negocio.
  const reimported = importLegacyState(JSON.parse(storeLegacyState(record)), {
    companyId: COMPANY,
    originDevice: DEVICE,
    now: AT
  });
  const original = importLegacyState(JSON.parse(legacyState()), {
    companyId: COMPANY,
    originDevice: DEVICE,
    now: AT
  });
  for (const table of ["products", "stock_balances", "customers", "suppliers", "sales", "returns", "cash_sessions", "warehouses"] as const) {
    const before = new Map((original.batches[table] ?? []).map((row) => [row.id, row]));
    const after = new Map((reimported.batches[table] ?? []).map((row) => [row.id, row]));
    assert.equal(after.size, before.size, `${table}: cambió el número de filas`);
    for (const [id, row] of before) {
      assert.ok(after.has(id), `${table}:${id} desapareció en la ida y vuelta`);
    }
  }

  // La sombra no reescribe nada: los valores son estables y no hay eco.
  const seqBefore = await driver.latestSeq();
  const echo = await writer.sync(storeLegacyState(record));
  assert.ok(echo);
  assert.deepEqual(echo?.written, {}, "la proyección no debe provocar reescrituras");
  assert.equal(await driver.latestSeq(), seqBefore, "el journal no crece tras proyectar");

  // Y una segunda pasada ni siquiera ve cambios en el JSON.
  const again = await writer.sync(storeLegacyState(record));
  assert.equal(again?.rawChanged, false);
});

test("la API por filas sigue borrando solo con lápidas explícitas", () => {
  const { store, record } = fakeStore();
  const row: LocalRow = {
    id: "p-1",
    company_id: COMPANY,
    version: 2,
    updated_at: AT,
    origin_device: DEVICE,
    deleted_at: null,
    name: "Arroz",
    sku: "A-1",
    price: 120
  };
  assert.deepEqual(applyLocalRowsToStore({ rows: [{ table: "products", row }], companyId: COMPANY, store }), {
    applied: 1,
    skipped: 0
  });
  assert.deepEqual(applyLocalRowsToStore({ rows: [], companyId: COMPANY, store }), {
    applied: 0,
    skipped: 0
  });
  assert.equal((record.state.products as unknown[]).length, 1, "la ausencia no borra");
  assert.deepEqual(
    applyLocalRowsToStore({
      rows: [],
      deletedIds: [{ table: "products", id: "p-1" }],
      companyId: COMPANY,
      now: LATER,
      store
    }),
    { applied: 1, skipped: 0 }
  );
  assert.equal((record.state.products as unknown[]).length, 0);
});

test("la huella de entidad ignora el orden de claves", () => {
  assert.equal(bridgeEntityHash({ b: 2, a: 1 }), bridgeEntityHash({ a: 1, b: 2 }));
  assert.notEqual(bridgeEntityHash({ a: 1 }), bridgeEntityHash({ a: 2 }));
});
