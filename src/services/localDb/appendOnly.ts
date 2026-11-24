/**
 * Reglas de solo anexado para las rutas calientes (venta y caja).
 *
 * Los libros de venta, sus líneas y pagos, las anulaciones de venta, los
 * movimientos de caja y el libro de inventario nunca se corrigen en el sitio:
 * un error se compensa con una fila nueva. Este módulo centraliza la lista de
 * tablas afectadas, resuelve el nombre físico del libro de inventario (el
 * esquema local lo llama `stock_movements` aunque el negocio lo conozca como
 * `inventory_movements`) y expone guardas que cualquier escritor debe atravesar
 * antes de tocar filas.
 *
 * Importante: el contrato del almacén solo tiene dos operaciones de escritura
 * (`upsert` y `delete`). Para una tabla de solo anexado, `upsert` es la
 * inserción permitida; la actualización real se detecta con
 * `assertAppendOnlyInsert`, que rechaza reescribir un id que ya existe.
 */
import type { LocalDbTransaction, LocalRow, LocalTable } from "./contract";
import { LOCAL_DB_TABLES } from "./schema";

/**
 * Nombres lógicos de las tablas de solo anexado. Se usan los nombres de
 * negocio (`inventory_movements`) y `resolvePhysicalTable` los traduce al
 * nombre que tenga el esquema local.
 */
export type AppendOnlyTableName =
  | "sales"
  | "sale_items"
  | "sale_payments"
  | "sale_voids"
  | "cash_movements"
  | "inventory_movements";

export const APPEND_ONLY_TABLES: readonly AppendOnlyTableName[] = [
  "sales",
  "sale_items",
  "sale_payments",
  "sale_voids",
  "cash_movements",
  "inventory_movements"
];

/** Operaciones que un guarda entiende; `upsert` es la inserción del contrato. */
export type AppendOnlyOperation = "insert" | "upsert" | "update" | "delete";

const APPEND_ONLY_SET = new Set<string>(APPEND_ONLY_TABLES);

/** Segunda pasada de `stock_balances` no entra aquí: es un saldo, no un libro. */
export const INVENTORY_LEDGER_ALIAS = "stock_movements";

function hasPhysicalTable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_DB_TABLES as Record<string, unknown>, name);
}

/**
 * Tabla física del libro de inventario. Si un esquema futuro añade
 * `inventory_movements` se usa tal cual; mientras tanto se usa el nombre v1
 * (`stock_movements`) para que el driver SQLite y el hub la reconozcan.
 */
export const INVENTORY_LEDGER_TABLE: LocalTable = hasPhysicalTable("inventory_movements")
  ? ("inventory_movements" as LocalTable)
  : INVENTORY_LEDGER_ALIAS;

/** Traduce un nombre lógico de tabla al nombre que conoce el almacén. */
export function resolvePhysicalTable(table: LocalTable | AppendOnlyTableName | string): LocalTable {
  if (table === "inventory_movements") return INVENTORY_LEDGER_TABLE;
  return table as LocalTable;
}

/** true si la tabla (lógica o física) es de solo anexado. */
export function isAppendOnly(table: LocalTable | AppendOnlyTableName | string): boolean {
  if (APPEND_ONLY_SET.has(table)) return true;
  // El esquema v1 llama stock_movements al libro de inventario.
  return table === INVENTORY_LEDGER_ALIAS;
}

/** Error estable: el consumidor distingue este caso por el código. */
export class AppendOnlyError extends Error {
  readonly code: "append_only" = "append_only";
  readonly table: string;
  readonly operation: string;

  constructor(table: string, operation: string, message?: string) {
    super(message ?? `La tabla ${table} es de solo anexado: no admite ${operation}`);
    this.name = "AppendOnlyError";
    this.table = table;
    this.operation = operation;
  }
}

const BLOCKED: Partial<Record<AppendOnlyOperation, string>> = {
  update: "actualizaciones",
  delete: "borrados"
};

/**
 * Guarda previa: lanza `AppendOnlyError` (código `append_only`) cuando se
 * intenta actualizar o borrar en una tabla de solo anexado. Las inserciones
 * (`insert`/`upsert`) se permiten aquí; que no reescriban una fila existente lo
 * comprueba `assertAppendOnlyInsert` dentro de la transacción.
 */
export function assertAppendOnly(
  table: LocalTable | AppendOnlyTableName | string,
  op: AppendOnlyOperation
): void {
  const blocked = BLOCKED[op];
  if (!blocked) return;
  if (!isAppendOnly(table)) return;
  throw new AppendOnlyError(table, op, `La tabla ${table} es de solo anexado: no admite ${blocked}`);
}

/** Envuelve una escritura para que pase obligatoriamente por la guarda. */
export async function guardOperation<T>(
  table: LocalTable | AppendOnlyTableName | string,
  op: AppendOnlyOperation,
  run: () => Promise<T>
): Promise<T> {
  assertAppendOnly(table, op);
  return run();
}

/**
 * Verificación real de solo anexado dentro de una transacción: ninguna fila
 * puede reutilizar un id ya almacenado. Es la diferencia entre anexar y
 * reescribir, que la guarda por operación no puede ver por sí sola.
 */
export async function assertAppendOnlyInsert(
  tx: LocalDbTransaction,
  table: LocalTable | AppendOnlyTableName | string,
  rows: LocalRow[]
): Promise<void> {
  const physical = resolvePhysicalTable(table);
  if (rows.length === 0 || !isAppendOnly(physical)) return;
  await guardOperation(physical, "insert", async () => {
    for (const row of rows) {
      const existing = await tx.get<LocalRow>(physical, row.id);
      if (existing) {
        throw new AppendOnlyError(
          physical,
          "insert",
          `La fila ${row.id} de ${physical} ya existe: el libro es de solo anexado`
        );
      }
    }
    return true;
  });
}
