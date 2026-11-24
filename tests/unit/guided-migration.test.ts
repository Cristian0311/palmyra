import assert from "node:assert/strict";
import test from "node:test";
import type { LocalDbDriver, LocalDbTransaction, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  analyzeLegacyMigration,
  clearGuidedMigrationState,
  clearRollback,
  createBackupProof,
  formatGuidedMigrationReport,
  guidedMigrationStorageKey,
  isRollbackRequested,
  readGuidedMigrationState,
  requestRollback,
  runGuidedMigration,
  type BackupProofInput,
  type GuidedMigrationStorage
} from "../../src/services/localDb/migration";

const COMPANY = "co-1";
const DEVICE = "device-a";
const NOW = "2026-04-01T09:00:00.000Z";

/**
 * Fixture equivalente al del importador verificado: 1 sucursal, 2 productos,
 * 3 saldos de stock, 2 ventas con líneas/pagos y 1 turno con 2 movimientos.
 */
function legacyState() {
  return {
    state: {
      branches: [{ id: "b1", name: "Centro" }],
      products: [
        { id: "p1", name: "Cemento gris", price: 150, costPrice: 100, sku: "CEM-1" },
        { id: "p2", name: "Arena fina", price: 60, costPrice: 40, sku: "ARE-1" }
      ],
      inventory: [
        { productId: "p1", branchId: "b1", quantity: 10, minQuantity: 2 },
        { productId: "p2", branchId: "b1", quantity: 5, minQuantity: 1 },
        { productId: "p2", branchId: "b1", variantLabel: "M", quantity: 2, minQuantity: 0 }
      ],
      transactions: [
        {
          id: "t1",
          branchId: "b1",
          date: "2026-03-01T10:00:00.000Z",
          total: 1500,
          status: "completed",
          items: [
            {
              id: "l1",
              product: { id: "p1", name: "Cemento gris" },
              quantity: 10,
              price: 150,
              total: 1500
            }
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
          openingBalance: 0,
          status: "open",
          movements: [
            { id: "m1", type: "income", amount: 100, currencyCode: "CUP" },
            { id: "m2", type: "expense", amount: 20, currencyCode: "CUP" }
          ]
        }
      ],
      cart: [{ id: "c1", quantity: 1 }]
    },
    version: 0
  };
}

/** Comprobante fresco por defecto: 1 minuto antes del instante de la prueba. */
function proofAt(offsetMs = -60_000): BackupProofInput {
  return {
    at: new Date(Date.parse(NOW) + offsetMs).toISOString(),
    bytes: 4096,
    sha256: "a".repeat(64)
  };
}

/** localStorage falso: progreso guiado y marca de rollback sin tocar el navegador. */
function createFakeStorage() {
  const data = new Map<string, string>();
  const storage: GuidedMigrationStorage = {
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    }
  };
  return { data, storage };
}

async function freshDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver();
  await driver.ready();
  return driver;
}

async function countRows(driver: LocalDbDriver, table: "sales" | "products" | "sale_items" | "stock_balances") {
  const rows = await driver.query<LocalRow>({ table, includeDeleted: true });
  return rows.length;
}

/** Driver que pierde la última venta de cada lote: simula un fallo de escritura. */
function createLossySalesDriver(): LocalDbDriver {
  const base = createMemoryDriver();
  return {
    ...base,
    transaction<T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T> {
      return base.transaction((tx) =>
        fn({
          get: tx.get,
          query: tx.query,
          remove: tx.remove,
          put: async (table, rows) => {
            const write = table === "sales" ? rows.slice(0, Math.max(0, rows.length - 1)) : rows;
            return tx.put(table, write);
          }
        })
      );
    }
  };
}

test("analyze cuenta tablas, ventas, stock y turnos sin escribir", () => {
  const analysis = analyzeLegacyMigration(legacyState(), { companyId: COMPANY, now: NOW });

  assert.equal(analysis.generatedAt, NOW);
  assert.equal(analysis.estimatedRows, 13);
  assert.equal(analysis.salesTotal, 1750.5);
  assert.equal(analysis.stockQuantity, 17);
  assert.equal(analysis.cashSessions, 1);
  assert.deepEqual(analysis.counts, {
    warehouses: 1,
    products: 2,
    stock_balances: 3,
    sales: 2,
    sale_items: 2,
    sale_payments: 2,
    cash_sessions: 1
  });

  // También acepta el JSON de zustand tal cual (texto).
  const fromText = analyzeLegacyMigration(JSON.stringify(legacyState()), { companyId: COMPANY, now: NOW });
  assert.deepEqual(fromText.counts, analysis.counts);

  // Un JSON roto no lanza: se informa y no inventa conteos.
  const broken = analyzeLegacyMigration("{no es json", { companyId: COMPANY, now: NOW });
  assert.deepEqual(broken.counts, {});
  assert.equal(broken.estimatedRows, 0);
  assert.match(broken.warnings[0], /no es válido/);
});

test("sin respaldo, con respaldo vacío o vencido la migración no escribe nada", async () => {
  const driver = await freshDriver();
  const { storage } = createFakeStorage();

  const withoutProof = await runGuidedMigration({
    legacy: legacyState(),
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage
  });
  assert.equal(withoutProof.ok, false);
  assert.match(String(withoutProof.error), /respaldo/i);
  assert.equal(await countRows(driver, "products"), 0);
  assert.equal(await countRows(driver, "sales"), 0);

  const emptyProof = await runGuidedMigration({
    legacy: legacyState(),
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage,
    backupProof: { at: NOW, bytes: 0 }
  });
  assert.equal(emptyProof.ok, false);
  assert.match(String(emptyProof.error), /vac[ií]o/i);

  const expired = await runGuidedMigration({
    legacy: legacyState(),
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage,
    backupProof: proofAt(-31 * 60_000)
  });
  assert.equal(expired.ok, false);
  assert.match(String(expired.error), /30 minutos/i);
  assert.equal(await countRows(driver, "products"), 0);
  assert.equal(await countRows(driver, "stock_balances"), 0);
});

test("createBackupProof rechaza vacío, futuro y vencido; acepta uno reciente", () => {
  assert.equal(createBackupProof(null, { now: NOW }).ok, false);
  assert.equal(createBackupProof({ at: NOW, bytes: 0 }, { now: NOW }).ok, false);
  assert.equal(createBackupProof(proofAt(10 * 60_000), { now: NOW }).ok, false);
  assert.equal(createBackupProof(proofAt(-31 * 60_000), { now: NOW }).ok, false);

  const fresh = createBackupProof(proofAt(-60_000), { now: NOW });
  assert.equal(fresh.ok, true);
  if (fresh.ok) {
    assert.equal(fresh.proof.bytes, 4096);
    assert.equal(fresh.proof.sha256, "a".repeat(64));
    assert.equal(fresh.ageMs, 60_000);
  }
});

test("con respaldo vigente migra y verifica conteos, sumas, stock y huella", async () => {
  const driver = await freshDriver();
  const { storage } = createFakeStorage();

  const result = await runGuidedMigration({
    legacy: legacyState(),
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage,
    backupProof: proofAt()
  });

  assert.equal(result.ok, true, result.error);
  assert.ok(result.report);
  const report = result.report!;
  assert.equal(report.ok, true);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.tables.products, { expected: 2, actual: 2 });
  assert.deepEqual(report.tables.stock_balances, { expected: 3, actual: 3 });
  assert.deepEqual(report.tables.sales, { expected: 2, actual: 2 });
  assert.equal(report.totals.actualSalesTotal, 1750.5);
  assert.equal(report.totals.actualStock, 17);
  assert.match(report.hash.actual, /^[0-9a-f]{16}$/);
  assert.equal(report.hash.expected, report.hash.actual);

  assert.equal(result.counts.products, 2);
  assert.equal(result.counts.stock_balances, 3);
  assert.equal(result.salesTotal, 1750.5);
  assert.equal(result.stockQuantity, 17);
  assert.equal(result.summary.rows, 13);
  assert.equal(result.summary.mismatches, 0);

  assert.equal(await countRows(driver, "products"), 2);
  assert.equal(await countRows(driver, "sales"), 2);
  assert.equal(await countRows(driver, "sale_items"), 2);
  assert.equal(await countRows(driver, "stock_balances"), 3);
});

test("una escritura incompleta se informa y no deja filas parciales", async () => {
  const driver = createLossySalesDriver();
  await driver.ready();
  const { storage } = createFakeStorage();

  const result = await runGuidedMigration({
    legacy: legacyState(),
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage,
    backupProof: proofAt()
  });

  assert.equal(result.ok, false);
  assert.match(String(result.error), /no verificada/i);
  assert.ok(result.report, "el reporte de diagnóstico debe acompañar al fallo");
  assert.ok(result.report!.mismatches.length > 0);

  // La transacción revirtió también las tablas ya escritas.
  assert.equal(await countRows(driver, "products"), 0);
  assert.equal(await countRows(driver, "sales"), 0);
  assert.equal(await countRows(driver, "stock_balances"), 0);
});

test("repetir la migración con el mismo estado no duplica filas", async () => {
  const driver = await freshDriver();
  const { storage } = createFakeStorage();
  const options = {
    legacy: legacyState(),
    driver,
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage,
    backupProof: proofAt()
  };

  const first = await runGuidedMigration(options);
  const second = await runGuidedMigration(options);

  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(second.counts, first.counts);
  assert.equal(second.report!.hash.actual, first.report!.hash.actual);
  assert.equal(await countRows(driver, "sales"), 2);
  assert.equal(await countRows(driver, "products"), 2);
  assert.equal(await countRows(driver, "sale_items"), 2);
  assert.equal(second.summary.rows, first.summary.rows);

  // Un comprobante de otro respaldo no sirve: el gate lo rechaza.
  const foreign = await runGuidedMigration({ ...options, backupProof: proofAt(-2 * 60_000) });
  assert.equal(foreign.ok, false);
  assert.match(String(foreign.error), /no corresponde/i);
  assert.equal(await countRows(driver, "sales"), 2);
});

test("progreso persistido por empresa y marca de rollback se activa y se limpia", async () => {
  const { data, storage } = createFakeStorage();
  const companyKey = guidedMigrationStorageKey(COMPANY);
  assert.match(companyKey, /^palmyra:migration-guided:v1:co-1/);

  const result = await runGuidedMigration({
    legacy: legacyState(),
    driver: await freshDriver(),
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage,
    backupProof: proofAt()
  });
  assert.equal(result.ok, true);
  assert.ok(data.has(companyKey));

  const saved = readGuidedMigrationState({ companyId: COMPANY, storage });
  assert.equal(saved.step, "migrated");
  assert.equal(saved.analyzedAt, NOW);
  assert.equal(saved.backupAt, proofAt().at);
  assert.equal(saved.lastReportAt, NOW);
  assert.equal(saved.rollbackRequested, false);
  assert.ok(saved.lastResult);
  assert.equal(saved.lastResult!.ok, true);
  assert.equal(saved.lastResult!.rows, 13);
  assert.equal(saved.lastResult!.salesTotal, 1750.5);
  assert.equal(saved.lastResult!.mismatches, 0);

  assert.equal(isRollbackRequested({ companyId: COMPANY, storage }), false);
  requestRollback({ companyId: COMPANY, storage, now: NOW });
  assert.equal(isRollbackRequested({ companyId: COMPANY, storage }), true);
  assert.equal(readGuidedMigrationState({ companyId: COMPANY, storage }).rollbackRequested, true);
  assert.ok(
    Array.from(data.keys()).some((key) => key.startsWith("palmyra_local_db_rollback_v1")),
    "la marca de paridad que lee el arranque debe existir"
  );

  clearRollback({ companyId: COMPANY, storage, now: NOW });
  assert.equal(isRollbackRequested({ companyId: COMPANY, storage }), false);
  assert.equal(readGuidedMigrationState({ companyId: COMPANY, storage }).rollbackRequested, false);

  clearGuidedMigrationState({ companyId: COMPANY, storage });
  assert.equal(data.has(companyKey), false);
  assert.equal(readGuidedMigrationState({ companyId: COMPANY, storage }).step, "idle");
});

test("el reporte de una línea incluye conteos, sumas, stock y huella", async () => {
  const { storage } = createFakeStorage();
  const result = await runGuidedMigration({
    legacy: legacyState(),
    driver: await freshDriver(),
    companyId: COMPANY,
    originDevice: DEVICE,
    now: NOW,
    storage,
    backupProof: proofAt()
  });

  const line = formatGuidedMigrationReport(result);
  assert.equal(line.includes("\n"), false);
  assert.match(line, /^migracion_guiada ok /);
  assert.match(line, /rows=13\/13/);
  assert.match(line, /sales_total=1750\.5/);
  assert.match(line, /stock=17/);
  assert.match(line, /hash=[0-9a-f]{16}/);
  assert.match(line, /products:2/);
  // Sin datos de clientes ni de productos.
  assert.equal(line.includes("Cemento"), false);
});
