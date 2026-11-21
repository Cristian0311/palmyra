/**
 * Registro local (con alcance usuario + empresa) del último intercambio real
 * con la nube. El estado de Zustand se rehidrata en cada arranque, pero la
 * frescura offline debe sobrevivir recargas para que la ventana de 20/30 días
 * tenga sentido. Nunca guarda datos operativos, solo marcas de tiempo.
 */
import { getPalmyraScopedStorageKey } from '../localScope';

const LEDGER_PREFIX = 'palmyra_offline_sync_ledger';

export const SYNC_LEDGER_EVENT = 'offline_sync_ledger_updated';

export type SyncLedger = {
  lastPullAt: string | null;
  lastPushAt: string | null;
};

const EMPTY_LEDGER: SyncLedger = { lastPullAt: null, lastPushAt: null };

function storageKey(): string | null {
  return getPalmyraScopedStorageKey(LEDGER_PREFIX);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function readSyncLedger(): SyncLedger {
  const key = storageKey();
  if (!key || typeof localStorage === 'undefined') return { ...EMPTY_LEDGER };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...EMPTY_LEDGER };
    const parsed = JSON.parse(raw);
    return {
      lastPullAt: normalizeTimestamp(parsed?.lastPullAt),
      lastPushAt: normalizeTimestamp(parsed?.lastPushAt)
    };
  } catch {
    return { ...EMPTY_LEDGER };
  }
}

export function recordSyncMoment(
  kind: 'pull' | 'push',
  at: string = new Date().toISOString()
): void {
  const key = storageKey();
  const timestamp = normalizeTimestamp(at);
  if (!key || !timestamp || typeof localStorage === 'undefined') return;
  const current = readSyncLedger();
  const next: SyncLedger = {
    ...current,
    [kind === 'pull' ? 'lastPullAt' : 'lastPushAt']: timestamp
  };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    return;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SYNC_LEDGER_EVENT, { detail: next }));
  }
}

/** La marca más reciente entre subida y bajada, o null si nunca hubo contacto. */
export function getLastSyncMoment(): string | null {
  const { lastPullAt, lastPushAt } = readSyncLedger();
  if (lastPullAt && lastPushAt) return lastPullAt > lastPushAt ? lastPullAt : lastPushAt;
  return lastPullAt || lastPushAt || null;
}
