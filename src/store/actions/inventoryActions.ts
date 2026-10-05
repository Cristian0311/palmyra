import type { Branch, Category, Product, InventoryLevel, CartItem, Transaction, ReturnItem, Currency, Customer, CashRegisterSession, User, PendingOrder, SalarySettlement, InventoryTransfer, Warranty, CashMovement, Supplier, SupplierOrder, InventoryAudit, FiscalConfig, DemandForecast, BankCard, BankTransaction } from '../../types';
import type { AppState } from '../storeTypes';
import {
  pullBranchInventoryFromSupabase,
  pushProductToSupabase,
  deleteProductFromSupabase,
  reconcileInventoryToSupabase,
  applyInventoryAdjustmentToSupabase,
  callTransferInventoryRPC,
  callTransferInventoryBulkRPC,
} from '../../services/supabaseSync';
import { enqueueOfflineItem } from '../../services/offlineQueue';
import { generateId } from '../../lib/utils';
import { setCanonicalInventoryQuantity, validateTransferStock } from '../utils/inventoryTransforms';
import { buildLocalCompletedSalePatch } from '../utils/localCompletedSale';
import { normalizeSemanticText } from '../../utils/textUtils';
import { getActiveTenant } from '../../services/tenant';

type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;

export function createInventoryActions(set: StoreSet, get: StoreGet): Partial<AppState> {
  return {
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
  };
}
