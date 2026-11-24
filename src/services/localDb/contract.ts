/**
 * Contrato del almacén local normalizado de PALMYRA.
 *
 * Los drivers (IndexedDB, SQLite, HTTP del hub LAN) implementan esta misma
 * interfaz. Los repositorios y el sincronizador solo conocen este contrato, de
 * modo que cambiar de motor no cambia la lógica de negocio.
 */

export type LocalTable =
  | "companies"
  | "company_settings"
  | "warehouses"
  | "products"
  | "product_variants"
  | "product_codes"
  | "product_prices"
  | "stock_movements"
  | "stock_balances"
  | "sales"
  /** Libro de anulaciones de venta (solo inserción). */
  | "sale_voids"
  | "sale_items"
  | "sale_payments"
  | "cash_sessions"
  | "cash_movements"
  | "customers"
  | "suppliers"
  | "purchases"
  | "purchase_items"
  | "transfers"
  | "transfer_items"
  | "returns"
  | "return_items"
  | "quotes"
  | "quote_items"
  | "banks"
  | "bank_movements"
  | "inventory_audits"
  | "inventory_audit_items"
  | "ncf_sequences"
  | "outbox"
  /** Equipos emparejados con el hub LAN (token solo como hash). */
  | "hub_devices"
  /** Recibos de operaciones idempotentes recibidas por el hub. */
  | "hub_receipts";

/** Columnas presentes en toda fila sincronizable. */
export interface LocalRow {
  id: string;
  company_id: string;
  /** Incrementa en cada escritura; sirve para last-writer-wins controlado. */
  version: number;
  updated_at: string;
  origin_device: string;
  deleted_at: string | null;
  [field: string]: unknown;
}

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";

export interface QueryFilter {
  field: string;
  op: FilterOp;
  value: unknown;
}

export interface QuerySpec {
  table: LocalTable;
  where?: QueryFilter[];
  orderBy?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  offset?: number;
  /** Por defecto las filas con deleted_at se excluyen. */
  includeDeleted?: boolean;
}

export type ChangeOp = "upsert" | "delete";

export interface ChangeRecord {
  seq: number;
  table: LocalTable;
  row_id: string;
  op: ChangeOp;
  company_id: string;
  updated_at: string;
  origin_device: string;
  recorded_at: string;
}

export interface MutationMeta {
  company_id: string;
  origin_device: string;
  /** Permite fijar el instante en pruebas; por defecto se usa el reloj. */
  at?: string;
}

export interface LocalDbTransaction {
  get<T extends LocalRow>(table: LocalTable, id: string): Promise<T | null>;
  query<T extends LocalRow>(spec: QuerySpec): Promise<T[]>;
  put<T extends LocalRow>(table: LocalTable, rows: T[]): Promise<number>;
  remove(table: LocalTable, ids: string[], meta: MutationMeta): Promise<void>;
}

export interface LocalDbDriver {
  readonly kind: "indexeddb" | "sqlite" | "http" | "memory";
  ready(): Promise<void>;
  get<T extends LocalRow>(table: LocalTable, id: string): Promise<T | null>;
  query<T extends LocalRow>(spec: QuerySpec): Promise<T[]>;
  /** Devuelve cuántas filas se escribieron y registra un cambio por fila. */
  put<T extends LocalRow>(table: LocalTable, rows: T[]): Promise<number>;
  remove(table: LocalTable, ids: string[], meta: MutationMeta): Promise<void>;
  transaction<T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T>;
  changes(sinceSeq?: number, limit?: number): Promise<ChangeRecord[]>;
  latestSeq(): Promise<number>;
  close(): Promise<void>;
}

export class LocalDbError extends Error {
  readonly code: "not_ready" | "invalid_row" | "transaction_failed" | "driver_unavailable";

  constructor(code: LocalDbError["code"], message: string) {
    super(message);
    this.name = "LocalDbError";
    this.code = code;
  }
}

export function assertLocalRow(table: LocalTable, row: unknown): asserts row is LocalRow {
  if (!row || typeof row !== "object") {
    throw new LocalDbError("invalid_row", `Fila inválida para ${table}`);
  }
  const candidate = row as Partial<LocalRow>;
  if (!candidate.id || typeof candidate.id !== "string") {
    throw new LocalDbError("invalid_row", `Fila de ${table} sin id`);
  }
  if (!candidate.company_id || typeof candidate.company_id !== "string") {
    throw new LocalDbError("invalid_row", `Fila ${candidate.id} de ${table} sin company_id`);
  }
  if (typeof candidate.version !== "number" || !Number.isFinite(candidate.version)) {
    throw new LocalDbError("invalid_row", `Fila ${candidate.id} de ${table} sin version`);
  }
  if (!candidate.updated_at || typeof candidate.updated_at !== "string") {
    throw new LocalDbError("invalid_row", `Fila ${candidate.id} de ${table} sin updated_at`);
  }
}

export function matchesFilters(row: LocalRow, filters: QueryFilter[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  for (const filter of filters) {
    const value = row[filter.field];
    switch (filter.op) {
      case "eq":
        if (value !== filter.value) return false;
        break;
      case "neq":
        if (value === filter.value) return false;
        break;
      case "in":
        if (!Array.isArray(filter.value) || !filter.value.includes(value)) return false;
        break;
      case "gt":
        if (!(typeof value === "number" && typeof filter.value === "number" && value > filter.value)) return false;
        break;
      case "gte":
        if (!(typeof value === "number" && typeof filter.value === "number" && value >= filter.value)) return false;
        break;
      case "lt":
        if (!(typeof value === "number" && typeof filter.value === "number" && value < filter.value)) return false;
        break;
      case "lte":
        if (!(typeof value === "number" && typeof filter.value === "number" && value <= filter.value)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Orden estable en memoria usando el mismo criterio en todos los drivers. */
export function compareRows(
  a: LocalRow,
  b: LocalRow,
  orderBy: NonNullable<QuerySpec["orderBy"]>
): number {
  const left = a[orderBy.field];
  const right = b[orderBy.field];
  let result = 0;
  if (typeof left === "number" && typeof right === "number") result = left - right;
  else result = String(left ?? "").localeCompare(String(right ?? ""));
  if (result === 0) result = a.id.localeCompare(b.id);
  return orderBy.direction === "desc" ? -result : result;
}

export function applyQuerySpec<T extends LocalRow>(rows: T[], spec: QuerySpec): T[] {
  let result = spec.includeDeleted ? rows.slice() : rows.filter((row) => !row.deleted_at);
  if (spec.where?.length) result = result.filter((row) => matchesFilters(row, spec.where));
  if (spec.orderBy) result.sort((a, b) => compareRows(a, b, spec.orderBy!));
  const offset = Math.max(0, spec.offset ?? 0);
  if (offset) result = result.slice(offset);
  if (typeof spec.limit === "number") result = result.slice(0, Math.max(0, spec.limit));
  return result;
}

export function nowIso(at?: string): string {
  return at ?? new Date().toISOString();
}
