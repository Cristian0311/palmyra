/**
 * Repositorios tipados sobre el almacén local normalizado.
 *
 * Son la puerta de escritura del almacén: cada operación añade las columnas
 * comunes de sincronización (company_id, version, updated_at, origin_device),
 * incrementa la versión respecto de la fila guardada y filtra siempre por
 * empresa sin devolver tombstones. La traducción legado → filas se delega en
 * importLegacy para no mantener dos mapeos distintos.
 */
import type {
  Branch,
  CartItem,
  CashMovement,
  CashRegisterSession,
  Customer,
  InventoryLevel,
  Payment,
  Product,
  StoreConfig,
  Supplier,
  Transaction
} from "../../types";
import {
  LocalDbError,
  type LocalDbDriver,
  type LocalDbTransaction,
  type LocalRow,
  type LocalTable,
  type QueryFilter
} from "./contract";
import { importLegacyState } from "./importLegacy";

export interface RepositoryOptions {
  /** Empresa dueña de las filas; sin ella no se puede leer ni escribir. */
  companyId?: string;
  /** Dispositivo que firma la escritura; por defecto "local". */
  deviceId?: string;
  /** Reloj inyectable: las pruebas fijan el instante de updated_at. */
  now?: () => string;
}

const DEFAULT_ORIGIN_DEVICE = "local";

/** Columnas de sincronización: nunca se copian como campos de negocio. */
const COMMON_COLUMNS = new Set([
  "id",
  "company_id",
  "version",
  "updated_at",
  "origin_device",
  "deleted_at"
]);

export interface RepositoryContext {
  driver: LocalDbDriver;
  companyId: string;
  deviceId: string;
  now: () => string;
}

export interface ProductRepository {
  list(): Promise<Product[]>;
  get(id: string): Promise<Product | null>;
  save(product: Product): Promise<Product>;
  saveMany(products: Product[]): Promise<Product[]>;
  remove(id: string): Promise<void>;
}

export interface InventoryRepository {
  list(): Promise<InventoryLevel[]>;
  get(id: string): Promise<InventoryLevel | null>;
  save(level: InventoryLevel): Promise<InventoryLevel>;
  saveMany(levels: InventoryLevel[]): Promise<InventoryLevel[]>;
  remove(id: string): Promise<void>;
}

export interface CustomerRepository {
  list(): Promise<Customer[]>;
  get(id: string): Promise<Customer | null>;
  save(customer: Customer): Promise<Customer>;
  remove(id: string): Promise<void>;
}

export interface SupplierRepository {
  list(): Promise<Supplier[]>;
  get(id: string): Promise<Supplier | null>;
  save(supplier: Supplier): Promise<Supplier>;
  remove(id: string): Promise<void>;
}

export interface SaleRepository {
  list(): Promise<Transaction[]>;
  get(id: string): Promise<Transaction | null>;
  save(sale: Transaction): Promise<Transaction>;
  saveMany(sales: Transaction[]): Promise<Transaction[]>;
  remove(id: string): Promise<void>;
}

export interface CashSessionRepository {
  list(): Promise<CashRegisterSession[]>;
  get(id: string): Promise<CashRegisterSession | null>;
  save(session: CashRegisterSession): Promise<CashRegisterSession>;
  remove(id: string): Promise<void>;
}

export interface StoreConfigRepository {
  get(): Promise<StoreConfig | null>;
  save(config: StoreConfig): Promise<StoreConfig>;
}

export interface LocalRepositories {
  products: ProductRepository;
  inventory: InventoryRepository;
  customers: CustomerRepository;
  suppliers: SupplierRepository;
  sales: SaleRepository;
  cashSessions: CashSessionRepository;
  storeConfig: StoreConfigRepository;
}

interface WriteContext {
  company_id: string;
  origin_device: string;
  at: string;
}

// ---------------------------------------------------------------------------
// fila → entidad de la store
// ---------------------------------------------------------------------------

/** Inversa de la conversión a snake_case que aplica el importador legado. */
export function toCamelColumn(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Campos de negocio de una fila con sus claves camelCase, sin columnas comunes. */
export function rowToEntityFields(row: LocalRow): Record<string, unknown> {
  const fields: Record<string, unknown> = { id: row.id };
  for (const [column, value] of Object.entries(row)) {
    if (COMMON_COLUMNS.has(column)) continue;
    if (value === undefined || typeof value === "function") continue;
    fields[toCamelColumn(column)] = value;
  }
  return fields;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function productFromRow(row: LocalRow): Product {
  const fields = rowToEntityFields(row);
  return {
    ...fields,
    id: row.id,
    name: asString(fields.name),
    sku: asString(fields.sku),
    costPrice: asNumber(fields.costPrice),
    price: asNumber(fields.price),
    margin: asNumber(fields.margin),
    categoryId: asString(fields.categoryId),
    color: asString(fields.color),
    commissionValue: asNumber(fields.commissionValue)
  } as unknown as Product;
}

export function inventoryFromRow(row: LocalRow): InventoryLevel {
  const fields = rowToEntityFields(row);
  const warehouseId = asString(fields.warehouseId) || asString(fields.branchId) || "default";
  return {
    ...fields,
    id: row.id,
    productId: asString(fields.productId),
    warehouseId,
    branchId: asString(fields.branchId) || warehouseId,
    variantLabel: optionalString(fields.variantLabel),
    quantity: asNumber(fields.quantity),
    minQuantity: asNumber(fields.minQuantity)
  } as InventoryLevel;
}

export function customerFromRow(row: LocalRow): Customer {
  const fields = rowToEntityFields(row);
  return {
    ...fields,
    id: row.id,
    name: asString(fields.name),
    email: asString(fields.email),
    phone: asString(fields.phone)
  } as unknown as Customer;
}

export function supplierFromRow(row: LocalRow): Supplier {
  const fields = rowToEntityFields(row);
  return {
    ...fields,
    id: row.id,
    name: asString(fields.name),
    phone: asString(fields.phone)
  } as unknown as Supplier;
}

export function branchFromRow(row: LocalRow): Branch {
  const fields = rowToEntityFields(row);
  return {
    ...fields,
    id: row.id,
    name: asString(fields.name),
    address: optionalString(fields.address),
    phone: optionalString(fields.phone),
    isMain: fields.isMain === true,
    isActive: fields.isActive !== false
  } as Branch;
}

function resolvedBranchId(fields: Record<string, unknown>): string {
  return asString(fields.branchId) || asString(fields.warehouseId) || "default";
}

export function transactionFromRow(row: LocalRow): Transaction {
  const fields = rowToEntityFields(row);
  const status = fields.status;
  return {
    ...fields,
    id: row.id,
    branchId: resolvedBranchId(fields),
    userId: asString(fields.userId),
    date: asString(fields.date),
    total: asNumber(fields.total),
    payments: asArray<Payment>(fields.payments),
    items: asArray<CartItem>(fields.items),
    status:
      status === "refunded" || status === "partial_refund" ? status : "completed"
  } as unknown as Transaction;
}

export function cashSessionFromRow(row: LocalRow): CashRegisterSession {
  const fields = rowToEntityFields(row);
  const status = fields.status;
  return {
    ...fields,
    id: row.id,
    branchId: resolvedBranchId(fields),
    openedAt: asString(fields.openedAt),
    openingBalance: asNumber(fields.openingBalance),
    status: status === "open" || status === "cancelled" ? status : "closed",
    userId: asString(fields.userId),
    movements: Array.isArray(fields.movements)
      ? (fields.movements as CashMovement[])
      : undefined
  } as unknown as CashRegisterSession;
}

export function cashMovementFromRow(row: LocalRow): CashMovement {
  const fields = rowToEntityFields(row);
  const type = fields.type;
  return {
    ...fields,
    id: row.id,
    type: type === "expense" ? "expense" : "income",
    amount: asNumber(fields.amount),
    currencyCode: asString(fields.currencyCode),
    description: asString(fields.description),
    date: asString(fields.date),
    sessionId: optionalString(fields.sessionId) ?? optionalString(row.session_id)
  } as CashMovement;
}

export function storeConfigFromRow(
  settingsRow: LocalRow | null,
  companyRow?: LocalRow | null
): StoreConfig {
  const stored =
    settingsRow && settingsRow.config && typeof settingsRow.config === "object" && !Array.isArray(settingsRow.config)
      ? (settingsRow.config as Record<string, unknown>)
      : {};
  const storeName =
    asString(stored.storeName) ||
    asString(settingsRow?.store_name) ||
    asString(companyRow?.name);
  return {
    ...stored,
    storeName,
    address: asString(stored.address),
    phone: asString(stored.phone)
  } as StoreConfig;
}

// ---------------------------------------------------------------------------
// escritura
// ---------------------------------------------------------------------------

/**
 * Prepara una fila para escribirla con las columnas comunes y la versión por
 * encima de lo que ya exista (local, hub o nube). Devuelve la fila final para
 * poder devolver la entidad tal como quedó guardada.
 */
async function bumpAndPut(
  tx: LocalDbTransaction,
  table: LocalTable,
  rows: LocalRow[],
  ctx: WriteContext
): Promise<LocalRow[]> {
  if (rows.length === 0) return [];
  const bumped: LocalRow[] = [];
  for (const row of rows) {
    const stored = await tx.get<LocalRow>(table, row.id);
    const incoming = Number(row.version);
    const storedVersion = Number(stored?.version);
    const incomingVersion = Number.isFinite(incoming) && incoming > 0 ? incoming : 1;
    // Alta: se respeta la versión entrante (la primera escritura es 1).
    // Actualización: siempre por encima de lo guardado para ganar por LWW.
    const version = Number.isFinite(storedVersion)
      ? Math.max(storedVersion, incomingVersion) + 1
      : incomingVersion;
    bumped.push({
      ...row,
      company_id: ctx.company_id,
      version,
      updated_at: ctx.at,
      origin_device: ctx.origin_device,
      deleted_at: typeof row.deleted_at === "string" ? row.deleted_at : null
    });
  }
  await tx.put(table, bumped);
  return bumped;
}

/** Marca como eliminadas las filas hijas que la entidad entrante ya no trae. */
async function retireMissingChildren(
  tx: LocalDbTransaction,
  table: LocalTable,
  foreignKey: string,
  parentId: string,
  keep: Set<string>,
  ctx: WriteContext
): Promise<void> {
  const existing = await tx.query<LocalRow>({
    table,
    where: [
      { field: "company_id", op: "eq", value: ctx.company_id },
      { field: foreignKey, op: "eq", value: parentId }
    ]
  });
  const doomed = existing.filter((row) => !keep.has(row.id));
  if (doomed.length === 0) return;
  await bumpAndPut(
    tx,
    table,
    doomed.map((row) => ({ ...row, deleted_at: ctx.at })),
    ctx
  );
}

/** Normaliza una entidad con el mapeo legado para no duplicar la conversión. */
function legacyBatches(
  legacyKey: string,
  entity: unknown,
  ctx: WriteContext
): Partial<Record<LocalTable, LocalRow[]>> {
  return importLegacyState(
    { state: { [legacyKey]: [entity] } },
    { companyId: ctx.company_id, originDevice: ctx.origin_device, now: ctx.at }
  ).batches;
}

function cashMovementRow(
  movement: CashMovement,
  session: CashRegisterSession,
  ctx: WriteContext
): LocalRow {
  const row: LocalRow = {
    id: movement.id,
    company_id: ctx.company_id,
    version: 1,
    updated_at: ctx.at,
    origin_device: ctx.origin_device,
    deleted_at: null,
    session_id: session.id,
    type: movement.type === "expense" ? "expense" : "income",
    amount: asNumber(movement.amount),
    currency_code: asString(movement.currencyCode),
    description: asString(movement.description),
    date: asString(movement.date)
  };
  const branchId = optionalString(movement.branchId) ?? optionalString(session.branchId) ?? optionalString(session.warehouseId);
  if (branchId) row.branch_id = branchId;
  if (movement.workerName) row.worker_name = movement.workerName;
  if (movement.category) row.category = movement.category;
  return row;
}

function companySettingRows(companyId: string, config: StoreConfig, ctx: WriteContext): LocalRow[] {
  const name = asString(config.storeName);
  return [
    {
      id: companyId,
      company_id: companyId,
      version: 1,
      updated_at: ctx.at,
      origin_device: ctx.origin_device,
      deleted_at: null,
      store_name: name,
      config: { ...config }
    }
  ];
}

function companyRows(companyId: string, config: StoreConfig, ctx: WriteContext): LocalRow[] {
  return [
    {
      id: companyId,
      company_id: companyId,
      version: 1,
      updated_at: ctx.at,
      origin_device: ctx.origin_device,
      deleted_at: null,
      name: asString(config.storeName)
    }
  ];
}

// ---------------------------------------------------------------------------
// lecturas
// ---------------------------------------------------------------------------

async function loadChildRows(
  driver: LocalDbDriver,
  companyId: string,
  table: LocalTable,
  foreignKey: string,
  parentId: string
): Promise<LocalRow[]> {
  return driver.query<LocalRow>({
    table,
    where: [
      { field: "company_id", op: "eq", value: companyId },
      { field: foreignKey, op: "eq", value: parentId }
    ]
  });
}

function saleItemFromRow(row: LocalRow): CartItem {
  const fields = rowToEntityFields(row);
  const productId = asString(fields.productId);
  return {
    ...fields,
    id: row.id,
    product: {
      id: productId,
      name: asString(fields.productName),
      sku: "",
      costPrice: 0,
      price: asNumber(fields.price),
      margin: 0,
      categoryId: "",
      color: "",
      commissionValue: 0
    } as Product,
    quantity: asNumber(fields.quantity),
    price: asNumber(fields.price),
    total: asNumber(fields.total),
    serialNumber: optionalString(fields.serialNumber),
    variantLabel: optionalString(fields.variantLabel)
  } as CartItem;
}

function salePaymentFromRow(row: LocalRow): Payment {
  const fields = rowToEntityFields(row);
  const method = fields.method;
  return {
    currencyCode: asString(fields.currencyCode, "CUP") as Payment["currencyCode"],
    amount: asNumber(fields.amount),
    exchangeRate: asNumber(fields.exchangeRate, 1),
    method: method === "transfer" ? "transfer" : "cash",
    bankCardId: optionalString(fields.bankCardId)
  };
}

/**
 * Venta con sus líneas y pagos. La fila padre conserva los arreglos legados;
 * solo se consultan las tablas hijas cuando la fila llegó normalizada desde
 * otro dispositivo o desde la nube.
 */
export async function transactionFromRowWithChildren(
  driver: LocalDbDriver,
  companyId: string,
  row: LocalRow
): Promise<Transaction> {
  const base = transactionFromRow(row);
  if ((base.items?.length ?? 0) > 0 || (base.payments?.length ?? 0) > 0) return base;
  const [itemRows, paymentRows] = await Promise.all([
    loadChildRows(driver, companyId, "sale_items", "sale_id", row.id),
    loadChildRows(driver, companyId, "sale_payments", "sale_id", row.id)
  ]);
  return {
    ...base,
    items: itemRows.map(saleItemFromRow),
    payments: paymentRows.map(salePaymentFromRow)
  };
}

export async function cashSessionFromRowWithChildren(
  driver: LocalDbDriver,
  companyId: string,
  row: LocalRow
): Promise<CashRegisterSession> {
  const base = cashSessionFromRow(row);
  if (Array.isArray(base.movements)) return base;
  const movementRows = await loadChildRows(driver, companyId, "cash_movements", "session_id", row.id);
  return { ...base, movements: movementRows.map(cashMovementFromRow) };
}

// ---------------------------------------------------------------------------
// fábrica
// ---------------------------------------------------------------------------

export function createRepositories(
  driver: LocalDbDriver,
  options: RepositoryOptions = {}
): LocalRepositories {
  const deviceId = String(options.deviceId ?? "").trim() || DEFAULT_ORIGIN_DEVICE;
  const clock = options.now ?? (() => new Date().toISOString());
  const configuredCompany = String(options.companyId ?? "").trim();

  function companyId(): string {
    if (!configuredCompany) {
      throw new LocalDbError(
        "invalid_row",
        "Los repositorios locales necesitan companyId para filtrar y firmar las filas"
      );
    }
    return configuredCompany;
  }

  function writeContext(): WriteContext {
    return { company_id: companyId(), origin_device: deviceId, at: clock() };
  }

  async function listRows(table: LocalTable, extra: QueryFilter[] = []): Promise<LocalRow[]> {
    return driver.query<LocalRow>({
      table,
      where: [{ field: "company_id", op: "eq", value: companyId() }, ...extra]
    });
  }

  async function getRow(table: LocalTable, id: string): Promise<LocalRow | null> {
    const row = await driver.get<LocalRow>(table, id);
    // Un id de otra empresa no es visible aunque exista en el almacén.
    if (!row || row.company_id !== companyId() || row.deleted_at) return null;
    return row;
  }

  async function removeRow(table: LocalTable, id: string): Promise<void> {
    const ctx = writeContext();
    await driver.transaction(async (tx) => {
      const stored = await tx.get<LocalRow>(table, id);
      if (!stored || stored.company_id !== ctx.company_id) return;
      if (stored.deleted_at) return;
      await bumpAndPut(tx, table, [{ ...stored, deleted_at: ctx.at }], ctx);
    });
  }

  async function saveProductList(items: Product[]): Promise<Product[]> {
    if (items.length === 0) return [];
    const ctx = writeContext();
    const saved: LocalRow[] = [];
    await driver.transaction(async (tx) => {
      for (const product of items) {
        const rows = legacyBatches("products", product, ctx).products ?? [];
        saved.push(...(await bumpAndPut(tx, "products", rows, ctx)));
      }
    });
    return saved.map(productFromRow);
  }

  const products: ProductRepository = {
    async list() {
      const rows = await listRows("products");
      return rows.map(productFromRow);
    },
    async get(id) {
      const row = await getRow("products", id);
      return row ? productFromRow(row) : null;
    },
    async save(product) {
      const saved = await saveProductList([product]);
      return saved[0];
    },
    async saveMany(items) {
      return saveProductList(items);
    },
    async remove(id) {
      await removeRow("products", id);
    }
  };

  async function saveInventoryList(levels: InventoryLevel[]): Promise<InventoryLevel[]> {
    if (levels.length === 0) return [];
    const ctx = writeContext();
    const saved: LocalRow[] = [];
    await driver.transaction(async (tx) => {
      for (const level of levels) {
        const rows = legacyBatches("inventory", level, ctx).stock_balances ?? [];
        saved.push(...(await bumpAndPut(tx, "stock_balances", rows, ctx)));
      }
    });
    return saved.map(inventoryFromRow);
  }

  const inventory: InventoryRepository = {
    async list() {
      const rows = await listRows("stock_balances");
      return rows.map(inventoryFromRow);
    },
    async get(id) {
      const row = await getRow("stock_balances", id);
      return row ? inventoryFromRow(row) : null;
    },
    async save(level) {
      const saved = await saveInventoryList([level]);
      return saved[0];
    },
    async saveMany(levels) {
      return saveInventoryList(levels);
    },
    async remove(id) {
      await removeRow("stock_balances", id);
    }
  };

  const customers: CustomerRepository = {
    async list() {
      const rows = await listRows("customers");
      return rows.map(customerFromRow);
    },
    async get(id) {
      const row = await getRow("customers", id);
      return row ? customerFromRow(row) : null;
    },
    async save(customer) {
      const ctx = writeContext();
      const saved: LocalRow[] = [];
      await driver.transaction(async (tx) => {
        const rows = legacyBatches("customers", customer, ctx).customers ?? [];
        saved.push(...(await bumpAndPut(tx, "customers", rows, ctx)));
      });
      return customerFromRow(saved[0]);
    },
    async remove(id) {
      await removeRow("customers", id);
    }
  };

  const suppliers: SupplierRepository = {
    async list() {
      const rows = await listRows("suppliers");
      return rows.map(supplierFromRow);
    },
    async get(id) {
      const row = await getRow("suppliers", id);
      return row ? supplierFromRow(row) : null;
    },
    async save(supplier) {
      const ctx = writeContext();
      const saved: LocalRow[] = [];
      await driver.transaction(async (tx) => {
        const rows = legacyBatches("suppliers", supplier, ctx).suppliers ?? [];
        saved.push(...(await bumpAndPut(tx, "suppliers", rows, ctx)));
      });
      return supplierFromRow(saved[0]);
    },
    async remove(id) {
      await removeRow("suppliers", id);
    }
  };

  async function saveSaleList(items: Transaction[]): Promise<Transaction[]> {
    if (items.length === 0) return [];
    const ctx = writeContext();
    const saved: LocalRow[] = [];
    await driver.transaction(async (tx) => {
      for (const sale of items) {
        const batches = legacyBatches("transactions", sale, ctx);
        saved.push(...(await bumpAndPut(tx, "sales", batches.sales ?? [], ctx)));
        const itemRows = await bumpAndPut(tx, "sale_items", batches.sale_items ?? [], ctx);
        const paymentRows = await bumpAndPut(tx, "sale_payments", batches.sale_payments ?? [], ctx);
        await retireMissingChildren(
          tx,
          "sale_items",
          "sale_id",
          sale.id,
          new Set(itemRows.map((row) => row.id)),
          ctx
        );
        await retireMissingChildren(
          tx,
          "sale_payments",
          "sale_id",
          sale.id,
          new Set(paymentRows.map((row) => row.id)),
          ctx
        );
      }
    });
    return saved.map(transactionFromRow);
  }

  const sales: SaleRepository = {
    async list() {
      const rows = await listRows("sales");
      return rows.map(transactionFromRow).sort((a, b) => a.date.localeCompare(b.date));
    },
    async get(id) {
      const row = await getRow("sales", id);
      if (!row) return null;
      return transactionFromRowWithChildren(driver, companyId(), row);
    },
    async save(sale) {
      const saved = await saveSaleList([sale]);
      return saved[0];
    },
    async saveMany(items) {
      return saveSaleList(items);
    },
    async remove(id) {
      await removeRow("sales", id);
    }
  };

  const cashSessions: CashSessionRepository = {
    async list() {
      const rows = await listRows("cash_sessions");
      return rows.map(cashSessionFromRow);
    },
    async get(id) {
      const row = await getRow("cash_sessions", id);
      if (!row) return null;
      return cashSessionFromRowWithChildren(driver, companyId(), row);
    },
    async save(session) {
      const ctx = writeContext();
      const saved: LocalRow[] = [];
      await driver.transaction(async (tx) => {
        const rows = legacyBatches("cashSessions", session, ctx).cash_sessions ?? [];
        saved.push(...(await bumpAndPut(tx, "cash_sessions", rows, ctx)));
        const movements = Array.isArray(session.movements) ? session.movements : [];
        const movementRows = await bumpAndPut(
          tx,
          "cash_movements",
          movements.map((movement) => cashMovementRow(movement, session, ctx)),
          ctx
        );
        await retireMissingChildren(
          tx,
          "cash_movements",
          "session_id",
          session.id,
          new Set(movementRows.map((row) => row.id)),
          ctx
        );
      });
      return cashSessionFromRow(saved[0]);
    },
    async remove(id) {
      await removeRow("cash_sessions", id);
    }
  };

  const storeConfig: StoreConfigRepository = {
    async get() {
      const rows = await listRows("company_settings");
      const settings = rows.find((row) => row.id === companyId()) ?? rows[0] ?? null;
      const company = await driver.get<LocalRow>("companies", companyId());
      if (!settings && !company) return null;
      return storeConfigFromRow(settings, company);
    },
    async save(config) {
      const ctx = writeContext();
      const company = companyId();
      let saved: LocalRow | null = null;
      await driver.transaction(async (tx) => {
        const settings = await bumpAndPut(tx, "company_settings", companySettingRows(company, config, ctx), ctx);
        saved = settings[0];
        await bumpAndPut(tx, "companies", companyRows(company, config, ctx), ctx);
      });
      return storeConfigFromRow(saved, null);
    }
  };

  return { products, inventory, customers, suppliers, sales, cashSessions, storeConfig };
}

// ---------------------------------------------------------------------------
// lecturas de ruta caliente
// ---------------------------------------------------------------------------

/**
 * Lecturas para pantallas de arranque (POS, caja, reportes) que necesitan la
 * empresa explícita y un orden estable sin cargar todo el almacén. No lanzan
 * por tablas vacías: un almacén recién creado devuelve listas vacías.
 */
export interface HotReadOptions {
  companyId: string;
  limit?: number;
}

export interface StockBalanceReadOptions extends HotReadOptions {
  warehouseId?: string;
}

function requireReadCompany(companyId: unknown): string {
  const company = String(companyId ?? "").trim();
  if (!company) {
    throw new LocalDbError("invalid_row", "Las lecturas locales necesitan companyId");
  }
  return company;
}

/** Límite normalizado; `undefined` significa "sin límite". */
function readLimit(limit: unknown): number | undefined {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : undefined;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  return limit === undefined ? items : items.slice(0, limit);
}

async function queryLiveRows(
  driver: LocalDbDriver,
  table: LocalTable,
  companyId: string,
  extra: QueryFilter[] = []
): Promise<LocalRow[]> {
  return driver.query<LocalRow>({
    table,
    where: [{ field: "company_id", op: "eq", value: companyId }, ...extra]
  });
}

/** Productos por nombre y, a igual nombre, por id: orden estable entre motores. */
export async function listProducts(
  driver: LocalDbDriver,
  options: HotReadOptions
): Promise<Product[]> {
  const company = requireReadCompany(options?.companyId);
  const rows = await queryLiveRows(driver, "products", company);
  const items = rows
    .map(productFromRow)
    .sort(
      (left, right) =>
        String(left.name ?? "").localeCompare(String(right.name ?? "")) ||
        left.id.localeCompare(right.id)
    );
  return applyLimit(items, readLimit(options.limit));
}

/** Saldos por producto, almacén, variante e id; filtrable por almacén. */
export async function listStockBalances(
  driver: LocalDbDriver,
  options: StockBalanceReadOptions
): Promise<InventoryLevel[]> {
  const company = requireReadCompany(options?.companyId);
  const warehouseId = String(options?.warehouseId ?? "").trim();
  const extra: QueryFilter[] = warehouseId
    ? [{ field: "warehouse_id", op: "eq", value: warehouseId }]
    : [];
  const rows = await queryLiveRows(driver, "stock_balances", company, extra);
  const items = rows
    .map(inventoryFromRow)
    .sort(
      (left, right) =>
        left.productId.localeCompare(right.productId) ||
        String(left.warehouseId ?? "").localeCompare(String(right.warehouseId ?? "")) ||
        String(left.variantLabel ?? "").localeCompare(String(right.variantLabel ?? "")) ||
        String(left.id ?? "").localeCompare(String(right.id ?? ""))
    );
  return applyLimit(items, readLimit(options.limit));
}

/** Ventas más recientes primero; a igual fecha, por id ascendente. */
export async function listRecentSales(
  driver: LocalDbDriver,
  options: HotReadOptions
): Promise<Transaction[]> {
  const company = requireReadCompany(options?.companyId);
  const limit = readLimit(options?.limit);
  // Con límite, el orden y la cota se empujan al motor: sin esto la ventana de
  // 200 ventas copiaba y ordenaba las 50.000 (≈1,2 s en SQLite, medido).
  const rows =
    limit === undefined
      ? await queryLiveRows(driver, "sales", company)
      : await driver.query<LocalRow>({
          table: "sales",
          where: [{ field: "company_id", op: "eq", value: company }],
          orderBy: { field: "date", direction: "desc" },
          limit
        });
  const items = rows
    .map(transactionFromRow)
    .sort(
      (left, right) =>
        String(right.date ?? "").localeCompare(String(left.date ?? "")) ||
        left.id.localeCompare(right.id)
    );
  return applyLimit(items, limit);
}

/** Turnos de caja abiertos, el más reciente primero. */
export async function getOpenCashSessions(
  driver: LocalDbDriver,
  options: HotReadOptions
): Promise<CashRegisterSession[]> {
  const company = requireReadCompany(options?.companyId);
  const rows = await queryLiveRows(driver, "cash_sessions", company, [
    { field: "status", op: "eq", value: "open" }
  ]);
  const items = rows
    .map(cashSessionFromRow)
    .filter((session) => session.status === "open")
    .sort(
      (left, right) =>
        String(right.openedAt ?? "").localeCompare(String(left.openedAt ?? "")) ||
        left.id.localeCompare(right.id)
    );
  return applyLimit(items, readLimit(options.limit));
}
