/**
 * Importador del estado legado.
 *
 * Hoy la aplicación persiste un único JSON de Zustand (ver
 * services/localStateStorage.ts). Este módulo lo traduce al esquema local
 * normalizado: aplana cada colección de negocio en filas con las columnas
 * comunes de sincronización y conserva el resto de campos tal cual.
 *
 * La lectura del almacén legado y la escritura real quedan fuera: la segunda
 * la realiza applyLegacyImport dentro de una única transacción.
 */
import { assertLocalRow, type LocalDbDriver, type LocalRow, type LocalTable } from "./contract";
import { LOCAL_DB_TABLE_NAMES } from "./schema";

export interface ImportMeta {
  companyId: string;
  originDevice: string;
  /** Permite fijar el instante de importación; por defecto se usa el reloj. */
  now?: string;
}

export interface ImportReport {
  tables: Record<string, number>;
  warnings: string[];
  unmappedKeys: string[];
  totals: { products: number; sales: number; salesTotal: number; cashSessions: number };
}

export interface LegacyImportResult {
  batches: Partial<Record<LocalTable, LocalRow[]>>;
  report: ImportReport;
}

/** Colecciones del estado legado que tienen tabla destino en el esquema v1. */
export const LEGACY_TABLE_MAP: Record<string, LocalTable> = {
  branches: "warehouses",
  products: "products",
  inventory: "stock_balances",
  transactions: "sales",
  cashSessions: "cash_sessions",
  customers: "customers",
  suppliers: "suppliers",
  supplierOrders: "purchases",
  inventoryAudits: "inventory_audits",
  quotes: "quotes",
  transfers: "transfers",
  returns: "returns",
  bankCards: "banks",
  bankTransactions: "bank_movements",
  fiscalConfigs: "ncf_sequences",
};

/** Arreglos de UI o sesión efímera: nunca forman parte del negocio importable. */
const IGNORED_ARRAYS = new Set(["cart", "notifications"]);

/** Claves que se normalizan como columnas comunes; no se copian en crudo. */
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
  "deleted_at",
]);

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** El JSON de zustand/persist envuelve el estado en { state, version }. */
export function unwrapLegacyState(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const wrapper = input as Record<string, unknown>;
  const inner = wrapper.state;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return wrapper;
}

/**
 * Tablas hijas que se derivan de una fila padre. La fila padre conserva sus
 * arreglos como JSON (compatibilidad con el estado legado) y aquí se extraen
 * además filas hijas para que el hub y la nube reciban el detalle normalizado.
 */
interface ChildTableSpec {
  table: LocalTable;
  /** Campo del padre donde viven las líneas. */
  arrayKey: string;
  /** Columna de la fila hija que apunta al id del padre. */
  foreignKey: string;
  /** Segmento del id derivado: `${padreId}:item:...` o `${padreId}:pay:...`. */
  idSegment: "item" | "pay";
  /**
   * El legado guarda la línea dentro de la propia fila (devoluciones y
   * traslados sin variantes): se sintetiza una línea cuando no hay arreglo.
   */
  flatLine: boolean;
}

const CHILD_TABLES: Partial<Record<LocalTable, ChildTableSpec[]>> = {
  sales: [
    { table: "sale_items", arrayKey: "items", foreignKey: "sale_id", idSegment: "item", flatLine: false },
    { table: "sale_payments", arrayKey: "payments", foreignKey: "sale_id", idSegment: "pay", flatLine: false },
  ],
  purchases: [
    { table: "purchase_items", arrayKey: "items", foreignKey: "purchase_id", idSegment: "item", flatLine: false },
  ],
  quotes: [
    { table: "quote_items", arrayKey: "items", foreignKey: "quote_id", idSegment: "item", flatLine: false },
  ],
  returns: [
    { table: "return_items", arrayKey: "items", foreignKey: "return_id", idSegment: "item", flatLine: true },
  ],
  transfers: [
    { table: "transfer_items", arrayKey: "variants", foreignKey: "transfer_id", idSegment: "item", flatLine: true },
  ],
};

/**
 * Snapshots que ya viven en la fila padre y no se duplican en cada línea. El
 * producto embebido (con posible imagen en base64) se aplana a product_id /
 * product_name para no duplicar el peso del JSON.
 */
const CHILD_OMIT_KEYS = new Set(["product"]);

/** Tablas cuyo alcance depende de la sucursal/almacén. */
const WAREHOUSE_SCOPED = new Set<LocalTable>([
  "stock_balances",
  "stock_movements",
  "sales",
  "cash_sessions",
  "purchases",
  "transfers",
  "inventory_audits"
]);

/**
 * El inventario legado guarda niveles sin id (InventoryLevel.id es opcional).
 * Se deriva una clave estable para no perder stock en la migración.
 */
function deriveRowId(table: LocalTable, raw: Record<string, unknown>): string | null {
  if (table !== "stock_balances") return null;
  const productId = firstString(raw.productId, raw.product_id);
  if (!productId) return null;
  const warehouseId =
    firstString(raw.warehouseId, raw.warehouse_id, raw.branchId, raw.branch_id) ?? "default";
  const variant = firstString(raw.variantLabel, raw.variant_label) ?? "base";
  return `stock:${productId}:${warehouseId}:${variant}`;
}

/**
 * Normaliza una fila del estado legado. Devuelve null cuando no hay id ni se
 * puede derivar: esas filas no pueden upsertarse y se informan como descartadas.
 */
function normalizeRow(
  table: LocalTable,
  raw: Record<string, unknown>,
  meta: ImportMeta,
  fallbackNow: string
): LocalRow | null {
  const rawId = raw.id;
  const id =
    typeof rawId === "string"
      ? rawId.trim()
      : typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : "";
  const resolvedId = id || deriveRowId(table, raw);
  if (!resolvedId) return null;

  const row = {} as LocalRow;
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || typeof value === "function") continue;
    if (COMMON_KEYS.has(key)) continue;
    // Solo se renombran las claves de la fila. Los arrays y objetos anidados
    // (items, payments, movements...) se guardan como JSON sin tocar.
    row[toSnakeCase(key)] = value;
  }

  const companyId = firstString(raw.companyId, raw.company_id) ?? meta.companyId;
  const versionValue = raw.version;
  const version = typeof versionValue === "number" && Number.isFinite(versionValue) ? versionValue : 1;
  const updatedAt =
    firstString(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at) ??
    meta.now ??
    fallbackNow;
  const originDevice = firstString(raw.originDevice, raw.origin_device) ?? meta.originDevice;
  const deletedAt = typeof raw.deletedAt === "string" ? raw.deletedAt : typeof raw.deleted_at === "string" ? raw.deleted_at : null;

  // El alcance se guarda siempre en warehouse_id; branch_id se conserva como
  // compatibilidad con el estado legado.
  if (
    WAREHOUSE_SCOPED.has(table) &&
    (row.warehouse_id === undefined || row.warehouse_id === null) &&
    typeof row.branch_id === "string"
  ) {
    row.warehouse_id = row.branch_id;
  }

  row.id = resolvedId;
  row.company_id = companyId;
  row.version = version;
  row.updated_at = updatedAt;
  row.origin_device = originDevice;
  row.deleted_at = deletedAt;
  return row;
}

function buildRows(
  table: LocalTable,
  source: unknown[],
  meta: ImportMeta,
  fallbackNow: string,
  warnings: string[]
): LocalRow[] {
  const byId = new Map<string, LocalRow>();
  let withoutId = 0;
  let invalid = 0;
  let derivedIds = 0;

  for (const candidate of source) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      invalid += 1;
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const hadId =
      (typeof record.id === "string" && record.id.trim() !== "") ||
      (typeof record.id === "number" && Number.isFinite(record.id));
    const row = normalizeRow(table, record, meta, fallbackNow);
    if (!row) {
      withoutId += 1;
      continue;
    }
    if (!hadId) derivedIds += 1;
    // Ante un id repetido gana la última ocurrencia del arreglo legado.
    if (byId.has(row.id)) warnings.push(`${table}: id duplicado "${row.id}" (se conserva la última)`);
    byId.set(row.id, row);
  }

  if (derivedIds > 0) warnings.push(`${table}: ${derivedIds} filas sin id con id derivado`);
  if (withoutId > 0) warnings.push(`${table}: ${withoutId} filas sin id`);
  if (invalid > 0) warnings.push(`${table}: ${invalid} filas con formato inválido`);
  return Array.from(byId.values());
}

/**
 * Clave de la línea: su id propio si lo tiene; si no, el índice dentro del
 * arreglo. Reimportar el mismo estado produce siempre los mismos ids.
 */
function childRowId(prefix: string, rawId: unknown, index: number): string {
  if (typeof rawId === "string" && rawId.trim()) return prefix + rawId.trim();
  if (typeof rawId === "number" && Number.isFinite(rawId)) return prefix + String(rawId);
  return prefix + String(index);
}

/** Copia los campos de negocio de una línea sin tocar las columnas comunes. */
function copyLineFields(
  target: LocalRow,
  line: Record<string, unknown>,
  foreignKey: string,
  omit: Set<string>
): void {
  for (const [key, value] of Object.entries(line)) {
    if (value === undefined || typeof value === "function") continue;
    if (COMMON_KEYS.has(key) || CHILD_OMIT_KEYS.has(key) || omit.has(key)) continue;
    const column = toSnakeCase(key);
    if (column === foreignKey) continue;
    target[column] = value;
  }
}

/**
 * Línea sintética para colecciones donde el legado guarda un único producto por
 * fila (devoluciones y traslados sin `variants`). Se copian los campos de la
 * fila padre salvo las columnas comunes y los arreglos que generan sus propios
 * hijos, de modo que no se pierde ningún dato de la línea original.
 */
function flatLineFrom(parent: LocalRow, ownArrays: Set<string>): Record<string, unknown> {
  const line: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (COMMON_KEYS.has(key) || CHILD_OMIT_KEYS.has(key) || ownArrays.has(key)) continue;
    line[key] = value;
  }
  return line;
}

function buildChildRow(
  spec: ChildTableSpec,
  parent: LocalRow,
  line: Record<string, unknown>,
  id: string,
  omit: Set<string>
): LocalRow {
  const row = {} as LocalRow;
  copyLineFields(row, line, spec.foreignKey, omit);

  // Las líneas de venta y cotización traen el producto embebido: se aplana a
  // product_id/product_name, que es lo que usan los índices del esquema.
  if (row.product_id === undefined && line.product && typeof line.product === "object") {
    const product = line.product as Record<string, unknown>;
    const productId = firstString(product.id);
    const productName = firstString(product.name);
    if (productId) row.product_id = productId;
    if (productName) row.product_name = productName;
  }
  // Los traslados agrupados solo guardan la variante en `variants`; el producto
  // viene de la fila padre.
  if (row.product_id === undefined && typeof parent.product_id === "string") {
    row.product_id = parent.product_id;
  }
  if (row.product_name === undefined && typeof parent.product_name === "string") {
    row.product_name = parent.product_name;
  }

  row.id = id;
  row[spec.foreignKey] = parent.id;
  // version, fechas y dispositivo se heredan del padre: una línea no tiene
  // ciclo de vida propio, cambia cuando cambia la operación a la que pertenece.
  row.company_id = parent.company_id;
  row.version = parent.version;
  row.updated_at = parent.updated_at;
  row.origin_device = parent.origin_device;
  row.deleted_at = typeof parent.deleted_at === "string" ? parent.deleted_at : null;
  if (row.warehouse_id === undefined && typeof parent.warehouse_id === "string") {
    row.warehouse_id = parent.warehouse_id;
  }
  return row;
}

/** Genera las filas hijas de un lote de filas padre ya normalizadas. */
function buildChildRows(
  spec: ChildTableSpec,
  parentSpecs: ChildTableSpec[],
  parents: LocalRow[],
  warnings: string[]
): LocalRow[] {
  const byId = new Map<string, LocalRow>();
  const ownArrays = new Set(parentSpecs.map((entry) => entry.arrayKey));
  let invalid = 0;

  for (const parent of parents) {
    const rawLines = parent[spec.arrayKey];
    const lines = Array.isArray(rawLines) ? rawLines : [];
    const prefix = `${parent.id}:${spec.idSegment}:`;
    const built: { line: Record<string, unknown>; id: string }[] = [];

    lines.forEach((candidate, index) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        invalid += 1;
        return;
      }
      const line = candidate as Record<string, unknown>;
      built.push({ line, id: childRowId(prefix, line.id, index) });
    });

    if (built.length === 0 && spec.flatLine) {
      built.push({ line: flatLineFrom(parent, ownArrays), id: prefix + "0" });
    }

    for (const { line, id } of built) {
      const row = buildChildRow(spec, parent, line, id, ownArrays);
      // Mismo criterio que las filas padre: ante un id repetido gana la última.
      if (byId.has(row.id)) warnings.push(`${spec.table}: id duplicado "${row.id}" (se conserva la última)`);
      byId.set(row.id, row);
    }
  }

  if (invalid > 0) warnings.push(`${spec.table}: ${invalid} líneas con formato inválido`);
  return Array.from(byId.values());
}

function sumSalesTotal(sales: LocalRow[] | undefined): number {
  let sum = 0;
  for (const row of sales ?? []) {
    const value = row.total ?? row.total_amount;
    if (typeof value === "number" && Number.isFinite(value)) sum += value;
  }
  return sum;
}

/**
 * Traduce el estado legado a lotes por tabla. No escribe nada: el resultado se
 * entrega a applyLegacyImport (o se inspecciona en pruebas/verificaciones).
 */
export function importLegacyState(state: unknown, meta: ImportMeta): LegacyImportResult {
  const source = unwrapLegacyState(state);
  const fallbackNow = new Date().toISOString();
  const batches: Partial<Record<LocalTable, LocalRow[]>> = {};
  /** Filas hijas acumuladas; varias colecciones podrían alimentar una misma hija. */
  const childBatches = new Map<LocalTable, Map<string, LocalRow>>();
  const warnings: string[] = [];
  const unmappedKeys: string[] = [];
  const tables: Record<string, number> = {};

  for (const key of Object.keys(source)) {
    const value = source[key];
    const table = LEGACY_TABLE_MAP[key];

    if (!Array.isArray(value)) {
      if (table) warnings.push(`${table}: el valor legado "${key}" no es un arreglo (omitido)`);
      continue;
    }
    if (IGNORED_ARRAYS.has(key)) continue;
    if (!table) {
      unmappedKeys.push(`${key}: ${value.length}`);
      continue;
    }

    const rows = buildRows(table, value, meta, fallbackNow, warnings);
    if (rows.length === 0) continue;
    batches[table] = rows;
    tables[table] = rows.length;

    const childSpecs = CHILD_TABLES[table];
    if (!childSpecs) continue;
    for (const spec of childSpecs) {
      const childRows = buildChildRows(spec, childSpecs, rows, warnings);
      if (childRows.length === 0) continue;
      let bucket = childBatches.get(spec.table);
      if (!bucket) {
        bucket = new Map<string, LocalRow>();
        childBatches.set(spec.table, bucket);
      }
      for (const row of childRows) bucket.set(row.id, row);
    }
  }

  // Las hijas se añaden después de sus padres para que el orden de escritura
  // (LOCAL_DB_TABLE_NAMES) nunca deje una línea apuntando a un padre ausente.
  for (const [table, bucket] of childBatches) {
    const rows = Array.from(bucket.values());
    if (rows.length === 0) continue;
    batches[table] = rows;
    tables[table] = rows.length;
  }

  return {
    batches,
    report: {
      tables,
      warnings,
      unmappedKeys,
      totals: {
        products: batches.products?.length ?? 0,
        sales: batches.sales?.length ?? 0,
        salesTotal: sumSalesTotal(batches.sales),
        cashSessions: batches.cash_sessions?.length ?? 0,
      },
    },
  };
}

/**
 * Escribe todos los lotes con una única transacción. El almacén legado no se
 * toca: su limpieza es una decisión aparte del llamador.
 */
export async function applyLegacyImport(driver: LocalDbDriver, result: LegacyImportResult): Promise<void> {
  await driver.transaction(async (tx) => {
    for (const table of LOCAL_DB_TABLE_NAMES) {
      const rows = result.batches[table];
      if (!rows || rows.length === 0) continue;
      // Se valida antes de escribir para que una fila inválida aborte el lote
      // completo en lugar de dejar la importación a medias.
      for (const row of rows) assertLocalRow(table, row);
      await tx.put(table, rows);
    }
  });
}
