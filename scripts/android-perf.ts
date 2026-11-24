/**
 * Arnés de rendimiento del almacén local para la fase F4 (Android autónomo).
 *
 * Mide con `node:perf_hooks` los objetivos del plan: inserción masiva de ventas,
 * ventana de las últimas 200, reportes por rango y arranque equivalente
 * (catálogo + ventana reciente). Los presupuestos son TOPES DE PRESUPUESTO, no
 * mediciones de hardware real: si un número los supera hay que investigar, pero
 * cumplirlos no demuestra que un móvil de gama media vaya a cumplirlos.
 *
 * Los datos son deterministas (semilla fija): dos ejecuciones insertan las
 * mismas ventas, con las mismas líneas y los mismos importes.
 *
 * Motores:
 * - `sqlite` con el binding Node ya existente (si el runtime trae `node:sqlite`).
 *   Es el que se mide contra los presupuestos porque es el motor de producción.
 * - `memory` como referencia, con muestra reducida: el driver en memoria copia
 *   todo el estado en cada transacción (O(n²) al insertar), así que no puede
 *   hospedar 50.000 ventas por la ruta caliente en un tiempo razonable.
 *
 * Uso: `npx tsx scripts/android-perf.ts [--ventas=50000] [--memoria=1000]`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { LocalDbDriver, LocalRow } from "../src/services/localDb/contract";
import { createMemoryDriver } from "../src/services/localDb/memoryDriver";
import { recordSale, type HotSaleItemInput, type HotSalePaymentInput } from "../src/services/localDb/hotPaths";
import {
  createRepositories,
  getOpenCashSessions,
  listProducts,
  listRecentSales,
  listStockBalances
} from "../src/services/localDb/repositories";
import { applyBackupSnapshot, readBackupSnapshot } from "../src/services/localDb/backup/snapshot";
import type { InventoryLevel, Product } from "../src/types";

export const PERF_COMPANY = "11111111-1111-4111-8111-111111111111";
export const PERF_DEVICE = "device-perf";
export const PERF_WAREHOUSE = "wh-1";
export const PERF_CATALOG_SIZE = 60;

/** Presupuestos del plan. Son el límite superior aceptado, no una promesa. */
export const PERFORMANCE_BUDGETS = {
  /** 50.000 ventas por la ruta caliente: 3 ms por venta es el techo tolerado. */
  insertTotalMs: 150_000,
  /** Ventana de trabajo del POS. */
  last200Ms: 300,
  /** Arranque en gama media. */
  bootMs: 5_000,
  /** Reporte de 30 días leído del almacén (no había presupuesto explícito). */
  reportRangeMs: 1_500
} as const;

export type PerfEngine = "memory" | "sqlite";

export type PerfVerdict = "ok" | "excedido" | "informativo";

export interface PerfMetric {
  operacion: string;
  ms: number;
  presupuestoMs: number | null;
  veredicto: PerfVerdict;
  detalle?: string;
}

export interface PerfDataset {
  ventas: number;
  lineas: number;
  pagos: number;
  movimientos: number;
  totalVendido: number;
  ventasEnRango: number;
  totalEnRango: number;
}

export interface PerfRunResult {
  motor: PerfEngine;
  ventas: number;
  escalaPresupuesto: number;
  metricas: PerfMetric[];
  dataset: PerfDataset;
  excedido: boolean;
  notas: string[];
}

export interface PerfRunOptions {
  engine: PerfEngine;
  sales: number;
  seed?: number;
  /** Multiplicador de presupuesto (pruebas de CI usan 10). */
  budgetScale?: number;
  /** Directorio base del archivo SQLite; por defecto el temporal del sistema. */
  directory?: string;
  /** Diagnóstico de hidratación completa (caro con 50.000 ventas). */
  hydrationDiagnostic?: boolean;
}

const DAY_MS = 86_400_000;
/** Una venta cada 10 minutos: 50.000 ventas cubren algo menos de un año. */
const SALE_STEP_MS = 600_000;
const SALE_BASE_MS = Date.UTC(2026, 0, 1, 8, 0, 0);
const REPORT_WINDOW_DAYS = 30;

interface CatalogProduct {
  id: string;
  name: string;
  sku: string;
  price: number;
  costPrice: number;
}

export interface GeneratedSale {
  sale: {
    id: string;
    warehouseId: string;
    branchId: string;
    userId: string;
    date: string;
    status: string;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
  };
  items: HotSaleItemInput[];
  payments: HotSalePaymentInput[];
}

/** PRNG determinista (mulberry32): misma semilla, misma secuencia de datos. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function saleTimestamp(index: number): number {
  return SALE_BASE_MS + index * SALE_STEP_MS;
}

export function buildCatalog(random: () => number): CatalogProduct[] {
  return Array.from({ length: PERF_CATALOG_SIZE }, (_, index) => {
    const price = 25 + Math.floor(random() * 1_175);
    return {
      id: `p-${String(index).padStart(2, "0")}`,
      name: `Producto ${String(index).padStart(2, "0")}`,
      sku: `SKU-${String(index).padStart(3, "0")}`,
      price,
      costPrice: round2(price * 0.72)
    };
  });
}

/** Venta realista: 1-5 líneas, descuento ocasional y pago simple o mixto. */
export function buildSaleData(
  index: number,
  random: () => number,
  catalog: CatalogProduct[]
): GeneratedSale {
  const lineCount = 1 + Math.floor(random() * 5);
  const items: HotSaleItemInput[] = [];
  let subtotal = 0;
  for (let line = 0; line < lineCount; line += 1) {
    const product = catalog[Math.floor(random() * catalog.length)];
    const quantity = random() < 0.65 ? 1 : 1 + Math.floor(random() * 3);
    const unitPrice = product.price;
    const total = round2(quantity * unitPrice);
    subtotal = round2(subtotal + total);
    items.push({
      id: `l${line}`,
      productId: product.id,
      productName: product.name,
      quantity,
      unitPrice,
      total
    });
  }
  const discount = random() < 0.12 ? round2(subtotal * (0.02 + random() * 0.08)) : 0;
  const total = round2(subtotal - discount);
  const method = random();
  const payments: HotSalePaymentInput[] =
    method < 0.7
      ? [{ id: "pay-1", method: "cash", currencyCode: "CUP", amount: total, exchangeRate: 1 }]
      : method < 0.9
        ? [{ id: "pay-1", method: "transfer", currencyCode: "CUP", amount: total, exchangeRate: 1 }]
        : [
            { id: "pay-1", method: "cash", currencyCode: "CUP", amount: round2(total * 0.6), exchangeRate: 1 },
            { id: "pay-2", method: "transfer", currencyCode: "CUP", amount: round2(total - round2(total * 0.6)), exchangeRate: 1 }
          ];
  const date = new Date(saleTimestamp(index)).toISOString();
  return {
    sale: {
      id: `sale-${String(index).padStart(6, "0")}`,
      warehouseId: PERF_WAREHOUSE,
      branchId: PERF_WAREHOUSE,
      userId: "u-1",
      date,
      status: "completed",
      subtotal,
      discount,
      tax: 0,
      total
    },
    items,
    payments
  };
}

/** Semilla del catálogo: productos, existencias, sucursal y configuración. */
export async function seedCatalog(driver: LocalDbDriver, catalog: CatalogProduct[]): Promise<void> {
  const repositories = createRepositories(driver, {
    companyId: PERF_COMPANY,
    deviceId: PERF_DEVICE,
    now: () => "2026-01-01T00:00:00.000Z"
  });
  await repositories.storeConfig.save({ storeName: "Bodega Central", address: "Calle 1", phone: "555" });
  await repositories.products.saveMany(
    catalog.map<Product>((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      price: product.price,
      costPrice: product.costPrice,
      margin: round2(product.price - product.costPrice),
      categoryId: "c-1",
      color: "bg-white",
      commissionValue: 0
    }))
  );
  await repositories.inventory.saveMany(
    catalog.map<InventoryLevel>((product) => ({
      productId: product.id,
      warehouseId: PERF_WAREHOUSE,
      branchId: PERF_WAREHOUSE,
      variantLabel: "base",
      quantity: 1_000_000,
      minQuantity: 5
    }))
  );
  await driver.put("warehouses", [
    {
      id: PERF_WAREHOUSE,
      company_id: PERF_COMPANY,
      version: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
      origin_device: PERF_DEVICE,
      deleted_at: null,
      name: "Almacén",
      address: "Calle 1",
      phone: "555",
      is_main: true,
      is_active: true
    }
  ]);
}

export interface InsertOutcome {
  ms: number;
  ventas: number;
  lineas: number;
  pagos: number;
  movimientos: number;
  totalVendido: number;
  /** Ventas de la ventana de reporte (30 días finales) y su importe exacto. */
  ventasEnRango: number;
  totalEnRango: number;
}

/** Inserta las ventas por la ruta caliente real del POS. */
export async function insertSales(
  driver: LocalDbDriver,
  sales: number,
  seed: number
): Promise<InsertOutcome> {
  const random = createSeededRandom(seed);
  const catalog = buildCatalog(random);
  const rangeTo = saleTimestamp(Math.max(0, sales - 1)) + 1;
  const rangeFrom = rangeTo - REPORT_WINDOW_DAYS * DAY_MS;
  const started = performance.now();
  let lineas = 0;
  let pagos = 0;
  let movimientos = 0;
  let totalVendido = 0;
  let ventasEnRango = 0;
  let totalEnRango = 0;
  for (let index = 0; index < sales; index += 1) {
    const data = buildSaleData(index, random, catalog);
    const result = await recordSale({
      driver,
      companyId: PERF_COMPANY,
      deviceId: PERF_DEVICE,
      sale: data.sale,
      items: data.items,
      payments: data.payments,
      at: data.sale.date
    });
    if (!result.created) {
      throw new Error(`La venta ${data.sale.id} no se insertó: ${result.voided ? "anulada" : "duplicada"}`);
    }
    lineas += data.items.length;
    pagos += data.payments.length;
    movimientos += data.items.length;
    totalVendido += data.sale.total;
    const stamp = Date.parse(data.sale.date);
    if (stamp >= rangeFrom && stamp < rangeTo) {
      ventasEnRango += 1;
      totalEnRango += data.sale.total;
    }
  }
  return {
    ms: performance.now() - started,
    ventas: sales,
    lineas,
    pagos,
    movimientos,
    totalVendido: round2(totalVendido),
    ventasEnRango,
    totalEnRango: round2(totalEnRango)
  };
}

/** Reporte por rango: barrido por empresa y filtro de fechas en memoria. */
export async function reportRange(
  driver: LocalDbDriver,
  sales: number
): Promise<{ rows: number; count: number; total: number }> {
  const rows = await driver.query<LocalRow>({
    table: "sales",
    where: [{ field: "company_id", op: "eq", value: PERF_COMPANY }]
  });
  const rangeTo = saleTimestamp(Math.max(0, sales - 1)) + 1;
  const rangeFrom = rangeTo - REPORT_WINDOW_DAYS * DAY_MS;
  let count = 0;
  let total = 0;
  for (const row of rows) {
    const stamp = Date.parse(String(row.date ?? ""));
    if (!Number.isFinite(stamp) || stamp < rangeFrom || stamp >= rangeTo) continue;
    count += 1;
    total += Number(row.total ?? 0);
  }
  return { rows: rows.length, count, total: round2(total) };
}

/** Arranque equivalente: catálogo + ventana reciente + turnos abiertos. */
async function bootReads(driver: LocalDbDriver): Promise<{ products: number; stock: number; recent: number; sessions: number }> {
  const [products, stock, recent, sessions] = await Promise.all([
    listProducts(driver, { companyId: PERF_COMPANY }),
    listStockBalances(driver, { companyId: PERF_COMPANY }),
    listRecentSales(driver, { companyId: PERF_COMPANY, limit: 200 }),
    getOpenCashSessions(driver, { companyId: PERF_COMPANY })
  ]);
  return { products: products.length, stock: stock.length, recent: recent.length, sessions: sessions.length };
}

function metric(
  operacion: string,
  ms: number,
  presupuestoMs: number | null,
  detalle?: string
): PerfMetric {
  const rounded = Math.round(ms * 10) / 10;
  let veredicto: PerfVerdict = "informativo";
  if (presupuestoMs !== null) veredicto = rounded <= presupuestoMs ? "ok" : "excedido";
  return {
    operacion,
    ms: rounded,
    presupuestoMs,
    veredicto,
    ...(detalle ? { detalle } : {})
  };
}

/** Dataset vacío: mismo contrato que `InsertOutcome` cuando no se midió nada. */
function emptyDataset(): PerfDataset {
  return {
    ventas: 0,
    lineas: 0,
    pagos: 0,
    movimientos: 0,
    totalVendido: 0,
    ventasEnRango: 0,
    totalEnRango: 0
  };
}

function datasetFrom(insert: InsertOutcome): PerfDataset {
  return {
    ventas: insert.ventas,
    lineas: insert.lineas,
    pagos: insert.pagos,
    movimientos: insert.movimientos,
    totalVendido: insert.totalVendido,
    ventasEnRango: insert.ventasEnRango,
    totalEnRango: insert.totalEnRango
  };
}

/** Ventana reciente y reporte por rango: las dos lecturas que mide el POS. */
async function measureReadMetrics(
  driver: LocalDbDriver,
  sales: number,
  insert: InsertOutcome,
  scale: number,
  notas: string[]
): Promise<PerfMetric[]> {
  let started = performance.now();
  const recent = await listRecentSales(driver, { companyId: PERF_COMPANY, limit: 200 });
  const recentMetric = metric(
    "ultimas 200 ventas",
    performance.now() - started,
    PERFORMANCE_BUDGETS.last200Ms * scale,
    `${recent.length} filas`
  );

  started = performance.now();
  const report = await reportRange(driver, sales);
  const reportMetric = metric(
    `reporte ${REPORT_WINDOW_DAYS} dias`,
    performance.now() - started,
    PERFORMANCE_BUDGETS.reportRangeMs * scale,
    `${report.count} ventas de ${report.rows} escaneadas`
  );

  // El reporte debe cuadrar con lo insertado o la medición no vale nada.
  if (report.count !== insert.ventasEnRango || Math.abs(report.total - insert.totalEnRango) > 1e-6) {
    notas.push(
      `reporte inconsistente: esperado ${insert.ventasEnRango}/${insert.totalEnRango}, real ${report.count}/${report.total}`
    );
  }
  return [recentMetric, reportMetric];
}

function bootMetric(reads: Awaited<ReturnType<typeof bootReads>>, ms: number, scale: number): PerfMetric {
  return metric(
    "arranque (catalogo + ventana 200)",
    ms,
    PERFORMANCE_BUDGETS.bootMs * scale,
    `${reads.products} productos, ${reads.stock} saldos, ${reads.recent} ventas`
  );
}

async function openSqlite(filePath: string): Promise<LocalDbDriver> {
  const { createNodeSqliteAdapter } = await import("../src/services/localDb/sqlite/bindingNode");
  const { createSqliteDriver } = await import("../src/services/localDb/sqlite/driver");
  const adapter = await createNodeSqliteAdapter(filePath);
  return createSqliteDriver({ adapter, filePath });
}

async function runSqlite(options: PerfRunOptions): Promise<PerfRunResult> {
  const scale = options.budgetScale ?? 1;
  const seed = options.seed ?? 0x5eed2026;
  // Archivo real: el arranque debe medirse sobre disco, como en el móvil.
  const folder = mkdtempSync(join(options.directory ?? tmpdir(), "palmyra-perf-"));
  const filePath = join(folder, "perf.sqlite");
  const notas: string[] = [];
  const metricas: PerfMetric[] = [];
  let driver = await openSqlite(filePath);
  let dataset: PerfDataset = emptyDataset();
  try {
    await seedCatalog(driver, buildCatalog(createSeededRandom(seed)));
    const insert = await insertSales(driver, options.sales, seed);
    metricas.push(
      metric(
        `insercion ${options.sales} ventas`,
        insert.ms,
        // Suelo de 2,5 s: con pocas ventas manda el coste fijo de cada llamada.
        Math.max((PERFORMANCE_BUDGETS.insertTotalMs * options.sales * scale) / 50_000, 2_500 * scale),
        `${(insert.ms / Math.max(1, options.sales)).toFixed(2)} ms/venta; ${insert.lineas} líneas`
      )
    );

    metricas.push(...(await measureReadMetrics(driver, options.sales, insert, scale, notas)));

    if (options.hydrationDiagnostic) {
      const { hydrateFromLocalDb } = await import("../src/services/localDb/bootHydration");
      const started = performance.now();
      const hydrated = await hydrateFromLocalDb(PERF_COMPANY, { driver });
      metricas.push(
        metric(
          "hidratacion completa (diagnostico)",
          performance.now() - started,
          null,
          `${hydrated?.transactions.length ?? 0} ventas; fuera de presupuesto`
        )
      );
    }

    // Arranque real: se cierra y se abre la base desde el archivo.
    await driver.close();
    const bootStart = performance.now();
    driver = await openSqlite(filePath);
    metricas.push(bootMetric(await bootReads(driver), performance.now() - bootStart, scale));
    dataset = datasetFrom(insert);
  } finally {
    await driver.close();
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      // Un archivo temporal sin borrar no invalida la medición.
    }
  }
  return {
    motor: "sqlite",
    ventas: options.sales,
    escalaPresupuesto: scale,
    metricas,
    dataset,
    excedido: metricas.some((entry) => entry.veredicto === "excedido"),
    notas
  };
}

async function runMemory(options: PerfRunOptions): Promise<PerfRunResult> {
  const seed = options.seed ?? 0x5eed2026;
  const scale = options.budgetScale ?? 1;
  const notas: string[] = [
    "El driver en memoria copia todo el estado en cada transacción (O(n²) al insertar): la muestra es reducida y su inserción es informativa."
  ];
  const metricas: PerfMetric[] = [];
  let driver = createMemoryDriver({ now: () => "2026-01-01T00:00:00.000Z" });
  await driver.ready();
  await seedCatalog(driver, buildCatalog(createSeededRandom(seed)));
  let dataset: PerfDataset = emptyDataset();
  try {
    const insert = await insertSales(driver, options.sales, seed);
    metricas.push(
      metric(
        `insercion ${options.sales} ventas`,
        insert.ms,
        null,
        `${(insert.ms / Math.max(1, options.sales)).toFixed(2)} ms/venta; referencia, no presupuesto`
      )
    );

    metricas.push(...(await measureReadMetrics(driver, options.sales, insert, scale, notas)));

    // Reapertura sobre el snapshot persistido (mismo mecanismo que el respaldo).
    const snapshot = await readBackupSnapshot(driver);
    await driver.close();
    const bootStart = performance.now();
    driver = createMemoryDriver({ now: () => "2026-01-01T00:00:00.000Z" });
    await driver.ready();
    await applyBackupSnapshot(driver, snapshot, {
      company_id: PERF_COMPANY,
      origin_device: PERF_DEVICE,
      at: "2026-12-31T23:59:59.000Z"
    });
    metricas.push(bootMetric(await bootReads(driver), performance.now() - bootStart, scale));
    dataset = datasetFrom(insert);
  } finally {
    await driver.close();
  }
  return {
    motor: "memory",
    ventas: options.sales,
    escalaPresupuesto: scale,
    metricas,
    dataset,
    excedido: metricas.some((entry) => entry.veredicto === "excedido"),
    notas
  };
}

export async function runPerformanceBenchmark(options: PerfRunOptions): Promise<PerfRunResult> {
  return options.engine === "sqlite" ? runSqlite(options) : runMemory(options);
}

function parseArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  if (!found) return fallback;
  const value = Number(found.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function isSqliteRuntimeAvailable(): Promise<boolean> {
  try {
    const { createNodeSqliteAdapter } = await import("../src/services/localDb/sqlite/bindingNode");
    const adapter = await createNodeSqliteAdapter(":memory:");
    adapter.close();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const sales = parseArg("ventas", 50_000);
  const memorySales = parseArg("memoria", 1_000);
  const tieneSqlite = await isSqliteRuntimeAvailable();
  const runs: PerfRunResult[] = [];

  if (tieneSqlite) {
    runs.push(await runPerformanceBenchmark({ engine: "sqlite", sales, hydrationDiagnostic: true }));
  } else {
    runs.push({
      motor: "sqlite",
      ventas: sales,
      escalaPresupuesto: 1,
      metricas: [],
      dataset: emptyDataset(),
      excedido: false,
      notas: ["SQLite nativo no disponible: el presupuesto de 50.000 ventas NO se pudo medir en este runtime."]
    });
  }

  runs.push(await runPerformanceBenchmark({ engine: "memory", sales: tieneSqlite ? memorySales : 1_000 }));

  const excedido = runs.some((run) => run.excedido) || !tieneSqlite;
  const output = {
    arnes: "android-perf",
    generadoEn: new Date().toISOString(),
    aviso:
      "Los presupuestos son el limite superior aceptado del plan, no la medicion de un movil real. " +
      "El driver en memoria solo sirve de referencia; el motor de produccion es SQLite.",
    semilla: 0x5eed2026,
    presupuestos: PERFORMANCE_BUDGETS,
    veredicto: excedido ? "excedido" : "ok",
    ejecuciones: runs
  };
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = excedido ? 1 : 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await main();
}
