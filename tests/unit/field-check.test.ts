/**
 * Pruebas de scripts/field-check.mjs.
 *
 * El script de campo no puede importar TypeScript, así que replica las reglas
 * mínimas de lectura de importLegacy.ts. Aquí se ejecuta el importador real y se
 * comparan sus conteos con los del script: si las reglas divergen, esta prueba
 * falla y obliga a alinear ambas implementaciones.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_MAX_REQUESTS_PER_DAY,
  DEFAULT_MIN_INTERVAL_MS
} from "../../src/services/cloudSync/contract";
import type { LocalRow, LocalTable } from "../../src/services/localDb/contract";
import {
  applyLegacyImport,
  importLegacyState,
  type ImportMeta as LegacyImportMeta
} from "../../src/services/localDb/importLegacy";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { LOCAL_DB_TABLE_NAMES } from "../../src/services/localDb/schema";

interface Totals {
  products: number;
  sales: number;
  salesTotal: number;
  cashSessions: number;
}

interface FieldMetrics {
  tableCounts: Record<string, number>;
  totals: Totals;
  stockByProduct: Record<string, number>;
}

interface BudgetReport {
  ok: boolean;
  issues: string[];
  maxRequestsPerDay: number;
  minIntervalMs: number;
  impliedIntervalMs: number;
  uploadsPerDayAtMinInterval: number;
}

interface ModuleStatus {
  area: string;
  label: string;
  ok: boolean;
  files: number;
  checks: number;
  detail: string;
  issues: string[];
}

interface FieldCheckModule {
  MAX_REQUESTS_PER_DAY: number;
  MIN_INTERVAL_MS: number;
  MS_PER_DAY: number;
  MODULE_AREAS: readonly string[];
  EMBEDDED_FIXTURE: unknown;
  computeLegacyMetrics(input: unknown): FieldMetrics & { warnings: string[]; unmappedKeys: string[] };
  computeStoreMetrics(dump: unknown): FieldMetrics;
  compareMetrics(expected: FieldMetrics, actual: FieldMetrics): string[];
  evaluateBudget(options?: { maxRequestsPerDay?: number; minIntervalMs?: number }): BudgetReport;
  checkModules(input?: { root?: string }): {
    ok: boolean;
    areas: ModuleStatus[];
    issues: string[];
  };
  checkField(input?: { legacy?: unknown; store?: unknown; moduleRoot?: string }): {
    ok: boolean;
    issues: string[];
    budget: BudgetReport;
    legacy: FieldMetrics;
    store: FieldMetrics | null;
    modules: { ok: boolean; areas: ModuleStatus[]; issues: string[] };
  };
  formatReport(result: unknown, options?: { legacyLabel?: string; storeLabel?: string | null }): string;
  runCli(
    argv?: string[],
    io?: { out: (line: string) => void; err: (line: string) => void }
  ): number;
}

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "field-check.mjs");
const fieldCheck = (await import(pathToFileURL(SCRIPT).href)) as unknown as FieldCheckModule;

const META: LegacyImportMeta = {
  companyId: "co-1",
  originDevice: "device-field",
  now: "2026-05-01T10:00:00.000Z"
};

/** Estado de ejemplo con duplicados, filas sin id y stock sin id propio. */
function sampleLegacyState() {
  return {
    state: {
      currentBranchId: "b1",
      branches: [
        { id: "b1", name: "Centro" },
        { id: "b2", name: "Vedado" }
      ],
      products: [
        { id: "p1", name: "Cemento gris", price: 150 },
        { name: "Producto sin id", price: 10 },
        { id: "p2", name: "Arena fina", price: 60 },
        { id: "p1", name: "Cemento gris (corregido)", price: 160 }
      ],
      inventory: [
        { productId: "p1", branchId: "b1", quantity: 12 },
        { productId: "p1", branchId: "b1", quantity: 20 },
        { productId: "p2", branchId: "b1", variantLabel: "M", quantity: 4 },
        { productId: "p2", branchId: "b2", quantity: 6 },
        { branchId: "b1", quantity: 99 }
      ],
      transactions: [
        { id: "t1", branchId: "b1", total: 1500, status: "completed" },
        { id: "t2", branchId: "b2", total: 250.5, status: "completed" },
        { id: "t1", branchId: "b1", total: 1600, status: "completed" },
        { id: "t3", branchId: "b1", total_amount: 99.5 }
      ],
      cashSessions: [{ id: "s1", branchId: "b1", openingBalance: 0 }],
      customers: [{ id: "c1", name: "Cliente de paso" }],
      cart: [{ id: "line-1", quantity: 1 }],
      notifications: [{ id: "n1" }],
      categories: [{ id: "cat1" }]
    },
    version: 0
  };
}

function stockFromRows(rows: LocalRow[] | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows ?? []) {
    const productId = row.product_id;
    const quantity = row.quantity;
    if (typeof productId !== "string" || typeof quantity !== "number") continue;
    result[productId] = (result[productId] ?? 0) + quantity;
  }
  return result;
}

/** Importa con el importador real y devuelve el volcado del almacén. */
async function importToStore(state: unknown) {
  const driver = createMemoryDriver();
  await driver.ready();
  const result = importLegacyState(state, META);
  await applyLegacyImport(driver, result);

  const dump: Record<string, LocalRow[]> = {};
  for (const table of LOCAL_DB_TABLE_NAMES) {
    const rows = await driver.query<LocalRow>({ table: table as LocalTable, includeDeleted: true });
    if (rows.length > 0) dump[table] = rows;
  }
  await driver.close();
  return { result, dump };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-field-check-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("el script replica los conteos y sumas del importador real", async () => {
  const state = sampleLegacyState();
  const { result, dump } = await importToStore(state);

  const legacy = fieldCheck.computeLegacyMetrics(state);
  assert.deepEqual(legacy.totals, result.report.totals);
  assert.equal(legacy.totals.products, 2);
  assert.equal(legacy.totals.sales, 3);
  assert.equal(legacy.totals.salesTotal, 1950);
  assert.equal(legacy.totals.cashSessions, 1);

  const expectedStock = stockFromRows(result.batches.stock_balances);
  assert.deepEqual(legacy.stockByProduct, expectedStock);
  assert.deepEqual(legacy.stockByProduct, { p1: 20, p2: 10 });

  const store = fieldCheck.computeStoreMetrics(dump);
  assert.equal(store.totals.products, result.report.totals.products);
  assert.equal(store.totals.sales, result.report.totals.sales);
  assert.equal(store.totals.salesTotal, result.report.totals.salesTotal);
  assert.equal(store.totals.cashSessions, result.report.totals.cashSessions);
  assert.deepEqual(store.stockByProduct, expectedStock);
  assert.deepEqual(fieldCheck.compareMetrics(legacy, store), []);
});

test("el script pasa con el fixture embebido y con archivos reales", async () => {
  const embedded = fieldCheck.runCli([], { out: () => {}, err: () => {} });
  assert.equal(embedded, 0);
  assert.match(
    fieldCheck.formatReport(fieldCheck.checkField({})),
    /Resultado: OK/
  );

  const spawned = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: ROOT });
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.match(spawned.stdout, /productos: 2/);
  assert.match(spawned.stdout, /Resultado: OK/);

  const state = sampleLegacyState();
  const { dump } = await importToStore(state);
  withTempDir((dir) => {
    const legacyPath = path.join(dir, "estado.json");
    const storePath = path.join(dir, "almacen.json");
    fs.writeFileSync(legacyPath, JSON.stringify(state), "utf8");
    fs.writeFileSync(storePath, JSON.stringify(dump), "utf8");

    const lines: string[] = [];
    const code = fieldCheck.runCli([legacyPath, storePath], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line)
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.match(lines.join("\n"), /suma de ventas: 1950\.00/);
  });
});

test("un desajuste en el almacén produce código 1 y un informe legible", async () => {
  const state = sampleLegacyState();
  const { dump } = await importToStore(state);

  const brokenProducts = structuredClone(dump);
  brokenProducts.products = brokenProducts.products.slice(1);
  const productCheck = fieldCheck.checkField({ legacy: state, store: brokenProducts });
  assert.equal(productCheck.ok, false);
  assert.ok(
    productCheck.issues.some((issue) => issue.includes("productos: legado 2, almacén 1")),
    productCheck.issues.join("; ")
  );

  const brokenTotal = structuredClone(dump);
  brokenTotal.sales[0].total = 1;
  const totalCheck = fieldCheck.checkField({ legacy: state, store: brokenTotal });
  assert.ok(totalCheck.issues.some((issue) => issue.includes("suma de ventas")));

  const brokenStock = structuredClone(dump);
  const stockRow = brokenStock.stock_balances.find((row) => row.product_id === "p2");
  assert.ok(stockRow);
  stockRow.quantity = 5;
  const stockCheck = fieldCheck.checkField({ legacy: state, store: brokenStock });
  assert.ok(
    stockCheck.issues.some((issue) => issue.includes('stock de "p2"')),
    stockCheck.issues.join("; ")
  );

  withTempDir((dir) => {
    const legacyPath = path.join(dir, "estado.json");
    const storePath = path.join(dir, "almacen-roto.json");
    fs.writeFileSync(legacyPath, JSON.stringify(state), "utf8");
    fs.writeFileSync(storePath, JSON.stringify(brokenStock), "utf8");

    const lines: string[] = [];
    const code = fieldCheck.runCli(["--legacy", legacyPath, "--store", storePath], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line)
    });
    const report = lines.join("\n");
    assert.equal(code, 1, report);
    assert.match(report, /Diferencias \(\d+\)/);
    assert.match(report, /Resultado: FALLA/);
  });
});

test("el presupuesto coincide con el contrato y detecta diseños incoherentes", () => {
  assert.equal(fieldCheck.MAX_REQUESTS_PER_DAY, DEFAULT_MAX_REQUESTS_PER_DAY);
  assert.equal(fieldCheck.MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(fieldCheck.MS_PER_DAY / fieldCheck.MAX_REQUESTS_PER_DAY, fieldCheck.MIN_INTERVAL_MS);
  assert.equal(fieldCheck.MIN_INTERVAL_MS, 15 * 60 * 1000);

  const budget = fieldCheck.evaluateBudget();
  assert.equal(budget.ok, true);
  assert.equal(budget.impliedIntervalMs, 900000);
  assert.equal(budget.uploadsPerDayAtMinInterval, 96);
  assert.deepEqual(budget.issues, []);

  const tooMany = fieldCheck.evaluateBudget({ maxRequestsPerDay: 48 });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.issues.some((issue) => issue.includes("se contradice")));

  const shortInterval = fieldCheck.evaluateBudget({ minIntervalMs: 60_000 });
  assert.equal(shortInterval.ok, false);
  assert.equal(shortInterval.uploadsPerDayAtMinInterval, 1440);

  const invalid = fieldCheck.evaluateBudget({ maxRequestsPerDay: 0, minIntervalMs: 0 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.length, 2);
});

test("el informe incluye avisos de lectura y colecciones sin tabla", () => {
  const report = fieldCheck.formatReport(fieldCheck.checkField({ legacy: sampleLegacyState() }));
  assert.match(report, /Avisos de lectura/);
  assert.match(report, /products: 1 filas sin id/);
  assert.match(report, /products: 1 ids duplicados/);
  assert.match(report, /stock_balances: 4 filas sin id con id derivado/);
  assert.match(report, /Colecciones sin tabla destino: categories: 1/);
  assert.doesNotMatch(report, /cart: 1|notifications: 1/);
});

test("el estado de los módulos cubre hub, respaldo, licencia y tasas sin red", () => {
  assert.deepEqual([...fieldCheck.MODULE_AREAS], ["hub", "respaldo", "licencia", "tasas"]);

  const modules = fieldCheck.checkModules();
  assert.equal(modules.ok, true, modules.issues.join("; "));
  assert.equal(modules.areas.length, 4);
  for (const area of modules.areas) {
    assert.equal(area.ok, true, `${area.area}: ${area.issues.join("; ")}`);
    assert.ok(area.files > 0);
    assert.ok(area.checks >= area.files);
    assert.match(area.detail, /archivos y \d+ marcas/);
    assert.deepEqual(area.issues, []);
  }

  const report = fieldCheck.formatReport(fieldCheck.checkField({}));
  assert.match(report, /Estado de los módulos \(OK, inspección sin red\)/);
  assert.match(report, /Hub LAN: OK/);
  assert.match(report, /Respaldo cifrado: OK/);
  assert.match(report, /Licencia ES256: OK/);
  assert.match(report, /Tasas del hub: OK/);

  // Un árbol sin los módulos convierte el informe en FALLA, sin tocar la red.
  withTempDir((dir) => {
    const broken = fieldCheck.checkModules({ root: dir });
    assert.equal(broken.ok, false);
    assert.ok(broken.issues.some((issue) => issue.includes("Hub LAN: falta")));
    assert.ok(broken.issues.some((issue) => issue.includes("Respaldo cifrado: falta")));
    assert.ok(broken.issues.some((issue) => issue.includes("Licencia ES256: falta")));
    assert.ok(broken.issues.some((issue) => issue.includes("Tasas del hub: falta")));

    const brokenField = fieldCheck.checkField({ moduleRoot: dir });
    assert.equal(brokenField.ok, false);
    assert.ok(brokenField.issues.some((issue) => issue.includes("Tasas del hub: falta")));
    const brokenReport = fieldCheck.formatReport(brokenField);
    assert.match(brokenReport, /Estado de los módulos \(FALLA, inspección sin red\)/);
    assert.match(brokenReport, /Resultado: FALLA/);
  });
});
