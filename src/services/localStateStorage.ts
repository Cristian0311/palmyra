/**
 * Persistencia local del estado de la aplicación.
 * IndexedDB evita que un POS offline dependa de localStorage para un objeto enorme.
 * Las escrituras se agrupan brevemente para evitar serializar el store en cada set().
 */
import type { StateStorage } from 'zustand/middleware';
import { getPalmyraLocalScopeKey, getPalmyraScopedStorageKey } from './localScope';

const DB_PREFIX = 'palmyra-local-state-v2';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'zustand';
let activeDbName = '';

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingValue: string | null = null;
let writeChain: Promise<void> = Promise.resolve();
let lastWriteError: Error | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function getStorageScopeKey(): string | null {
  return getPalmyraLocalScopeKey();
}

function getDbName(): string | null {
  const scope = getStorageScopeKey();
  return scope ? DB_PREFIX + '-' + encodeURIComponent(scope) : null;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  const dbName = getDbName();
  if (!dbName) return Promise.resolve(null);
  if (dbPromise && activeDbName === dbName) return dbPromise;
  dbPromise = new Promise(resolve => {
    activeDbName = dbName;
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; resolve(null); };
  });
  return dbPromise;
}

async function read(): Promise<string | null> {
  const fallback = () => {
    const key = getPalmyraScopedStorageKey('palmyra-local-state');
    if (!key) return null;
    try { return localStorage.getItem(key); } catch { return null; }
  };

  const db = await openDb();
  if (!db) return fallback();

  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => {
      const value = typeof req.result === 'string' ? req.result : null;
      // Si IndexedDB aún no tiene un valor válido, conservar el respaldo
      // local evita arrancar el POS con un estado vacío tras una recuperación.
      resolve(value ?? fallback());
    };
    req.onerror = () => resolve(fallback());
  });
}

async function writeNow(value: string): Promise<void> {
  const scopeKey = getStorageScopeKey();
  if (!scopeKey) return;
  const fallbackKey = getPalmyraScopedStorageKey('palmyra-local-state');
  const operation = writeChain.then(async () => {
    const db = await openDb();

    if (!db) {
      try {
        if (!fallbackKey) return;
        localStorage.setItem(fallbackKey, value);
        lastWriteError = null;
        return;
      } catch (localError) {
        const error = new Error(`No se pudo persistir el estado local: ${String(localError)}`);
        lastWriteError = error;
        throw error;
      }
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB state write failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB state write aborted'));
      });
      lastWriteError = null;
    } catch (idbError) {
      // Respaldo inmediato: una venta cobrada offline nunca debe depender de
      // una única implementación de almacenamiento del navegador.
      try {
        if (!fallbackKey) throw idbError;
        localStorage.setItem(fallbackKey, value);
        lastWriteError = null;
        console.warn('[localStateStorage] IndexedDB falló; se guardó el estado en localStorage:', idbError);
      } catch (localError) {
        const error = new Error(
          `No se pudo persistir el estado local ni en IndexedDB ni en localStorage: ${String(localError)}`
        );
        lastWriteError = error;
        throw error;
      }
    }
  });

  // La cadena queda siempre reutilizable para las siguientes escrituras, pero
  // conservamos el último error para que flushLocalStateStorage pueda reportar
  // correctamente una pérdida de persistencia.
  writeChain = operation.catch(error => {
    lastWriteError = error instanceof Error ? error : new Error(String(error));
    console.error('[localStateStorage] Error escribiendo estado local:', error);
  });

  await operation;
}

export async function flushLocalStateStorage(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    const next = pendingValue;
    pendingValue = null;
    if (next != null) {
      await writeNow(next);
      return;
    }
  }

  await writeChain;
  if (lastWriteError) {
    const error = lastWriteError;
    lastWriteError = null;
    throw error;
  }
}

export const localStateStorage: StateStorage = {
  getItem: async () => {
    const value = await read();
    // Migración transparente desde la persistencia antigua de Zustand.
    if (value) {
      void writeNow(value);
    }
    return value;
  },
  setItem: async (_name, value) => {
    pendingValue = value;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const next = pendingValue;
      pendingValue = null;
      if (next != null) void writeNow(next);
    }, 250);
  },
  removeItem: async () => {
    const fallbackKey = getPalmyraScopedStorageKey('palmyra-local-state');
    const db = await openDb();
    if (!db) {
      if (fallbackKey) {
        try { localStorage.removeItem(fallbackKey); } catch {}
      }
      return;
    }
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
};

export async function clearLocalStateStorage(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    const next = pendingValue;
    pendingValue = null;
    if (next != null) {
      try {
        await writeNow(next);
      } catch (error) {
        console.warn('[localStateStorage] No se pudo vaciar la escritura pendiente antes de limpiar:', error);
      }
    }
  }

  // Esperar a cualquier escritura que ya esté en vuelo. Sin esto, un put()
  // pendiente podía terminar después del delete() y reconstituir una caché vieja.
  try { await writeChain; } catch {}

  const db = await openDb();
  if (db) {
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }

  const fallbackKey = getPalmyraScopedStorageKey('palmyra-local-state');
  if (fallbackKey) {
    try { localStorage.removeItem(fallbackKey); } catch {}
  }
}
