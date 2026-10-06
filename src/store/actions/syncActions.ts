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


type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;

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
        const pendingCurrencyCodes = new Set(queue.filter(i => i.type === 'currency').map(i => i.data?.code).filter(Boolean));
        const validProductIds = new Set((d.products || []).map((p: any) => p.id));
        const validCategoryIds = new Set((d.categories || []).map((x: any) => x.id));
        return {
          branches: replaceRemoteRecords(d.branches || [], state.branches || [], pendingBranchIds).filter(x => !pendingBranchDeleteIds.has(x.id)),
          categories: replaceRemoteRecords(d.categories || [], state.categories || [], pendingCategoryIds).filter(x => !pendingCategoryDeleteIds.has(x.id)),
          products: replaceRemoteRecords(d.products || [], state.products || [], pendingProductIds).filter(x => !pendingProductDeleteIds.has(x.id)),
          users: replaceRemoteRecords(d.users || [], state.users || [], pendingUserIds),
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
        // entró en el límite de la consulta. Los IDs que sí llegan del servidor
        // reemplazan su versión local; el resto del historial permanece intacto.
        const txMap = new Map<string, Transaction>();
        for (const item of state.transactions || []) {
          txMap.set(item.id, item);
        }
        for (const item of res.transactions || []) txMap.set(item.id, item);

        const sessionMap = new Map<string, CashRegisterSession>();
        for (const item of state.cashSessions || []) {
          sessionMap.set(item.id, item);
        }
        for (const item of res.cashSessions || []) sessionMap.set(item.id, item);

        const transferMap = new Map<string, InventoryTransfer>();
        for (const item of state.transfers || []) {
          transferMap.set(item.id || item.operationId, item);
        }
        for (const item of res.transfers || []) transferMap.set(item.id || item.operationId, item);

        const invMap = new Map<string, InventoryLevel>();
        for (const item of state.inventory || []) {
          if (item.branchId !== branchId) invMap.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
        }
        for (const item of res.inventory || []) invMap.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
        return {
          transactions: Array.from(txMap.values()),
          cashSessions: Array.from(sessionMap.values()),
          transfers: Array.from(transferMap.values()),
          inventory: Array.from(invMap.values())
        };
      });
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
      const byKey = new Map<string, InventoryLevel>();
      for (const item of get().inventory || []) {
        if (item.branchId !== branchId) byKey.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
      }
      for (const item of res.inventory) byKey.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
      set({ inventory: Array.from(byKey.values()) });
      return true;
    } catch {
      return false;
    }
  },

  bootstrapPosFromSupabase: async () => {
    const branchId = get().currentBranchId;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    const res = await pullPosBootstrapFromSupabase(branchId);
    if (!res.success || !res.data) return false;
    const d = res.data;
    const queuedStoreConfig = [...getOfflineQueue()]
      .filter(i => i.type === 'store_config' && i.data && typeof i.data === 'object')
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .at(-1)?.data;
    const queueSnapshot = getOfflineQueue();
    const pendingBranchIds = new Set(queueSnapshot.filter(i => i.type === 'branch').map(i => i.data?.id).filter(Boolean));
    const pendingBranchDeleteIds = new Set(queueSnapshot.filter(i => i.type === 'branch_delete').map(i => i.data?.id).filter(Boolean));
    const pendingCategoryIds = new Set(queueSnapshot.filter(i => i.type === 'category').map(i => i.data?.id).filter(Boolean));
    const pendingCategoryDeleteIds = new Set(queueSnapshot.filter(i => i.type === 'category_delete').map(i => i.data?.id).filter(Boolean));
    const pendingProductIds = new Set(queueSnapshot.filter(i => i.type === 'product').map(i => i.data?.id).filter(Boolean));
    const pendingProductDeleteIds = new Set(queueSnapshot.filter(i => i.type === 'product_delete').map(i => i.data?.id).filter(Boolean));
    const pendingUserIds = new Set(queueSnapshot.filter(i => i.type === 'user').map(i => i.data?.id).filter(Boolean));
    const pendingCustomerIds = new Set(queueSnapshot.filter(i => i.type === 'customer').map(i => i.data?.id).filter(Boolean));

    set((state) => {
      // Never blank a branch because a reconnect pull returned zero rows.
      // Keep the last local branch snapshot until a non-empty authoritative
      // snapshot arrives; pending offline operations are then replayed normally.
      const hasBranchInventory = Array.isArray(d.inventory) && d.inventory.length > 0;
      const branchInv = hasBranchInventory ? d.inventory : (state.inventory || []).filter((item: InventoryLevel) => !branchId || item.branchId === branchId);
      const invMap = new Map<string, InventoryLevel>();
      for (const item of state.inventory || []) {
        if (branchId && item.branchId === branchId) continue;
        invMap.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
      }
      for (const item of branchInv) invMap.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
      return {
        branches: replaceRemoteRecords(d.branches || [], state.branches || [], pendingBranchIds).filter((b: any) => !pendingBranchDeleteIds.has(b.id)),
        categories: replaceRemoteRecords(d.categories || [], state.categories || [], pendingCategoryIds).filter((c: any) => !pendingCategoryDeleteIds.has(c.id)),
        products: replaceRemoteRecords(d.products || [], state.products || [], pendingProductIds).filter((p: any) => !pendingProductDeleteIds.has(p.id)),
        inventory: Array.from(invMap.values()),
        users: replaceRemoteRecords(d.users || [], state.users || [], pendingUserIds),
        customers: replaceRemoteRecords(d.customers || [], state.customers || [], pendingCustomerIds),
        currencies: d.currencies?.length ? d.currencies : state.currencies,
        fiscalConfigs: Array.isArray(queuedStoreConfig?.fiscalConfigs)
          ? queuedStoreConfig.fiscalConfigs
          : (Array.isArray(d.settings?.store_config?.fiscalConfigs) ? d.settings.store_config.fiscalConfigs : state.fiscalConfigs),
        storeConfig: queuedStoreConfig
          ? { ...state.storeConfig, ...(d.settings?.store_config || {}), ...queuedStoreConfig }
          : (d.settings?.store_config ? { ...state.storeConfig, ...d.settings.store_config } : state.storeConfig),
        receiptConfig: d.settings?.receipt_config
          ? { ...state.receiptConfig, ...d.settings.receipt_config }
          : state.receiptConfig,
        transactions: (() => {
          const pending = new Set(getOfflineQueue().filter(i => i.type === 'transaction' || i.type === 'void_transaction').map(i => String(i.data?.id || i.actionId)));
          const map = new Map<string, Transaction>();
          for (const item of state.transactions || []) {
            if (item.branchId !== branchId || pending.has(String(item.id)) || item.offlinePending === true) map.set(item.id, item);
          }
          for (const item of d.transactions || []) map.set(item.id, item);
          return Array.from(map.values());
        })(),
        cashSessions: (() => {
          const pending = new Set(getOfflineQueue().filter(i => i.type === 'cash_session').map(i => String(i.data?.id || i.actionId)));
          const map = new Map<string, CashRegisterSession>();
          for (const item of state.cashSessions || []) {
            if (item.branchId !== branchId || pending.has(String(item.id))) map.set(item.id, item);
          }
          for (const item of d.cashSessions || []) map.set(item.id, item);
          return Array.from(map.values());
        })(),
        transfers: (() => {
          const pending = new Set<string>();
          for (const q of getOfflineQueue()) {
            if (q.type === 'transfer') {
              pending.add(String(q.data?.id || q.data?.operationId || q.actionId));
            } else if (q.type === 'transfer_bulk') {
              for (const op of Array.isArray(q.data?.items) ? q.data.items : []) {
                if (op?.operationId) pending.add(String(op.operationId));
              }
            }
          }
          const map = new Map<string, InventoryTransfer>();
          const belongsToBranch = (item: any) => item.branchId === branchId || item.fromBranchId === branchId || item.toBranchId === branchId;
          for (const item of state.transfers || []) {
            if (!belongsToBranch(item) || pending.has(String(item.id || item.operationId))) map.set(item.id || item.operationId, item);
          }
          for (const item of d.transfers || []) map.set(item.id || item.operationId, item);
          return Array.from(map.values());
        })(),
        bankCards: mergeById(d.bankCards, state.bankCards || []),
        bankTransactions: mergeById(d.bankTransactions, state.bankTransactions || []),
        lastSyncTime: new Date().toISOString(),
        syncResult: { success: true, message: 'Caché POS actualizado de forma incremental.' }
      };
    });
    return true;
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