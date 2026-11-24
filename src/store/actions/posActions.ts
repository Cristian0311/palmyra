import type { Branch, Category, Product, InventoryLevel, CartItem, Transaction, ReturnItem, Currency, Customer, CashRegisterSession, User, PendingOrder, SalarySettlement, InventoryTransfer, Warranty, CashMovement, Supplier, SupplierOrder, InventoryAudit, FiscalConfig, DemandForecast, BankCard, BankTransaction } from '../../types';
import type { AppState } from '../storeTypes';
import {
  pushTransactionToSupabase,
  deleteTransactionFromSupabase,
  callProcessTransactionRPC,
  callVoidTransactionRPC,
  callCompleteReturnRPC,
} from '../../services/supabaseSync';
import { enqueueOfflineItem, getOfflineQueue, waitForOfflineQueueReady } from '../../services/offlineQueue';
import { removeFromOfflineQueueByAction, removeFromOfflineQueueByTransactionId } from '../../services/offlineQueue/outboxUtils';
import { buildLocalCompletedSalePatch } from '../utils/localCompletedSale';
import { buildLocalVoidTransactionsPatch, canVoidSales } from '../utils/localVoidTransaction';
import { purgeCancelledShift } from '../utils/purgeCancelledShift';
import { createVoidTransactionAction } from '../utils/voidTransactionAction';
import { stableLegacySaleUuid } from '../../services/supabaseSync/rpc';
import { setCanonicalInventoryQuantity } from '../utils/inventoryTransforms';
import { generateId, generateReadableId } from '../../lib/utils';
import { normalizeSemanticText } from '../../utils/textUtils';
import { getActiveTenant } from '../../services/tenant';
import { pushWarrantyToSupabase, callCancelSessionRPC, pullBranchInventoryFromSupabase } from '../../services/supabaseSync';
import { flushLocalStateStorage } from '../../services/localStateStorage';
import { isCloudBusinessSyncAllowed } from '../../services/localPlanMode';
import { mirrorCompletedSale, mirrorSaleVoid } from '../../services/localDb/posWriteThrough';

type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;


/**
 * A cancelled shift leaves no trace: stock goes back, the bank reversal is
 * applied when possible, and the session, its tickets and its salary
 * settlement are removed from the local snapshot instead of being kept as
 * "cancelled" rows.
 */
function applyCancelledShiftPatch(
  set: StoreSet,
  get: StoreGet,
  sessionId: string,
  sales: Transaction[],
  audit: { userId: string; reason: string; date: string },
) {
  const state = get();
  let voidPatch: ReturnType<typeof buildLocalVoidTransactionsPatch>;
  try {
    voidPatch = buildLocalVoidTransactionsPatch(state, sales, audit);
  } catch (error) {
    // The server already voided the shift; the local bank copy is refreshed
    // right after, so an insufficient local balance must not block the purge.
    console.warn('[cancelSession] Reversión bancaria local omitida; se reconciliará con Supabase:', error);
    voidPatch = buildLocalVoidTransactionsPatch(state, sales, audit, { reverseBank: false });
  }
  set({ ...voidPatch, ...purgeCancelledShift(state, sessionId, sales.map(sale => sale.id)) });
}

async function refreshInventoryBranchesFromSupabase(set: StoreSet, get: StoreGet, branchIds: string[]): Promise<boolean> {  const ids = Array.from(new Set(branchIds.filter(Boolean)));
  if (!ids.length) return true;
  try {
    const results = await Promise.all(ids.map(id => pullBranchInventoryFromSupabase(id)));
    if (results.some(result => !result.success)) return false;
    const byKey = new Map<string, any>();
    get().inventory.forEach(item => { if (!ids.includes(item.branchId)) byKey.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item); });
    for (const result of results) for (const item of result.inventory) byKey.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
    set({ inventory: Array.from(byKey.values()) });
    return true;
  } catch { return false; }
}

/**
 * Stock disponible de una variante en la sucursal activa. Devuelve null cuando
 * no hay fila de inventario para el producto: en ese caso no se bloquea la
 * venta (p. ej. catálogo aún sin sincronizar).
 */
function availableStockFor(state: any, productId: string, variantLabel?: string): number | null {
  const branchId = state.currentBranchId;
  const rows = (state.inventory || []).filter((row: any) =>
    row.productId === productId && (!branchId || !row.branchId || row.branchId === branchId)
  );
  if (!rows.length) return null;
  const scoped = rows.filter((row: any) => (row.variantLabel || '') === (variantLabel || ''));
  if (!scoped.length) return null;
  return scoped.reduce((sum: number, row: any) => sum + Math.max(0, Number(row.quantity) || 0), 0);
}

export function createPosActions(set: StoreSet, get: StoreGet): any {
  const cancellingSessions = new Set<string>();
  return {
  cart: [],
  currentCustomerId: undefined,
  setCartCustomer: (customerId) => set({ currentCustomerId: customerId }),
  addToCart: (product, serialNumber, attributes, requestedQuantity = 1) => {
    const variantLabel = attributes?.variantLabel || attributes?.size || attributes?.color;
    const requested = Math.max(1, Math.floor(Number(requestedQuantity) || 1));
    const cap = availableStockFor(get(), product.id, variantLabel);
    if (cap !== null && cap <= 0) {
      get().addNotification(
        'Sin stock disponible',
        'warning',
        `${product.name} no tiene existencias en la sucursal activa.`
      );
      return;
    }
    const quantity = cap === null ? requested : Math.min(requested, cap);
    if (cap !== null && quantity < requested) {
      get().addNotification(
        'Cantidad limitada por stock',
        'warning',
        `${product.name}: solo hay ${cap} unidad(es) disponibles; se agregaron ${quantity}.`
      );
    }
    set((state) => {

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
        const nextQuantity = cap === null
          ? existing.quantity + quantity
          : Math.min(existing.quantity + quantity, cap);
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
    });
  },

  updateCartQty: (cartItemId, delta) => set((state) => ({
    cart: state.cart.map(item => {
      if (item.id === cartItemId) {
        // Productos con serie no deben cambiar cantidad > 1 (o se divide, pero simplificamos así)
        if (item.product.hasSerial && delta > 0) return item;
        const cap = delta > 0 ? availableStockFor(state, item.product.id, item.variantLabel) : null;
        const requestedQty = Math.max(0, item.quantity + delta);
        const newQty = cap === null ? requestedQty : Math.min(requestedQty, cap);
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
    import('../../services/supabaseSync').then(({ pushQuoteToSupabase }) => {
      pushQuoteToSupabase(quote).catch(() => {});
    }).catch(() => {});
  },
  updateQuote: (id, updates) => {
    set((state) => ({ quotes: state.quotes.map(q => q.id === id ? { ...q, ...updates } : q) }));
    const updated = get().quotes.find(q => q.id === id);
    if (updated) {
      import('../../services/supabaseSync').then(({ pushQuoteToSupabase }) => {
        pushQuoteToSupabase(updated).catch(() => {});
      }).catch(() => {});
    }
  },
  deleteQuote: (id) => {
    const queueDelete = () => {
      enqueueOfflineItem('quote_delete', { id }, `quote-delete:${id}`).catch(() => {});
    };
    set((state) => ({ quotes: state.quotes.filter(q => q.id !== id) }));
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      queueDelete();
      return;
    }
    import('../../services/supabaseSync').then(({ deleteQuoteFromSupabase }) => {
      deleteQuoteFromSupabase(id).then((ok) => { if (!ok) queueDelete(); }).catch(queueDelete);
    }).catch(queueDelete);
  },

  timeShifts: [],
  addTimeShift: (shift) => {
    set((state) => ({ timeShifts: [shift, ...state.timeShifts] }));
    import('../../services/supabaseSync').then(({ pushTimeShiftToSupabase }) => {
      pushTimeShiftToSupabase(shift).catch(() => {});
    }).catch(() => {});
  },
  updateTimeShift: (id, updates) => {
    set((state) => ({ timeShifts: state.timeShifts.map(s => s.id === id ? { ...s, ...updates } : s) }));
    const updated = get().timeShifts.find(s => s.id === id);
    if (updated) {
      import('../../services/supabaseSync').then(({ pushTimeShiftToSupabase }) => {
        pushTimeShiftToSupabase(updated).catch(() => {});
      }).catch(() => {});
    }
  },
  processTransaction: async (transaction) => {
    // La cola debe estar hidratada antes de aceptar una venta. Esto evita que
    // una venta creada justo después de abrir/recargar el POS compita con la
    // migración inicial de IndexedDB y quede fuera del snapshot durable.
    await waitForOfflineQueueReady();

    // Asignamos una identidad remota UUID estable ANTES de encolar la venta.
    // Los tickets antiguos pueden usar IDs legibles (PALMYRA-TK..., INF-..., etc.)
    // que no son UUID. Si generamos un UUID distinto en cada reintento y la
    // primera RPC alcanzó a confirmar antes de perder la respuesta, el replay
    // podría crear una segunda venta. El remoteId queda dentro de IndexedDB y
    // acompaña a la venta durante todo su ciclo de vida.
    const stableRemoteId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(transaction.remoteId || ''))
      ? String(transaction.remoteId)
      : (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(transaction.id || ''))
        ? String(transaction.id)
        : crypto.randomUUID());
    const transactionForSync = { ...transaction, remoteId: stableRemoteId };
    
    // Primero persistimos la operación en la cola durable. Así, aunque la
    // pestaña se cierre durante el cobro, existe una operación reintentable.
    const durableTransaction = { ...transactionForSync, offlinePending: true };
    await enqueueOfflineItem('transaction', durableTransaction, transaction.id);

    // Offline real o conexión inestable: el POS debe conservar inmediatamente
    // la venta localmente. En una conexión mala navigator.onLine puede seguir
    // siendo true aunque la RPC falle por timeout/DNS/TLS.
    const applyLocalSale = async (pending: boolean) => {
      const localTransaction = { ...transactionForSync, offlinePending: pending };
      const alreadyLocal = get().transactions.some(
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
      // Espejo directo al almacén normalizado: sin await para no sumar latencia
      // al cobro (la función captura sus propios errores). Se espeja la venta
      // tal como quedó en la store, que es lo que verá la sombra en el JSON.
      const settled = get().transactions.find(t => t.id === localTransaction.id);
      void mirrorCompletedSale(settled ?? localTransaction);
    };

    // El plan Gratis no tiene nube: la venta es local aunque el teléfono esté online.
    if (typeof navigator === 'undefined' || navigator.onLine === false || !isCloudBusinessSyncAllowed()) {
      await applyLocalSale(true);
      return true;
    }

    try {
      const res = await callProcessTransactionRPC(transactionForSync);

      if (!res.success) {
        const code = String(res.errorCode || '');
        // Solo rechazos de negocio/consistencia explícitos son definitivos.
        // Los errores de transporte permanecen pendientes para reintento.
        const permanentCodes = new Set([
          'P0001', '23503', '23505', '23502', '23514', '42501', '42883', '22P02', '22003', '22007', 'IDEMPOTENCY_CONFLICT'
        ]);

        if (permanentCodes.has(code)) {
          removeFromOfflineQueueByTransactionId(transaction.id);
          console.error('[processTransaction] Operación rechazada por servidor:', res.error);
          const friendly = {
            'invalid_product': 'El producto de la venta no existe o no está activo en la empresa.',
            'invalid_warehouse': 'El almacén seleccionado no es válido para esta empresa.',
            'location_access_denied': 'La cuenta no tiene acceso al almacén seleccionado.',
            'invalid_cash_session': 'El turno de caja ya no está abierto o pertenece a otro almacén.',
            'insufficient_stock': 'No hay stock suficiente para completar la venta.',
            'insufficient_component_stock': 'No hay stock suficiente para uno de los componentes del producto.',
            'invalid_variant': 'La variante seleccionada ya no está disponible.',
            'serial_not_available': 'El número de serie seleccionado ya no está disponible.',
            'total_mismatch': 'El total de la venta no coincide con sus artículos.',
            'payment_total_mismatch': 'El total cobrado no coincide con el total de la venta.',
            'cash_session_required': 'El pago en efectivo necesita un turno de caja abierto.',
            'plan_feature_required': 'El plan actual no tiene habilitada esta función del POS.'
          }[String(res.error || '')] || String(res.error || 'El servidor rechazó la venta.');
          get().addNotification('Venta rechazada', 'error', friendly);
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
      const inventoryReconciled = await refreshInventoryBranchesFromSupabase(set, get, [transaction.branchId]);
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

  deleteTransaction: createVoidTransactionAction({
    get, set,
    ready: waitForOfflineQueueReady,
    enqueue: data => enqueueOfflineItem('void_transaction', data, 'void:' + data.id),
    remove: id => removeFromOfflineQueueByAction('void_transaction', 'void:' + id),
    resolveId: async id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id : stableLegacySaleUuid((await getActiveTenant()).companyId, id),
    hasPendingSale: id => getOfflineQueue().some(item => item.type === 'transaction' && item.data?.id === id),
    online: () => typeof navigator !== 'undefined' && navigator.onLine && isCloudBusinessSyncAllowed(),
    rpc: callVoidTransactionRPC,
    flush: flushLocalStateStorage,
    // La anulación se espeja al libro local sin bloquear ni cambiar la baja.
    onVoided: transaction => {
      void mirrorSaleVoid(transaction);
    },
    reconcile: async branchId => {
      const inventoryOk = await refreshInventoryBranchesFromSupabase(set, get, [branchId]);
      const { pullBankDataFromSupabase } = await import('../../services/supabaseSync');
      const banks = await pullBankDataFromSupabase();
      if (banks.success) set({ bankCards: banks.bankCards, bankTransactions: banks.bankTransactions });
      return inventoryOk && banks.success;
    },
  }),

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
    if (!session || cancellingSessions.has(sessionId)) return false;
    if (!canVoidSales(state.currentUser, session.branchId) ||
        (state.currentUser?.role !== 'admin' && !state.currentUser?.permissions?.includes('cash.close'))) {
      state.addNotification('Se requieren permisos de anulación de ventas y cierre de caja.', 'warning');
      return false;
    }
    if (session.status === 'cancelled') return true;
    if (reason.trim().length < 3) {
      state.addNotification('Indica un motivo para anular el turno.', 'warning');
      return false;
    }
    await waitForOfflineQueueReady();
    // Un turno se puede anular sin conexión aunque su cola aún contenga ventas,
    // devoluciones, cobros o la apertura de ESE mismo turno: el grafo de
    // dependencias de offlineSync ordena todo eso antes de `cash-cancel` y el
    // RPC de anulación es idempotente. Solo bloqueamos lo que el replay no puede
    // resolver de forma segura: operaciones en conflicto (nunca se reintentan) y
    // operaciones de OTROS turnos, que no pueden reordenarse detrás de esta
    // cancelación sin alterar el historial de ese otro turno.
    const belongsToThisSession = (item: { type: string; data?: any }): boolean => {
      const data = item.data || {};
      if (item.type === 'cash_session') return String(data.id || '') === sessionId;
      if (item.type === 'transaction') {
        if (data.sessionId) return String(data.sessionId) === sessionId;
        // Ventas antiguas sin turno: el grafo las vincula por sucursal y fecha.
        const saleTime = new Date(data.date).getTime();
        const openTime = new Date(session.openedAt).getTime();
        const closeTime = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;
        return (data.branchId || data.warehouseId) === session.branchId &&
          Number.isFinite(saleTime) && Number.isFinite(openTime) &&
          saleTime >= openTime && saleTime <= closeTime;
      }
      if (item.type === 'void_transaction') {
        const sale = (state.transactions || []).find(tx => tx.id === data.id || tx.remoteId === data.remoteId);
        return !!sale && sale.sessionId === sessionId;
      }
      if (item.type === 'return_complete') {
        const returnRequest = (state.returns || []).find(r => r.id === data.id);
        return !!returnRequest &&
          (state.transactions || []).some(tx => tx.id === returnRequest.transactionId && tx.sessionId === sessionId);
      }
      return false;
    };
    const blockingItems = getOfflineQueue().filter(item =>
      ['transaction', 'void_transaction', 'return_complete', 'cash_session'].includes(item.type) &&
      (item.status === 'conflict' || !belongsToThisSession(item))
    );
    if (blockingItems.length) {
      state.addNotification('Sincroniza las ventas, devoluciones y turnos pendientes antes de anular el turno completo.', 'warning');
      return false;
    }

    const userId = state.currentUser!.id;
    const cancelledAt = new Date().toISOString();

    if (!isCloudBusinessSyncAllowed()) {
      // Plan Gratis: no hay autoridad remota. Se aplica la misma eliminación
      // integral en este dispositivo con los permisos ya verificados arriba.
      const sessionSales = get().transactions.filter(tx => tx.sessionId === sessionId && !tx.deletedAt);
      const audit = { userId, reason: reason.trim(), date: cancelledAt };
      applyCancelledShiftPatch(set, get, sessionId, sessionSales, audit);
      await flushLocalStateStorage();
      state.addNotification(
        'Turno eliminado por completo.',
        'success',
        `Se reintegraron ${sessionSales.length} venta(s) al inventario local y el turno dejó de existir en este dispositivo. El plan Gratis no sincroniza esta eliminación con la nube.`
      );
      return true;
    }

    // La sesión autenticada y el permiso cash.close se validan en Supabase.
    // No se requiere una contraseña adicional del empleado para esta acción.
    if (typeof navigator === 'undefined' || !navigator.onLine) {
      // Sin conexión: se aplica la misma cancelación integral en este equipo y la
      // intención queda en la cola durable. Al reconectar, el grafo de
      // dependencias empuja primero ventas/devoluciones del turno y después
      // `cash-cancel`, que ejecuta el RPC idempotente de anulación.
      const cancelReason = reason.trim().slice(0, 500);
      const audit = { userId, reason: cancelReason, date: cancelledAt };
      const sessionSales = get().transactions.filter(tx => tx.sessionId === sessionId && !tx.deletedAt);
      cancellingSessions.add(sessionId);
      try {
        await enqueueOfflineItem(
          'cash_session',
          { ...session, __operation: 'cancel', cancelReason, cancelUserId: userId, cancelledAt },
          'cash-cancel:' + sessionId
        );
        try {
          applyCancelledShiftPatch(set, get, sessionId, sessionSales, audit);
          await flushLocalStateStorage();
        } catch (patchError) {
          // La intención ya es durable: se conserva y se reconcilia al reconectar.
          console.warn('[cancelSession] Anulación encolada; limpieza local pendiente:', patchError);
          get().addNotification(
            'Turno anulado; limpieza local pendiente.',
            'warning',
            'La cancelación se confirmará en la nube al reconectar.'
          );
          return true;
        }
        get().addNotification(
          'Turno anulado en este equipo. Se confirmará en la nube al reconectar.',
          'success',
          `Se reintegraron ${sessionSales.length} venta(s) al inventario local y el turno quedó fuera de este dispositivo.`
        );
        return true;
      } catch (error) {
        get().addNotification(
          'No se pudo anular el turno en este equipo.',
          'error',
          error instanceof Error ? error.message : 'Error de persistencia local.'
        );
        return false;
      } finally {
        cancellingSessions.delete(sessionId);
      }
    }

    cancellingSessions.add(sessionId);
    let confirmed = false;
    try {
      const res = await callCancelSessionRPC(sessionId, userId, reason.trim().slice(0, 500));
      if (!res.success) {
        get().addNotification(res.error || 'No se pudo cancelar el turno.', 'error');
        return false;
      }

      // Older servers only marked the turn voided. Never invent stock restores
      // for sales that the server did not explicitly confirm as voided.
      if (!Array.isArray(res.data?.voided_sale_ids)) {
        state.addNotification('El servidor no confirmó la anulación de las ventas. Se requiere actualizar el RPC de anulación de turnos.', 'error');
        return false;
      }
      confirmed = true;
      const voidedIds = new Set<string>(res.data.voided_sale_ids);
      // Only the sales the server explicitly confirmed are restored. Tickets
      // without remoteId were voided server-side through the same turn, so they
      // are matched by session; a sale confirmed elsewhere is never re-restored.
      const sessionSales = get().transactions.filter(tx =>
        tx.sessionId === sessionId && !tx.deletedAt &&
        (voidedIds.has(tx.remoteId || tx.id) || !tx.remoteId));
      const audit = { userId, reason, date: cancelledAt };
      applyCancelledShiftPatch(set, get, sessionId, sessionSales, audit);
      await flushLocalStateStorage();

      const inventoryReconciled = await refreshInventoryBranchesFromSupabase(set, get, [session.branchId]);
      const { pullBankDataFromSupabase } = await import('../../services/supabaseSync');
      const bankRes = await pullBankDataFromSupabase();
      if (!inventoryReconciled || !bankRes.success) {
        get().addNotification('Turno eliminado, pero la reconciliación local aún está pendiente.', 'warning');
      } else {
        set({ bankCards: bankRes.bankCards, bankTransactions: bankRes.bankTransactions });
        get().addNotification('Turno eliminado por completo.', 'success', 'El turno, sus ventas y su liquidación se eliminaron y el stock volvió al inventario.');
      }
      removeFromOfflineQueueByAction('cash_session', 'cash-cancel:' + sessionId);
      await flushLocalStateStorage();
      return true;
    } catch (err) {
      console.warn('[cancelSession] No se pudo confirmar la cancelación:', err);
      get().addNotification(
        confirmed ? 'Turno anulado; reconciliación local pendiente.' : 'No se pudo confirmar la anulación. Sincroniza y vuelve a intentarlo.',
        'warning'
      );
      return confirmed;
    } finally {
      cancellingSessions.delete(sessionId);
    }
  },

  createReturn: (returnItem) => {
    const newReturn = { ...returnItem, id: returnItem.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(returnItem.id) ? returnItem.id : crypto.randomUUID() };
    set((state) => ({
      returns: [newReturn, ...state.returns.filter(r => r.id !== newReturn.id)]
    }));
    // Registrar inmediatamente la intención en la cola durable para evitar una
    // carrera entre "crear devolución" y "completar devolución".
    void enqueueOfflineItem('return', newReturn, newReturn.id);
    import('../../services/supabaseSync').then(({ pushReturnToSupabase }) => {
      pushReturnToSupabase(newReturn).catch(() => {});
    }).catch(() => {});
  },
  updateReturn: (id, returnItem) => {
    const previous = get().returns.find(r => r.id === id);
    set((state) => ({
      returns: state.returns.map(r => r.id === id ? { ...r, ...returnItem } : r)
    }));
    const updated = get().returns.find(r => r.id === id);
    if (updated) {
      const refundKeys: (keyof typeof updated)[] = ['refundStatus', 'refundAmount', 'refundCurrencyCode', 'refundMethod', 'refundBankCardId', 'refundTransactionId', 'refundedAt'];
      const refundChanged = refundKeys.some(key => (previous as any)?.[key] !== (updated as any)?.[key]);
      import('../../services/supabaseSync').then(({ pushReturnToSupabase, pushReturnRefundToSupabase }) => {
        pushReturnToSupabase(updated).catch(() => {});
        if (refundChanged) pushReturnRefundToSupabase(updated).catch(() => {});
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
      await enqueueOfflineItem('return_complete', { id, remoteId: returnReq.serverReturnId || id, userId }, 'return:' + id);
      if (navigator.onLine && isCloudBusinessSyncAllowed()) {
        try {
          // Primero confirmamos la existencia de la devolución en la nube. Así
          // "Completar" nunca corre antes que "Crear devolución".
          const { pushReturnToSupabase } = await import('../../services/supabaseSync');
          const persisted = await pushReturnToSupabase(returnReq);
          if (!persisted) throw new Error('La devolución todavía no está confirmada en Supabase.');
          removeFromOfflineQueueByAction('return', returnReq.id);

          const res = await callCompleteReturnRPC(returnReq.serverReturnId || id, userId);
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
  };
}
