/**
 * Offline-first operation queue.
 *
 * IMPORTANT: this queue stores operations, not a copy of the whole application
 * state. IndexedDB is used because POS devices can remain offline for long
 * periods and localStorage is too fragile for a growing transactional queue.
 */
import { addSyncLog } from '../utils/syncLogger';
import { getPalmyraLocalScopeKey } from './localScope';
import { idbClear, idbDelete, idbGetAll, idbPut, idbReplaceAll, resetOfflineQueueDbCache } from './offlineQueueStorage';
import type { OfflineActionType, OfflineQueueItem } from './offlineQueueTypes';
export type { OfflineActionType, OfflineQueueItem } from './offlineQueueTypes';


let STORAGE_KEY = 'palmyra-offline-queue__anonymous';
let TOMBSTONES_KEY = 'palmyra-offline-queue-tombstones__anonymous';
let DB_NAME = 'palmyra-offline-v2-anonymous';
let DEVICE_KEY = 'palmyra_device_id__anonymous';
let activeScopeKey: string | null = null;

let memoryQueue: OfflineQueueItem[] = [];
let queueReady = false;
let persistenceChain: Promise<void> = Promise.resolve();
let persistenceError: Error | null = null;
let queueInitPromise: Promise<void>;
let removedDuringQueueProcess = new Set<string>();

function refreshScopeKeys() {
  const scopeKey = getPalmyraLocalScopeKey();
  activeScopeKey = scopeKey;
  if (!scopeKey) {
    STORAGE_KEY = 'palmyra-offline-queue__anonymous';
    TOMBSTONES_KEY = 'palmyra-offline-queue-tombstones__anonymous';
    DB_NAME = 'palmyra-offline-v2-anonymous';
    DEVICE_KEY = 'palmyra_device_id__anonymous';
    return;
  }
  STORAGE_KEY = 'palmyra-offline-queue__' + scopeKey;
  TOMBSTONES_KEY = 'palmyra-offline-queue-tombstones__' + scopeKey;
  DB_NAME = 'palmyra-offline-v2-' + encodeURIComponent(scopeKey);
  DEVICE_KEY = 'palmyra_device_id__' + scopeKey;
}

refreshScopeKeys();

class PermanentSyncError extends Error {
  permanent = true;
}

function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  if (!activeScopeKey) return 'anonymous-device';
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, id);
  return id;
}

function readQueueTombstones(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeQueueTombstones(ids: Iterable<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(Array.from(new Set(ids))));
  } catch (e) {
    console.warn('[offlineSync] No se pudo persistir el registro de borrados de la cola:', e);
  }
}

function addQueueTombstone(id: string): void {
  const tombstones = readQueueTombstones();
  tombstones.add(String(id));
  writeQueueTombstones(tombstones);
}

function removeQueueTombstone(id: string): void {
  const tombstones = readQueueTombstones();
  if (!tombstones.delete(String(id))) return;
  writeQueueTombstones(tombstones);
}

function clearQueueTombstones(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(TOMBSTONES_KEY); } catch {}
}

async function migrateLegacyQueue(): Promise<void> {
  if (typeof window === 'undefined') { queueReady = true; return; }
  if (!activeScopeKey) {
    memoryQueue = [];
    queueReady = true;
    emitQueueEvent();
    return;
  }
  const legacyRaw = localStorage.getItem(STORAGE_KEY);
  const legacy = legacyRaw ? (() => { try { return JSON.parse(legacyRaw); } catch { return []; } })() : [];
  const tombstones = readQueueTombstones();
  let existing: OfflineQueueItem[] | null = null;
  try {
    existing = await idbGetAll(DB_NAME, Boolean(activeScopeKey));
  } catch (e) {
    // Never replace IndexedDB with an empty queue when a read itself failed.
    // The old behavior could erase durable pending sales during startup.
    console.error('[offlineSync] No se pudo leer la cola IndexedDB; se conserva sin sobrescribir:', e);
    memoryQueue = (Array.isArray(legacy) ? legacy : [])
      .filter(item => !tombstones.has(String(item.id)));
    queueReady = true;
    emitQueueEvent();
    return;
  }
  // Merge every source instead of choosing one. This prevents an enqueue that
  // happens during startup from being overwritten by the migration itself.
  const merged = new Map<string, OfflineQueueItem>();
  const mergeCandidate = (item: OfflineQueueItem) => {
    const normalized = { ...item, deviceId: item.deviceId || getDeviceId() };
    const mergeKey = `${normalized.type}:${normalized.actionId}`;
    const previous = merged.get(mergeKey);
    if (!previous) { merged.set(mergeKey, normalized); return; }
    const previousTime = Date.parse(String(previous.timestamp || '')) || 0;
    const candidateTime = Date.parse(String(normalized.timestamp || '')) || 0;
    // Prefer the freshest version; when timestamps tie, retain the more advanced
    // state and higher retry count rather than resetting a durable operation.
    const rank = (x: OfflineQueueItem) => x.status === 'conflict' ? 4 : x.status === 'processing' ? 3 : x.status === 'failed' ? 2 : 1;
    if (candidateTime > previousTime ||
        (candidateTime === previousTime && (rank(normalized) > rank(previous) ||
          (rank(normalized) === rank(previous) && Number(normalized.retryCount || 0) > Number(previous.retryCount || 0))))) {
      merged.set(mergeKey, normalized);
    }
  };
  for (const item of (Array.isArray(existing) ? existing : [])) mergeCandidate(item);
  for (const item of (Array.isArray(legacy) ? legacy : [])) mergeCandidate(item);
  for (const item of memoryQueue) mergeCandidate(item);
  memoryQueue = Array.from(merged.values())
    .filter(item => !tombstones.has(String(item.id)))
    .sort((a,b) => a.timestamp.localeCompare(b.timestamp));
  try {
    await idbReplaceAll(DB_NAME, Boolean(activeScopeKey), memoryQueue);
    if (legacyRaw) localStorage.removeItem(STORAGE_KEY);
    clearQueueTombstones();
  } catch (e) {
    persistenceError = e instanceof Error ? e : new Error(String(e));
    // Si IndexedDB está dañado/bloqueado, conservamos una copia durable en
    // localStorage y NO eliminamos la cola heredada.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryQueue)); } catch { /* se conserva en memoria */ }
    console.error('[offlineSync] IndexedDB no disponible durante migración; usando respaldo local:', e);
  }
  queueReady = true;
  emitQueueEvent();

  // El replay automático se inicia desde App después de que el store termine
  // de hidratarse. No procesamos la cola aquí para evitar que IndexedDB y
  // Zustand compitan durante el arranque y posteriormente se pisen el estado.
}

export async function setOfflineQueueScope(): Promise<void> {
  const nextScope = getPalmyraLocalScopeKey();
  if (nextScope === activeScopeKey && queueReady) return;

  try { await persistenceChain; } catch {}

  refreshScopeKeys();
  memoryQueue = [];
  removedDuringQueueProcess = new Set<string>();
  queueReady = false;
  persistenceError = null;
  resetOfflineQueueDbCache();

  queueInitPromise = migrateLegacyQueue().catch(async (error) => {
    persistenceError = error instanceof Error ? error : new Error(String(error));
    console.error('[offlineSync] Error inicializando cola offline; se conserva el estado disponible:', error);
    if (!queueReady) {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) memoryQueue = parsed;
      } catch {}
      queueReady = true;
      emitQueueEvent();
    }
  });
  await queueInitPromise;
}

// Hydrate once at module load. Synchronous readers use the memory snapshot.
// Writers wait for this migration so a first offline operation cannot be lost
// when the legacy localStorage queue is being imported.
queueInitPromise = migrateLegacyQueue();

function emitQueueEvent() {
  if (typeof window !== 'undefined') {
    const pending = memoryQueue.filter(item => item.status !== 'conflict').length;
    const conflicts = memoryQueue.filter(item => item.status === 'conflict').length;
    window.dispatchEvent(new CustomEvent('offline_queue_updated', {
      detail: { count: pending, pendingCount: pending, conflictCount: conflicts }
    }));
  }
}

export function getOfflineQueue(): OfflineQueueItem[] {
  return [...memoryQueue];
}

/**
 * Espera a que la cola persistida haya terminado de migrarse antes de leerla.
 * Esto evita una condición de carrera al reconectar justo después de abrir la app:
 * antes de la migración memoryQueue puede estar vacía aunque IndexedDB tenga ventas.
 */
export async function waitForOfflineQueueReady(): Promise<void> {
  if (queueInitPromise) await queueInitPromise;
}

function persistQueueItem(item: OfflineQueueItem): Promise<void> {
  const operation = persistenceChain.then(async () => {
    if (!queueReady && queueInitPromise) await queueInitPromise;
    removeQueueTombstone(item.id);
    if (typeof indexedDB !== 'undefined') {
      try {
        await idbPut(DB_NAME, Boolean(activeScopeKey), item);
        persistenceError = null;
        return;
      } catch (idbError) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryQueue));
          persistenceError = null;
          return;
        } catch (localError) {
          throw new Error(
            `No se pudo persistir la operación offline en IndexedDB ni en localStorage: ${String(localError)}`
          );
        }
      }
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryQueue));
      persistenceError = null;
    } catch (e) {
      throw new Error(`No se pudo persistir la operación offline en localStorage: ${String(e)}`);
    }
  });

  // La cadena interna se recupera para permitir que una nueva operación pueda
  // intentarse después de un fallo, pero la promesa de ESTA operación sí rechaza.
  persistenceChain = operation.catch(e => {
    persistenceError = e instanceof Error ? e : new Error(String(e));
    console.error('[offlineSync] Error persistiendo cola durable:', e);
  });
  return operation;
}

function persistQueueDelete(id: string): Promise<void> {
  addQueueTombstone(id);
  persistenceChain = persistenceChain.then(async () => {
    if (!queueReady && queueInitPromise) await queueInitPromise;
    if (typeof indexedDB !== 'undefined') {
      try {
        await idbDelete(DB_NAME, Boolean(activeScopeKey), id);
        return;
      } catch (idbError) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryQueue)); } catch {}
        throw idbError;
      }
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryQueue)); } catch (e) {
      console.error('[offlineSync] Error al guardar cola offline:', e);
    }
  }).catch(async e => {
    persistenceError = e instanceof Error ? e : new Error(String(e));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryQueue)); } catch { /* se reporta y se conserva en memoria */ }
    console.error('[offlineSync] Error persistiendo eliminación de cola offline:', e);
  });
  return persistenceChain;
}

async function waitForQueuePersistence(): Promise<void> {
  await persistenceChain;
  if (persistenceError) { const error = persistenceError; persistenceError = null; throw error; }
}

function persistQueueClear(): void {
  const ids = memoryQueue.map(item => String(item.id));
  writeQueueTombstones(new Set([...readQueueTombstones(), ...ids]));
  persistenceChain = persistenceChain.then(async () => {
    if (!queueReady && queueInitPromise) await queueInitPromise;
    if (typeof indexedDB !== 'undefined') {
      try {
        await idbClear(DB_NAME, Boolean(activeScopeKey));
        clearQueueTombstones();
        return;
      } catch (idbError) {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        console.warn('[offlineSync] No se pudo limpiar IndexedDB; los tombstones evitarán la reaparición:', idbError);
        return;
      }
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      clearQueueTombstones();
    } catch (e) {
      console.error('[offlineSync] Error al limpiar cola offline:', e);
    }
  }).catch(e => console.error('[offlineSync] Error persistiendo cola:', e));
}

export function enqueueOfflineItem(type: OfflineActionType, data: any, actionId?: string): Promise<void> {
  const finalActionId = actionId || data?.id || crypto.randomUUID();
  const currentQueue = getOfflineQueue();
  const existingIdx = currentQueue.findIndex(item => item.type === type && item.actionId === finalActionId);
  const base = {
    id: existingIdx >= 0 ? currentQueue[existingIdx].id : crypto.randomUUID(),
    actionId: finalActionId,
    type,
    data,
    timestamp: new Date().toISOString(),
    retryCount: existingIdx >= 0 ? currentQueue[existingIdx].retryCount : 0,
    status: 'pending' as const,
    deviceId: getDeviceId()
  };
  if (existingIdx >= 0) {
    removedDuringQueueProcess.delete(currentQueue[existingIdx].id);
    currentQueue[existingIdx] = { ...currentQueue[existingIdx], ...base, data: { ...currentQueue[existingIdx].data, ...data } };
  } else {
    currentQueue.push(base);
  }
  memoryQueue = currentQueue;
  emitQueueEvent();
  const persistence = persistQueueItem(currentQueue[existingIdx >= 0 ? existingIdx : currentQueue.length - 1]);
  addSyncLog({ level: 'info', source: 'offline_queue', title: `Elemento encolado (${type})`, details: `Operación ${finalActionId} añadida a la cola durable. Pendientes: ${currentQueue.length}`, entityType: type, actionId: finalActionId });
  return persistence;
}

export async function setOfflineQueueItemLastError(type: OfflineActionType, actionId: string, message: string): Promise<void> {
  await waitForOfflineQueueReady();
  const index = memoryQueue.findIndex(item => item.type === type && item.actionId === actionId);
  if (index < 0) return;
  const updated = {
    ...memoryQueue[index],
    lastError: String(message || 'Error no especificado').slice(0, 2000),
    // Keep the operation retryable. This is diagnostic metadata, not a terminal rejection.
    status: memoryQueue[index].status === 'conflict' ? 'conflict' as const : 'pending' as const,
  };
  memoryQueue[index] = updated;
  emitQueueEvent();
  await persistQueueItem(updated);
}

export async function removeFromOfflineQueue(id: string): Promise<void> {
  removedDuringQueueProcess.add(id);
  memoryQueue = memoryQueue.filter(item => item.id !== id);
  addQueueTombstone(id);
  emitQueueEvent();
  await persistQueueDelete(id);
}

export function clearOfflineQueue(): void {
  for (const item of memoryQueue) removedDuringQueueProcess.add(item.id);
  memoryQueue = [];
  emitQueueEvent();
  persistQueueClear();
}
export function getOfflineQueueCount(): number {
  // Los conflictos definitivos ya no son operaciones pendientes y no deben
  // despertar el sincronizador cada 30s indefinidamente.
  return memoryQueue.filter(item => item.status !== 'conflict').length;
}
export function getOfflineConflictCount(): number {
  return memoryQueue.filter(item => item.status === 'conflict').length;
}

export function setOfflineQueueMemory(queue: OfflineQueueItem[]): void {
  memoryQueue = [...queue];
  emitQueueEvent();
}

export function isOfflineQueueItemRemoved(id: string): boolean {
  return removedDuringQueueProcess.has(id);
}

export function clearOfflineQueueRemovalMark(id: string): void {
  removedDuringQueueProcess.delete(id);
}

export async function persistOfflineQueueSnapshot(queue: OfflineQueueItem[]): Promise<void> {
  const snapshot = [...queue];
  memoryQueue = [...snapshot];
  emitQueueEvent();
  persistenceChain = persistenceChain.then(async () => {
    if (!queueReady && queueInitPromise) await queueInitPromise;
    if (typeof indexedDB !== 'undefined') {
      await idbReplaceAll(DB_NAME, Boolean(activeScopeKey), snapshot);
      return;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    }
  }).catch(async e => {
    persistenceError = e instanceof Error ? e : new Error(String(e));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      return;
    } catch (localError) {
      console.error('[offlineSync] Error persistiendo snapshot de cola en ambos storages:', e, localError);
      throw e;
    }
  });
  await waitForQueuePersistence();
}

