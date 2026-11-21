/**
 * Contrato de sincronización offline.
 *
 * La cola durable ya garantiza idempotencia y dependencias. Este módulo añade
 * lo que faltaba para operar durante días sin red: versión de esquema por
 * operación, una secuencia monotónica por dispositivo (independiente del reloj
 * local) y una lectura única de la salud de la cola.
 */
import type { OfflineQueueItem } from '../offlineQueueTypes';

export const SYNC_PROTOCOL_VERSION = 2;
export const OFFLINE_ITEM_SCHEMA_VERSION = 1;

/** Días sin sincronizar antes de avisar y antes de considerar los datos fríos. */
export const OFFLINE_WARNING_DAYS = 20;
export const OFFLINE_WINDOW_DAYS = 30;

export type OfflineQueueHealth = {
  total: number;
  pending: number;
  failed: number;
  conflicts: number;
  oldestQueuedAt: string | null;
  lastError: string | null;
};

export type OfflineFreshness = {
  lastSyncAt: string | null;
  daysSinceSync: number | null;
  state: 'fresh' | 'warning' | 'stale' | 'unknown';
};

function timestampOf(item: Pick<OfflineQueueItem, 'timestamp'>): number {
  const parsed = Date.parse(String(item.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Orden estable: primero la secuencia del dispositivo y, solo para elementos
 * heredados sin secuencia, la marca de tiempo. Nunca se ordena por reloj entre
 * dos dispositivos distintos.
 */
export function compareOfflineQueueItems(a: OfflineQueueItem, b: OfflineQueueItem): number {
  const seqA = Number(a.deviceSequence);
  const seqB = Number(b.deviceSequence);
  if (Number.isFinite(seqA) && Number.isFinite(seqB) && seqA !== seqB) return seqA - seqB;
  const byTime = timestampOf(a) - timestampOf(b);
  if (byTime !== 0) return byTime;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

export function normalizeOfflineQueueItem(
  item: OfflineQueueItem,
  options?: { deviceId?: string; deviceSequence?: number }
): OfflineQueueItem {
  const normalized: OfflineQueueItem = {
    ...item,
    schemaVersion: Number(item.schemaVersion) || OFFLINE_ITEM_SCHEMA_VERSION,
    queuedAt: item.queuedAt || item.timestamp || new Date(0).toISOString(),
  };
  const deviceId = item.deviceId || options?.deviceId;
  if (deviceId) normalized.deviceId = deviceId;
  const sequence = Number.isFinite(Number(options?.deviceSequence))
    ? Number(options?.deviceSequence)
    : Number(item.deviceSequence);
  if (Number.isFinite(sequence) && sequence > 0) normalized.deviceSequence = sequence;
  return normalized;
}

/**
 * Asigna secuencias solo a elementos heredados, en su orden actual. El
 * resultado es determinista y no reescribe operaciones que ya tienen una.
 */
export function assignMissingDeviceSequences(
  items: OfflineQueueItem[],
  startSequence = 0
): { items: OfflineQueueItem[]; lastSequence: number } {
  let sequence = Math.max(0, Math.floor(Number(startSequence) || 0));
  const ordered = [...items].sort(compareOfflineQueueItems);
  const replacements = new Map<string, OfflineQueueItem>();
  const used = new Set<number>();

  for (const item of ordered) {
    const existing = Number(item.deviceSequence);
    if (Number.isFinite(existing) && existing > 0) used.add(existing);
  }

  for (const item of ordered) {
    const existing = Number(item.deviceSequence);
    if (Number.isFinite(existing) && existing > 0) continue;
    do { sequence += 1; } while (used.has(sequence));
    used.add(sequence);
    replacements.set(item.id, normalizeOfflineQueueItem(item, { deviceSequence: sequence }));
  }

  let lastSequence = sequence;
  for (const value of used) {
    if (value > lastSequence) lastSequence = value;
  }
  return {
    items: items.map(item => replacements.get(item.id) || item),
    lastSequence
  };
}

export function summarizeOfflineQueue(items: OfflineQueueItem[]): OfflineQueueHealth {
  const conflicts = items.filter(item => item.status === 'conflict');
  // Un conflicto no se reintenta solo; por eso no cuenta como pendiente.
  const pendingItems = items.filter(item => item.status !== 'conflict');
  const failed = pendingItems.filter(item => item.status === 'failed');

  let oldest = Number.POSITIVE_INFINITY;
  for (const item of pendingItems) {
    const time = timestampOf(item);
    if (time > 0 && time < oldest) oldest = time;
  }

  const diagnostic = conflicts[0] || failed[0] || null;

  return {
    total: items.length,
    pending: pendingItems.length,
    failed: failed.length,
    conflicts: conflicts.length,
    oldestQueuedAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    lastError: diagnostic?.lastError ? String(diagnostic.lastError) : null
  };
}

export function evaluateOfflineFreshness(
  lastSyncAt: string | null | undefined,
  now: number = Date.now()
): OfflineFreshness {
  const parsed = Date.parse(String(lastSyncAt || ''));
  if (!Number.isFinite(parsed)) {
    return { lastSyncAt: null, daysSinceSync: null, state: 'unknown' };
  }
  const days = Math.max(0, (now - parsed) / 86_400_000);
  const state: OfflineFreshness['state'] =
    days >= OFFLINE_WINDOW_DAYS ? 'stale' : days >= OFFLINE_WARNING_DAYS ? 'warning' : 'fresh';
  return {
    lastSyncAt: new Date(parsed).toISOString(),
    daysSinceSync: Math.floor(days),
    state
  };
}
