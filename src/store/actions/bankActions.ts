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

/**
 * Valores canónicos que llegan desde Supabase (`credit`/`debit`/`transfer`) y
 * los que usa la UI (`deposit`/`withdrawal`/`payment_received`/`supplier_payment`).
 * Cualquier otro valor se trata como desconocido: NUNCA se convierte en
 * `withdrawal`, porque eso invertiría el signo del dinero en pantalla.
 */
const BANK_TRANSACTION_TYPE_ALIASES: Record<string, BankTransaction['type']> = {
  credit: 'deposit',
  deposit: 'deposit',
  payment_received: 'deposit',
  debit: 'withdrawal',
  withdrawal: 'withdrawal',
  supplier_payment: 'withdrawal',
  transfer: 'withdrawal',
  transfer_out: 'withdrawal',
  transfer_in: 'deposit'
};

/** Devuelve el tipo de movimiento normalizado o `null` si no es reconocible. */
export function normalizeBankTransactionType(raw: unknown): BankTransaction['type'] | null {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return null;
  return BANK_TRANSACTION_TYPE_ALIASES[key] ?? null;
}

export type BankRefreshResult = {
  success: boolean;
  /** No se consultó la nube: cooldown o una carga ya estaba en curso. */
  skipped: boolean;
  offline?: boolean;
  message?: string;
  transactionCount: number;
  /** Movimientos remotos descartados por traer un tipo no reconocido. */
  unknownTypeCount: number;
};

/** Evita que la página dispare una consulta remota por cada render/foco. */
export const BANK_REFRESH_COOLDOWN_MS = 20_000;
let lastBankPullAt = 0;
let bankPullInFlight: Promise<BankRefreshResult> | null = null;

/** Solo para pruebas o para forzar la primera carga tras iniciar sesión. */
export function resetBankRefreshCooldown(): void {
  lastBankPullAt = 0;
}

function bankQueuePendingKeys(): { transactionKeys: Set<string>; cardIds: Set<string> } {
  const transactionKeys = new Set<string>();
  const cardIds = new Set<string>();
  let queue: ReturnType<typeof getOfflineQueue> = [];
  try { queue = getOfflineQueue() || []; } catch { queue = []; }
  for (const item of queue) {
    if (item.status === 'conflict') continue;
    const data: any = item.data || {};
    if (item.type === 'bank_transaction' || item.type === 'bank_transaction_delete' ||
        item.type === 'bank_internal_transfer' || item.type === 'bank_internal_transfer_delete') {
      for (const key of [data.id, data.transactionId, data.operationId, data.reference]) {
        if (key) transactionKeys.add(String(key));
      }
      if (data.operationId) {
        transactionKeys.add(`${data.operationId}:OUT`);
        transactionKeys.add(`${data.operationId}:IN`);
      }
      for (const cardId of [data.cardId, data.fromCardId, data.toCardId]) {
        if (cardId) cardIds.add(String(cardId));
      }
    }
    if (item.type === 'bank_card' || item.type === 'bank_card_balance' || item.type === 'bank_card_delete') {
      if (data.id) cardIds.add(String(data.id));
    }
  }
  return { transactionKeys, cardIds };
}

function bankTransactionIdentityKeys(tx: BankTransaction): string[] {
  const keys: string[] = [];
  if (tx.id) keys.push(`id:${tx.id}`);
  if (tx.transactionId) keys.push(`tx:${tx.cardId}::${tx.transactionId}`);
  if (tx.reference) keys.push(`ref:${tx.cardId}::${tx.reference}`);
  return keys;
}

/** Valor "desnudo" de una clave de identidad (`id:X`, `tx:card::Y` → `X`, `Y`). */
function bankIdentityValue(key: string): string {
  const afterType = key.slice(key.indexOf(':') + 1);
  return afterType.includes('::') ? afterType.split('::').pop() || afterType : afterType;
}

/**
 * Una fila con id UUID vino de la nube en una carga anterior. Si hoy ya no
 * aparece allí, se eliminó remotamente y no debe resucitar. Los ids locales
 * (`BTX-…`, `ref:OUT`) sí se conservan porque la nube aún no los conoce.
 */
function isRemoteBankTransactionId(id: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

/**
 * Une el snapshot remoto con el estado local sin perder trabajo del dispositivo:
 * los movimientos pendientes de sincronizar y las filas creadas offline siguen
 * visibles aunque todavía no existan en la nube.
 */
function mergeBankState(
  local: { bankCards: BankCard[]; bankTransactions: BankTransaction[] },
  remote: { bankCards: BankCard[]; bankTransactions: BankTransaction[] }
): { bankCards: BankCard[]; bankTransactions: BankTransaction[]; unknownTypeCount: number } {
  const pending = bankQueuePendingKeys();
  const remoteTransactions = remote.bankTransactions || [];
  const remoteKeys = new Set<string>();
  for (const tx of remoteTransactions) {
    for (const key of bankTransactionIdentityKeys(tx)) remoteKeys.add(key);
  }
  const seen = new Set<string>();
  const merged: BankTransaction[] = [];

  const addUnique = (tx: BankTransaction): boolean => {
    const keys = bankTransactionIdentityKeys(tx);
    if (keys.some(key => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    merged.push(tx);
    return true;
  };

  // 1) Lo local que la nube aún no conoce (o que está en la cola) se conserva.
  for (const tx of local.bankTransactions || []) {
    const keys = bankTransactionIdentityKeys(tx);
    const isPending = keys.some(key => pending.transactionKeys.has(bankIdentityValue(key)));
    if (isPending) { addUnique(tx); continue; }
    const knownRemotely = keys.some(key => remoteKeys.has(key));
    if (!knownRemotely && !isRemoteBankTransactionId(tx.id)) addUnique(tx);
  }

  // 2) Snapshot remoto. Un tipo no reconocido se omite y se informa; nunca se
  //    asume "salida" por defecto (eso invertiría el signo del movimiento).
  let unknownTypeCount = 0;
  for (const tx of remoteTransactions) {
    const type = normalizeBankTransactionType(tx.type);
    if (!type) { unknownTypeCount++; continue; }
    addUnique({ ...tx, type });
  }

  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // 3) Tarjetas: la nube manda salvo que la cuenta tenga cambios pendientes.
  const cardById = new Map<string, BankCard>();
  for (const card of remote.bankCards || []) cardById.set(card.id, card);
  for (const card of local.bankCards || []) {
    if (!cardById.has(card.id)) cardById.set(card.id, card);
    else if (pending.cardIds.has(card.id)) cardById.set(card.id, card);
  }

  return { bankCards: Array.from(cardById.values()), bankTransactions: merged, unknownTypeCount };
}

export function createBankActions(set: StoreSet, get: StoreGet): any {
  return {
  bankCards: INITIAL_BANK_CARDS,
  addBankCard: (card) => {
    set(state => {
      // Deduplicación por ID, Número de Cuenta o Nombre+Banco. `name` y
      // `bankName` son opcionales (la nube puede traerlos null): acceder al
      // nombre sin guardas lanzaba TypeError al añadir una cuenta.
      const nameOf = (value?: string) => (value ?? '').trim().toLowerCase();
      const bankOf = (value: import('../../types').BankCard) => nameOf(value.bankName ?? value.bank);
      const isDuplicate = state.bankCards.some(c => {
        if (c.id === card.id) return true;
        if (c.accountNumber && card.accountNumber && c.accountNumber === card.accountNumber) return true;
        const cName = nameOf(c.name);
        return cName !== '' && cName === nameOf(card.name) && bankOf(c) === bankOf(card);
      });
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
  addBankTransaction: async (incoming) => {
    // Un tipo no reconocido jamás se asume "salida": se rechaza y se avisa.
    const normalizedType = normalizeBankTransactionType(incoming.type);
    if (!normalizedType) {
      get().addNotification(
        'El movimiento bancario no se registró: su tipo no es reconocido.',
        'error'
      );
      return false;
    }
    const transaction: BankTransaction = { ...incoming, type: normalizedType };
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
          const permanentCodes = new Set(['P0001','23503','23505','23514','42501','22003','22P02','IDEMPOTENCY_CONFLICT']);
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

  /**
   * Carga el historial bancario desde Supabase y lo fusiona con el estado local.
   * El bootstrap del POS omite las transacciones bancarias (pull.ts llama a
   * loadBanks con includeTransactions:false), así que la página de Bancos debe
   * pedirlas explícitamente; si no, las tarjetas cargan pero los movimientos
   * nunca aparecen hasta que se produce una venta o una conciliación.
   */
  refreshBankData: async (options?: { force?: boolean }): Promise<BankRefreshResult> => {
    const localTransactionCount = (get().bankTransactions || []).length;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return {
        success: false,
        skipped: false,
        offline: true,
        transactionCount: localTransactionCount,
        unknownTypeCount: 0,
        message: 'Sin conexión: se muestran los movimientos guardados en este dispositivo.'
      };
    }
    if (bankPullInFlight) {
      const running = await bankPullInFlight;
      return { ...running, skipped: true };
    }
    if (!options?.force && Date.now() - lastBankPullAt < BANK_REFRESH_COOLDOWN_MS) {
      return { success: true, skipped: true, transactionCount: localTransactionCount, unknownTypeCount: 0 };
    }

    const run = (async (): Promise<BankRefreshResult> => {
      try {
        const remote = await pullBankDataFromSupabase();
        if (!remote.success) {
          // También se marca el intento fallido: evita ráfagas de consultas si
          // la nube está caída y la página se re-monta. «Reintentar» usa force.
          lastBankPullAt = Date.now();
          return {
            success: false,
            skipped: false,
            transactionCount: (get().bankTransactions || []).length,
            unknownTypeCount: 0,
            // Nunca se muestra el texto crudo del transporte/Supabase.
            message: 'No se pudo cargar el historial bancario desde la nube. Revisa la conexión e inténtalo de nuevo.'
          };
        }
        const merged = mergeBankState(
          { bankCards: get().bankCards || [], bankTransactions: get().bankTransactions || [] },
          { bankCards: remote.bankCards || [], bankTransactions: remote.bankTransactions || [] }
        );
        set({ bankCards: merged.bankCards, bankTransactions: merged.bankTransactions });
        lastBankPullAt = Date.now();
        return {
          success: true,
          skipped: false,
          transactionCount: merged.bankTransactions.length,
          unknownTypeCount: merged.unknownTypeCount
        };
      } catch (error) {
        console.warn('[Bank] No se pudo actualizar el historial bancario:', error);
        return {
          success: false,
          skipped: false,
          transactionCount: (get().bankTransactions || []).length,
          unknownTypeCount: 0,
          message: 'No se pudo cargar el historial bancario desde la nube.'
        };
      }
    })();

    bankPullInFlight = run;
    try {
      return await run;
    } finally {
      if (bankPullInFlight === run) bankPullInFlight = null;
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
