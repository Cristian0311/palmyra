/**
 * Escritura directa del POS en el almacén local normalizado.
 *
 * La sombra legada refleja el JSON de Zustand cada pocos segundos. Para que la
 * venta, la anulación y el movimiento de caja existan de inmediato (hub LAN,
 * respaldo, sync por cursores) sin esperar esa pasada, el POS escribe las
 * mismas filas de negocio en el momento.
 *
 * Reglas:
 * - Se reutiliza `importLegacyState` con un estado legado parcial: así las filas
 *   son idénticas a las que produce la sombra y esta última las reconoce como
 *   sin cambios (ignora `version`, `updated_at` y `origin_device`).
 * - Todo es idempotente por id: si la fila ya existe no se reescribe nada.
 * - Ninguna función lanza. Un fallo se informa con `{ written: false }` y con
 *   el evento `palmyra:localdb-writethrough`; el cobro nunca se bloquea.
 * - El stock (`stock_balances`/`stock_movements`) no se toca aquí: la sombra
 *   mantiene los saldos y el libro de inventario.
 */
import type { Transaction } from "../../types";
import { assertLocalRow, type LocalDbDriver, type LocalRow, type LocalTable } from "./contract";
import { importLegacyState } from "./importLegacy";
import { getRuntimeDriver } from "./runtimeDriver";
import { getDeviceId } from "../lanPresence";
import { getPalmyraLocalScope } from "../localScope";
import { SALE_VOID_REASONS, recordSaleVoid } from "./saleLifecycle";

/** Evento de diagnóstico; el detalle describe la escritura, nunca lanza. */
export const POS_WRITE_EVENT = "palmyra:localdb-writethrough";

/** Bandera de corte: el valor exacto "0" desactiva la escritura directa. */
const FLAG = "VITE_LOCAL_DB_POS_WRITE";

/** Estados de venta cerrada que admiten espejo inmediato. */
const CLOSED_SALE_STATUSES = new Set<string>(["completed", "partial_refund", "refunded"]);

/** Orden de escritura: padre y luego hijas. */
const SALE_TABLES: LocalTable[] = ["sales", "sale_items", "sale_payments"];

/** Motivos válidos importados del ciclo de vida de la venta. */
const VOID_REASONS = new Set<string>(Object.values(SALE_VOID_REASONS));

export type PosWriteOp = "sale" | "sale_void" | "cash_movement";

export interface PosWriteThroughOptions {
  driver?: LocalDbDriver;
  companyId?: string;
  deviceId?: string;
  /** Instante fijo (importación diferida y pruebas); por defecto el reloj. */
  now?: string;
  /** Fuerza el corte sin mirar la bandera: false desactiva, true activa. */
  enabled?: boolean;
}

export interface SaleVoidMirrorOptions extends PosWriteThroughOptions {
  /** Código de `SALE_VOID_REASONS`; un valor libre se descarta. */
  reason?: string;
}

export interface PosWriteThroughDetail {
  ok: boolean;
  op: PosWriteOp;
  id: string;
  error?: string;
}

interface EnvRecord {
  [key: string]: string | undefined;
}

function readFlag(): string | undefined {
  try {
    const env = (import.meta as ImportMeta & { env?: EnvRecord }).env;
    if (env && env[FLAG] !== undefined) return env[FLAG];
  } catch {
    // Bajo Node (pruebas) import.meta.env no existe: se trata como vacío.
  }
  try {
    if (typeof process !== "undefined" && process.env) return process.env[FLAG];
  } catch {
    // Navegador sin `process`: solo manda import.meta.env.
  }
  return undefined;
}

/** true salvo que la bandera valga exactamente "0" o `enabled` sea false. */
export function isPosWriteEnabled(options: PosWriteThroughOptions = {}): boolean {
  if (typeof options.enabled === "boolean") return options.enabled;
  return String(readFlag() ?? "").trim() !== "0";
}

function detail(fields: {
  ok: boolean;
  op: PosWriteOp;
  id: string;
  error?: unknown;
}): PosWriteThroughDetail {
  const result: PosWriteThroughDetail = { ok: fields.ok, op: fields.op, id: fields.id };
  if (fields.error !== undefined) {
    result.error = fields.error instanceof Error ? fields.error.message : String(fields.error);
  }
  return result;
}

/** Emite el evento solo cuando existe `window`; un fallo del emisor no propaga. */
function emit(result: PosWriteThroughDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(POS_WRITE_EVENT, { detail: result }));
  } catch {
    // El evento es solo diagnóstico: nunca condiciona la escritura.
  }
}

function resolveCompanyId(options: PosWriteThroughOptions): string {
  try {
    return String(options.companyId ?? getPalmyraLocalScope()?.companyId ?? "").trim();
  } catch {
    return "";
  }
}

function resolveDeviceId(options: PosWriteThroughOptions): string {
  if (options.deviceId) return String(options.deviceId).trim();
  try {
    return String(getDeviceId() ?? "").trim();
  } catch {
    return "";
  }
}

async function resolveDriver(options: PosWriteThroughOptions): Promise<LocalDbDriver | null> {
  if (options.driver) return options.driver;
  return getRuntimeDriver();
}

function isClosedSale(transaction: Transaction | null | undefined): boolean {
  if (!transaction || typeof transaction.id !== "string" || !transaction.id.trim()) return false;
  if (transaction.deletedAt) return false;
  return CLOSED_SALE_STATUSES.has(String(transaction.status ?? ""));
}

function pickVoidReason(transaction: Transaction, requested?: string): string {
  const code = typeof requested === "string" ? requested.trim() : "";
  if (code && VOID_REASONS.has(code)) return code;
  // Una baja hecha desde el POS lleva autor/fecha; el resto se trata como la
  // venta que desapareció del JSON legado.
  return transaction.deletedAt || transaction.deletedBy
    ? SALE_VOID_REASONS.user_void
    : SALE_VOID_REASONS.legacy_removed;
}

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Fila del movimiento de caja con el mismo id que usa la ruta caliente
 * (`${sessionId}:mov:${movementId}`). El importador legado no genera hijos para
 * `cashSessions`, así que aquí se aplana el movimiento en su propia fila.
 */
function buildCashMovementRow(
  sessionId: string,
  movement: Record<string, unknown>,
  companyId: string,
  deviceId: string,
  at: string
): LocalRow {
  const row = {} as LocalRow;
  for (const [key, value] of Object.entries(movement)) {
    if (key === "id" || key === "sessionId" || key === "session_id") continue;
    if (value === undefined || typeof value === "function") continue;
    row[toSnakeCase(key)] = value;
  }
  row.id = `${sessionId}:mov:${String(movement.id)}`;
  row.company_id = companyId;
  row.version = 1;
  row.updated_at = firstText(movement.date) ?? at;
  row.origin_device = deviceId;
  row.deleted_at = null;
  row.session_id = sessionId;
  if (row.warehouse_id === undefined) {
    row.warehouse_id = firstText(movement.warehouseId, movement.branchId);
  }
  if (row.date === undefined) row.date = at;
  row.created_at = at;
  return row;
}

/**
 * Espeja una venta cerrada en `sales`, `sale_items` y `sale_payments`.
 * Si la fila de venta ya existe no escribe nada (idempotente por id).
 */
export async function mirrorCompletedSale(
  transaction: Transaction,
  options: PosWriteThroughOptions = {}
): Promise<{ written: boolean }> {
  const op: PosWriteOp = "sale";
  const id = String(transaction?.id ?? "");
  try {
    if (!isPosWriteEnabled(options) || !isClosedSale(transaction)) {
      emit(detail({ ok: true, op, id }));
      return { written: false };
    }
    const driver = await resolveDriver(options);
    const companyId = resolveCompanyId(options);
    if (!driver || !companyId) {
      emit(detail({ ok: true, op, id }));
      return { written: false };
    }
    const deviceId = resolveDeviceId(options);

    // Un estado legado parcial produce exactamente las filas de la sombra.
    const { batches } = importLegacyState(
      { transactions: [{ ...transaction }] },
      { companyId, originDevice: deviceId, now: options.now }
    );
    const saleRow = batches.sales?.[0];
    if (!saleRow) {
      emit(detail({ ok: true, op, id }));
      return { written: false };
    }

    const written = await driver.transaction(async (tx) => {
      const existing = await tx.get<LocalRow>("sales", saleRow.id);
      if (existing) return false;
      for (const table of SALE_TABLES) {
        const rows = batches[table];
        if (!rows || rows.length === 0) continue;
        for (const row of rows) assertLocalRow(table, row);
        await tx.put(table, rows);
      }
      return true;
    });

    emit(detail({ ok: true, op, id }));
    return { written };
  } catch (error) {
    emit(detail({ ok: false, op, id, error }));
    return { written: false };
  }
}

/**
 * Anula una venta anexando `sale_voids` con el mismo contrato que la sombra.
 * Idempotente: si la anulación ya existe no escribe; si la venta todavía no
 * está en el almacén, `recordSaleVoid` lo informa sin lanzar.
 */
export async function mirrorSaleVoid(
  transaction: Transaction,
  options: SaleVoidMirrorOptions = {}
): Promise<{ written: boolean }> {
  const op: PosWriteOp = "sale_void";
  const id = String(transaction?.id ?? "");
  try {
    if (!isPosWriteEnabled(options) || !id.trim()) {
      emit(detail({ ok: true, op, id }));
      return { written: false };
    }
    const driver = await resolveDriver(options);
    const companyId = resolveCompanyId(options);
    if (!driver || !companyId) {
      emit(detail({ ok: true, op, id }));
      return { written: false };
    }
    const deviceId = resolveDeviceId(options);

    const result = await recordSaleVoid({
      driver,
      companyId,
      deviceId,
      saleId: id,
      branchId: transaction.warehouseId ?? transaction.branchId ?? null,
      reason: pickVoidReason(transaction, options.reason),
      createdBy: transaction.deletedBy ?? transaction.userId ?? deviceId,
      voidedAt: options.now
    });

    emit(detail({ ok: true, op, id }));
    return { written: result.created };
  } catch (error) {
    emit(detail({ ok: false, op, id, error }));
    return { written: false };
  }
}

/**
 * Espeja un movimiento de caja recién anotado: abre la fila del turno si aún
 * no existe y anexa el movimiento en `cash_movements`. No borra nada; una baja
 * de movimiento queda para la reconciliación de la sombra.
 */
export async function mirrorCashMovement<S extends { id: string }, M extends { id: string }>(
  session: S,
  movement: M,
  options: PosWriteThroughOptions = {}
): Promise<{ written: boolean }> {
  const op: PosWriteOp = "cash_movement";
  const id = String(movement?.id ?? "");
  try {
    if (!isPosWriteEnabled(options) || !id.trim() || !session?.id) {
      emit(detail({ ok: true, op, id }));
      return { written: false };
    }
    const driver = await resolveDriver(options);
    const companyId = resolveCompanyId(options);
    if (!driver || !companyId) {
      emit(detail({ ok: true, op, id }));
      return { written: false };
    }
    const deviceId = resolveDeviceId(options);
    const at = options.now ?? new Date().toISOString();
    const sessionId = String(session.id);

    const { batches } = importLegacyState(
      { cashSessions: [{ ...(session as Record<string, unknown>), movements: [{ ...(movement as Record<string, unknown>) }] }] },
      { companyId, originDevice: deviceId, now: at }
    );
    const sessionRow = batches.cash_sessions?.[0];
    const movementRow = buildCashMovementRow(
      sessionId,
      movement as unknown as Record<string, unknown>,
      companyId,
      deviceId,
      at
    );

    const written = await driver.transaction(async (tx) => {
      let wrote = false;
      if (sessionRow) {
        const existingSession = await tx.get<LocalRow>("cash_sessions", sessionRow.id);
        if (!existingSession) {
          assertLocalRow("cash_sessions", sessionRow);
          await tx.put("cash_sessions", [sessionRow]);
          wrote = true;
        }
      }
      const existingMovement = await tx.get<LocalRow>("cash_movements", movementRow.id);
      if (!existingMovement) {
        assertLocalRow("cash_movements", movementRow);
        await tx.put("cash_movements", [movementRow]);
        wrote = true;
      }
      return wrote;
    });

    emit(detail({ ok: true, op, id }));
    return { written };
  } catch (error) {
    emit(detail({ ok: false, op, id, error }));
    return { written: false };
  }
}
