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
import { localStateStorage, clearLocalStateStorage, flushLocalStateStorage } from '../../services/localStateStorage';
import { getPalmyraScopedStorageKey } from '../../services/localScope';
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
  collectPendingTransferIds,
  mergeBranchInventory,
  mergeBranchOperationalData
} from '../utils/offlineProtection';
import { readSyncLedger, recordSyncMoment } from '../../services/offline/syncLedger';
import {
  loadBootstrapData,
  pullSalesHistoryPage,
  HISTORY_PAGE_DEFAULT_LIMIT,
} from '../../services/supabaseSync';


type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;

/** Ventana de gracia: repetir el arranque en este plazo no gasta red. */
export const BOOTSTRAP_COOLDOWN_MS = 10 * 60 * 1000;

let bootstrapInFlight: Promise<boolean> | null = null;
let lastBootstrapSuccessAt = 0;
let historyCursor: string | null = null;
let historyExhausted = false;

export type BootstrapActionOptions = {
  force?: boolean;
  /** Inyección para pruebas: cliente y empresa sin red. */
  supabase?: any;
  tenant?: { companyId: string };
  now?: Date | string;
};

function lastPullMomentMs(): number {
  const ledger = readSyncLedger().lastPullAt;
  const parsed = ledger ? Date.parse(ledger) : NaN;
  return Math.max(lastBootstrapSuccessAt, Number.isFinite(parsed) ? parsed : 0);
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

/**
 * Fusiona el arranque acotado con el estado local sin purgar historial:
 * lo que no entró en la ventana sigue disponible desde la caché del equipo.
 */
export function mergeBootstrapSnapshot(d: any, state: AppState): Partial<AppState> {
  const queue = getOfflineQueue();
  const pendingTransactions = collectPendingTransactionIds(queue);
  const pendingSessions = collectPendingCashSessionIds(queue);
  const pendingTransfers = collectPendingTransferIds(queue);
  const pendingInventoryKeys = collectPendingInventoryKeys(queue, {
    transactions: state.transactions || [],
    returns: state.returns || [],
    supplierOrders: state.supplierOrders || []
  });

  const mergedTransactions = (() => {
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
    const map = new Map<string, InventoryTransfer>();
    const keyOf = (item: any) => String(item?.id || item?.operationId || '');
    for (const transfer of state.transfers || []) map.set(keyOf(transfer), transfer);
    for (const transfer of d.transfers || []) {
      const key = keyOf(transfer);
      if (pendingTransfers.has(key) && map.has(key)) continue;
      map.set(key, transfer);
    }
    return Array.from(map.values());
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

  const branches = replaceRemoteRecords(d.branches || [], state.branches || [], pendingBranchIds)
    .filter(b => !pendingBranchDeleteIds.has(b.id));
  const validBranchIds = new Set(branches.map(b => b.id));
  const nextBranchId = state.currentBranchId && validBranchIds.has(state.currentBranchId)
    ? state.currentBranchId
    : (branches[0]?.id || state.currentBranchId);

  const users = (() => {
    const merged = mergeById(d.users || [], state.users || [], pendingUserIds);
    const map = new Map(merged.map(u => [String(u.id), u]));
    for (const local of state.users || []) {
      if (pendingUserIds.has(String(local.id)) && !map.has(String(local.id))) map.set(String(local.id), local);
    }
    return Array.from(map.values()).filter(u => !pendingUserDeleteIds.has(String(u.id)));
  })();

  const products = replaceRemoteRecords(d.products || [], state.products || [], pendingProductIds)
    .filter(p => !pendingProductDeleteIds.has(p.id));
  const categories = replaceRemoteRecords(d.categories || [], state.categories || [], pendingCategoryIds)
    .filter(c => !pendingCategoryDeleteIds.has(c.id));
  const customers = mergeById(d.customers || [], state.customers || [], pendingCustomerIds)
    .filter(c => !pendingCustomerDeleteIds.has(String(c.id)));

  return {
    branches,
    currentBranchId: nextBranchId,
    products,
    categories,
    users,
    customers,
    currencies: Array.isArray(d.currencies) && d.currencies.length
      ? mergeUnique(d.currencies, state.currencies || [], { idKey: 'code' })
      : state.currencies,
    inventory: mergeBranchInventory(d.inventory, state.inventory || [], '', pendingInventoryKeys),
    transactions: mergedTransactions,
    cashSessions: mergedCashSessions,
    transfers: mergedTransfers,
    bankCards: mergeById(d.bankCards || [], state.bankCards || []),
    bankTransactions: mergeById(d.bankTransactions || [], state.bankTransactions || []),
    suppliers: mergeById(d.suppliers || [], state.suppliers || []),
    supplierOrders: mergeById(d.supplierOrders || [], state.supplierOrders || []),
    returns: mergeById(d.returns || [], state.returns || []),
    warranties: mergeById(d.warranties || [], state.warranties || []),
    quotes: mergeById(d.quotes || [], state.quotes || []),
    timeShifts: mergeById(d.timeShifts || [], state.timeShifts || []),
    salarySettlements: mergeById(d.salarySettlements || [], state.salarySettlements || []),
    inventoryAudits: mergeById(d.inventoryAudits || [], state.inventoryAudits || []),
    storeConfig: d.storeConfig ? { ...state.storeConfig, ...d.storeConfig } : state.storeConfig,
    receiptConfig: d.receiptConfig ? { ...state.receiptConfig, ...d.receiptConfig } : state.receiptConfig,
    lastTurnNumber: Math.max(Number(state.lastTurnNumber) || 0, Number(d.lastTurnNumber) || 0),
  };
}

async function runBootstrap(set: StoreSet, get: StoreGet, options?: BootstrapActionOptions): Promise<boolean> {
  const force = options?.force === true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (bootstrapInFlight) return bootstrapInFlight;
  if (!force && Date.now() - lastPullMomentMs() < BOOTSTRAP_COOLDOWN_MS) return false;

  const run = (async () => {
    try {
      const { data } = await loadBootstrapData({
        supabase: options?.supabase,
        tenant: options?.tenant,
        now: options?.now,
        includeSaasUser: options?.supabase ? false : undefined,
      });
      set((state) => ({
        ...mergeBootstrapSnapshot(data, state),
        lastSyncTime: new Date().toISOString(),
        syncResult: { success: true, message: 'Arranque acotado: catálogo y actividad reciente.' }
      }));
      lastBootstrapSuccessAt = Date.now();
      historyCursor = null;
      historyExhausted = false;
      recordSyncMoment('pull');
      return true;
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
      set((state) => {
        // Este refresco es deliberadamente parcial (ventas/sesiones/transferencias
        // recientes). Nunca debe borrar historial local antiguo solo porque no
        // entró en el límite de la consulta. Las operaciones que aún viven en la
        // cola durable conservan su versión local hasta que Supabase las confirme.
        const merged = mergeBranchOperationalData({
          remote: res,
          local: {
            inventory: state.inventory || [],
            transactions: state.transactions || [],
            cashSessions: state.cashSessions || [],
            transfers: state.transfers || [],
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