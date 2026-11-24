/**
 * Ciclo de vida de la venta en el almacén local.
 *
 * La venta es un libro de solo anexado: anular no es borrarla ni corregir su
 * cabecera, es anexar un documento nuevo en `sale_voids`. Así el hub LAN y la
 * nube replican la anulación sin romper la regla de append-only y sin perder el
 * rastro del cobro original (la venta, sus líneas, sus pagos y sus movimientos
 * de inventario se conservan tal cual se escribieron).
 *
 * Reglas:
 * - Idempotencia por id determinista `void:<saleId>`: repetir la anulación
 *   devuelve la fila existente y el mismo `actionId`, sin escribir de nuevo.
 * - Una sola transacción: comprobar la anulación previa, comprobar la venta y
 *   escribir el documento ocurren juntos; si algo falla, el almacén queda como
 *   estaba.
 * - Nunca se lanza para informar «no existe la venta» ni «ya estaba anulada»:
 *   el resultado lo dice con `created: false` y `skipped`, porque ambos casos
 *   son reintentos legítimos de la cola offline.
 * - La guarda `assertSaleNotVoided` tampoco lanza: devuelve `false` cuando la
 *   venta está anulada, de modo que la ruta caliente rechace la escritura sin
 *   tumbar el cobro.
 */
import type { LocalDbDriver, LocalDbTransaction, LocalRow, LocalTable } from "./contract";
import { assertAppendOnlyInsert } from "./appendOnly";
import { operationActionId } from "./hubOutbox";

/**
 * Tabla física del libro de anulaciones. El contrato compartido todavía no la
 * lista en `LocalTable`; se usa la misma conversión tipada que el resto del
 * almacén para no cambiar las firmas públicas que ya consumen los demás
 * módulos. Cuando el contrato la declare, este alias encaja sin cambios.
 */
export const SALE_VOID_TABLE: LocalTable = "sale_voids" as LocalTable;

/** Prefijo del id determinista de la anulación. */
export const SALE_VOID_ID_PREFIX = "void:";

/** Secuencia de anexado: una anulación se escribe una sola vez. */
const APPEND_SEQ = 1;

/**
 * Motivos estables. El consumidor (sombra legada, reportes, nube) compara por
 * código, nunca por texto libre: `legacy_removed` es una venta que desapareció
 * del JSON legado, `user_void` una anulación del cajero y `refund_full` una
 * devolución total que cierra la venta.
 */
export const SALE_VOID_REASONS = Object.freeze({
  legacy_removed: "legacy_removed",
  user_void: "user_void",
  refund_full: "refund_full"
} as const);

export type SaleVoidReasonCode = (typeof SALE_VOID_REASONS)[keyof typeof SALE_VOID_REASONS];

export type SaleVoidErrorCode = "invalid_input" | "company_mismatch";

export class SaleVoidError extends Error {
  readonly code: SaleVoidErrorCode;

  constructor(code: SaleVoidErrorCode, message: string) {
    super(message);
    this.name = "SaleVoidError";
    this.code = code;
  }
}

/** Fila del libro de anulaciones tal como queda almacenada. */
export interface SaleVoidRow extends LocalRow {
  sale_id: string;
  branch_id: string | null;
  reason: string;
  voided_at: string;
  created_by: string | null;
}

/**
 * Venta a anular. Lo normal es pasar su id; los alias permiten reutilizar la
 * entidad `Sale` o la fila del almacén sin convertirla antes.
 */
export interface SaleVoidSaleRef {
  id?: string;
  saleId?: string;
  sale_id?: string;
  branchId?: string;
  branch_id?: string;
  warehouseId?: string;
  warehouse_id?: string;
  user_id?: string;
  created_by?: string;
  status?: string;
  [field: string]: unknown;
}

export type SaleVoidSale = string | SaleVoidSaleRef;

/** Entrada de `buildSaleVoidRow` y `recordSaleVoid`. */
export interface SaleVoidInput {
  driver: LocalDbDriver;
  companyId: string;
  deviceId: string;
  /** Venta anulada. Obligatoria salvo que se use el alias heredado `sale`. */
  saleId?: string;
  /** Alias heredado: la fila de la venta o su id (sombra legada). */
  sale?: SaleVoidSale;
  /** Motivo; por defecto `user_void`. */
  reason?: string;
  /** Sucursal de la venta; si falta se toma de la venta almacenada. */
  branchId?: string | null;
  createdBy?: string | null;
  /** Reloj fijo para pruebas o importación diferida. */
  voidedAt?: string;
  [field: string]: unknown;
}

/** Alias heredado del contrato de entrada. */
export type RecordSaleVoidInput = SaleVoidInput;

export type SaleVoidSkipReason = "missing_sale" | "already_voided";

export interface RecordSaleVoidResult {
  voidId: string;
  saleId: string;
  actionId: string;
  /** false cuando no se escribió nada (venta ausente o ya anulada). */
  created: boolean;
  /** Motivo del no-op; `null` cuando la anulación se anexó en esta llamada. */
  skipped: SaleVoidSkipReason | null;
  /** Fila anulada o preexistente; `null` si la venta no existe. */
  row: SaleVoidRow | null;
}

export type EffectiveSaleStatus = "completed" | "voided" | "refunded" | "partial_refund";

/** Id determinista de la anulación: la misma venta produce siempre la misma fila. */
export function saleVoidId(saleId: string): string {
  return SALE_VOID_ID_PREFIX + String(saleId ?? "").trim();
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function requireText(value: unknown, message: string): string {
  const text = firstText(value);
  if (!text) throw new SaleVoidError("invalid_input", message);
  return text;
}

function referenceOf(sale: SaleVoidSale | undefined): SaleVoidSaleRef | null {
  return sale && typeof sale === "object" ? sale : null;
}

/** Id de la venta aceptando tanto `saleId` como el alias heredado `sale`. */
function saleIdOf(input: SaleVoidInput): string {
  if (!input || typeof input !== "object") return "";
  const direct = firstText(input.saleId);
  if (direct) return direct;
  if (typeof input.sale === "string") return input.sale.trim();
  const reference = referenceOf(input.sale);
  return reference ? firstText(reference.id, reference.saleId, reference.sale_id) ?? "" : "";
}

function reasonOf(reason: unknown): string {
  const text = firstText(reason);
  if (text) return text;
  if (reason === undefined || reason === null) return SALE_VOID_REASONS.user_void;
  throw new SaleVoidError("invalid_input", "El motivo de la anulación debe ser un texto no vacío");
}

/**
 * true si el listado de anulaciones contiene una anulación viva de la venta.
 * Acepta las filas del almacén (incluidas las que llegan con `includeDeleted`)
 * y también objetos mínimos con `sale_id`; una fila borrada no anula nada.
 */
export function isSaleVoided(voids: LocalRow[] | null | undefined, saleId: string): boolean {
  const id = typeof saleId === "string" ? saleId.trim() : "";
  if (!id || !Array.isArray(voids)) return false;
  const expectedId = saleVoidId(id);
  return voids.some((row) => {
    if (!row || typeof row !== "object" || row.deleted_at) return false;
    const linked = firstText(row.sale_id);
    if (linked) return linked === id;
    // Sin columna `sale_id`, el id determinista sigue identificando la anulación.
    return row.id === expectedId;
  });
}

/**
 * Estado efectivo para reportes y arqueos: la anulación manda sobre todo lo
 * demás. `voided` puede ser el booleano ya calculado con `isSaleVoided` o el
 * listado de anulaciones; en este último caso se cruza con el id de la venta.
 */
export function effectiveSaleStatus(
  status: string | SaleVoidSaleRef | null | undefined,
  voided: boolean | LocalRow[] | null | undefined
): EffectiveSaleStatus {
  const reference = status && typeof status === "object" ? status : null;
  const saleId = reference ? firstText(reference.id, reference.saleId, reference.sale_id) ?? "" : "";
  const isVoided =
    typeof voided === "boolean"
      ? voided
      : saleId
        ? isSaleVoided(voided as LocalRow[], saleId)
        : false;
  if (isVoided) return "voided";

  const original =
    (typeof status === "string" ? status : reference ? firstText(reference.status) : undefined) ?? "";
  if (original === "voided") return "voided";
  if (original === "refunded") return "refunded";
  if (original === "partial_refund") return "partial_refund";
  return "completed";
}

async function findExistingVoid(
  tx: LocalDbTransaction,
  companyId: string,
  saleId: string,
  voidId: string
): Promise<LocalRow | null> {
  const direct = await tx.get<LocalRow>(SALE_VOID_TABLE, voidId);
  if (direct) return direct;
  // Una anulación llegada por el hub podría tener otro id: se busca por venta.
  const rows = await tx.query<LocalRow>({
    table: SALE_VOID_TABLE,
    where: [
      { field: "company_id", op: "eq", value: companyId },
      { field: "sale_id", op: "eq", value: saleId }
    ],
    includeDeleted: true,
    limit: 1
  });
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Construye la fila del libro de anulaciones sin tocar el almacén. Función pura
 * salvo el reloj: si no se fija `voidedAt`, se usa el instante actual.
 */
export function buildSaleVoidRow(input: SaleVoidInput): SaleVoidRow {
  if (!input || typeof input !== "object") {
    throw new SaleVoidError("invalid_input", "Falta la anulación de venta");
  }
  const companyId = requireText(input.companyId, "Falta companyId");
  const deviceId = requireText(input.deviceId, "Falta deviceId");
  const saleId = saleIdOf(input);
  if (!saleId) throw new SaleVoidError("invalid_input", "La anulación necesita el id de la venta");

  const reference = referenceOf(input.sale);
  const at = firstText(input.voidedAt) ?? new Date().toISOString();
  const row = {} as SaleVoidRow;
  row.id = saleVoidId(saleId);
  row.company_id = companyId;
  row.sale_id = saleId;
  row.branch_id =
    firstText(
      input.branchId,
      reference?.branchId,
      reference?.branch_id,
      reference?.warehouseId,
      reference?.warehouse_id
    ) ?? null;
  row.reason = reasonOf(input.reason);
  row.voided_at = at;
  row.created_by = firstText(input.createdBy, reference?.created_by, reference?.user_id) ?? null;
  row.version = 1;
  row.updated_at = at;
  row.origin_device = deviceId;
  row.deleted_at = null;
  return row;
}

/**
 * Guarda reutilizable de la ruta caliente: devuelve `true` si la venta admite
 * escritura y `false` si ya está anulada. No lanza: quien llama decide si
 * devuelve un rechazo (cobro idempotente) o lo informa en su propio resultado.
 */
export async function assertSaleNotVoided(driver: LocalDbDriver, saleId: string): Promise<boolean> {
  const id = typeof saleId === "string" ? saleId.trim() : "";
  if (!driver || !id) return true;
  const direct = await driver.get<LocalRow>(SALE_VOID_TABLE, saleVoidId(id));
  if (direct && !direct.deleted_at) return false;
  const rows = await driver.query<LocalRow>({
    table: SALE_VOID_TABLE,
    where: [{ field: "sale_id", op: "eq", value: id }],
    limit: 1
  });
  return !isSaleVoided(rows, id);
}

/**
 * Anula una venta anexando un documento nuevo. Idempotente por
 * `void:<saleId>`: si ya hay anulación devuelve la existente; si la venta no
 * existe no escribe nada y lo informa con `created: false` y `skipped`.
 */
export async function recordSaleVoid(input: SaleVoidInput): Promise<RecordSaleVoidResult> {
  if (!input || !input.driver) {
    throw new SaleVoidError("invalid_input", "Falta el driver del almacén local");
  }
  const companyId = requireText(input.companyId, "Falta companyId");
  const deviceId = requireText(input.deviceId, "Falta deviceId");
  const saleId = saleIdOf(input);
  if (!saleId) throw new SaleVoidError("invalid_input", "La anulación necesita el id de la venta");

  const voidId = saleVoidId(saleId);
  const actionId = operationActionId(deviceId, SALE_VOID_TABLE, voidId, APPEND_SEQ);
  const fixedAt = firstText(input.voidedAt);

  const outcome = await input.driver.transaction(
    async (
      tx
    ): Promise<{ created: boolean; skipped: SaleVoidSkipReason | null; row: SaleVoidRow | null }> => {
      const existing = await findExistingVoid(tx, companyId, saleId, voidId);
      if (existing) {
        return { created: false, skipped: "already_voided", row: existing as SaleVoidRow };
      }

      const storedSale = await tx.get<LocalRow>("sales", saleId);
      if (!storedSale) return { created: false, skipped: "missing_sale", row: null };
      if (storedSale.company_id && storedSale.company_id !== companyId) {
        throw new SaleVoidError(
          "company_mismatch",
          `La venta ${saleId} no pertenece a la empresa ${companyId}`
        );
      }

      const row = buildSaleVoidRow({
        ...input,
        companyId,
        deviceId,
        saleId,
        voidedAt: fixedAt,
        branchId:
          firstText(input.branchId) ??
          firstText(storedSale.branch_id, storedSale.warehouse_id) ??
          null,
        createdBy:
          firstText(input.createdBy, storedSale.created_by, storedSale.user_id) ?? null
      } as SaleVoidInput);

      // Guarda real de solo anexado: el id determinista no puede existir ya.
      await assertAppendOnlyInsert(tx, SALE_VOID_TABLE, [row]);
      await tx.put(SALE_VOID_TABLE, [row]);
      return { created: true, skipped: null, row };
    }
  );

  return {
    voidId,
    saleId,
    actionId,
    created: outcome.created,
    skipped: outcome.skipped,
    row: outcome.row
  };
}
