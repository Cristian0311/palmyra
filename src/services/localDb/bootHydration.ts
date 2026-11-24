/**
 * Hidratación de la store desde el almacén local normalizado.
 *
 * El corte es reversible y apagado por defecto: sin VITE_LOCAL_DB_SOURCE=local
 * nada de esto toca la aplicación en el arranque. Cuando está activo, el
 * arranque lee el almacén (memory, IndexedDB o SQLite, siempre por el contrato)
 * y solo escribe la store si está vacía o si se fuerza con
 * VITE_LOCAL_DB_SOURCE_FORCE=1, de modo que nunca se pisa trabajo que el JSON
 * legado ya tenía.
 *
 * Este módulo también expone `refreshStoreFromLocalDb`, el puente del bucle del
 * hub LAN: hidrata el almacén, proyecta el diff a la store con
 * applyLocalSnapshotToStore (ver storeBridge) y publica el resultado en
 * `palmyra:localdb-source`. Con debounce de 500 ms, una ejecución a la vez y
 * kill switch VITE_LOCAL_DB_APPLY_REMOTE=0.
 *
 * Antes de aplicar el snapshot en modo `local` se comprueba la paridad con el
 * JSON legado vigente (parity.ts): si no cuadra se pide el rollback y la
 * hidratación no se aplica. Una marca de rollback activa desactiva el modo
 * `local` sin reiniciar la aplicación.
 *
 * Colecciones reconstruidas: productos, inventario, clientes, proveedores,
 * ventas, turnos de caja, sucursales, devoluciones, configuración de tienda
 * (solo de relleno: si la store ya tiene una, se respeta) y `currentBranchId`
 * cuando es inequívoco (única sucursal activa o única principal). Las
 * CATEGORÍAS no tienen tabla en el esquema v1: el JSON legado conserva nombre,
 * color y departamento, mientras el almacén solo guarda `category_id` en los
 * productos. No se pueden reconstruir fielmente y se dejan fuera a propósito
 * (no se toca `categories`).
 */
import type {
  Branch,
  CashRegisterSession,
  Customer,
  InventoryLevel,
  InventoryTransfer,
  Product,
  ReturnItem,
  StoreConfig,
  Supplier,
  Transaction
} from "../../types";
import type { LocalDbDriver, LocalRow, LocalTable } from "./contract";
import {
  getLocalDbSourceMode,
  isLocalDbSourceForced,
  type LocalDbSourceEnv,
  type LocalDbSourceMode
} from "./cutover";
import { getPalmyraLocalScope } from "../localScope";
import { readLocalStateStorage } from "../localStateStorage";
import { getRuntimeDriver } from "./runtimeDriver";
import {
  compareLocalDbWithLegacy,
  isLocalDbRollbackRequested,
  requestLocalDbRollback,
  type ParityReport
} from "./parity";
import {
  branchFromRow,
  cashSessionFromRowWithChildren,
  customerFromRow,
  inventoryFromRow,
  productFromRow,
  storeConfigFromRow,
  supplierFromRow,
  transactionFromRowWithChildren,
  transferFromRow
} from "./repositories";
import {
  applyLocalSnapshotToStore,
  isLocalDbRemoteApplyEnabled,
  returnFromRow,
  type BridgeStore,
  type SnapshotRowMeta,
  type StoreBridgeResult
} from "./storeBridge";

export { returnFromRow };

export const LOCAL_DB_SOURCE_EVENT = "palmyra:localdb-source";

/** Ventana de agrupación del refresco: varias páginas del hub, un solo render. */
export const REFRESH_DEBOUNCE_MS = 500;

/** Snapshot parcial con la misma forma que las colecciones de la store. */
export interface LocalDbSnapshot {
  products: Product[];
  inventory: InventoryLevel[];
  customers: Customer[];
  suppliers: Supplier[];
  transactions: Transaction[];
  cashSessions: CashRegisterSession[];
  branches: Branch[];
  /** Devoluciones: el mapeo es fila plana → ReturnItem (sin hijos propios). */
  returns: ReturnItem[];
  /** Traslados: una fila por línea (variantes adjuntas desde transfer_items). */
  transfers: InventoryTransfer[];
  storeConfig?: StoreConfig;
  /** Solo se rellena cuando la sucursal activa se puede deducir sin ambigüedad. */
  currentBranchId?: string;
  /**
   * Metadatos de sincronización por tabla e id (versión y updated_at). Es la
   * evidencia que usa el puente para decidir qué fila gana; sin ellos solo se
   * admiten altas.
   */
  sync?: Record<string, Record<string, SnapshotRowMeta>>;
  /** Ids con lápida explícita por tabla: único camino de borrado del puente. */
  deleted?: Record<string, string[]>;
}

export interface HydrateFromLocalDbOptions {
  /** Driver ya abierto; por defecto se usa el del runtime de la app. */
  driver?: LocalDbDriver;
}

export interface LocalDbSourceDiagnostics {
  kind: "init";
  mode: LocalDbSourceMode;
  applied: boolean;
  counts: Record<string, number>;
  reason?: string;
  /** Resultado del control de paridad JSON legado ↔ almacén, si se ejecutó. */
  parity?: ParityReport;
}

/** Resultado de una proyección del bucle LAN (evento palmyra:localdb-source). */
export interface LocalDbApplyDiagnostics extends StoreBridgeResult {
  kind: "refresh";
  reason: string;
}

export type LocalDbSourceEventDetail = LocalDbSourceDiagnostics | LocalDbApplyDiagnostics;

/**
 * Último resultado del arranque de la fuente local. Es exactamente el objeto
 * que se publica en `palmyra:localdb-source`; se conserva para que la interfaz
 * (p. ej. la recuperación guiada) pueda leerlo después del arranque sin
 * inventar telemetría nueva.
 */
let lastInitDiagnostics: LocalDbSourceDiagnostics | null = null;

/** Devuelve el último diagnóstico de `initLocalDbSource` o null si no corrió. */
export function getLastLocalDbSourceDiagnostics(): LocalDbSourceDiagnostics | null {
  return lastInitDiagnostics;
}

/** Mínimo que necesitamos de la store para decidir y aplicar la hidratación. */
export interface HydratableState {
  isInitialized?: boolean;
  products?: readonly unknown[];
  inventory?: readonly unknown[];
  customers?: readonly unknown[];
  suppliers?: readonly unknown[];
  transactions?: readonly unknown[];
  cashSessions?: readonly unknown[];
  transfers?: readonly unknown[];
  currentBranchId?: string;
}

export interface HydratableStore {
  getState(): HydratableState;
  setState(patch: Partial<LocalDbSnapshot>): void;
}

export interface InitLocalDbSourceOptions {
  companyId?: string;
  driver?: LocalDbDriver;
  store?: HydratableStore;
  /** Fuerza la escritura aunque la store tenga datos. */
  force?: boolean;
  /** Permite inyectar el entorno en pruebas; por defecto import.meta.env. */
  env?: LocalDbSourceEnv;
}

export interface RefreshStoreFromLocalDbOptions {
  /** Etiqueta del disparador (hub, visibilidad, manual): viaja en el evento. */
  reason?: string;
  driver?: LocalDbDriver;
  store?: BridgeStore | HydratableStore | null;
  env?: LocalDbSourceEnv;
  /** Dispositivo actual; se anota en la huella del puente. */
  deviceId?: string;
  now?: () => string;
}

const READY_POLL_MS = 100;
const READY_TIMEOUT_MS = 5_000;

const EMPTY_RESULT: StoreBridgeResult = { applied: 0, skipped: 0 };

function rowsOf(
  driver: LocalDbDriver,
  companyId: string,
  table: LocalTable
): Promise<LocalRow[]> {
  return driver.query<LocalRow>({
    table,
    where: [{ field: "company_id", op: "eq", value: companyId }],
    // Las lápidas se proyectan como borrado explícito, nunca por ausencia.
    includeDeleted: true
  });
}

function liveRows(rows: readonly LocalRow[]): LocalRow[] {
  return rows.filter((row) => !row.deleted_at);
}

/** Acumula metadatos (versión, updated_at, origen) y lápidas por tabla. */
function rememberRows(
  rows: readonly LocalRow[],
  table: LocalTable,
  meta: Record<string, Record<string, SnapshotRowMeta>>,
  deleted: Record<string, string[]>
): void {
  if (rows.length === 0) return;
  const tableMeta: Record<string, SnapshotRowMeta> = meta[table] ?? {};
  for (const row of rows) {
    const version = Number(row.version);
    tableMeta[row.id] = {
      version: Number.isFinite(version) && version > 0 ? version : 1,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
      ...(typeof row.origin_device === "string" ? { originDevice: row.origin_device } : {})
    };
    if (row.deleted_at) {
      const bucket = deleted[table] ?? [];
      bucket.push(row.id);
      deleted[table] = bucket;
    }
  }
  meta[table] = tableMeta;
}

function isSnapshotEmpty(snapshot: LocalDbSnapshot): boolean {
  return (
    snapshot.products.length === 0 &&
    snapshot.inventory.length === 0 &&
    snapshot.customers.length === 0 &&
    snapshot.suppliers.length === 0 &&
    snapshot.transactions.length === 0 &&
    snapshot.cashSessions.length === 0 &&
    snapshot.branches.length === 0 &&
    snapshot.returns.length === 0 &&
    snapshot.transfers.length === 0 &&
    !snapshot.storeConfig
  );
}

/**
 * Deduce la sucursal activa al hidratar solo cuando el mapeo es inequívoco:
 * la actual sigue existiendo, o hay una única sucursal activa, o una única
 * marcada como principal. En cualquier otro caso se respeta la store.
 */
export function resolveHydratedBranchId(
  currentBranchId: string | undefined,
  branches: readonly Branch[]
): string | undefined {
  if (!branches || branches.length === 0) return undefined;
  const ids = new Set(branches.map((branch) => branch?.id).filter(Boolean));
  if (currentBranchId && ids.has(currentBranchId)) return undefined;
  const active = branches.filter((branch) => branch?.isActive !== false);
  const pool = active.length > 0 ? active : branches;
  if (pool.length === 1) return pool[0].id;
  const mains = pool.filter((branch) => branch?.isMain === true);
  if (mains.length === 1) return mains[0].id;
  return undefined;
}

/**
 * Reconstruye las colecciones de la store desde el almacén local. Devuelve
 * null cuando no hay nada que hidratar o el almacén falla: el arranque sigue
 * con el JSON legado sin que el usuario pierda trabajo.
 */
export async function hydrateFromLocalDb(
  companyId: string,
  options: HydrateFromLocalDbOptions = {}
): Promise<LocalDbSnapshot | null> {
  const company = String(companyId ?? "").trim();
  if (!company) return null;

  try {
    const driver = options.driver ?? (await getRuntimeDriver());
    await driver.ready();

    const [
      productRows,
      stockRows,
      customerRows,
      supplierRows,
      saleRows,
      sessionRows,
      warehouseRows,
      settingsRows,
      returnRows,
      transferRows,
      transferItemRows
    ] = await Promise.all([
      rowsOf(driver, company, "products"),
      rowsOf(driver, company, "stock_balances"),
      rowsOf(driver, company, "customers"),
      rowsOf(driver, company, "suppliers"),
      rowsOf(driver, company, "sales"),
      rowsOf(driver, company, "cash_sessions"),
      rowsOf(driver, company, "warehouses"),
      rowsOf(driver, company, "company_settings"),
      rowsOf(driver, company, "returns"),
      rowsOf(driver, company, "transfers"),
      rowsOf(driver, company, "transfer_items")
    ]);

    const transactions = await Promise.all(
      liveRows(saleRows).map((row) => transactionFromRowWithChildren(driver, company, row))
    );
    const cashSessions = await Promise.all(
      liveRows(sessionRows).map((row) => cashSessionFromRowWithChildren(driver, company, row))
    );

    // Traslados: la fila padre es la línea del historial y transfer_items
    // guarda el desglose por variante. Las filas que la nube escribió sin
    // líneas (solo el padre) no pueden proyectar producto ni cantidad: se
    // omiten en lugar de inventar filas engañosas; el historial completo
    // llega por la autocuración del arranque cuando hay conexión.
    const itemsByParent = new Map<string, LocalRow[]>();
    for (const item of liveRows(transferItemRows)) {
      const parentId = typeof item.transfer_id === "string" ? item.transfer_id : "";
      if (!parentId) continue;
      const list = itemsByParent.get(parentId) || [];
      list.push(item);
      itemsByParent.set(parentId, list);
    }
    const transfers = liveRows(transferRows)
      .map((row) => {
        const children = itemsByParent.get(row.id) || [];
        // Un padre sin producto y sin hijos es una fila de la nube sin detalle.
        if (!row.product_id && children.length === 0) return null;
        const source =
          row.product_id || children.length === 0
            ? row
            : {
                ...row,
                product_id: children[0].product_id,
                product_name: children[0].product_name,
                quantity: children[0].quantity,
                variant_label: children[0].variant_label
              };
        const entity = transferFromRow(source);
        const variants = children
          .map((child) => ({
            variantLabel:
              typeof child.variant_label === "string"
                ? child.variant_label
                : typeof child.variantLabel === "string"
                  ? child.variantLabel
                  : "",
            quantity: Number(child.quantity) || 0
          }))
          .filter((entry) => entry.quantity > 0);
        if (variants.length > 0) entity.variants = variants;
        return entity;
      })
      .filter((row): row is InventoryTransfer => row !== null)
      .sort((a, b) => a.date.localeCompare(b.date));

    const companyRow = await driver.get<LocalRow>("companies", company);
    const hasConfigRow = settingsRows.length > 0 || Boolean(companyRow);
    const storeConfig = hasConfigRow
      ? storeConfigFromRow(liveRows(settingsRows)[0] ?? null, companyRow)
      : undefined;

    const sync: Record<string, Record<string, SnapshotRowMeta>> = {};
    const deleted: Record<string, string[]> = {};
    rememberRows(productRows, "products", sync, deleted);
    rememberRows(stockRows, "stock_balances", sync, deleted);
    rememberRows(customerRows, "customers", sync, deleted);
    rememberRows(supplierRows, "suppliers", sync, deleted);
    rememberRows(saleRows, "sales", sync, deleted);
    rememberRows(sessionRows, "cash_sessions", sync, deleted);
    rememberRows(warehouseRows, "warehouses", sync, deleted);
    rememberRows(returnRows, "returns", sync, deleted);
    rememberRows(transferRows, "transfers", sync, deleted);

    const branches = liveRows(warehouseRows).map(branchFromRow);
    const snapshot: LocalDbSnapshot = {
      products: liveRows(productRows).map(productFromRow),
      inventory: liveRows(stockRows).map(inventoryFromRow),
      customers: liveRows(customerRows).map(customerFromRow),
      suppliers: liveRows(supplierRows).map(supplierFromRow),
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
      cashSessions,
      branches,
      returns: liveRows(returnRows).map(returnFromRow),
      transfers,
      ...(storeConfig ? { storeConfig } : {}),
      ...(Object.keys(sync).length > 0 ? { sync } : {}),
      ...(Object.keys(deleted).length > 0 ? { deleted } : {})
    };

    // La sucursal activa solo se deduce cuando es inequívoca también aquí.
    const branchId = resolveHydratedBranchId(undefined, branches);
    if (branchId) snapshot.currentBranchId = branchId;

    return isSnapshotEmpty(snapshot) ? null : snapshot;
  } catch {
    // El almacén es un respaldo: un fallo de lectura no debe romper el arranque.
    return null;
  }
}

function countSnapshot(snapshot: LocalDbSnapshot): Record<string, number> {
  return {
    products: snapshot.products.length,
    inventory: snapshot.inventory.length,
    customers: snapshot.customers.length,
    suppliers: snapshot.suppliers.length,
    sales: snapshot.transactions.length,
    cashSessions: snapshot.cashSessions.length,
    branches: snapshot.branches.length,
    returns: snapshot.returns.length,
    transfers: snapshot.transfers.length,
    storeConfig: snapshot.storeConfig ? 1 : 0
  };
}

function storeHasData(state: HydratableState): boolean {
  return (
    (state.products?.length ?? 0) > 0 ||
    (state.inventory?.length ?? 0) > 0 ||
    (state.customers?.length ?? 0) > 0 ||
    (state.suppliers?.length ?? 0) > 0 ||
    (state.transactions?.length ?? 0) > 0 ||
    (state.cashSessions?.length ?? 0) > 0 ||
    (state.transfers?.length ?? 0) > 0
  );
}

/**
 * La rehidratación de Zustand es asíncrona (IndexedDB); escribir la store antes
 * de que termine dejaría que el snapshot legado pise lo hidratado. Se espera un
 * máximo acotado y, si no hay señal de inicialización, se continúa igual.
 */
async function waitForStoreReady(store: HydratableStore): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const state = store.getState();
    if (state.isInitialized !== false) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

async function loadStore(): Promise<HydratableStore | null> {
  try {
    // Importación diferida: la store importa medio dominio y no debe entrar en
    // el grafo de módulos del almacén (evita ciclos en el arranque).
    const module = await import("../../store/useStore");
    return module.useStore as unknown as HydratableStore;
  } catch {
    return null;
  }
}

function emitDiagnostics(detail: LocalDbSourceEventDetail): void {
  try {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(LOCAL_DB_SOURCE_EVENT, { detail }));
  } catch {
    // El evento es diagnóstico: si el entorno no lo soporta, no pasa nada.
  }
}

/** Dispositivo neutro para el plan esperado: la paridad no firma escrituras. */
const PARITY_ORIGIN_DEVICE = "local-db-parity";

/**
 * Control de paridad antes de aplicar el snapshot. Devuelve null cuando no hay
 * JSON legado en este dispositivo: sin fuente que contrastar no hay veredicto.
 */
async function checkLegacyParity(
  driver: LocalDbDriver,
  companyId: string
): Promise<ParityReport | null> {
  let raw: string | null = null;
  try {
    raw = await readLocalStateStorage();
  } catch {
    raw = null;
  }
  if (!raw) return null;
  return compareLocalDbWithLegacy({
    driver,
    state: raw,
    companyId,
    originDevice: PARITY_ORIGIN_DEVICE
  });
}

/**
 * Arranque de la fuente local. Nunca lanza; publica el resultado en
 * palmyra:localdb-source para poder diagnosticar desde la consola.
 */
export async function initLocalDbSource(
  options: InitLocalDbSourceOptions = {}
): Promise<LocalDbSourceDiagnostics> {
  const mode = getLocalDbSourceMode(options.env);
  const diagnostics: LocalDbSourceDiagnostics = { kind: "init", mode, applied: false, counts: {} };
  lastInitDiagnostics = null;

  try {
    if (mode !== "local") {
      diagnostics.reason = "modo sombra: el JSON legado sigue siendo la fuente";
    } else if (isLocalDbRollbackRequested()) {
      // La marca sobrevive al reinicio: hasta que se limpie, el corte no se repite.
      diagnostics.reason = "rollback solicitado: se continúa con el JSON legado (modo sombra)";
    } else {
      const companyId = String(
        options.companyId ?? getPalmyraLocalScope()?.companyId ?? ""
      ).trim();

      if (!companyId) {
        diagnostics.reason = "sin empresa activa para hidratar";
      } else {
        const driver = options.driver ?? (await getRuntimeDriver());
        const snapshot = await hydrateFromLocalDb(companyId, { driver });
        if (!snapshot) {
          diagnostics.reason = "almacén local vacío o ilegible";
        } else {
          diagnostics.counts = countSnapshot(snapshot);
          // El JSON legado manda: si el almacén no coincide con él, el corte no
          // está verificado y se vuelve a sombra sin tocar la store.
          const parity = await checkLegacyParity(driver, companyId);
          if (parity) diagnostics.parity = parity;
          if (parity && !parity.ok) {
            requestLocalDbRollback(
              `paridad fallida: ${parity.mismatches.slice(0, 3).join(" | ")}`
            );
            diagnostics.reason =
              "paridad JSON legado ↔ almacén fallida: rollback a sombra solicitado";
          } else {
            const store = options.store ?? (await loadStore());
            if (!store) {
              diagnostics.reason = "la store no está disponible";
            } else {
              await waitForStoreReady(store);
              const force = options.force ?? isLocalDbSourceForced(options.env);
              if (!force && storeHasData(store.getState())) {
                diagnostics.reason =
                  "la store ya tiene datos; use VITE_LOCAL_DB_SOURCE_FORCE=1 para forzar";
              } else {
                // La sucursal activa se conserva si sigue existiendo; solo se
                // reescribe cuando el snapshot la deja inequívoca. Los metadatos
                // del snapshot (sync/deleted) no forman parte del estado visible.
                const { sync: _sync, deleted: _deleted, currentBranchId: _ignored, ...base } = snapshot;
                const patch: Partial<LocalDbSnapshot> = { ...base };
                const current = store.getState().currentBranchId;
                const known = new Set(snapshot.branches.map((branch) => branch?.id).filter(Boolean));
                const branchId = resolveHydratedBranchId(current, snapshot.branches);
                if (current && known.has(current)) patch.currentBranchId = current;
                else if (branchId) patch.currentBranchId = branchId;
                store.setState(patch);
                diagnostics.applied = true;
              }
            }
          }
        }
      }
    }
  } catch (error) {
    diagnostics.reason =
      error instanceof Error ? error.message : "error inesperado al hidratar el almacén local";
  }

  lastInitDiagnostics = diagnostics;
  emitDiagnostics(diagnostics);
  return diagnostics;
}

// ---------------------------------------------------------------------------
// refresco desde el hub LAN: hidratar + proyectar el diff
// ---------------------------------------------------------------------------

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCompany = "";
let pendingOptions: RefreshStoreFromLocalDbOptions = {};
let pendingResolvers: Array<(result: StoreBridgeResult) => void> = [];
/** Cadena de ejecución: un refresco nunca se solapa con el anterior. */
let refreshChain: Promise<unknown> = Promise.resolve();

/** Limpia temporizador y cola pendientes; pensado para pruebas y logout. */
export function resetLocalDbRefreshForTests(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  pendingCompany = "";
  pendingOptions = {};
  pendingResolvers = [];
  refreshChain = Promise.resolve();
}

async function runRefresh(
  companyId: string,
  options: RefreshStoreFromLocalDbOptions
): Promise<StoreBridgeResult> {
  const reason = options.reason || "refresco-local";
  let snapshot: LocalDbSnapshot | null = null;
  try {
    snapshot = await hydrateFromLocalDb(companyId, { driver: options.driver });
  } catch {
    snapshot = null;
  }
  if (!snapshot) {
    const empty: StoreBridgeResult = { applied: 0, skipped: 0 };
    emitDiagnostics({ kind: "refresh", ...empty, reason: "almacén local vacío o ilegible" });
    return empty;
  }

  const result = applyLocalSnapshotToStore({
    store: (options.store ?? undefined) as BridgeStore | undefined,
    snapshot,
    companyId,
    originDevice: options.deviceId,
    onlyNewer: true,
    now: options.now ? options.now() : undefined,
    env: options.env
  });
  emitDiagnostics({ kind: "refresh", applied: result.applied, skipped: result.skipped, reason });
  return result;
}

function enqueueRefresh(
  companyId: string,
  options: RefreshStoreFromLocalDbOptions
): Promise<StoreBridgeResult> {
  const run = () => runRefresh(companyId, options);
  const task = refreshChain.then(run, run);
  refreshChain = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

/**
 * Hidrata el almacén y proyecta el diff a la store (puente del hub LAN).
 *
 * - Debounce de 500 ms: las páginas que llegan seguidas comparten un trabajo.
 * - Serializado: una ejecución a la vez; la siguiente espera a la anterior.
 * - Kill switch: VITE_LOCAL_DB_APPLY_REMOTE=0 lo apaga sin tocar nada más.
 * - Publica `palmyra:localdb-source` con `{ applied, skipped, reason }`.
 */
export function refreshStoreFromLocalDb(
  companyId: string,
  options: RefreshStoreFromLocalDbOptions = {}
): Promise<StoreBridgeResult> {
  const company = String(companyId ?? "").trim();
  if (!company || !isLocalDbRemoteApplyEnabled(options.env)) {
    return Promise.resolve(EMPTY_RESULT);
  }

  pendingCompany = company;
  pendingOptions = options;
  const promise = new Promise<StoreBridgeResult>((resolve) => {
    pendingResolvers.push(resolve);
  });

  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const target = pendingCompany;
    const resolvers = pendingResolvers;
    const jobOptions = pendingOptions;
    pendingCompany = "";
    pendingOptions = {};
    pendingResolvers = [];
    if (!target || resolvers.length === 0) return;
    void enqueueRefresh(target, jobOptions)
      .catch(() => EMPTY_RESULT)
      .then((result) => {
        for (const resolve of resolvers) resolve(result);
      });
  }, REFRESH_DEBOUNCE_MS);

  return promise;
}
