/**
 * Rutas calientes del almacén local: venta y caja.
 *
 * Cobrar es la operación más frecuente del POS y la que más caro sale si queda
 * a medias. Estas funciones escriben todo el efecto de negocio en UNA sola
 * transacción del driver (SQLite/IndexedDB): la venta, sus líneas, sus pagos,
 * el libro de inventario y los saldos; o el turno y sus movimientos de caja.
 *
 * Reglas que sostienen la ruta caliente:
 * - Solo anexado: venta, líneas, pagos y movimientos nunca se reescriben. La
 *   guarda de `appendOnly.ts` se ejecuta dentro de la transacción.
 * - Una venta anulada es un documento cerrado: `recordSale` la rechaza (sin
 *   lanzar) porque la anulación vive en `sale_voids` y nunca se deshace.
 * - Idempotencia por id: repetir `recordSale` con la misma venta no duplica
 *   nada y devuelve el mismo `actionId`; igual para cada movimiento de caja.
 * - Validación antes de escribir: si el total no cuadra con las líneas o los
 *   pagos no cubren el total, la transacción no empieza y el almacén queda
 *   intacto.
 *
 * El `actionId` devuelto usa la secuencia de anexado (1) porque estas filas se
 * escriben una sola vez; es determinista y sobrevive a los reintentos. El
 * outbox (`hubOutbox.ts`) usa la secuencia real del journal para el resto de
 * tablas.
 */
import type { LocalDbDriver, LocalDbTransaction, LocalRow, LocalTable } from "./contract";
import {
  assertAppendOnlyInsert,
  INVENTORY_LEDGER_TABLE
} from "./appendOnly";
import { operationActionId } from "./hubOutbox";
import { SALE_VOID_TABLE, assertSaleNotVoided, saleVoidId } from "./saleLifecycle";

/** Secuencia de anexado: una venta o un movimiento se escriben una sola vez. */
const APPEND_SEQ = 1;
/** Tolerancia por defecto (la caja en CUP redondea el total al entero). */
const DEFAULT_TOLERANCE = 0.75;

export type HotPathErrorCode = "invalid_input" | "totals_mismatch";

export class HotPathError extends Error {
  readonly code: HotPathErrorCode;

  constructor(code: HotPathErrorCode, message: string) {
    super(message);
    this.name = "HotPathError";
    this.code = code;
  }
}

export interface HotSaleItemInput {
  /** Se conserva como sufijo del id de la línea si viene. */
  id?: string;
  productId?: string;
  productName?: string;
  quantity: number;
  /** Precio capturado de la línea; `price` se acepta como alias. */
  unitPrice?: number;
  price?: number;
  total?: number;
  warehouseId?: string;
  variantLabel?: string;
  serialNumber?: string;
  [field: string]: unknown;
}

export interface HotSalePaymentInput {
  id?: string;
  method: "cash" | "transfer" | string;
  currencyCode: string;
  amount: number;
  /** Unidades de moneda base por unidad de la moneda del pago. */
  exchangeRate?: number;
  bankCardId?: string;
  [field: string]: unknown;
}

export interface HotSaleInput {
  id: string;
  total: number;
  subtotal?: number;
  tax?: number;
  discount?: number;
  warehouseId?: string;
  sessionId?: string;
  date?: string;
  status?: string;
  [field: string]: unknown;
}

export interface HotInventoryMovementInput {
  id?: string;
  productId: string;
  /** Negativo descuenta stock (venta). */
  quantityDelta: number;
  warehouseId?: string;
  variantLabel?: string;
  movementType?: string;
  referenceId?: string;
  [field: string]: unknown;
}

export interface RecordSaleInput {
  driver: LocalDbDriver;
  companyId: string;
  deviceId: string;
  sale: HotSaleInput;
  items: HotSaleItemInput[];
  payments: HotSalePaymentInput[];
  /** Si falta, se deriva un descuento por línea con `movement_type = sale`. */
  inventoryMovements?: HotInventoryMovementInput[];
  /** Reloj fijo para pruebas o recibo diferido. */
  at?: string;
  /** Diferencia aceptada al cuadrar totales (por defecto 0.75). */
  tolerance?: number;
}

export interface RecordSaleResult {
  saleId: string;
  actionId: string;
  /** false cuando la venta ya estaba anexada (reintento idempotente). */
  created: boolean;
  /** true cuando la venta está anulada: no se escribió ni se escribirá nada. */
  voided?: boolean;
}

export interface HotCashSessionInput {
  id: string;
  warehouseId?: string;
  branchId?: string;
  openedAt?: string;
  openingBalance?: number;
  status?: string;
  userId?: string;
  workerName?: string;
  [field: string]: unknown;
}

export interface HotCashMovementInput {
  /** Recomendado: sin id se deriva uno estable por posición. */
  id?: string;
  sessionId?: string;
  type: "income" | "expense";
  amount: number;
  currencyCode: string;
  description?: string;
  date?: string;
  warehouseId?: string;
  branchId?: string;
  workerName?: string;
  category?: string;
  [field: string]: unknown;
}

export interface RecordCashMovementInput {
  driver: LocalDbDriver;
  companyId: string;
  deviceId: string;
  /** Turno a abrir; se ignora si ya existe (nunca se reescribe). */
  session?: HotCashSessionInput;
  movements: HotCashMovementInput | HotCashMovementInput[];
  at?: string;
}

export interface RecordCashMovementResult {
  sessionId: string;
  /** Ids de los movimientos anexados en esta llamada (vacío en un reintento). */
  movementIds: string[];
  actionId: string;
  created: boolean;
}

const COMMON_KEYS = new Set([
  "id",
  "companyId",
  "company_id",
  "version",
  "updatedAt",
  "updated_at",
  "originDevice",
  "origin_device",
  "deletedAt",
  "deleted_at"
]);

/** Los hijos viven en sus tablas: el estado no se duplica en la cabecera JSON. */
const SALE_SKIP = new Set<string>([...COMMON_KEYS, "items", "payments", "changePayments"]);

const ITEM_SKIP = new Set<string>([...COMMON_KEYS, "product", "sale_id", "saleId", "unitPrice"]);

const PAYMENT_SKIP = new Set<string>([...COMMON_KEYS, "sale_id", "saleId"]);

const MOVEMENT_SKIP = new Set<string>([...COMMON_KEYS, "reference_id", "referenceId"]);

const SESSION_SKIP = new Set<string>([...COMMON_KEYS, "movements", "closingBalances", "closing_balances"]);

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HotPathError("invalid_input", message);
  return value;
}

function requireNumber(value: unknown, field: string, min: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < min) {
    throw new HotPathError("invalid_input", `El campo ${field} debe ser un número mayor o igual que ${min}`);
  }
  return number;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function copyBusinessFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  skip: Set<string>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || typeof value === "function") continue;
    if (skip.has(key)) continue;
    target[toSnakeCase(key)] = value;
  }
}

/** Id estable de la línea con el mismo criterio que el importador legado. */
function childId(prefix: string, rawId: unknown, index: number): string {
  if (typeof rawId === "string" && rawId.trim()) return prefix + rawId.trim();
  if (typeof rawId === "number" && Number.isFinite(rawId)) return prefix + String(rawId);
  return prefix + String(index);
}

function productOf(candidate: Record<string, unknown>): Record<string, unknown> | null {
  const product = candidate.product;
  return product && typeof product === "object" && !Array.isArray(product)
    ? (product as Record<string, unknown>)
    : null;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Id derivado del saldo, idéntico al que usa `importLegacy` para inventario. */
function stockBalanceId(productId: string, warehouseId: string, variant: string): string {
  return `stock:${productId}:${warehouseId}:${variant}`;
}

function variantOf(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "base";
}

interface NormalizedSale {
  saleId: string;
  warehouseId: string;
  total: number;
  subtotal: number;
  items: { input: HotSaleItemInput; total: number; quantity: number; unitPrice: number }[];
  payments: HotSalePaymentInput[];
}

/**
 * Cuadre previo a la escritura. Acepta las dos variantes de total que produce
 * la caja (con y sin descuento explícito) y exige que los pagos cubran el
 * total; el vuelto puede dejar pagos por encima.
 */
function normalizeSale(input: RecordSaleInput): NormalizedSale {
  if (!input || typeof input !== "object") {
    throw new HotPathError("invalid_input", "Falta el lote de venta");
  }
  const sale = input.sale as Record<string, unknown> | undefined;
  if (!sale || typeof sale !== "object") {
    throw new HotPathError("invalid_input", "Falta la venta a registrar");
  }
  const saleId = requireText(sale.id, "La venta necesita un id");
  const tolerance =
    input.tolerance === undefined ? DEFAULT_TOLERANCE : requireNumber(input.tolerance, "tolerance", 0);
  const total = requireNumber(sale.total, "total", 0);

  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) {
    throw new HotPathError("invalid_input", "La venta necesita al menos una línea");
  }

  const warehouseId =
    firstText(sale.warehouseId, sale.warehouse_id, sale.branchId, sale.branch_id) ?? "default";

  const items = rawItems.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new HotPathError("invalid_input", `La línea ${index} de la venta no es válida`);
    }
    const item = raw as HotSaleItemInput;
    const quantity = requireNumber(item.quantity, `quantity de la línea ${index}`, 0);
    if (quantity <= 0) {
      throw new HotPathError("invalid_input", `La línea ${index} necesita una cantidad mayor que 0`);
    }
    const unitPrice = requireNumber(
      item.unitPrice !== undefined ? item.unitPrice : item.price,
      `precio de la línea ${index}`,
      0
    );
    const captured = optionalNumber(item.total);
    const lineTotal = captured !== null && captured >= 0 ? captured : roundAmount(quantity * unitPrice);
    if (!Number.isFinite(lineTotal)) {
      throw new HotPathError("invalid_input", `El total de la línea ${index} no es válido`);
    }
    return { input: item, total: lineTotal, quantity, unitPrice };
  });

  const itemsTotal = roundAmount(items.reduce((sum, line) => sum + line.total, 0));
  const declaredSubtotal = optionalNumber(sale.subtotal);
  const subtotal = declaredSubtotal !== null && declaredSubtotal >= 0 ? declaredSubtotal : itemsTotal;
  if (Math.abs(subtotal - itemsTotal) > tolerance) {
    throw new HotPathError(
      "totals_mismatch",
      `El subtotal declarado (${subtotal}) no cuadra con las líneas (${itemsTotal})`
    );
  }

  const tax = optionalNumber(sale.tax) ?? 0;
  const discount = optionalNumber(sale.discount) ?? 0;
  const candidates = [subtotal + tax, subtotal + tax - discount];
  const matches = candidates.some((candidate) => Math.abs(candidate - total) <= tolerance);
  if (!matches) {
    throw new HotPathError(
      "totals_mismatch",
      `El total (${total}) no cuadra con subtotal (${subtotal}), impuesto (${tax}) y descuento (${discount})`
    );
  }

  const payments = (Array.isArray(input.payments) ? input.payments : []).map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new HotPathError("invalid_input", `El pago ${index} no es válido`);
    }
    const payment = raw as HotSalePaymentInput;
    requireText(payment.currencyCode, `El pago ${index} necesita currencyCode`);
    requireText(payment.method, `El pago ${index} necesita method`);
    requireNumber(payment.amount, `amount del pago ${index}`, 0);
    return payment;
  });

  if (total > 0) {
    if (payments.length === 0) {
      throw new HotPathError("invalid_input", "Una venta con total mayor que 0 necesita pagos");
    }
    const paid = payments.reduce((sum, payment) => {
      const rate = optionalNumber(payment.exchangeRate);
      const effective = rate !== null && rate > 0 ? rate : 1;
      return sum + requireNumber(payment.amount, "amount", 0) * effective;
    }, 0);
    if (paid + tolerance < total) {
      throw new HotPathError(
        "totals_mismatch",
        `Los pagos (${roundAmount(paid)}) no cubren el total (${total})`
      );
    }
  }

  return { saleId, warehouseId, total, subtotal, items, payments };
}

function buildSaleRow(input: RecordSaleInput, normalized: NormalizedSale, at: string): LocalRow {
  const row = {} as LocalRow;
  copyBusinessFields(row as Record<string, unknown>, input.sale as Record<string, unknown>, SALE_SKIP);
  const date = firstText((input.sale as Record<string, unknown>).date);
  row.id = normalized.saleId;
  row.company_id = input.companyId;
  row.version = 1;
  row.updated_at = date ?? at;
  row.origin_device = input.deviceId;
  row.deleted_at = null;
  if (row.warehouse_id === undefined) row.warehouse_id = normalized.warehouseId;
  if (row.subtotal === undefined) row.subtotal = normalized.subtotal;
  row.total = normalized.total;
  return row;
}

function buildSaleItemRows(
  input: RecordSaleInput,
  normalized: NormalizedSale,
  at: string
): LocalRow[] {
  const prefix = `${normalized.saleId}:item:`;
  return normalized.items.map((line, index) => {
    const source = line.input as unknown as Record<string, unknown>;
    const product = productOf(source);
    const row = {} as LocalRow;
    copyBusinessFields(row as Record<string, unknown>, source, ITEM_SKIP);
    row.id = childId(prefix, line.input.id, index);
    row.company_id = input.companyId;
    row.version = 1;
    row.updated_at = at;
    row.origin_device = input.deviceId;
    row.deleted_at = null;
    row.sale_id = normalized.saleId;
    row.product_id = firstText(line.input.productId, product?.id, row.product_id);
    row.product_name = firstText(line.input.productName, product?.name, row.product_name);
    row.quantity = line.quantity;
    row.price = line.unitPrice;
    row.total = line.total;
    if (row.warehouse_id === undefined) {
      row.warehouse_id = firstText(line.input.warehouseId, normalized.warehouseId);
    }
    return row;
  });
}

function buildSalePaymentRows(
  input: RecordSaleInput,
  normalized: NormalizedSale,
  at: string
): LocalRow[] {
  const prefix = `${normalized.saleId}:pay:`;
  return normalized.payments.map((payment, index) => {
    const row = {} as LocalRow;
    copyBusinessFields(row as Record<string, unknown>, payment as Record<string, unknown>, PAYMENT_SKIP);
    row.id = childId(prefix, payment.id, index);
    row.company_id = input.companyId;
    row.version = 1;
    row.updated_at = at;
    row.origin_device = input.deviceId;
    row.deleted_at = null;
    row.sale_id = normalized.saleId;
    row.currency_code = payment.currencyCode;
    row.method = payment.method;
    row.amount = requireNumber(payment.amount, "amount", 0);
    row.exchange_rate =
      optionalNumber(payment.exchangeRate) !== null && Number(payment.exchangeRate) > 0
        ? Number(payment.exchangeRate)
        : 1;
    row.created_at = at;
    return row;
  });
}

function buildMovementRows(
  input: RecordSaleInput,
  normalized: NormalizedSale,
  at: string
): LocalRow[] {
  const source: HotInventoryMovementInput[] =
    Array.isArray(input.inventoryMovements) && input.inventoryMovements.length > 0
      ? input.inventoryMovements
      : normalized.items.map((line) => ({
          productId: firstText(line.input.productId, productOf(line.input as unknown as Record<string, unknown>)?.id) ?? "",
          quantityDelta: -line.quantity,
          variantLabel: line.input.variantLabel,
          movementType: "sale"
        }));

  const prefix = `${normalized.saleId}:stock:`;
  return source.map((movement, index) => {
    if (!movement || typeof movement !== "object") {
      throw new HotPathError("invalid_input", `El movimiento de inventario ${index} no es válido`);
    }
    const record = movement as unknown as Record<string, unknown>;
    const row = {} as LocalRow;
    copyBusinessFields(row, record, MOVEMENT_SKIP);
    row.id = childId(prefix, movement.id, index);
    row.company_id = input.companyId;
    row.version = 1;
    row.updated_at = at;
    row.origin_device = input.deviceId;
    row.deleted_at = null;
    row.product_id = firstText(movement.productId, row.product_id);
    if (!row.product_id) {
      throw new HotPathError("invalid_input", `El movimiento ${index} necesita productId`);
    }
    row.warehouse_id =
      firstText(movement.warehouseId, row.warehouse_id, normalized.warehouseId) ?? "default";
    row.variant_label = variantOf(movement.variantLabel);
    row.quantity_delta = requireNumber(movement.quantityDelta, `quantityDelta del movimiento ${index}`, -Infinity);
    row.movement_type = firstText(movement.movementType) ?? "sale";
    row.reference_id = firstText(movement.referenceId) ?? normalized.saleId;
    row.created_at = at;
    return row;
  });
}

interface BalanceDelta {
  productId: string;
  warehouseId: string;
  variant: string;
  delta: number;
}

function aggregateBalanceDeltas(movements: LocalRow[]): BalanceDelta[] {
  const byKey = new Map<string, BalanceDelta>();
  for (const movement of movements) {
    const productId = String(movement.product_id ?? "");
    if (!productId) continue;
    const warehouseId = String(movement.warehouse_id ?? "default");
    const variant = variantOf(movement.variant_label);
    const delta = Number(movement.quantity_delta) || 0;
    const key = productId + "\u0000" + warehouseId + "\u0000" + variant;
    const current = byKey.get(key);
    if (current) current.delta += delta;
    else byKey.set(key, { productId, warehouseId, variant, delta });
  }
  return Array.from(byKey.values());
}

async function findStockBalance(
  tx: LocalDbTransaction,
  companyId: string,
  target: BalanceDelta
): Promise<LocalRow | null> {
  const derived = stockBalanceId(target.productId, target.warehouseId, target.variant);
  const direct = await tx.get<LocalRow>("stock_balances", derived);
  if (direct) return direct;
  const candidates = await tx.query<LocalRow>({
    table: "stock_balances",
    where: [
      { field: "company_id", op: "eq", value: companyId },
      { field: "product_id", op: "eq", value: target.productId },
      { field: "warehouse_id", op: "eq", value: target.warehouseId }
    ],
    includeDeleted: true
  });
  return (
    candidates.find((row) => variantOf(row.variant_label) === target.variant) ?? null
  );
}

async function buildBalanceRows(
  tx: LocalDbTransaction,
  input: RecordSaleInput,
  movements: LocalRow[],
  at: string
): Promise<LocalRow[]> {
  const rows: LocalRow[] = [];
  for (const target of aggregateBalanceDeltas(movements)) {
    const existing = await findStockBalance(tx, input.companyId, target);
    const row = (existing ? { ...existing } : {}) as LocalRow;
    row.id = existing?.id ?? stockBalanceId(target.productId, target.warehouseId, target.variant);
    row.company_id = input.companyId;
    row.version = (typeof existing?.version === "number" ? existing.version : 0) + 1;
    row.updated_at = at;
    row.origin_device = input.deviceId;
    row.deleted_at = null;
    row.product_id = target.productId;
    row.warehouse_id = target.warehouseId;
    if (target.variant !== "base") row.variant_label = target.variant;
    row.min_quantity = optionalNumber(row.min_quantity) ?? 0;
    row.quantity = roundQuantity((optionalNumber(existing?.quantity) ?? 0) + target.delta);
    rows.push(row);
  }
  return rows;
}

/**
 * Anexa una venta completa. Idempotente por `sale.id`: si ya existe, no escribe
 * nada y devuelve el mismo `actionId`. Una venta anulada se rechaza sin lanzar:
 * la anulación es un documento nuevo en `sale_voids` y la cabecera no se toca.
 */
export async function recordSale(input: RecordSaleInput): Promise<RecordSaleResult> {
  if (!input || !input.driver) {
    throw new HotPathError("invalid_input", "Falta el driver del almacén local");
  }
  const companyId = requireText(input.companyId, "Falta companyId");
  const deviceId = requireText(input.deviceId, "Falta deviceId");
  const saleId = requireText(input.sale?.id, "La venta necesita un id");

  // Una anulación es definitiva: reanexar la venta no la resucita.
  if (!(await assertSaleNotVoided(input.driver, saleId))) {
    return {
      saleId,
      actionId: operationActionId(deviceId, "sales", saleId, APPEND_SEQ),
      created: false,
      voided: true
    };
  }

  // Idempotencia primero: un reintento devuelve el mismo actionId aunque el
  // cuerpo haya quedado desactualizado; no se revalida lo que ya está anexado.
  const alreadyStored = await input.driver.get<LocalRow>("sales", saleId);
  if (alreadyStored) {
    return {
      saleId,
      actionId: operationActionId(deviceId, "sales", saleId, APPEND_SEQ),
      created: false
    };
  }

  const normalized = normalizeSale(input);
  const at = input.at ?? new Date().toISOString();
  const ledgerTable = INVENTORY_LEDGER_TABLE;

  const outcome = await input.driver.transaction(
    async (tx): Promise<"created" | "existing" | "voided"> => {
      // Segunda comprobación ya dentro de la transacción: la anulación pudo
      // llegar por el hub entre la guarda previa y este momento.
      const voidedRow = await tx.get<LocalRow>(SALE_VOID_TABLE, saleVoidId(normalized.saleId));
      if (voidedRow) return "voided";

      const existing = await tx.get<LocalRow>("sales", normalized.saleId);
      if (existing) return "existing";

      const saleRow = buildSaleRow(input, normalized, at);
      const itemRows = buildSaleItemRows(input, normalized, at);
      const paymentRows = buildSalePaymentRows(input, normalized, at);
      const movementRows = buildMovementRows(input, normalized, at);
      const balanceRows = await buildBalanceRows(tx, input, movementRows, at);

      // Guarda real de solo anexado: ningún id de estos libros puede existir ya.
      await assertAppendOnlyInsert(tx, "sales", [saleRow]);
      await assertAppendOnlyInsert(tx, "sale_items", itemRows);
      await assertAppendOnlyInsert(tx, "sale_payments", paymentRows);
      await assertAppendOnlyInsert(tx, ledgerTable, movementRows);

      await tx.put("sales", [saleRow]);
      if (itemRows.length > 0) await tx.put("sale_items", itemRows);
      if (paymentRows.length > 0) await tx.put("sale_payments", paymentRows);
      if (movementRows.length > 0) await tx.put(ledgerTable, movementRows);
      if (balanceRows.length > 0) await tx.put("stock_balances", balanceRows);
      return "created";
    }
  );

  const actionId = operationActionId(deviceId, "sales", normalized.saleId, APPEND_SEQ);
  if (outcome === "voided") {
    return { saleId: normalized.saleId, actionId, created: false, voided: true };
  }
  return { saleId: normalized.saleId, actionId, created: outcome === "created" };
}

function buildSessionRow(
  session: HotCashSessionInput,
  companyId: string,
  deviceId: string,
  at: string
): LocalRow {
  const row = {} as LocalRow;
  copyBusinessFields(row as Record<string, unknown>, session as Record<string, unknown>, SESSION_SKIP);
  row.id = requireText(session.id, "El turno necesita un id");
  row.company_id = companyId;
  row.version = 1;
  row.updated_at = firstText(session.openedAt) ?? at;
  row.origin_device = deviceId;
  row.deleted_at = null;
  if (row.warehouse_id === undefined) {
    row.warehouse_id = firstText(session.warehouseId, session.branchId);
  }
  if (row.status === undefined) row.status = "open";
  return row;
}

function buildCashMovementRows(
  movements: HotCashMovementInput[],
  sessionId: string,
  companyId: string,
  deviceId: string,
  at: string
): LocalRow[] {
  const prefix = `${sessionId}:mov:`;
  return movements.map((movement, index) => {
    if (!movement || typeof movement !== "object") {
      throw new HotPathError("invalid_input", `El movimiento de caja ${index} no es válido`);
    }
    if (movement.type !== "income" && movement.type !== "expense") {
      throw new HotPathError("invalid_input", `El movimiento ${index} necesita type income o expense`);
    }
    requireText(movement.currencyCode, `El movimiento ${index} necesita currencyCode`);
    const amount = requireNumber(movement.amount, `amount del movimiento ${index}`, 0);
    if (amount <= 0) {
      throw new HotPathError("invalid_input", `El movimiento ${index} necesita un monto mayor que 0`);
    }
    const row = {} as LocalRow;
    copyBusinessFields(row as Record<string, unknown>, movement as Record<string, unknown>, COMMON_KEYS);
    row.id = childId(prefix, movement.id, index);
    row.company_id = companyId;
    row.version = 1;
    row.updated_at = firstText(movement.date) ?? at;
    row.origin_device = deviceId;
    row.deleted_at = null;
    row.session_id = sessionId;
    row.type = movement.type;
    row.amount = amount;
    row.currency_code = movement.currencyCode;
    row.date = firstText(movement.date) ?? at;
    row.created_at = at;
    if (row.warehouse_id === undefined) row.warehouse_id = firstText(movement.warehouseId, movement.branchId);
    return row;
  });
}

/**
 * Anexa movimientos de caja (entrada/salida) y, si hace falta, abre el turno.
 * Un turno existente no se toca y un movimiento repetido no se duplica.
 */
export async function recordCashMovement(
  input: RecordCashMovementInput
): Promise<RecordCashMovementResult> {
  if (!input || !input.driver) {
    throw new HotPathError("invalid_input", "Falta el driver del almacén local");
  }
  const companyId = requireText(input.companyId, "Falta companyId");
  const deviceId = requireText(input.deviceId, "Falta deviceId");
  const at = input.at ?? new Date().toISOString();
  const list = Array.isArray(input.movements) ? input.movements : [input.movements];
  if (list.length === 0 || list[0] === undefined || list[0] === null) {
    throw new HotPathError("invalid_input", "Falta al menos un movimiento de caja");
  }

  const sessionId = requireText(
    input.session?.id ?? list[0]?.sessionId,
    "El movimiento de caja necesita un turno (session.id o movement.sessionId)"
  );
  const movementRows = buildCashMovementRows(list, sessionId, companyId, deviceId, at);

  const appended = await input.driver.transaction(async (tx) => {
    const existingSession = await tx.get<LocalRow>("cash_sessions", sessionId);
    if (!existingSession) {
      if (!input.session) {
        throw new HotPathError(
          "invalid_input",
          `No existe el turno ${sessionId} y no se envió la sesión para abrirlo`
        );
      }
      await tx.put("cash_sessions", [buildSessionRow(input.session, companyId, deviceId, at)]);
    }

    const pending: LocalRow[] = [];
    for (const row of movementRows) {
      const already = await tx.get<LocalRow>("cash_movements", row.id);
      if (already) continue;
      pending.push(row);
    }
    if (pending.length === 0) return [] as string[];

    await assertAppendOnlyInsert(tx, "cash_movements", pending);
    await tx.put("cash_movements", pending);
    return pending.map((row) => row.id);
  });

  const primaryId = appended[0] ?? movementRows[0].id;
  return {
    sessionId,
    movementIds: appended,
    actionId: operationActionId(deviceId, "cash_movements", primaryId, APPEND_SEQ),
    created: appended.length > 0
  };
}
