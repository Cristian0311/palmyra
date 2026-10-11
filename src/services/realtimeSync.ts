import { getSupabase } from '../lib/supabase';
import { useStore } from '../store/useStore';
import { getOfflineQueueCount } from './offlineQueue';
import { isBrowserOffline, isTransientNetworkError } from './offlineNetwork';

let realtimeChannel: any = null;
let realtimeSubscriptionPromise: Promise<void> | null = null;
let realtimeSubscriptionGeneration: number | null = null;
let channelRemovalPromise: Promise<void> = Promise.resolve();
let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
let isSyncInProgress = false;
let bootstrappedTenantKey = '';
let lastOperationalRefreshAt = 0;
let lastGlobalRefreshAt = 0;
let subscriberGeneration = 0;
let initRefCount = 0;
let cleanupRuntime: (() => void) | null = null;

const OP_MS = 5000;
const GLOBAL_MS = 15000;

const GLOBAL_TABLES = new Set([
  'warehouses', 'categories', 'products', 'product_variants', 'product_barcodes',
  'product_kit_components', 'employees', 'employee_warehouse_access', 'currencies'
]);
// Only subscribe to tenant-owned tables with company_id. Child tables without
// that column are refreshed through their parent (sales, transfers, audits, etc.);
// listening without a tenant filter could leak another company's row metadata.
const OP_TABLES = new Set([
  'stock_balances', 'variant_stock_balances', 'stock_movements', 'sales',
  'payments', 'cash_registers', 'cash_sessions', 'cash_movements', 'transfers',
  'sales_returns', 'warranties', 'purchase_orders', 'quotes', 'inventory_audits',
  'bank_accounts', 'bank_transactions', 'employee_time_shifts', 'payroll_runs',
  'payroll_items'
]);

async function getTenantState() {
  const { getActiveTenant } = await import('./tenant');
  const tenant = await getActiveTenant();
  return {
    companyId: tenant.companyId,
    branchId: useStore.getState().currentBranchId,
    bootstrapPosFromSupabase: async () => {
      const { pullPosBootstrapFromSupabase } = await import('./supabaseSync');
      const result = await pullPosBootstrapFromSupabase(useStore.getState().currentBranchId);
      if (result.success) {
        useStore.setState(result.data);
        return true;
      }
      return false;
    },
    refreshBranchOperationalData: () => useStore.getState().refreshBranchOperationalData(),
    refreshGlobalCatalogData: () => useStore.getState().refreshGlobalCatalogData()
  };
}

function warnNetworkOnly(message: string, error: unknown) {
  if (!isBrowserOffline() && !isTransientNetworkError(error)) {
    console.warn(message, error);
  }
}

function isManualOfflineSyncEnabled(): boolean {
  return useStore.getState().storeConfig?.manualOfflineSync === true;
}

async function refresh(force = false): Promise<void> {
  if (isBrowserOffline() || isSyncInProgress) return;

  try {
    if (getOfflineQueueCount() > 0) {
      // Respect the explicit manual-sync preference even when a Realtime
      // event, focus or reconnect causes a background refresh. A user-triggered
      // force sync is the only path allowed to bypass this preference.
      if (!force && isManualOfflineSyncEnabled()) return;
      isSyncInProgress = true;
      let remaining = getOfflineQueueCount();
      try {
        const { processOfflineQueue } = await import('./offlineSync');
        const result = await processOfflineQueue();
        remaining = result.remaining;
      } catch (error) {
        warnNetworkOnly('[PALMYRA] offline replay failed', error);
      } finally {
        isSyncInProgress = false;
      }

      // A completed replay is followed by a canonical catalogue pull. This
      // keeps deletes and edits in sync even when Realtime missed an event.
      if (remaining === 0 && !isBrowserOffline()) {
        try {
          const state = await getTenantState();
          await state.refreshGlobalCatalogData();
        } catch (error) {
          warnNetworkOnly('[PALMYRA] No se pudo refrescar el catálogo tras vaciar la cola offline:', error);
        }
      }
      return;
    }

    const state = await getTenantState();
    const key = state.companyId + '|' + state.branchId;
    if (force || key !== bootstrappedTenantKey) {
      const ok = await state.bootstrapPosFromSupabase();
      if (ok) bootstrappedTenantKey = key;
    } else {
      await state.refreshBranchOperationalData();
    }
  } catch (error) {
    // Transient outages must never turn into an unhandled rejected promise.
    warnNetworkOnly('[PALMYRA] Background sync could not reach the active tenant.', error);
  }
}

function schedule(kind: 'operational' | 'global' | 'all' = 'operational', delay = 500): void {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => {
    refreshTimeout = null;
    if (isBrowserOffline()) return;
    void (async () => {
      const now = Date.now();
      if (kind === 'operational' && now - lastOperationalRefreshAt < OP_MS) return;
      if (kind === 'global' && now - lastGlobalRefreshAt < GLOBAL_MS) return;
      if (kind === 'operational') lastOperationalRefreshAt = now;
      else if (kind === 'global') lastGlobalRefreshAt = now;
      else {
        lastOperationalRefreshAt = now;
        lastGlobalRefreshAt = now;
      }

      try {
        const state = await getTenantState();
        if (getOfflineQueueCount() > 0) {
          await refresh(false);
          return;
        }
        if (kind === 'global') await state.refreshGlobalCatalogData();
        else if (kind === 'all') await state.bootstrapPosFromSupabase();
        else await state.refreshBranchOperationalData();
      } catch (error) {
        warnNetworkOnly('[PALMYRA] Realtime refresh deferred until connectivity returns.', error);
      }
    })();
  }, delay);
}

export function triggerBackgroundSync(force = false): Promise<void> {
  return refresh(force);
}

export function scheduleDebouncedSync(delayMs = 1200): void {
  schedule('all', delayMs);
}

async function ensureRealtimeSubscribed(supabase: NonNullable<ReturnType<typeof getSupabase>>): Promise<void> {
  if (isBrowserOffline()) return;
  if (realtimeChannel) return;

  if (realtimeSubscriptionPromise) {
    const pendingGeneration = realtimeSubscriptionGeneration;
    await realtimeSubscriptionPromise;
    // If an offline/cleanup transition invalidated the pending subscription,
    // retry once for the new generation. A failed connection in the same
    // generation is left to the poll/online event, avoiding retry recursion.
    if (!realtimeChannel && !isBrowserOffline() && pendingGeneration !== subscriberGeneration) {
      await ensureRealtimeSubscribed(supabase);
    }
    return;
  }

  const generation = subscriberGeneration;
  let attempt!: Promise<void>;
  attempt = (async () => {
    // Wait for an in-flight unsubscribe before reusing the same Realtime topic.
    await channelRemovalPromise;
    const state = await getTenantState();
    if (generation !== subscriberGeneration || isBrowserOffline() || !state.companyId) return;
    if (realtimeChannel) return;

    const topic = 'palmyra-tenant-' + state.companyId;
    const channel = supabase.channel(topic);

    // Every postgres_changes callback is registered before subscribe().
    // Adding handlers afterwards throws and can abort the socket lifecycle.
    for (const table of [...GLOBAL_TABLES, ...OP_TABLES]) {
      const config: any = { event: '*', schema: 'public', table };
      // currencies is a shared reference table and has no company_id column.
      if (state.companyId && table !== 'currencies') config.filter = 'company_id=eq.' + state.companyId;
      channel.on('postgres_changes', config, (payload: any) => {
        if (generation !== subscriberGeneration || realtimeChannel !== channel) return;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('remote_data_changed', { detail: payload }));
        }
        const tableName = payload?.table;
        if (OP_TABLES.has(tableName)) schedule('operational', 400);
        else if (GLOBAL_TABLES.has(tableName)) schedule('global', 700);
      });
    }

    // Check cancellation again after async tenant resolution and before subscribe.
    if (generation !== subscriberGeneration || isBrowserOffline()) {
      channelRemovalPromise = Promise.resolve(supabase.removeChannel(channel)).then(() => undefined).catch(() => undefined);
      await channelRemovalPromise;
      return;
    }

    realtimeChannel = channel;
    channel.subscribe((status: string) => {
      if (generation !== subscriberGeneration || realtimeChannel !== channel) return;
      if (status === 'SUBSCRIBED') {
        schedule('all', 300);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[PALMYRA] Realtime subscription status:', status);
      } else if (status === 'CLOSED') {
        if (realtimeChannel === channel) realtimeChannel = null;
      }
    });
  })().catch(error => {
    // Supabase aborts a pending channel when it is removed or the app goes
    // offline. That is expected; do not surface it as a user-facing failure.
    if (!isBrowserOffline() && !isTransientNetworkError(error)) {
      console.warn('[PALMYRA] Could not establish Realtime subscription; polling remains active.', error);
    }
  }).finally(() => {
    if (realtimeSubscriptionPromise === attempt) {
      realtimeSubscriptionPromise = null;
      realtimeSubscriptionGeneration = null;
    }
  });

  realtimeSubscriptionGeneration = generation;
  realtimeSubscriptionPromise = attempt;
  await attempt;
}

function stopRealtimeChannel(supabase: NonNullable<ReturnType<typeof getSupabase>>): void {
  subscriberGeneration += 1;
  bootstrappedTenantKey = '';
  const channel = realtimeChannel;
  realtimeChannel = null;
  if (channel) {
    channelRemovalPromise = Promise.resolve(supabase.removeChannel(channel))
      .then(() => undefined)
      .catch(error => {
        warnNetworkOnly('[PALMYRA] Realtime channel cleanup deferred.', error);
      });
  }
}

export function initMultiDeviceRealtimeSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  initRefCount += 1;

  if (initRefCount === 1) {
    const supabase = getSupabase();
    if (!supabase) {
      initRefCount = 0;
      return () => {};
    }

    const onOffline = () => stopRealtimeChannel(supabase);
    const onOnline = () => {
      void ensureRealtimeSubscribed(supabase);
      void refresh(false);
    };
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') schedule('operational', 300);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule('all', 300);
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    if (!isBrowserOffline()) {
      void ensureRealtimeSubscribed(supabase);
      void refresh(false);
    }

    // Retry the channel as well as canonical polling: "online" can fire while
    // DNS, TLS or the API is still unavailable.
    pollIntervalId = setInterval(() => {
      if (isBrowserOffline()) return;
      void ensureRealtimeSubscribed(supabase);
      void refresh(false);
    }, 120_000);

    cleanupRuntime = () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (pollIntervalId) clearInterval(pollIntervalId);
      pollIntervalId = null;
      if (refreshTimeout) clearTimeout(refreshTimeout);
      refreshTimeout = null;
      stopRealtimeChannel(supabase);
      realtimeSubscriptionPromise = null;
      realtimeSubscriptionGeneration = null;
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    initRefCount = Math.max(0, initRefCount - 1);
    if (initRefCount === 0 && cleanupRuntime) {
      const cleanup = cleanupRuntime;
      cleanupRuntime = null;
      cleanup();
    }
  };
}
