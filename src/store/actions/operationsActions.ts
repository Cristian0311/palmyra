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
  deleteBankTransactionFromSupabase, clearSelectedDataFromSupabase, callOpenSessionRPCWithId, callProcessTransactionRPC, callVoidTransactionRPC, callCompleteReturnRPC, callTransferInventoryRPC, callReceiveSupplierOrderRPC, callStartInventoryAuditRPC, callSaveInventoryAuditCountRPC, callRequestInventoryAuditRecountRPC, callApproveInventoryAuditRPC, callDeleteInventoryAuditRPC, callCompleteInventoryAuditRPC, callCloseSessionRPC, callCancelSessionRPC, callDeleteBankInternalTransferRPC, callDeleteBankTransactionRPC, callDeleteBankCardRPC, callProcessBankTransactionRPC
} from '../../services/supabaseSync';
import { getSupabaseCredentials } from '../../lib/supabase';
import { loadSaaSContext, signInSaaSAccount, signOutSaaSAccount } from '../../services/saas';
import { getOfflineQueue, enqueueOfflineItem, removeFromOfflineQueue, waitForOfflineQueueReady } from '../../services/offlineQueue';
import { normalizeSemanticText, areSemanticallyEqual } from '../../utils/textUtils';
import { localStateStorage, clearLocalStateStorage, flushLocalStateStorage } from '../../services/localStateStorage';
import { getPalmyraScopedStorageKey } from '../../services/localScope';
import { isCloudBusinessSyncAllowed } from '../../services/localPlanMode';
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


type StoreSet = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
type StoreGet = () => AppState;

export function createOperationsActions(set: StoreSet, get: StoreGet): any {
  return {
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
    if (isCloudBusinessSyncAllowed()) pushSupplierToSupabase(newSupplier).catch(() => {});
  },
  updateSupplier: (id, s) => {
    set(state => ({ suppliers: state.suppliers.map(x => x.id === id ? { ...x, ...s } : x) }));
    const updated = get().suppliers.find(x => x.id === id);
    if (updated && isCloudBusinessSyncAllowed()) pushSupplierToSupabase(updated).catch(() => {});
  },
  deleteSupplier: (id) => {
    set(state => ({ suppliers: state.suppliers.filter(x => x.id !== id) }));
    const actionId = 'supplier-delete:' + id;
    const queueDeletion = () => enqueueOfflineItem('supplier_delete', { id }, actionId)
      .catch((error) => console.warn('[PALMYRA] No se pudo guardar la eliminación de proveedor en la cola:', error));
    if (typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed()) {
      deleteSupplierFromSupabase(id).then((ok) => {
        if (!ok) queueDeletion();
      }).catch(() => queueDeletion());
    } else {
      queueDeletion();
    }
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
    if (audit.reviewStatus === 'approved') return { success: true };
    if (audit.reviewStatus !== 'pending_approval') return { success: false, error: 'El conteo aún no está pendiente de aprobación.' };

    const userId = get().currentUser?.id || 'system';
    const actionId = 'audit-approve:' + id;
    const branchId = audit.branchId;
    const postedAt = new Date().toISOString();

    // Los ajustes se derivan del conteo: counted - expected por producto/variante.
    // Las líneas sin conteo (null) no se tocan.
    const diffs = (audit.items || [])
      .filter((it: any) => it && it.counted !== null && it.counted !== undefined && Number.isFinite(Number(it.counted)))
      .map((it: any) => ({
        productId: it.productId,
        variantLabel: it.variantLabel || '',
        counted: Math.max(0, Number(it.counted) || 0),
        delta: Math.max(0, Number(it.counted) || 0) - (Number(it.expected) || 0),
        minQuantity: typeof it.minQuantity === 'number' ? it.minQuantity : undefined
      }));

    const alreadyPosted = Boolean(audit.adjustmentPostedAt);
    if (!alreadyPosted) {
      set(state => {
        const inventory = [...state.inventory];
        for (const d of diffs) {
          if (d.delta === 0) continue;
          const idx = inventory.findIndex(i => i.productId === d.productId && i.branchId === branchId && (i.variantLabel || '') === d.variantLabel);
          if (idx >= 0) {
            inventory[idx] = { ...inventory[idx], quantity: Math.max(0, Number(inventory[idx].quantity || 0) + d.delta) };
          } else if (d.counted > 0) {
            inventory.push({ id: crypto.randomUUID(), productId: d.productId, branchId, quantity: d.counted, minQuantity: d.minQuantity ?? 5, variantLabel: d.variantLabel });
          }
        }
        return {
          inventory,
          inventoryAudits: state.inventoryAudits.map(a => a.id === id
            ? { ...a, status: 'completed' as const, reviewStatus: 'approved', reviewedBy: userId, reviewedAt: postedAt, adjustmentPostedAt: postedAt, notes: notes || a.notes }
            : a)
        };
      });
    }

    await enqueueOfflineItem('audit_approve', { id, userId, notes }, actionId)
      .catch(() => undefined);

    // La RPC de aprobación solo cambia el estado remoto; el stock se publica
    // por variante con la RPC idempotente de ajuste.
    let queuedAdjustments = 0;
    for (const d of diffs) {
      if (d.delta === 0) continue;
      const result = await applyInventoryAdjustmentToSupabase({
        operationId: `audit-approve:${id}:${d.productId}:${d.variantLabel || 'base'}`,
        productId: d.productId,
        branchId,
        variantLabel: d.variantLabel || undefined,
        delta: d.delta,
        minQuantity: d.minQuantity,
        userId,
        movementType: 'Ajuste por auditoría física'
      });
      if (!result.success) queuedAdjustments += 1;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const res = await callApproveInventoryAuditRPC(id, userId, notes);
        if (!res.success) throw new Error(res.error || 'No se pudo aprobar la auditoría');
        removeFromOfflineQueueByAction('audit_approve', actionId);
        if (queuedAdjustments > 0) {
          get().addNotification('Auditoría aprobada; el ajuste de stock quedó pendiente de sincronizar.', 'info');
        }
        return { success: true };
      } catch (err: any) {
        // La aprobación queda protegida en la cola durable hasta recibir confirmación.
        console.warn('[approveInventoryAudit] Aprobación no confirmada; queda durable:', err);
        get().addNotification('Auditoría aprobada localmente; queda pendiente de sincronizar con la nube.', 'info');
        return { success: true, pending: true };
      }
    }

    get().addNotification('Auditoría aprobada offline; el ajuste de stock se sincronizará al reconectar.', 'info');
    return { success: true, pending: true };
  },
  deleteInventoryAudit: async (id) => {
    const audit = get().inventoryAudits.find(a => a.id === id);
    if (!audit) return { success: true };
    if (audit.reviewStatus === 'approved' || audit.status === 'completed') {
      return { success: false, error: 'Las auditorías aprobadas conservan el ajuste de stock y no se pueden eliminar.' };
    }

    const { markAuditPendingDeletion, clearAuditPendingDeletion } = await import('../utils/mergeInventoryAudits');
    markAuditPendingDeletion(id);
    set(state => ({ inventoryAudits: state.inventoryAudits.filter(a => a.id !== id) }));

    const actionId = 'audit-delete:' + id;
    const queueDelete = () => enqueueOfflineItem('audit_delete', { id }, actionId).catch(() => undefined);

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const res = await callDeleteInventoryAuditRPC(id);
        if (!res.success) throw new Error(res.error || 'No se pudo eliminar la auditoría');
        clearAuditPendingDeletion(id);
        return { success: true };
      } catch (err: any) {
        console.warn('[deleteInventoryAudit] Eliminación no confirmada; queda durable:', err);
        await queueDelete();
        get().addNotification('Auditoría eliminada localmente; se confirmará al reconectar.', 'info');
        return { success: true, pending: true };
      }
    }

    await queueDelete();
    return { success: true, pending: true };
  },
  };
}
