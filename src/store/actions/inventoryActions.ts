import type { Branch, Category, Product, InventoryLevel, CartItem, Transaction, ReturnItem, Currency, Customer, CashRegisterSession, User, PendingOrder, SalarySettlement, InventoryTransfer, Warranty, CashMovement, Supplier, SupplierOrder, InventoryAudit, FiscalConfig, DemandForecast, BankCard, BankTransaction } from '../../types';
import type { AppState } from '../storeTypes';
import {
  pushProductToSupabase,
  deleteProductFromSupabase,
  reconcileInventoryToSupabase,
  applyInventoryAdjustmentToSupabase,
  callTransferInventoryRPC,
  callTransferInventoryBulkRPC,
  callReceiveTransferRPC,
  callCancelTransferRPC,
} from '../../services/supabaseSync';
import {
  pullTransferHistoryCorrected,
  settleTransferRows,
  classifyTransferResolutionError,
  registerTransferStatusOverrides,
  applyTransferStatusOverrides
} from '../../services/cloudSync/transferHistory';
import { mergeTransferLists, transferIdentityKey } from '../../services/localDb/repositories';
import { enqueueOfflineItem, getOfflineQueue, removeFromOfflineQueue } from '../../services/offlineQueue';
import { removeFromOfflineQueueByAction } from '../../services/offlineQueue/outboxUtils';
import { generateId } from '../../lib/utils';
import { setCanonicalInventoryQuantity, validateTransferStock } from '../utils/inventoryTransforms';
import { refreshInventoryBranchesFromSupabase } from '../utils/refreshBranchInventory';
import { buildLocalCompletedSalePatch } from '../utils/localCompletedSale';
import { normalizeSemanticText } from '../../utils/textUtils';
import { getActiveTenant } from '../../services/tenant';
import { isCloudBusinessSyncAllowed } from '../../services/localPlanMode';
import { INITIAL_PRODUCTS, INITIAL_INVENTORY } from '../storeInitialData';

type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;

export type TransferResolutionMode = 'receive' | 'cancel';

/**
 * Asentamiento local IDEMPOTENTE de una recepción o cancelación: solo toca
 * filas con estado 'in_transit' y las marca una vez. Una segunda aplicación
 * (reintento, doble clic, cola duplicada) no genera un segundo movimiento de
 * stock ni repite la acreditación/devolución.
 */
export function settleTransferResolutions(
  transfers: InventoryTransfer[],
  inventory: InventoryLevel[],
  ids: string[],
  mode: TransferResolutionMode,
  options: { creditStock?: boolean } = {}
): { transfers: InventoryTransfer[]; inventory: InventoryLevel[]; changed: boolean } {
  const targetStatus: InventoryTransfer['status'] = mode === 'receive' ? 'completed' : 'cancelled';
  const creditSide = mode === 'receive' ? 'toBranchId' : 'fromBranchId';
  return settleTransferRows(transfers, inventory, ids, targetStatus, {
    creditStock: options.creditStock !== false,
    creditSide
  });
}

/** Doble clic / doble invocación: una resolución por lote de ids en vuelo. */
const transferResolutionInFlight = new Set<string>();

/**
 * Reemplaza el historial por las filas canónicas de la nube sin duplicar:
 * una fila local se conserva SOLO si su identidad (operationId || id) no
 * aparece en el remoto, y las remotas llegan desduplicadas por id. Un
 * despacho local pendiente cuya operación ya confirmó el servidor deja de
 * convivir con su copia remota; llamarla dos veces es idempotente.
 */
export async function syncTransferHistory(
  set: StoreSet,
  pull: () => Promise<{ success: boolean; transfers: InventoryTransfer[] }> = () =>
    pullTransferHistoryCorrected()
): Promise<void> {
  try {
    // Camino sano (cloudSync): pagina sin filtros de enum y proyecta los
    // estados reales (posted → in_transit, received → completed). El mapeo
    // legado destruía la distinción despachado/recibido.
    const result = await pull();
    if (!result || result.success !== true || !Array.isArray(result.transfers)) return;
    // Los traslados legacy 'posted' ya aplicados en la nube se asentaron
    // localmente como recibidos: el override evita que este pull los devuelva
    // a 'in_transit' (el servidor aún los reporta como posted). Cualquier otra
    // resolución confirmada por la nube (recibido/cancelado ya existente)
    // también queda cubierta por el mismo mapa de overrides.
    set(state => ({
      transfers: applyTransferStatusOverrides(
        mergeTransferLists(result.transfers, state.transfers || [])
      )
    }));
  } catch {
    // La reconciliación se reintentará en el siguiente ciclo de sincronización.
  }
}

export function createInventoryActions(set: StoreSet, get: StoreGet): any {
  return {
  products: INITIAL_PRODUCTS,
  inventory: INITIAL_INVENTORY,
  addProduct: (product) => {
    // Crear producto y registrar existencias son operaciones distintas.
    // El stock inicial ya no se genera desde este formulario; se gestiona
    // exclusivamente desde la acción "Gestionar Stock" del inventario.
    let added = false;
    let duplicateField: 'sku' | 'name' | null = null;
    set((state) => {
      const normalizedSku = String(product.sku || '').trim().toLowerCase();
      const normalizedName = String(product.name || '').trim().toLowerCase();
      const duplicate = state.products.find(p =>
        p.id === product.id ||
        (normalizedSku && String(p.sku || '').trim().toLowerCase() === normalizedSku) ||
        String(p.name || '').trim().toLowerCase() === normalizedName
      );
      if (duplicate) {
        duplicateField = normalizedSku && String(duplicate.sku || '').trim().toLowerCase() === normalizedSku ? 'sku' : 'name';
        return state;
      }
      added = true;
      return { products: [product, ...state.products] };
    });

    if (!added) {
      get().addNotification(
        duplicateField === 'sku'
          ? 'Ya existe un producto con ese SKU. Usa un código distinto o edita el producto existente.'
          : 'Ya existe un producto con ese nombre. Usa otro nombre o edita el producto existente.',
        'warning'
      );
      return false;
    }

    // Producto durable; no se crea ninguna fila de stock aquí.
    void enqueueOfflineItem('product', product, product.id)
      .then(async () => {
        const ok = await pushProductToSupabase(product);
        if (ok) {
          const queued = getOfflineQueue().filter(item => item.type === 'product' && item.actionId === product.id);
          for (const item of queued) removeFromOfflineQueue(item.id);
        }
      })
      .catch((error) => {
        console.warn('[PALMYRA] No se pudo preparar la cola durable del producto:', error);
      });
    return true;
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

    if (typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed()) {
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

    let wasOnline = typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed();
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
          canonicalRefreshed = await refreshInventoryBranchesFromSupabase(set, get, [fromBranchId, toBranchId]);
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

    if (!canonicalRefreshed) {
      // La mercancía queda EN TRÁNSITO: se descuenta del origen y el destino
      // solo se acredita al confirmar la recepción. Acreditar aquí duplicaría
      // el stock cuando el operador reciba el traslado.
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
      }
      set({ inventory: newInventory });
    }

    const totalQuantity = activeVariants.reduce((sum, v) => sum + v.quantity, 0);
    const product = get().products.find(p => p.id === productId);
    const fromBranch = get().branches.find(b => b.id === fromBranchId);
    const toBranch = get().branches.find(b => b.id === toBranchId);
    const transferRecord: import('../../types').InventoryTransfer = {
      id: operationId, operationId, productId, productName: product?.name || 'Producto',
      fromBranchId, fromBranchName: fromBranch?.name || 'Sucursal Origen',
      toBranchId, toBranchName: toBranch?.name || 'Sucursal Destino',
      quantity: totalQuantity, variants: activeVariants, date: new Date().toISOString(),
      // El despacho en dos fases deja el traslado posted/in_transit en el
      // servidor: marcarlo 'completed' aquí lo escondía de la vista de
      // tránsito y el siguiente pull lo reintroducía como in_transit,
      // duplicando la fila. Tras confirmar el despacho queda in_transit.
      userId, status: serverConfirmed ? 'in_transit' as const : 'pending' as const,
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
      if (typeof navigator !== 'undefined' && (!navigator.onLine || !isCloudBusinessSyncAllowed())) {
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
    const productIds: string[] = Array.from(new Set((ids || []).map((id) => String(id).trim()).filter(Boolean)));
    if (!productIds.length) return;
    set((state) => ({
      products: (state.products || []).filter(p => !productIds.includes(String(p.id))),
      inventory: (state.inventory || []).filter(i => !productIds.includes(String(i.productId)))
    }));
    for (const productId of productIds) {
      removeFromOfflineQueueByAction('product', productId);
      const actionId = 'product-delete:' + productId;
      if (typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed()) {
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
    if (typeof navigator !== 'undefined' && (!navigator.onLine || !isCloudBusinessSyncAllowed())) {
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
    if (typeof navigator !== 'undefined' && (!navigator.onLine || !isCloudBusinessSyncAllowed())) {
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
    let bulkPartial = false;
    const online = typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed();

    if (online) {
      try {
        const res = await callTransferInventoryBulkRPC(queueData);
        if (!res.success) {
          const code = String(res.errorCode || '');
          const permanentCodes = new Set(['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT']);
          if (res.partial) {
            // El servidor aplicó una parte del lote. La cola debe quedarse para
            // completar los pendientes; el stock se relee de la fuente canónica
            // para reflejar exactamente lo aplicado.
            bulkPartial = true;
            canonicalRefreshed = await refreshInventoryBranchesFromSupabase(set, get, [fromBranchId, toBranchId]);
            get().addNotification(
              'Traslado aplicado parcialmente',
              'warning',
              res.error || 'Los artículos pendientes se reintentarán automáticamente y el stock se reconciliará al reconectar.'
            );
          } else if (permanentCodes.has(code)) {
            removeFromOfflineQueueByAction('transfer_bulk', actionId);
            return { success: false, pending: false, error: res.error || 'El traslado múltiple fue rechazado por el servidor.' };
          }
        } else {
          serverConfirmed = true;
          canonicalRefreshed = await refreshInventoryBranchesFromSupabase(set, get, [fromBranchId, toBranchId]);
          if (canonicalRefreshed) removeFromOfflineQueueByAction('transfer_bulk', actionId);
        }
      } catch (err) {
        console.warn('[transferProductsBulk] La confirmación online no fue concluyente; queda durable:', err);
      }
    }

    // Un lote parcial nunca aplica deltas locales a medias: un reintento
    // volvería a incluir los artículos ya confirmados y descontaría dos veces.
    // El stock se reconciliará desde el servidor en el siguiente intento.
    // Si el servidor confirmó pero el refresco canónico falló, el descuento
    // local del origen SÍ se aplica: mantenerlo pendiente dejaba el stock
    // local inflado (mercancía ya despachada) hasta el próximo ciclo.
    if (!bulkPartial && !canonicalRefreshed) {
      set(state => {
        // La mercancía queda EN TRÁNSITO: se descuenta del origen y el destino
        // solo se acredita al confirmar la recepción (igual que el traslado
        // unitario). Acreditar aquí el destino inflaba el stock de la sucursal
        // receptora antes de recibir el lote y duplicaba unidades si el
        // operador confirmaba la recepción sin pasar por la reconciliación
        // canónica de la cola.
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
        status: serverConfirmed ? 'in_transit' as const : 'pending' as const,
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

    return { success: true, pending: bulkPartial || !canonicalRefreshed };
  },

  receiveTransfer: async (operationIds) => {
    const ids: string[] = Array.from(new Set<string>((operationIds || []).map((id): string => String(id || '')).filter(Boolean)));
    if (!ids.length) return { success: true, pending: false };
    // Coincidencia por identidad normalizada: la UI pasa la identidad cruda de
    // la fila, pero filas legadas pueden traer prefijos que el RPC sí entiende.
    const idKeys = new Set(ids.map(id => transferIdentityKey({ id, operationId: id })).filter(Boolean));
    const rows = (get().transfers || []).filter(t =>
      idKeys.has(transferIdentityKey(t)) && t.status === 'in_transit'
    );
    if (!rows.length) return { success: true, pending: false };
    const flightKey = 'receive:' + ids.join(',');
    if (transferResolutionInFlight.has(flightKey)) return { success: true, pending: false };
    transferResolutionInFlight.add(flightKey);
    try {
    const destinationIds = Array.from(new Set(rows.map(row => row.toBranchId).filter(Boolean)));

    // Asienta el estado visible local SIEMPRE (in_transit → target) de forma
    // idempotente; con creditStock=false no vuelve a mover stock porque la
    // nube ya lo resolvió y el refresco canónico traerá la verdad.
    const settleLocal = (targetStatus: InventoryTransfer['status'], creditStock: boolean, subsetIds: string[]) => {
      const resolution = settleTransferRows(
        get().transfers || [],
        get().inventory || [],
        subsetIds,
        targetStatus,
        { creditStock, creditSide: 'toBranchId' }
      );
      set({ inventory: resolution.inventory, transfers: resolution.transfers });
    };

    const queuePayload = {
      operationIds: ids,
      rows: rows.map(row => ({
        productId: row.productId,
        branchId: row.toBranchId,
        variantLabel: row.variantLabel || '',
        quantity: row.quantity
      }))
    };

    const online = typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed();
    if (!online) {
      settleLocal('completed', true, ids);
      await enqueueOfflineItem('transfer_receive', queuePayload, 'transfer-receive:' + ids.join(','));
      return { success: true, pending: true };
    }

    const freshIds: string[] = [];      // aplicado ahora por la nube: acreditar localmente
    const alreadyIds: string[] = [];    // ya recibido en la nube: sin crédito local
    const postedIds: string[] = [];     // una sola fase: asentar sin crédito + override
    const cancelledIds: string[] = [];  // la nube dice cancelado: asentar cancelado
    const missingIds: string[] = [];    // no existe en la nube: asentar recibido local
    const retryableIds: string[] = [];
    const unresolvedIds: string[] = [];
    const errors: string[] = [];

    for (const id of ids) {
      const res = await callReceiveTransferRPC(id);
      if (res.success) {
        const data = res.data || {};
        if (data.already_existed && String(data.status) === 'posted') postedIds.push(id);
        else if (data.already_existed) alreadyIds.push(id);
        else freshIds.push(id);
      } else {
        const kind = classifyTransferResolutionError(res.error || '', res.errorCode);
        if (kind === 'cancelled') {
          cancelledIds.push(id);
        } else if (kind === 'not_found') {
          missingIds.push(id);
        } else if (kind === 'retriable') {
          retryableIds.push(id);
          errors.push(res.error || 'La nube no confirmó la recepción.');
        } else {
          unresolvedIds.push(id);
          errors.push(res.error || 'La nube rechazó la recepción con un estado inesperado.');
        }
      }
    }

    if (freshIds.length) settleLocal('completed', true, freshIds);
    if (alreadyIds.length) settleLocal('completed', false, alreadyIds);
    if (postedIds.length) {
      settleLocal('completed', false, postedIds);
    }
    if (cancelledIds.length) settleLocal('cancelled', false, cancelledIds);
    if (missingIds.length) settleLocal('completed', false, missingIds);

    // Toda resolución terminal queda registrada como override persistente: si
    // la identidad no casa con las filas remotas del historial (prefijo legado,
    // traslado sin líneas, ...), el próximo pull no devolverá la fila a
    // 'en tránsito'. posted ya se cubre; ya-recibido, cancelado y no-existente
    // también son estados finales conocidos por la nube.
    if (postedIds.length) registerTransferStatusOverrides(postedIds, 'completed');
    if (alreadyIds.length) registerTransferStatusOverrides(alreadyIds, 'completed');
    if (cancelledIds.length) registerTransferStatusOverrides(cancelledIds, 'cancelled');
    if (missingIds.length) registerTransferStatusOverrides(missingIds, 'completed');

    if (retryableIds.length) {
      await enqueueOfflineItem('transfer_receive', { ...queuePayload, operationIds: retryableIds }, 'transfer-receive:' + retryableIds.join(','));
    }
    await refreshInventoryBranchesFromSupabase(set, get, destinationIds);
    await syncTransferHistory(set);

    if (retryableIds.length) {
      return { success: false, pending: true, error: errors.join(' ') || 'La recepción quedó pendiente de confirmación con la nube.' };
    }
    if (unresolvedIds.length) {
      return { success: false, pending: false, error: errors.join(' ') || 'La nube rechazó la recepción con un estado inesperado.' };
    }
    const warnings: string[] = [];
    if (postedIds.length) warnings.push('Traslado de una sola fase: ya estaba aplicado en el servidor; se marcó como recibido sin mover stock de nuevo.');
    if (alreadyIds.length) warnings.push('La nube ya tenía registrada la recepción; no se volvió a mover stock.');
    if (cancelledIds.length) warnings.push('El traslado estaba cancelado en la nube; se actualizó el estado local.');
    if (missingIds.length) warnings.push('El traslado no existe en la nube; se marcó como recibido localmente y se reconciliará.');
    return {
      success: true,
      pending: false,
      warning: warnings.join(' ') || undefined,
      alreadyApplied: freshIds.length === 0 && (alreadyIds.length > 0 || postedIds.length > 0 || cancelledIds.length > 0 || missingIds.length > 0)
    };
    } finally {
      transferResolutionInFlight.delete(flightKey);
    }
  },

  cancelTransfer: async (operationIds) => {
    const ids: string[] = Array.from(new Set<string>((operationIds || []).map((id): string => String(id || '')).filter(Boolean)));
    if (!ids.length) return { success: true, pending: false };
    const idKeys = new Set(ids.map(id => transferIdentityKey({ id, operationId: id })).filter(Boolean));
    const rows = (get().transfers || []).filter(t =>
      idKeys.has(transferIdentityKey(t)) && t.status === 'in_transit'
    );
    if (!rows.length) return { success: true, pending: false };
    const flightKey = 'cancel:' + ids.join(',');
    if (transferResolutionInFlight.has(flightKey)) return { success: true, pending: false };
    transferResolutionInFlight.add(flightKey);
    try {
    const originIds = Array.from(new Set(rows.map(row => row.fromBranchId).filter(Boolean)));

    // Asienta el estado visible local SIEMPRE (in_transit → target) de forma
    // idempotente; con creditStock=false no devuelve stock local porque la
    // nube ya lo resolvió y el refresco canónico traerá la verdad.
    const settleLocal = (targetStatus: InventoryTransfer['status'], creditStock: boolean, subsetIds: string[]) => {
      const resolution = settleTransferRows(
        get().transfers || [],
        get().inventory || [],
        subsetIds,
        targetStatus,
        { creditStock, creditSide: 'fromBranchId' }
      );
      set({ inventory: resolution.inventory, transfers: resolution.transfers });
    };

    const queuePayload = {
      operationIds: ids,
      rows: rows.map(row => ({
        productId: row.productId,
        branchId: row.fromBranchId,
        variantLabel: row.variantLabel || '',
        quantity: row.quantity
      }))
    };

    const online = typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed();
    if (!online) {
      settleLocal('cancelled', true, ids);
      await enqueueOfflineItem('transfer_cancel', queuePayload, 'transfer-cancel:' + ids.join(','));
      return { success: true, pending: true };
    }

    const freshIds: string[] = [];      // cancelado ahora por la nube: devolver stock al origen local
    const alreadyIds: string[] = [];    // ya cancelado en la nube: sin crédito local
    const missingIds: string[] = [];    // no existe en la nube: asentar cancelado local
    const resolvedIds: string[] = [];   // not_in_transit: la nube ya lo resolvió (recibido o de una sola fase)
    const retryableIds: string[] = [];
    const errors: string[] = [];

    for (const id of ids) {
      const res = await callCancelTransferRPC(id);
      if (res.success) {
        if (res.data?.already_existed) alreadyIds.push(id);
        else freshIds.push(id);
      } else {
        const kind = classifyTransferResolutionError(res.error || '', res.errorCode);
        if (kind === 'not_found') {
          missingIds.push(id);
        } else if (kind === 'retriable') {
          retryableIds.push(id);
          errors.push(res.error || 'La nube no confirmó la cancelación.');
        } else {
          // 'not_in_transit': la nube ya resolvió el traslado (recibido, o
          // legacy de una sola fase ya aplicado). No hay nada que cancelar: se
          // asienta como recibido y desaparece de la lista de acciones.
          resolvedIds.push(id);
        }
      }
    }

    if (freshIds.length) settleLocal('cancelled', true, freshIds);
    if (alreadyIds.length) settleLocal('cancelled', false, alreadyIds);
    if (missingIds.length) settleLocal('cancelled', false, missingIds);
    if (resolvedIds.length) settleLocal('completed', false, resolvedIds);

    if (alreadyIds.length) registerTransferStatusOverrides(alreadyIds, 'cancelled');
    if (missingIds.length) registerTransferStatusOverrides(missingIds, 'cancelled');
    if (resolvedIds.length) registerTransferStatusOverrides(resolvedIds, 'completed');

    if (retryableIds.length) {
      await enqueueOfflineItem('transfer_cancel', { ...queuePayload, operationIds: retryableIds }, 'transfer-cancel:' + retryableIds.join(','));
    }
    await refreshInventoryBranchesFromSupabase(set, get, originIds);
    await syncTransferHistory(set);

    if (retryableIds.length) {
      return { success: false, pending: true, error: errors.join(' ') || 'La cancelación quedó pendiente de confirmación con la nube.' };
    }
    if (errors.length) {
      return { success: false, pending: false, error: errors.join(' ') };
    }
    const warnings: string[] = [];
    if (alreadyIds.length) warnings.push('La nube ya tenía registrada la cancelación; no se volvió a mover stock.');
    if (missingIds.length) warnings.push('El traslado no existe en la nube; se marcó como cancelado localmente y se reconciliará.');
    if (resolvedIds.length) warnings.push('La nube ya tenía el traslado resuelto; se marcó como recibido sin mover stock.');
    return {
      success: true,
      pending: false,
      warning: warnings.join(' ') || undefined,
      alreadyApplied: freshIds.length === 0 && (alreadyIds.length > 0 || missingIds.length > 0 || resolvedIds.length > 0)
    };
    } finally {
      transferResolutionInFlight.delete(flightKey);
    }
  },
  };
}
