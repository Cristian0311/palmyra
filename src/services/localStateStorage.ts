import type { StateStorage } from 'zustand/middleware';
import { getPalmyraLocalScopeKey } from './localScope';

const DB_PREFIX = 'palmyra-local-state-v2';
const STORE = 'state';
const KEY = 'zustand';
const databases = new Map<string, Promise<IDBDatabase | null>>();
let writeChain: Promise<void> = Promise.resolve();
const writeErrors = new Map<string, Error>();

const legacyKey = (scope: string) => 'palmyra-local-state__' + scope;
const recoveryKey = (scope: string) => 'palmyra-local-state-recovery__' + scope;

type LocalStateListener = (raw: string) => void;
const listeners = new Set<LocalStateListener>();

/** Avisa cuando el estado legado quedó guardado; lo usa la escritura en sombra. */
export function subscribeLocalStateStorage(listener: LocalStateListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifySaved(raw: string): void {
  for (const listener of listeners) {
    try { listener(raw); } catch {}
  }
}

/** Lee el snapshot legado del usuario/empresa activos, sin montar un store. */
export async function readLocalStateStorage(): Promise<string | null> {
  const scope = getPalmyraLocalScopeKey();
  if (!scope) return null;
  return read(scope);
}

function openDb(scope: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  const existing = databases.get(scope);
  if (existing) return existing;
  const promise = new Promise<IDBDatabase | null>(resolve => {
    const req = indexedDB.open(DB_PREFIX + '-' + encodeURIComponent(scope), 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); databases.delete(scope); };
      resolve(db);
    };
    req.onerror = () => { databases.delete(scope); resolve(null); };
    req.onblocked = () => { databases.delete(scope); resolve(null); };
  });
  databases.set(scope, promise);
  return promise;
}

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

async function read(scope: string): Promise<string | null> {
  await writeChain;
  // A recovery record is newer than IndexedDB after a failed write, not an older backup.
  const recovery = stored(recoveryKey(scope));
  if (recovery !== null) return recovery;
  const db = await openDb(scope);
  if (!db) return stored(legacyKey(scope));
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : stored(legacyKey(scope)));
      req.onerror = () => resolve(stored(legacyKey(scope)));
      tx.onabort = () => resolve(stored(legacyKey(scope)));
    } catch { resolve(stored(legacyKey(scope))); }
  });
}

async function writeNow(scope: string, value: string): Promise<void> {
  const operation = writeChain.then(async () => {
    try {
      const db = await openDb(scope);
      if (!db) throw new Error('IndexedDB no disponible');
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Error escribiendo IndexedDB'));
        tx.onabort = () => reject(tx.error || new Error('Escritura abortada'));
      });
      try { localStorage.removeItem(recoveryKey(scope)); localStorage.removeItem(legacyKey(scope)); } catch {}
      writeErrors.delete(scope);
      notifySaved(value);
    } catch {
      try {
        localStorage.setItem(recoveryKey(scope), value);
        writeErrors.delete(scope);
        notifySaved(value);
      } catch {
        const error = new Error('No se pudo guardar en este dispositivo. Libera espacio y vuelve a intentar antes de cerrar la aplicación.');
        writeErrors.set(scope, error);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('palmyra:storage-warning', { detail: { message: error.message } }));
        throw error;
      }
    }
  });
  writeChain = operation.catch(() => {});
  await operation;
}

export async function flushLocalStateStorage(): Promise<void> {
  const scope = getPalmyraLocalScopeKey();
  await writeChain;
  const error = scope ? writeErrors.get(scope) : undefined;
  if (error) throw error;
}

export const localStateStorage: StateStorage = {
  getItem: async () => {
    const scope = getPalmyraLocalScopeKey();
    if (!scope) return null;
    return read(scope);
  },
  setItem: async (_name, value) => {
    const scope = getPalmyraLocalScopeKey();
    if (!scope) return;
    // Capture the account before awaiting: session changes must not redirect an in-flight write.
    await writeNow(scope, value);
  },
  removeItem: async () => {
    await clearLocalStateStorage();
  }
};

export async function clearLocalStateStorage(): Promise<void> {
  const scope = getPalmyraLocalScopeKey();
  if (!scope) return;
  await writeChain;
  const db = await openDb(scope);
  if (db) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  localStorage.removeItem(recoveryKey(scope));
  localStorage.removeItem(legacyKey(scope));
  writeErrors.delete(scope);
}
