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
import { normalizeSemanticText, areSemanticallyEqual } from '../../utils/textUtils';
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
        const mergeById = <T extends { id: string }>(
          remote: T[],
          local: T[],
          protectedIds: Set<string | number> = new Set()
        ) => {
          const localMap = new Map(local.map(x => [x.id, x]));
          const map = new Map(remote.map(x => [x.id, x]));
          for (const [id, item] of localMap) {
            if (!map.has(id) || protectedIds.has(id)) map.set(id, item);
          }
          return Array.from(map.values());
        };
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
          branches: mergeById(d.branches || [], state.branches || [], pendingBranchIds).filter(x => !pendingBranchDeleteIds.has(x.id)),
          categories: mergeById(d.categories || [], state.categories || [], pendingCategoryIds).filter(x => !pendingCategoryDeleteIds.has(x.id) && (validCategoryIds.has(x.id) || pendingCategoryIds.has(x.id))),
          products: mergeById(d.products || [], state.products || [], pendingProductIds).filter(x => !pendingProductDeleteIds.has(x.id) && (validProductIds.has(x.id) || pendingProductIds.has(x.id))),
          users: mergeById(d.users || [], state.users || [], pendingUserIds),
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
    set((state) => {
      const mergeById = <T extends { id: string }>(remote: T[] | undefined, local: T[]) => {
        const map = new Map(local.map(x => [x.id, x]));
        for (const item of remote || []) map.set(item.id, item);
        return Array.from(map.values());
      };
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
        branches: mergeById(d.branches, state.branches || []),
        categories: mergeById(d.categories, state.categories || []),
        products: mergeById(d.products, state.products || []).filter((p: any) => !new Set(getOfflineQueue().filter(i => i.type === 'product_delete').map(i => i.data?.id).filter(Boolean)).has(p.id)),
        inventory: Array.from(invMap.values()),
        users: mergeById(d.users, state.users || []),
        customers: mergeById(d.customers, state.customers || []),
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
        set((state) => {
          // Helper para deduplicar arrays por ID o clave personalizada
          // AHORA ES ADITIVO: No descarta datos locales que no están en Supabase, 
          // simplemente prioriza Supabase para los conflictos de ID.
          const mergeUnique = <T extends Record<string, any>>(supabaseData: T[] | undefined, localData: T[], options?: { offlineIds?: Set<string | number>, semanticDedupe?: boolean, idKey?: string, semanticKeys?: string[] }): T[] => {
            const idKey = options?.idKey || 'id';
            const semanticKeys = options?.semanticKeys || (options?.semanticDedupe ? ['name'] : []);
            const map = new Map<string | number, T>();
            const semanticMap = new Map<string, string | number>(); 
            
            const getSemanticKey = (item: T): string | null => {
              if (semanticKeys.length === 0) return null;
              const values = semanticKeys.map(k => normalizeSemanticText(String(item[k] || ''))).filter(Boolean);
              return values.length > 0 ? values.join('::') : null;
            };

            // 1. Cargar TODOS los datos locales primero
            localData.forEach(item => {
              const sKey = getSemanticKey(item);
              if (sKey) {
                semanticMap.set(sKey, item[idKey]);
              }
              map.set(item[idKey], item);
            });
            
            // 2. Sobrescribir con datos de Supabase (la fuente de verdad principal)
            if (supabaseData) {
              supabaseData.forEach(item => {
                const sKey = getSemanticKey(item);
                if (sKey) {
                  const existingId = semanticMap.get(sKey);
                  if (existingId && existingId !== item[idKey]) {
                    map.delete(existingId);
                  }
                  semanticMap.set(sKey, item[idKey]);
                }
                
                // Si es una sesión de caja y localmente ya fue cerrada pero en la nube está abierta, preservar el estado cerrado
                if (item.status === 'open') {
                  const localItem = map.get(item[idKey]);
                  if (localItem && localItem.status === 'closed') {
                    map.set(item[idKey], {
                      ...item,
                      status: 'closed',
                      closedAt: localItem.closedAt || item.closed_at || new Date().toISOString(),
                      closingDate: localItem.closingDate || localItem.closedAt,
                      closingBalances: localItem.closingBalances || []
                    });
                    return;
                  }
                }

                map.set(item[idKey], item);
              });
            }
            
            return Array.from(map.values());
          };

          // --- 1. Sucursales ---
          const offlineQueueSnapshot = getOfflineQueue();
          const offlineQueuedBranchItems = offlineQueueSnapshot.filter(i => i.type === 'branch');
          const offlineQueuedBranchIds = new Set(offlineQueuedBranchItems.map(i => i.data.id));
          const offlineDeletedBranchIds = new Set(offlineQueueSnapshot.filter(i => i.type === 'branch_delete').map(i => i.data?.id).filter(Boolean));
          
          const mergedBranches = mergeUnique(data.branches, state.branches || [], { offlineIds: offlineQueuedBranchIds });
          
          // Purge: Si recibimos datos de Supabase, eliminar locales que no estén en Supabase Y no estén en la cola offline
          const finalBranches = (data.branches && data.branches.length > 0)
            ? mergedBranches.filter(b =>
                !offlineDeletedBranchIds.has(b.id) &&
                (data.branches.some((sb: any) => sb.id === b.id) ||
                offlineQueuedBranchIds.has(b.id))
              )
            : mergedBranches.filter(b => !offlineDeletedBranchIds.has(b.id));

          const validBranchIds = new Set(finalBranches.map(b => b.id));

          let nextBranchId = state.currentBranchId;
          if (!nextBranchId || !validBranchIds.has(nextBranchId)) {
            nextBranchId = finalBranches[0]?.id || '';
          }

          // --- 2. Transacciones ---
          const offlineQueuedTxIds = new Set(
            getOfflineQueue().filter(i => i.type === 'transaction' || i.type === 'void_transaction').map(i => i.data.id)
          );
          const offlinePendingTxIds = new Set(
            (state.transactions || []).filter((tx: any) => tx.offlinePending === true).map((tx: any) => tx.id)
          );
          const mergedTransactionsRaw = replaceRemoteRecords(
            data.transactions,
            state.transactions || [],
            new Set([...offlineQueuedTxIds, ...offlinePendingTxIds])
          );
          // Nunca purgar una venta local únicamente porque una lectura remota
          // todavía no la devuelve. Entre commits/realtime/reconexiones puede
          // existir una ventana de consistencia y esa purga era precisamente la
          // causa de que un ticket apareciera en Reportes y luego desapareciera.
          // Supabase sigue siendo la autoridad: cuando llega el mismo ID remoto,
          // mergeUnique lo reemplaza con la versión del servidor.
          const mergedTransactions = mergedTransactionsRaw;

          // --- 3. Sesiones ---
          const offlineQueuedSessionIds = new Set(
            getOfflineQueue().filter(i => i.type === 'cash_session').map(i => i.data.id)
          );
          const mergedCashSessionsRaw = replaceRemoteRecords(data.cashSessions, state.cashSessions || [], offlineQueuedSessionIds);
          const mergedCashSessions = Array.isArray(data.cashSessions) && data.cashSessions.length > 0
            ? mergedCashSessionsRaw.filter(cs => data.cashSessions.some((ss: any) => ss.id === cs.id) || offlineQueuedSessionIds.has(cs.id))
            : mergedCashSessionsRaw;

          // --- 4. Clientes ---
          const customerQueue = getOfflineQueue();
          const offlineQueuedCustomerIds = new Set(
            customerQueue
              .filter(i => i.type === 'customer' || i.type === 'customer_delete')
              .map(i => i.data?.id)
              .filter(Boolean)
          );
          const offlineDeletedCustomerIds = new Set(
            customerQueue
              .filter(i => i.type === 'customer_delete')
              .map(i => String(i.data?.id || ''))
              .filter(Boolean)
          );
          const mergedCustomers = replaceRemoteRecords(data.customers, state.customers || [], offlineQueuedCustomerIds)
            .filter(customer => !offlineDeletedCustomerIds.has(String(customer.id)));

          // --- 5. Devoluciones ---
          const offlineQueuedReturnIds = new Set(
            getOfflineQueue().filter(i => i.type === 'return' || i.type === 'return_complete').map(i => i.data.id)
          );
          const mergedReturnsRaw = replaceRemoteRecords(data.returns, state.returns || [], offlineQueuedReturnIds);
          const mergedReturns = Array.isArray(data.returns) && data.returns.length > 0
            ? mergedReturnsRaw.filter(r => data.returns.some((sr: any) => sr.id === r.id) || offlineQueuedReturnIds.has(r.id))
            : mergedReturnsRaw;

          // --- 6. Inventario (Deduplicación por combinación única) ---
          // An empty inventory response during reconnect is not authoritative:
          // keep the last local snapshot instead of blanking the POS.
          const hasRemoteInventory = Array.isArray(data.inventory) && data.inventory.length > 0;
          const baseInv = hasRemoteInventory ? data.inventory : (state.inventory || []);
          const invMap = new Map<string, InventoryLevel>();
          baseInv.forEach(inv => {
            const key = `${inv.productId}_${inv.branchId}_${inv.variantLabel || ''}`;
            invMap.set(key, inv);
          });

          // Si una operación de inventario sigue en la cola, su valor local es el
          // estado que todavía no está confirmado por Supabase. Conservamos esa fila
          // durante el merge para evitar que un snapshot remoto anterior la revierta.
          const pendingInventoryKeys = new Set<string>();
          getOfflineQueue().forEach(i => {
            const d = i.data || {};

            if (i.type === 'inventory_adjustment' || i.type === 'inventory_reconcile' || i.type === 'inventory') {
              pendingInventoryKeys.add(`${d.productId}_${d.branchId}_${d.variantLabel || ''}`);
              return;
            }

            if (i.type === 'transaction') {
              const branchId = d.branchId;
              for (const saleItem of Array.isArray(d.items) ? d.items : []) {
                const product = typeof saleItem?.product === 'string' ? saleItem.product : saleItem?.product?.id;
                if (!product || !branchId) continue;
                const label = saleItem?.variantLabel || saleItem?.variant_label || '';
                pendingInventoryKeys.add(`${product}_${branchId}_${label}`);
                const components = typeof saleItem?.product === 'object'
                  ? (saleItem.product?.kitComponents || saleItem.product?.kitItems || [])
                  : [];
                for (const component of Array.isArray(components) ? components : []) {
                  if (component?.productId) {
                    pendingInventoryKeys.add(`${component.productId}_${branchId}_`);
                  }
                }
              }
              return;
            }

            if (i.type === 'transfer' || i.type === 'transfer_bulk') {
              const operations = i.type === 'transfer'
                ? [{ productId: d.productId, variants: d.variants }]
                : (Array.isArray(d.items) ? d.items : []);
              for (const op of operations) {
                const productId = op?.productId;
                for (const v of Array.isArray(op?.variants) ? op.variants : []) {
                  const label = v?.variantLabel ?? v?.variant_label ?? '';
                  if (!productId) continue;
                  pendingInventoryKeys.add(`${productId}_${d.fromBranchId}_${label}`);
                  pendingInventoryKeys.add(`${productId}_${d.toBranchId}_${label}`);
                }
              }
              return;
            }

            if (i.type === 'return' || i.type === 'return_complete') {
              const req = i.type === 'return'
                ? d
                : (state.returns || []).find((r: any) => r.id === d.id);
              if (!req) return;
              const originalTx = (state.transactions || []).find((tx: any) => tx.id === req.transactionId);
              const branchId = req.branchId || originalTx?.branchId;
              if (!branchId) return;
              const label = req.variantLabel || '';
              if (req.type === 'refund') {
                pendingInventoryKeys.add(`${req.productId}_${branchId}_${label}`);
              }
              if (req.type === 'warranty_exchange' && req.replacementProductId) {
                pendingInventoryKeys.add(`${req.replacementProductId}_${branchId}_`);
              }
              return;
            }

            if (i.type === 'supplier_receive') {
              const order = (state.supplierOrders || []).find((o: any) => o.id === d.id);
              for (const item of Array.isArray(order?.items) ? order.items : []) {
                pendingInventoryKeys.add(`${item.productId}_${order.branchId}_${item.variantLabel || ''}`);
              }
            }
          });

          // Si una operación todavía está pendiente, su snapshot local ya
          // incluye el movimiento optimista. No basta con conservar la fila:
          // debemos conservar también SU CANTIDAD para que un pull remoto
          // retrasado no haga retroceder visualmente el inventario.
          const localInventoryByKey = new Map<string, InventoryLevel>();
          for (const localInv of state.inventory || []) {
            const key = `${localInv.productId}_${localInv.branchId}_${localInv.variantLabel || ''}`;
            if (pendingInventoryKeys.has(key)) localInventoryByKey.set(key, localInv);
          }
          for (const [key, localInv] of localInventoryByKey) {
            invMap.set(key, localInv);
          }

          let mergedInventory = Array.from(invMap.values()).filter(inv =>
            !inv.branchId || validBranchIds.has(inv.branchId)
          );
          if (data.inventory && data.inventory.length > 0) {
            const supabaseInvKeys = new Set(
              data.inventory.map((si: any) =>
                `${si.product_id || si.productId}_${si.branch_id || si.branchId}_${si.variant_label || si.variantLabel || ''}`
              )
            );
            mergedInventory = mergedInventory.filter(inv => {
              const key = `${inv.productId}_${inv.branchId}_${inv.variantLabel || ''}`;
              return supabaseInvKeys.has(key) || pendingInventoryKeys.has(key);
            });
          }

          // --- 7. Otros (Deduplicación simple por ID o clave única) ---
          const pendingProductIds = new Set(getOfflineQueue().filter(i => i.type === 'product').map(i => i.data?.id).filter(Boolean));
           const pendingProductDeleteIds = new Set(getOfflineQueue().filter(i => i.type === 'product_delete').map(i => i.data?.id).filter(Boolean));
          const pendingCategoryIds = new Set(getOfflineQueue().filter(i => i.type === 'category').map(i => i.data?.id).filter(Boolean));
          const pendingCategoryDeleteIds = new Set(getOfflineQueue().filter(i => i.type === 'category_delete').map(i => i.data?.id).filter(Boolean));
          const mergedProducts = mergeUnique(data.products, state.products || []);
          // A successful remote snapshot may omit a newly-created offline product.
          // Keep it until its durable product operation is confirmed remotely.
          const finalProducts = (Array.isArray(data.products) && data.products.length > 0)
            ? mergedProducts.filter(p => !pendingProductDeleteIds.has(p.id) && (data.products.some((sp: any) => sp.id === p.id) || pendingProductIds.has(p.id)))
            : mergedProducts;

          const mergedCategories = mergeUnique(data.categories, state.categories || []);
          const finalCategories = (Array.isArray(data.categories) && data.categories.length > 0)
            ? mergedCategories.filter(c => !pendingCategoryDeleteIds.has(c.id) && (data.categories.some((sc: any) => sc.id === c.id) || pendingCategoryIds.has(c.id)))
            : mergedCategories.filter(c => !pendingCategoryDeleteIds.has(c.id));

          const pendingUserIds = new Set(getOfflineQueue().filter(i => i.type === 'user').map(i => String(i.data?.id || i.actionId)));
          const mergedUsers = mergeUnique(data.users, state.users || []);
          // Conservar también usuarios creados/editados offline hasta que su
          // operación durable sea confirmada por Supabase.
          const finalUsers = (Array.isArray(data.users) && data.users.length > 0)
            ? mergedUsers.filter(u =>
                data.users.some((su: any) => su.id === u.id) ||
                pendingUserIds.has(String(u.id)) ||
                u.id.startsWith('admin-') ||
                u.id.startsWith('employee-')
              )
            : mergedUsers;

          const mergedBankCards = replaceRemoteRecords(data.bankCards, state.bankCards || [], new Set(getOfflineQueue().filter(i => i.type === 'bank_card').map(i => String(i.data?.id || i.actionId))));
          const mergedBankTransactions = replaceRemoteRecords(data.bankTransactions, state.bankTransactions || [], new Set(getOfflineQueue().filter(i => i.type === 'bank_transaction' || i.type === 'bank_transaction_delete' || i.type === 'bank_internal_transfer_delete').map(i => String(i.data?.id || i.data?.operationId || i.actionId))));
          const supplierQueue = getOfflineQueue();
          const pendingSupplierIds = new Set(supplierQueue.filter(i => i.type === 'supplier').map(i => String(i.data?.id || i.actionId)));
          const deletedSupplierIds = new Set(supplierQueue.filter(i => i.type === 'supplier_delete').map(i => String(i.data?.id || i.actionId)));
          const mergedSuppliers = replaceRemoteRecords(data.suppliers, state.suppliers || [], new Set([...pendingSupplierIds, ...deletedSupplierIds]));
          const filteredSuppliers = mergedSuppliers.filter(s => !deletedSupplierIds.has(String(s.id)));
          const mergedSupplierOrders = replaceRemoteRecords(data.supplierOrders, state.supplierOrders || [], new Set(getOfflineQueue().filter(i => i.type === 'supplier_order').map(i => String(i.data?.id || i.actionId))));
          const mergedCurrencies = mergeUnique(data.currencies, state.currencies || [], { idKey: 'code' });
          const pendingTransferIds = new Set<string>();
          for (const q of getOfflineQueue()) {
            if (q.type === 'transfer') {
              pendingTransferIds.add(String(q.data?.id || q.data?.operationId || q.actionId));
            } else if (q.type === 'transfer_bulk') {
              for (const op of Array.isArray(q.data?.items) ? q.data.items : []) {
                if (op?.operationId) pendingTransferIds.add(String(op.operationId));
              }
            }
          }
          const mergedTransfers = replaceRemoteRecords(
            data.transfers,
            state.transfers || [],
            pendingTransferIds
          );
          const mergedWarranties = replaceRemoteRecords(data.warranties, state.warranties || [], new Set(getOfflineQueue().filter(i => i.type === 'warranty').map(i => String(i.data?.id || i.actionId))));
          const mergedQuotes = replaceRemoteRecords(data.quotes, state.quotes || [], new Set(getOfflineQueue().filter(i => i.type === 'quote').map(i => String(i.data?.id || i.actionId))));
          const mergedTimeShifts = replaceRemoteRecords(data.timeShifts, state.timeShifts || [], new Set(getOfflineQueue().filter(i => i.type === 'time_shift').map(i => String(i.data?.id || i.actionId))));
          const mergedSalarySettlements = replaceRemoteRecords(data.salarySettlements, state.salarySettlements || [], new Set(getOfflineQueue().filter(i => i.type === 'salary_settlement').map(i => String(i.data?.id || i.actionId))));

          const updatedCurrentUser = state.currentUser
            ? (finalUsers.find((u: any) => u.id === state.currentUser?.id) || state.currentUser)
            : null;

          return {
            products: finalProducts,
            categories: finalCategories,
            inventory: mergedInventory,
            branches: finalBranches,
            currentBranchId: nextBranchId,
            users: finalUsers,
            currentUser: updatedCurrentUser,
            bankCards: mergedBankCards,
            bankTransactions: mergedBankTransactions,
            customers: mergedCustomers,
            suppliers: filteredSuppliers,
            supplierOrders: mergedSupplierOrders,
            currencies: mergedCurrencies,
            transactions: mergedTransactions,
            cashSessions: mergedCashSessions,
            transfers: mergedTransfers,
            warranties: mergedWarranties,
            returns: mergedReturns,
            quotes: mergedQuotes,
            timeShifts: mergedTimeShifts,
            salarySettlements: mergedSalarySettlements,
            receiptConfig: data.receiptConfig ? { ...state.receiptConfig, ...data.receiptConfig } : state.receiptConfig,
            storeConfig: data.storeConfig ? { ...state.storeConfig, ...data.storeConfig } : state.storeConfig,
            lastTurnNumber: data.lastTurnNumber !== undefined ? Math.max(state.lastTurnNumber, data.lastTurnNumber) : state.lastTurnNumber,
            lastSyncTime: new Date().toISOString(),
            syncResult: result,
            isSyncing: false
          };
        });
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
