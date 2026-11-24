import type { LocalTable } from "./contract";

/**
 * Esquema lógico v1. Cada driver lo traduce a su almacenamiento físico:
 * IndexedDB crea un object store por tabla; SQLite crea una tabla por entrada.
 */
export const LOCAL_DB_VERSION = 1;

export interface TableSchema {
  /** Nombre físico. */
  name: LocalTable;
  /** Campos indexados por empresa; el driver añade id como clave primaria. */
  indexes: string[][];
}

const company: string[] = ["company_id"];
const companyUpdated: string[] = ["company_id", "updated_at"];
const companyCreated: string[] = ["company_id", "created_at"];
const companyVoided: string[] = ["company_id", "voided_at"];
const companyWarehouse: string[] = ["company_id", "warehouse_id"];
const companySale: string[] = ["company_id", "sale_id"];
const companyProduct: string[] = ["company_id", "product_id"];
const companySession: string[] = ["company_id", "session_id"];

/** Tablas del esquema lógico. */
export const LOCAL_DB_TABLES: Record<LocalTable, TableSchema> = {
  companies: { name: "companies", indexes: [company] },
  company_settings: { name: "company_settings", indexes: [company] },
  warehouses: { name: "warehouses", indexes: [company, companyUpdated] },
  products: { name: "products", indexes: [company, companyUpdated, ["company_id", "name"]] },
  product_variants: { name: "product_variants", indexes: [companyProduct] },
  product_codes: { name: "product_codes", indexes: [company, ["company_id", "code"]] },
  product_prices: { name: "product_prices", indexes: [companyProduct, companyWarehouse] },
  stock_movements: { name: "stock_movements", indexes: [companyProduct, companyWarehouse, companyCreated] },
  stock_balances: { name: "stock_balances", indexes: [companyProduct, companyWarehouse] },
  // Índice por fecha de negocio: la ventana «últimas 200» ordena por `date` y
  // sin él SQLite recorría las 50.000 ventas (medido: 1,2 s frente a 300 ms).
  sales: { name: "sales", indexes: [company, companyCreated, companyWarehouse, ["company_id", "date"]] },
  /**
   * Libro de anulaciones de venta. Columnas: id, company_id, sale_id,
   * branch_id, reason, voided_at, created_by, version, updated_at,
   * origin_device y deleted_at. Solo se anexa: nunca se actualiza ni se borra.
   */
  sale_voids: { name: "sale_voids", indexes: [company, companySale, companyVoided] },
  sale_items: { name: "sale_items", indexes: [companySale, companyProduct] },
  sale_payments: { name: "sale_payments", indexes: [companySale] },
  cash_sessions: { name: "cash_sessions", indexes: [company, companyWarehouse, companyCreated] },
  cash_movements: { name: "cash_movements", indexes: [companySession, companyCreated] },
  customers: { name: "customers", indexes: [company, companyUpdated] },
  suppliers: { name: "suppliers", indexes: [company, companyUpdated] },
  purchases: { name: "purchases", indexes: [company, companyCreated, companyWarehouse] },
  purchase_items: { name: "purchase_items", indexes: [company, ["company_id", "purchase_id"]] },
  transfers: { name: "transfers", indexes: [company, companyCreated] },
  transfer_items: { name: "transfer_items", indexes: [company, ["company_id", "transfer_id"]] },
  returns: { name: "returns", indexes: [company, companyCreated, companySale] },
  return_items: { name: "return_items", indexes: [company, ["company_id", "return_id"]] },
  quotes: { name: "quotes", indexes: [company, companyCreated] },
  quote_items: { name: "quote_items", indexes: [company, ["company_id", "quote_id"]] },
  banks: { name: "banks", indexes: [company, companyUpdated] },
  bank_movements: { name: "bank_movements", indexes: [company, ["company_id", "bank_id"], companyCreated] },
  inventory_audits: { name: "inventory_audits", indexes: [company, companyCreated, companyWarehouse] },
  inventory_audit_items: { name: "inventory_audit_items", indexes: [company, ["company_id", "audit_id"]] },
  ncf_sequences: { name: "ncf_sequences", indexes: [company] },
  outbox: { name: "outbox", indexes: [company, ["company_id", "status"], companyCreated] },
  /**
   * Equipos emparejados con el hub LAN. Columnas: id, company_id, version,
   * updated_at, origin_device, deleted_at, device_id, device_name, platform,
   * token_hash, pin_hash (PBKDF2 del PIN o null), paired_at y revoked_at.
   * `pin_hash` es aditivo: el driver SQLite guarda los campos no comunes en el
   * JSON `data`, así que las bases existentes lo admiten sin migración.
   */
  hub_devices: { name: "hub_devices", indexes: [company, ["company_id", "device_id"]] },
  hub_receipts: { name: "hub_receipts", indexes: [company, ["company_id", "action_id"], companyCreated] }
};

export const LOCAL_DB_TABLE_NAMES = Object.keys(LOCAL_DB_TABLES) as LocalTable[];
