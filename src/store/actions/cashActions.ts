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

export function createCashActions(set: StoreSet, get: StoreGet): Partial<AppState> {
  return {
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
        import('../../services/supabaseSync').then(({ pushSalarySettlementToSupabase }) => {
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
  };
}
