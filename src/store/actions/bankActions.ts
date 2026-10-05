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
import { INITIAL_BANK_CARDS } from '../storeInitialData';


type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void;
type StoreGet = () => AppState;

export function createBankActions(set: StoreSet, get: StoreGet): Partial<AppState> {
  return {
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
    let found: import('../../types').BankCard | undefined;
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
    updateBankCardMetadataToSupabase(metadata as import('../../types').BankCard).then(ok => {
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
            await get().reconcileBankBalances();
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
    const uniqueTxs: import('../../types').BankTransaction[] = [];
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
  };
}
