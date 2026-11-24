/**
 * Prueba de aguante del almacén local para la fase F4: 30 días sin red.
 *
 * Simula la operación real de un POS cubano que no puede sincronizar: turno
 * diario con apertura y cierre, ~120 ventas al día, dos devoluciones y una
 * transferencia por semana, respaldo cifrado diario y «cierre y reapertura» del
 * almacén cada noche sobre la foto persistida (nuevo driver + snapshot, el mismo
 * mecanismo que usa el respaldo; no se reutiliza el objeto del driver).
 *
 * Al final comprueba, contra lo que la simulación generó (no contra el propio
 * almacén, para que la verificación sea independiente):
 * - ventas totales exactas y sin actionId duplicado;
 * - existencias = inicial + ventas + devoluciones + transferencias, y
 *   existencias = inicial + suma del libro de movimientos;
 * - restauración final equivalente (conteos, importe y existencias).
 *
 * Determinista: misma semilla, mismo historial. Sale con código 1 ante cualquier
 * discrepancia.
 *
 * Uso: `npx tsx scripts/android-soak.ts [--dias=30]`.
 */
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { LocalDbDriver, LocalDbTransaction, LocalRow } from "../src/services/localDb/contract";
import { createMemoryDriver } from "../src/services/localDb/memoryDriver";
import { recordCashMovement, recordSale } from "../src/services/localDb/hotPaths";
import { createRepositories } from "../src/services/localDb/repositories";
import { assertAppendOnlyInsert } from "../src/services/localDb/appendOnly";
import { createBackup, restoreBackup } from "../src/services/localDb/backup/backup";
import { applyBackupSnapshot, readBackupSnapshot } from "../src/services/localDb/backup/snapshot";
import type { InventoryLevel, Product } from "../src/types";

export const SOAK_COMPANY = "11111111-1111-4111-8111-111111111111";
export const SOAK_DEVICE = "device-soak";
export const SOAK_WAREHOUSE = "wh-1";
export const SOAK_AUX_WAREHOUSE = "wh-2";
export const SOAK_PASSPHRASE = "palmyra-aguante-2026";
export const SOAK_SALES_PER_DAY = 120;
export const SOAK_PRODUCTS = 24;
/** Existencias iniciales: holgadas para que 30 días no agoten el catálogo. */
const INITIAL_MAIN = 10_000;
const INITIAL_AUX = 500;

const DAY_MS = 86_400_000;
/** Lunes 5 de enero de 2026, para que los patrones semanales sean estables. */
const CALENDAR_START_MS = Date.UTC(2026, 0, 5, 8, 0, 0);
const SHIFT_OPEN_OFFSET_MS = -3_600_000;
const SALE_FIRST_OFFSET_MS = 3_600_000;
const SALE_WINDOW_MS = 8 * 3_600_000;

/** PRNG determinista (mulberry32): misma semilla, mismo historial. */
function createSeededRandom(seed: number): () => number {
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

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function dayStart(day: number): number {
  return CALENDAR_START_MS + day * DAY_MS;
}

function dateKey(day: number): string {
  return new Date(dayStart(day)).toISOString().slice(0, 10);
}

/** Día de devolución: martes y viernes. */
function isReturnDay(day: number): boolean {
  const weekday = day % 7;
  return weekday === 1 || weekday === 4;
}

/** Día de transferencia: jueves. */
function isTransferDay(day: number): boolean {
  return day % 7 === 3;
}

export interface SoakOptions {
  days: number;
  seed?: number;
  salesPerDay?: number;
  /** Día del calendario donde arranca la simulación (0 = lunes). */
  startDay?: number;
  /** Respaldo cifrado diario; la prueba corta puede desactivarlo. */
  dailyBackup?: boolean;
  onProgress?: (message: string) => void;
}

export interface SoakCheck {
  nombre: string;
  ok: boolean;
  detalle: string;
}

export interface SoakSummary {
  dias: number;
  semilla: number;
  ventas: number;
  lineas: number;
  devoluciones: number;
  transferencias: number;
  turnos: number;
  reintentosIdempotentes: number;
  actionIds: number;
  respaldos: number;
  bytesUltimoRespaldo: number;
  ms: number;
  checks: SoakCheck[];
  ok: boolean;
}

interface BusinessSale {
  id: string;
  total: number;
  actionId: string;
  lines: { productId: string; quantity: number; price: number; name: string }[];
}

function stockKey(productId: string, warehouseId: string): string {
  return `${productId}|${warehouseId}`;
}

/** Filas de la empresa simulada en una tabla; todas las verificaciones filtran igual. */
function companyRows(driver: LocalDbDriver, table: string): Promise<LocalRow[]> {
  return driver.query<LocalRow>({
    table,
    where: [{ field: "company_id", op: "eq", value: SOAK_COMPANY }]
  });
}

async function seedWarehouse(driver: LocalDbDriver, catalog: Product[], now: string): Promise<void> {
  const repositories = createRepositories(driver, {
    companyId: SOAK_COMPANY,
    deviceId: SOAK_DEVICE,
    now: () => now
  });
  await repositories.storeConfig.save({ storeName: "Bodega Central", address: "Calle 1", phone: "555" });
  await repositories.products.saveMany(catalog);
  const levels: InventoryLevel[] = [];
  for (const product of catalog) {
    levels.push({
      productId: product.id,
      warehouseId: SOAK_WAREHOUSE,
      branchId: SOAK_WAREHOUSE,
      variantLabel: "base",
      quantity: INITIAL_MAIN,
      minQuantity: 10
    });
    levels.push({
      productId: product.id,
      warehouseId: SOAK_AUX_WAREHOUSE,
      branchId: SOAK_AUX_WAREHOUSE,
      variantLabel: "base",
      quantity: INITIAL_AUX,
      minQuantity: 5
    });
  }
  await repositories.inventory.saveMany(levels);
  await driver.put("warehouses", [
    {
      id: SOAK_WAREHOUSE,
      company_id: SOAK_COMPANY,
      version: 1,
      updated_at: now,
      origin_device: SOAK_DEVICE,
      deleted_at: null,
      name: "Almacén",
      address: "Calle 1",
      phone: "555",
      is_main: true,
      is_active: true
    },
    {
      id: SOAK_AUX_WAREHOUSE,
      company_id: SOAK_COMPANY,
      version: 1,
      updated_at: now,
      origin_device: SOAK_DEVICE,
      deleted_at: null,
      name: "Sucursal",
      address: "Calle 2",
      phone: "556",
      is_main: false,
      is_active: true
    }
  ]);
}

function buildCatalog(random: () => number): Product[] {
  return Array.from({ length: SOAK_PRODUCTS }, (_, index) => {
    const price = 30 + Math.floor(random() * 970);
    return {
      id: `p-${String(index).padStart(2, "0")}`,
      name: `Producto ${String(index).padStart(2, "0")}`,
      sku: `SKU-${String(index).padStart(3, "0")}`,
      price,
      costPrice: round2(price * 0.7),
      margin: round2(price * 0.3),
      categoryId: "c-1",
      color: "bg-white",
      commissionValue: 0
    };
  });
}

/** Ajusta el saldo del producto/almacén dentro de la transacción en curso. */
async function addBalanceRow(
  tx: LocalDbTransaction,
  productId: string,
  warehouseId: string,
  delta: number,
  at: string
): Promise<void> {
  const id = `stock:${productId}:${warehouseId}:base`;
  const existing = await tx.get<LocalRow>("stock_balances", id);
  await tx.put("stock_balances", [
    {
      ...(existing ?? {}),
      id,
      company_id: SOAK_COMPANY,
      version: (typeof existing?.version === "number" ? existing.version : 0) + 1,
      updated_at: at,
      origin_device: SOAK_DEVICE,
      deleted_at: null,
      product_id: productId,
      warehouse_id: warehouseId,
      quantity: round3(Number(existing?.quantity ?? 0) + delta),
      min_quantity: Number(existing?.min_quantity ?? 0)
    }
  ]);
}

function movementRow(
  id: string,
  productId: string,
  warehouseId: string,
  delta: number,
  movementType: string,
  referenceId: string,
  at: string
): LocalRow {
  return {
    id,
    company_id: SOAK_COMPANY,
    version: 1,
    updated_at: at,
    origin_device: SOAK_DEVICE,
    deleted_at: null,
    product_id: productId,
    warehouse_id: warehouseId,
    variant_label: "base",
    quantity_delta: delta,
    movement_type: movementType,
    reference_id: referenceId,
    created_at: at
  };
}

/** Devolución de una unidad: documento nuevo + entrada de inventario. */
async function appendReturn(
  driver: LocalDbDriver,
  sale: BusinessSale,
  lineIndex: number,
  at: string
): Promise<{ productId: string; quantity: number }> {
  const line = sale.lines[lineIndex % sale.lines.length];
  const returnId = `ret-${sale.id}-${lineIndex}`;
  const quantity = 1;
  const amount = round2(quantity * line.price);
  await driver.transaction(async (tx) => {
    const existing = await tx.get<LocalRow>("returns", returnId);
    if (existing) return;
    await tx.put("returns", [
      {
        id: returnId,
        company_id: SOAK_COMPANY,
        version: 1,
        updated_at: at,
        origin_device: SOAK_DEVICE,
        deleted_at: null,
        transaction_id: sale.id,
        product_id: line.productId,
        quantity,
        reason: "defective",
        date: at,
        status: "completed",
        type: "refund",
        branch_id: SOAK_WAREHOUSE,
        warehouse_id: SOAK_WAREHOUSE,
        variant_label: "base",
        refund_status: "paid",
        refund_amount: amount,
        refund_currency_code: "CUP",
        refund_method: "cash"
      }
    ]);
    await tx.put("return_items", [
      {
        id: `${returnId}:item:0`,
        company_id: SOAK_COMPANY,
        version: 1,
        updated_at: at,
        origin_device: SOAK_DEVICE,
        deleted_at: null,
        return_id: returnId,
        product_id: line.productId,
        product_name: line.name,
        quantity,
        price: line.price,
        total: amount,
        variant_label: "base"
      }
    ]);
    const movement = movementRow(
      `${returnId}:stock:0`,
      line.productId,
      SOAK_WAREHOUSE,
      quantity,
      "return",
      returnId,
      at
    );
    await assertAppendOnlyInsert(tx, "stock_movements", [movement]);
    await tx.put("stock_movements", [movement]);
    await addBalanceRow(tx, line.productId, SOAK_WAREHOUSE, quantity, at);
  });
  return { productId: line.productId, quantity };
}

/** Transferencia interna: un documento y dos movimientos compensados. */
async function appendTransfer(
  driver: LocalDbDriver,
  day: number,
  catalog: Product[],
  random: () => number,
  at: string
): Promise<{ productId: string; quantity: number }[]> {
  const transferId = `tr-${dateKey(day)}`;
  const lines = Array.from({ length: 3 }, () => {
    const product = catalog[Math.floor(random() * catalog.length)];
    return { productId: product.id, quantity: 3, name: product.name };
  });
  await driver.transaction(async (tx) => {
    const existing = await tx.get<LocalRow>("transfers", transferId);
    if (existing) return;
    await tx.put("transfers", [
      {
        id: transferId,
        company_id: SOAK_COMPANY,
        version: 1,
        updated_at: at,
        origin_device: SOAK_DEVICE,
        deleted_at: null,
        from_warehouse_id: SOAK_WAREHOUSE,
        to_warehouse_id: SOAK_AUX_WAREHOUSE,
        status: "received",
        date: at,
        item_count: lines.length,
        total_quantity: lines.reduce((sum, line) => sum + line.quantity, 0)
      }
    ]);
    await tx.put(
      "transfer_items",
      lines.map((line, index) => ({
        id: `${transferId}:item:${index}`,
        company_id: SOAK_COMPANY,
        version: 1,
        updated_at: at,
        origin_device: SOAK_DEVICE,
        deleted_at: null,
        transfer_id: transferId,
        product_id: line.productId,
        product_name: line.name,
        quantity: line.quantity,
        variant_label: "base"
      }))
    );
    const movements: LocalRow[] = [];
    for (const [index, line] of lines.entries()) {
      movements.push(
        movementRow(`${transferId}:stock:out:${index}`, line.productId, SOAK_WAREHOUSE, -line.quantity, "transfer_out", transferId, at)
      );
      movements.push(
        movementRow(`${transferId}:stock:in:${index}`, line.productId, SOAK_AUX_WAREHOUSE, line.quantity, "transfer_in", transferId, at)
      );
    }
    await assertAppendOnlyInsert(tx, "stock_movements", movements);
    await tx.put("stock_movements", movements);
    for (const line of lines) {
      await addBalanceRow(tx, line.productId, SOAK_WAREHOUSE, -line.quantity, at);
      await addBalanceRow(tx, line.productId, SOAK_AUX_WAREHOUSE, line.quantity, at);
    }
  });
  return lines.map((line) => ({ productId: line.productId, quantity: line.quantity }));
}

async function closeShift(driver: LocalDbDriver, sessionId: string, at: string): Promise<void> {
  await driver.transaction(async (tx) => {
    const session = await tx.get<LocalRow>("cash_sessions", sessionId);
    if (!session) return;
    await tx.put("cash_sessions", [
      { ...session, status: "closed", version: Number(session.version ?? 0) + 1, updated_at: at }
    ]);
  });
}

async function openShift(driver: LocalDbDriver, sessionId: string, at: string): Promise<string> {
  const result = await recordCashMovement({
    driver,
    companyId: SOAK_COMPANY,
    deviceId: SOAK_DEVICE,
    session: {
      id: sessionId,
      warehouseId: SOAK_WAREHOUSE,
      openedAt: at,
      openingBalance: 1_000,
      status: "open",
      userId: "u-1"
    },
    movements: [
      {
        id: `${sessionId}:fondo`,
        type: "income",
        amount: 1_000,
        currencyCode: "CUP",
        description: "Fondo de apertura",
        date: at
      }
    ],
    at
  });
  return result.actionId;
}

/** Reabre el almacén sobre la foto persistida, sin reutilizar el driver. */
async function reopen(driver: LocalDbDriver, now: string): Promise<LocalDbDriver> {
  const snapshot = await readBackupSnapshot(driver);
  await driver.close();
  const next = createMemoryDriver({ now: () => now });
  await next.ready();
  await applyBackupSnapshot(next, snapshot, {
    company_id: SOAK_COMPANY,
    origin_device: SOAK_DEVICE,
    at: now
  });
  return next;
}

export async function runSoak(options: SoakOptions): Promise<SoakSummary> {
  const days = Math.max(1, Math.floor(options.days));
  const startDay = Math.max(0, Math.floor(options.startDay ?? 0));
  const perDay = Math.max(1, Math.floor(options.salesPerDay ?? SOAK_SALES_PER_DAY));
  const seed = options.seed ?? 0x50a4c0de;
  const random = createSeededRandom(seed);
  const catalog = buildCatalog(random);
  const started = performance.now();
  const checks: SoakCheck[] = [];
  const actionIds = new Set<string>();
  const sales: BusinessSale[] = [];
  const expectedStock = new Map<string, number>();
  for (const product of catalog) {
    expectedStock.set(stockKey(product.id, SOAK_WAREHOUSE), INITIAL_MAIN);
    expectedStock.set(stockKey(product.id, SOAK_AUX_WAREHOUSE), INITIAL_AUX);
  }

  let driver = createMemoryDriver({ now: () => "2026-01-05T00:00:00.000Z" });
  await driver.ready();
  await seedWarehouse(driver, catalog, "2026-01-05T00:00:00.000Z");

  let totalSold = 0;
  let linesTotal = 0;
  let returnsCount = 0;
  let transfersCount = 0;
  let retries = 0;
  let backups = 0;
  let lastBackup: Uint8Array | null = null;
  const sessionIds: string[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const day = startDay + offset;
    const start = dayStart(day);
    const openedAt = new Date(start + SHIFT_OPEN_OFFSET_MS).toISOString();
    const closedAt = new Date(start + SALE_WINDOW_MS + SHIFT_OPEN_OFFSET_MS).toISOString();
    const sessionId = `turno-${dateKey(day)}`;
    sessionIds.push(sessionId);
    actionIds.add(await openShift(driver, sessionId, openedAt));

    const daySales: BusinessSale[] = [];
    for (let slot = 0; slot < perDay; slot += 1) {
      const at = new Date(start + SALE_FIRST_OFFSET_MS + Math.floor((slot * SALE_WINDOW_MS) / perDay)).toISOString();
      const lineCount = 1 + Math.floor(random() * 4);
      const items = Array.from({ length: lineCount }, () => {
        const product = catalog[Math.floor(random() * catalog.length)];
        const quantity = 1 + Math.floor(random() * 3);
        return {
          productId: product.id,
          productName: product.name,
          quantity,
          unitPrice: product.price
        };
      });
      const subtotal = round2(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
      const discount = random() < 0.1 ? round2(subtotal * 0.05) : 0;
      const total = round2(subtotal - discount);
      const id = `sale-${dateKey(day)}-${String(slot).padStart(3, "0")}`;
      const method = random() < 0.75 ? "cash" : "transfer";
      const result = await recordSale({
        driver,
        companyId: SOAK_COMPANY,
        deviceId: SOAK_DEVICE,
        sale: {
          id,
          warehouseId: SOAK_WAREHOUSE,
          branchId: SOAK_WAREHOUSE,
          userId: "u-1",
          date: at,
          status: "completed",
          subtotal,
          discount,
          total
        },
        items,
        payments: [{ method, currencyCode: "CUP", amount: total, exchangeRate: 1 }],
        at
      });
      if (!result.created) throw new Error(`La venta ${id} no se anexó`);
      actionIds.add(result.actionId);
      const business: BusinessSale = {
        id,
        total,
        actionId: result.actionId,
        lines: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          price: item.unitPrice,
          name: item.productName
        }))
      };
      for (const line of business.lines) {
        const key = stockKey(line.productId, SOAK_WAREHOUSE);
        expectedStock.set(key, round3((expectedStock.get(key) ?? 0) - line.quantity));
      }
      sales.push(business);
      daySales.push(business);
      totalSold = round2(totalSold + total);
      linesTotal += items.length;

      // Reintento del cobro (cola offline): mismo actionId, nada duplicado.
      if (slot % 17 === 0) {
        const retry = await recordSale({
          driver,
          companyId: SOAK_COMPANY,
          deviceId: SOAK_DEVICE,
          sale: { id, warehouseId: SOAK_WAREHOUSE, branchId: SOAK_WAREHOUSE, date: at, status: "completed", subtotal, discount, total },
          items,
          payments: [{ method, currencyCode: "CUP", amount: total, exchangeRate: 1 }],
          at
        });
        retries += 1;
        if (retry.created || retry.actionId !== result.actionId) {
          throw new Error(`El reintento de ${id} no fue idempotente`);
        }
      }
    }

    await closeShift(driver, sessionId, closedAt);

    if (isReturnDay(day)) {
      const target = daySales[daySales.length - 1];
      const returned = await appendReturn(driver, target, day, closedAt);
      const key = stockKey(returned.productId, SOAK_WAREHOUSE);
      expectedStock.set(key, round3((expectedStock.get(key) ?? 0) + returned.quantity));
      returnsCount += 1;
    }

    if (isTransferDay(day)) {
      const moved = await appendTransfer(driver, day, catalog, random, closedAt);
      for (const line of moved) {
        const from = stockKey(line.productId, SOAK_WAREHOUSE);
        const to = stockKey(line.productId, SOAK_AUX_WAREHOUSE);
        expectedStock.set(from, round3((expectedStock.get(from) ?? 0) - line.quantity));
        expectedStock.set(to, round3((expectedStock.get(to) ?? 0) + line.quantity));
      }
      transfersCount += 1;
    }

    if (options.dailyBackup !== false) {
      lastBackup = await createBackup({
        driver,
        passphrase: SOAK_PASSPHRASE,
        meta: { dia: day + 1, fecha: dateKey(day) },
        now: () => closedAt
      });
      backups += 1;
    }

    driver = await reopen(driver, closedAt);
    options.onProgress?.(`día ${day + 1}/${days} reabierto`);
  }

  // -------------------------------------------------------------------------
  // verificaciones
  // -------------------------------------------------------------------------
  const saleRows = await companyRows(driver, "sales");
  const itemRows = await companyRows(driver, "sale_items");
  const paymentRows = await companyRows(driver, "sale_payments");
  const returnRows = await companyRows(driver, "returns");
  const transferRows = await companyRows(driver, "transfers");
  const sessionRows = await companyRows(driver, "cash_sessions");
  const balanceRows = await companyRows(driver, "stock_balances");
  const movementRows = await companyRows(driver, "stock_movements");

  checks.push({
    nombre: "ventas-totales",
    ok: saleRows.length === days * perDay && sales.length === days * perDay,
    detalle: `esperado ${days * perDay}, real ${saleRows.length}`
  });

  const storedTotal = round2(saleRows.reduce((sum, row) => sum + Number(row.total ?? 0), 0));
  checks.push({
    nombre: "importe-vendido",
    ok: Math.abs(storedTotal - totalSold) <= 1e-6,
    detalle: `esperado ${totalSold}, real ${storedTotal}`
  });

  checks.push({
    nombre: "lineas-y-pagos",
    ok: itemRows.length === linesTotal && paymentRows.length >= days * perDay,
    detalle: `lineas ${itemRows.length}/${linesTotal}, pagos ${paymentRows.length}`
  });

  const uniqueIds = new Set(saleRows.map((row) => row.id));
  checks.push({
    nombre: "sin-ventas-duplicadas",
    ok: uniqueIds.size === saleRows.length && actionIds.size === saleRows.length + sessionIds.length,
    detalle: `ids ${uniqueIds.size}, actionIds ${actionIds.size}`
  });

  checks.push({
    nombre: "documentos",
    ok:
      returnRows.length === returnsCount &&
      transferRows.length === transfersCount &&
      sessionRows.length === days,
    detalle: `devoluciones ${returnRows.length}/${returnsCount}, transferencias ${transferRows.length}/${transfersCount}, turnos ${sessionRows.length}/${days}`
  });

  // A) saldo esperado desde los hechos de negocio, sin leer el libro.
  // B) saldo = inicial + suma del libro de movimientos (coherencia del ledger).
  const ledger = new Map<string, number>();
  for (const movement of movementRows) {
    const key = stockKey(String(movement.product_id ?? ""), String(movement.warehouse_id ?? ""));
    ledger.set(key, round3((ledger.get(key) ?? 0) + Number(movement.quantity_delta ?? 0)));
  }
  let mismatchesA = 0;
  let mismatchesB = 0;
  for (const [key, expected] of expectedStock) {
    const [productId, warehouseId] = key.split("|");
    const row = balanceRows.find(
      (candidate) => candidate.product_id === productId && candidate.warehouse_id === warehouseId
    );
    const actual = Number(row?.quantity ?? 0);
    if (Math.abs(actual - expected) > 1e-6) mismatchesA += 1;
    const initial = warehouseId === SOAK_WAREHOUSE ? INITIAL_MAIN : INITIAL_AUX;
    if (Math.abs(actual - (initial + (ledger.get(key) ?? 0))) > 1e-6) mismatchesB += 1;
  }
  checks.push({
    nombre: "existencias-vs-ventas",
    ok: mismatchesA === 0,
    detalle: `${expectedStock.size} saldos comprobados, ${mismatchesA} descuadres`
  });
  checks.push({
    nombre: "existencias-vs-libro",
    ok: mismatchesB === 0 && movementRows.length > 0,
    detalle: `${movementRows.length} movimientos, ${mismatchesB} descuadres`
  });

  checks.push({
    nombre: "respaldos-diarios",
    ok: lastBackup !== null && backups === days,
    detalle: `${backups} respaldos, ultimo ${lastBackup?.byteLength ?? 0} bytes`
  });

  // C) restauración final sobre un almacén vacío: debe ser equivalente.
  if (lastBackup) {
    const target = createMemoryDriver({ now: () => "2026-02-10T00:00:00.000Z" });
    await target.ready();
    const report = await restoreBackup({ bytes: lastBackup, passphrase: SOAK_PASSPHRASE, driver: target });
    const restoredSales = await companyRows(target, "sales");
    const restoredBalances = await companyRows(target, "stock_balances");
    const restoredTotal = round2(restoredSales.reduce((sum, row) => sum + Number(row.total ?? 0), 0));
    const quantity = (rows: LocalRow[]): number =>
      round3(rows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0));
    const countsOk =
      report.counts.sales === saleRows.length &&
      report.counts.sale_items === itemRows.length &&
      report.counts.stock_balances === balanceRows.length &&
      report.totalRows === Object.values(report.counts).reduce((sum, value) => sum + value, 0);
    checks.push({
      nombre: "restauracion-equivalente",
      ok:
        countsOk &&
        restoredSales.length === saleRows.length &&
        Math.abs(restoredTotal - storedTotal) <= 1e-6 &&
        Math.abs(quantity(restoredBalances) - quantity(balanceRows)) <= 1e-6,
      detalle: `filas ${report.totalRows}, ventas ${restoredSales.length}, importe ${restoredTotal}`
    });
    await target.close();
  } else {
    checks.push({
      nombre: "restauracion-equivalente",
      ok: false,
      detalle: "no se generó ningún respaldo"
    });
  }

  await driver.close();
  const ok = checks.every((check) => check.ok);
  return {
    dias: days,
    semilla: seed,
    ventas: saleRows.length,
    lineas: itemRows.length,
    devoluciones: returnRows.length,
    transferencias: transferRows.length,
    turnos: sessionRows.length,
    reintentosIdempotentes: retries,
    actionIds: actionIds.size,
    respaldos: backups,
    bytesUltimoRespaldo: lastBackup?.byteLength ?? 0,
    ms: Math.round(performance.now() - started),
    checks,
    ok
  };
}

async function main(): Promise<void> {
  const found = process.argv.find((argument) => argument.startsWith("--dias="));
  const days = found ? Number(found.slice("--dias=".length)) : 30;
  const summary = await runSoak({
    days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 30,
    onProgress: (message) => {
      if (process.argv.includes("--verboso")) console.error(message);
    }
  });
  console.log(JSON.stringify({ arnes: "android-soak", ...summary }, null, 2));
  process.exitCode = summary.ok ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await main();
}
