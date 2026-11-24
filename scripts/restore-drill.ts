/**
 * SIMULACRO DE RESTAURACIÓN DE PALMYRA (`npm run drill:restore`).
 *
 * Comprueba, sin tocar la base real ni ninguna ruta de disco, que la cadena
 * respaldo cifrado → borrado → restauración devuelve EXACTAMENTE el mismo
 * almacén y dentro del objetivo de aceptación (< 15 minutos).
 *
 * Pasos:
 *   1. Genera un conjunto sintético determinista (33 tablas del contrato,
 *      5 000 ventas, 2 000 saldos de stock, caja, transferencias, etc.).
 *   2. Lo escribe en un driver local en MEMORIA.
 *   3. Crea el respaldo cifrado con la misma rutina que usa la app y lo
 *      inspecciona (hash, conteos y filas) antes de continuar.
 *   4. Descarta el almacén (driver nuevo con filas basura) y restaura.
 *   5. Verifica conteos por tabla, total de ventas, cantidad en stock, que las
 *      filas basura desaparecieron y que el hash del almacén restaurado es
 *      idéntico al del respaldo.
 *
 * El proceso termina con código 1 si hay cualquier diferencia o si el
 * simulacro supera los 15 minutos; 0 en caso contrario.
 *
 * La frase de prueba es FIJA y solo existe para este simulacro: aquí no se
 * maneja ningún respaldo real ni se imprime material sensible.
 */
import { pathToFileURL } from "node:url";

import type { LocalDbDriver, LocalRow, LocalTable } from "../src/services/localDb/contract";
import { createMemoryDriver } from "../src/services/localDb/memoryDriver";
import { LOCAL_DB_TABLE_NAMES } from "../src/services/localDb/schema";
import {
  canonicalJson,
  createBackupResult,
  inspectBackup,
  restoreBackup,
  sha256Hex,
  type RestoreReport
} from "../src/services/localDb/backup/index";

/** Frase del simulacro: no protege datos reales, solo ejercita el cifrado. */
export const DRILL_PASSPHRASE = "palmyra-simulacro-2026";
/** Objetivo de aceptación del plan F7: restauración completa en < 15 min. */
export const RESTORE_DRILL_LIMIT_MS = 15 * 60 * 1000;
/** El conjunto debe cubrir al menos 20 tablas del contrato. */
export const MIN_DRILL_TABLES = 20;
export const DEFAULT_SALES_ROWS = 5000;
export const DEFAULT_STOCK_ROWS = 2000;

const DRILL_COMPANY_ID = "empresa-simulacro";
const DRILL_CREATED_AT = "2026-11-20T08:00:00.000Z";
const DRILL_DEVICE = "drill-restauracion";

/* ───────────────────────── Confirmación y preflight ─────────────────────── */

/** Palabra exacta que el operador debe escribir para habilitar la restauración. */
export const RESTORE_CONFIRMATION_WORD = "RESTAURAR";

/**
 * Guarda pura de la doble confirmación de la interfaz: palabra exacta, aviso
 * de reemplazo aceptado y diálogo nativo confirmado. Sin las tres cosas no se
 * restaura nada.
 */
export function isRestoreConfirmationValid(input: {
  typed: string;
  acknowledged: boolean;
  dialogConfirmed: boolean;
}): boolean {
  return (
    typeof input?.typed === "string" &&
    input.typed.trim() === RESTORE_CONFIRMATION_WORD &&
    input.acknowledged === true &&
    input.dialogConfirmed === true
  );
}

/**
 * Guarda pura previa a restaurar el hub: la instantánea de seguridad debe
 * haberse creado con éxito ANTES de escribir. El proceso principal aplica la
 * misma regla antes de llamar a `restoreBackup`.
 */
export function evaluateHubRestorePreflight(input: {
  confirmed: boolean;
  inFlight?: boolean;
  companyId?: string;
  safetySnapshot?: { ok: boolean; fileName?: string } | null;
}): { ok: boolean; error?: string } {
  if (input?.confirmed !== true) {
    return { ok: false, error: "La restauración exige confirmación explícita." };
  }
  if (input.inFlight === true) {
    return { ok: false, error: "Ya hay una restauración del hub en curso." };
  }
  if (typeof input.companyId !== "string" || input.companyId.trim() === "") {
    return { ok: false, error: "No se pudo determinar la empresa del hub." };
  }
  if (!input.safetySnapshot || input.safetySnapshot.ok !== true) {
    return { ok: false, error: "La instantánea de seguridad falló; no se restaura nada." };
  }
  return { ok: true };
}

/* ───────────────────────────── Conjunto sintético ───────────────────────── */

export interface DrillDatasetOptions {
  companyId?: string;
  createdAt?: string;
  salesCount?: number;
  stockCount?: number;
}

export interface DrillDataset {
  companyId: string;
  createdAt: string;
  tables: Record<string, LocalRow[]>;
  counts: Record<string, number>;
  totalRows: number;
  /** Tablas con al menos una fila. */
  tableCount: number;
  salesCount: number;
  salesTotal: number;
  stockQuantity: number;
  cashMovements: number;
  transfers: number;
}

export interface DrillSnapshot {
  counts: Record<string, number>;
  totalRows: number;
  salesCount: number;
  salesTotal: number;
  stockQuantity: number;
  /** SHA-256 del contenido de las tablas (fecha y journal aparte). */
  hash: string;
}

function byId(a: LocalRow, b: LocalRow): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Huella del CONTENIDO de las tablas, independiente de la fecha del respaldo y
 * del `seq` del journal (que avanza al restaurar y por diseño nunca retrocede).
 * Si dos almacenes tienen las mismas filas, aquí dan el mismo hash.
 */
export async function drillContentHash(tables: Record<string, LocalRow[]>): Promise<string> {
  const ordered: Record<string, LocalRow[]> = {};
  const counts: Record<string, number> = {};
  let totalRows = 0;
  for (const table of LOCAL_DB_TABLE_NAMES) {
    const rows = (tables[table] ?? []).slice().sort(byId);
    ordered[table] = rows;
    counts[table] = rows.length;
    totalRows += rows.length;
  }
  return sha256Hex(canonicalJson({ tables: ordered, counts, totalRows }));
}

function clampCount(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function sumField(rows: LocalRow[], field: string): number {
  let total = 0;
  for (const row of rows) {
    const value = Number(row[field]);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

function isoAt(baseMs: number, offsetMinutes: number): string {
  return new Date(baseMs + offsetMinutes * 60_000).toISOString();
}

/**
 * Conjunto de datos determinista. No usa aleatoriedad: dos simulacros generan
 * el mismo contenido y el mismo hash, así que una diferencia siempre es un
 * fallo real de la restauración.
 */
export function buildDrillDataset(options: DrillDatasetOptions = {}): DrillDataset {
  const companyId =
    typeof options.companyId === "string" && options.companyId.trim()
      ? options.companyId.trim()
      : DRILL_COMPANY_ID;
  const createdAt =
    typeof options.createdAt === "string" && Number.isFinite(Date.parse(options.createdAt))
      ? options.createdAt
      : DRILL_CREATED_AT;
  const salesCount = clampCount(options.salesCount, DEFAULT_SALES_ROWS);
  const stockCount = clampCount(options.stockCount, DEFAULT_STOCK_ROWS);
  const baseMs = Date.parse(createdAt);

  const tables: Record<string, LocalRow[]> = {};
  for (const name of LOCAL_DB_TABLE_NAMES) tables[name] = [];
  const add = (table: LocalTable, row: LocalRow): void => {
    tables[table].push(row);
  };
  const make = (id: string, extra: Record<string, unknown> = {}): LocalRow => ({
    id,
    company_id: companyId,
    version: 1,
    updated_at: createdAt,
    origin_device: DRILL_DEVICE,
    deleted_at: null,
    ...extra
  });

  const warehouses = ["suc-central", "suc-norte", "suc-sur", "almacen"];
  const warehouseOf = (index: number): string => warehouses[index % warehouses.length];

  // Empresa y ajustes.
  add("companies", make("empresa", { name: "PALMYRA Simulacro", currency: "CUP", active: true }));
  add(
    "company_settings",
    make("ajustes-empresa", {
      company_name: "PALMYRA Simulacro",
      currency: "CUP",
      tax_rate: 0,
      low_stock_alert: 5,
      updated_by: DRILL_DEVICE
    })
  );

  warehouses.forEach((warehouseId, index) => {
    add(
      "warehouses",
      make(warehouseId, {
        name: `Sucursal ${index + 1}`,
        code: `S${index + 1}`,
        kind: index === warehouses.length - 1 ? "almacen" : "tienda",
        active: true
      })
    );
  });

  // Catálogo base (300 productos y sus derivados).
  const productCount = Math.max(12, Math.ceil(salesCount / 16));
  for (let index = 0; index < productCount; index += 1) {
    const productId = `producto-${index}`;
    add(
      "products",
      make(productId, {
        name: `Producto ${index}`,
        sku: `SKU-${String(index).padStart(5, "0")}`,
        barcode: `750000${String(index).padStart(6, "0")}`,
        category: ["bebidas", "alimentos", "limpieza", "ferreteria"][index % 4],
        price: 100 + (index % 40) * 25,
        cost: 60 + (index % 35) * 15,
        unit: "unidad",
        active: true
      })
    );
    if (index % 2 === 0) {
      add("product_variants", make(`variante-${index}`, {
        product_id: productId,
        name: "Presentación estándar",
        factor: 1
      }));
      add("product_codes", make(`codigo-${index}`, {
        product_id: productId,
        code: `COD-${String(index).padStart(6, "0")}`,
        kind: "barcode"
      }));
    }
    add("product_prices", make(`precio-${index}-0`, {
      product_id: productId,
      warehouse_id: warehouseOf(0),
      price: 100 + (index % 40) * 25,
      currency: "CUP"
    }));
    add("product_prices", make(`precio-${index}-1`, {
      product_id: productId,
      warehouse_id: warehouseOf(1),
      price: 105 + (index % 40) * 25,
      currency: "CUP"
    }));
  }

  // Stock: 2 000 saldos y su ledger de movimientos.
  let stockQuantity = 0;
  for (let index = 0; index < stockCount; index += 1) {
    const quantity = (index * 13) % 120;
    stockQuantity += quantity;
    add("stock_balances", make(`saldo-${index}`, {
      product_id: `producto-${index % productCount}`,
      warehouse_id: warehouseOf(index),
      quantity,
      reserved: index % 5 === 0 ? 1 : 0,
      min_stock: 5,
      deleted_at: index > 0 && index % 997 === 0 ? createdAt : null
    }));
    add("stock_movements", make(`mov-stock-${index}`, {
      product_id: `producto-${index % productCount}`,
      warehouse_id: warehouseOf(index),
      delta: index % 3 === 0 ? -2 : quantity > 0 ? 2 : 0,
      kind: index % 2 === 0 ? "venta" : "reposicion",
      reference_id: `venta-${index}`,
      created_at: isoAt(baseMs, -index)
    }));
  }

  // Caja: 60 turnos y 900 movimientos.
  const cashSessionCount = Math.max(4, Math.ceil(salesCount / 80));
  for (let index = 0; index < cashSessionCount; index += 1) {
    add("cash_sessions", make(`turno-${index}`, {
      warehouse_id: warehouseOf(index),
      opened_at: isoAt(baseMs, -index * 480),
      closed_at: index % 4 === 0 ? null : isoAt(baseMs, -index * 480 + 420),
      opening_amount: 500 + index * 25,
      closing_amount: index % 4 === 0 ? null : 900 + index * 25,
      status: index % 4 === 0 ? "abierto" : "cerrado",
      opened_by: `empleado-${index % 12}`
    }));
  }
  const cashMovements = Math.max(8, Math.ceil(salesCount / 6));
  for (let index = 0; index < cashMovements; index += 1) {
    add("cash_movements", make(`mov-caja-${index}`, {
      session_id: `turno-${index % cashSessionCount}`,
      warehouse_id: warehouseOf(index),
      kind: ["venta", "retiro", "deposito"][index % 3],
      amount: index % 7 === 0 ? -(20 + (index % 90)) : 20 + (index % 90),
      created_at: isoAt(baseMs, -index),
      reference_id: `venta-${index}`
    }));
  }

  // Ventas (5 000 por defecto): cabecera, ítem y pago.
  let salesTotal = 0;
  for (let index = 0; index < salesCount; index += 1) {
    const saleId = `venta-${index}`;
    const total = 100 + ((index * 37) % 900);
    salesTotal += total;
    add("sales", make(saleId, {
      warehouse_id: warehouseOf(index),
      date: isoAt(baseMs, -index * 8).slice(0, 10),
      created_at: isoAt(baseMs, -index * 8),
      total,
      subtotal: total,
      tax: 0,
      discount: index % 11 === 0 ? 5 : 0,
      currency: "CUP",
      status: index % 211 === 0 ? "anulada" : "completada",
      payment_method: ["efectivo", "transferencia", "tarjeta"][index % 3],
      customer_id: index % 3 === 0 ? null : `cliente-${index % 200}`,
      seller_id: `empleado-${index % 12}`,
      ncf: `B01${String(index).padStart(8, "0")}`,
      deleted_at: index > 0 && index % 499 === 0 ? createdAt : null
    }));
    add("sale_items", make(`item-${index}`, {
      sale_id: saleId,
      product_id: `producto-${index % productCount}`,
      warehouse_id: warehouseOf(index),
      quantity: 1 + (index % 4),
      unit_price: total,
      subtotal: total
    }));
    add("sale_payments", make(`pago-${index}`, {
      sale_id: saleId,
      method: ["efectivo", "transferencia", "tarjeta"][index % 3],
      amount: total,
      currency: "CUP",
      created_at: isoAt(baseMs, -index * 8)
    }));
    if (index % 211 === 0) {
      add("sale_voids", make(`anulacion-${index}`, {
        sale_id: saleId,
        branch_id: warehouseOf(index),
        reason: "Simulacro de anulación",
        voided_at: isoAt(baseMs, -index * 8 + 30),
        created_by: `empleado-${index % 12}`
      }));
    }
  }

  // Compras, transferencias y devoluciones.
  const purchaseCount = Math.max(4, Math.ceil(salesCount / 40));
  for (let index = 0; index < purchaseCount; index += 1) {
    const purchaseId = `compra-${index}`;
    add("purchases", make(purchaseId, {
      supplier_id: `proveedor-${index % 40}`,
      warehouse_id: warehouseOf(index),
      created_at: isoAt(baseMs, -index * 120),
      total: 1000 + index * 10,
      status: "recibida"
    }));
    add("purchase_items", make(`compra-item-${index}`, {
      purchase_id: purchaseId,
      product_id: `producto-${index % productCount}`,
      quantity: 10 + (index % 20),
      unit_cost: 50 + (index % 30)
    }));
  }
  const transfers = Math.max(6, Math.ceil(salesCount / 90));
  for (let index = 0; index < transfers; index += 1) {
    const transferId = `traslado-${index}`;
    add("transfers", make(transferId, {
      from_warehouse_id: warehouseOf(index),
      to_warehouse_id: warehouseOf(index + 1),
      created_at: isoAt(baseMs, -index * 300),
      status: ["despachado", "recibido", "cancelado"][index % 3],
      total_items: 3
    }));
    for (let item = 0; item < 3; item += 1) {
      add("transfer_items", make(`traslado-item-${index}-${item}`, {
        transfer_id: transferId,
        product_id: `producto-${(index + item) % productCount}`,
        quantity: 1 + item
      }));
    }
  }
  const returnCount = Math.max(4, Math.ceil(salesCount / 120));
  for (let index = 0; index < returnCount; index += 1) {
    const returnId = `devolucion-${index}`;
    add("returns", make(returnId, {
      sale_id: `venta-${index}`,
      warehouse_id: warehouseOf(index),
      created_at: isoAt(baseMs, -index * 240),
      total: 50 + index,
      reason: "Simulacro",
      status: "completada"
    }));
    add("return_items", make(`devolucion-item-${index}`, {
      return_id: returnId,
      product_id: `producto-${index % productCount}`,
      quantity: 1
    }));
  }

  // Cotizaciones, bancos y auditorías.
  const quoteCount = Math.max(4, Math.ceil(salesCount / 60));
  for (let index = 0; index < quoteCount; index += 1) {
    const quoteId = `cotizacion-${index}`;
    add("quotes", make(quoteId, {
      customer_id: `cliente-${index % 200}`,
      created_at: isoAt(baseMs, -index * 180),
      total: 300 + index,
      status: "enviada"
    }));
    add("quote_items", make(`cotizacion-item-${index}`, {
      quote_id: quoteId,
      product_id: `producto-${index % productCount}`,
      quantity: 2,
      unit_price: 150
    }));
  }
  for (let index = 0; index < 6; index += 1) {
    add("banks", make(`banco-${index}`, {
      name: `Banco ${index + 1}`,
      currency: index % 2 === 0 ? "CUP" : "USD",
      balance: 1000 * (index + 1),
      active: true
    }));
  }
  const bankMovements = Math.max(6, Math.ceil(salesCount / 9));
  for (let index = 0; index < bankMovements; index += 1) {
    add("bank_movements", make(`mov-banco-${index}`, {
      bank_id: `banco-${index % 6}`,
      kind: index % 2 === 0 ? "deposito" : "retiro",
      amount: 100 + index,
      created_at: isoAt(baseMs, -index),
      reference: `REF-${index}`
    }));
  }
  const auditCount = Math.max(3, Math.ceil(salesCount / 200));
  for (let index = 0; index < auditCount; index += 1) {
    const auditId = `auditoria-${index}`;
    add("inventory_audits", make(auditId, {
      warehouse_id: warehouseOf(index),
      created_at: isoAt(baseMs, -index * 600),
      status: "cerrada",
      items: 10
    }));
    for (let item = 0; item < 10; item += 1) {
      add("inventory_audit_items", make(`auditoria-item-${index}-${item}`, {
        audit_id: auditId,
        product_id: `producto-${(index + item) % productCount}`,
        expected: 10,
        counted: 10 - (item % 2)
      }));
    }
  }

  // Secuencias NCF, contactos y estado interno del hub.
  for (let index = 0; index < 3; index += 1) {
    add("ncf_sequences", make(`ncf-${index}`, {
      prefix: ["B01", "B02", "B14"][index],
      next_number: 1000 + index,
      active: true
    }));
  }
  const customerCount = Math.max(4, Math.ceil(salesCount / 25));
  for (let index = 0; index < customerCount; index += 1) {
    add("customers", make(`cliente-${index}`, {
      name: `Cliente ${index}`,
      phone: `555${String(index).padStart(4, "0")}`,
      email: null,
      balance: index % 5
    }));
  }
  for (let index = 0; index < Math.max(2, Math.ceil(salesCount / 200)); index += 1) {
    add("suppliers", make(`proveedor-${index}`, {
      name: `Proveedor ${index}`,
      contact: `Contacto ${index}`,
      active: true
    }));
  }
  add("hub_devices", make("equipo-caja-1", {
    device_id: "caja-1",
    device_name: "PC Caja 1",
    platform: "win32",
    token_hash: "0".repeat(64),
    paired_at: createdAt,
    revoked_at: null
  }));
  add("hub_devices", make("equipo-movil-1", {
    device_id: "movil-1",
    device_name: "Móvil 1",
    platform: "android",
    token_hash: "1".repeat(64),
    paired_at: createdAt,
    revoked_at: null
  }));
  for (let index = 0; index < Math.max(2, Math.ceil(salesCount / 200)); index += 1) {
    add("hub_receipts", make(`recibo-${index}`, {
      action_id: `accion-${index}`,
      device_id: "caja-1",
      created_at: isoAt(baseMs, -index)
    }));
  }

  const counts: Record<string, number> = {};
  let totalRows = 0;
  let tableCount = 0;
  for (const name of LOCAL_DB_TABLE_NAMES) {
    const length = tables[name].length;
    counts[name] = length;
    totalRows += length;
    if (length > 0) tableCount += 1;
  }

  return {
    companyId,
    createdAt,
    tables,
    counts,
    totalRows,
    tableCount,
    salesCount: tables.sales.length,
    salesTotal,
    stockQuantity,
    cashMovements: tables.cash_movements.length,
    transfers: tables.transfers.length
  };
}

/* ───────────────────── Comparación pura de expectativa ──────────────────── */

/**
 * Compara el almacén restaurado con el conjunto original. Devuelve la lista de
 * diferencias en español (vacía = restauración exacta).
 */
export function compareDrillExpectation(
  expected: DrillDataset,
  actual: DrillSnapshot
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const table of LOCAL_DB_TABLE_NAMES) {
    const wanted = expected.counts[table] ?? 0;
    const got = actual.counts[table] ?? 0;
    if (wanted !== got) {
      mismatches.push(`tabla ${table}: esperado ${wanted}, restaurado ${got}`);
    }
  }
  if (expected.totalRows !== actual.totalRows) {
    mismatches.push(`filas totales: esperado ${expected.totalRows}, restaurado ${actual.totalRows}`);
  }
  if (expected.salesCount !== actual.salesCount) {
    mismatches.push(`ventas: esperado ${expected.salesCount}, restaurado ${actual.salesCount}`);
  }
  if (expected.salesTotal !== actual.salesTotal) {
    mismatches.push(`total de ventas: esperado ${expected.salesTotal}, restaurado ${actual.salesTotal}`);
  }
  if (expected.stockQuantity !== actual.stockQuantity) {
    mismatches.push(
      `cantidad en stock: esperado ${expected.stockQuantity}, restaurado ${actual.stockQuantity}`
    );
  }
  if (!actual.hash || !/^[a-f0-9]{64}$/.test(actual.hash)) {
    mismatches.push("hash del almacén restaurado ausente o inválido");
  }
  return { ok: mismatches.length === 0, mismatches };
}

/* ───────────────────────────── Ejecución ────────────────────────────────── */

export interface RunRestoreDrillOptions {
  dataset?: DrillDataset;
  passphrase?: string;
  /** Solo para pruebas: reloj inyectable del tiempo total del simulacro. */
  clock?: () => number;
  salesCount?: number;
  stockCount?: number;
  limitMs?: number;
}

export interface RestoreDrillResult {
  ok: boolean;
  exitCode: 0 | 1;
  caughtAt: string;
  elapsedMs: number;
  limitMs: number;
  withinLimit: boolean;
  dataset: {
    tableCount: number;
    totalRows: number;
    salesCount: number;
    salesTotal: number;
    stockQuantity: number;
    cashMovements: number;
    transfers: number;
  };
  backup: {
    fileName: string;
    sizeBytes: number;
    /** Hash de contenido de las tablas originales. */
    hash: string;
    /** Hash del sobre cifrado que declara el respaldo. */
    envelopeHash: string;
    createdAt: string;
    totalRows: number;
  };
  restore: RestoreReport;
  restored: DrillSnapshot;
  hashMatches: boolean;
  staleRowsRemoved: boolean;
  mismatches: string[];
}

const STALE_SALE_ID = "basura-venta-no-debe-volver";
const STALE_PRODUCT_ID = "basura-producto-no-debe-volver";

async function seedDataset(driver: LocalDbDriver, dataset: DrillDataset): Promise<void> {
  for (const table of LOCAL_DB_TABLE_NAMES) {
    const rows = dataset.tables[table] ?? [];
    for (let index = 0; index < rows.length; index += 1000) {
      await driver.put(table, rows.slice(index, index + 1000));
    }
  }
}

async function addStaleRows(driver: LocalDbDriver, companyId: string, createdAt: string): Promise<void> {
  const stale = (id: string): LocalRow => ({
    id,
    company_id: companyId,
    version: 1,
    updated_at: createdAt,
    origin_device: DRILL_DEVICE,
    deleted_at: null
  });
  await driver.put("sales", [stale(STALE_SALE_ID)]);
  await driver.put("products", [stale(STALE_PRODUCT_ID)]);
}

async function snapshotOf(driver: LocalDbDriver): Promise<DrillSnapshot> {
  const tables: Record<string, LocalRow[]> = {};
  const counts: Record<string, number> = {};
  let totalRows = 0;
  for (const table of LOCAL_DB_TABLE_NAMES) {
    const rows = await driver.query<LocalRow>({ table, includeDeleted: true });
    tables[table] = rows;
    counts[table] = rows.length;
    totalRows += rows.length;
  }
  const hash = await drillContentHash(tables);
  const sales = tables.sales ?? [];
  const stock = tables.stock_balances ?? [];
  return {
    counts,
    totalRows,
    salesCount: sales.length,
    salesTotal: sumField(sales, "total"),
    stockQuantity: sumField(stock, "quantity"),
    hash
  };
}

/**
 * Ejecuta el simulacro completo en memoria. Nunca toca la base real ni el
 * disco: los dos almacenes son drivers en memoria y el respaldo vive en RAM.
 */
export async function runRestoreDrill(options: RunRestoreDrillOptions = {}): Promise<RestoreDrillResult> {
  const dataset =
    options.dataset ??
    buildDrillDataset({
      ...(options.salesCount !== undefined ? { salesCount: options.salesCount } : {}),
      ...(options.stockCount !== undefined ? { stockCount: options.stockCount } : {})
    });
  const passphrase =
    typeof options.passphrase === "string" && options.passphrase.length > 0
      ? options.passphrase
      : DRILL_PASSPHRASE;
  const clock = options.clock ?? (() => Date.now());
  const limitMs =
    typeof options.limitMs === "number" && Number.isFinite(options.limitMs) && options.limitMs > 0
      ? options.limitMs
      : RESTORE_DRILL_LIMIT_MS;
  const startedAt = clock();
  const caughtAt = new Date().toISOString();

  // 1) Almacén original en memoria.
  const source = createMemoryDriver();
  await source.ready();
  await seedDataset(source, dataset);

  // 2) Respaldo cifrado real + inspección sin escribir.
  const contentHashBefore = await drillContentHash(dataset.tables);
  const backup = await createBackupResult({
    driver: source,
    passphrase,
    now: () => dataset.createdAt,
    meta: { drill: "restore", company: dataset.companyId }
  });
  const inspected = await inspectBackup({ bytes: backup.bytes, passphrase });

  // 3) Borrado: driver nuevo con filas basura que deben desaparecer.
  await source.close();
  const target = createMemoryDriver();
  await target.ready();
  await addStaleRows(target, dataset.companyId, dataset.createdAt);

  // 4) Restauración verificada (descifra, valida hash y escribe en transacción).
  const restoreReport = await restoreBackup({
    bytes: backup.bytes,
    passphrase,
    driver: target,
    mutation: { company_id: dataset.companyId, origin_device: DRILL_DEVICE },
    now: () => dataset.createdAt
  });

  // 5) Hash del almacén restaurado, independiente de la fecha y del journal.
  const restored = await snapshotOf(target);
  const staleSale = await target.get("sales", STALE_SALE_ID);
  const staleProduct = await target.get("products", STALE_PRODUCT_ID);
  await target.close();

  const comparison = compareDrillExpectation(dataset, restored);
  const mismatches = [...comparison.mismatches];
  if (inspected.hash !== backup.summary.hash || inspected.totalRows !== dataset.totalRows) {
    mismatches.push("el respaldo inspeccionado no coincide con el conjunto original");
  }
  const hashMatches = contentHashBefore === restored.hash;
  if (!hashMatches) {
    mismatches.push(`hash: original ${contentHashBefore}, restaurado ${restored.hash}`);
  }
  if (!restoreReport.hash || restoreReport.hash !== backup.summary.hash) {
    mismatches.push("el informe de restauración no declara el hash del respaldo");
  }
  const staleRowsRemoved = staleSale === null && staleProduct === null;
  if (!staleRowsRemoved) mismatches.push("las filas basura del almacén vaciado siguen presentes");

  const elapsedMs = Math.max(0, clock() - startedAt);
  const withinLimit = elapsedMs <= limitMs;
  if (!withinLimit) {
    mismatches.push(
      `tiempo: ${elapsedMs} ms supera el límite de ${limitMs} ms (15 min)`
    );
  }

  return {
    ok: mismatches.length === 0,
    exitCode: mismatches.length === 0 ? 0 : 1,
    caughtAt,
    elapsedMs,
    limitMs,
    withinLimit,
    dataset: {
      tableCount: dataset.tableCount,
      totalRows: dataset.totalRows,
      salesCount: dataset.salesCount,
      salesTotal: dataset.salesTotal,
      stockQuantity: dataset.stockQuantity,
      cashMovements: dataset.cashMovements,
      transfers: dataset.transfers
    },
    backup: {
      fileName: backup.summary.fileName,
      sizeBytes: backup.summary.sizeBytes,
      hash: contentHashBefore,
      envelopeHash: backup.summary.hash,
      createdAt: backup.summary.createdAt,
      totalRows: backup.summary.totalRows
    },
    restore: restoreReport,
    restored,
    hashMatches,
    staleRowsRemoved,
    mismatches
  };
}

/* ───────────────────────────── Informe ──────────────────────────────────── */

function pad(value: string | number, size: number): string {
  return String(value).padStart(size, " ");
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "n/d";
  const totalSeconds = value / 1000;
  if (totalSeconds < 60) return `${value.toFixed(1)} ms (${totalSeconds.toFixed(2)} s)`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${value.toFixed(1)} ms (${minutes} min ${seconds.toFixed(1)} s)`;
}

/** Informe en español listo para consola. Nunca incluye la frase del respaldo. */
export function formatRestoreDrillReport(result: RestoreDrillResult): string {
  const lines: string[] = [];
  lines.push("==============================================================");
  lines.push("  SIMULACRO DE RESTAURACIÓN — PALMYRA POS");
  lines.push("==============================================================");
  lines.push(`Ejecutado: ${result.caughtAt}`);
  lines.push("");
  lines.push("Conjunto sintético (en memoria, sin tocar la base real):");
  lines.push(`  Tablas con datos:      ${result.dataset.tableCount} (mínimo 20)`);
  lines.push(`  Filas totales:         ${result.dataset.totalRows}`);
  lines.push(`  Ventas:                ${result.dataset.salesCount}`);
  lines.push(`  Total de ventas:       ${result.dataset.salesTotal}`);
  lines.push(`  Cantidad en stock:     ${result.dataset.stockQuantity}`);
  lines.push(`  Movimientos de caja:   ${result.dataset.cashMovements}`);
  lines.push(`  Transferencias:        ${result.dataset.transfers}`);
  lines.push("");
  lines.push("Respaldo cifrado:");
  lines.push(`  Archivo:               ${result.backup.fileName}`);
  lines.push(`  Tamaño:                ${result.backup.sizeBytes} bytes`);
  lines.push(`  Filas:                 ${result.backup.totalRows}`);
  lines.push(`  Hash de contenido:     ${result.backup.hash}`);
  lines.push(`  Hash del respaldo:     ${result.backup.envelopeHash}`);
  lines.push("");
  lines.push("Restauración:");
  lines.push(`  Filas escritas:        ${result.restore.written}`);
  lines.push(`  Filas eliminadas:      ${result.restore.removed}`);
  lines.push(`  Filas restauradas:     ${result.restored.totalRows}`);
  lines.push(`  Hash restaurado:       ${result.restored.hash}`);
  lines.push(`  Hash idéntico:         ${result.hashMatches ? "sí" : "NO"}`);
  lines.push(`  Basura eliminada:      ${result.staleRowsRemoved ? "sí" : "NO"}`);
  lines.push("");
  lines.push("Tiempo:");
  lines.push(`  Transcurrido:          ${formatMs(result.elapsedMs)}`);
  lines.push(`  Límite (15 min):       ${formatMs(result.limitMs)}`);
  lines.push(`  Dentro del objetivo:   ${result.withinLimit ? "sí" : "NO"}`);
  if (result.mismatches.length > 0) {
    lines.push("");
    lines.push(`Diferencias (${result.mismatches.length}):`);
    for (const mismatch of result.mismatches) lines.push(`  - ${mismatch}`);
    lines.push("");
    lines.push("VEREDICTO: FALLO — revisa las diferencias antes de dar el rollback por bueno.");
  } else {
    lines.push("");
    lines.push("VEREDICTO: CORRECTO — la restauración reproduce el almacén y cumple el objetivo.");
  }
  lines.push("==============================================================");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const result = await runRestoreDrill();
  console.log(formatRestoreDrillReport(result));
  process.exitCode = result.exitCode;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`SIMULACRO DE RESTAURACIÓN: FALLO — ${detail}`);
    process.exitCode = 1;
  });
}
