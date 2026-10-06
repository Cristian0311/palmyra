import type { OfflineQueueItem } from './offlineQueueTypes';

const DB_VERSION = 1;
const STORE_NAME = 'operations';

let dbPromise: Promise<IDBDatabase | null> | null = null;
let activeDbName = '';

export function resetOfflineQueueDbCache(): void {
  dbPromise = null;
  activeDbName = '';
}

export function openOfflineQueueDb(
  dbName: string,
  enabled: boolean
): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined' || !enabled) return Promise.resolve(null);
  if (dbPromise && activeDbName === dbName) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    activeDbName = dbName;
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('action', ['type', 'actionId'], { unique: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('IndexedDB open failed'));
    };
  });
  return dbPromise;
}

export async function idbGetAll(dbName: string, enabled: boolean): Promise<OfflineQueueItem[] | null> {
  const db = await openOfflineQueueDb(dbName, enabled);
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result || []) as OfflineQueueItem[]);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction read failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction read aborted'));
  });
}

export async function idbReplaceAll(dbName: string, enabled: boolean, queue: OfflineQueueItem[]): Promise<void> {
  const db = await openOfflineQueueDb(dbName, enabled);
  if (!db) throw new Error('IndexedDB no disponible');
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    queue.forEach(item => store.put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}

export async function idbPut(dbName: string, enabled: boolean, item: OfflineQueueItem): Promise<void> {
  const db = await openOfflineQueueDb(dbName, enabled);
  if (!db) throw new Error('IndexedDB no disponible');
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB put failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB put aborted'));
  });
}

export async function idbDelete(dbName: string, enabled: boolean, id: string): Promise<void> {
  const db = await openOfflineQueueDb(dbName, enabled);
  if (!db) throw new Error('IndexedDB no disponible');
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
  });
}

export async function idbClear(dbName: string, enabled: boolean): Promise<void> {
  const db = await openOfflineQueueDb(dbName, enabled);
  if (!db) throw new Error('IndexedDB no disponible');
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB clear aborted'));
  });
}
