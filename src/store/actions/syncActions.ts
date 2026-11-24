import { Branch, Category, Product, InventoryLevel, CartItem, Transaction, ReturnItem, Currency, Customer, CashRegisterSession, User, PendingOrder, SalarySettlement, InventoryTransfer, Warranty, CashMovement, Supplier, SupplierOrder, InventoryAudit, FiscalConfig, DemandForecast, BankCard, BankTransaction } from '../../types';
import { generateId, generateReadableId } from '../../lib/utils';
import { 
  pullAllFromSupabase, pullPosBootstrapFromSupabase, pullBranchInventoryFromSupabase, pullBranchOperationalDataFromSupabase, pullGlobalCatalogDataFromSupabase, pullBankDataFromSupabase, pushProductToSupabase, 
  pushTransactionToSupabase, pushCashSessionToSupabase, pushWarrantyToSupabase, pushUserToSupabase, deleteUserFromSupabase, 
  SyncResult,
  pushBranchToSupabase, deleteBranchFromSupabase, pushCategoryToSupabase, deleteCategoryFromSupabase, deleteProductFromSupabase,
  pushCurrencyToSupabase, clearSupabaseData, pushBankCardToSupabase, updateBankCardMetadataToSupabase, setBankCardBalanceToSupabase, deleteBankCardFromSupabase, pushBankTransactionToSupabase, pushAllToSupabase,
  pushSupplierToSupabase, deleteSupplierFromSupabase, pushSupplierOrderToSupabase, pushCustomerToSupabase,
  applyInventoryAdjustmentToSupabase, reconcileInventoryToSupabase,
  pushReceiptConfigToSupabase, pushStoreConfigToSupabase, deleteTransactionFromSupabase, deleteCustomerFromSupabase, callReserveNCFRangeRPC, callTransferInventoryBulkRPC,
  deleteBankTransactionFromSupabase, clearSelectedDataFromSupabase, callOpenSessionRPCWithId, callProcessTransactionRPC, callVoidTransactionRPC, callCompleteReturnRPC, callTransferInventoryRPC, callReceiveSupplierOrderRPC, callStartInventoryAuditRPC, callSaveInventoryAuditCountRPC, callRequestInventoryAuditRecountRPC, callApproveInventoryAuditRPC, callCompleteInventoryAuditRPC, callCloseSessionRPC, callCancelSessionRPC, callDeleteBankInternalTransferRPC, callDeleteBankTransactionRPC, callDeleteBankCardRPC, callProcessBankTransactionRPC
} from '../../services/supabaseSync';
import { getSupabaseCredentials } from '../../lib/supabase';
import { loadSaaSContext, signInSaaSAccount, signOutSaaSAccount } from '../../services/saas';
import { getOfflineQueue, enqueueOfflineItem, removeFromOfflineQueue, waitForOfflineQueueReady } from '../../services/offlineQueue';
import { areSemanticallyEqual } from '../../utils/textUtils';
import { localStateStorage, clearLocalStateStorage, flushLocalStateStorage, readLocalStateStorage } from '../../services/localStateStorage';
import { getPalmyraScopedStorageKey, getPalmyraLocalScope } from '../../services/localScope';
import { setCanonicalInventoryQuantity, validateTransferStock } from '../utils/inventoryTransforms';
import { buildLocalVoidTransactionPatch } from '../utils/localVoidTransaction';
import { buildLocalCompletedSalePatch } from '../utils/localCompletedSale';
import { replaceRemoteRecords } from '../utils/replaceRemoteRecords';
import { calculateExpectedCashBase } from '../../services/cash/expectedCash';
import { removeFromOfflineQueueByAction, removeFromOfflineQueueByTransactionId } from '../../services/offlineQueue/outboxUtils';
import {
  getNcfDeviceId,
  loadNcfRanges,
  saveNcfRanges,
  invalidateNcfRange,
  withNcfLock,
  type LocalNcfRange,
} from '../../services/fiscal/ncfLocal';
import type { AppState } from '../storeTypes';
import { buildSupabaseSyncState } from '../utils/buildSupabaseSyncState';
import { mergeById, mergeUnique } from '../utils/syncMerges';
import {
  collectPendingCashSessionIds,
  collectPendingInventoryKeys,
  collectPendingTransactionIds,
  mergeBranchInventory,
  mergeBranchOperationalData
} from '../utils/offlineProtection';
import { readSyncLedger, recordSyncMoment } from '../../services/offline/syncLedger';
import { dedupeTransferRows, filterLocalTransfers, mergeTransferLists } from '../../services/localDb/repositories';
import {
  loadBootstrapData,
  pullSalesHistoryPage,
  HISTORY_PAGE_DEFAULT_LIMIT,
  type BootstrapReport,
} from '../../services/supabaseSync';


type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;

/** Ventana de gracia: repetir el arranque en este plazo no gasta red. */
export const BOOTSTRAP_COOLDOWN_MS = 10 * 60 * 1000;

let bootstrapInFlight: Promise<boolean> | null = null;
let historyCursor: string | null = null;
let historyExhausted = false;

/** Éxito del arranque POR EMPRESA: una empresa nunca valida la caché de otra. */
const bootstrapSuccessByCompany = new Map<string, number>();
/** Última empresa con la que se ejecutó el arranque (para detectar cambio de tenant). */
let bootstrapCompanyId = '';
/** Autocuración: como mucho una descarga completa por empresa y sesión. */
const selfHealDoneFor = new Set<string>();

export type BootstrapActionOptions = {
  force?: boolean;
  /** Inyección para pruebas: cliente y empresa sin red. */
  supabase?: any;
  tenant?: { companyId: string };
  now?: Date | string;
  /** Inyección para pruebas: estado de conexión. */
  isOnline?: () => boolean;
  /** Inyección para pruebas: snapshot persistido (JSON de zustand). */
  localSnapshot?: string | null;
  /** Inyección para pruebas: descarga completa de autocuración. */
  fullPull?: (companyId: string) => Promise<unknown>;
  /** Inyección para pruebas: historial de traslados de la autocuración. */
  transferHistoryPull?: (companyId: string) => Promise<{
    success: boolean;
    transfers: InventoryTransfer[];
  }>;
};

function isOnlineNow(options?: BootstrapActionOptions): boolean {
  try {
    if (options?.isOnline) return options.isOnline() !== false;
    return !(typeof navigator !== 'undefined' && navigator.onLine === false);
  } catch {
    return false;
  }
}

function lastPullMomentMs(companyId?: string): number {
  const ledger = readSyncLedger().lastPullAt;
  const parsed = ledger ? Date.parse(ledger) : NaN;
  const companyMoment = companyId ? bootstrapSuccessByCompany.get(companyId) || 0 : 0;
  return Math.max(companyMoment, Number.isFinite(parsed) ? parsed : 0);
}

function oldestTransactionIso(transactions: Transaction[]): string | null {
  let oldest: string | null = null;
  for (const tx of transactions || []) {
    const date = (tx as any)?.date;
    if (typeof date !== 'string' || !date) continue;
    if (!oldest || date < oldest) oldest = date;
  }
  return oldest;
}

function pendingIds(queue: { type: string; data?: any; actionId?: string }[], types: string[]): Set<string> {
  return new Set(
    queue
      .filter(i => types.includes(i.type))
      .map(i => String(i.data?.id ?? i.data?.operationId ?? i.actionId ?? ''))
      .filter(Boolean)
  );
}

/** ¿La sección remota llegó completa? Sin informe se asume que sí. */
export function sectionLoaded(report: BootstrapReport | undefined, key: string): boolean {
  if (!report?.sections) return true;
  const entry = report.sections[key];
  return !entry || entry.ok !== false;
}

function referencedBranchIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  if (state.currentBranchId) ids.add(String(state.currentBranchId));
  for (const item of state.inventory || []) if (item?.branchId) ids.add(String(item.branchId));
  for (const tx of state.transactions || []) if ((tx as any)?.branchId) ids.add(String((tx as any).branchId));
  for (const session of state.cashSessions || []) if ((session as any)?.branchId) ids.add(String((session as any).branchId));
  for (const transfer of state.transfers || []) {
    if ((transfer as any)?.fromBranchId) ids.add(String((transfer as any).fromBranchId));
    if ((transfer as any)?.toBranchId) ids.add(String((transfer as any).toBranchId));
  }
  return ids;
}

function referencedProductIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const item of state.inventory || []) if (item?.productId) ids.add(String(item.productId));
  const pushItems = (items: any) => {
    if (!Array.isArray(items)) return;
    for (const item of items) if (item?.productId) ids.add(String(item.productId));
  };
  for (const tx of state.transactions || []) pushItems((tx as any)?.items);
  for (const ret of state.returns || []) pushItems((ret as any)?.items);
  for (const order of state.supplierOrders || []) pushItems((order as any)?.items);
  for (const quote of state.quotes || []) pushItems((quote as any)?.items);
  return ids;
}

/**
 * Fusiona el arranque acotado con el estado local sin purgar historial:
 * lo que no entró en la ventana sigue disponible desde la caché del equipo.
 *
 * Con `report`, cada sección se reemplaza SOLO si su consulta remota terminó
 * bien. Una sección caída (red, RLS, presupuesto) conserva la caché local y
 * nunca se sobrescribe con `[]`.
 */
export function mergeBootstrapSnapshot(d: any, state: AppState, report?: BootstrapReport): Partial<AppState> {
  const queue = getOfflineQueue();
  const pendingTransactions = collectPendingTransactionIds(queue);
  const pendingSessions = collectPendingCashSessionIds(queue);
  const pendingInventoryKeys = collectPendingInventoryKeys(queue, {
    transactions: state.transactions || [],
    returns: state.returns || [],
    supplierOrders: state.supplierOrders || []
  });
  const loaded = (key: string) => sectionLoaded(report, key);

  const mergedTransactions = (() => {
    if (!loaded('sales')) return state.transactions || [];
    const map = new Map<string, Transaction>();
    for (const tx of state.transactions || []) map.set(String(tx.id), tx);
    for (const tx of d.transactions || []) {
      const key = String(tx.id);
      const local: any = map.get(key);
      const remoteId = local?.remoteId ? String(local.remoteId) : '';
      if (local && (local.offlinePending === true || pendingTransactions.has(key) || (remoteId && pendingTransactions.has(remoteId)))) continue;
      map.set(key, tx);
    }
    return Array.from(map.values());
  })();

  const mergedCashSessions = (() => {
    if (!loaded('cashSessions')) return state.cashSessions || [];
    const map = new Map<string, CashRegisterSession>();
    for (const session of state.cashSessions || []) map.set(String(session.id), session);
    for (const session of d.cashSessions || []) {
      const key = String(session.id);
      const local: any = map.get(key);
      // Un cierre local nunca se reabre por un snapshot retrasado.
      if (local && (pendingSessions.has(key) || (local.status === 'closed' && session.status === 'open'))) continue;
      map.set(key, session);
    }
    return Array.from(map.values());
  })();

  const mergedTransfers = (() => {
    if (!loaded('transfers')) return state.transfers || [];
    // Las filas remotas llegan UNA POR LÍNEA (id = id de línea, operationId =
    // uuid del traslado) mientras que las locales offline usan id = uuid.
    // Comparar id||operationId mezcla ambos espacios y deja convivir un
    // despacho local pendiente con su copia remota. La identidad de un
    // traslado es operationId || id: la fila local se conserva SOLO si la
    // nube no trae esa operación, y las remotas se desduplican por id para
    // absorber solapes de paginación.
    const remoteRows = dedupeTransferRows(d.transfers || []);
    return mergeTransferLists(remoteRows, state.transfers || []);
  })();

  const pendingBranchIds = pendingIds(queue, ['branch']);
  const pendingBranchDeleteIds = pendingIds(queue, ['branch_delete']);
  const pendingCategoryIds = pendingIds(queue, ['category']);
  const pendingCategoryDeleteIds = pendingIds(queue, ['category_delete']);
  const pendingProductIds = pendingIds(queue, ['product']);
  const pendingProductDeleteIds = pendingIds(queue, ['product_delete']);
  const pendingUserIds = pendingIds(queue, ['user']);
  const pendingUserDeleteIds = pendingIds(queue, ['user_delete']);
  const pendingCustomerIds = pendingIds(queue, ['customer_delete', 'customer']);
  const pendingCustomerDeleteIds = pendingIds(queue, ['customer_delete']);

  // Almacenes: se conservan los inactivos/archivados que ESTE equipo ya usa
  // (sucursal activa, inventario, ventas, turnos o traslados), para que una
  // bodega archivada en la nube no deje operaciones huérfanas.
  const branches = (() => {
    if (!loaded('warehouses')) return state.branches || [];
    const referenced = referencedBranchIds(state);
    const localIds = new Set((state.branches || []).map(b => b.id));
    const remoteRows = (d.branches || []).filter((b: any) =>
      b.isActive !== false || referenced.has(b.id) || localIds.has(b.id)
    );
    return replaceRemoteRecords(remoteRows, state.branches || [], pendingBranchIds)
      .filter(b => !pendingBranchDeleteIds.has(b.id));
  })();
  const validBranchIds = new Set(branches.map(b => b.id));
  const nextBranchId = state.currentBranchId && validBranchIds.has(state.currentBranchId)
    ? state.currentBranchId
    : (branches[0]?.id || state.currentBranchId);

  const users = (() => {
    if (!loaded('users')) return state.users || [];
    const merged = mergeById(d.users || [], state.users || [], pendingUserIds);
    const map = new Map(merged.map(u => [String(u.id), u]));
    for (const local of state.users || []) {
      if (pendingUserIds.has(String(local.id)) && !map.has(String(local.id))) map.set(String(local.id), local);
    }
    return Array.from(map.values()).filter(u => !pendingUserDeleteIds.has(String(u.id)));
  })();

  // Productos y categorías: los archivados/inactivos solo desaparecen de la UI
  // si nada local los referencia; una venta o un stock viejo conserva su fila.
  const products = (() => {
    if (!loaded('products')) return state.products || [];
    const localIds = new Set((state.products || []).map(p => p.id));
    const referenced = referencedProductIds(state);
    const remoteRows = (d.products || []).filter((p: any) =>
      p.status !== 'archived' || localIds.has(p.id) || referenced.has(p.id)
    );
    return replaceRemoteRecords(remoteRows, state.products || [], pendingProductIds)
      .filter(p => !pendingProductDeleteIds.has(p.id));
  })();
  const categories = (() => {
    if (!loaded('categories')) return state.categories || [];
    const referenced = new Set((state.products || []).map(p => String(p.categoryId || '')).filter(Boolean));
    for (const product of products) if (product.categoryId) referenced.add(String(product.categoryId));
    const localIds = new Set((state.categories || []).map(c => c.id));
    const remoteRows = (d.categories || []).filter((c: any) =>
      c.active !== false || localIds.has(c.id) || referenced.has(c.id)
    );
    return replaceRemoteRecords(remoteRows, state.categories || [], pendingCategoryIds)
      .filter(c => !pendingCategoryDeleteIds.has(c.id));
  })();
  const customers = loaded('customers')
    ? mergeById(d.customers || [], state.customers || [], pendingCustomerIds)
        .filter(c => !pendingCustomerDeleteIds.has(String(c.id)))
    : state.customers || [];

  return {
    branches,
    currentBranchId: nextBranchId,
    products,
    categories,
    users,
    customers,
    currencies: loaded('currencies') && Array.isArray(d.currencies) && d.currencies.length
      ? mergeUnique(d.currencies, state.currencies || [], { idKey: 'code' })
      : state.currencies,
    inventory: loaded('inventory')
      ? mergeBranchInventory(d.inventory, state.inventory || [], '', pendingInventoryKeys)
      : state.inventory,
    transactions: mergedTransactions,
    cashSessions: mergedCashSessions,
    transfers: mergedTransfers,
    bankCards: loaded('banks') ? mergeById(d.bankCards || [], state.bankCards || []) : state.bankCards,
    bankTransactions: loaded('banks') ? mergeById(d.bankTransactions || [], state.bankTransactions || []) : state.bankTransactions,
    suppliers: loaded('suppliers') ? mergeById(d.suppliers || [], state.suppliers || []) : state.suppliers,
    supplierOrders: loaded('suppliers') ? mergeById(d.supplierOrders || [], state.supplierOrders || []) : state.supplierOrders,
    returns: loaded('extras') ? mergeById(d.returns || [], state.returns || []) : state.returns,
    warranties: loaded('extras') ? mergeById(d.warranties || [], state.warranties || []) : state.warranties,
    quotes: loaded('extras') ? mergeById(d.quotes || [], state.quotes || []) : state.quotes,
    timeShifts: loaded('extras') ? mergeById(d.timeShifts || [], state.timeShifts || []) : state.timeShifts,
    salarySettlements: loaded('extras') ? mergeById(d.salarySettlements || [], state.salarySettlements || []) : state.salarySettlements,
    inventoryAudits: loaded('extras') ? mergeById(d.inventoryAudits || [], state.inventoryAudits || []) : state.inventoryAudits,
    storeConfig: loaded('settings') && d.storeConfig ? { ...state.storeConfig, ...d.storeConfig } : state.storeConfig,
    receiptConfig: loaded('settings') && d.receiptConfig ? { ...state.receiptConfig, ...d.receiptConfig } : state.receiptConfig,
    lastTurnNumber: Math.max(Number(state.lastTurnNumber) || 0, Number(d.lastTurnNumber) || 0),
  };
}

// --- Hidratación inmediata desde el snapshot local -------------------------

type SnapshotSections = Partial<Record<keyof AppState, any[]>>;

function parsePersistedSnapshot(raw: string | null | undefined): any | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.state ? parsed.state : parsed;
  } catch {
    return null;
  }
}

/**
 * Rellena SOLO secciones vacías con el snapshot persistido. La nube puede
 * tardar; al reabrir la app el usuario ve sus datos de inmediato y el pull
 * solo añade/actualiza después.
 */
export function hydrateStoreFromSnapshot(state: AppState, snapshot: any): Partial<AppState> | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const patch: Record<string, any[]> = {};
  const arrays: Array<keyof SnapshotSections> = [
    'branches', 'categories', 'products', 'customers', 'inventory', 'transactions',
    'cashSessions', 'transfers', 'bankCards', 'bankTransactions', 'suppliers',
    'supplierOrders', 'returns', 'warranties', 'quotes', 'timeShifts',
    'salarySettlements', 'inventoryAudits', 'users', 'currencies'
  ];
  for (const key of arrays) {
    const local = (state as any)[key];
    const cached = snapshot[key];
    if ((!Array.isArray(local) || local.length === 0) && Array.isArray(cached) && cached.length) {
      patch[key as string] = cached;
    }
  }
  const nextBranchId = !state.currentBranchId && typeof snapshot.currentBranchId === 'string'
    ? snapshot.currentBranchId
    : undefined;
  if (!Object.keys(patch).length && !nextBranchId) return null;
  return { ...(patch as Partial<AppState>), ...(nextBranchId ? { currentBranchId: nextBranchId } : {}) };
}

async function hydrateCachedState(
  set: StoreSet,
  get: StoreGet,
  companyId: string,
  options?: BootstrapActionOptions
): Promise<boolean> {
  try {
    const scope = getPalmyraLocalScope();
    // Una caché de OTRA empresa nunca hidrata este ámbito.
    if (scope?.companyId && scope.companyId !== companyId) {
      console.warn('[PALMYRA] Arranque: la copia local pertenece a otra empresa; se ignora la caché ajena.');
      return false;
    }
    const raw = options?.localSnapshot !== undefined ? options.localSnapshot : await readLocalStateStorage();
    const snapshot = parsePersistedSnapshot(raw);
    if (!snapshot) return false;
    let applied = false;
    set((state) => {
      const patch = hydrateStoreFromSnapshot(state, snapshot);
      if (!patch) return {};
      applied = true;
      return patch;
    });
    return applied;
  } catch (error) {
    console.warn('[PALMYRA] Arranque: no se pudo hidratar la copia local.', error);
    return false;
  }
}

async function resolveBootstrapCompanyId(options?: BootstrapActionOptions): Promise<string> {
  const provided = options?.tenant?.companyId?.trim();
  if (provided) return provided;
  const { getActiveTenant } = await import('../../services/tenant');
  const tenant = await getActiveTenant();
  return tenant?.companyId?.trim() || '';
}

/**
 * Autocuración: si el ámbito local quedó sin catálogo pero la nube sí tiene
 * filas, se fuerza UNA descarga completa (sin cursores incrementales).
 */
function needsFullCatalogPull(state: AppState, d: any, report: BootstrapReport): boolean {
  const remoteCount = (key: string) => (Array.isArray(d?.[key]) ? d[key].length : 0);
  const localCount = (key: keyof AppState) => (Array.isArray((state as any)[key]) ? (state as any)[key].length : 0);
  const remoteHasCatalog = remoteCount('products') > 0 || remoteCount('categories') > 0 || remoteCount('branches') > 0;
  if (!remoteHasCatalog) return false;
  return (
    (remoteCount('products') > 0 && localCount('products') === 0) ||
    (remoteCount('categories') > 0 && localCount('categories') === 0) ||
    (remoteCount('branches') > 0 && localCount('branches') === 0)
  );
}

async function requestFullCloudPull(companyId: string, options?: BootstrapActionOptions): Promise<boolean> {
  try {
    const runFull = options?.fullPull || (async (id: string) => {
      const engine = await import('../../services/cloudSync/pullEngine');
      return engine.requestFullCloudPull(id, 'bootstrap-self-heal');
    });
    const outcome: any = await runFull(companyId);
    if (outcome === false || outcome === null) {
      console.info('[PALMYRA] Autocuración: no hay motor de descarga completo activo; se reintentará en el próximo arranque.');
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[PALMYRA] Autocuración: la descarga completa falló.', error);
    return false;
  }
}

/**
 * Autocuración de traslados. La sección de traslados del arranque legado
 * aplica `status.not.in.(completed,cancelled)` sobre un enum que no tiene
 * esos valores (posted|cancelled|in_transit|received) y falla SIEMPRE con
 * 22P02, dejando el historial vacío aunque la nube tenga filas. Este camino
 * usa el pull sano de cloudSync (sin filtros de enum, con los estados
 * reales) y rellena el historial sin borrar trabajo local: las filas que la
 * nube no conoce (pendientes offline o caché antigua) se conservan.
 */
async function healTransferHistory(
  set: StoreSet,
  get: StoreGet,
  companyId: string,
  catalog: any,
  options?: BootstrapActionOptions
): Promise<void> {
  try {
    const runPull =
      options?.transferHistoryPull ||
      (async (id: string) => {
        const module = await import('../../services/cloudSync/transferHistory');
        // Reutiliza los nombres que el arranque ya trajo: 3 consultas menos.
        const productNames = new Map<string, string>();
        for (const p of Array.isArray(catalog?.products) ? catalog.products : []) {
          if (p?.id && typeof p.name === 'string') productNames.set(p.id, p.name);
        }
        const warehouseNames = new Map<string, string>();
        for (const b of Array.isArray(catalog?.branches) ? catalog.branches : []) {
          if (b?.id && typeof b.name === 'string') warehouseNames.set(b.id, b.name);
        }
        return module.pullTransferHistoryCorrected({
          tenant: { companyId: id },
          refs: { productNames, warehouseNames }
        });
      });
    const result = await runPull(companyId);
    if (!result || result.success !== true || !Array.isArray(result.transfers)) return;
    set((state) => {
      // Identidad operationId || id: un pendiente local cuya operación ya
      // llegó de la nube (misma operación, distinto id de fila) no debe
      // convivir con sus líneas remotas. Lo que la nube no conoce se conserva.
      return { transfers: mergeTransferLists(result.transfers, state.transfers || []) };
    });
  } catch {
    // Se conserva la copia local; la autocuración se reintenta en el próximo arranque.
  }
}

function buildBootstrapResult(report: BootstrapReport, data: any): SyncResult {
  const labels = Object.values(report.sections || {}).map(entry => entry.label);
  const failed = report.errors || [];
  if (!failed.length) {
    return {
      success: true,
      message: `Arranque: ${data.products?.length || 0} productos, ${data.branches?.length || 0} almacenes, ${data.categories?.length || 0} categorías.`,
      counts: {
        products: data.products?.length || 0,
        categories: data.categories?.length || 0,
        branches: data.branches?.length || 0,
        customers: data.customers?.length || 0,
        transactions: data.transactions?.length || 0,
        inventory: data.inventory?.length || 0,
      },
    };
  }
  const anyOk = (report.sections ? Object.values(report.sections) : []).some(entry => entry.ok);
  if (!anyOk) {
    // Nada llegó: se conserva TODO lo local y se informa el error real.
    return { success: false, message: failed[0].message, errors: failed.map(entry => `${entry.label}: ${entry.message}`) };
  }
  return {
    success: false,
    message: `Arranque parcial: ${failed.map(entry => entry.label).join(', ')} no se pudieron actualizar; se conserva la copia local.`,
    counts: {
      products: data.products?.length || 0,
      categories: data.categories?.length || 0,
      branches: data.branches?.length || 0,
      customers: data.customers?.length || 0,
      transactions: data.transactions?.length || 0,
      inventory: data.inventory?.length || 0,
      sections: labels.length,
    },
    errors: failed.map(entry => `${entry.label}: ${entry.message}`),
  };
}

async function runBootstrap(set: StoreSet, get: StoreGet, options?: BootstrapActionOptions): Promise<boolean> {
  const force = options?.force === true;
  if (!isOnlineNow(options)) {
    // Offline: se muestra la copia local y no se toca nada más.
    const offlineCompany = options?.tenant?.companyId || getPalmyraLocalScope()?.companyId || '';
    if (offlineCompany) await hydrateCachedState(set, get, offlineCompany, options);
    set({ syncResult: { success: false, message: 'Sin conexión: se muestra la copia local del equipo.' } });
    return false;
  }
  if (bootstrapInFlight) return bootstrapInFlight;

  const run = (async () => {
    try {
      // La empresa SIEMPRE se resuelve antes de pedir nada: sin ámbito no hay
      // arranque válido y nunca se cachea un snapshot vacío.
      const companyId = await resolveBootstrapCompanyId(options);
      if (!companyId) {
        set({ syncResult: { success: false, message: 'No se pudo resolver la empresa activa; se muestra la copia local.' } });
        return false;
      }
      if (bootstrapCompanyId && bootstrapCompanyId !== companyId) {
        // Cambio de empresa: los cursores y la ventana de gracia eran de otra.
        historyCursor = null;
        historyExhausted = false;
        console.info('[PALMYRA] Arranque: empresa activa cambiada; se descarta el estado de sincronización anterior.');
      }
      bootstrapCompanyId = companyId;

      // 1) Mostrar ya lo que hay en disco, sin esperar a la red.
      await hydrateCachedState(set, get, companyId, options);

      if (!force && Date.now() - lastPullMomentMs(companyId) < BOOTSTRAP_COOLDOWN_MS) return false;

      const before = get();
      const { data, report } = await loadBootstrapData({
        supabase: options?.supabase,
        tenant: { companyId },
        now: options?.now,
        includeSaasUser: options?.supabase ? false : undefined,
      });

      // 2) Reemplazar solo las secciones que llegaron completas.
      set((state) => ({
        ...mergeBootstrapSnapshot(data, state, report),
        syncResult: buildBootstrapResult(report, data),
        ...(report.ok ? { lastSyncTime: new Date().toISOString() } : {}),
      }));

      // 2b) Autocuración de traslados: la sección del arranque falla siempre
      // por el filtro de enum inválido del camino legado; si este equipo no
      // tiene historial (o la sección falló) se rellena por el camino sano.
      const transfersSectionOk =
        !report?.sections?.transfers || report.sections.transfers.ok !== false;
      if (!transfersSectionOk || (before.transfers || []).length === 0) {
        await healTransferHistory(set, get, companyId, data, options);
      }

      const anySection = Object.values(report.sections).some(entry => entry.ok);
      if (report.ok) {
        bootstrapSuccessByCompany.set(companyId, Date.now());
        historyCursor = null;
        historyExhausted = false;
        recordSyncMoment('pull');
      }

      // 3) Autocuración: ámbito local vacío + nube con filas → pull completo.
      if (needsFullCatalogPull(before, data, report) && !selfHealDoneFor.has(companyId)) {
        selfHealDoneFor.add(companyId);
        console.info(
          `[PALMYRA] Autocuración: el catálogo local de ${companyId} estaba vacío y la nube tiene ` +
          `${data.products?.length || 0} productos / ${data.categories?.length || 0} categorías / ${data.branches?.length || 0} almacenes. ` +
          'Se fuerza una descarga completa sin cursores.'
        );
        await requestFullCloudPull(companyId, options);
      }

      return report.ok || anySection;
    } catch (e: any) {
      // Un fallo de red no toca los datos locales: el POS sigue offline.
      set({ syncResult: { success: false, message: e?.message || 'No se pudo actualizar desde la nube' } });
      return false;
    } finally {
      bootstrapInFlight = null;
    }
  })();

  bootstrapInFlight = run;
  return run;
}


export function createSyncActions(set: StoreSet, get: StoreGet): any {
  return {
  refreshGlobalCatalogData: async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    try {
      const res = await pullGlobalCatalogDataFromSupabase();
      if (!res.success || !res.data) return false;
      const d: any = res.data;
      set((state) => {
        const queue = getOfflineQueue();
        const pendingStoreConfig = [...queue]
          .filter(i => i.type === 'store_config' && i.data && typeof i.data === 'object')
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .at(-1)?.data;
        const pendingBranchIds = new Set(queue.filter(i => i.type === 'branch').map(i => i.data?.id).filter(Boolean));
        const pendingProductIds = new Set(queue.filter(i => i.type === 'product').map(i => i.data?.id).filter(Boolean));
         const pendingProductDeleteIds = new Set(queue.filter(i => i.type === 'product_delete').map(i => i.data?.id).filter(Boolean));
        const pendingCategoryIds = new Set(queue.filter(i => i.type === 'category').map(i => i.data?.id).filter(Boolean));
        const pendingCategoryDeleteIds = new Set(queue.filter(i => i.type === 'category_delete').map(i => i.data?.id).filter(Boolean));
        const pendingBranchDeleteIds = new Set(queue.filter(i => i.type === 'branch_delete').map(i => i.data?.id).filter(Boolean));
        const pendingUserIds = new Set(queue.filter(i => i.type === 'user').map(i => i.data?.id).filter(Boolean));
        const pendingUserDeleteIds = new Set(queue.filter(i => i.type === 'user_delete').map(i => i.data?.id).filter(Boolean));
        const pendingCurrencyCodes = new Set(queue.filter(i => i.type === 'currency' || i.type === 'currency_rate').map(i => i.data?.code).filter(Boolean));
        const validProductIds = new Set((d.products || []).map((p: any) => p.id));
        const validCategoryIds = new Set((d.categories || []).map((x: any) => x.id));
        return {
          branches: replaceRemoteRecords(d.branches || [], state.branches || [], pendingBranchIds).filter(x => !pendingBranchDeleteIds.has(x.id)),
          categories: replaceRemoteRecords(d.categories || [], state.categories || [], pendingCategoryIds).filter(x => !pendingCategoryDeleteIds.has(x.id)),
          products: replaceRemoteRecords(d.products || [], state.products || [], pendingProductIds)
            .filter(x => !pendingProductDeleteIds.has(x.id) && (
              validProductIds.has(x.id) || pendingProductIds.has(x.id)
            )),
          users: replaceRemoteRecords(d.users || [], state.users || [], pendingUserIds).filter((u: any) => !pendingUserDeleteIds.has(u.id)),
          currencies: Array.isArray(d.currencies) && d.currencies.length
            ? (() => {
                const currencyMap = new Map<string, Currency>((state.currencies || []).map(currency => [currency.code, currency]));
                for (const currency of d.currencies as Currency[]) currencyMap.set(currency.code, currency);
                for (const currency of state.currencies || []) {
                  if (pendingCurrencyCodes.has(currency.code)) currencyMap.set(currency.code, currency);
                }
                return Array.from(currencyMap.values());
              })()
            : state.currencies,
          fiscalConfigs: Array.isArray(pendingStoreConfig?.fiscalConfigs)
            ? pendingStoreConfig.fiscalConfigs
            : (Array.isArray(d.settings?.store_config?.fiscalConfigs)
              ? d.settings.store_config.fiscalConfigs
              : state.fiscalConfigs),
          receiptConfig: d.settings?.receipt_config ? { ...state.receiptConfig, ...d.settings.receipt_config } : state.receiptConfig,
          storeConfig: pendingStoreConfig
            ? { ...state.storeConfig, ...(d.settings?.store_config || {}), ...pendingStoreConfig }
            : (d.settings?.store_config ? { ...state.storeConfig, ...d.settings.store_config } : state.storeConfig),
        };
      });
      return true;
    } catch {
      return false;
    }
  },

  refreshBranchOperationalData: async (options) => {
    const branchId = get().currentBranchId;
    if (!branchId || (typeof navigator !== 'undefined' && !navigator.onLine)) return false;
    try {
      const res = await pullBranchOperationalDataFromSupabase(branchId, options);
      if (!res.success) return false;
      // El mapeo legado convierte `posted` en 'completed' y rompe el flujo de
      // recepción en dos fases. Se reemplaza por el historial con estados
      // reales (reutilizando los nombres ya traídos); si falla, se conserva
      // el resultado legado sin perder el resto del refresco.
      let remoteTransfers: any[] = Array.isArray(res.transfers) ? res.transfers : [];
      try {
        const productNames = new Map<string, string>();
        const warehouseNames = new Map<string, string>();
        for (const t of remoteTransfers) {
          if (t?.productId && t.productName) productNames.set(t.productId, t.productName);
          if (t?.fromBranchId && t.fromBranchName) warehouseNames.set(t.fromBranchId, t.fromBranchName);
          if (t?.toBranchId && t.toBranchName) warehouseNames.set(t.toBranchId, t.toBranchName);
        }
        const module = await import('../../services/cloudSync/transferHistory');
        const corrected = await module.pullTransferHistoryCorrected({
          branchId,
          refs: { productNames, warehouseNames }
        });
        if (corrected.success) remoteTransfers = corrected.transfers;
      } catch {
        // Se sigue con las filas legadas: mejor historial con estados aproximados que ninguno.
      }
      // Entradas ya desduplicadas para mergeBranchOperationalData, que usa la
      // clave id||operationId: un pendiente local (id = uuid) y sus líneas
      // remotas (id = id de línea) compartirían operationId pero no clave, y
      // convivirían duplicadas. Las remotas se desduplican por id (solape de
      // páginas) y las locales cuya operación ya llegó se descartan.
      const canonicalTransfers = dedupeTransferRows(remoteTransfers);
      set((state) => {
        const keptLocalTransfers = filterLocalTransfers(state.transfers || [], canonicalTransfers);
        // Este refresco es deliberadamente parcial (ventas/sesiones/transferencias
        // recientes). Nunca debe borrar historial local antiguo solo porque no
        // entró en el límite de la consulta. Las operaciones que aún viven en la
        // cola durable conservan su versión local hasta que Supabase las confirme.
        const merged = mergeBranchOperationalData({
          remote: { ...res, transfers: canonicalTransfers },
          local: {
            inventory: state.inventory || [],
            transactions: state.transactions || [],
            cashSessions: state.cashSessions || [],
            transfers: keptLocalTransfers,
            returns: (state as any).returns || [],
            supplierOrders: (state as any).supplierOrders || []
          },
          branchId,
          queue: getOfflineQueue()
        });
        return {
          transactions: merged.transactions,
          cashSessions: merged.cashSessions,
          transfers: merged.transfers,
          inventory: merged.inventory
        };
      });
      recordSyncMoment('pull');
      return true;
    } catch {
      return false;
    }
  },

  refreshBranchInventory: async () => {
    const branchId = get().currentBranchId;
    if (!branchId || (typeof navigator !== 'undefined' && !navigator.onLine)) return false;
    try {
      const res = await pullBranchInventoryFromSupabase(branchId);
      if (!res.success) return false;
      const state = get();
      const pendingInventoryKeys = collectPendingInventoryKeys(getOfflineQueue(), {
        transactions: state.transactions || [],
        returns: (state as any).returns || [],
        supplierOrders: (state as any).supplierOrders || []
      });
      set({ inventory: mergeBranchInventory(res.inventory, state.inventory || [], branchId, pendingInventoryKeys) });
      recordSyncMoment('pull');
      return true;
    } catch {
      return false;
    }
  },

  bootstrapPosFromSupabase: async () => {
    // Antes descargaba todo el historial. Ahora usa el arranque acotado.
    return runBootstrap(set, get);
  },

  /**
   * Único arranque permitido: catálogo pequeño + ventana operativa reciente.
   * Nunca llama a syncWithSupabase ni descarga historial completo.
   */
  bootstrapCloudData: async (options?: BootstrapActionOptions) => {
    return runBootstrap(set, get, options);
  },

  /** Página siguiente de ventas antiguas (keyset por created_at), bajo demanda. */
  loadOlderSalesHistory: async (options?: { limit?: number }) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { added: 0, hasMore: !historyExhausted };
    }
    if (historyExhausted) return { added: 0, hasMore: false };
    const beforeIso = historyCursor || oldestTransactionIso(get().transactions || []);
    try {
      const page = await pullSalesHistoryPage({ beforeIso, limit: options?.limit ?? HISTORY_PAGE_DEFAULT_LIMIT });
      historyCursor = page.nextBefore || beforeIso;
      historyExhausted = !page.hasMore;
      if (!page.transactions.length) return { added: 0, hasMore: false };
      set((state) => {
        const protectedIds = collectPendingTransactionIds(getOfflineQueue());
        const map = new Map<string, Transaction>();
        for (const tx of state.transactions || []) map.set(String(tx.id), tx);
        for (const tx of page.transactions) {
          const key = String(tx.id);
          if (map.has(key) || protectedIds.has(key)) continue;
          map.set(key, tx);
        }
        return { transactions: Array.from(map.values()) };
      });
      return { added: page.transactions.length, hasMore: page.hasMore };
    } catch {
      return { added: 0, hasMore: !historyExhausted };
    }
  },


  syncWithSupabase: async () => {
    set({ isSyncing: true });
    try {
      const { data, result } = await pullAllFromSupabase();
      if (result.success && data) {
        set((state) => ({
          ...buildSupabaseSyncState(data, state),
          lastSyncTime: new Date().toISOString(),
          syncResult: result,
          isSyncing: false
        }));
      } else {
        set({ isSyncing: false, syncResult: result });
      }
      if (result.success) {
        recordSyncMoment('pull');
        get().reconcileBankBalances().catch(() => {});
      }
      return result;
    } catch (e: any) {
      const errRes: SyncResult = { success: false, message: e?.message || 'Error al sincronizar con Supabase' };
      set({ isSyncing: false, syncResult: errRes });
      return errRes;
    }
  },
  };
}