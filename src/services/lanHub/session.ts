/**
 * Sesión persistente de un equipo emparejado con el hub LAN.
 *
 * El token de dispositivo es el único secreto del canal: aquí se guarda tal
 * cual en IndexedDB (el hub solo conserva su hash) y NUNCA se escribe en logs,
 * mensajes de error ni en la URL. Si IndexedDB no está disponible (modo
 * privado, SSR, pruebas) se conserva en memoria para no perder la sesión en
 * curso; el cursor sigue siendo monótono igualmente.
 */

export interface HubSession {
  hubId: string;
  deviceId: string;
  token: string;
  baseUrl: string;
  /** ISO-8601 del momento del emparejamiento. */
  joinedAt: string;
  /** Último `seq` del journal aplicado; nunca retrocede. */
  cursor: number;
}

export interface HubSessionStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export const HUB_SESSION_DB_NAME = "palmyra-hub-session-v1";
export const HUB_SESSION_KEY = "session";
/** Cursor de salida (outbox), independiente del cursor de entrada. */
const HUB_OUTBOX_CURSOR_KEY = "outboxCursor";
const STORE_NAME = "kv";

function createIndexedDbHubSessionStore(
  options: { factory?: IDBFactory; dbName?: string } = {}
): HubSessionStore {
  const dbName = options.dbName ?? HUB_SESSION_DB_NAME;
  const factory =
    options.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
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
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Otra pestaña puede actualizar la versión: se cierra y se reabre luego.
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

  async function get<T = unknown>(key: string): Promise<T | null> {
    const db = await ready();
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => {
          const record = request.result as { key?: string; value?: T } | undefined;
          resolve(record && record.key === key && "value" in record ? (record.value as T) : null);
        };
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function set<T = unknown>(key: string, value: T): Promise<void> {
    const db = await ready();
    // Inerte sin IndexedDB: se pierde la persistencia, nunca la sesión en curso.
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return;
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Error escribiendo la sesión del hub"));
        tx.onabort = () => reject(tx.error ?? new Error("Escritura de la sesión del hub abortada"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Error escribiendo la sesión del hub"));
      }
    });
  }

  async function remove(key: string): Promise<void> {
    const db = await ready();
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return;
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Error borrando la sesión del hub"));
        tx.onabort = () => reject(tx.error ?? new Error("Borrado de la sesión del hub abortado"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Error borrando la sesión del hub"));
      }
    });
  }

  return { get, set, delete: remove };
}

/** Almacén volátil para pruebas y como respaldo cuando IndexedDB falla. */
export function createMemoryHubSessionStore(): HubSessionStore {
  const data = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return data.has(key) ? (data.get(key) as T) : null;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Estado del módulo                                                   */
/* ------------------------------------------------------------------ */

let store: HubSessionStore | null = null;
/** Copia en memoria: respaldo si el almacén falla o es inerte. */
let memory: HubSession | null = null;
/** Copia en memoria del cursor de salida; mismo papel que `memory`. */
let outboxCursorMemory: number | null = null;
let cursorLock: Promise<unknown> = Promise.resolve();
let outboxCursorLock: Promise<unknown> = Promise.resolve();
const listeners = new Set<(session: HubSession | null) => void>();

function currentStore(): HubSessionStore {
  if (!store) store = createIndexedDbHubSessionStore();
  return store;
}

/**
 * Sustituye el almacén (pruebas o un adaptador futuro). `null` restaura el
 * IndexedDB por defecto. No toca la memoria ni notifica a los suscriptores.
 */
export function configureHubSessionStorage(next: HubSessionStore | null): void {
  store = next;
  memory = null;
  outboxCursorMemory = null;
}

function cloneSession(session: HubSession): HubSession {
  return { ...session };
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Descarta registros corruptos: sin token, hub o equipo no hay sesión. */
function sanitizeSession(raw: unknown): HubSession | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<HubSession>;
  const hubId = textValue(candidate.hubId);
  const deviceId = textValue(candidate.deviceId);
  const token = textValue(candidate.token);
  const baseUrl = textValue(candidate.baseUrl);
  const joinedAt = textValue(candidate.joinedAt);
  if (!hubId || !deviceId || !token || !baseUrl || !joinedAt) return null;
  const cursorRaw = candidate.cursor;
  const cursor =
    typeof cursorRaw === "number" && Number.isSafeInteger(cursorRaw) && cursorRaw >= 0
      ? cursorRaw
      : 0;
  return { hubId, deviceId, token, baseUrl, joinedAt, cursor };
}

async function readStored(): Promise<HubSession | null> {
  try {
    const raw = await currentStore().get<unknown>(HUB_SESSION_KEY);
    return sanitizeSession(raw);
  } catch {
    return null;
  }
}

function notify(session: HubSession | null): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(session ? cloneSession(session) : null);
    } catch {
      // Un suscriptor roto no puede tumbar a los demás ni la persistencia.
    }
  }
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/** Sesión vigente o null. Nunca lanza y nunca registra el token. */
export async function getHubSession(): Promise<HubSession | null> {
  const stored = await readStored();
  if (stored) {
    memory = stored;
    return cloneSession(stored);
  }
  return memory ? cloneSession(memory) : null;
}

/**
 * Guarda la sesión. El cursor nunca retrocede para el mismo hub y equipo:
 * reescribir con un valor menor conserva el más alto ya confirmado.
 */
export async function saveHubSession(session: HubSession): Promise<HubSession | null> {
  const clean = sanitizeSession(session);
  if (!clean) throw new Error("La sesión del hub LAN no es válida");

  const previous = memory ?? (await readStored());
  if (
    previous &&
    previous.hubId === clean.hubId &&
    previous.deviceId === clean.deviceId &&
    previous.cursor > clean.cursor
  ) {
    clean.cursor = previous.cursor;
  }

  memory = cloneSession(clean);
  try {
    await currentStore().set(HUB_SESSION_KEY, memory);
  } catch {
    // Cuota o modo privado: la memoria mantiene la sesión en esta ejecución.
  }
  notify(memory);
  return cloneSession(clean);
}

/** Borra la sesión del almacén y de la memoria; avisa a los suscriptores. */
export async function clearHubSession(): Promise<void> {
  memory = null;
  outboxCursorMemory = 0;
  try {
    await currentStore().delete(HUB_SESSION_KEY);
  } catch {
    // Si el borrado falla, la memoria ya está limpia.
  }
  try {
    await currentStore().delete(HUB_OUTBOX_CURSOR_KEY);
  } catch {
    // El cursor de salida se reinicia igualmente en memoria.
  }
  notify(null);
}

/**
 * Avanza el cursor de la sesión sin retroceder jamás. Devuelve el cursor
 * efectivo; si no hay sesión devuelve 0 y no escribe nada.
 */
export function advanceCursor(seq: number): Promise<number> {
  const run = cursorLock.then(
    () => advanceCursorNow(seq),
    () => advanceCursorNow(seq)
  );
  cursorLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function advanceCursorNow(seq: number): Promise<number> {
  const current = await getHubSession();
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) {
    return current ? current.cursor : 0;
  }
  if (!current) return 0;
  const next = Math.max(current.cursor, Math.floor(seq));
  if (next === current.cursor) return current.cursor;
  await saveHubSession({ ...current, cursor: next });
  return next;
}

/* ------------------------------------------------------------------ */
/* Cursor de salida (outbox)                                           */
/* ------------------------------------------------------------------ */

function outboxSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Cursor de salida del equipo; 0 si nunca se guardó. Es independiente del
 * cursor de entrada porque miden journals distintos (este, el local).
 */
export async function loadHubOutboxCursor(): Promise<number> {
  try {
    const stored = outboxSeq(await currentStore().get<unknown>(HUB_OUTBOX_CURSOR_KEY));
    if (stored !== null) {
      // La memoria y el almacén pueden discrepar tras un fallo de escritura:
      // el mayor es el único que no reabre una ventana ya confirmada.
      outboxCursorMemory =
        outboxCursorMemory === null ? stored : Math.max(outboxCursorMemory, stored);
    }
  } catch {
    // Almacén inerte: se responde con la copia en memoria.
  }
  return outboxCursorMemory ?? 0;
}

/** Guarda el cursor de salida sin retroceder nunca. No lanza hacia afuera. */
export function saveHubOutboxCursor(seq: number): Promise<void> {
  const run = outboxCursorLock.then(
    () => saveHubOutboxCursorNow(seq),
    () => saveHubOutboxCursorNow(seq)
  );
  outboxCursorLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function saveHubOutboxCursorNow(seq: number): Promise<void> {
  const target = outboxSeq(seq);
  if (target === null) return;
  const current = await loadHubOutboxCursor();
  if (target <= current) {
    outboxCursorMemory = current;
    return;
  }
  outboxCursorMemory = target;
  try {
    await currentStore().set(HUB_OUTBOX_CURSOR_KEY, target);
  } catch {
    // Cuota o modo privado: la memoria mantiene el avance de esta ejecución.
  }
}

/** Se avisa en cada guardado, avance de cursor y borrado. Devuelve el baja. */
export function subscribeHubSession(
  listener: (session: HubSession | null) => void
): () => void {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
