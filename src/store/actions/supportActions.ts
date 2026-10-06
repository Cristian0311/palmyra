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
import { INITIAL_FISCAL_CONFIGS } from '../storeInitialData';


type StoreSet = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
type StoreGet = () => AppState;

export function createSupportActions(set: StoreSet, get: StoreGet): any {
  return {
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
        get().addNotification(
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
    import('../../services/supabaseSync').then(({ pushSalarySettlementToSupabase }) => {
      pushSalarySettlementToSupabase(settlement).catch(() => {});
    }).catch(() => {});
  },
  updateSalarySettlement: (id, settlement) => {
    set((state) => ({
      salarySettlements: state.salarySettlements.map(s => s.id === id ? { ...s, ...settlement } : s)
    }));
    const updated = get().salarySettlements.find(s => s.id === id);
    if (updated) {
      import('../../services/supabaseSync').then(({ pushSalarySettlementToSupabase }) => {
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
    await enqueueOfflineItem('cash_movement', {
      id: movement.id,
      sessionId,
      type: movement.type,
      amount: Math.abs(Number(movement.amount) || 0),
      currencyCode: movement.currencyCode,
      description: movement.description || ''
    }, actionId);
    await flushLocalStateStorage();

    if (navigator.onLine) {
      const { pushCashMovementToSupabase } = await import('../../services/supabaseSync');
      const synced = await pushCashMovementToSupabase({
        id: movement.id,
        sessionId,
        type: movement.type,
        amount: Math.abs(Number(movement.amount) || 0),
        currencyCode: movement.currencyCode,
        description: movement.description || ''
      });
      if (synced) removeFromOfflineQueueByAction('cash_movement', actionId);
      return synced;
    }
    return true;
  },
  removeCashMovement: async (sessionId, movementId) => {
    // La baja del movimiento es independiente del snapshot de caja. Esto evita
    // que un turno offline vuelva a insertar un movimiento eliminado.
    set((state) => ({
      cashSessions: (state.cashSessions || []).map(s =>
        s.id === sessionId
          ? { ...s, movements: (s.movements || []).filter(m => m.id !== movementId) }
          : s
      )
    }));

    const updated = get().cashSessions.find(s => s.id === sessionId);
    if (!updated) return;

    const actionId = `cash-movement-remove:${sessionId}:${movementId}`;
    await enqueueOfflineItem('cash_movement_delete', {
      id: movementId,
      sessionId
    }, actionId);
    await flushLocalStateStorage();

    if (navigator.onLine) {
      const { deleteCashMovementFromSupabase } = await import('../../services/supabaseSync');
      const synced = await deleteCashMovementFromSupabase({ id: movementId, sessionId });
      if (synced) removeFromOfflineQueueByAction('cash_movement_delete', actionId);
      return synced;
    }
    return true;
  },
  };
}
