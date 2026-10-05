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
  
  products: INITIAL_PRODUCTS,
  inventory: INITIAL_INVENTORY,
  addProduct: (product, initialQuantity, branchId, variantLabel, initialVariantQuantities) => {
    const state = get();
    const targetBranch = branchId || state.currentBranchId;
    const warehouseAvailable = Boolean(targetBranch) && (state.branches || []).some(b => b.id === targetBranch && (b.isActive !== false));
    if (!warehouseAvailable) {
      get().addNotification("No se puede crear el producto sin un almacén activo.", "error", "Primero crea o selecciona un almacén y luego registra el producto.");
      return;
    }
    let newInventoryEntries: InventoryLevel[] = [];
    
    if (initialVariantQuantities && Object.keys(initialVariantQuantities).length > 0) {
      Object.entries(initialVariantQuantities).forEach(([vLabel, qty]) => {
        if (Number(qty) > 0) {
          newInventoryEntries.push({ id: crypto.randomUUID(), productId: product.id, branchId: targetBranch, quantity: Number(qty), minQuantity: 5, variantLabel: vLabel });
        }
      });
    } else if (initialQuantity && initialQuantity > 0) {
      newInventoryEntries.push({ id: crypto.randomUUID(), productId: product.id, branchId: targetBranch, quantity: initialQuantity, minQuantity: 5, variantLabel });
    }

    let added = false;
    set((state) => {
      // Deduplicación por ID, SKU o Nombre (ignoring case)
      const isDuplicate = state.products.some(p => 
        p.id === product.id || 
        (p.sku && product.sku && p.sku.toLowerCase().trim() === product.sku.toLowerCase().trim()) ||
        (p.name.toLowerCase().trim() === product.name.toLowerCase().trim())
      );
      if (isDuplicate) return state;
      added = true;
      return {
        products: [product, ...state.products],
        inventory: [...state.inventory, ...newInventoryEntries]
      };
    });

    if (!added) return;

    // Producto y stock inicial se sincronizan como operaciones independientes.
    pushProductToSupabase(product).catch(() => {});
    for (const inv of newInventoryEntries) {
      const op = { operationId: `invrec:${crypto.randomUUID()}`, productId: inv.productId, branchId: inv.branchId, variantLabel: inv.variantLabel || '', expectedQuantity: 0, newQuantity: inv.quantity, quantity: inv.quantity, minQuantity: inv.minQuantity, userId: get().currentUser?.id || undefined };
      if (typeof navigator !== 'undefined' && !navigator.onLine) enqueueOfflineItem('inventory_reconcile', op, op.operationId);
      else reconcileInventoryToSupabase(op).then(res => { if (!res.success || res.conflict) enqueueOfflineItem('inventory_reconcile', op, op.operationId); }).catch(() => enqueueOfflineItem('inventory_reconcile', op, op.operationId));
    }
  },
  updateProduct: (id, product) => {
    set((state) => ({
      products: state.products.map(p => p.id === id ? { ...p, ...product } : p)
    }));
    const updated = get().products.find(p => p.id === id);
    if (updated) pushProductToSupabase(updated);
  },
  deleteProduct: (id) => {
    const productId = String(id || '').trim();
    if (!productId) return;

    // El borrado es físico: desaparece del catálogo y del stock local de inmediato.
    set((state) => ({
      products: (state.products || []).filter(p => p.id !== productId),
      inventory: (state.inventory || []).filter(i => i.productId !== productId)
    }));

    // Una eliminación siempre tiene precedencia sobre una edición del mismo producto.
    removeFromOfflineQueueByAction('product', productId);
    const deleteActionId = 'product-delete:' + productId;

    const deleteRemotely = async () => {
      const ok = await deleteProductFromSupabase(productId);
      if (!ok) {
        await enqueueOfflineItem('product_delete', { id: productId }, deleteActionId);
      } else {
        removeFromOfflineQueueByAction('product_delete', deleteActionId);
      }
    };

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      deleteRemotely().catch(async () => {
        await enqueueOfflineItem('product_delete', { id: productId }, deleteActionId);
      });
    } else {
      enqueueOfflineItem('product_delete', { id: productId }, deleteActionId).catch(() => {});
    }
  },
  transferInventory: async (productId, fromBranchId, toBranchId, quantity, variantLabel, transactionId) => {
    const res = await get().transferInventoryBatch(
      productId,
      fromBranchId,
      toBranchId,
      [{ variantLabel: variantLabel || '', quantity }],
      transactionId
    );
    return res.success;
  },

  transferInventoryBatch: async (productId, fromBranchId, toBranchId, variants, transactionId, batchId) => {
    if (!productId || !fromBranchId || !toBranchId) return { success: false, error: 'Información incompleta para realizar la transferencia.' };
    if (fromBranchId === toBranchId) return { success: false, error: 'La sucursal de origen y destino no pueden ser la misma.' };

    const activeVariants = (variants || [])
      .map(v => ({ variantLabel: String(v?.variantLabel || '').trim(), quantity: Number(v?.quantity) }))
      .filter(v => Number.isInteger(v.quantity) && v.quantity > 0);

    if (activeVariants.length === 0) return { success: false, error: 'Debes indicar una cantidad entera mayor a 0 para transferir.' };

    const currentUserId = get().currentUser?.id;
    if (!currentUserId || !get().users.some(u => u.id === currentUserId)) {
      return { success: false, error: 'No hay un trabajador válido autenticado para realizar el traslado.' };
    }

    const stockCheck = validateTransferStock(get().inventory || [], 
      activeVariants.map(v => ({
        productId,
        branchId: fromBranchId,
        variantLabel: v.variantLabel,
        quantity: v.quantity
      }))
    );
    if (!stockCheck.ok) return { success: false, error: stockCheck.message };

    const operationId = transactionId || crypto.randomUUID();
    const userId = currentUserId;
    const serverPayload = { operationId, batchId: batchId || undefined, productId, fromBranchId, toBranchId, variants: activeVariants, userId };
    const actionId = 'transfer:' + operationId;

    await enqueueOfflineItem('transfer', serverPayload, actionId);

    let wasOnline = typeof navigator !== 'undefined' && navigator.onLine;
    let serverConfirmed = false;
    let canonicalRefreshed = false;

    if (wasOnline) {
      try {
        const res = await callTransferInventoryRPC(serverPayload);
        if (!res.success) {
          const code = String((res as any).errorCode || '');
          const permanentCodes = new Set(['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT']);
          if (permanentCodes.has(code)) {
            removeFromOfflineQueueByAction('transfer', actionId);
            return { success: false, error: res.error || 'La transferencia fue rechazada por el servidor' };
          }
          wasOnline = false;
        } else {
          serverConfirmed = true;
          canonicalRefreshed = await refreshInventoryBranchesFromSupabase([fromBranchId, toBranchId]);
          if (canonicalRefreshed) {
            removeFromOfflineQueueByAction('transfer', actionId);
          } else {
            wasOnline = false;
          }
        }
      } catch (err: any) {
        console.warn('[transferInventoryBatch] Fallo de transporte; operación durable queda pendiente:', err);
        wasOnline = false;
      }
    }

    if (!canonicalRefreshed && !serverConfirmed) {
      const newInventory = [...get().inventory];
      for (const v of activeVariants) {
        const sourceIdx = newInventory.findIndex(i =>
          i.productId === productId &&
          i.branchId === fromBranchId &&
          (i.variantLabel || '') === v.variantLabel
        );
        if (sourceIdx !== -1) {
          newInventory[sourceIdx] = {
            ...newInventory[sourceIdx],
            quantity: Math.max(0, Number(newInventory[sourceIdx].quantity) - v.quantity)
          };
        }

        const targetIdx = newInventory.findIndex(i =>
          i.productId === productId &&
          i.branchId === toBranchId &&
          (i.variantLabel || '') === v.variantLabel
        );
        if (targetIdx !== -1) {
          newInventory[targetIdx] = {
            ...newInventory[targetIdx],
            quantity: Number(newInventory[targetIdx].quantity) + v.quantity
          };
        } else {
          newInventory.push({
            id: crypto.randomUUID(),
            productId,
            branchId: toBranchId,
            variantLabel: v.variantLabel || undefined,
            quantity: v.quantity,
            minQuantity: 5
          });
        }
      }
      set({ inventory: newInventory });
    }

    const totalQuantity = activeVariants.reduce((sum, v) => sum + v.quantity, 0);
    const product = get().products.find(p => p.id === productId);
    const fromBranch = get().branches.find(b => b.id === fromBranchId);
    const toBranch = get().branches.find(b => b.id === toBranchId);
    const transferRecord: import('../types').InventoryTransfer = {
      id: operationId, operationId, productId, productName: product?.name || 'Producto',
      fromBranchId, fromBranchName: fromBranch?.name || 'Sucursal Origen',
      toBranchId, toBranchName: toBranch?.name || 'Sucursal Destino',
      quantity: totalQuantity, variants: activeVariants, date: new Date().toISOString(),
      userId, status: serverConfirmed && canonicalRefreshed ? 'completed' : 'pending',
      variantLabel: activeVariants.length === 1 ? (activeVariants[0].variantLabel || 'Producto Base') : activeVariants.map(v => v.variantLabel || 'Base').join(', '),
      transactionId, batchId
    };
    get().addTransfer(transferRecord);
    return { success: true, pending: !canonicalRefreshed };
  },

  reconcileProductStock: async (productId, corrections) => {
    const currentInventory = get().inventory;
    const newInventory = [...currentInventory];
    const operations: any[] = [];

    for (const item of corrections) {
      const vLabel = item.variantLabel || '';
      const existing = currentInventory.find(i => i.productId === productId && i.branchId === item.branchId && (i.variantLabel || '') === vLabel);
      const expectedQuantity = Number(existing?.quantity || 0);
      const nextQuantity = Math.max(0, item.quantity);
      const idx = newInventory.findIndex(i => i.productId === productId && i.branchId === item.branchId && (i.variantLabel || '') === vLabel);
      const next = idx !== -1
        ? { ...newInventory[idx], quantity: nextQuantity, minQuantity: item.minQuantity ?? newInventory[idx].minQuantity ?? 5 }
        : { id: crypto.randomUUID(), productId, branchId: item.branchId, variantLabel: vLabel || undefined, quantity: nextQuantity, minQuantity: item.minQuantity ?? 5 };
      if (idx !== -1) newInventory[idx] = next as InventoryLevel; else newInventory.push(next as InventoryLevel);
      operations.push({ operationId: `invrec:${crypto.randomUUID()}`, productId, branchId: item.branchId, variantLabel: vLabel, expectedQuantity, newQuantity: nextQuantity, quantity: nextQuantity, minQuantity: next.minQuantity, userId: get().currentUser?.id || undefined });
    }

    set({ inventory: newInventory });
    let needsRefresh = false;
    for (const op of operations) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await enqueueOfflineItem('inventory_reconcile', op, op.operationId);
        continue;
      }
      const res = await reconcileInventoryToSupabase(op);
      if (res.success && !res.conflict && Number.isFinite(Number(res.data?.quantity))) {
        set((state) => ({ inventory: setCanonicalInventoryQuantity(state.inventory || [], op.productId, op.branchId, op.variantLabel, Number(res.data.quantity)) }));
      }
      if (!res.success || res.conflict) {
        await enqueueOfflineItem('inventory_reconcile', op, op.operationId);
        needsRefresh = true;
      }
    }
    if (needsRefresh) await get().refreshBranchInventory().catch(err =>
      console.warn('[reconcileProductStock] No se pudo refrescar tras conflicto:', err)
    );
    return { success: true };
  },

  repairOrphanedInventoryLevels: async () => {
    const defaultBranchId = get().branches[0]?.id;
    if (!defaultBranchId) return { repaired: 0, message: 'No hay sucursales configuradas.' };

    let repairedCount = 0;
    set((state) => ({
      inventory: state.inventory.map(i => {
        if (!i.branchId) {
          repairedCount++;
          return { ...i, branchId: defaultBranchId };
        }
        return i;
      })
    }));

    return { repaired: repairedCount, message: `Se repararon ${repairedCount} registros huérfanos.` };
  },
  batchDeleteProducts: (ids) => {
    const productIds = Array.from(new Set((ids || []).map(String).map(x => x.trim()).filter(Boolean)));
    if (!productIds.length) return;
    set((state) => ({
      products: (state.products || []).filter(p => !productIds.includes(p.id)),
      inventory: (state.inventory || []).filter(i => !productIds.includes(i.productId))
    }));
    for (const productId of productIds) {
      removeFromOfflineQueueByAction('product', productId);
      const actionId = 'product-delete:' + productId;
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        deleteProductFromSupabase(productId).then(ok => {
          if (ok) removeFromOfflineQueueByAction('product_delete', actionId);
          else enqueueOfflineItem('product_delete', { id: productId }, actionId).catch(() => {});
        }).catch(() => enqueueOfflineItem('product_delete', { id: productId }, actionId).catch(() => {}));
      } else {
        enqueueOfflineItem('product_delete', { id: productId }, actionId).catch(() => {});
      }
    }
  },
  batchUpdateProducts: (ids, updates) => {
    set((state) => ({
      products: state.products.map(p => ids.includes(p.id) ? { ...p, ...updates } : p)
    }));

    // Las ediciones masivas también deben pasar por la misma capa durable que
    // una edición individual: online se confirma en Supabase y offline queda
    // en IndexedDB para reintento.
    for (const id of ids) {
      const updated = get().products.find(p => p.id === id);
      if (updated) pushProductToSupabase(updated).catch(() => {});
    }
  },
  adjustInventory: (productId, branchId, delta, variantLabel, minQuantity) => {
    const current = get().inventory.find(i => i.productId === productId && i.branchId === branchId && (i.variantLabel || '') === (variantLabel || ''));
    const currentQty = Number(current?.quantity || 0);
    const nextQty = Math.max(0, currentQty + delta);
    const operationId = `invadj:${crypto.randomUUID()}`;
    const payload = {
      operationId, productId, branchId, variantLabel: variantLabel || '', delta,
      minQuantity: minQuantity ?? current?.minQuantity ?? 5,
      userId: get().currentUser?.id || undefined, movementType: delta >= 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT'
    };
    set((state) => {
      const newInventory = [...state.inventory];
      const idx = newInventory.findIndex(i => i.productId === productId && i.branchId === branchId && (i.variantLabel || '') === (variantLabel || ''));
      if (idx !== -1) newInventory[idx] = { ...newInventory[idx], quantity: nextQty, minQuantity: payload.minQuantity };
      else if (nextQty > 0) newInventory.push({ id: crypto.randomUUID(), productId, branchId, quantity: nextQty, minQuantity: payload.minQuantity, variantLabel });
      return { inventory: newInventory };
    });
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      enqueueOfflineItem('inventory_adjustment', payload, operationId);
      return;
    }
    applyInventoryAdjustmentToSupabase(payload).then(async res => {
      if (res.success && !res.conflict) {
        const canonicalQuantity = Number(res.data?.quantity);
        if (Number.isFinite(canonicalQuantity)) {
          set((state) => ({ inventory: setCanonicalInventoryQuantity(state.inventory || [], productId, branchId, variantLabel, canonicalQuantity) }));
        } else {
          await get().refreshBranchInventory().catch(err =>
            console.warn('[adjustInventory] No se pudo refrescar tras confirmación:', err)
          );
        }
        return;
      }

      await enqueueOfflineItem('inventory_adjustment', payload, operationId);
      // En un conflicto multi-tablet, el stock local ya no es confiable:
      // vuelve a leer el valor canónico sin eliminar la operación pendiente.
      await get().refreshBranchInventory().catch(err =>
        console.warn('[adjustInventory] No se pudo refrescar tras conflicto:', err)
      );
    }).catch(async err => {
      await enqueueOfflineItem('inventory_adjustment', payload, operationId);
      console.warn('[adjustInventory] Ajuste pendiente por error de red:', err);
    });
  },
  setInventoryQuantity: (productId, branchId, quantity, variantLabel, minQuantity) => {
    const current = get().inventory.find(i => i.productId === productId && i.branchId === branchId && (i.variantLabel || '') === (variantLabel || ''));
    const expectedQuantity = Number(current?.quantity || 0);
    const newQuantity = Math.max(0, quantity);
    const operationId = `invrec:${crypto.randomUUID()}`;
    const payload = {
      operationId, productId, branchId, variantLabel: variantLabel || '', expectedQuantity,
      quantity: newQuantity, minQuantity: minQuantity ?? current?.minQuantity ?? 5,
      userId: get().currentUser?.id || undefined
    };
    set((state) => {
      const newInventory = [...state.inventory];
      const idx = newInventory.findIndex(i => i.productId === productId && i.branchId === branchId && (i.variantLabel || '') === (variantLabel || ''));
      if (idx !== -1) newInventory[idx] = { ...newInventory[idx], quantity: newQuantity, minQuantity: payload.minQuantity };
      else newInventory.push({ id: crypto.randomUUID(), productId, branchId, quantity: newQuantity, minQuantity: payload.minQuantity, variantLabel });
      return { inventory: newInventory };
    });
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      enqueueOfflineItem('inventory_reconcile', payload, operationId);
      return;
    }
    reconcileInventoryToSupabase({ ...payload, newQuantity }).then(async res => {
      if (res.success && !res.conflict && Number.isFinite(Number(res.data?.quantity))) {
        set((state) => ({ inventory: setCanonicalInventoryQuantity(state.inventory || [], productId, branchId, variantLabel, Number(res.data.quantity)) }));
      }
      if (!res.success || res.conflict) {
        await enqueueOfflineItem('inventory_reconcile', payload, operationId);
        await get().refreshBranchInventory();
      }
    }).catch(async () => {
      await enqueueOfflineItem('inventory_reconcile', payload, operationId);
      await get().refreshBranchInventory();
    });
  },

  transferProductsBulk: async (fromBranchId, toBranchId, items) => {
    const validItems = (items || [])
      .map(item => ({
        productId: item?.productId,
        variant: String(item?.variant || '').trim(),
        quantity: Number(item?.quantity)
      }))
      .filter(item => item.productId && Number.isInteger(item.quantity) && item.quantity > 0);

    if (validItems.length === 0) return { success: true, pending: false };
    if (!fromBranchId || !toBranchId || fromBranchId === toBranchId) {
      return { success: false, pending: false, error: 'Las sucursales de origen y destino deben ser válidas y diferentes.' };
    }

    const currentUserId = get().currentUser?.id;
    if (!currentUserId || !get().users.some(u => u.id === currentUserId)) {
      return { success: false, pending: false, error: 'No hay un trabajador válido autenticado para realizar el traslado.' };
    }

    const stockCheck = validateTransferStock(get().inventory || [], 
      validItems.map(item => ({
        productId: item.productId,
        branchId: fromBranchId,
        variantLabel: item.variant,
        quantity: item.quantity
      }))
    );
    if (!stockCheck.ok) return { success: false, pending: false, error: stockCheck.message };

    const batchId = crypto.randomUUID();
    const userId = currentUserId;
    const operations = validItems.map(item => ({
      operationId: crypto.randomUUID(),
      productId: item.productId,
      variants: [{ variantLabel: item.variant, quantity: item.quantity }]
    }));
    const queueData = {
      batchId,
      fromBranchId,
      toBranchId,
      userId,
      items: operations
    };
    const actionId = 'transfer-bulk:' + batchId;
    await enqueueOfflineItem('transfer_bulk', queueData, actionId);

    let canonicalRefreshed = false;
    let serverConfirmed = false;
    const online = typeof navigator !== 'undefined' && navigator.onLine;

    if (online) {
      try {
        const res = await callTransferInventoryBulkRPC(queueData);
        if (!res.success) {
          const code = String(res.errorCode || '');
          const permanentCodes = new Set(['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT']);
          if (permanentCodes.has(code)) {
            removeFromOfflineQueueByAction('transfer_bulk', actionId);
            return { success: false, pending: false, error: res.error || 'El traslado múltiple fue rechazado por el servidor.' };
          }
        } else {
          serverConfirmed = true;
          canonicalRefreshed = await refreshInventoryBranchesFromSupabase([fromBranchId, toBranchId]);
          if (canonicalRefreshed) removeFromOfflineQueueByAction('transfer_bulk', actionId);
        }
      } catch (err) {
        console.warn('[transferProductsBulk] La confirmación online no fue concluyente; queda durable:', err);
      }
    }

    if (!canonicalRefreshed && !serverConfirmed) {
      set(state => {
        const nextInventory = [...state.inventory];
        for (const item of validItems) {
          const label = item.variant || '';
          const idx = nextInventory.findIndex(i =>
            i.productId === item.productId &&
            i.branchId === fromBranchId &&
            (i.variantLabel || '') === label
          );
          if (idx >= 0) {
            nextInventory[idx] = { ...nextInventory[idx], quantity: Math.max(0, Number(nextInventory[idx].quantity || 0) - item.quantity) };
          }
          const targetIdx = nextInventory.findIndex(i =>
            i.productId === item.productId &&
            i.branchId === toBranchId &&
            (i.variantLabel || '') === label
          );
          if (targetIdx >= 0) {
            nextInventory[targetIdx] = { ...nextInventory[targetIdx], quantity: Number(nextInventory[targetIdx].quantity || 0) + item.quantity };
          } else {
            nextInventory.push({
              id: crypto.randomUUID(),
              productId: item.productId,
              branchId: toBranchId,
              variantLabel: label || undefined,
              quantity: item.quantity,
              minQuantity: 5
            });
          }
        }
        return { inventory: nextInventory };
      });
    }

    const batchRecords = validItems.map((item, index) => {
      const op = operations[index];
      const product = get().products.find(p => p.id === item.productId);
      const fromBranch = get().branches.find(b => b.id === fromBranchId);
      const toBranch = get().branches.find(b => b.id === toBranchId);
      return {
        id: op.operationId,
        operationId: op.operationId,
        productId: item.productId,
        productName: product?.name || 'Producto',
        fromBranchId,
        fromBranchName: fromBranch?.name || 'Sucursal Origen',
        toBranchId,
        toBranchName: toBranch?.name || 'Sucursal Destino',
        quantity: item.quantity,
        variants: op.variants,
        date: new Date().toISOString(),
        userId,
        status: serverConfirmed && canonicalRefreshed ? 'completed' as const : 'pending' as const,
        variantLabel: item.variant || 'Producto Base',
        batchId
      };
    });

    set(state => ({
      transfers: [
        ...batchRecords,
        ...(state.transfers || []).filter(existing => !batchRecords.some(r => (r.operationId || r.id) === (existing.operationId || existing.id)))
      ]
    }));

    return { success: true, pending: !canonicalRefreshed };
  },  
  cart: [],
  currentCustomerId: undefined,
  setCartCustomer: (customerId) => set({ currentCustomerId: customerId }),
  addToCart: (product, serialNumber, attributes, requestedQuantity = 1) => set((state) => {
    const quantity = Math.max(1, Math.floor(Number(requestedQuantity) || 1));
    const variantLabel = attributes?.variantLabel || attributes?.size || attributes?.color;

    // Batch normal-product additions into one state update. This is especially
    // important for voice commands like "agrega 15 blusas": one set() instead
    // of 15 React/store updates keeps low-end tablets responsive.
    if (!product.hasSerial && !serialNumber) {
      const existing = state.cart.find(item =>
        item.product.id === product.id &&
        !item.serialNumber &&
        item.selectedSize === attributes?.size &&
        item.selectedColor === attributes?.color &&
        (item.variantLabel || '') === (variantLabel || '')
      );

      if (existing) {
        const nextQuantity = existing.quantity + quantity;
        return {
          cart: state.cart.map(item =>
            item.id === existing.id
              ? { ...item, quantity: nextQuantity, total: nextQuantity * item.price }
              : item
          )
        };
      }

      return {
        cart: [...state.cart, {
          id: crypto.randomUUID(),
          product,
          quantity,
          price: product.price,
          total: quantity * product.price,
          selectedSize: attributes?.size,
          selectedColor: attributes?.color,
          variantLabel
        }]
      };
    }

    // Serialised products still receive one row per unit, but all rows are
    // generated in the same state update.
    let updatedProducts = state.products;
    const currentProduct = state.products.find(p => p.id === product.id);
    let nextSerial = currentProduct?.nextSerial || 1;
    const rows = Array.from({ length: quantity }, () => {
      let finalSerial = serialNumber;
      if (product.hasSerial && !finalSerial) {
        finalSerial = `SN-${product.sku || product.id.slice(-4)}-${nextSerial.toString().padStart(4, '0')}`;
        nextSerial += 1;
      }
      const prod = updatedProducts.find(p => p.id === product.id) || product;
      return {
        id: crypto.randomUUID(),
        product: prod,
        quantity: 1,
        price: prod.price,
        total: prod.price,
        serialNumber: finalSerial,
        selectedSize: attributes?.size,
        selectedColor: attributes?.color,
        variantLabel
      };
    });

    if (product.hasSerial && nextSerial !== (currentProduct?.nextSerial || 1)) {
      updatedProducts = state.products.map(p =>
        p.id === product.id ? { ...p, nextSerial } : p
      );
    }

    return { products: updatedProducts, cart: [...state.cart, ...rows] };
  }),
  
  updateCartQty: (cartItemId, delta) => set((state) => ({
    cart: state.cart.map(item => {
      if (item.id === cartItemId) {
        // Productos con serie no deben cambiar cantidad > 1 (o se divide, pero simplificamos así)
        if (item.product.hasSerial && delta > 0) return item; 
        const newQty = Math.max(0, item.quantity + delta);
        return { ...item, quantity: newQty, total: newQty * item.price };
      }
      return item;
    }).filter(item => item.quantity > 0)
  })),

  updateCartSerial: (cartItemId, serialNumber) => set((state) => ({
    cart: state.cart.map(item => 
      item.id === cartItemId ? { ...item, serialNumber } : item
    )
  })),
  
  clearCart: () => set({ cart: [], currentCustomerId: undefined }),

  transactions: [],
  returns: [],
  quotes: [],
  addQuote: (quote) => {
    set((state) => ({ quotes: [...state.quotes, quote] }));
    import('../services/supabaseSync').then(({ pushQuoteToSupabase }) => {
      pushQuoteToSupabase(quote).catch(() => {});
    }).catch(() => {});
  },
  updateQuote: (id, updates) => {
    set((state) => ({ quotes: state.quotes.map(q => q.id === id ? { ...q, ...updates } : q) }));
    const updated = get().quotes.find(q => q.id === id);
    if (updated) {
      import('../services/supabaseSync').then(({ pushQuoteToSupabase }) => {
        pushQuoteToSupabase(updated).catch(() => {});
      }).catch(() => {});
    }
  },

  timeShifts: [],
  addTimeShift: (shift) => {
    set((state) => ({ timeShifts: [shift, ...state.timeShifts] }));
    import('../services/supabaseSync').then(({ pushTimeShiftToSupabase }) => {
      pushTimeShiftToSupabase(shift).catch(() => {});
    }).catch(() => {});
  },
  updateTimeShift: (id, updates) => {
    set((state) => ({ timeShifts: state.timeShifts.map(s => s.id === id ? { ...s, ...updates } : s) }));
    const updated = get().timeShifts.find(s => s.id === id);
    if (updated) {
      import('../services/supabaseSync').then(({ pushTimeShiftToSupabase }) => {
        pushTimeShiftToSupabase(updated).catch(() => {});
      }).catch(() => {});
    }
  },
  processTransaction: async (transaction) => {
    // La cola debe estar hidratada antes de aceptar una venta. Esto evita que
    // una venta creada justo después de abrir/recargar el POS compita con la
    // migración inicial de IndexedDB y quede fuera del snapshot durable.
    await waitForOfflineQueueReady();

    // Primero persistimos la operación en la cola durable. Así, aunque la
    // pestaña se cierre durante el cobro, existe una operación reintentable.
    const durableTransaction = { ...transaction, offlinePending: true };
    await enqueueOfflineItem('transaction', durableTransaction, transaction.id);

    // Offline real o conexión inestable: el POS debe conservar inmediatamente
    // la venta localmente. En una conexión mala navigator.onLine puede seguir
    // siendo true aunque la RPC falle por timeout/DNS/TLS.
    const applyLocalSale = async (pending: boolean) => {
      const localTransaction = { ...transaction, offlinePending: pending };
      const alreadyLocal = useStore.getState().transactions.some(
        t => t.id === transaction.id && !t.deletedAt
      );
      if (!alreadyLocal || pending === false) {
        let generatedWarranties: Warranty[] = [];
        set((state) => {
          const patch = buildLocalCompletedSalePatch(state, localTransaction);
          generatedWarranties = patch.generatedWarranties;
          const { generatedWarranties: _generated, ...statePatch } = patch;
          return statePatch;
        });
        for (const warranty of generatedWarranties) {
          void pushWarrantyToSupabase(warranty);
        }
      }
      await flushLocalStateStorage();
    };

    if (typeof navigator === 'undefined' || navigator.onLine === false) {
      await applyLocalSale(true);
      return true;
    }

    try {
      const res = await callProcessTransactionRPC(transaction);

      if (!res.success) {
        const code = String(res.errorCode || '');
        // Solo rechazos de negocio/consistencia explícitos son definitivos.
        // Los errores de transporte permanecen pendientes para reintento.
        const permanentCodes = new Set([
          'P0001', '23503', '23505', '22P02', '22003', '22007', 'IDEMPOTENCY_CONFLICT'
        ]);

        if (permanentCodes.has(code)) {
          removeFromOfflineQueueByTransactionId(transaction.id);
          console.error('[processTransaction] Operación rechazada por servidor:', res.error);
          return false;
        }

        await applyLocalSale(true);
        get().addNotification(
          'Venta guardada localmente. Se sincronizará automáticamente cuando la conexión sea estable.',
          'info'
        );
        return true;
      }

      // Confirmada en Supabase: reflejarla localmente como confirmada antes de
      // retirar la operación de la cola durable.
      await applyLocalSale(false);

      // La confirmación remota ya ocurrió. Si este refresh falla, la venta no
      // vuelve a un estado de error ni se vuelve a cobrar; el sincronizador
      // reconciliará el inventario en el siguiente ciclo.
      const inventoryReconciled = await refreshInventoryBranchesFromSupabase([transaction.branchId]);
      if (!inventoryReconciled) {
        console.warn('[processTransaction] Venta confirmada; inventario local pendiente de reconciliación.');
      }

      removeFromOfflineQueueByTransactionId(transaction.id);
      return true;
    } catch (err) {
      // Timeout, DNS, TLS, caída temporal o respuesta perdida: el ticket ya
      // está protegido en la cola durable, pero también debe verse localmente.
      // Si la RPC alcanzó a confirmar la venta antes de perder la respuesta,
      // el siguiente replay será idempotente por transaction.id.
      console.warn('[processTransaction] Conexión inestable durante el cobro; venta conservada localmente:', err);
      try {
        await applyLocalSale(true);
      } catch (persistError) {
        console.error('[processTransaction] No se pudo persistir el espejo local de la venta:', persistError);
      }
      get().addNotification(
        'Venta guardada localmente. Se sincronizará automáticamente cuando la conexión sea estable.',
        'info'
      );
      return true;
    }
  },

  deleteTransaction: async (id: string, reason?: string) => {
    const state = get();
    const tx = (state.transactions || []).find(t => t.id === id);
    if (!tx || tx.deletedAt) return false;
    const userId = state.currentUser?.id || 'system';
    const finalReason = reason || 'Anulación de venta';

    if (!navigator.onLine) {
      await enqueueOfflineItem('void_transaction', { id, userId, reason: finalReason }, 'void:' + id);
      set(current => buildLocalVoidTransactionPatch(current, tx));
      const deletedAt = new Date().toISOString();
      set((current) => ({
        transactions: current.transactions.map(t => t.id === id ? { ...t, deletedAt, deletedBy: userId, deleteReason: finalReason } : t)
      }));
      return true;
    }

    await enqueueOfflineItem('void_transaction', { id, userId, reason: finalReason }, 'void:' + id);
    try {
      const res = await callVoidTransactionRPC(id, userId, finalReason);
      if (!res.success) throw new Error(res.error || 'No se pudo anular la venta');
      set(current => buildLocalVoidTransactionPatch(current, tx));
      const deletedAt = new Date().toISOString();
      set((current) => ({
        transactions: current.transactions.map(t => t.id === id ? { ...t, deletedAt, deletedBy: userId, deleteReason: finalReason } : t)
      }));

      const inventoryReconciled = await get().refreshBranchInventory();
      const { pullBankDataFromSupabase } = await import('../services/supabaseSync');
      const bankRes = await pullBankDataFromSupabase();
      if (!inventoryReconciled || !bankRes.success) {
        throw new Error('Venta anulada en servidor, pero el inventario/saldos locales aún no pudieron reconciliarse');
      }
      set({ bankCards: bankRes.bankCards, bankTransactions: bankRes.bankTransactions });

      removeFromOfflineQueueByAction('void_transaction', 'void:' + id);
      return true;
    } catch (err) {
      console.warn('[deleteTransaction] Anulación no confirmada; queda durable para reintento:', err);
      return false;
    }
  },

  updateTransaction: (id: string, updates: Partial<Transaction>) => {
    const existing = get().transactions.find(t => t.id === id);
    if (!existing) return;
    // Completed sales are immutable. A post-sale correction must go through
    // the void/return workflow so inventory, cash and audit history stay aligned.
    if (existing.status === 'completed' || existing.status === 'refunded' || existing.deletedAt) {
      get().addNotification('La venta completada no se puede editar. Usa devolución/anulación para corregirla.', 'warning');
      return;
    }
    const updated = { ...existing, ...updates };
    set((state) => ({ transactions: (state.transactions || []).map(t => t.id === id ? updated : t) }));
    pushTransactionToSupabase(updated).catch(() => {});
  },

  cancelSession: async (sessionId: string, reason = 'Cancelación de turno') => {
    const state = get();
    const session = state.cashSessions.find(s => s.id === sessionId);
    if (!session) return false;
    if (session.status !== 'open') {
      state.addNotification('El turno ya no está abierto.', 'warning');
      return false;
    }

    const userId = state.currentUser?.id || 'system';
    const cancelledAt = new Date().toISOString();
    const queueData = {
      id: sessionId,
      branchId: session.branchId,
      userId,
      status: 'cancelled',
      closedAt: cancelledAt,
      closingDate: cancelledAt,
      deleteReason: reason,
      __operation: 'cancel'
    };

    // Persist the cancellation intent before any local mutation.
    await enqueueOfflineItem('cash_session', queueData, 'cash-cancel:' + sessionId);

    if (navigator.onLine) {
      try {
        const res = await callCancelSessionRPC(sessionId, userId, reason);
        if (!res.success) throw new Error(res.error || 'No se pudo cancelar el turno');

        const sessionTxs = (get().transactions || []).filter(t => t.sessionId === sessionId && !t.deletedAt);
        sessionTxs.forEach(tx => set(current => buildLocalVoidTransactionPatch(current, tx)));
        set(current => ({
          cashSessions: (current.cashSessions || []).map(s => s.id === sessionId ? {
            ...s, status: 'cancelled', closedAt: cancelledAt, closingDate: cancelledAt, deleteReason: reason
          } : s),
          transactions: (current.transactions || []).map(t =>
            t.sessionId === sessionId && !t.deletedAt
              ? { ...t, deletedAt: cancelledAt, deletedBy: userId, deleteReason: reason, status: 'refunded' as const }
              : t
          ),
          cart: []
        }));

        const inventoryReconciled = await get().refreshBranchInventory();
        const { pullBankDataFromSupabase } = await import('../services/supabaseSync');
        const bankRes = await pullBankDataFromSupabase();
        if (!inventoryReconciled || !bankRes.success) {
          throw new Error('Turno cancelado en servidor, pero el inventario/saldos locales aún no pudieron reconciliarse');
        }
        set({ bankCards: bankRes.bankCards, bankTransactions: bankRes.bankTransactions });

        removeFromOfflineQueueByAction('cash_session', 'cash-cancel:' + sessionId);
        return true;
      } catch (err) {
        console.warn('[cancelSession] Cancelación no confirmada; queda durable para reintento:', err);
        return false;
      }
    }

    const sessionTxs = (state.transactions || []).filter(t => t.sessionId === sessionId && !t.deletedAt);
    sessionTxs.forEach(tx => set(current => buildLocalVoidTransactionPatch(current, tx)));
    set(current => ({
      cashSessions: (current.cashSessions || []).map(s => s.id === sessionId ? {
        ...s, status: 'cancelled', closedAt: cancelledAt, closingDate: cancelledAt, deleteReason: reason
      } : s),
      transactions: (current.transactions || []).map(t =>
        t.sessionId === sessionId && !t.deletedAt
          ? { ...t, deletedAt: cancelledAt, deletedBy: userId, deleteReason: reason, status: 'refunded' as const }
          : t
      ),
      cart: []
    }));
    return true;
  },

  createReturn: (returnItem) => {
    const newReturn = { ...returnItem, id: returnItem.id || generateReadableId('DEV', get().returns.length) };
    set((state) => ({
      returns: [newReturn, ...state.returns.filter(r => r.id !== newReturn.id)]
    }));
    // Registrar inmediatamente la intención en la cola durable para evitar una
    // carrera entre "crear devolución" y "completar devolución".
    void enqueueOfflineItem('return', newReturn, newReturn.id);
    import('../services/supabaseSync').then(({ pushReturnToSupabase }) => {
      pushReturnToSupabase(newReturn).catch(() => {});
    }).catch(() => {});
  },
  updateReturn: (id, returnItem) => {
    set((state) => ({
      returns: state.returns.map(r => r.id === id ? { ...r, ...returnItem } : r)
    }));
    const updated = get().returns.find(r => r.id === id);
    if (updated) {
      import('../services/supabaseSync').then(({ pushReturnToSupabase }) => {
        pushReturnToSupabase(updated).catch(() => {});
      }).catch(() => {});
    }
  },
  processReturn: async (id, action) => {
    const state = get();
    const returnReq = state.returns.find(r => r.id === id);
    if (!returnReq || returnReq.status !== 'pending') return false;
    const userId = state.currentUser?.id || 'system';
    let canonicalInventoryRefreshed = false;

    if (action === 'complete') {
      await enqueueOfflineItem('return_complete', { id, userId }, 'return:' + id);
      if (navigator.onLine) {
        try {
          // Primero confirmamos la existencia de la devolución en la nube. Así
          // "Completar" nunca corre antes que "Crear devolución".
          const { pushReturnToSupabase } = await import('../services/supabaseSync');
          const persisted = await pushReturnToSupabase(returnReq);
          if (!persisted) throw new Error('La devolución todavía no está confirmada en Supabase.');
          removeFromOfflineQueueByAction('return', returnReq.id);

          const res = await callCompleteReturnRPC(id, userId);
          if (!res.success) throw new Error(res.error || 'No se pudo completar la devolución');

          canonicalInventoryRefreshed = await get().refreshBranchInventory();
          if (!canonicalInventoryRefreshed) {
            throw new Error('Devolución confirmada, pero el inventario local aún no pudo reconciliarse con Supabase');
          }

          removeFromOfflineQueueByAction('return_complete', 'return:' + id);
        } catch (err) {
          console.warn('[processReturn] Devolución no confirmada; queda durable para reintento:', err);
          return false;
        }
      }
    }

    set((current) => {
      const req = current.returns.find(r => r.id === id);
      if (!req || req.status !== 'pending') return current;
      let updatedInventory = [...current.inventory];
      let updatedWarranties = [...current.warranties];
      const originalTx = current.transactions.find(t => t.id === req.transactionId);
      const branchId = req.branchId || originalTx?.branchId || current.currentBranchId;

      const adjustLocal = (productId: string, delta: number, variantLabel?: string) => {
        const idx = updatedInventory.findIndex(i => i.productId === productId && i.branchId === branchId && (i.variantLabel || '') === (variantLabel || ''));
        if (idx !== -1) updatedInventory[idx] = { ...updatedInventory[idx], quantity: Math.max(0, updatedInventory[idx].quantity + delta) };
      };

      if (action === 'complete') {
        if (!canonicalInventoryRefreshed) {
          if (req.type === 'refund') adjustLocal(req.productId, req.quantity, req.variantLabel);
          if (req.type === 'warranty_exchange' && req.replacementProductId) adjustLocal(req.replacementProductId, -(req.replacementQuantity || req.quantity));
        }
        const warrantyIdx = updatedWarranties.findIndex(w => w.transactionId === req.transactionId && w.productId === req.productId);
        if (warrantyIdx !== -1) updatedWarranties[warrantyIdx] = { ...updatedWarranties[warrantyIdx], status: req.type === 'warranty_exchange' ? 'exchanged' : 'refunded' };
      }
      return {
        returns: current.returns.map(r => r.id === id ? {
          ...r,
          status: action === 'complete' ? 'completed' : 'rejected',
          processedBy: userId,
          receivedAt: action === 'complete' ? new Date().toISOString() : r.receivedAt,
          refundStatus: action === 'complete'
            ? (r.type === 'refund' ? (r.refundStatus || 'pending') : 'not_required')
            : r.refundStatus
        } : r),
        inventory: updatedInventory,
        warranties: updatedWarranties
      };
    });
    return true;
  },

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

  cashSessions: [],
  openSession: async (session) => {
    const existingSessions = get().cashSessions || [];
    let maxTurn = 0;
    existingSessions.forEach(s => {
      const persisted = Number(s.turnNumber);
      if (Number.isFinite(persisted) && persisted > maxTurn) maxTurn = persisted;
    });
    
    // Si hay red, usar RPC para garantizar integridad y turno único
    if (navigator.onLine) {
      try {
        const res = await callOpenSessionRPCWithId(session);
        if (res.success && res.data) {
          const officialSession = {
            ...res.data,
            openingBalance: Number(res.data.opening_balance || res.data.opening_amount) || 0,
            openingAmount: Number(res.data.opening_amount || res.data.opening_balance) || 0,
            turnNumber: Number(res.data.turn_number) || undefined,
            userId: session.userId,
            branchId: session.branchId,
            workerName: session.workerName,
            workingEmployeeIds: session.workingEmployeeIds?.length ? session.workingEmployeeIds : [session.userId],
            movements: res.data.movements || []
          };
          set((state) => {
            const sessions = (state.cashSessions || []).filter(s => s.id !== officialSession.id);
            return {
              cashSessions: [...sessions, officialSession],
              lastTurnNumber: Math.max(state.lastTurnNumber, Number(officialSession.turnNumber) || 0),
              cart: []
            };
          });
          return true;
        }
        if (res.errorCode) {
          console.warn("[openSession] Apertura rechazada por Supabase:", res.error);
          get().addNotification(res.error || 'No se pudo abrir el turno.', 'error');
          return false;
        }
      } catch (err) {
        console.warn("[openSession] Fallo de transporte al abrir; se conservará como operación offline:", err);
      }
    }

    const nextTurn = Math.max(maxTurn, get().lastTurnNumber || 0) + 1;
    // El turno creado offline necesita un ID estable y único que también pueda
    // usar la venta offline como session_id cuando llegue a Supabase.
    const sessionWithSequentialId = {
      ...session,
      // Local optimistic label only. Supabase assigns the authoritative number
      // atomically on INSERT; the queue payload must never force a client number.
      turnNumber: nextTurn,
      // Keep the original stable ID. If the online insert actually succeeded
      // but its response was lost, replaying this exact operation becomes an
      // idempotent lookup instead of creating a second turn.
      id: session.id,
      workingEmployeeIds: session.workingEmployeeIds && session.workingEmployeeIds.length > 0 
        ? session.workingEmployeeIds 
        : [session.userId]
    };
    set((state) => ({ 
      cashSessions: [...(state.cashSessions || []), sessionWithSequentialId],
      lastTurnNumber: nextTurn,
      cart: [] // ASEGURAR QUE EL CARRITO ESTÉ VACÍO AL ABRIR NUEVO TURNO
    }));
    // Offline-first: never fire-and-forget a master write. The session must
    // survive a reload and be retried through the operation queue.
    await enqueueOfflineItem('cash_session', sessionWithSequentialId, `cash-open:${sessionWithSequentialId.id}`);
    return true;
  },
  closeSession: async (sessionId, closingBalances, workerName, closingDate, discrepancyDeduction, sessionMeta) => {
    const finalClosingDate = closingDate || new Date().toISOString();
    const session = get().cashSessions.find(s => s.id === sessionId);
    if (!session) return false;

    // Nunca cerrar remotamente mientras exista una venta/liquidación de este
    // turno todavía pendiente en la cola durable. En offline el cierre sí se
    // puede encolar, y el motor lo ordenará después de las ventas.
    const pendingSessionTransactions = getOfflineQueue().filter(item =>
      item.type === 'transaction' &&
      item.data?.sessionId === sessionId
    );
    if (pendingSessionTransactions.length > 0 && typeof navigator !== 'undefined' && navigator.onLine) {
      get().addNotification(
        'No se puede cerrar todavía: hay ' + pendingSessionTransactions.length + ' venta(s) del turno pendientes de sincronizar.',
        'warning'
      );
      return false;
    }

    const sessionTxs = get().transactions.filter(t =>
      t.sessionId
        ? t.sessionId === session.id
        : (t.branchId === session.branchId &&
           new Date(t.date).getTime() >= new Date(session.openedAt).getTime() &&
           (!session.closedAt || new Date(t.date).getTime() <= new Date(session.closedAt).getTime()))
    );
    const user = get().users.find(u => u.id === session.userId || u.name?.toLowerCase() === (workerName || session.workerName)?.toLowerCase());
    const commissions = sessionTxs.reduce((sum, tx) =>
      sum + (tx.items || []).reduce((itemSum, item) => {
        const prodObj = typeof item.product === 'object' ? item.product : get().products.find(p => p.id === (item.product as unknown as string));
        return itemSum + ((prodObj?.commissionValue || 0) * (item.quantity || 0));
      }, 0), 0);
    const baseSalary = user?.baseSalary || 0;
    const deduction = discrepancyDeduction || 0;
    const settlement: SalarySettlement = {
      id: crypto.randomUUID(),
      userId: session.userId,
      userName: workerName || session.workerName || user?.name || 'Vendedor',
      sessionId,
      baseSalary,
      commissions,
      discrepancyDeduction: deduction,
      total: (baseSalary + commissions) - deduction,
      date: finalClosingDate,
      status: 'pending'
    };
    const expectedCashBase = calculateExpectedCashBase(session, sessionTxs, get().currencies || []);
    const updatedSession = {
      ...session,
      expectedBalance: expectedCashBase,
      closedAt: finalClosingDate,
      status: 'closed' as 'closed',
      closingBalances: closingBalances || [],
      workerName: settlement.userName,
      closingDate: finalClosingDate,
      ...(sessionMeta || {})
    };
    const actionId = 'cash-close:' + sessionId;
    await enqueueOfflineItem('cash_session', { ...updatedSession, __operation: 'close', settlement }, actionId);

    if (navigator.onLine) {
      try {
        const res = await callCloseSessionRPC(sessionId, closingBalances || [], finalClosingDate, session.notes || '', settlement, expectedCashBase);
        if (!res.success) throw new Error(res.error || 'No se pudo cerrar el turno');
        set((state) => ({
          cashSessions: (state.cashSessions || []).map(s => s.id === sessionId ? updatedSession : s),
          salarySettlements: [...(state.salarySettlements || []).filter(st => st.sessionId !== sessionId), { ...settlement, id: res.data?.settlement_id || settlement.id }],
          cart: []
        }));
        removeFromOfflineQueueByAction('cash_session', actionId);
        return true;
      } catch (err) {
        console.warn("[closeSession] El cierre no fue confirmado; queda durable para reintento:", err);
        return false;
      }
    }

    set((state) => ({
      cashSessions: (state.cashSessions || []).map(s => s.id === sessionId ? updatedSession : s),
      salarySettlements: [...(state.salarySettlements || []).filter(st => st.sessionId !== sessionId), settlement],
      cart: []
    }));
    return true;
  },
  updateCashSession: (id, updates) => {
    set((state) => ({
      cashSessions: (state.cashSessions || []).map(s =>
        s.id === id ? { ...s, ...updates } : s
      )
    }));
    const updated = get().cashSessions.find(s => s.id === id);
    if (!updated) return;

    // Los cambios administrativos del turno (incluida la auditoría de
    // descuadres) también deben ser durables cuando el dispositivo está
    // offline o el push online falla. Usamos una operación snapshot separada
    // para no pisar una operación pendiente de cierre/cancelación.
    const actionId = `cash-snapshot:${id}`;
    void enqueueOfflineItem('cash_session', { ...updated, __operation: 'snapshot' }, actionId)
      .then(async () => {
        try {
          const synced = await pushCashSessionToSupabase(updated);
          if (!synced) return;

          const queued = getOfflineQueue().find(
            item => item.type === 'cash_session' && item.actionId === actionId
          );
          if (queued) removeFromOfflineQueue(queued.id);
        } catch (error) {
          console.warn('[CashSession] La actualización quedó en cola para reintento:', error);
        }
      })
      .catch(error => {
        console.warn('[CashSession] No se pudo persistir el cambio administrativo en la cola offline:', error);
      });
  },
  updateCashSessionDateCascade: async (sessionId, newDateYMD) => {
    const state = get();
    const session = (state.cashSessions || []).find(s => s.id === sessionId);
    if (!session || !newDateYMD) return false;

    // Helper to shift ISO string to target YYYY-MM-DD date
    const shiftDate = (isoStr: string | null | undefined): string => {
      if (!isoStr) return '';
      try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return `${newDateYMD}T12:00:00.000Z`;
        const [year, month, day] = newDateYMD.split('-').map(Number);
        const updated = new Date(d);
        updated.setFullYear(year, month - 1, day);
        return updated.toISOString();
      } catch {
        return `${newDateYMD}T12:00:00.000Z`;
      }
    };

    const newOpenedAt = shiftDate(session.openedAt);
    const newClosedAt = session.closedAt ? shiftDate(session.closedAt) : undefined;
    const newClosingDate = session.closingDate ? shiftDate(session.closingDate) : undefined;

    // Shift movements date
    const updatedMovements = (session.movements || []).map(m => ({
      ...m,
      date: shiftDate(m.date)
    }));

    const updatedSession: CashRegisterSession = {
      ...session,
      openedAt: newOpenedAt,
      closedAt: newClosedAt,
      closingDate: newClosingDate,
      movements: updatedMovements
    };

    // Find affected transactions
    const oldOpenTime = new Date(session.openedAt).getTime();
    const oldCloseTime = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;

    const affectedTxIds = new Set<string>();
    const updatedTransactions = (state.transactions || []).map(tx => {
      const isLinked = tx.sessionId === session.id || (
        tx.branchId === session.branchId &&
        new Date(tx.date).getTime() >= oldOpenTime &&
        new Date(tx.date).getTime() <= oldCloseTime
      );
      if (isLinked) {
        affectedTxIds.add(tx.id);
        return {
          ...tx,
          sessionId: session.id, // Enforce sessionId linkage
          date: shiftDate(tx.date)
        };
      }
      return tx;
    });

    // Update bank transactions linked to these transactions
    const updatedBankTransactions = (state.bankTransactions || []).map(bt => {
      if (bt.transactionId && affectedTxIds.has(bt.transactionId)) {
        return {
          ...bt,
          date: shiftDate(bt.date)
        };
      }
      return bt;
    });

    // Update salary settlements linked to this session
    const updatedSalarySettlements = (state.salarySettlements || []).map(st => {
      if (st.sessionId === session.id) {
        return {
          ...st,
          date: newClosingDate || newOpenedAt
        };
      }
      return st;
    });

    // Update warranties linked to these transactions
    const updatedWarranties = (state.warranties || []).map(w => {
      if (affectedTxIds.has(w.transactionId)) {
        return {
          ...w,
          purchaseDate: shiftDate(w.purchaseDate)
        };
      }
      return w;
    });

    // Update returns linked to these transactions
    const updatedReturns = (state.returns || []).map(ret => {
      if (affectedTxIds.has(ret.transactionId)) {
        return {
          ...ret,
          date: shiftDate(ret.date)
        };
      }
      return ret;
    });

    // Update local state atomically
    set({
      cashSessions: (state.cashSessions || []).map(s => s.id === sessionId ? updatedSession : s),
      transactions: updatedTransactions,
      bankTransactions: updatedBankTransactions,
      salarySettlements: updatedSalarySettlements,
      warranties: updatedWarranties,
      returns: updatedReturns
    });

    // Sync updates to Supabase in background
    try {
      await pushCashSessionToSupabase(updatedSession);
      for (const tx of updatedTransactions) {
        if (affectedTxIds.has(tx.id)) {
          await pushTransactionToSupabase(tx);
        }
      }
      for (const bt of updatedBankTransactions) {
        if (bt.transactionId && affectedTxIds.has(bt.transactionId)) {
          await pushBankTransactionToSupabase(bt);
        }
      }
    } catch (e) {
      console.warn("Cascaded date update Supabase sync error:", e);
    }

    return true;
  },
  joinOpenSession: (sessionId, userId, workerName) => {
    const session = get().cashSessions.find(s => s.id === sessionId);
    if (!session || session.status !== 'open') return;
    const employeeIds = [...(session.workingEmployeeIds || [])];
    if (userId && !employeeIds.includes(userId)) employeeIds.push(userId);
    const updatedSession: CashRegisterSession = {
      ...session,
      workingEmployeeIds: employeeIds,
      workerName: workerName || session.workerName
    };
    set((state) => ({
      cashSessions: (state.cashSessions || []).map(s => s.id === sessionId ? updatedSession : s)
    }));
    // Joining a shared shift is a real state change and must survive reloads.
    const actionId = `cash-join:${sessionId}:${userId}`;
    void enqueueOfflineItem('cash_session', updatedSession, actionId).then(async () => {
      if (!navigator.onLine) return;
      const synced = await pushCashSessionToSupabase(updatedSession);
      if (synced) {
        removeFromOfflineQueueByAction('cash_session', actionId);
      } else {
        console.warn('[joinOpenSession] La unión no fue confirmada; permanece durable para replay.');
      }
    }).catch(err => console.warn('[joinOpenSession] No se pudo persistir la intención de unión:', err));
  },
  getCurrentSession: (branchId, userId) => {
    const sessions = get().cashSessions || [];
    if (!userId) return undefined;
    
    // Strict match: must be open AND not deleted AND the specific user must be the opener or in working employees
    // Strictly isolate by branchId so cross-tablet/cross-branch sessions never collide
    return sessions.find(s => 
      s.status === 'open' && 
      !s.deletedAt &&
      (s.userId === userId || s.workingEmployeeIds?.includes(userId)) &&
      (branchId ? s.branchId === branchId : true)
    );
  },

  addInformationalSoldProductToSession: async (sessionId, itemData, affectStock, isDeduction = false) => {
    const session = get().cashSessions.find(s => s.id === sessionId);
    if (!session) {
      return { success: false };
    }

    const txs = get().transactions || [];
    const maxNum = txs.reduce((max, t) => {
      const match = t.id?.match(/INF-(\d+)/i) || t.id?.match(/ADJ-(\d+)/i) || t.id?.match(/SUB-(\d+)/i);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    const nextNum = Math.max(txs.length, maxNum) + 1;
    const prefix = isDeduction ? 'SUB' : 'INF';
    // These informational records can also originate from multiple terminals.
    const txId = `${prefix}-${nextNum.toString().padStart(3, '0')}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

    const rawTotalAmount = itemData.quantity * itemData.price;
    const totalAmount = isDeduction ? -Math.abs(rawTotalAmount) : Math.abs(rawTotalAmount);
    const itemQty = isDeduction ? -Math.abs(itemData.quantity) : Math.abs(itemData.quantity);

    const txDate = session.closingDate || session.closedAt || session.openedAt || new Date().toISOString();
    const currencyCode = itemData.currencyCode || get().getBaseCurrency().code;
    const curr = get().currencies.find(c => c.code === currencyCode);
    const rate = curr?.rateToBase || 1;

    const informationalTx: Transaction = {
      id: txId,
      branchId: session.branchId,
      userId: itemData.userId || session.userId,
      cashierName: itemData.workerName || session.workerName,
      date: txDate,
      subtotal: totalAmount,
      tax: 0,
      total: totalAmount,
      items: [
        {
          id: crypto.randomUUID(),
          product: {
            id: itemData.productId,
            name: itemData.productName,
            price: itemData.price,
            costPrice: 0,
            sku: isDeduction ? 'SUB' : 'INF'
          } as any,
          quantity: itemQty,
          price: itemData.price,
          total: totalAmount
        }
      ],
      payments: [
        {
          method: itemData.paymentMethod || 'cash',
          amount: totalAmount,
          currencyCode: currencyCode as any,
          exchangeRate: rate
        }
      ],
      status: 'completed',
      sessionId: session.id,
      notes: isDeduction
        ? (affectStock ? 'AJUSTE_AUDITORIA_RESTAR_DUPLICADO (Sumando stock devuelto a almacén)' : 'AJUSTE_AUDITORIA_RESTAR_DUPLICADO (Sin afectar stock)')
        : (affectStock ? 'AJUSTE_MANUAL_INFORME (Afectando stock físico)' : 'AJUSTE_MANUAL_INFORME (Sin afectar stock físico)')
    };

    // Agregar a transacciones locales
    set(state => ({
      transactions: [informationalTx, ...state.transactions]
    }));

    // Acción sobre el inventario físico del almacén de la sucursal:
    // Si isDeduction = false (agregar faltante): descontamos de inventario (-quantity)
    // Si isDeduction = true (restar producto anotado doble): SUMAMOS nuevamente al inventario de almacén (+quantity)
    if (affectStock) {
      const stockDelta = isDeduction ? Math.abs(itemData.quantity) : -Math.abs(itemData.quantity);
      get().adjustInventory(itemData.productId, session.branchId, stockDelta, itemData.variantLabel);
    }

    // Sincronizar transacción con Supabase
    pushTransactionToSupabase(informationalTx).catch(() => {});

    // Si el turno está cerrado, recalcular nómina si aplica
    if (session.status === 'closed') {
      const existingSettlement = (get().salarySettlements || []).find(st => st.sessionId === session.id);
      if (existingSettlement) {
        const productObj = get().products.find(p => p.id === itemData.productId);
        const commValue = productObj?.commissionValue || 0;
        const commDelta = commValue * Math.abs(itemData.quantity);
        const newCommissions = isDeduction
          ? Math.max(0, (existingSettlement.commissions || 0) - commDelta)
          : (existingSettlement.commissions || 0) + commDelta;
        const newTotal = isDeduction
          ? Math.max(0, (existingSettlement.total || 0) - commDelta)
          : (existingSettlement.total || 0) + commDelta;

        const updatedSettlement = {
          ...existingSettlement,
          commissions: newCommissions,
          total: newTotal
        };
        set(state => ({
          salarySettlements: state.salarySettlements.map(st => st.id === existingSettlement.id ? updatedSettlement : st)
        }));
        import('../services/supabaseSync').then(({ pushSalarySettlementToSupabase }) => {
          pushSalarySettlementToSupabase(updatedSettlement).catch(() => {});
        });
      }
    }

    return { success: true, transactionId: txId };
  },

  subtractInformationalProductFromSession: async (sessionId, itemData, affectStock = true) => {
    return get().addInformationalSoldProductToSession(sessionId, itemData, affectStock, true);
  },

  forceCloseSessionFromReports: async (sessionId, closingBalances, closingDate, notes) => {
    const session = get().cashSessions.find(s => s.id === sessionId);
    if (!session) return { success: false };

    const finalClosingDate = closingDate || new Date().toISOString();
    const finalBalances = closingBalances && closingBalances.length > 0
      ? closingBalances
      : session.closingBalances && session.closingBalances.length > 0
        ? session.closingBalances
        : [{ currencyCode: get().getBaseCurrency().code, amount: session.openingBalance || 0, method: 'cash' as const, exchangeRate: 1 }];

    const sessionTxs = (get().transactions || []).filter(t =>
      t.sessionId === session.id ||
      (t.sessionId == null &&
        t.branchId === session.branchId &&
        new Date(t.date).getTime() >= new Date(session.openedAt).getTime() &&
        new Date(t.date).getTime() <= new Date(finalClosingDate).getTime())
    );
    const user = get().users.find(u => u.id === session.userId || u.name?.toLowerCase() === session.workerName?.toLowerCase());
    const commissions = sessionTxs.reduce((sum, tx) =>
      sum + (tx.items || []).reduce((itemSum, item) => {
        const prodObj = typeof item.product === 'object'
          ? item.product
          : get().products.find(p => p.id === (item.product as unknown as string));
        return itemSum + ((prodObj?.commissionValue || 0) * (item.quantity || 0));
      }, 0), 0);
    const settlement: SalarySettlement = {
      id: crypto.randomUUID(),
      userId: session.userId,
      userName: session.workerName || user?.name || 'Vendedor',
      sessionId: session.id,
      baseSalary: user?.baseSalary || 0,
      commissions,
      discrepancyDeduction: 0,
      total: (user?.baseSalary || 0) + commissions,
      date: finalClosingDate,
      status: 'pending'
    };
    const expectedCashBase = calculateExpectedCashBase(session, sessionTxs, get().currencies || []);
    const updatedSession: CashRegisterSession = {
      ...session,
      expectedBalance: expectedCashBase,
      status: 'closed',
      closedAt: finalClosingDate,
      closingDate: finalClosingDate,
      closingBalances: finalBalances,
      notes: notes ? (session.notes ? session.notes + ' | ' + notes : notes) : session.notes
    };
    const queueData = { ...updatedSession, __operation: 'close', settlement };
    await enqueueOfflineItem('cash_session', queueData, 'cash-close:' + sessionId);

    if (navigator.onLine) {
      try {
        const res = await callCloseSessionRPC(sessionId, finalBalances, finalClosingDate, updatedSession.notes || '', settlement, expectedCashBase);
        if (!res.success) throw new Error(res.error || 'No se pudo cerrar el turno');
        set(state => ({
          cashSessions: state.cashSessions.map(s => s.id === sessionId ? updatedSession : s),
          salarySettlements: [...(state.salarySettlements || []).filter(st => st.sessionId !== sessionId), { ...settlement, id: res.data?.settlement_id || settlement.id }]
        }));
        removeFromOfflineQueueByAction('cash_session', 'cash-close:' + sessionId);
        return { success: true };
      } catch (err) {
        get().addNotification('El cierre no fue confirmado por la nube; quedó protegido para reintento.', 'warning');
        return { success: false };
      }
    }

    set(state => ({
      cashSessions: state.cashSessions.map(s => s.id === sessionId ? updatedSession : s),
      salarySettlements: [...(state.salarySettlements || []).filter(st => st.sessionId !== sessionId), settlement]
    }));
    return { success: true };
  },

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
