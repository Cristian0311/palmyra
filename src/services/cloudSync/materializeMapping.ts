/**
 * Contrato de materialización de la bandeja `local_change_inbox`.
 *
 * La nube recibe los cambios del journal local tal como los escribe el
 * dispositivo (columnas snake_case derivadas del estado legado). Este módulo
 * declara, tabla por tabla, a qué tabla de negocio corresponde cada fila local,
 * con qué columnas explícitas se publica y cómo se representa un tombstone.
 *
 * Reglas:
 *  - Solo se materializan tablas enumeradas aquí; el resto se descarta con
 *    motivo (la bandeja lo marca como `skipped`).
 *  - No hay SQL dinámico ni adivinación de columnas: cada columna cloud se
 *    escribe desde una lista cerrada de alias locales.
 *  - Las tablas hijas declaran su clave padre; una línea sin padre no se
 *    materializa (el SQL la reporta como error de fila, no aborta el lote).
 *  - `stock_balances` y `product_prices` quedan fuera a propósito: su clave
 *    natural no es `id` y su escritura pasa por RPC de inventario/precios.
 *  - El SQL de la migración replica este mapa; si se agrega una tabla hay que
 *    tocar ambos lados (la prueba de contrato lo verifica).
 */
import type { LocalRow, LocalTable } from "../localDb/contract";
import { LOCAL_DB_TABLES } from "../localDb/schema";

export type ColumnKind = "text" | "number" | "boolean" | "uuid" | "timestamp" | "json";

/**
 * Cómo se aplica un `op = 'delete'`:
 *  - `soft`: `deleted_at = now()` (la tabla tiene esa columna).
 *  - `deactivate`: no se borra historial; se marca `active = false` o
 *    `status = 'archived'/'cancelled'` según `tombstoneColumn/Value`.
 *  - `purge`: borrado real (líneas y ledger sin soft delete).
 */
export type TombstoneMode = "soft" | "deactivate" | "purge";

export interface ColumnMapping {
  /** Nombre exacto de la columna en la tabla cloud. */
  readonly column: string;
  /** Alias locales en orden de prioridad (el primero es el canónico). */
  readonly from: readonly string[];
  readonly kind: ColumnKind;
  /** Sin valor la fila no se materializa. */
  readonly required?: boolean;
}

export interface ParentReference {
  /** Columna cloud que apunta al padre. */
  readonly column: string;
  /** Tabla local del padre (sirve para derivar su id si no es UUID). */
  readonly localTable: LocalTable;
  /** Clave local de la fila hija que contiene el id del padre. */
  readonly localKey: string;
}

export interface TableMapping {
  /** Tabla destino en Supabase. */
  readonly table: string;
  readonly columns: readonly ColumnMapping[];
  readonly tombstone: TombstoneMode;
  /** Columna de desactivación lógica cuando `tombstone = 'deactivate'`. */
  readonly tombstoneColumn?: string;
  readonly tombstoneValue?: string;
  /** Presente solo en tablas hijas. */
  readonly parent?: ParentReference;
}

const c = (
  column: string,
  from: readonly string[] | string,
  kind: ColumnKind = "text",
  required = false
): ColumnMapping => ({
  column,
  from: typeof from === "string" ? [from] : from,
  kind,
  ...(required ? { required: true } : {})
});

const ID = (required = true) => c("id", "id", "uuid", required);
const COMPANY = () => c("company_id", "company_id", "uuid", true);
const CREATED_AT = () => c("created_at", ["created_at", "date"], "timestamp");
const UPDATED_AT = () => c("updated_at", "updated_at", "timestamp");

/**
 * Tablas locales que no se materializan en tablas de negocio.
 * El valor explica el motivo y viaja al `error` de la bandeja al omitirlas.
 */
export const UNSUPPORTED_LOCAL_TABLES: Readonly<Record<string, string>> = {
  companies:
    "company_master_managed_by_onboarding: la fila de empresa la administra el alta SaaS, no el journal",
  company_settings:
    "settings_json_merge_required: company_settings se identifica por company_id y se fusiona por JSON; un upsert por id pisaría ajustes del servidor",
  product_codes:
    "natural_key_table: product_barcodes se identifica por (company_id, barcode), no por id",
  product_prices:
    "natural_key_table: product_prices se identifica por (product_id, currency_code, valid_from); se escribe con set_product_price",
  stock_balances:
    "aggregate_keyed_by_warehouse_product_variant: se reconcilia con adjust_inventory, nunca por id",
  ncf_sequences:
    "fiscal_sequences_are_server_managed: company_fiscal_sequences reserva rangos con RPC; copiar contadores locales duplicaría NCF",
  outbox: "device_local_queue: cola del dispositivo, no es dato de negocio",
  hub_devices: "device_local_pairing: emparejamiento del hub LAN, no es dato de negocio",
  hub_receipts: "device_local_idempotency: recibos del hub LAN, no son datos de negocio"
};

/**
 * Tablas que existen SOLO en el almacén local: no tienen tabla homónima en la
 * nube y nunca deben materializarse. Se separan de `UNSUPPORTED_LOCAL_TABLES`
 * porque allí el destino cloud existe y se descarta por estrategia (clave
 * natural, agregado o JSON); aquí el destino simplemente no existe.
 *
 * `sale_voids` es el libro local de anulaciones de venta (append-only). La nube
 * no tiene `public.sale_voids` (no hay DDL, ni pull, ni RLS): una anulación se
 * materializa como `sales.status = 'voided'` (+ `deleted_at` si existe) y su
 * reposición de stock en `stock_movements`. Enviarla al journal y omitirla aquí
 * deja la fila `skipped` con este motivo, sin romper el lote.
 */
export const LOCAL_ONLY_TABLES: Readonly<Record<string, string>> = {
  sale_voids:
    "local_only_table: no existe public.sale_voids en la nube; la anulación se refleja en sales.status='voided' y stock_movements"
};

/** Mapa explícito tabla local → tabla cloud. */
export const MATERIALIZE_MAP: Readonly<Partial<Record<LocalTable, TableMapping>>> = {
  warehouses: {
    table: "warehouses",
    tombstone: "deactivate",
    tombstoneColumn: "active",
    tombstoneValue: "false",
    columns: [
      ID(),
      COMPANY(),
      c("code", "code"),
      c("name", "name", "text", true),
      c("active", ["active", "is_active"], "boolean"),
      CREATED_AT()
    ]
  },
  products: {
    table: "products",
    tombstone: "deactivate",
    tombstoneColumn: "status",
    tombstoneValue: "archived",
    columns: [
      ID(),
      COMPANY(),
      c("sku", "sku"),
      c("name", "name", "text", true),
      c("description", "description"),
      c("category_id", "category_id", "uuid"),
      c("brand_id", "brand_id", "uuid"),
      c("base_unit", ["base_unit", "unit"]),
      c("cost", ["cost", "cost_price"], "number"),
      c("commission_fixed", ["commission_fixed"], "number"),
      c("commission_percent", ["commission_percent"], "number"),
      c("minimum_stock", ["minimum_stock", "min_stock_alert"], "number"),
      c("track_stock", "track_stock", "boolean"),
      c("track_serial", ["track_serial", "has_serial"], "boolean"),
      c("is_kit", "is_kit", "boolean"),
      c("status", "status"),
      c("image_path", ["image_path", "image"]),
      CREATED_AT()
    ]
  },
  product_variants: {
    table: "product_variants",
    tombstone: "deactivate",
    tombstoneColumn: "active",
    tombstoneValue: "false",
    columns: [
      ID(),
      COMPANY(),
      c("product_id", "product_id", "uuid", true),
      c("name", "name", "text", true),
      c("attributes", "attributes", "json"),
      c("active", ["active", "is_active"], "boolean")
    ]
  },
  sales: {
    table: "sales",
    tombstone: "soft",
    columns: [
      ID(),
      COMPANY(),
      c("warehouse_id", ["warehouse_id", "branch_id"], "uuid", true),
      c("cash_session_id", ["cash_session_id", "session_id"], "uuid"),
      c("employee_id", "employee_id", "uuid"),
      c("seller_user_id", ["seller_user_id", "user_id"], "uuid"),
      c("customer_id", "customer_id", "uuid"),
      c("status", "status"),
      c("total", ["total", "total_amount"], "number"),
      c("currency_code", ["currency_code", "currency"]),
      c("client_name", "client_name"),
      c("notes", "notes"),
      c("source_operation_id", "source_operation_id", "uuid"),
      c("metadata", "metadata", "json"),
      CREATED_AT()
    ]
  },
  sale_items: {
    table: "sale_items",
    tombstone: "purge",
    parent: { column: "sale_id", localTable: "sales", localKey: "sale_id" },
    columns: [
      ID(),
      c("sale_id", "sale_id", "uuid", true),
      c("product_id", "product_id", "uuid", true),
      c("variant_id", "variant_id", "uuid"),
      c("quantity", "quantity", "number"),
      c("unit_price", ["unit_price", "price"], "number"),
      c("discount", "discount", "number"),
      c("tax", "tax", "number"),
      c("line_total", ["line_total", "total"], "number"),
      c("serial_number", "serial_number")
    ]
  },
  sale_payments: {
    table: "payments",
    tombstone: "purge",
    parent: { column: "sale_id", localTable: "sales", localKey: "sale_id" },
    columns: [
      ID(),
      COMPANY(),
      c("sale_id", "sale_id", "uuid", true),
      c("method", "method"),
      c("currency_code", ["currency_code", "currency"]),
      c("amount", "amount", "number"),
      c("exchange_rate", "exchange_rate", "number"),
      c("reference", "reference"),
      c("created_by", "created_by", "uuid")
    ]
  },
  cash_sessions: {
    table: "cash_sessions",
    tombstone: "soft",
    columns: [
      ID(),
      COMPANY(),
      c("cash_register_id", "cash_register_id", "uuid"),
      c("employee_id", "employee_id", "uuid"),
      c("opened_by", "opened_by", "uuid"),
      c("closed_by", "closed_by", "uuid"),
      c("status", "status"),
      c("opened_at", ["opened_at", "date"], "timestamp"),
      c("closed_at", "closed_at", "timestamp"),
      c("opening_amount", ["opening_amount", "opening_balance"], "number"),
      c("expected_cash", ["expected_cash", "expected_balance"], "number"),
      c("physical_cash", ["physical_cash"], "number"),
      c("difference", "difference", "number"),
      c("turn_number", "turn_number", "number"),
      c("metadata", "metadata", "json")
    ]
  },
  cash_movements: {
    table: "cash_movements",
    tombstone: "purge",
    parent: { column: "cash_session_id", localTable: "cash_sessions", localKey: "cash_session_id" },
    columns: [
      ID(),
      COMPANY(),
      c("cash_session_id", ["cash_session_id", "session_id"], "uuid", true),
      c("movement_type", ["movement_type", "type"], "text", true),
      c("amount", "amount", "number"),
      c("currency_code", ["currency_code", "currency"]),
      c("reference_id", "reference_id", "uuid"),
      c("note", ["note", "description"]),
      c("created_by", ["created_by", "user_id"], "uuid")
    ]
  },
  stock_movements: {
    table: "stock_movements",
    tombstone: "purge",
    columns: [
      ID(),
      COMPANY(),
      c("warehouse_id", ["warehouse_id", "branch_id"], "uuid", true),
      c("product_id", "product_id", "uuid", true),
      c("variant_id", "variant_id", "uuid"),
      c("movement_type", ["movement_type", "type"], "text", true),
      c("quantity", "quantity", "number"),
      c("reference_type", "reference_type"),
      c("reference_id", "reference_id", "uuid"),
      c("created_by", ["created_by", "user_id"], "uuid"),
      c("occurred_at", ["occurred_at", "created_at", "date"], "timestamp"),
      c("note", ["note", "description"])
    ]
  },
  customers: {
    table: "customers",
    tombstone: "deactivate",
    tombstoneColumn: "active",
    tombstoneValue: "false",
    columns: [
      ID(),
      COMPANY(),
      c("name", "name", "text", true),
      c("phone", "phone"),
      c("email", "email"),
      c("tax_id", ["tax_id", "taxid"]),
      c("active", ["active", "is_active"], "boolean")
    ]
  },
  suppliers: {
    table: "suppliers",
    tombstone: "deactivate",
    tombstoneColumn: "active",
    tombstoneValue: "false",
    columns: [
      ID(),
      COMPANY(),
      c("name", "name", "text", true),
      c("phone", "phone"),
      c("address", "address"),
      c("email", "email"),
      c("rating", ["rating"], "number"),
      c("merchandise_type", ["merchandise_type", "type_of_merchandise"]),
      c("active", ["active", "is_active"], "boolean")
    ]
  },
  purchases: {
    table: "purchase_orders",
    tombstone: "deactivate",
    tombstoneColumn: "status",
    tombstoneValue: "cancelled",
    columns: [
      ID(),
      COMPANY(),
      c("supplier_id", "supplier_id", "uuid"),
      c("warehouse_id", ["warehouse_id", "branch_id"], "uuid", true),
      c("status", "status"),
      c("order_number", ["order_number"], "text"),
      c("currency_code", ["currency_code", "currency"]),
      c("subtotal", "subtotal", "number"),
      c("total", "total", "number"),
      c("created_by", ["created_by", "user_id"], "uuid"),
      c("expected_delivery_date", "expected_delivery_date", "timestamp"),
      c("transport_cost", "transport_cost", "number"),
      c("transport_details", "transport_details", "json"),
      CREATED_AT(),
      UPDATED_AT()
    ]
  },
  purchase_items: {
    table: "purchase_items",
    tombstone: "purge",
    parent: { column: "purchase_order_id", localTable: "purchases", localKey: "purchase_id" },
    columns: [
      ID(),
      c("purchase_order_id", ["purchase_order_id", "purchase_id"], "uuid", true),
      c("product_id", "product_id", "uuid", true),
      c("quantity", "quantity", "number"),
      c("unit_cost", ["unit_cost", "cost"], "number"),
      c("line_total", ["line_total", "total"], "number")
    ]
  },
  transfers: {
    table: "transfers",
    tombstone: "deactivate",
    tombstoneColumn: "status",
    tombstoneValue: "cancelled",
    columns: [
      ID(),
      COMPANY(),
      c("origin_warehouse_id", ["origin_warehouse_id", "from_branch_id"], "uuid", true),
      c("destination_warehouse_id", ["destination_warehouse_id", "to_branch_id"], "uuid", true),
      c("status", "status"),
      c("notes", ["notes", "description"]),
      c("created_by", ["created_by", "user_id"], "uuid"),
      c("batch_id", "batch_id", "uuid"),
      c("received_at", "received_at", "timestamp"),
      c("received_by", "received_by", "uuid"),
      CREATED_AT()
    ]
  },
  transfer_items: {
    table: "transfer_items",
    tombstone: "purge",
    parent: { column: "transfer_id", localTable: "transfers", localKey: "transfer_id" },
    columns: [
      ID(),
      c("transfer_id", "transfer_id", "uuid", true),
      c("product_id", "product_id", "uuid", true),
      c("quantity", "quantity", "number"),
      c("variant_id", "variant_id", "uuid")
    ]
  },
  returns: {
    table: "sales_returns",
    tombstone: "purge",
    columns: [
      ID(),
      COMPANY(),
      c("sale_id", ["sale_id", "transaction_id"], "uuid", true),
      c("status", "status"),
      c("reason", "reason"),
      c("total", ["total", "refund_amount"], "number"),
      c("created_by", ["created_by", "user_id"], "uuid"),
      c("return_type", ["return_type", "type"]),
      c("refund_status", "refund_status"),
      c("refund_amount", "refund_amount", "number"),
      c("refund_currency_code", ["refund_currency_code", "refund_currency"], "text"),
      c("refund_method", "refund_method"),
      c("refund_bank_card_id", ["refund_bank_card_id"], "uuid"),
      c("refund_transaction_id", ["refund_transaction_id"], "uuid"),
      c("refunded_at", "refunded_at", "timestamp"),
      UPDATED_AT()
    ]
  },
  return_items: {
    table: "sales_return_items",
    tombstone: "purge",
    parent: { column: "return_id", localTable: "returns", localKey: "return_id" },
    columns: [
      ID(),
      c("return_id", "return_id", "uuid", true),
      c("sale_item_id", "sale_item_id", "uuid"),
      c("product_id", "product_id", "uuid", true),
      c("quantity", "quantity", "number"),
      c("unit_price", ["unit_price", "price"], "number"),
      c("line_total", ["line_total", "total"], "number"),
      c("variant_id", "variant_id", "uuid")
    ]
  },
  quotes: {
    table: "quotes",
    tombstone: "purge",
    columns: [
      ID(),
      COMPANY(),
      c("quote_number", "quote_number"),
      c("customer_id", "customer_id", "uuid"),
      c("warehouse_id", ["warehouse_id", "branch_id"], "uuid", true),
      c("currency_code", ["currency_code", "currency"]),
      c("status", "status"),
      c("total", "total", "number"),
      c("valid_until", "valid_until", "timestamp"),
      c("notes", "notes"),
      c("created_by", ["created_by", "user_id"], "uuid")
    ]
  },
  quote_items: {
    table: "quote_items",
    tombstone: "purge",
    parent: { column: "quote_id", localTable: "quotes", localKey: "quote_id" },
    columns: [
      ID(),
      c("quote_id", "quote_id", "uuid", true),
      c("product_id", "product_id", "uuid", true),
      c("quantity", "quantity", "number"),
      c("unit_price", ["unit_price", "price"], "number"),
      c("discount", "discount", "number"),
      c("tax", "tax", "number"),
      c("line_total", ["line_total", "total"], "number")
    ]
  },
  banks: {
    table: "bank_accounts",
    tombstone: "deactivate",
    tombstoneColumn: "active",
    tombstoneValue: "false",
    columns: [
      ID(),
      COMPANY(),
      c("name", "name", "text", true),
      c("bank_name", ["bank_name", "bank"]),
      c("last_four", ["last_four", "last_four_digits"]),
      c("currency_code", ["currency_code", "currency"]),
      c("balance", "balance", "number"),
      c("active", ["active", "is_active"], "boolean"),
      UPDATED_AT()
    ]
  },
  bank_movements: {
    table: "bank_transactions",
    tombstone: "purge",
    parent: { column: "bank_account_id", localTable: "banks", localKey: "bank_account_id" },
    columns: [
      ID(),
      COMPANY(),
      c("bank_account_id", ["bank_account_id", "card_id"], "uuid", true),
      c("transaction_type", ["transaction_type", "type"], "text", true),
      c("amount", "amount", "number"),
      c("currency_code", ["currency_code", "currency"]),
      c("reference", ["reference", "reference_id", "transaction_id"]),
      c("note", ["note", "description"]),
      c("created_by", ["created_by", "user_id"], "uuid"),
      CREATED_AT()
    ]
  },
  inventory_audits: {
    table: "inventory_audits",
    tombstone: "purge",
    columns: [
      ID(),
      COMPANY(),
      c("warehouse_id", ["warehouse_id", "branch_id"], "uuid", true),
      c("status", "status"),
      c("blind_count", "blind_count", "boolean"),
      c("notes", "notes"),
      c("created_by", ["created_by", "user_id"], "uuid"),
      c("submitted_at", "submitted_at", "timestamp"),
      c("reviewed_by", "reviewed_by", "uuid"),
      c("reviewed_at", "reviewed_at", "timestamp"),
      UPDATED_AT()
    ]
  },
  inventory_audit_items: {
    table: "inventory_audit_items",
    tombstone: "purge",
    parent: { column: "audit_id", localTable: "inventory_audits", localKey: "audit_id" },
    columns: [
      ID(),
      c("audit_id", "audit_id", "uuid", true),
      c("product_id", "product_id", "uuid", true),
      c("expected_quantity", ["expected_quantity", "expected"], "number"),
      c("counted_quantity", ["counted_quantity", "counted"], "number"),
      c("difference", "difference", "number"),
      c("notes", "notes")
    ]
  }
};

/** Tablas locales materializables, en el orden de escritura padre → hija. */
export const MATERIALIZABLE_LOCAL_TABLES = Object.keys(
  MATERIALIZE_MAP
) as LocalTable[];

/** Acceso propio al mapa: evita heredados como `__proto__`. */
function specFor(local: string): TableMapping | null {
  if (!Object.prototype.hasOwnProperty.call(MATERIALIZE_MAP, local)) return null;
  return MATERIALIZE_MAP[local as LocalTable] ?? null;
}

/** Tabla cloud para una tabla local; `null` si no se materializa. */
export function cloudTableFor(local: string): string | null {
  const spec = specFor(local);
  return spec ? spec.table : null;
}

/** Columnas cloud explícitas de una tabla local (vacío si no se materializa). */
export function columnsFor(local: string): readonly string[] {
  const spec = specFor(local);
  return spec ? spec.columns.map((column) => column.column) : [];
}

/** ¿La tabla local tiene destino de negocio confirmado? */
export function isMaterializable(local: string): boolean {
  return specFor(local) !== null;
}

/** Motivo por el que una tabla local no se materializa (o `null`). */
export function unsupportedReason(local: string): string | null {
  if (isMaterializable(local)) return null;
  if (Object.prototype.hasOwnProperty.call(LOCAL_ONLY_TABLES, local)) {
    return LOCAL_ONLY_TABLES[local] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(UNSUPPORTED_LOCAL_TABLES, local)) {
    return UNSUPPORTED_LOCAL_TABLES[local] ?? null;
  }
  return "unknown_local_table: no existe en el esquema local v1";
}

export interface UpsertPayloadOptions {
  /** Instante para columnas obligatorias ausentes; por defecto no se rellena. */
  readonly now?: string;
}

/**
 * Construye el objeto de columnas cloud para una fila local.
 *
 * Devuelve `null` cuando la tabla no se materializa, cuando falta una columna
 * requerida o cuando el `id`/`company_id` no son texto utilizable. No valida
 * tipos de Postgres más allá de la coerción básica: eso lo decide el SQL.
 */
export function buildUpsertPayload(
  local: string,
  row: LocalRow | Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  const spec = specFor(local);
  if (!spec || !row) return null;

  const source = row as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  for (const column of spec.columns) {
    const raw = pickValue(source, column.from);
    if (raw === undefined) {
      if (column.required) return null;
      continue;
    }
    const value = coerceValue(raw, column.kind);
    if (value === undefined) {
      if (column.required) return null;
      continue;
    }
    payload[column.column] = value;
  }

  if (!hasText(payload.id) || (!spec.parent && !hasText(payload.company_id))) return null;
  return payload;
}

/**
 * Extrae la fila del sobre que guarda la bandeja.
 *
 * `ingest_local_changes` guarda el cambio completo serializado:
 * `{ seq, table, row_id, op, row, deleted_at }`; los campos de negocio están en
 * `row`, no en la raíz. El SQL usa la misma ruta (`payload -> 'row'`).
 */
export function rowFromInboxPayload(
  payload: unknown
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).row;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
}

/** ¿El sobre de la bandeja representa un tombstone? */
export function isTombstoneEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const envelope = payload as Record<string, unknown>;
  if (envelope.op === "delete") return true;
  const row = rowFromInboxPayload(payload);
  return typeof row?.deleted_at === "string" && row.deleted_at.trim() !== "";
}

/** Valores de un tombstone: modo y columnas a tocar, sin SQL. */
export interface TombstonePlan {
  readonly table: string;
  readonly mode: TombstoneMode;
  readonly column?: string;
  readonly value?: string;
}

/** Plan de borrado para una tabla local; `null` si no se materializa. */
export function tombstoneFor(local: string): TombstonePlan | null {
  const spec = specFor(local);
  if (!spec) return null;
  return {
    table: spec.table,
    mode: spec.tombstone,
    ...(spec.tombstoneColumn ? { column: spec.tombstoneColumn } : {}),
    ...(spec.tombstoneValue ? { value: spec.tombstoneValue } : {})
  };
}

function pickValue(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return undefined;
}

function coerceValue(value: unknown, kind: ColumnKind): unknown {
  switch (kind) {
    case "number": {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const text = String(value).trim().toLowerCase();
      if (text === "true" || text === "1" || text === "yes") return true;
      if (text === "false" || text === "0" || text === "no") return false;
      return undefined;
    }
    case "uuid": {
      const text = String(value).trim();
      return text ? text.toLowerCase() : undefined;
    }
    case "timestamp": {
      const text = String(value).trim();
      return text || undefined;
    }
    case "json": {
      if (typeof value === "object") return value;
      return undefined;
    }
    default: {
      if (typeof value === "object") return undefined;
      return String(value);
    }
  }
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Tablas del esquema local v1 sin destino de negocio (para auditoría). */
export const NON_MATERIALIZABLE_LOCAL_TABLES = Object.keys(LOCAL_DB_TABLES).filter(
  (table) => !isMaterializable(table)
);
