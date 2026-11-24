import assert from "node:assert/strict";
import test from "node:test";
import type {
  LocalDbDriver,
  LocalDbTransaction,
  LocalRow
} from "../../src/services/localDb/contract";
import {
  applyVerifiedImport,
  formatVerificationReport,
  verifyImportedState
} from "../../src/services/localDb/importVerify";
import type { ImportMeta } from "../../src/services/localDb/importLegacy";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";

const META: ImportMeta = {
  companyId: "co-1",
  originDevice: "device-a",
  now: "2026-04-01T09:00:00.000Z"
};

/**
 * Fixture: 2 productos, 2 ventas con líneas y pagos, 1 turno con 2 movimientos
 * e inventario en dos presentaciones (base y variante).
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
          payments: [
            { id: "pay1", currencyCode: "CUP", amount: 1500, exchangeRate: 1, method: "cash" }
          ]
        },
        {
          id: "t2",
          branchId: "b1",
          date: "2026-03-02T10:00:00.000Z",
          total: 250.5,
          status: "completed",
          items: [{ productId: "p2", quantity: 4, price: 60, total: 240 }],
          payments: [
            { currencyCode: "USD", amount: 1, exchangeRate: 250.5, method: "transfer" }
          ]
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

async function freshDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver();
  await driver.ready();
  return driver;
}

async function countRows(driver: LocalDbDriver, table: "sales" | "products"): Promise<number> {
  const rows = await driver.query<LocalRow>({ table, includeDeleted: true });
  return rows.length;
}

test("applyVerifiedImport deja un reporte ok con conteos, sumas y hash", async () => {
  const driver = await freshDriver();

  const { report, written } = await applyVerifiedImport(driver, legacyState(), META);

  assert.equal(written, true);
  assert.equal(report.ok, true);
  assert.equal(report.source, "legacy_json");
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.tables, {
    warehouses: { expected: 1, actual: 1 },
    products: { expected: 2, actual: 2 },
    stock_balances: { expected: 3, actual: 3 },
    sales: { expected: 2, actual: 2 },
    sale_items: { expected: 2, actual: 2 },
    sale_payments: { expected: 2, actual: 2 },
    cash_sessions: { expected: 1, actual: 1 }
  });
  assert.equal(report.totals.expectedSalesTotal, 1750.5);
  assert.equal(report.totals.actualSalesTotal, 1750.5);
  assert.equal(report.totals.expectedStock, 17);
  assert.equal(report.totals.actualStock, 17);
  // Huella determinista de 64 bits en hex, idéntica en ambos lados.
  assert.match(report.hash.expected, /^[0-9a-f]{16}$/);
  assert.equal(report.hash.expected, report.hash.actual);

  assert.equal(await countRows(driver, "sales"), 2);
  assert.equal(await countRows(driver, "products"), 2);

  // El resumen de logs es una sola línea y no expone datos de clientes.
  const line = formatVerificationReport(report);
  assert.equal(line.includes("\n"), false);
  assert.match(line, /^import_verify ok source=legacy_json /);
  assert.equal(line.includes("p1"), false);
});

test("reimportar el mismo estado sigue siendo ok y no duplica filas", async () => {
  const driver = await freshDriver();

  const first = await applyVerifiedImport(driver, legacyState(), META);
  const second = await applyVerifiedImport(driver, legacyState(), META);

  assert.equal(second.report.ok, true);
  assert.deepEqual(second.report.tables, first.report.tables);
  assert.equal(second.report.hash.actual, first.report.hash.actual);
  assert.equal(await countRows(driver, "sales"), 2);
  assert.equal(await countRows(driver, "products"), 2);
  const items = await driver.query<LocalRow>({ table: "sale_items", includeDeleted: true });
  assert.equal(items.length, 2);
});

test("una fila extra en products rompe el conteo y la verificación", async () => {
  const driver = await freshDriver();
  await applyVerifiedImport(driver, legacyState(), META);

  await driver.put<LocalRow>("products", [
    {
      id: "p-extra",
      company_id: META.companyId,
      version: 1,
      updated_at: META.now as string,
      origin_device: META.originDevice,
      deleted_at: null,
      name: "Producto fantasma"
    }
  ]);

  const report = await verifyImportedState(driver, legacyState(), META);

  assert.equal(report.ok, false);
  assert.deepEqual(report.tables.products, { expected: 2, actual: 3 });
  assert.ok(report.mismatches.some((entry) => entry.includes("products")));
  assert.notEqual(report.hash.expected, report.hash.actual);
  assert.match(formatVerificationReport(report), /^import_verify fail /);
});

/**
 * Driver que pierde silenciosamente la última fila de cada lote de ventas: así
 * se reproduce un fallo real de escritura después de haber volcado productos.
 */
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

test("applyVerifiedImport revierte todo si la relectura no cuadra", async () => {
  const driver = createLossySalesDriver();
  await driver.ready();

  await assert.rejects(
    () => applyVerifiedImport(driver, legacyState(), META),
    /Importación no verificada/
  );

  // Nada sobrevive: la transacción deshizo también las tablas ya escritas.
  assert.equal(await countRows(driver, "sales"), 0);
  assert.equal(await countRows(driver, "products"), 0);
  const stock = await driver.query<LocalRow>({ table: "stock_balances", includeDeleted: true });
  assert.equal(stock.length, 0);
});

test("un estado con filas sin id no inventa filas ni rompe la importación", async () => {
  const driver = await freshDriver();
  const state = {
    state: {
      products: [
        { id: "p1", name: "Cemento gris", price: 150 },
        { name: "Sin id", price: 10 }
      ]
    }
  };

  const { report } = await applyVerifiedImport(driver, state, META);

  // El importador descarta la fila sin id: lo esperado y lo real coinciden.
  assert.equal(report.ok, true);
  assert.deepEqual(report.tables.products, { expected: 1, actual: 1 });
  assert.equal(await countRows(driver, "products"), 1);
});

test("un snapshot en la nube con otra envoltura se verifica igual", async () => {
  const plain = legacyState().state;

  // Referencia: el mismo contenido importado como JSON legado.
  const reference = await freshDriver();
  const legacyReport = (await applyVerifiedImport(reference, legacyState(), META)).report;

  const cloud = await freshDriver();
  const applied = await applyVerifiedImport(cloud, plain, META, { source: "cloud_snapshot" });

  assert.equal(applied.report.source, "cloud_snapshot");
  assert.equal(applied.report.ok, true);
  // El objeto plano se acepta porque unwrapLegacyState lo devuelve tal cual.
  assert.equal(applied.report.hash.expected, legacyReport.hash.expected);
  assert.equal(applied.report.totals.actualSalesTotal, 1750.5);

  const verified = await verifyImportedState(cloud, plain, META, { source: "cloud_snapshot" });
  assert.equal(verified.ok, true);
  assert.equal(verified.source, "cloud_snapshot");
  assert.equal(verified.hash.actual, applied.report.hash.expected);
});
