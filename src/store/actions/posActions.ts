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
import { buildLocalVoidTransactionPatch } from '../utils/localVoidTransaction';
import { setCanonicalInventoryQuantity } from '../utils/inventoryTransforms';
import { generateId, generateReadableId } from '../../lib/utils';
import { normalizeSemanticText } from '../../utils/textUtils';
import { getActiveTenant } from '../../services/tenant';
import { pushWarrantyToSupabase, callCancelSessionRPC, pullBranchInventoryFromSupabase } from '../../services/supabaseSync';
import { flushLocalStateStorage } from '../../services/localStateStorage';

type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;


async function refreshInventoryBranchesFromSupabase(set: StoreSet, get: StoreGet, branchIds: string[]): Promise<boolean> {
  const ids = Array.from(new Set(branchIds.filter(Boolean)));
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

export function createPosActions(set: StoreSet, get: StoreGet): any {
  return {
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

    // Primero persistimos la operación en la cola durable. Así, aunque la
    // pestaña se cierre durante el cobro, existe una operación reintentable.
    const durableTransaction = { ...transaction, offlinePending: true };
    await enqueueOfflineItem('transaction', durableTransaction, transaction.id);

    // Offline real o conexión inestable: el POS debe conservar inmediatamente
    // la venta localmente. En una conexión mala navigator.onLine puede seguir
    // siendo true aunque la RPC falle por timeout/DNS/TLS.
    const applyLocalSale = async (pending: boolean) => {
      const localTransaction = { ...transaction, offlinePending: pending };
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

  deleteTransaction: async (id: string, reason?: string) => {
    const state = get();
    const tx = (state.transactions || []).find(t => t.id === id);
    if (!tx || tx.deletedAt) return false;
    const userId = state.currentUser?.id || 'system';
    const finalReason = reason || 'Anulación de venta';

    if (!navigator.onLine) {
      await enqueueOfflineItem('void_transaction', { id, remoteId: tx.remoteId || id, userId, reason: finalReason }, 'void:' + id);
      set(current => buildLocalVoidTransactionPatch(current, tx));
      const deletedAt = new Date().toISOString();
      set((current) => ({
        transactions: current.transactions.map(t => t.id === id ? { ...t, deletedAt, deletedBy: userId, deleteReason: finalReason } : t)
      }));
      return true;
    }

    await enqueueOfflineItem('void_transaction', { id, remoteId: tx.remoteId || id, userId, reason: finalReason }, 'void:' + id);
    try {
      const res = await callVoidTransactionRPC(tx.remoteId || id, userId, finalReason);
      if (!res.success) throw new Error(res.error || 'No se pudo anular la venta');
      set(current => buildLocalVoidTransactionPatch(current, tx));
      const deletedAt = new Date().toISOString();
      set((current) => ({
        transactions: current.transactions.map(t => t.id === id ? { ...t, deletedAt, deletedBy: userId, deleteReason: finalReason } : t)
      }));

      const inventoryReconciled = await get().refreshBranchInventory();
      const { pullBankDataFromSupabase } = await import('../../services/supabaseSync');
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

  cancelSession: async (sessionId: string, reason = 'Cancelación de turno', password?: string) => {
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
      __operation: 'cancel',
      requiresEmployeePassword: true
    };

    // La cancelación se confirma primero en Supabase. Nunca marcamos un turno
    // como cancelado localmente si la respuesta del servidor es incierta: así
    // un timeout no convierte una operación sin contraseña en una cancelación.
    if (typeof navigator === 'undefined' || !navigator.onLine) {
      get().addNotification(
        'Conexión necesaria para cancelar el turno',
        'warning',
        'La contraseña se valida contra el empleado que abrió la caja. Conéctate a Internet para confirmar la cancelación de forma segura.'
      );
      return false;
    }

    try {
      const res = await callCancelSessionRPC(sessionId, userId, reason, password);
      if (!res.success) {
        get().addNotification(res.error || 'No se pudo cancelar el turno.', 'error');
        return false;
      }

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
      const { pullBankDataFromSupabase } = await import('../../services/supabaseSync');
      const bankRes = await pullBankDataFromSupabase();
      if (!inventoryReconciled || !bankRes.success) {
        get().addNotification('Turno cancelado, pero la reconciliación local aún está pendiente.', 'warning');
      } else {
        set({ bankCards: bankRes.bankCards, bankTransactions: bankRes.bankTransactions });
      }
      removeFromOfflineQueueByAction('cash_session', 'cash-cancel:' + sessionId);
      await flushLocalStateStorage();
      return true;
    } catch (err) {
      console.warn('[cancelSession] No se pudo confirmar la cancelación:', err);
      get().addNotification(
        'No se pudo confirmar la cancelación',
        'warning',
        'El turno permanece abierto. Vuelve a intentarlo con conexión estable; PALMYRA no lo cancelará sin validación.'
      );
      return false;
    }

    // La cancelación de caja requiere validación contra el empleado que abrió
    // el turno. No permitimos cancelaciones offline porque el dispositivo no
    // conserva la contraseña en el estado persistido y no debemos aceptar una
    // credencial que no pueda validar el servidor.
    if (typeof navigator === 'undefined' || !navigator.onLine) {
      get().addNotification(
        'Conexión necesaria para cancelar el turno',
        'warning',
        'La contraseña se valida contra el empleado que abrió la caja. Conéctate a Internet para confirmar la cancelación de forma segura.'
      );
      return false;
    }

    return false;
  },

  createReturn: (returnItem) => {
    const newReturn = { ...returnItem, id: returnItem.id || generateReadableId('DEV', get().returns.length) };
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
    set((state) => ({
      returns: state.returns.map(r => r.id === id ? { ...r, ...returnItem } : r)
    }));
    const updated = get().returns.find(r => r.id === id);
    if (updated) {
      import('../../services/supabaseSync').then(({ pushReturnToSupabase }) => {
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
          const { pushReturnToSupabase } = await import('../../services/supabaseSync');
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
  };
}
