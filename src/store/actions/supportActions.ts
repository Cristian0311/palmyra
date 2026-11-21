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
import { INITIAL_FISCAL_CONFIGS } from '../storeInitialData';


type StoreSet = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
type StoreGet = () => AppState;

/** Evita repetir el mismo aviso fiscal en cada venta de la sesión. */
const offlineNcfWarned = new Set<string>();

type ReservedNcfBlock = { start: number; end: number; prefix: string; rangeId: string };
type ReserveNcfOutcome =
  | { ok: true; block: ReservedNcfBlock; error?: undefined }
  | { ok: false; block?: undefined; error?: string };

/** Reserva un bloque fiscal en el servidor y valida la respuesta. */
async function reserveNcfBlock(params: {
  fiscalType: string;
  userId: string;
  blockSize?: number;
}): Promise<ReserveNcfOutcome> {
  const reservation = await callReserveNCFRangeRPC({
    fiscalType: params.fiscalType,
    deviceId: getNcfDeviceId(),
    blockSize: params.blockSize || 100,
    userId: params.userId
  });
  if (!reservation.success || !reservation.data) {
    return { ok: false, error: reservation.error };
  }
  const data = reservation.data;
  const start = Number(data.start_number);
  const end = Number(data.end_number);
  const prefix = String(data.prefix || '');
  if (!prefix || !Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return { ok: false, error: 'El servidor devolvió un rango fiscal inválido.' };
  }
  return {
    ok: true,
    block: {
      start,
      end,
      prefix,
      rangeId: String(data.range_id || crypto.randomUUID())
    }
  };
}

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
    const ncf = await withNcfLock(async () => {
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
        // Aviso preventivo: sin conexión, un bloque agotado bloquea el NCF de
        // las próximas ventas. Se avisa al cruzar el umbral y al agotarse.
        const remaining = local.end - number;
        if (remaining === 10) {
          get().addNotification(
            'Quedan 10 folios fiscales en este equipo',
            'warning',
            'Conecta el equipo para reservar el siguiente bloque y seguir vendiendo sin internet.'
          );
        } else if (remaining === 0) {
          get().addNotification(
            'Se agotó el bloque fiscal de este equipo',
            'warning',
            'La próxima venta sin conexión no podrá generar NCF. Conecta para renovar el bloque.'
          );
        }
        return `${local.prefix}${number.toString().padStart(8, '0')}`;
      }

      // Sin un rango reservado no inventamos folios localmente. Una tablet que
      // entra offline con su rango agotado simplemente esperará a tener red;
      // esto evita duplicados fiscales entre terminales.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (!offlineNcfWarned.has(type)) {
          offlineNcfWarned.add(type);
          get().addNotification(
            'Sin rango fiscal reservado en este equipo',
            'warning',
            'La venta puede continuar. Conecta el equipo para reservar folios NCF y que las próximas ventas offline los incluyan.'
          );
        }
        return undefined;
      }

      const userId = get().currentUser?.id;
      if (!userId) return undefined;

      const outcome = await reserveNcfBlock({ fiscalType: type, userId });
      if (!outcome.ok) {
        get().addNotification(
          'No se pudo reservar un rango fiscal para la venta.',
          'warning',
          outcome.error || 'Intente de nuevo con conexión disponible.'
        );
        return undefined;
      }

      const { start, end, prefix, rangeId } = outcome.block;
      saveNcfRanges({
        ...loadNcfRanges(),
        [type]: {
          rangeId,
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

    // Fuera del lock: si el bloque quedó agotado, intentamos renovarlo en
    // segundo plano. La venta actual no espera por esta reserva.
    if (ncf) {
      setTimeout(() => {
        void get().refreshNcfRangeIfExhausted().catch(() => {});
      }, 0);
    }
    return ncf;
  },

  /**
   * Renueva en segundo plano los bloques fiscales agotados mientras hay red.
   * Así, cuando el equipo vuelva a quedarse sin internet, ya tiene folios
   * reservados y puede seguir vendiendo sin inventar numeración.
   */
  refreshNcfRangeIfExhausted: async () => withNcfLock(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    const userId = get().currentUser?.id;
    if (!userId) return false;
    let refreshed = false;
    for (const config of get().fiscalConfigs.filter(c => c.active && c.type)) {
      const local = loadNcfRanges()[config.type];
      const usable = Boolean(
        local &&
        local.fiscalType === config.type &&
        local.prefix === config.prefix &&
        Number.isFinite(local.next) &&
        Number.isFinite(local.end) &&
        local.next <= local.end &&
        local.next <= Number(config.limit)
      );
      if (usable) continue;
      // No reservamos el primer bloque de forma anticipada: eso consumiría
      // secuencia fiscal en equipos que todavía no emiten NCF. Solo renovamos
      // bloques que este dispositivo ya tenía reservados y agotó.
      if (!local) continue;

      const outcome = await reserveNcfBlock({ fiscalType: config.type, userId });
      if (!outcome.ok) continue;
      const { start, end, prefix, rangeId } = outcome.block;
      saveNcfRanges({
        ...loadNcfRanges(),
        [config.type]: { rangeId, fiscalType: config.type, prefix, next: start, end }
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
      refreshed = true;
    }
    return refreshed;
  }),

  demandForecasts: [],
  updateForecasts: (f) => set({ demandForecasts: f }),

  receiptConfig: {
    showLogo: true,
    showAddress: true,
    showPhone: true,
    showFooter: true,
    footerText: "¡GRACIAS POR SU PREFERENCIA!",
    businessName: "PALMYRA",
    businessAddress: "",
    businessPhone: "",
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

    if (navigator.onLine && isCloudBusinessSyncAllowed()) {
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

    if (navigator.onLine && isCloudBusinessSyncAllowed()) {
      const { deleteCashMovementFromSupabase } = await import('../../services/supabaseSync');
      const synced = await deleteCashMovementFromSupabase({ id: movementId, sessionId });
      if (synced) removeFromOfflineQueueByAction('cash_movement_delete', actionId);
      return synced;
    }
    return true;
  },
  };
}
