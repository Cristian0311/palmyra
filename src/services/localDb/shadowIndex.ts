/**
 * Índice de la escritura en sombra.
 *
 * Guarda, por empresa, qué escribió la última importación del estado legado:
 * el hash de cada fila y la versión local que se le asignó. Con eso la
 * siguiente pasada solo escribe lo que cambió y puede distinguir un borrado
 * legítimo de una fila que el hub o la nube modificaron por su cuenta.
 *
 * Vive aparte del almacén de negocio (IndexedDB con su propia base) para no
 * añadir tablas fuera del esquema ni gastar la cuota de localStorage.
 */

export interface ShadowRowStamp {
  /** Huella del contenido de negocio (sin versión, fecha ni dispositivo). */
  h: string;
  /** Versión local asignada en la última escritura. */
  v: number;
}

export interface ShadowIndexData {
  /** Huella del JSON legado completo que produjo este índice. */
  raw?: string;
  /** Huella por colección legada: permite saltar colecciones sin cambios. */
  collections: Record<string, string>;
  tables: Record<string, Record<string, ShadowRowStamp>>;
}

export interface ShadowIndexStore {
  load(): Promise<ShadowIndexData>;
  save(data: ShadowIndexData): Promise<void>;
}

export function emptyShadowIndex(): ShadowIndexData {
  return { collections: {}, tables: {} };
}

export function createMemoryShadowIndexStore(initial?: ShadowIndexData): ShadowIndexStore {
  let current = initial ?? emptyShadowIndex();
  return {
    async load() {
      return current;
    },
    async save(data) {
      current = data;
    }
  };
}

const DB_NAME = "palmyra-shadow-index-v1";
const STORE = "index";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * El índice es una optimización: si IndexedDB falla, se trabaja con un índice
 * vacío en memoria y la importación vuelve a escribir (idempotente) en vez de
 * romper el arranque.
 */
export function createShadowIndexStore(scopeKey: string): ShadowIndexStore {
  let fallback: ShadowIndexData | null = null;
  const key = scopeKey || "default";

  return {
    async load() {
      const db = await openDb();
      if (!db) return fallback ?? emptyShadowIndex();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(key);
          req.onsuccess = () => {
            const value = req.result as ShadowIndexData | undefined;
            resolve(value && typeof value === "object" ? value : emptyShadowIndex());
          };
          req.onerror = () => resolve(emptyShadowIndex());
          tx.onabort = () => resolve(emptyShadowIndex());
        } catch {
          resolve(emptyShadowIndex());
        } finally {
          db.close();
        }
      });
    },
    async save(data) {
      const db = await openDb();
      if (!db) {
        fallback = data;
        return;
      }
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(data, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        } finally {
          db.close();
        }
      });
    }
  };
}
