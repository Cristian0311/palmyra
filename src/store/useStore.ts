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
import type { AppState } from './storeTypes';

import {
  INITIAL_USERS, INITIAL_BRANCHES, INITIAL_CATEGORIES, INITIAL_PRODUCTS,
  INITIAL_INVENTORY, INITIAL_BANK_CARDS, INITIAL_FISCAL_CONFIGS,
  BASE_CURRENCY_CODE, INITIAL_CURRENCIES
} from './storeInitialData';

// --- Definición del Store ---
const NCF_RANGE_STORAGE_KEY = 'palmyra-pos-ncf-ranges-v2';
type LocalNcfRange = {
  rangeId: string;
  fiscalType: string;
  prefix: string;
  next: number;
  end: number;
};

let ncfRangesMemory: Record<string, LocalNcfRange> = {};

function getNcfDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    const key = getPalmyraScopedStorageKey('palmyra-pos-device-id');
    if (!key) return 'anonymous-device';
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    if (!(ncfRangesMemory as any).__deviceId) (ncfRangesMemory as any).__deviceId = crypto.randomUUID();
    return (ncfRangesMemory as any).__deviceId;
  }
}

function loadNcfRanges(): Record<string, LocalNcfRange> {
  const key = getPalmyraScopedStorageKey(NCF_RANGE_STORAGE_KEY);
  if (!key) {
    ncfRangesMemory = {};
    return ncfRangesMemory;
  }
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') ncfRangesMemory = parsed;
      else ncfRangesMemory = {};
    } else {
      ncfRangesMemory = {};
    }
  } catch {
    ncfRangesMemory = {};
  }
  return ncfRangesMemory;
}

function saveNcfRanges(ranges: Record<string, LocalNcfRange>): void {
  ncfRangesMemory = ranges;
  const key = getPalmyraScopedStorageKey(NCF_RANGE_STORAGE_KEY);
  try {
    if (key && typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(ranges));
  } catch {}
}

function invalidateNcfRange(fiscalType: string): void {
  const ranges = { ...loadNcfRanges() };
  delete ranges[fiscalType];
  saveNcfRanges(ranges);
}

async function withNcfLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : null;
  if (locks?.request) return locks.request('palmyra-ncf-allocation', { mode: 'exclusive' }, fn);
  return fn();
}

function calculateExpectedCashBase(
  session: CashRegisterSession,
  transactions: Transaction[],
  currencies: Currency[]
): number {
  const currencyRate = (code: string, fallback = 1) => {
    const row = currencies.find((item) => item.code === code);
    const rate = Number(row?.rateToBase);
    return Number.isFinite(rate) && rate > 0 ? rate : fallback;
  };

  let expected = Number(session.openingBalance) || 0;
  const sessionTxs = (transactions || []).filter((tx) =>
    tx.sessionId
      ? tx.sessionId === session.id
      : (
          tx.branchId === session.branchId &&
          new Date(tx.date).getTime() >= new Date(session.openedAt).getTime() &&
          (!session.closedAt || new Date(tx.date).getTime() <= new Date(session.closedAt).getTime())
        )
  );

  for (const tx of sessionTxs) {
    for (const payment of tx.payments || []) {
      if (payment.method !== 'cash') continue;
      const amount = Number(payment.amount) || 0;
      const explicitRate = Number(payment.exchangeRate);
      const rate = Number.isFinite(explicitRate) && explicitRate > 0
        ? explicitRate
        : currencyRate(payment.currencyCode);
      expected += amount * rate;
    }

    if (tx.changePayments?.length) {
      for (const change of tx.changePayments) {
        if (change.method !== 'cash') continue;
        const amount = Number(change.amount) || 0;
        const explicitRate = Number(change.exchangeRate);
        const rate = Number.isFinite(explicitRate) && explicitRate > 0
          ? explicitRate
          : currencyRate(change.currencyCode);
        expected -= amount * rate;
      }
    } else if (Number(tx.changeGiven) > 0) {
      expected -= Number(tx.changeGiven) || 0;
    }
  }

  for (const movement of session.movements || []) {
    const amount = Number(movement.amount) || 0;
    const rate = currencyRate(movement.currencyCode);
    expected += (movement.type === 'income' ? amount : -amount) * rate;
  }

  return Math.round(expected * 1000000) / 1000000;
}

function removeFromOfflineQueueByAction(type: string, actionId: string) {
  const queued = getOfflineQueue().find(item => item.type === type && item.actionId === actionId);
  if (queued) removeFromOfflineQueue(queued.id);
}

function removeFromOfflineQueueByTransactionId(transactionId: string) {
  const queued = getOfflineQueue().find(item => item.type === 'transaction' && item.actionId === transactionId);
  if (queued) removeFromOfflineQueue(queued.id);
}

function validateLocalTransferStock(
  requirements: { productId: string; branchId: string; variantLabel?: string; quantity: number }[]
): { ok: boolean; message?: string } {
  const inventory = useStore.getState().inventory || [];
  const needed = new Map<string, { productId: string; branchId: string; variantLabel: string; quantity: number }>();

  for (const req of requirements) {
    const quantity = Number(req.quantity);
    if (!req.productId || !req.branchId || !Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, message: 'La cantidad de traslado debe ser un número entero mayor que 0.' };
    }
    const variantLabel = req.variantLabel || '';
    const key = req.productId + ':' + req.branchId + ':' + variantLabel;
    const previous = needed.get(key);
    if (previous) previous.quantity += quantity;
    else needed.set(key, { productId: req.productId, branchId: req.branchId, variantLabel, quantity });
  }