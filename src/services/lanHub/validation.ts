/**
 * Validación de negocio de las operaciones que propone un cliente del hub LAN.
 *
 * El hub es el único escritor del almacén local de la empresa, así que no basta
 * con que una fila tenga forma válida: hay que comprobar que la operación tiene
 * sentido contra el estado almacenado. Este módulo no escribe nada; recibe el
 * driver (o la transacción en curso) y devuelve un veredicto por operación.
 *
 * Reglas (códigos del cable):
 * - `unknown_table` / `forbidden_table`: solo tablas del esquema y nunca las
 *   internas del hub.
 * - `company_mismatch`: ninguna fila ni borrado puede tocar otra empresa.
 * - `append_only`: ventas, líneas, pagos, caja y movimientos de inventario se
 *   insertan pero no se actualizan ni se borran.
 * - `stale_version`: la versión entrante es menor que la almacenada.
 * - `version_conflict`: misma versión con contenido distinto.
 * - `duplicate`: misma versión y mismo contenido (reintento idempotente).
 * - `negative_stock`: la cantidad resultante de un saldo o movimiento de stock
 *   quedaría por debajo de cero.
 *
 * La comprobación de stock es deliberadamente conservadora: cuando no hay un
 * saldo almacenado con el que calcular el resultado, se deja pasar la fila para
 * no romper lotes legítimos de catálogo ni movimientos cuyo saldo aún no llegó.
 */
import type { LocalDbDriver, LocalRow, LocalTable, QuerySpec } from "../localDb/contract";
import { LOCAL_DB_TABLE_NAMES } from "../localDb/schema";

/** Códigos que el handler devuelve tal cual en `error` (o como estado `duplicate`). */
export type HubValidationCode =
  | "unknown_table"
  | "forbidden_table"
  | "company_mismatch"
  | "append_only"
  | "stale_version"
  | "version_conflict"
  | "duplicate"
  | "negative_stock";

export type HubValidationFailure = { ok: false; code: HubValidationCode };

export type HubValidationResult =
  | { ok: true }
  | HubValidationFailure;

/**
 * Guarda explícita: el proyecto compila sin `strictNullChecks` y la
 * discriminación por un `ok` booleano no estrecha la unión por sí sola.
 */
export function isValidationFailure(result: HubValidationResult): result is HubValidationFailure {
  return result.ok === false;
}

/**
 * Lo único que la validación necesita del almacén. Tanto el driver como la
 * transacción en curso cumplen esta forma, de modo que el handler puede validar
 * y escribir dentro de la misma transacción.
 */
export type HubValidationDriver = Pick<LocalDbDriver, "get" | "query">;

export interface HubValidateOperationInput {
  table: string;
  rows?: LocalRow[];
  deletes?: string[];
  driver: HubValidationDriver;
  companyId: string;
}

/** Tablas internas del hub: un cliente nunca las escribe. */
const INTERNAL_TABLES = new Set<string>(["hub_devices", "hub_receipts"]);

/**
 * Tablas de solo inserción. `inventory_movements` es el nombre de la nube; en
 * el almacén local el mismo ledger vive como `stock_movements`.
 */
const APPEND_ONLY_TABLES = new Set<string>([
  "sales",
  "sale_voids",
  "sale_items",
  "sale_payments",
  "cash_movements",
  "stock_movements",
  "inventory_movements"
]);

const STOCK_BALANCE_TABLES = new Set<string>(["stock_balances"]);
const STOCK_MOVEMENT_TABLES = new Set<string>(["stock_movements", "inventory_movements"]);

/** Campos que pueden publicar la cantidad resultante ya calculada. */
const RESULT_QUANTITY_FIELDS = ["quantity_after", "resulting_quantity", "stock_after"];

function fail(code: HubValidationCode): HubValidationResult {
  return { ok: false, code };
}

function textField(row: LocalRow, ...fields: string[]): string | null {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberField(row: LocalRow, ...fields: string[]): number | null {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Clave de variante estable: `variant_id` si existe y, si no, etiqueta o base. */
function variantKey(row: LocalRow): string {
  const variant = textField(row, "variant_id", "variant_label");
  return variant ?? "";
}

/** Serialización canónica: claves ordenadas para comparar filas sin falsos negativos. */
function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const fields = keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return '"__nonfinite__"';
  const json = JSON.stringify(value);
  return json === undefined ? "null" : json;
}

/** Igualdad exacta de filas: mismo contenido, sin importar el orden de claves. */
export function sameRow(a: LocalRow, b: LocalRow): boolean {
  return canonicalValue(a) === canonicalValue(b);
}

interface StockKey {
  productId: string;
  warehouseId: string;
  variant: string;
}

function stockKey(row: LocalRow): StockKey | null {
  const productId = textField(row, "product_id");
  if (!productId) return null;
  return {
    productId,
    warehouseId: textField(row, "warehouse_id") ?? "",
    variant: variantKey(row)
  };
}

function stockKeyId(key: StockKey): string {
  return `${key.productId}|${key.warehouseId}|${key.variant}`;
}

/**
 * Saldo vigente del par producto/almacén/variante. Devuelve `null` cuando no se
 * puede determinar (sin producto o sin saldo único coincidente): en ese caso la
 * comprobación no rechaza nada.
 */
async function storedQuantity(
  driver: HubValidationDriver,
  companyId: string,
  key: StockKey
): Promise<number | null> {
  const spec: QuerySpec = {
    table: "stock_balances",
    where: [
      { field: "company_id", op: "eq", value: companyId },
      { field: "product_id", op: "eq", value: key.productId }
    ]
  };
  if (key.warehouseId) {
    spec.where.push({ field: "warehouse_id", op: "eq", value: key.warehouseId });
  }

  let balances: LocalRow[];
  try {
    balances = await driver.query<LocalRow>(spec);
  } catch {
    return null;
  }
  if (balances.length === 0) return null;

  const exact = balances.find((row) => variantKey(row) === key.variant);
  // Sin variante explícita, un único saldo es una respuesta inequívoca.
  const balance = exact ?? (balances.length === 1 ? balances[0] : null);
  if (!balance) return null;
  return numberField(balance, "quantity");
}

/** Devuelve el código de stock si el lote dejaría existencias negativas. */
async function validateStock(
  table: string,
  rows: LocalRow[],
  driver: HubValidationDriver,
  companyId: string
): Promise<HubValidationCode | null> {
  if (STOCK_BALANCE_TABLES.has(table)) {
    for (const row of rows) {
      const quantity = numberField(row, "quantity");
      if (quantity !== null && quantity < 0) return "negative_stock";
    }
    return null;
  }
  if (!STOCK_MOVEMENT_TABLES.has(table)) return null;

  // Deltas acumulados por producto/almacén/variante dentro del propio lote.
  const pending = new Map<string, number>();
  const bases = new Map<string, number | null>();

  for (const row of rows) {
    const published = numberField(row, ...RESULT_QUANTITY_FIELDS);
    if (published !== null && published < 0) return "negative_stock";

    // `quantity_delta` es el nombre explícito; `quantity` va firmada en el
    // ledger de Supabase (negativa en ventas y traslados de salida).
    const delta = numberField(row, "quantity_delta", "quantity");
    if (delta === null || delta >= 0) continue;

    const key = stockKey(row);
    if (!key) continue;
    const id = stockKeyId(key);
    if (!bases.has(id)) {
      bases.set(id, await storedQuantity(driver, companyId, key));
    }
    const base = bases.get(id);
    const total = (pending.get(id) ?? 0) + delta;
    pending.set(id, total);
    // Sin saldo almacenado no se puede probar el resultado: no se rechaza.
    if (base === null || base === undefined) continue;
    if (base + total < 0) return "negative_stock";
  }
  return null;
}

/**
 * Valida una operación completa contra el estado almacenado.
 *
 * No escribe nada y no lanza por datos inválidos: todo veredicto negativo se
 * expresa con un código, para que el handler lo devuelva por operación sin
 * tumbar el resto del lote.
 */
export async function validateOperation(
  input: HubValidateOperationInput
): Promise<HubValidationResult> {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const deletes = Array.isArray(input.deletes) ? input.deletes : [];
  const driver = input.driver;
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  if (!driver || !companyId) return fail("company_mismatch");

  const tableName = typeof input.table === "string" ? input.table.trim() : "";
  if (!tableName || !(LOCAL_DB_TABLE_NAMES as string[]).includes(tableName)) {
    return fail("unknown_table");
  }
  if (INTERNAL_TABLES.has(tableName)) return fail("forbidden_table");
  const table = tableName as LocalTable;
  const appendOnly = APPEND_ONLY_TABLES.has(table);

  // Primera barrera multiempresa: ninguna fila ni borrado toca otra empresa.
  for (const row of rows) {
    if (!row || row.company_id !== companyId) return fail("company_mismatch");
  }
  if (appendOnly && deletes.length > 0) return fail("append_only");

  const seen = new Map<string, LocalRow>();
  for (const row of rows) {
    // Un mismo id repetido dentro del lote: idéntico es un reintento, distinto
    // es un conflicto, y en ambos casos no debe escribirse dos veces.
    const prior = seen.get(row.id);
    if (prior) return fail(sameRow(prior, row) ? "duplicate" : "version_conflict");
    seen.set(row.id, row);

    const stored = await driver.get<LocalRow>(table, row.id);
    if (!stored) continue;
    if (stored.company_id !== companyId) return fail("company_mismatch");
    // Reescribir exactamente lo almacenado no es un cambio: es un reintento.
    if (sameRow(stored, row)) return fail("duplicate");
    if (appendOnly) return fail("append_only");

    const incoming = Number(row.version);
    const current = Number(stored.version);
    if (!Number.isFinite(incoming) || !Number.isFinite(current)) continue;
    if (incoming < current) return fail("stale_version");
    if (incoming === current) return fail("version_conflict");
  }

  for (const id of deletes) {
    if (typeof id !== "string" || !id.trim()) continue;
    const stored = await driver.get<LocalRow>(table, id.trim());
    if (stored && stored.company_id !== companyId) return fail("company_mismatch");
  }

  const stock = await validateStock(table, rows, driver, companyId);
  return stock ? fail(stock) : { ok: true };
}
