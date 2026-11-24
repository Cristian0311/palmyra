import assert from "node:assert/strict";
import test from "node:test";
import type { LocalRow, LocalTable } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createLegacyShadowWriter, shadowRowHash } from "../../src/services/localDb/legacyShadow";
import { createMemoryShadowIndexStore } from "../../src/services/localDb/shadowIndex";
import { importLegacyState } from "../../src/services/localDb/importLegacy";
import {
  applyLocalRowsToStore,
  refreshStoreFromLocalDb,
  resetStoreBridgeForTests,
  type BridgeStore,
  type BridgeStoreState
} from "../../src/services/localDb/storeBridge";
import {
  hydrateFromLocalDb,
  initLocalDbSource,
  resolveHydratedBranchId
} from "../../src/services/localDb/bootHydration";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-a";
const AT = "2026-11-23T12:00:00.000Z";
const LATER = "2026-11-23T13:00:00.000Z";

/**
 * Estado legado "completo": cada entidad ya trae los campos que los
 * conversores fila→entidad añaden por defecto. Es lo que la app produce de
 * verdad (el formulario siempre escribe todas las claves), y es la condición
 * para que la proyección sea reversible sin inventar datos.
 */
function legacyState(overrides: Record<string, unknown> = {}): string {
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
        },
        {
          productId: "p-2",
          warehouseId: "wh-1",
          branchId: "wh-1",
          variantLabel: "base",
          quantity: 4,
          minQuantity: 1
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
      ],
      cart: [{ id: "cart-line", productId: "p-1", quantity: 1 }],
      ...overrides
    },
    version: 2
  });
}

const PARENT_TABLES: LocalTable[] = [
  "products",
  "stock_balances",
  "customers",
  "suppliers",
  "sales",
  "cash_sessions",
  "warehouses",
  "returns"
];

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

function rowsOf(table: LocalTable, rows: LocalRow[]): Map<string, LocalRow> {
  const map = new Map<string, LocalRow>();
  for (const row of rows) map.set(row.id, row);
  return map;
}

/** Filas legado que el puente proyecta (sin tablas hijas ni internas). */
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

async function seed(now = () => AT) {
  const driver = createMemoryDriver({ now });
  await driver.ready();
  const writer = createLegacyShadowWriter({
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    index: createMemoryShadowIndexStore(),
    now
  });
  const report = await writer.sync(legacyState());
  assert.ok(report);
  return { driver, writer };
}

test("ida y vuelta: legado → filas → store → filas conserva los mismos hashes", async () => {
  resetStoreBridgeForTests();
  const { driver, writer } = await seed();

  const original = new Map<LocalTable, Map<string, LocalRow>>();
  const bridged = [];
  for (const table of PARENT_TABLES) {
    const rows = await driver.query<LocalRow>({ table });
    original.set(table, rowsOf(table, rows));
    for (const row of rows) bridged.push({ table, row });
  }
  const settingsRows = await driver.query<LocalRow>({ table: "company_settings" });
  const companyRows = await driver.query<LocalRow>({ table: "companies" });
  for (const row of settingsRows) bridged.push({ table: "company_settings", row });
  for (const row of companyRows) bridged.push({ table: "companies", row });

  const { store, record } = fakeStore();
  const applied = applyLocalRowsToStore({
    rows: bridged,
    companyId: COMPANY,
    now: AT,
    store
  });
  assert.ok(applied.applied >= 8, `debe proyectar todas las entidades (${applied.applied})`);
  assert.equal((record.state.products as any[]).length, 2);
  assert.equal((record.state.returns as any[]).length, 1);
  assert.equal((record.state.products as any[])[0].name, "Arroz");

  const reimported = importLegacyState(JSON.parse(storeLegacyState(record)), {
    companyId: COMPANY,
    originDevice: DEVICE,
    now: AT
  });

  for (const table of PARENT_TABLES) {
    const before = original.get(table)!;
    const after = rowsOf(table, reimported.batches[table] ?? []);
    assert.equal(after.size, before.size, `${table}: cambió el número de filas`);
    for (const [id, row] of before) {
      const again = after.get(id);
      assert.ok(again, `${table}: la fila ${id} desapareció en la vuelta`);
      assert.equal(
        shadowRowHash(again!),
        shadowRowHash(row),
        `${table}:${id}: la huella de negocio cambió en la ida y vuelta`
      );
    }
  }

  // La sombra reimporta el estado proyectado sin escribir nada: no hay eco.
  const seqBefore = await driver.latestSeq();
  const echo = await writer.sync(storeLegacyState(record));
  assert.ok(echo);
  assert.equal(echo?.rawChanged, true);
  assert.deepEqual(echo?.written, {}, "la proyección no debe provocar reescrituras en la sombra");
  assert.equal(await driver.latestSeq(), seqBefore, "el journal no debe crecer tras proyectar");
});

test("un cambio remoto se proyecta y la sombra lo refleja una sola vez (sin oscilar)", async () => {
  resetStoreBridgeForTests();
  const { driver, writer } = await seed();
  const { store, record } = fakeStore({ products: [] });

  // Primera proyección para fijar las huellas.
  const first = await refreshStoreFromLocalDb(COMPANY, { driver, store, now: () => AT });
  assert.ok(first.applied > 0);
  const callsAfterFirst = record.calls;

  // El hub modifica el producto (fila normalizada completa, versión 5).
  const current = (await driver.get<LocalRow>("products", "p-1"))!;
  await driver.put("products", [
    { ...current, version: 5, updated_at: LATER, origin_device: "device-hub", price: 130, name: "Arroz Premium" }
  ]);

  const second = await refreshStoreFromLocalDb(COMPANY, {
    driver,
    store,
    now: () => LATER
  });
  assert.equal(second.applied, 1, "solo el producto remoto cambia");
  assert.ok(second.skipped > 0, "el resto del lote se descarta sin reescribir");
  assert.equal(record.calls, callsAfterFirst + 1, "un cambio = un render");
  const remoteProduct = (record.state.products as any[]).find((item) => item.id === "p-1");
  assert.equal(remoteProduct?.price, 130);
  assert.equal(remoteProduct?.name, "Arroz Premium");

  // La sombra escribe el contenido remoto una vez...
  const seqBefore = await driver.latestSeq();
  const echo = await writer.sync(storeLegacyState(record));
  assert.ok(echo);
  assert.equal(echo?.written.products, 1);
  assert.equal((await driver.latestSeq()) - seqBefore, 1);

  const echoed = (await driver.get<LocalRow>("products", "p-1"))!;
  const reimported = importLegacyState(
    { state: { products: [remoteProduct] } },
    { companyId: COMPANY, originDevice: DEVICE, now: LATER }
  );
  assert.equal(
    shadowRowHash(echoed),
    shadowRowHash(reimported.batches.products![0]),
    "la sombra no debe deformar el contenido remoto"
  );

  // ...y la siguiente pasada ya no encuentra nada: no hay bucle de escritura.
  const again = await writer.sync(storeLegacyState(record));
  assert.equal(again?.rawChanged, false);
  assert.equal(await driver.latestSeq(), seqBefore + 1);
});

test("hidratación: devoluciones y sucursal activa inequívoca", async () => {
  const { driver } = await seed();
  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot);
  assert.equal(snapshot?.returns.length, 1);
  assert.equal(snapshot?.returns[0].id, "ret-1");
  assert.equal(snapshot?.returns[0].transactionId, "sale-1");
  assert.equal(snapshot?.returns[0].status, "completed");
  assert.equal(snapshot?.returns[0].refundAmount, 120);

  assert.equal(resolveHydratedBranchId(undefined, snapshot!.branches), "wh-1");
  assert.equal(resolveHydratedBranchId("wh-1", snapshot!.branches), undefined);

  const twoWithoutMain = [
    { id: "a", name: "A", isMain: false, isActive: true },
    { id: "b", name: "B", isMain: false, isActive: true }
  ] as any[];
  assert.equal(resolveHydratedBranchId("", twoWithoutMain), undefined, "con dos sucursales no se inventa la activa");
  const oneMain = [
    { id: "a", name: "A", isMain: false, isActive: true },
    { id: "b", name: "B", isMain: true, isActive: true }
  ] as any[];
  assert.equal(resolveHydratedBranchId("", oneMain), "b");
});

test("initLocalDbSource fija currentBranchId cuando es inequívoco", async () => {
  const { driver } = await seed();
  const { store, record } = fakeStore();

  const diagnostics = await initLocalDbSource({
    companyId: COMPANY,
    driver,
    store,
    env: { VITE_LOCAL_DB_SOURCE: "local" }
  });

  assert.equal(diagnostics.applied, true);
  assert.equal(record.state.currentBranchId, "wh-1");
  assert.equal((record.state.returns as any[]).length, 1);
});
