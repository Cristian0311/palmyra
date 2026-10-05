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
import { getOfflineQueue, enqueueOfflineItem, removeFromOfflineQueue, waitForOfflineQueueReady } from '../services/offlineQueue';
import { normalizeSemanticText, areSemanticallyEqual } from '../utils/textUtils';
import { localStateStorage, clearLocalStateStorage, flushLocalStateStorage } from '../services/localStateStorage';
import { getPalmyraScopedStorageKey } from '../services/localScope';
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
  
  updateCurrencyRate: (code, newRate) => {
    set((state) => ({
      currencies: (state.currencies || INITIAL_CURRENCIES)
        .filter(c => ['CUP', 'USD', 'EUR'].includes(c.code))
        .map(c => c.code === code ? { ...c, rateToBase: newRate } : c)
    }));
    const updated = get().currencies.find(c => c.code === code);
    if (updated) {
      pushCurrencyToSupabase(updated);
    }
  },

  getBaseCurrency: () => {
    const list = (get().currencies || INITIAL_CURRENCIES).filter(c => ['CUP', 'USD', 'EUR'].includes(c.code));
    return list.find(c => c.isBase) || list.find(c => c.code === 'CUP') || INITIAL_CURRENCIES[0];
  },
  
  storeConfig: { storeName: 'Mi Tienda POS', address: 'Calle Principal 123', phone: '+53 51234567', receiptNotes: '¡Gracias por su compra!', darkMode: false, manualOfflineSync: false },
  
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
    let shouldPush = false;
    set((state) => {
      // Deduplicación estricta insensible a mayúsculas, acentos y espaciado
      const normName = normalizeSemanticText(branch.name);
      const isDuplicate = state.branches.some(b => 
        b.id === branch.id || 
        normalizeSemanticText(b.name) === normName
      );
      if (isDuplicate) {
        console.warn(`[MARÉ] Intento de agregar sucursal duplicada bloqueado: "${branch.name}"`);
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
          console.warn(`[MARÉ] No se puede renombrar: ya existe otra sucursal con el nombre "${branch.name}"`);
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
  deleteBranch: (id) => {
    // Validar integridad referencial antes de permitir eliminación
    // Mantener la misma regla que aplica la operación remota: cualquier
    // registro histórico relacionado impide una eliminación física.
    const hasInventory = (get().inventory || []).some(l => l.branchId === id);
    const hasTx = (get().transactions || []).some(t => t.branchId === id);
    const hasSessions = (get().cashSessions || []).some(s => s.branchId === id);
    if (hasInventory || hasTx || hasSessions) {
      console.warn(`[MARÉ] Bloqueada eliminación de sucursal ${id} porque tiene relaciones activas (inventario, ventas o turnos).`);
      return;
    }

    set((state) => {
      const newBranches = state.branches.filter(b => b.id !== id);
      return {
        branches: newBranches,
        currentBranchId: state.currentBranchId === id ? (newBranches[0]?.id || '') : state.currentBranchId
      };
    });
    deleteBranchFromSupabase(id);
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
    set((state) => ({ categories: state.categories.filter(c => c.id !== id) }));
    deleteCategoryFromSupabase(id);
  },
  
  ...createInventoryActions(set, get),
  ...createPosActions(set, get),
  customers: [],
  addCustomer: async (customer) => {
    let added = false;
    set((state) => {
      // Deduplicación por ID, Teléfono o Correo
      const isDuplicate = (state.customers || []).some(c =>
        c.id === customer.id ||
        (c.phone && customer.phone && c.phone === customer.phone) ||
        (c.email && customer.email && c.email.toLowerCase().trim() === customer.email.toLowerCase().trim())
      );
      if (isDuplicate) return state;
      added = true;
      return { customers: [...(state.customers || []), customer] };
    });
    if (!added) return false;

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
    if (navigator.onLine) {
      deleteCustomerFromSupabase(id).then((ok) => {
        if (!ok) enqueueOfflineItem('customer_delete', { id }, `customer-delete:${id}`);
      }).catch(() => enqueueOfflineItem('customer_delete', { id }, `customer-delete:${id}`));
    } else {
      enqueueOfflineItem('customer_delete', { id }, `customer-delete:${id}`);
    }
  },

  ...createCashActions(set, get),
  pendingOrders: [],
  createPendingOrder: (order) => set((state) => ({
    pendingOrders: [...state.pendingOrders, order]
  })),
  removePendingOrder: (id) => set((state) => ({
    pendingOrders: state.pendingOrders.filter(o => o.id !== id)
  })),

  // Suppliers
  suppliers: [],
  addSupplier: (s) => {
    const newSupplier = { ...s, products: s.products || [] };
    set(state => ({ suppliers: [...state.suppliers, newSupplier] }));
    pushSupplierToSupabase(newSupplier).catch(() => {});
  },
  updateSupplier: (id, s) => {
    set(state => ({ suppliers: state.suppliers.map(x => x.id === id ? { ...x, ...s } : x) }));
    const updated = get().suppliers.find(x => x.id === id);
    if (updated) pushSupplierToSupabase(updated).catch(() => {});
  },
  deleteSupplier: (id) => {
    set(state => ({ suppliers: state.suppliers.filter(x => x.id !== id) }));
    deleteSupplierFromSupabase(id).catch(() => {});
  },

  supplierOrders: [],
  createSupplierOrder: (o) => {
    set(state => ({ supplierOrders: [o, ...state.supplierOrders] }));
    pushSupplierOrderToSupabase(o).catch(() => {});
  },
  updateSupplierOrder: async (id, o) => {
    const previous = get().supplierOrders.find(x => x.id === id);
    const requestedReceived = o.status === 'received' && previous?.status !== 'received';
    const userId = get().currentUser?.id || 'system';
    const actionId = 'supplier:' + id;

    const receiveOffline = requestedReceived && !(typeof navigator !== 'undefined' && navigator.onLine);
    if (requestedReceived) {
      await enqueueOfflineItem('supplier_receive', { id, userId }, actionId);
      if (receiveOffline) {
        // La recepción debe ser la única operación que cambie el stock y el
        // estado remoto. Si encolamos supplier_order con status=received antes,
        // el replay puede llegar a receive_supplier_order_v2 cuando ya ve la
        // orden como recibida y entonces no aplicar el inventario.
        const pendingOrderSnapshot = { ...get().supplierOrders.find(x => x.id === id), ...o, status: 'pending' as const };
        await enqueueOfflineItem('supplier_order', pendingOrderSnapshot, id);
      }
      if (navigator.onLine) {
        try {
          const res = await callReceiveSupplierOrderRPC(id, userId);
          if (!res.success) throw new Error(res.error || 'No se pudo recibir la orden');

          set(state => {
            const updated = state.supplierOrders.map(x => x.id === id ? { ...x, ...o, status: 'received' as const } : x);
            return { supplierOrders: updated };
          });

          const inventoryReconciled = await get().refreshBranchInventory();
          if (!inventoryReconciled) {
            throw new Error('Recepción confirmada, pero el inventario local aún no pudo reconciliarse con Supabase');
          }

          removeFromOfflineQueueByAction('supplier_receive', actionId);
          return { success: true };
        } catch (err) {
          console.warn('[updateSupplierOrder] Recepción no confirmada; queda durable para reintento:', err);
          return;
        }
      }
    }

    set(state => {
      const current = state.supplierOrders.find(x => x.id === id);
      const updated = state.supplierOrders.map(x => x.id === id ? { ...x, ...o } : x);
      const order = updated.find(x => x.id === id);
      if (order && current?.status !== 'received' && order.status === 'received' && !navigator.onLine) {
        const nextInventory = [...state.inventory];
        for (const item of order.items || []) {
          const qty = Number(item.quantity) || 0;
          const idx = nextInventory.findIndex(i => i.productId === item.productId && i.branchId === order.branchId && (i.variantLabel || '') === (item.variantLabel || ''));
          if (idx >= 0) nextInventory[idx] = { ...nextInventory[idx], quantity: Math.max(0, Number(nextInventory[idx].quantity || 0) + qty) };
          else if (qty > 0) nextInventory.push({ id: crypto.randomUUID(), productId: item.productId, branchId: order.branchId, quantity: qty, minQuantity: 5, variantLabel: item.variantLabel || '' });
        }
        return { supplierOrders: updated, inventory: nextInventory };
      }
      return { supplierOrders: updated };
    });
    const updatedOrder = get().supplierOrders.find(x => x.id === id);
    // Cuando la acción fue una recepción offline, el encabezado pendiente ya
    // quedó encolado con status=pending y debe ser consumido por receive RPC.
    if (updatedOrder && !receiveOffline) {
      pushSupplierOrderToSupabase(updatedOrder).catch(() => {});
    }
  },

  inventoryAudits: [],
  createInventoryAudit: async (audit) => {
    const userId = get().currentUser?.id || audit.userId || 'system';
    const actionId = 'audit-start:' + audit.id;
    const queueData = {
      id: audit.id,
      branchId: audit.branchId,
      userId,
      mode: audit.mode || 'cycle_count',
      blindCount: audit.blindCount === true,
      notes: audit.notes || '',
      date: audit.date
    };
    await enqueueOfflineItem('audit_start', queueData, actionId);

    if (navigator.onLine) {
      try {
        const res = await callStartInventoryAuditRPC(
          audit.id, audit.branchId, userId, audit.mode || 'cycle_count', audit.blindCount === true, audit.notes
        );
        if (!res.success) throw new Error(res.error || 'No se pudo iniciar la auditoría');
        if (res.data?.already_exists && res.data?.audit_id && res.data.audit_id !== audit.id) {
          removeFromOfflineQueueByAction('audit_start', actionId);
          set(state => ({
            inventoryAudits: state.inventoryAudits.filter(a => a.id !== audit.id)
          }));
          get().addNotification('Ya existe una auditoría abierta para esta sucursal.', 'warning');
          return { success: false, error: 'Ya existe una auditoría abierta para esta sucursal.' };
        }
        removeFromOfflineQueueByAction('audit_start', actionId);
        const serverItems = Array.isArray(res.data?.items) ? res.data.items : audit.items;
        set(state => ({
          inventoryAudits: [
            { ...audit, userId, mode: audit.mode || 'cycle_count', blindCount: audit.blindCount === true,
              snapshotAt: res.data?.snapshot_at || audit.snapshotAt || audit.date, reviewStatus: 'counting',
              items: serverItems.map((item: any) => ({ ...item, difference: Number(item.difference || 0) })) },
            ...state.inventoryAudits.filter(a => a.id !== audit.id)
          ]
        }));
        return { success: true };
      } catch (err: any) {
        console.warn('[createInventoryAudit] Inicio no confirmado; queda durable para reintento:', err);
        set(state => ({ inventoryAudits: [{ ...audit, userId, reviewStatus: 'counting' }, ...state.inventoryAudits.filter(a => a.id !== audit.id)] }));
        get().addNotification('Auditoría guardada offline; queda pendiente de confirmación con la nube.', 'info');
        return { success: true, pending: true };
      }
    }

    set(state => ({ inventoryAudits: [{ ...audit, userId, reviewStatus: 'counting' }, ...state.inventoryAudits.filter(a => a.id !== audit.id)] }));
    get().addNotification('Auditoría guardada offline; queda pendiente de confirmación con la nube.', 'info');
    return { success: true, pending: true };
  },
  completeInventoryAudit: async (id, items, notes) => {
    const audit = get().inventoryAudits.find(a => a.id === id);
    if (!audit || audit.status === 'completed') return { success: false, error: 'La auditoría ya está cerrada.' };
    const userId = get().currentUser?.id || audit.userId || 'system';
    const actionId = 'audit:' + id;
    await enqueueOfflineItem('audit_complete', { id, branchId: audit.branchId, userId, items, notes }, actionId);

    if (navigator.onLine) {
      try {
        const res = await callSaveInventoryAuditCountRPC(id, userId, items, notes);
        if (!res.success) throw new Error(res.error || 'No se pudo guardar el conteo');
        removeFromOfflineQueueByAction('audit_complete', actionId);
        const serverItems = Array.isArray(res.data?.items) ? res.data.items : items;
        set(state => ({
          inventoryAudits: state.inventoryAudits.map(a => a.id === id
            ? { ...a, items: serverItems, notes: notes || a.notes, submittedAt: new Date().toISOString(), reviewStatus: 'pending_approval' }
            : a)
        }));
        return { success: true };
      } catch (err: any) {
        console.warn('[completeInventoryAudit] Conteo no confirmado; queda durable para reintento:', err);
        set(state => ({
          inventoryAudits: state.inventoryAudits.map(a => a.id === id
            ? { ...a, items, notes: notes || a.notes, submittedAt: new Date().toISOString(), reviewStatus: 'pending_approval' }
            : a)
        }));
        get().addNotification('Conteo guardado offline; queda pendiente de confirmación con la nube.', 'info');
        return { success: true, pending: true };
      }
    }

    set(state => ({
      inventoryAudits: state.inventoryAudits.map(a => a.id === id
        ? { ...a, items, notes: notes || a.notes, submittedAt: new Date().toISOString(), reviewStatus: 'pending_approval' }
        : a)
    }));
    get().addNotification('Conteo guardado offline; queda pendiente de confirmación con la nube.', 'info');
    return { success: true, pending: true };
  },
  requestInventoryAuditRecount: async (id, notes) => {
    const audit = get().inventoryAudits.find(a => a.id === id);
    if (!audit) return { success: false, error: 'Auditoría no encontrada.' };
    const userId = get().currentUser?.id || 'system';
    const actionId = 'audit-recount:' + id + ':' + Date.now();
    await enqueueOfflineItem('audit_recount', { id, userId, notes }, actionId);

    if (navigator.onLine) {
      try {
        const res = await callRequestInventoryAuditRecountRPC(id, userId, notes);
        if (!res.success) throw new Error(res.error || 'No se pudo solicitar el recuento');
        removeFromOfflineQueueByAction('audit_recount', actionId);
        set(state => ({ inventoryAudits: state.inventoryAudits.map(a => a.id === id ? { ...a, reviewStatus: 'recount_requested', recountCount: res.data?.recount_count || ((a.recountCount || 0) + 1), reviewedBy: userId, reviewedAt: new Date().toISOString() } : a) }));
        return { success: true };
      } catch (err: any) {
        console.warn('[requestInventoryAuditRecount] No confirmado; queda durable:', err);
        return { success: false, error: err?.message || 'No se pudo solicitar el recuento.' };
      }
    }

    set(state => ({ inventoryAudits: state.inventoryAudits.map(a => a.id === id ? { ...a, reviewStatus: 'recount_requested', recountCount: (a.recountCount || 0) + 1 } : a) }));
    return { success: true };
  },
  approveInventoryAudit: async (id, notes) => {
    const audit = get().inventoryAudits.find(a => a.id === id);
    if (!audit) return { success: false, error: 'Auditoría no encontrada.' };
    if (audit.reviewStatus !== 'pending_approval') return { success: false, error: 'El conteo aún no está pendiente de aprobación.' };
    if (!navigator.onLine) return { success: false, error: 'La aprobación del ajuste físico requiere conexión para validar que el inventario no haya cambiado.' };

    const userId = get().currentUser?.id || 'system';
    const actionId = 'audit-approve:' + id;
    await enqueueOfflineItem('audit_approve', { id, userId, notes }, actionId);
    try {
      const res = await callApproveInventoryAuditRPC(id, userId, notes);
      if (!res.success) throw new Error(res.error || 'No se pudo aprobar la auditoría');
      removeFromOfflineQueueByAction('audit_approve', actionId);
      const adjustments = Array.isArray(res.data?.adjustments) ? res.data.adjustments : [];
      set(state => {
        const auditNow = state.inventoryAudits.find(a => a.id === id);
        let inventory = [...state.inventory];
        for (const adj of adjustments) {
          const idx = inventory.findIndex(i => i.productId === adj.productId && i.branchId === audit?.branchId && (i.variantLabel || '') === (adj.variantLabel || ''));
          if (idx >= 0) inventory[idx] = { ...inventory[idx], quantity: Math.max(0, Number(inventory[idx].quantity || 0) + Number(adj.delta || 0)) };
        }
        return {
          inventory,
          inventoryAudits: state.inventoryAudits.map(a => a.id === id
            ? { ...a, status: 'completed' as const, reviewStatus: 'approved', reviewedBy: userId, reviewedAt: new Date().toISOString(), adjustmentPostedAt: new Date().toISOString(), notes: notes || a.notes,
              items: Array.isArray(res.data?.items) ? res.data.items : a.items }
            : a)
        };
      });
      return { success: true };
    } catch (err: any) {
      // La aprobación queda protegida en la cola durable hasta recibir confirmación.
      // Nunca se elimina una aprobación que Supabase no haya confirmado.
      console.warn('[approveInventoryAudit] Aprobación no confirmada; queda durable:', err);
      return { success: false, error: err?.message || 'No se pudo aprobar la auditoría. La operación quedó pendiente de sincronización.' };
    }
  },

  fiscalConfigs: INITIAL_FISCAL_CONFIGS,
  updateFiscalConfig: (id, c) => {
    const current = get().fiscalConfigs.find(x => x.id === id);
    const nextFiscalConfigs = get().fiscalConfigs.map(x => x.id === id ? { ...x, ...c } : x);
    const nextStoreConfig = { ...get().storeConfig, fiscalConfigs: nextFiscalConfigs };
    set({ fiscalConfigs: nextFiscalConfigs, storeConfig: nextStoreConfig as any });
    if (current && (
      c.type !== undefined || c.prefix !== undefined || c.limit !== undefined ||
      c.active !== undefined || c.current !== undefined
    )) {
      invalidateNcfRange(current.type);
    }
    pushStoreConfigToSupabase(nextStoreConfig as any).catch(() => {});
  },
  getNextNCF: async (type) => {
    return withNcfLock(async () => {
      const config = get().fiscalConfigs.find(c => c.type === type && c.active);
      if (!config) return undefined;

      const ranges = loadNcfRanges();
      const local = ranges[type];
      if (
        local &&
        local.fiscalType === type &&
        local.prefix === config.prefix &&
        Number.isFinite(local.next) &&
        Number.isFinite(local.end) &&
        local.next <= local.end &&
        local.next <= Number(config.limit)
      ) {
        const number = local.next;
        saveNcfRanges({
          ...ranges,
          [type]: { ...local, next: number + 1 }
        });
        set(state => {
          const nextFiscalConfigs = state.fiscalConfigs.map(c =>
            c.id === config.id
              ? { ...c, current: Math.max(Number(c.current) || 1, number + 1) }
              : c
          );
          return {
            fiscalConfigs: nextFiscalConfigs,
            storeConfig: { ...state.storeConfig, fiscalConfigs: nextFiscalConfigs } as any
          };
        });
        return `${local.prefix}${number.toString().padStart(8, '0')}`;
      }

      // Sin un rango reservado no inventamos folios localmente. Una tablet que
      // entra offline con su rango agotado simplemente esperará a tener red;
      // esto evita duplicados fiscales entre terminales.
      if (typeof navigator !== 'undefined' && !navigator.onLine) return undefined;

      const userId = get().currentUser?.id;
      if (!userId) return undefined;

      const reservation = await callReserveNCFRangeRPC({
        fiscalType: type,
        deviceId: getNcfDeviceId(),
        blockSize: 100,
        userId
      });
      if (!reservation.success || !reservation.data) {
        useStore.getState().addNotification(
          'No se pudo reservar un rango fiscal para la venta.',
          'warning',
          reservation.error || 'Intente de nuevo con conexión disponible.'
        );
        return undefined;
      }

      const data = reservation.data;
      const start = Number(data.start_number);
      const end = Number(data.end_number);
      const prefix = String(data.prefix || config.prefix || '');
      if (!prefix || !Number.isFinite(start) || !Number.isFinite(end) || start > end) return undefined;

      saveNcfRanges({
        ...loadNcfRanges(),
        [type]: {
          rangeId: String(data.range_id || crypto.randomUUID()),
          fiscalType: type,
          prefix,
          next: start + 1,
          end
        }
      });

      set(state => {
        const nextFiscalConfigs = state.fiscalConfigs.map(c =>
          c.id === config.id
            ? { ...c, prefix, current: Math.max(Number(c.current) || 1, end + 1), limit: Math.max(Number(c.limit) || end, end) }
            : c
        );
        return {
          fiscalConfigs: nextFiscalConfigs,
          storeConfig: { ...state.storeConfig, fiscalConfigs: nextFiscalConfigs } as any
        };
      });

      return `${prefix}${start.toString().padStart(8, '0')}`;
    });
  },

  demandForecasts: [],
  updateForecasts: (f) => set({ demandForecasts: f }),

  receiptConfig: {
    showLogo: true,
    showAddress: true,
    showPhone: true,
    showFooter: true,
    footerText: "¡GRACIAS POR SU PREFERENCIA!",
    businessName: "MARÉ",
    businessAddress: "Calle Principal #123, Cuba",
    businessPhone: "+53 000-0000",
    printerWidth: "58mm",
    openDrawer: true,
    autoPrint: true,
  },
  updateReceiptConfig: (config) => {
    set((state) => ({
      receiptConfig: { ...state.receiptConfig, ...config }
    }));
    const full = get().receiptConfig;
    pushReceiptConfigToSupabase(full).catch(() => {});
  },

  salarySettlements: [],
  addSalarySettlement: (settlement) => {
    set((state) => ({
      salarySettlements: [settlement, ...state.salarySettlements]
    }));
    import('../services/supabaseSync').then(({ pushSalarySettlementToSupabase }) => {
      pushSalarySettlementToSupabase(settlement).catch(() => {});
    }).catch(() => {});
  },
  updateSalarySettlement: (id, settlement) => {
    set((state) => ({
      salarySettlements: state.salarySettlements.map(s => s.id === id ? { ...s, ...settlement } : s)
    }));
    const updated = get().salarySettlements.find(s => s.id === id);
    if (updated) {
      import('../services/supabaseSync').then(({ pushSalarySettlementToSupabase }) => {
        pushSalarySettlementToSupabase(updated).catch(() => {});
      }).catch(() => {});
    }
  },
  addCashMovement: async (sessionId, movement) => {
    set((state) => ({
      cashSessions: state.cashSessions.map(s =>
        s.id === sessionId ? { ...s, movements: [...(s.movements || []), movement] } : s
      )
    }));
    const updated = get().cashSessions.find(s => s.id === sessionId);
    if (!updated) return;

    const actionId = `cash-movement:${sessionId}:${movement.id}`;
    await enqueueOfflineItem('cash_session', updated, actionId);

    if (navigator.onLine) {
      const synced = await pushCashSessionToSupabase(updated);
      // Solo retiramos la operación cuando el snapshot fue confirmado. Si falla,
      // pushCashSessionToSupabase deja una operación durable para replay.
      if (synced) removeFromOfflineQueueByAction('cash_session', actionId);
      else console.warn('[addCashMovement] Movimiento no confirmado; permanece protegido para replay.');
      return synced;
    }
    return true;
  },
  removeCashMovement: async (sessionId, movementId) => {
    set((state) => ({
      cashSessions: (state.cashSessions || []).map(s => {
        if (s.id !== sessionId) return s;
        const baseNotes = s.notes?.includes('__META__:') ? s.notes.split('__META__:')[0].trim() : (s.notes || '');
        const existingRemoved = (() => {
          try {
            const raw = s.notes?.includes('__META__:') ? JSON.parse(s.notes.split('__META__:').slice(1).join('__META__:')) : null;
            return Array.isArray(raw?.removed_movement_ids) ? raw.removed_movement_ids.map(String) : [];
          } catch { return []; }
        })();
        const removedMovementIds = Array.from(new Set([...existingRemoved, String(movementId)]));
        const nextNotes = `${baseNotes}${baseNotes ? ' ' : ''}__META__:${JSON.stringify({
          closing_balances: s.closingBalances || [],
          closing_date: s.closingDate || null,
          movements: (s.movements || []).filter(m => m.id !== movementId),
          removed_movement_ids: removedMovementIds
        })}`;
        return {
          ...s,
          notes: nextNotes,
          movements: (s.movements || []).filter(m => m.id !== movementId)
        };
      })
    }));
    const updated = get().cashSessions.find(s => s.id === sessionId);
    if (!updated) return;

    const actionId = `cash-movement-remove:${sessionId}:${movementId}`;
    await enqueueOfflineItem('cash_session', updated, actionId);

    if (navigator.onLine) {
      const synced = await pushCashSessionToSupabase(updated);
      if (synced) removeFromOfflineQueueByAction('cash_session', actionId);
      else console.warn('[removeCashMovement] Eliminación de movimiento no confirmada; permanece protegida para replay.');
      return synced;
    }
    return true;
  },

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

  bankCards: INITIAL_BANK_CARDS,
  addBankCard: (card) => {
    set(state => {
      // Deduplicación por ID, Número de Cuenta o Nombre+Banco
      const isDuplicate = state.bankCards.some(c => 
        c.id === card.id || 
        (c.accountNumber && card.accountNumber && c.accountNumber === card.accountNumber) ||
        (c.name.toLowerCase().trim() === card.name.toLowerCase().trim() && c.bankName?.toLowerCase().trim() === card.bankName?.toLowerCase().trim())
      );
      if (isDuplicate) return state;
      return { bankCards: [...state.bankCards, card] };
    });
    pushBankCardToSupabase(card).catch(() => {});
  },
  updateBankCard: (id, card) => {
    let found: import('../types').BankCard | undefined;
    let previousBalance = 0;
    let requestedBalance: number | undefined;
    set(state => {
      const updated = state.bankCards.map(c => {
        if (c.id !== id) return c;
        previousBalance = Number(c.balance) || 0;
        requestedBalance = card.balance !== undefined && Number.isFinite(Number(card.balance))
          ? Number(card.balance)
          : undefined;
        const next = {
          ...c,
          ...card,
          balance: requestedBalance !== undefined ? requestedBalance : c.balance
        };
        found = next;
        return next;
      });
      return { bankCards: updated };
    });
    if (!found) return;

    const metadata = { ...found };
    delete (metadata as any).balance;
    updateBankCardMetadataToSupabase(metadata as import('../types').BankCard).then(ok => {
      if (!ok) {
        enqueueOfflineItem('bank_card', { ...metadata, __metadata_only: true }, 'bank-metadata:' + metadata.id)
          .catch(err => console.warn('[Bank] metadata queue failed:', err));
      }
    }).catch(err => {
      console.warn('[Bank] metadata update failed:', err);
      enqueueOfflineItem('bank_card', { ...metadata, __metadata_only: true }, 'bank-metadata:' + metadata.id)
        .catch(queueErr => console.warn('[Bank] metadata queue failed:', queueErr));
    });

    if (requestedBalance !== undefined && requestedBalance !== previousBalance) {
      const actionId = 'bank-balance:' + id + ':' + crypto.randomUUID();
      const balancePayload = {
        id,
        expectedBalance: previousBalance,
        newBalance: requestedBalance,
        __balance_only: true
      };
      enqueueOfflineItem('bank_card_balance', balancePayload, actionId).then(async () => {
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          const synced = await setBankCardBalanceToSupabase(id, previousBalance, requestedBalance);
          if (synced) {
            removeFromOfflineQueueByAction('bank_card_balance', actionId);
          } else {
            // Otro movimiento pudo cambiar el saldo. Recuperamos el saldo canónico
            // en vez de dejar la UI afirmando un valor que ya no existe en servidor.
            const remote = await pullBankDataFromSupabase();
            if (remote.success) {
              set({ bankCards: remote.bankCards, bankTransactions: remote.bankTransactions });
            }
          }
        }
      }).catch(async err => {
        console.warn('[Bank] balance queue failed:', err);
        const remote = await pullBankDataFromSupabase();
        if (remote.success) {
          set({ bankCards: remote.bankCards, bankTransactions: remote.bankTransactions });
        }
      });
    }
  },
  deleteBankCard: async (id) => {
    const card = get().bankCards.find(c => c.id === id);
    if (!card) return true;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      get().addNotification('No se puede eliminar una cuenta bancaria sin conexión. Conéctate para validar su historial y evitar borrar datos remotos.', 'warning');
      return false;
    }

    try {
      const res = await callDeleteBankCardRPC(id);
      if (!res.success) {
        get().addNotification(res.error || 'No se pudo eliminar la cuenta bancaria.', 'error');
        return false;
      }
      set(state => ({ bankCards: state.bankCards.filter(c => c.id !== id) }));
      return true;
    } catch (e: any) {
      get().addNotification(e?.message || 'No se pudo eliminar la cuenta bancaria.', 'error');
      return false;
    }
  },

  bankTransactions: [],
  addBankTransaction: async (transaction) => {
    const existing = (get().bankTransactions || []).some(t =>
      t.id === transaction.id ||
      (transaction.transactionId && t.transactionId && t.cardId === transaction.cardId && t.transactionId === transaction.transactionId) ||
      (transaction.reference && t.reference && t.reference === transaction.reference && t.cardId === transaction.cardId)
    );
    if (existing) return true;

    const actionId = 'bank-transaction:' + transaction.id;
    await enqueueOfflineItem('bank_transaction', transaction, actionId);

    const applyLocalOptimisticBankTransaction = () => {
      set(state => {
        const duplicate = (state.bankTransactions || []).some(t =>
          t.id === transaction.id ||
          (transaction.transactionId && t.transactionId && t.transactionId === transaction.transactionId) ||
          (transaction.reference && t.reference && t.reference === transaction.reference && t.cardId === transaction.cardId)
        );
        if (duplicate) return state;

        const updatedCards = (state.bankCards || []).map(card => {
          if (card.id !== transaction.cardId) return card;
          const delta =
            (transaction.type === 'deposit' || transaction.type === 'payment_received')
              ? transaction.amount
              : (transaction.type === 'withdrawal' || transaction.type === 'supplier_payment')
                ? -transaction.amount
                : 0;
          return { ...card, balance: Math.max(0, card.balance + delta) };
        });

        return {
          bankTransactions: [transaction, ...(state.bankTransactions || [])],
          bankCards: updatedCards
        };
      });
    };

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const res = await callProcessBankTransactionRPC(transaction);
        if (!res.success) {
          const code = String(res.errorCode || '');
          const permanentCodes = new Set(['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT']);
          if (permanentCodes.has(code)) {
            await removeFromOfflineQueueByAction('bank_transaction', actionId);
            await useStore.getState().reconcileBankBalances();
            get().addNotification(res.error || 'El movimiento bancario fue rechazado por el servidor.', 'error');
            return false;
          }
          throw new Error(res.error || 'No se pudo confirmar el movimiento bancario');
        }

        const queued = getOfflineQueue().find(item => item.type === 'bank_transaction' && item.actionId === actionId);
        if (queued) await removeFromOfflineQueue(queued.id);

        const data = res.data || {};
        const balance = Number(data.balance);
        set(state => ({
          bankTransactions: [transaction, ...(state.bankTransactions || []).filter(t => t.id !== transaction.id)],
          bankCards: (state.bankCards || []).map(card =>
            card.id === transaction.cardId && Number.isFinite(balance)
              ? { ...card, balance }
              : card
          )
        }));
        return true;
      } catch (err: any) {
        // Timeout/corte de red después de enviar el movimiento: el servidor
        // puede haberlo aplicado. Conservamos la misma operación en la cola y
        // mostramos el estado local como pendiente, para impedir un segundo
        // movimiento manual con otro ID.
        applyLocalOptimisticBankTransaction();
        get().addNotification(
          'Movimiento bancario guardado localmente y pendiente de confirmación con la nube.',
          'info',
          err?.message || 'La respuesta del servidor no pudo confirmarse.'
        );
        return true;
      }
    }

    applyLocalOptimisticBankTransaction();
    get().addNotification('Movimiento bancario guardado offline; queda pendiente de sincronización.', 'info');
    return true;
  },

  deleteBankTransaction: async (id) => {
    const tx = get().bankTransactions.find(t => t.id === id);
    if (!tx) return true;

    const operationId =
      tx.transactionId ||
      ((/:OUT$|:IN$/i).test(tx.id) ? tx.id.replace(/:(OUT|IN)$/i, '') : null);

    const hasTransferSuffix = /:(OUT|IN)$/i.test(tx.id);
    const hasInternalPair = Boolean(operationId && get().bankTransactions.some(other =>
      other.id !== tx.id &&
      other.transactionId === operationId &&
      (
        (tx.type === 'withdrawal' && other.type === 'deposit') ||
        (tx.type === 'deposit' && other.type === 'withdrawal')
      )
    ));
    const isInternal = hasTransferSuffix || hasInternalPair;

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      const res = isInternal
        ? await callDeleteBankInternalTransferRPC(operationId!)
        : await callDeleteBankTransactionRPC(id);

      if (!res.success) {
        get().addNotification(res.error || 'No se pudo eliminar el movimiento bancario.', 'error');
        return false;
      }

      set(state => {
        if (isInternal) {
          const targetIds = new Set(
            (state.bankTransactions || [])
              .filter(t =>
                (t.transactionId && t.transactionId === operationId) ||
                t.id === operationId + ':OUT' ||
                t.id === operationId + ':IN'
              )
              .map(t => t.id)
          );
          const data = res.data || {};
          const fromBalance = Number(data.from_balance);
          const toBalance = Number(data.to_balance);
          return {
            bankTransactions: state.bankTransactions.filter(t => !targetIds.has(t.id)),
            bankCards: state.bankCards.map(card => {
              if (card.id === data.from_card_id && Number.isFinite(fromBalance)) return { ...card, balance: fromBalance };
              if (card.id === data.to_card_id && Number.isFinite(toBalance)) return { ...card, balance: toBalance };
              return card;
            })
          };
        }

        const data = res.data || {};
        const cardId = data.card_id || tx.cardId;
        const balance = Number(data.balance);
        return {
          bankTransactions: state.bankTransactions.filter(t => t.id !== id),
          bankCards: state.bankCards.map(card =>
            card.id === cardId && Number.isFinite(balance) ? { ...card, balance } : card
          )
        };
      });
      return true;
    }

    try {
      if (isInternal) {
        const pair = get().bankTransactions.filter(t =>
          (t.transactionId && t.transactionId === operationId) ||
          t.id === operationId + ':OUT' ||
          t.id === operationId + ':IN'
        );
        const outTx = pair.find(t => t.type === 'withdrawal');
        const inTx = pair.find(t => t.type === 'deposit');
        if (!outTx || !inTx) {
          get().addNotification('La transferencia bancaria interna está incompleta; no se puede eliminar offline.', 'error');
          return false;
        }
        await enqueueOfflineItem(
          'bank_internal_transfer_delete',
          { operationId },
          'bank-delete-transfer:' + operationId
        );
        set(state => ({
          bankTransactions: state.bankTransactions.filter(t =>
            !(t.transactionId && t.transactionId === operationId) &&
            t.id !== operationId + ':OUT' &&
            t.id !== operationId + ':IN'
          ),
          bankCards: state.bankCards.map(card => {
            if (card.id === outTx.cardId) return { ...card, balance: card.balance + outTx.amount };
            if (card.id === inTx.cardId) return { ...card, balance: Math.max(0, card.balance - inTx.amount) };
            return card;
          })
        }));
        get().addNotification('Transferencia bancaria eliminada offline; la reversión quedó en la cola de sincronización.', 'info');
        return true;
      }

      await enqueueOfflineItem(
        'bank_transaction_delete',
        { id },
        'bank-delete:' + id
      );

      set(state => ({
        bankTransactions: state.bankTransactions.filter(t => t.id !== id),
        bankCards: state.bankCards.map(card => {
          if (card.id !== tx.cardId) return card;
          const next =
            (tx.type === 'deposit' || tx.type === 'payment_received')
              ? card.balance - tx.amount
              : (tx.type === 'withdrawal' || tx.type === 'supplier_payment')
                ? card.balance + tx.amount
                : card.balance;
          return { ...card, balance: Math.max(0, next) };
        })
      }));
      get().addNotification('Movimiento eliminado offline; la reversión quedó en la cola de sincronización.', 'info');
      return true;
    } catch (e: any) {
      get().addNotification(e?.message || 'No se pudo guardar la eliminación en la cola offline.', 'error');
      return false;
    }
  },

  reconcileBankBalances: async () => {
    const state = get();
    const seenIds = new Set<string>();
    const seenTxIds = new Set<string>();
    const seenRefs = new Set<string>();
    const uniqueTxs: import('../types').BankTransaction[] = [];
    let removedDuplicates = 0;

    // Local de-duplication only. Never delete cloud data from a potentially
    // partial local snapshot; cloud reconciliation must be explicit and verified.
    for (const bt of state.bankTransactions || []) {
      const isDuplicate =
        seenIds.has(bt.id) ||
        (bt.transactionId && seenTxIds.has(bt.cardId + '::' + bt.transactionId)) ||
        (bt.reference && seenRefs.has(`${bt.cardId}::${bt.reference}`));

      if (isDuplicate) {
        removedDuplicates++;
        continue;
      }

      seenIds.add(bt.id);
      if (bt.transactionId) seenTxIds.add(bt.cardId + '::' + bt.transactionId);
      if (bt.reference) seenRefs.add(`${bt.cardId}::${bt.reference}`);
      uniqueTxs.push(bt);
    }

    if (removedDuplicates > 0) set({ bankTransactions: uniqueTxs });

    const totalSales = state.transactions.length;
    const totalMovements = uniqueTxs.length;

    return {
      removedDuplicates,
      totalSales,
      totalMovements,
      message: `Reconciliación local completada: ${totalSales} ventas y ${totalMovements} movimientos bancarios verificados. Los duplicados locales no se eliminaron físicamente de la nube.`
    };
  },

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
  notifications: [],
  addNotification: (message, type = 'info', details) => {
    const id = crypto.randomUUID();
    set(state => ({
      notifications: [...state.notifications, { id, message, type, ...(details ? { details } : {}) }]
    }));
    setTimeout(() => {
      set(state => ({
        notifications: state.notifications.filter(n => n.id !== id)
      }));
    }, details ? 15000 : 4000);
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
    useStore.setState({ isInitialized: true });

    // Recuperación crítica del POS offline:
    // la cola durable (IndexedDB/localStorage) puede contener una venta que
    // todavía no estaba incluida en el último snapshot de Zustand. Debemos
    // reconstruirla después de que la cola termine de hidratarse y antes de
    // que el POS haga refrescos remotos que puedan reemplazar el historial local.
    void waitForOfflineQueueReady()
      .then(() => useStore.getState().restoreTransactionsFromBackup())
      .catch((restoreError) => {
        console.error('[Store] No se pudieron recuperar las ventas offline:', restoreError);
      });
  },
  partialize: (state) => ({
    users: state.users, currentUser: state.currentUser,
    currencies: state.currencies, storeConfig: state.storeConfig,
    branches: state.branches, currentBranchId: state.currentBranchId, activeSessionId: state.activeSessionId, categories: state.categories,
    products: state.products, inventory: state.inventory, cart: state.cart, currentCustomerId: state.currentCustomerId,
    transactions: state.transactions, returns: state.returns, warranties: state.warranties,
    cashSessions: state.cashSessions, transfers: state.transfers, suppliers: state.suppliers,
    supplierOrders: state.supplierOrders, inventoryAudits: state.inventoryAudits, salarySettlements: state.salarySettlements,
    quotes: state.quotes, timeShifts: state.timeShifts, pendingOrders: state.pendingOrders, receiptConfig: state.receiptConfig,
    fiscalConfigs: state.fiscalConfigs, bankCards: state.bankCards
  })
}
));
