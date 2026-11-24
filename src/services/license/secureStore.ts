/**
 * Almacén de secretos pequeños (claves, tokens, material de identidad).
 *
 * En el POS de escritorio los valores se cifran con `safeStorage` de Electron,
 * que respalda la clave en el llavero del sistema operativo; el renderer nunca
 * ve la clave, solo entrega el texto por IPC. En el APK los valores se cifran
 * con una clave AES del Android Keystore (`PALMYRA_KEYSTORE`) y en IndexedDB
 * solo queda el sobre cifrado. En navegador y PWA el secure store no existe:
 * se degrada a IndexedDB, que aquí funciona como almacén tolerante (sin
 * cifrado en reposo) para no romper la sesión.
 *
 * Ningún método lanza hacia la app: un fallo del puente degrada al respaldo
 * local y devuelve null/false.
 */

import { getNativeKeystoreBridge, openNativeSecret, sealNativeSecret } from "../../lib/nativeApp";

export type SecureStoreKind = "electron" | "keystore" | "indexeddb" | "memory";

/** Resultado saneado que devuelve el preload. */
export interface SecureStoreBridgeResult {
  ok: boolean;
  value?: string | null;
  error?: string;
  /** true cuando el main no puede cifrar (safeStorage no disponible). */
  unavailable?: boolean;
}

export interface SecureStoreBridge {
  get(key: string): Promise<SecureStoreBridgeResult>;
  set(key: string, value: string): Promise<SecureStoreBridgeResult>;
  delete(key: string): Promise<SecureStoreBridgeResult>;
}

export interface SecureStringStore {
  readonly kind: SecureStoreKind;
  /** true solo si el sistema operativo cifra el valor en reposo. */
  readonly atRestEncryption: boolean;
  /**
   * Comprueba de verdad (sondeando el puente si hace falta) si el valor queda
   * cifrado. `atRestEncryption` es sincrónico y puede adelantarse a la sonda.
   */
  isEncryptionActive(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export const SECURE_STORE_DB_NAME = "palmyra-secure-v1";
export const SECURE_STORE_OBJECT = "secrets";
export const SECURE_STORE_MAX_VALUE_LENGTH = 200_000;

const SECURE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const PROBE_KEY = "secure-probe";

/** El preload y el main aplican la misma regla de claves. */
export function sanitizeSecureKey(key: unknown): string | null {
  return typeof key === "string" && SECURE_KEY_PATTERN.test(key) ? key : null;
}

/* ------------------------------------------------------------------ */
/* Implementaciones                                                    */
/* ------------------------------------------------------------------ */

export function createMemorySecureStore(
  initial: Record<string, string> = {},
  options: { atRestEncryption?: boolean } = {}
): SecureStringStore {
  const data = new Map<string, string>(Object.entries(initial));
  const encrypted = options.atRestEncryption === true;
  return {
    kind: "memory",
    atRestEncryption: encrypted,
    async isEncryptionActive() {
      return encrypted;
    },
    async get(key) {
      const clean = sanitizeSecureKey(key);
      return clean && data.has(clean) ? (data.get(clean) as string) : null;
    },
    async set(key, value) {
      const clean = sanitizeSecureKey(key);
      if (!clean || typeof value !== "string") return false;
      data.set(clean, value);
      return true;
    },
    async delete(key) {
      const clean = sanitizeSecureKey(key);
      if (clean) data.delete(clean);
    }
  };
}

/**
 * Fallback IndexedDB con un object store `secrets` de registros { key, value }.
 * Sin IndexedDB (pruebas, SSR) queda inerte: get null y escrituras silenciosas.
 */
export function createIndexedDbSecureStore(
  options: { factory?: IDBFactory; dbName?: string } = {}
): SecureStringStore {
  const factory = options.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  const dbName = options.dbName ?? SECURE_STORE_DB_NAME;
  let opening: Promise<IDBDatabase | null> | null = null;

  function ready(): Promise<IDBDatabase | null> {
    if (!factory) return Promise.resolve(null);
    if (opening) return opening;
    opening = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(dbName, 1);
      } catch {
        opening = null;
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SECURE_STORE_OBJECT)) {
          db.createObjectStore(SECURE_STORE_OBJECT, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        opening = null;
        resolve(null);
      };
      request.onblocked = () => {
        opening = null;
        resolve(null);
      };
    });
    return opening;
  }

  async function get(key: string): Promise<string | null> {
    const clean = sanitizeSecureKey(key);
    if (!clean) return null;
    const db = await ready();
    if (!db || !db.objectStoreNames.contains(SECURE_STORE_OBJECT)) return null;
    return new Promise<string | null>((resolve) => {
      try {
        const tx = db.transaction(SECURE_STORE_OBJECT, "readonly");
        const request = tx.objectStore(SECURE_STORE_OBJECT).get(clean);
        request.onsuccess = () => {
          const record = request.result as { key?: string; value?: unknown } | undefined;
          resolve(record && record.key === clean && typeof record.value === "string" ? record.value : null);
        };
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function mutate(key: string, value: string | null): Promise<void> {
    const clean = sanitizeSecureKey(key);
    if (!clean) return;
    const db = await ready();
    if (!db || !db.objectStoreNames.contains(SECURE_STORE_OBJECT)) return;
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(SECURE_STORE_OBJECT, "readwrite");
        const store = tx.objectStore(SECURE_STORE_OBJECT);
        if (value === null) store.delete(clean);
        else store.put({ key: clean, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Error escribiendo el almacén seguro"));
        tx.onabort = () => reject(tx.error ?? new Error("Escritura del almacén seguro abortada"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Error escribiendo el almacén seguro"));
      }
    });
  }

  return {
    kind: "indexeddb",
    // IndexedDB no cifra en reposo: se documenta para no prometer seguridad.
    atRestEncryption: false,
    async isEncryptionActive() {
      return false;
    },
    get,
    async set(key, value) {
      if (typeof value !== "string" || value.length > SECURE_STORE_MAX_VALUE_LENGTH) return false;
      try {
        await mutate(key, value);
        return true;
      } catch {
        return false;
      }
    },
    async delete(key) {
      try {
        await mutate(key, null);
      } catch {
        // Silencioso: borrar un secreto ausente no es un error.
      }
    }
  };
}

function bridgeStore(bridge: SecureStoreBridge): SecureStringStore {
  const assertOk = (result: SecureStoreBridgeResult): SecureStoreBridgeResult => {
    if (!result || result.ok !== true) {
      throw new Error(result?.error || "El almacén seguro del sistema no está disponible.");
    }
    return result;
  };
  return {
    kind: "electron",
    atRestEncryption: true,
    async isEncryptionActive() {
      return true;
    },
    async get(key) {
      const clean = sanitizeSecureKey(key);
      if (!clean) return null;
      const result = assertOk(await bridge.get(clean));
      return typeof result.value === "string" ? result.value : null;
    },
    async set(key, value) {
      const clean = sanitizeSecureKey(key);
      if (!clean || typeof value !== "string" || value.length > SECURE_STORE_MAX_VALUE_LENGTH) {
        return false;
      }
      assertOk(await bridge.set(clean, value));
      return true;
    },
    async delete(key) {
      const clean = sanitizeSecureKey(key);
      if (!clean) return;
      assertOk(await bridge.delete(clean));
    }
  };
}

/** Puente que expone el preload aislado; null fuera de Electron. */
export function readDesktopSecureBridge(): SecureStoreBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as { palmyraSecureStore?: Partial<SecureStoreBridge> }).palmyraSecureStore;
  return candidate &&
    typeof candidate.get === "function" &&
    typeof candidate.set === "function" &&
    typeof candidate.delete === "function"
    ? (candidate as SecureStoreBridge)
    : null;
}

/** Motor de cifrado del APK: Android Keystore vía `PALMYRA_KEYSTORE`. */
export interface NativeKeystoreEngine {
  /** Devuelve el sobre cifrado en Base64 o null si el Keystore falló. */
  seal(text: string): Promise<string | null>;
  /** Devuelve el texto descifrado o null si el sobre no es de este equipo. */
  open(envelope: string): Promise<string | null>;
}

const defaultKeystoreEngine: NativeKeystoreEngine = {
  seal: (text) => sealNativeSecret(text),
  open: (envelope) => openNativeSecret(envelope)
};

/**
 * Secure store del APK: la clave AES vive en el Android Keystore (no
 * exportable) y en IndexedDB solo queda el sobre cifrado. Copiar la carpeta de
 * datos de la app a otro equipo no sirve: el Keystore no puede descifrarlo.
 *
 * La sonda de arranque cifra y descifra un texto fijo; si falla, el almacén se
 * declara sin cifrado y la app usa el respaldo tolerante.
 */
export function createNativeKeystoreSecureStore(
  options: {
    engine?: NativeKeystoreEngine | null;
    backing?: SecureStringStore;
    idb?: { factory?: IDBFactory; dbName?: string };
  } = {}
): SecureStringStore {
  const engine = options.engine ?? defaultKeystoreEngine;
  // El sobre cifrado se persiste en IndexedDB; el texto claro nunca.
  const backing = options.backing ?? createIndexedDbSecureStore(options.idb);
  let probe: Promise<boolean> | null = null;

  function probeEncryption(): Promise<boolean> {
    if (probe) return probe;
    probe = (async () => {
      try {
        const sealed = await engine.seal(PROBE_KEY);
        if (!sealed) return false;
        return (await engine.open(sealed)) === PROBE_KEY;
      } catch {
        return false;
      }
    })();
    return probe;
  }

  return {
    kind: "keystore",
    // El Keystore siempre cifra; `isEncryptionActive` lo comprueba de verdad.
    atRestEncryption: true,
    isEncryptionActive() {
      return probeEncryption();
    },
    async get(key) {
      const clean = sanitizeSecureKey(key);
      if (!clean) return null;
      try {
        const sealed = await backing.get(clean);
        if (!sealed) return null;
        return await engine.open(sealed);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      const clean = sanitizeSecureKey(key);
      if (!clean || typeof value !== "string" || value.length > SECURE_STORE_MAX_VALUE_LENGTH) {
        return false;
      }
      try {
        const sealed = await engine.seal(value);
        if (!sealed) return false;
        return await backing.set(clean, sealed);
      } catch {
        return false;
      }
    },
    async delete(key) {
      const clean = sanitizeSecureKey(key);
      if (!clean) return;
      try {
        await backing.delete(clean);
      } catch {
        // Silencioso: borrar un secreto ausente no es un error.
      }
    }
  };
}

/**
 * Secure store resiliente: usa el cifrado del sistema operativo cuando responde
 * (`safeStorage` en escritorio, Keystore en el APK) y cae a IndexedDB (o
 * memoria) sin lanzar. La sonda de arranque no escribe nada.
 */
export function createSecureStore(
  options: {
    bridge?: SecureStoreBridge | null;
    fallback?: SecureStringStore;
    keystore?: NativeKeystoreEngine | null;
    keystoreBacking?: SecureStringStore;
  } = {}
): SecureStringStore {
  const bridge = options.bridge === undefined ? readDesktopSecureBridge() : options.bridge;
  const fallback = options.fallback ?? createIndexedDbSecureStore();
  const electron = bridge ? bridgeStore(bridge) : null;
  // Sin puente de escritorio, el APK cifra con su Keystore. En navegador y PWA
  // no hay ninguno de los dos y el almacén queda en el respaldo tolerante.
  const keystoreEngine =
    options.keystore === undefined
      ? getNativeKeystoreBridge()
        ? defaultKeystoreEngine
        : null
      : options.keystore;
  const keystore =
    !electron && keystoreEngine
      ? createNativeKeystoreSecureStore({
          engine: keystoreEngine,
          backing: options.keystoreBacking
        })
      : null;
  let active: SecureStringStore | null = null;

  function degrade(): SecureStringStore {
    active = fallback;
    return fallback;
  }

  async function select(): Promise<SecureStringStore> {
    if (active) return active;
    if (electron && bridge) {
      try {
        // Lectura de una clave inexistente: el main responde si puede descifrar.
        const probe = await bridge.get(PROBE_KEY);
        if (probe && probe.ok === true) {
          active = electron;
          return electron;
        }
      } catch {
        // Se degrada abajo.
      }
    }
    if (keystore) {
      try {
        if (await keystore.isEncryptionActive()) {
          active = keystore;
          return keystore;
        }
      } catch {
        // Se degrada abajo.
      }
    }
    return degrade();
  }

  return {
    get kind() {
      return (active ?? electron ?? keystore ?? fallback).kind;
    },
    get atRestEncryption() {
      return (active ?? electron ?? keystore ?? fallback).atRestEncryption;
    },
    async isEncryptionActive() {
      const selected = await select();
      return selected.atRestEncryption;
    },
    async get(key) {
      const selected = await select();
      try {
        return await selected.get(key);
      } catch {
        // Un fallo de lectura (p. ej. un perfil copiado a otro equipo que el
        // llavero no puede descifrar) cae al respaldo SIN degradar la sesión:
        // escribir sigue siendo posible y la identidad se rehace.
        return selected === fallback ? null : await fallback.get(key);
      }
    },
    async set(key, value) {
      const selected = await select();
      try {
        return await selected.set(key, value);
      } catch {
        if (selected === fallback) return false;
        return degrade().set(key, value);
      }
    },
    async delete(key) {
      const selected = await select();
      try {
        await selected.delete(key);
      } catch {
        if (selected !== fallback) await degrade().delete(key);
      }
    }
  };
}

let defaultStore: SecureStringStore | null = null;

/** Instancia de la sesión: `safeStorage` en escritorio, Keystore en el APK,
 *  IndexedDB en navegador/PWA. */
export function getDefaultSecureStore(): SecureStringStore {
  if (!defaultStore) defaultStore = createSecureStore();
  return defaultStore;
}

/** Permite inyectar un almacén (pruebas) o reiniciar la detección. */
export function setDefaultSecureStore(store: SecureStringStore | null): void {
  defaultStore = store;
}

/**
 * Adaptador para las APIs de licencia que esperan un almacén clave-valor.
 * Solo devuelve valores de tipo texto; el resto se ignora.
 */
export function secureStoreAsKeyValue(store: SecureStringStore): {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
} {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const value = await store.get(key);
      return value === null ? null : (value as unknown as T);
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      if (typeof value === "string") await store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      await store.delete(key);
    }
  };
}
