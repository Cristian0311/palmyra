import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Branch, Category, Product, InventoryLevel, CartItem, Transaction, ReturnItem, Currency, Customer, CashRegisterSession, User, PendingOrder, SalarySettlement, InventoryTransfer, Warranty, CashMovement, Supplier, SupplierOrder, InventoryAudit, FiscalConfig, DemandForecast, BankCard, BankTransaction } from '../types';
import { generateId, generateReadableId } from '../lib/utils';
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
} from '../services/supabaseSync';
import { getSupabaseCredentials } from '../lib/supabase';
import { loadSaaSContext, signInSaaSAccount, signOutSaaSAccount } from '../services/saas';
import { getCachedSaaSContext } from '../services/offlineAuthContext';
import { getOfflineQueue, enqueueOfflineItem, removeFromOfflineQueue, waitForOfflineQueueReady } from '../services/offlineQueue';
import { normalizeSemanticText, areSemanticallyEqual } from '../utils/textUtils';
import { evaluateWarehouseDeletion } from '../lib/teamWarehouses';
import { localStateStorage, clearLocalStateStorage, flushLocalStateStorage } from '../services/localStateStorage';
import { getPalmyraScopedStorageKey } from '../services/localScope';
import { isCloudBusinessSyncAllowed } from '../services/localPlanMode';
import { setCanonicalInventoryQuantity, validateTransferStock } from './utils/inventoryTransforms';
import { buildLocalVoidTransactionPatch } from './utils/localVoidTransaction';
import { buildLocalCompletedSalePatch } from './utils/localCompletedSale';
import { replaceRemoteRecords } from './utils/replaceRemoteRecords';
import { calculateExpectedCashBase } from '../services/cash/expectedCash';
import { removeFromOfflineQueueByAction, removeFromOfflineQueueByTransactionId } from '../services/offlineQueue/outboxUtils';
import {
  getNcfDeviceId,
  loadNcfRanges,
  saveNcfRanges,
  invalidateNcfRange,
  withNcfLock,
  type LocalNcfRange,
} from '../services/fiscal/ncfLocal';
import type { AppState } from './storeTypes';

import { createAuthActions } from './actions/authActions';
import { createInventoryActions } from './actions/inventoryActions';
import { createPosActions } from './actions/posActions';
import { createCashActions } from './actions/cashActions';
import { createBankActions } from './actions/bankActions';
import { createSyncActions } from './actions/syncActions';
import { createOperationsActions } from './actions/operationsActions';
import { createSupportActions } from './actions/supportActions';

import {
  INITIAL_USERS, INITIAL_BRANCHES, INITIAL_CATEGORIES, INITIAL_PRODUCTS,
  INITIAL_INVENTORY, INITIAL_BANK_CARDS, INITIAL_FISCAL_CONFIGS,
  BASE_CURRENCY_CODE, INITIAL_CURRENCIES
} from './storeInitialData';

// --- Definición del Store ---

async function refreshInventoryBranchesFromSupabase(branchIds: string[]): Promise<boolean> {
  const ids = Array.from(new Set(branchIds.filter(Boolean)));
  if (!ids.length) return true;
  try {
    const results = await Promise.all(ids.map(id => pullBranchInventoryFromSupabase(id)));
    if (results.some(result => !result.success)) return false;

    const byKey = new Map<string, InventoryLevel>();
    useStore.getState().inventory.forEach(item => {
      if (!ids.includes(item.branchId)) {
        byKey.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
      }
    });

    for (const result of results) {
      for (const item of result.inventory) {
        byKey.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
      }
    }

    useStore.setState({ inventory: Array.from(byKey.values()) });
    return true;
  } catch (error) {
    console.warn('[inventory] No se pudo refrescar el inventario canónico de las sucursales:', error);
    return false;
  }
}









export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      lastTurnNumber: 0,
      isSyncing: false,
      lastSyncTime: null,
      syncResult: null,
      users: INITIAL_USERS,
      currentUser: null,
  ...createAuthActions(set, get),
  currencies: INITIAL_CURRENCIES,
  
  updateCurrencyRate: async (code, newRate) => {
    if (!Number.isFinite(newRate) || newRate <= 0) return false;

    // Se actualiza SOLO la moneda indicada. Filtrar la lista a CUP/USD/EUR
    // borraba MLC, ZELLE y cualquier divisa extra al guardar una tasa.
    const currencies = get().currencies || INITIAL_CURRENCIES;
    const current = currencies.find(c => c.code === code);
    if (!current || current.isBase) return false;

    const updatedCurrency = { ...current, rateToBase: newRate };
    // Actualizar inmediatamente el estado local conserva el trabajo offline.
    set({
      currencies: currencies.map(c => c.code === code ? updatedCurrency : c)
    });

    // No informar éxito remoto hasta recibir confirmación de Supabase.
    return await pushCurrencyToSupabase(updatedCurrency);
  },

  getBaseCurrency: () => {
    const list = get().currencies || INITIAL_CURRENCIES;
    return list.find(c => c.isBase) || list.find(c => c.code === 'CUP') || INITIAL_CURRENCIES[0];
  },
  
  storeConfig: { storeName: 'PALMYRA', address: '', phone: '', receiptNotes: '¡Gracias por su compra!', darkMode: false, manualOfflineSync: false },
  
  updateStoreConfig: (config) => {
    const nextStoreConfig = { ...config, fiscalConfigs: get().fiscalConfigs };
    set({ storeConfig: nextStoreConfig as any });
    pushStoreConfigToSupabase(nextStoreConfig as any).catch(() => {});
  },



  branches: INITIAL_BRANCHES,
  currentBranchId: '',
  setCurrentBranch: (id) => set({ currentBranchId: id }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  addBranch: (branch) => {
    const current = get();
    const activeWarehouseCount = (current.branches || []).filter(b => b.isActive !== false).length;
    const cachedContext = current.currentUser?.id
      ? getCachedSaaSContext(current.currentUser.id)
      : null;
    const cachedLimit = Number(cachedContext?.subscription?.limits?.warehouses);

    // Client-side guard for offline/local UX. The database trigger remains the
    // final authority, so stale cache can never grant an extra warehouse.
    if (Number.isFinite(cachedLimit) && activeWarehouseCount >= cachedLimit) {
      console.warn(
        `[PALMYRA] Creación local de almacén bloqueada: límite ${cachedLimit} alcanzado para ${cachedContext?.subscription?.planName || 'el plan actual'}.`
      );
      return;
    }

    let shouldPush = false;
    set((state) => {
      // Deduplicación estricta insensible a mayúsculas, acentos y espaciado
      const normName = normalizeSemanticText(branch.name);
      const isDuplicate = state.branches.some(b =>
        b.id === branch.id ||
        normalizeSemanticText(b.name) === normName
      );
      if (isDuplicate) {
        console.warn(`[Palmyra] Intento de agregar sucursal duplicada bloqueado: "${branch.name}"`);
        return state;
      }

      shouldPush = true;
      return {
        branches: [...state.branches, branch],
        currentBranchId: state.currentBranchId || branch.id
      };
    });
    if (shouldPush) {
      pushBranchToSupabase(branch);
    }
  },
  updateBranch: (id, branch) => {
    let shouldPush = false;
    set((state) => {
      if (branch.name) {
        const normName = normalizeSemanticText(branch.name);
        const nameCollision = state.branches.some(b => b.id !== id && normalizeSemanticText(b.name) === normName);
        if (nameCollision) {
          console.warn(`[Palmyra] No se puede renombrar: ya existe otra sucursal con el nombre "${branch.name}"`);
          return state;
        }
      }
      shouldPush = true;
      return {
        branches: state.branches.map(b => b.id === id ? { ...b, ...branch } : b)
      };
    });
    if (shouldPush) {
      const updated = get().branches.find(b => b.id === id);
      if (updated) pushBranchToSupabase(updated);
    }
  },
  /**
   * Baja de un almacén. Devuelve SIEMPRE un resultado explícito: el aviso de
   * «eliminado» de la UI solo es válido si `ok === true`.
   *
   * Regla determinista (ver `evaluateWarehouseDeletion`): se bloquea si tiene
   * unidades en stock, ventas o turnos. Nunca se borra ni se reasigna inventario.
   * Si procede, se quita de la memoria, del JSON persistido y del almacén local
   * (tombstone `deleted_at` en `warehouses`) para que ni el arranque offline ni
   * el puente del hub lo rehidraten, y se encola/confirma la baja remota.
   */
  deleteBranch: async (id) => {
    const rawId = String(id || '').trim();
    if (!rawId) return { ok: false, reason: 'unknown' as const, detail: 'No se indicó el almacén a eliminar.' };

    const decision = evaluateWarehouseDeletion({
      warehouseId: rawId,
      inventory: get().inventory,
      transactions: get().transactions,
      cashSessions: get().cashSessions,
    });
    if (!decision.ok) {
      console.warn(`[Palmyra] Bloqueada la baja del almacén ${rawId}: ${decision.detail}`);
      return decision;
    }

    let removed = false;
    set((state) => {
      const newBranches = state.branches.filter(b => b.id !== rawId);
      if (newBranches.length === state.branches.length) return state;
      removed = true;
      return {
        branches: newBranches,
        // El inventario de un almacén sin unidades ya está filtrado arriba: no
        // hay filas que huérfanar, así que también se limpian sus niveles en cero.
        inventory: state.inventory.filter(l => l.branchId !== rawId && l.warehouseId !== rawId),
        currentBranchId: state.currentBranchId === rawId ? (newBranches[0]?.id || '') : state.currentBranchId
      };
    });
    if (!removed) {
      return { ok: false, reason: 'unknown' as const, detail: 'El almacén ya no existe en este dispositivo.', counts: decision.counts };
    }

    const actionId = 'branch-delete:' + rawId;
    // Cola offline ANTES de tocar la red: si el replay falla, la marca sigue ahí
    // y ningún pull puede devolver el almacén mientras esté pendiente.
    const queueDeletion = async () => {
      try {
        await waitForOfflineQueueReady();
        await enqueueOfflineItem('branch_delete', { id: rawId }, actionId);
        return true;
      } catch (error) {
        console.warn('[PALMYRA] No se pudo guardar la eliminación de almacén en la cola:', error);
        return false;
      }
    };
    const purgeLocalRow = async () => {
      try {
        const { removeWarehouseFromLocalDb } = await import('../services/localDb/warehouseDelete');
        return await removeWarehouseFromLocalDb(rawId);
      } catch (error) {
        console.warn('[PALMYRA] No se pudo borrar el almacén del almacén local:', error);
        return false;
      }
    };

    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    if (!online) {
      const queued = await queueDeletion();
      await purgeLocalRow();
      return {
        ok: true,
        synced: false,
        pendingSync: queued,
        detail: queued
          ? 'Almacén eliminado. Se sincronizará al recuperar la conexión.'
          : 'Almacén eliminado en este dispositivo. No se pudo registrar la sincronización pendiente.',
        counts: decision.counts,
      };
    }

    let remoteOk = false;
    try {
      remoteOk = await deleteBranchFromSupabase(rawId);
    } catch {
      remoteOk = false;
    }
    let queued = false;
    if (remoteOk) {
      try {
        // Firma real: `(type, actionId)` y devuelve `void`. Antes se llamaba con
        // un solo argumento y con `.catch()`, lo que no compilaba y dejaba la
        // cola sin limpiar.
        removeFromOfflineQueueByAction('branch_delete', actionId);
        queued = false;
      } catch (error) {
        console.warn('[PALMYRA] No se pudo retirar la baja de almacén de la cola:', error);
      }
    } else {
      queued = await queueDeletion();
    }
    await purgeLocalRow();

    if (remoteOk) {
      return { ok: true, synced: true, pendingSync: false, detail: 'Almacén eliminado.', counts: decision.counts };
    }
    return {
      ok: true,
      synced: false,
      pendingSync: Boolean(queued),
      detail: queued
        ? 'Almacén eliminado. Quedó pendiente de sincronizar con la nube.'
        : 'Almacén eliminado en este dispositivo, pero no se pudo dejar registrada la baja en la nube.',
      counts: decision.counts,
    };
  },
  
  categories: INITIAL_CATEGORIES,
  addCategory: (category) => {
    let shouldPush = false;
    set((state) => {
      // Deduplicación estricta por ID o Nombre normalizado
      const normName = normalizeSemanticText(category.name);
      const isDuplicate = state.categories.some(c => 
        c.id === category.id || 
        normalizeSemanticText(c.name) === normName
      );
      if (isDuplicate) return state;
      shouldPush = true;
      return { categories: [...state.categories, category] };
    });
    if (shouldPush) {
      pushCategoryToSupabase(category);
    }
  },
  updateCategory: (id, category) => {
    set((state) => ({
      categories: state.categories.map(c => c.id === id ? { ...c, ...category } : c)
    }));
    const updated = get().categories.find(c => c.id === id);
    if (updated) pushCategoryToSupabase(updated);
  },
  deleteCategory: (id) => {
    const productsInUse = (get().products || []).filter(p => p.categoryId === id).length;
    if (productsInUse > 0) {
      get().addNotification(
        `No se puede eliminar la categoría: ${productsInUse} producto${productsInUse === 1 ? '' : 's'} la usa${productsInUse === 1 ? '' : 'n'}. Reasígnalos a otra categoría primero.`,
        'warning'
      );
      return;
    }
    set((state) => ({ categories: state.categories.filter(c => c.id !== id) }));
    const actionId = 'category-delete:' + id;
    const queueDeletion = () => enqueueOfflineItem('category_delete', { id }, actionId)
      .catch((error) => console.warn('[PALMYRA] No se pudo guardar la eliminación de categoría en la cola:', error));
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      deleteCategoryFromSupabase(id).then((ok) => {
        if (!ok) queueDeletion();
      }).catch(() => queueDeletion());
    } else {
      queueDeletion();
    }
  },
  
  ...createInventoryActions(set, get),
  ...createPosActions(set, get),
  customers: [],
  addCustomer: async (customer) => {
    let added = false;
    set((state) => {
      // Deduplicación por ID, Teléfono o Correo. El teléfono se compara solo
      // por dígitos para no duplicar «555 1234» frente a «555-1234».
      const digits = (value?: string) => (value || '').replace(/\D/g, '');
      const isDuplicate = (state.customers || []).some(c =>
        c.id === customer.id ||
        (digits(customer.phone).length >= 6 && digits(c.phone) === digits(customer.phone)) ||
        (c.email && customer.email && c.email.toLowerCase().trim() === customer.email.toLowerCase().trim())
      );
      if (isDuplicate) return state;
      added = true;
      return { customers: [...(state.customers || []), customer] };
    });
    if (!added) return false;
    // Plan Gratis: el cliente vive solo en este dispositivo; no se intenta subir
    // ni se revierte el alta local ante un rechazo de la nube.
    if (!isCloudBusinessSyncAllowed()) return true;

    const result = await pushCustomerToSupabase(customer);
    if (!result.success && !result.pending) {
      set((state) => ({ customers: state.customers.filter(c => c.id !== customer.id) }));
      get().addNotification("No se pudo guardar el cliente.", "error", result.error || "Supabase rechazó la operación.");
      return false;
    }
    return true;
  },
  updateCustomer: async (id, customer) => {
    const previous = get().customers.find(c => c.id === id);
    const updated = previous ? { ...previous, ...customer } : undefined;
    if (!updated) return false;

    set((state) => ({
      customers: state.customers.map(c => c.id === id ? updated : c)
    }));

    if (!isCloudBusinessSyncAllowed()) return true;

    const result = await pushCustomerToSupabase(updated);
    if (!result.success && !result.pending) {
      if (previous) {
        set((state) => ({ customers: state.customers.map(c => c.id === id ? previous : c) }));
      }
      get().addNotification("No se pudo actualizar el cliente.", "error", result.error || "Supabase rechazó la operación.");
      return false;
    }
    return true;
  },
  deleteCustomer: (id) => {
    set((state) => ({
      customers: state.customers.filter(c => c.id !== id),
      currentCustomerId: state.currentCustomerId === id ? undefined : state.currentCustomerId
    }));
    if (navigator.onLine && isCloudBusinessSyncAllowed()) {
      deleteCustomerFromSupabase(id).then((ok) => {
        if (!ok) enqueueOfflineItem('customer_delete', { id }, `customer-delete:${id}`);
      }).catch(() => enqueueOfflineItem('customer_delete', { id }, `customer-delete:${id}`));
    } else {
      enqueueOfflineItem('customer_delete', { id }, `customer-delete:${id}`);
    }
  },

  ...createCashActions(set, get),
  ...createOperationsActions(set, get),
  ...createSupportActions(set, get),
transfers: [],
  addTransfer: (transfer) => {
    // The transfer RPC is the only authority for inventory transfers. Calling a
    // second upsert here used to duplicate/overwrite a transfer after the RPC
    // had already committed it. This action only updates the local ledger.
    set((state) => ({
      transfers: [transfer, ...state.transfers.filter(t => t.id !== transfer.id && t.operationId !== transfer.operationId)]
    }));
  },

  warranties: [],
  addWarranty: (warranty) => {
    set((state) => ({ warranties: [warranty, ...state.warranties] }));
    import('../services/supabaseSync').then(({ pushWarrantyToSupabase }) => {
      pushWarrantyToSupabase(warranty).catch(() => {});
    }).catch(() => {});
  },
  updateWarranty: (id, warranty) => {
    set((state) => ({
      warranties: state.warranties.map(w => w.id === id ? { ...w, ...warranty } : w)
    }));
    const updated = get().warranties.find(w => w.id === id);
    if (updated) {
      import('../services/supabaseSync').then(({ pushWarrantyToSupabase }) => {
        pushWarrantyToSupabase(updated).catch(() => {});
      }).catch(() => {});
    }
  },

  ...createBankActions(set, get),
  ...createSyncActions(set, get),
  seedDemoProducts: () => {
    set({
      products: INITIAL_PRODUCTS,
      inventory: INITIAL_INVENTORY,
      categories: INITIAL_CATEGORIES,
      branches: INITIAL_BRANCHES,
      bankCards: INITIAL_BANK_CARDS,
      currencies: INITIAL_CURRENCIES
    });
  },

  restoreTransactionsFromBackup: () => {
    try {
      const currentTxs = get().transactions || [];

      // El outbox durable es la primera fuente de recuperación de ventas offline.
      // Tras una recarga, la transacción debe reaparecer aunque el snapshot de
      // Zustand no hubiera alcanzado a persistirse antes de cerrar la pestaña.
      const durableTransactions = getOfflineQueue()
        .filter(item => item.type === 'transaction' && item.status !== 'conflict')
        .map(item => ({ ...(item.data as Transaction), offlinePending: true }))
        .filter((tx: any) => tx?.id && tx.status !== 'refunded' && tx.status !== 'cancelled');

      const durableById = new Map(durableTransactions.map((tx: any) => [String(tx.id), tx]));
      const missingDurable = durableTransactions.filter(
        (tx: any) => !currentTxs.some((ct: any) => ct.id === tx.id)
      );

      if (missingDurable.length > 0 || durableById.size > 0) {
        set((state) => ({
          transactions: (state.transactions || []).map((tx: any) =>
            durableById.has(String(tx.id)) ? { ...tx, offlinePending: true } : tx
          ).concat(missingDurable)
        }));
        get().addNotification(
          'Se recuperaron ' + missingDurable.length + ' venta(s) offline pendientes de sincronización.',
          'info'
        );
      }

      // Respaldo legacy: solo recupera una venta que siga representada por el outbox.
      const backupKey = getPalmyraScopedStorageKey('palmyra-sales-backup-v1');
      const backupRaw = backupKey ? localStorage.getItem(backupKey) : null;
      if (!backupRaw) return;
      const backupList = JSON.parse(backupRaw);
      if (!Array.isArray(backupList) || backupList.length === 0) return;

      const queuedTransactionIds = new Set(
        getOfflineQueue()
          .filter(item => item.type === 'transaction' && item.status !== 'conflict')
          .map(item => item.actionId)
      );
      const afterDurable = get().transactions || [];
      const recoverable = backupList.filter((bt: any) =>
        bt?.id &&
        queuedTransactionIds.has(bt.id) &&
        !afterDurable.some((ct: any) => ct.id === bt.id)
      );

      if (recoverable.length > 0) {
        set((state) => ({ transactions: [...recoverable, ...(state.transactions || [])] }));
        get().addNotification(
          'Se recuperaron ' + recoverable.length + ' venta(s) del respaldo local.',
          'info'
        );
      }
    } catch (e) {
      console.error('[Backup Safety] Error recuperando ventas locales:', e);
    }
  },
  restoreCashSessionsFromBackup: () => {
    try {
      const currentSessions = get().cashSessions || [];
      const queued = getOfflineQueue()
        .filter(item => item.type === 'cash_session' && item.status !== 'conflict' && item.data?.id)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));

      if (!queued.length) return;

      const latestBySession = new Map<string, any>();
      for (const item of queued) latestBySession.set(String(item.data.id), item.data);

      const merged = new Map<string, CashRegisterSession>(
        currentSessions.map(session => [String(session.id), session])
      );

      for (const [id, raw] of latestBySession) {
        const current = merged.get(id);
        merged.set(id, {
          ...(current || {}),
          ...raw,
          id,
          movements: Array.isArray(raw.movements) ? raw.movements : (current?.movements || [])
        } as CashRegisterSession);
      }

      const sessions = Array.from(merged.values());
      set({
        cashSessions: sessions,
        lastTurnNumber: sessions.reduce(
          (max, session) => Math.max(max, Number(session.turnNumber) || 0),
          Number(get().lastTurnNumber) || 0
        )
      });
    } catch (error) {
      console.error('[Store] No se pudieron recuperar los turnos offline:', error);
    }
  },
  notifications: [],
  addNotification: (message, type = 'info', details) => {
    const id = crypto.randomUUID();
    set(state => ({
      notifications: [...state.notifications, { id, message, type, ...(details ? { details } : {}) }]
    }));
    // Las burbujas de carga permanecen hasta que la operación termine.
    if (type !== 'loading') {
      setTimeout(() => {
        set(state => ({
          notifications: state.notifications.filter(n => n.id !== id)
        }));
      }, details ? 15000 : 4000);
    }
    return id;
  },
  removeNotification: (id) => {
    set(state => ({
      notifications: state.notifications.filter(n => n.id !== id)
    }));
  },

  isInitialized: false
}),
{
  name: 'pos-store-storage',
  storage: createJSONStorage(() => localStateStorage),
  // El estado operativo sigue persistiendo para poder trabajar offline, pero
  // evitamos guardar datos puramente transitorios y el historial bancario pesado
  // en cada cambio de UI.
  onRehydrateStorage: () => (state, error) => {
    if (error) console.error('[Store] Error hidratando el estado local:', error);
    const hydratedMaxTurn = (state?.cashSessions || []).reduce((max: number, session: any) => {
      const n = Number(session?.turnNumber);
      return Number.isFinite(n) ? Math.max(max, Math.trunc(n)) : max;
    }, 0);
    useStore.setState((current) => ({
      isInitialized: true,
      lastTurnNumber: Math.max(Number(current.lastTurnNumber) || 0, hydratedMaxTurn)
    }));

    // Recuperación crítica del POS offline:
    // la cola durable (IndexedDB/localStorage) puede contener una venta que
    // todavía no estaba incluida en el último snapshot de Zustand. Debemos
    // reconstruirla después de que la cola termine de hidratarse y antes de
    // que el POS haga refrescos remotos que puedan reemplazar el historial local.
    void waitForOfflineQueueReady()
      .then(() => {
        useStore.getState().restoreTransactionsFromBackup();
        useStore.getState().restoreCashSessionsFromBackup();
      })
      .catch((restoreError) => {
        console.error('[Store] No se pudieron recuperar las operaciones offline:', restoreError);
      });
  },
  partialize: (state) => ({
    lastTurnNumber: state.lastTurnNumber,
    // Passwords are credentials, never durable application state. POS rehydration
    // must restore the employee identity, not a saved password.
    users: (state.users || []).map(({ password: _password, ...user }) => user),
    currentUser: state.currentUser ? (({ password: _password, ...user }) => user)(state.currentUser) : null,
    currencies: state.currencies, storeConfig: state.storeConfig,
    branches: state.branches, currentBranchId: state.currentBranchId, categories: state.categories,
    products: state.products, inventory: state.inventory, cart: state.cart, currentCustomerId: state.currentCustomerId,
    transactions: state.transactions, returns: state.returns, warranties: state.warranties,
    cashSessions: state.cashSessions, transfers: state.transfers, suppliers: state.suppliers,
    supplierOrders: state.supplierOrders, inventoryAudits: state.inventoryAudits, salarySettlements: state.salarySettlements,
    quotes: state.quotes, timeShifts: state.timeShifts, pendingOrders: state.pendingOrders, receiptConfig: state.receiptConfig,
    fiscalConfigs: state.fiscalConfigs, bankCards: state.bankCards
  })
}
));
