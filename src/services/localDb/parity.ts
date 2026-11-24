/**
 * Paridad JSON legado ↔ almacén normalizado y rollback del corte.
 *
 * Antes de dar el corte por bueno se compara lo que el estado legado describe
 * con lo que el driver tiene realmente guardado: conteo por tabla y las sumas
 * que sostienen el negocio (ventas, existencias y caja). Es una comprobación de
 * solo lectura: nunca escribe en el almacén y nunca lanza por datos; un fallo
 * se devuelve como `ok: false` con el motivo para que el arranque decida.
 *
 * El rollback es una marca por empresa en localStorage: si la paridad no
 * cuadra, el arranque deja de hidratar desde el almacén y la aplicación sigue
 * trabajando con el JSON legado (modo sombra) sin reiniciar.
 */
import { getPalmyraScopedStorageKey } from "../localScope";
import type { LocalDbDriver, LocalRow, LocalTable } from "./contract";
import { importLegacyState, type ImportMeta } from "./importLegacy";

/** Dispositivo neutro para el plan esperado: la paridad no firma escrituras. */
const PARITY_ORIGIN_DEVICE = "local-db-parity";
/** Diferencia tolerada al comparar sumas (doble IEEE-754 en ambos lados). */
const SUM_EPSILON = 1e-6;

export interface ParityTableStatus {
  expected: number;
  actual: number;
}

export interface ParityTotals {
  expectedRows: number;
  actualRows: number;
  expectedSalesTotal: number;
  actualSalesTotal: number;
  expectedStockQuantity: number;
  actualStockQuantity: number;
  expectedCashAmount: number;
  actualCashAmount: number;
}

export interface ParityReport {
  ok: boolean;
  tables: Record<string, ParityTableStatus>;
  totals: ParityTotals;
  mismatches: string[];
}

export interface CompareLocalDbWithLegacyOptions {
  driver: LocalDbDriver;
  /** JSON legado tal cual (string) o ya parseado; ambas formas se aceptan. */
  state: unknown;
  companyId: string;
  originDevice: string;
  now?: string;
}

interface CashTotals {
  count: number;
  amount: number;
}

function emptyTotals(): ParityTotals {
  return {
    expectedRows: 0,
    actualRows: 0,
    expectedSalesTotal: 0,
    actualSalesTotal: 0,
    expectedStockQuantity: 0,
    actualStockQuantity: 0,
    expectedCashAmount: 0,
    actualCashAmount: 0
  };
}

function failed(reason: string): ParityReport {
  return { ok: false, tables: {}, totals: emptyTotals(), mismatches: [reason] };
}

/** El estado puede llegar como texto de zustand/persist o ya parseado. */
function parseState(state: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (typeof state !== "string") return { ok: true, value: state };
  const text = state.trim();
  if (!text) return { ok: false, reason: "el JSON legado está vacío" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "el JSON legado no es válido" };
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // El legado guarda importes como texto en algunos formularios.
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function sumColumn(rows: readonly LocalRow[] | undefined, fields: string[]): number {
  let total = 0;
  for (const row of rows ?? []) {
    const value = firstNumber(...fields.map((field) => row[field]));
    if (value !== null) total += value;
  }
  return total;
}

function sameSum(expected: number, actual: number): boolean {
  return Math.abs(expected - actual) <= SUM_EPSILON;
}

/** Movimientos embebidos en la fila del turno (forma del JSON legado). */
function movementsOf(row: LocalRow): Record<string, unknown>[] {
  const value = row.movements;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
  );
}

function summarizeEmbedded(rows: readonly LocalRow[] | undefined): CashTotals {
  let count = 0;
  let amount = 0;
  for (const row of rows ?? []) {
    for (const movement of movementsOf(row)) {
      count += 1;
      amount += toNumber(movement.amount) ?? 0;
    }
  }
  return { count, amount };
}

/**
 * Lo que el almacén representa en materia de caja. El importador conserva los
 * movimientos dentro de la fila del turno, así que se cuentan ambos formatos:
 * primero los normalizados en `cash_movements` y, para los turnos que aún no
 * los tienen en tabla, los embebidos en su fila. Nunca se suman dos veces.
 */
function actualCashTotals(
  sessionRows: readonly LocalRow[] | undefined,
  movementRows: readonly LocalRow[]
): CashTotals {
  const bySession = new Map<string, LocalRow[]>();
  for (const row of movementRows) {
    const sessionId = typeof row.session_id === "string" ? row.session_id : "";
    const bucket = bySession.get(sessionId) ?? [];
    bucket.push(row);
    bySession.set(sessionId, bucket);
  }

  let count = 0;
  let amount = 0;
  for (const bucket of bySession.values()) {
    for (const row of bucket) {
      count += 1;
      amount += toNumber(row.amount) ?? 0;
    }
  }
  for (const session of sessionRows ?? []) {
    if ((bySession.get(session.id)?.length ?? 0) > 0) continue;
    for (const movement of movementsOf(session)) {
      count += 1;
      amount += toNumber(movement.amount) ?? 0;
    }
  }
  return { count, amount };
}

/**
 * Lectura real por empresa. Se incluyen las empresas presentes en lo esperado
 * (el legado puede traer filas con companyId ajeno) y las filas borradas,
 * porque el estado de origen también las describe.
 */
async function readActualRows(
  driver: LocalDbDriver,
  table: LocalTable,
  expectedRows: readonly LocalRow[],
  companyId: string
): Promise<LocalRow[]> {
  const companies = Array.from(
    new Set(
      expectedRows
        .map((row) => row.company_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  ).sort();
  return driver.query<LocalRow>({
    table,
    where: [
      { field: "company_id", op: "in", value: companies.length > 0 ? companies : [companyId] }
    ],
    includeDeleted: true
  });
}

/**
 * Compara el plan que produce `importLegacyState` con el almacén real. Nunca
 * lanza: cualquier fallo de lectura o de datos se informa como `ok: false`.
 */
export async function compareLocalDbWithLegacy(
  options: CompareLocalDbWithLegacyOptions
): Promise<ParityReport> {
  try {
    const driver = options?.driver;
    const companyId = String(options?.companyId ?? "").trim();
    if (!driver) return failed("sin driver del almacén local");
    if (!companyId) return failed("sin empresa activa para comparar la paridad");

    const parsed = parseState(options.state);
    // Guarda explícita: sin `strictNullChecks` la negación no estrecha la unión.
    if (parsed.ok === false) return failed((parsed as { ok: false; reason: string }).reason);

    const meta: ImportMeta = {
      companyId,
      originDevice: String(options.originDevice ?? "").trim() || PARITY_ORIGIN_DEVICE,
      ...(options.now ? { now: options.now } : {})
    };
    const { batches } = importLegacyState(parsed.value, meta);

    // Solo las tablas que el estado de origen describe pueden exigirse: las que
    // escribe otra capa (hub, caja caliente) no forman parte de esta paridad.
    const expectedTables = (Object.keys(batches) as LocalTable[])
      .filter((table) => (batches[table]?.length ?? 0) > 0)
      .sort();

    const actualByTable = new Map<LocalTable, LocalRow[]>();
    await Promise.all(
      expectedTables.map(async (table) => {
        actualByTable.set(
          table,
          await readActualRows(driver, table, batches[table] ?? [], companyId)
        );
      })
    );

    const tables: Record<string, ParityTableStatus> = {};
    const mismatches: string[] = [];

    for (const table of expectedTables) {
      const expectedRows = batches[table] ?? [];
      const actualRows = actualByTable.get(table) ?? [];
      tables[table] = { expected: expectedRows.length, actual: actualRows.length };
      if (expectedRows.length !== actualRows.length) {
        mismatches.push(
          `tabla ${table}: esperado ${expectedRows.length}, real ${actualRows.length}`
        );
      }
    }

    const expectedSalesTotal = sumColumn(batches.sales, ["total", "total_amount"]);
    const actualSalesTotal = sumColumn(actualByTable.get("sales"), ["total", "total_amount"]);
    if (!sameSum(expectedSalesTotal, actualSalesTotal)) {
      mismatches.push(`ventas.total: esperado ${expectedSalesTotal}, real ${actualSalesTotal}`);
    }

    const expectedStockQuantity = sumColumn(batches.stock_balances, ["quantity"]);
    const actualStockQuantity = sumColumn(actualByTable.get("stock_balances"), ["quantity"]);
    if (!sameSum(expectedStockQuantity, actualStockQuantity)) {
      mismatches.push(
        `inventario.quantity: esperado ${expectedStockQuantity}, real ${actualStockQuantity}`
      );
    }

    const expectedCash = summarizeEmbedded(batches.cash_sessions);
    const movementRows = await driver.query<LocalRow>({
      table: "cash_movements",
      where: [{ field: "company_id", op: "eq", value: companyId }],
      includeDeleted: true
    });
    const actualCash = actualCashTotals(actualByTable.get("cash_sessions"), movementRows);

    if (expectedCash.count > 0 || actualCash.count > 0) {
      tables.cash_movements = { expected: expectedCash.count, actual: actualCash.count };
      if (expectedCash.count !== actualCash.count) {
        mismatches.push(
          `tabla cash_movements: esperado ${expectedCash.count}, real ${actualCash.count}`
        );
      }
    }
    if (!sameSum(expectedCash.amount, actualCash.amount)) {
      mismatches.push(`caja.amount: esperado ${expectedCash.amount}, real ${actualCash.amount}`);
    }

    const totals: ParityTotals = {
      expectedRows: Object.values(tables).reduce((sum, entry) => sum + entry.expected, 0),
      actualRows: Object.values(tables).reduce((sum, entry) => sum + entry.actual, 0),
      expectedSalesTotal,
      actualSalesTotal,
      expectedStockQuantity,
      actualStockQuantity,
      expectedCashAmount: expectedCash.amount,
      actualCashAmount: actualCash.amount
    };

    return { ok: mismatches.length === 0, tables, totals, mismatches };
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : "error inesperado al comparar el almacén local"
    );
  }
}

// ---------------------------------------------------------------------------
// rollback del corte
// ---------------------------------------------------------------------------

export const LOCAL_DB_ROLLBACK_KEY = "palmyra_local_db_rollback_v1";
export const LOCAL_DB_ROLLBACK_EVENT = "palmyra:localdb-rollback";

export interface LocalDbRollbackRecord {
  reason: string;
  at: string;
}

/** Subconjunto de Storage que basta para la marca de rollback. */
export type RollbackStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface RollbackOptions {
  /** localStorage inyectable; `null` simula un dispositivo sin almacenamiento. */
  storage?: RollbackStorage | null;
  now?: string;
}

function resolveStorage(storage?: RollbackStorage | null): RollbackStorage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Clave con prefijo de alcance; sin sesión se usa la clave base para no perder el aviso. */
export function localDbRollbackStorageKey(): string {
  try {
    return getPalmyraScopedStorageKey(LOCAL_DB_ROLLBACK_KEY) ?? LOCAL_DB_ROLLBACK_KEY;
  } catch {
    return LOCAL_DB_ROLLBACK_KEY;
  }
}

function emitRollback(record: LocalDbRollbackRecord): void {
  try {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(LOCAL_DB_ROLLBACK_EVENT, { detail: record }));
  } catch {
    // El evento es diagnóstico: en entornos sin DOM el rollback sigue siendo válido.
  }
}

/**
 * Pide volver a modo sombra. La marca queda en localStorage para sobrevivir al
 * reinicio; el evento avisa a la interfaz sin que nadie tenga que consultarla.
 */
export function requestLocalDbRollback(
  reason: string,
  options: RollbackOptions = {}
): LocalDbRollbackRecord {
  const record: LocalDbRollbackRecord = {
    reason: String(reason ?? "").trim() || "rollback solicitado",
    at: options.now ?? new Date().toISOString()
  };
  const storage = resolveStorage(options.storage);
  if (storage) {
    try {
      storage.setItem(localDbRollbackStorageKey(), JSON.stringify(record));
    } catch {
      // Sin cuota el aviso en memoria y el evento siguen siendo válidos.
    }
  }
  emitRollback(record);
  return record;
}

export function isLocalDbRollbackRequested(options: RollbackOptions = {}): boolean {
  const storage = resolveStorage(options.storage);
  if (!storage) return false;
  try {
    const raw = storage.getItem(localDbRollbackStorageKey());
    return typeof raw === "string" && raw.length > 0;
  } catch {
    return false;
  }
}

export function clearLocalDbRollback(options: RollbackOptions = {}): void {
  const storage = resolveStorage(options.storage);
  if (!storage) return;
  try {
    storage.removeItem(localDbRollbackStorageKey());
  } catch {
    // Un borrado fallido deja la marca: el arranque seguirá en sombra.
  }
}
