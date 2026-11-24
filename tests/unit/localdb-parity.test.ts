import assert from "node:assert/strict";
import test from "node:test";
import type { InventoryLevel, Product, Transaction } from "../../src/types";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { applyLegacyImport, importLegacyState } from "../../src/services/localDb/importLegacy";
import { initLocalDbSource, type HydratableState, type LocalDbSnapshot } from "../../src/services/localDb/bootHydration";
import {
  LOCAL_DB_ROLLBACK_EVENT,
  clearLocalDbRollback,
  compareLocalDbWithLegacy,
  isLocalDbRollbackRequested,
  requestLocalDbRollback
} from "../../src/services/localDb/parity";
import {
  pruneLegacyBackups,
  writeLegacyBackup,
  type RetentionStorage
} from "../../src/services/localDb/jsonRetention";
import {
  getOpenCashSessions,
  listProducts,
  listRecentSales,
  listStockBalances
} from "../../src/services/localDb/repositories";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const DEVICE = "device-a";
const AT = "2026-11-23T12:00:00.000Z";

/** Estado legado de referencia: 2 productos, 3 saldos, 2 ventas y 2 turnos. */
function legacyState() {
  return {
    state: {
      branches: [{ id: "b1", name: "Centro" }],
      products: [
        {
          id: "p2",
          name: "Zanahoria",
          sku: "Z-1",
          price: 60,
          costPrice: 40,
          margin: 20,
          categoryId: "c1",
          color: "bg-white",
          commissionValue: 0
        },
        {
          id: "p1",
          name: "Arroz",
          sku: "A-1",
          price: 150,
          costPrice: 100,
          margin: 50,
          categoryId: "c1",
          color: "bg-white",
          commissionValue: 0
        }
      ],
      inventory: [
        { productId: "p1", branchId: "b1", quantity: 10, minQuantity: 2 },
        { productId: "p2", branchId: "b1", quantity: 5, minQuantity: 1 },
        { productId: "p2", branchId: "b2", variantLabel: "M", quantity: 3, minQuantity: 0 }
      ],
      transactions: [
        {
          id: "t1",
          branchId: "b1",
          date: "2026-03-01T10:00:00.000Z",
          total: 1500,
          status: "completed",
          items: [
            { id: "l1", product: { id: "p1", name: "Arroz" }, quantity: 10, price: 150, total: 1500 }
          ],
          payments: [{ id: "pay1", currencyCode: "CUP", amount: 1500, exchangeRate: 1, method: "cash" }]
        },
        {
          id: "t2",
          branchId: "b1",
          date: "2026-03-02T10:00:00.000Z",
          total: 250.5,
          status: "completed",
          items: [{ productId: "p2", quantity: 4, price: 60, total: 240 }],
          payments: [{ currencyCode: "USD", amount: 1, exchangeRate: 250.5, method: "transfer" }]
        }
      ],
      cashSessions: [
        {
          id: "s1",
          branchId: "b1",
          openedAt: "2026-03-01T08:00:00.000Z",
          openingBalance: 100,
          status: "open",
          userId: "u1",
          movements: [
            { id: "m1", type: "income", amount: 100, currencyCode: "CUP" },
            { id: "m2", type: "expense", amount: 20, currencyCode: "CUP" }
          ]
        },
        {
          id: "s2",
          branchId: "b1",
          openedAt: "2026-03-02T08:00:00.000Z",
          openingBalance: 0,
          status: "closed",
          closedAt: "2026-03-02T20:00:00.000Z",
          userId: "u1",
          movements: []
        }
      ],
      cart: [{ id: "c1", quantity: 1 }]
    },
    version: 0
  };
}

const META = { companyId: COMPANY, originDevice: DEVICE, now: AT };

async function seededDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  await applyLegacyImport(driver, importLegacyState(legacyState(), META));
  return driver;
}

/** localStorage falso: sirve para retención y para la marca de rollback. */
function createFakeStorage() {
  const data = new Map<string, string>();
  const storage: RetentionStorage = {
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    }
  };
  return { data, storage };
}

function fakeStore(initial: HydratableState = {}) {
  const record = { calls: 0, state: { ...initial } as HydratableState };
  return {
    record,
    store: {
      getState: () => record.state,
      setState: (patch: Partial<LocalDbSnapshot>) => {
        record.calls += 1;
        record.state = { ...record.state, ...patch };
      }
    }
  };
}

test("paridad ok: el plan legado coincide con el almacén importado", async () => {
  const driver = await seededDriver();

  const report = await compareLocalDbWithLegacy({
    driver,
    state: legacyState(),
    companyId: COMPANY,
    originDevice: DEVICE,
    now: AT
  });

  assert.equal(report.ok, true, report.mismatches.join("; "));
  assert.deepEqual(report.tables.products, { expected: 2, actual: 2 });
  assert.deepEqual(report.tables.stock_balances, { expected: 3, actual: 3 });
  assert.deepEqual(report.tables.sales, { expected: 2, actual: 2 });
  assert.deepEqual(report.tables.cash_sessions, { expected: 2, actual: 2 });
  // Los movimientos embebidos en el turno cuentan igual que una tabla normalizada.
  assert.deepEqual(report.tables.cash_movements, { expected: 2, actual: 2 });

  assert.equal(report.totals.expectedSalesTotal, 1750.5);
  assert.equal(report.totals.actualSalesTotal, 1750.5);
  assert.equal(report.totals.expectedStockQuantity, 18);
  assert.equal(report.totals.actualStockQuantity, 18);
  assert.equal(report.totals.expectedCashAmount, 120);
  assert.equal(report.totals.actualCashAmount, 120);
  assert.equal(report.totals.expectedRows, report.totals.actualRows);
});

test("paridad acepta el JSON de zustand tal cual (texto) y no lanza con datos rotos", async () => {
  const driver = await seededDriver();

  const fromText = await compareLocalDbWithLegacy({
    driver,
    state: JSON.stringify(legacyState()),
    companyId: COMPANY,
    originDevice: DEVICE
  });
  assert.equal(fromText.ok, true, fromText.mismatches.join("; "));

  const broken = await compareLocalDbWithLegacy({
    driver,
    state: "{no es json",
    companyId: COMPANY,
    originDevice: DEVICE
  });
  assert.equal(broken.ok, false);
  assert.match(broken.mismatches[0], /no es válido/);
});

test("paridad falsa al alterar una fila o añadir una extra", async () => {
  const driver = await seededDriver();
  const common = {
    company_id: COMPANY,
    version: 5,
    updated_at: AT,
    origin_device: DEVICE,
    deleted_at: null
  };

  const sale = await driver.get<LocalRow>("sales", "t1");
  assert.ok(sale);
  await driver.put("sales", [{ ...sale!, total: 1600 }]);

  const changed = await compareLocalDbWithLegacy({
    driver,
    state: legacyState(),
    companyId: COMPANY,
    originDevice: DEVICE
  });
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.tables.sales, { expected: 2, actual: 2 });
  assert.ok(changed.mismatches.some((entry) => entry.includes("ventas.total")));

  // Una fila que el JSON no describe también rompe el conteo.
  await driver.put("products", [{ ...common, id: "p-extra", name: "Fantasma" }]);
  const extra = await compareLocalDbWithLegacy({
    driver,
    state: legacyState(),
    companyId: COMPANY,
    originDevice: DEVICE
  });
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.tables.products, { expected: 2, actual: 3 });
  assert.ok(extra.mismatches.some((entry) => entry.includes("tabla products")));
});

test("rollback: se activa, persiste, emite el evento y se limpia", () => {
  const { data, storage } = createFakeStorage();
  const target = new EventTarget();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = target;
  const seen: Array<{ reason: string; at: string }> = [];
  target.addEventListener(LOCAL_DB_ROLLBACK_EVENT, (event) => {
    seen.push((event as CustomEvent).detail);
  });

  try {
    assert.equal(isLocalDbRollbackRequested({ storage }), false);

    requestLocalDbRollback("paridad rota", { storage, now: AT });

    assert.equal(isLocalDbRollbackRequested({ storage }), true);
    assert.equal(data.size, 1);
    const [key, value] = Array.from(data.entries())[0];
    assert.match(key, /^palmyra_local_db_rollback_v1/);
    assert.equal(JSON.parse(value).reason, "paridad rota");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, "paridad rota");
    assert.equal(seen[0].at, AT);

    clearLocalDbRollback({ storage });
    assert.equal(isLocalDbRollbackRequested({ storage }), false);
    assert.equal(data.size, 0);
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});

test("el arranque en modo local no hidrata mientras haya rollback pendiente", async () => {
  const { storage } = createFakeStorage();
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  try {
    requestLocalDbRollback("fallo simulado en el corte", { now: AT });
    assert.equal(isLocalDbRollbackRequested(), true);

    const { store, record } = fakeStore();
    const diagnostics = await initLocalDbSource({
      companyId: COMPANY,
      driver: await seededDriver(),
      store,
      env: { VITE_LOCAL_DB_SOURCE: "local" }
    });

    assert.equal(diagnostics.applied, false);
    assert.equal(record.calls, 0);
    assert.match(String(diagnostics.reason), /rollback/);

    clearLocalDbRollback();
    assert.equal(isLocalDbRollbackRequested(), false);
  } finally {
    if (previous === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = previous;
  }
});

test("respaldo del JSON: uno por día y poda solo lo que supera 30 días", () => {
  const { storage } = createFakeStorage();
  storage.setItem("zustand", "estado-vivo");
  storage.setItem("palmyra_legacy_backup:2026-01-01", "viejo");
  storage.setItem("palmyra_local_db_rollback_v1:otra", "otra-clave");

  const first = writeLegacyBackup('{"state":{"a":1}}', {
    storage,
    now: "2026-03-15T10:00:00.000Z"
  });
  assert.deepEqual(first, { written: true, pruned: 1 });
  assert.equal(storage.getItem("palmyra_legacy_backup:2026-03-15"), '{"state":{"a":1}}');
  assert.equal(storage.getItem("palmyra_legacy_backup:2026-01-01"), null);
  // La clave viva y las claves ajenas al prefijo quedan intactas.
  assert.equal(storage.getItem("zustand"), "estado-vivo");
  assert.equal(storage.getItem("palmyra_local_db_rollback_v1:otra"), "otra-clave");

  // Mismo día: no se sobrescribe el primero.
  const again = writeLegacyBackup('{"state":{"a":2}}', {
    storage,
    now: "2026-03-15T23:00:00.000Z"
  });
  assert.equal(again.written, false);
  assert.equal(storage.getItem("palmyra_legacy_backup:2026-03-15"), '{"state":{"a":1}}');

  // Día siguiente: respaldo nuevo.
  const nextDay = writeLegacyBackup('{"state":{"a":3}}', {
    storage,
    now: "2026-03-16T09:00:00.000Z"
  });
  assert.equal(nextDay.written, true);

  // Tope de tamaño: no escribe.
  const tooBig = writeLegacyBackup("x".repeat(32), {
    storage,
    now: "2026-03-17T09:00:00.000Z",
    maxBytes: 16
  });
  assert.equal(tooBig.written, false);
  assert.equal(storage.getItem("palmyra_legacy_backup:2026-03-17"), null);

  // Poda determinista: el día del corte se conserva, el anterior se borra.
  storage.setItem("palmyra_legacy_backup:2026-02-12", "limite-viejo");
  storage.setItem("palmyra_legacy_backup:2026-02-13", "limite-exacto");
  storage.setItem("palmyra_legacy_backup:sin-fecha", "no-se-toca");

  const pruned = pruneLegacyBackups({ storage, now: "2026-03-15T10:00:00.000Z" });
  assert.equal(pruned, 1);
  assert.equal(storage.getItem("palmyra_legacy_backup:2026-02-12"), null);
  assert.equal(storage.getItem("palmyra_legacy_backup:2026-02-13"), "limite-exacto");
  assert.equal(storage.getItem("palmyra_legacy_backup:sin-fecha"), "no-se-toca");

  // Sin almacenamiento nunca lanza.
  assert.deepEqual(writeLegacyBackup("{}", { storage: null }), { written: false, pruned: 0 });
  assert.equal(pruneLegacyBackups({ storage: null }), 0);
});

test("lecturas de ruta caliente: orden estable, filtros y tablas vacías", async () => {
  const driver = await seededDriver();

  const products: Product[] = await listProducts(driver, { companyId: COMPANY });
  assert.deepEqual(products.map((item) => item.id), ["p1", "p2"]);
  assert.equal((await listProducts(driver, { companyId: COMPANY, limit: 1 })).length, 1);
  assert.deepEqual(await listProducts(driver, { companyId: OTHER_COMPANY }), []);

  const balances: InventoryLevel[] = await listStockBalances(driver, { companyId: COMPANY });
  assert.deepEqual(
    balances.map((item) => item.id),
    ["stock:p1:b1:base", "stock:p2:b1:base", "stock:p2:b2:M"]
  );
  const second = await listStockBalances(driver, { companyId: COMPANY, warehouseId: "b2" });
  assert.equal(second.length, 1);
  assert.equal(second[0].quantity, 3);

  const recent: Transaction[] = await listRecentSales(driver, { companyId: COMPANY, limit: 1 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, "t2");
  assert.equal(recent[0].total, 250.5);

  const open = await getOpenCashSessions(driver, { companyId: COMPANY });
  assert.deepEqual(open.map((session) => session.id), ["s1"]);

  // Almacén vacío: listas vacías, sin errores.
  const empty = createMemoryDriver();
  await empty.ready();
  assert.deepEqual(await listProducts(empty, { companyId: COMPANY }), []);
  assert.deepEqual(await listStockBalances(empty, { companyId: COMPANY }), []);
  assert.deepEqual(await listRecentSales(empty, { companyId: COMPANY }), []);
  assert.deepEqual(await getOpenCashSessions(empty, { companyId: COMPANY }), []);
});
