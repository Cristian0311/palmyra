import {
  LICENSE_SIGNATURE_ALG,
  LICENSE_VERSION,
  type SignedLease
} from "./contract";
import type { ClockTamperDraft, ClockTamperKind, ClockTamperSource } from "./clock";
import {
  devicePrivateSeal,
  fingerprintFromPublicJwk,
  importStoredPrivateKey,
  type DeviceKey
} from "./deviceKey";
import { getDefaultSecureStore } from "./secureStore";

/**
 * Persistencia de la identidad del dispositivo, el lease firmado y la marca de
 * agua del reloj. Todo se guarda en un almacén clave-valor pequeño que puede
 * ser IndexedDB (producción), memoria (pruebas) o cualquier adaptador futuro.
 *
 * El lease NUNCA se valida criptográficamente aquí: esta capa solo comprueba
 * la forma para descartar datos corruptos y que la verificación de firma siga
 * siendo responsabilidad del evaluador de licencia.
 */

export interface LicenseKeyValueStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export const LICENSE_STORE_KEYS = {
  deviceKey: "device-key",
  leasePrefix: "lease:",
  watermark: "clock-watermark",
  /** Telemetría local de manipulación del reloj (acotada, sin datos personales). */
  clockTelemetry: "clock-telemetry"
};

const DEFAULT_DB_NAME = "palmyra-license-v1";
const DEFAULT_STORE_NAME = "kv";

/** Almacén volátil para pruebas y como último recurso en memoria. */
export function createMemoryLicenseStore(): LicenseKeyValueStore {
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

/**
 * Almacén IndexedDB con un único object store "kv" de registros { key, value }.
 * Si IndexedDB no está disponible (modo privado antiguo, SSR, pruebas) el
 * driver queda inerte: get devuelve null y las escrituras no rompen la app.
 */
export function createIndexedDbLicenseStore(
  options: { factory?: IDBFactory; dbName?: string } = {}
): LicenseKeyValueStore {
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
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
        if (!db.objectStoreNames.contains(DEFAULT_STORE_NAME)) {
          db.createObjectStore(DEFAULT_STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Si otra pestaña actualiza la versión, se cierra y se reabre luego.
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
    if (!db || !db.objectStoreNames.contains(DEFAULT_STORE_NAME)) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(DEFAULT_STORE_NAME, "readonly");
        const request = tx.objectStore(DEFAULT_STORE_NAME).get(key);
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

  async function mutate(key: string, value: unknown, remove: boolean): Promise<void> {
    const db = await ready();
    // Inerte sin IndexedDB: se pierde la persistencia, nunca la sesión en curso.
    if (!db || !db.objectStoreNames.contains(DEFAULT_STORE_NAME)) return;
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(DEFAULT_STORE_NAME, "readwrite");
        const objectStore = tx.objectStore(DEFAULT_STORE_NAME);
        if (remove) objectStore.delete(key);
        else objectStore.put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Error escribiendo IndexedDB"));
        tx.onabort = () => reject(tx.error ?? new Error("Escritura abortada"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Error escribiendo IndexedDB"));
      }
    });
  }

  return {
    get,
    set: (key, value) => mutate(key, value, false),
    delete: (key) => mutate(key, undefined, true)
  };
}

/* ------------------------------------------------------------------ */
/* Identidad del dispositivo                                           */
/* ------------------------------------------------------------------ */

function isCryptoKeyLike(value: unknown): value is CryptoKey {
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) return true;
  // Reserva estructural para CryptoKey de otro contexto (iframe, worker).
  const candidate = value as Partial<CryptoKey> | null;
  return (
    !!candidate &&
    typeof candidate === "object" &&
    candidate.type === "private" &&
    typeof candidate.algorithm === "object" &&
    Array.isArray(candidate.usages)
  );
}

function isPublicJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object") return false;
  const jwk = value as JsonWebKey;
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    jwk.x.length > 0 &&
    typeof jwk.y === "string" &&
    jwk.y.length > 0
  );
}

/** Huella sha256 en base64url: siempre 43 caracteres. */
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Registro estructurado (IndexedDB). Contiene la pública y la huella siempre;
 * la CryptoKey solo existe cuando NO hay llavero del sistema (navegador/PWA).
 * Con llavero, la privada vive cifrada por el SO y este registro no sirve para
 * suplantar al equipo si se copia la carpeta del perfil.
 */
interface StoredDeviceIdentity {
  publicJwk: JsonWebKey;
  fingerprint: string;
  privateKey?: CryptoKey;
}

const DEVICE_KEY_RECORD_VERSION = 2;

function parseStoredIdentity(value: unknown): StoredDeviceIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DeviceKey> & { v?: unknown };
  if (!isPublicJwk(candidate.publicJwk)) return null;
  if (
    typeof candidate.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(candidate.fingerprint)
  ) {
    return null;
  }
  if (candidate.privateKey === undefined) {
    return { publicJwk: candidate.publicJwk, fingerprint: candidate.fingerprint };
  }
  if (!isCryptoKeyLike(candidate.privateKey)) return null;
  return {
    publicJwk: candidate.publicJwk,
    fingerprint: candidate.fingerprint,
    privateKey: candidate.privateKey
  };
}

/**
 * Diagnóstico de la identidad: de dónde salió la clave y si está ligada al
 * sistema operativo. Sin material de clave; pensado para la UI y el soporte.
 */
export type DeviceIdentitySource = "os-store" | "perfil" | "nuevo" | "no-disponible";

export interface DeviceIdentityReport {
  source: DeviceIdentitySource;
  /** true solo si el llavero del SO cifra la copia de la clave privada. */
  bound: boolean;
  reason?: string;
}

let lastIdentityReport: DeviceIdentityReport = {
  source: "no-disponible",
  bound: false,
  reason: "Todavía no se ha cargado la identidad del equipo."
};

function setIdentityReport(report: DeviceIdentityReport): void {
  lastIdentityReport = report;
}

/** Última información conocida de la identidad. Nunca incluye clave material. */
export function getDeviceIdentityReport(): DeviceIdentityReport {
  return { ...lastIdentityReport };
}

export async function saveDeviceKey(
  store: LicenseKeyValueStore,
  key: DeviceKey
): Promise<void> {
  // 1. Copia cifrada por el sistema operativo: es la única que ata la identidad
  //    a esta máquina/usuario. Sin llavero no hay vinculación posible.
  const bound = await persistBoundDeviceKey(key);

  if (bound) {
    // 2a. Registro estructurado SIN CryptoKey: copiar el perfil a otro equipo
    //     deja una pública huérfana y la app rehace la identidad allí.
    await store.set(LICENSE_STORE_KEYS.deviceKey, {
      v: DEVICE_KEY_RECORD_VERSION,
      publicJwk: key.publicJwk,
      fingerprint: key.fingerprint
    });
    setIdentityReport({ source: "os-store", bound: true });
    return;
  }

  // 2b. Sin cifrado en reposo (navegador/PWA) se conserva la CryptoKey no
  //     extraíble en el almacén estructurado: respaldo tolerante, no vinculante.
  await store.set(LICENSE_STORE_KEYS.deviceKey, {
    publicJwk: key.publicJwk,
    privateKey: key.privateKey,
    fingerprint: key.fingerprint
  });
  setIdentityReport({
    source: "perfil",
    bound: false,
    reason: "El sistema no ofrece llavero: la identidad queda ligada al perfil local."
  });
  await discardStaleSecureCopy(key.fingerprint);
}

/** Devuelve null si el registro falta o está corrupto; nunca lanza. */
export async function loadDeviceKey(
  store: LicenseKeyValueStore
): Promise<DeviceKey | null> {
  let identity: StoredDeviceIdentity | null = null;
  try {
    identity = parseStoredIdentity(await store.get<unknown>(LICENSE_STORE_KEYS.deviceKey));
  } catch {
    identity = null;
  }

  // Respaldo sin cifrado (navegador/PWA): la CryptoKey no extraíble ya sirve.
  if (identity?.privateKey) {
    setIdentityReport({
      source: "perfil",
      bound: false,
      reason: "Sin llavero del sistema: la identidad vive en el perfil local."
    });
    return {
      publicJwk: identity.publicJwk,
      privateKey: identity.privateKey,
      fingerprint: identity.fingerprint
    };
  }

  // Con llavero, la privada solo se puede recuperar si el SO descifra la copia.
  const secure = await loadSecureDeviceKey();
  if (!secure) {
    setIdentityReport({
      source: identity ? "no-disponible" : "nuevo",
      bound: false,
      reason: identity
        ? "La copia cifrada del equipo no se puede abrir aquí: se crea una identidad nueva."
        : "No hay identidad guardada en este equipo."
    });
    return null;
  }
  // Nunca se mezclan dos identidades: si la pública del registro no coincide
  // con la copia del llavero, manda el llavero y el registro se descarta.
  if (identity && identity.fingerprint !== secure.fingerprint) {
    setIdentityReport({
      source: "os-store",
      bound: true,
      reason: "El registro público no coincidía con la copia del llavero."
    });
    return secure;
  }
  setIdentityReport({ source: "os-store", bound: true });
  return secure;
}

/* ------------------------------------------------------------------ */
/* Copia del secure store                                              */
/* ------------------------------------------------------------------ */

/** Clave del registro de identidad dentro del secure store. */
export const LICENSE_SECURE_KEYS = {
  deviceKey: "license-device-key",
  /** Copia cifrada del lease por empresa (`license-lease:<companyId>`). */
  leasePrefix: "license-lease:"
} as const;

interface SecureDeviceKeyRecord {
  /**
   * 1 = forma antigua/exportable, 2 = JWK privada sellada por el SO.
   * Ambas se aceptan al leer.
   */
  v: 1 | 2;
  fingerprint: string;
  publicJwk: JsonWebKey;
  /** Solo si la CryptoKey era exportable (migraciones y pruebas). */
  privateJwk?: JsonWebKey;
  /**
   * JWK privada de una clave NO extraíble. WebCrypto no la puede exportar
   * después, así que se deposita aquí en el instante de creación; el blob
   * completo lo cifra el llavero del sistema (safeStorage/Keystore).
   */
  sealedPrivate?: { alg: string; privateJwk: JsonWebKey };
}

function privateJwkOf(key: unknown): JsonWebKey | null {
  if (!key || typeof key !== "object") return null;
  const candidate = key as JsonWebKey;
  const secret = (candidate as { d?: unknown }).d;
  if (
    candidate.kty !== "EC" ||
    candidate.crv !== "P-256" ||
    typeof candidate.x !== "string" ||
    typeof candidate.y !== "string" ||
    typeof secret !== "string" ||
    secret.length === 0
  ) {
    return null;
  }
  return { kty: candidate.kty, crv: candidate.crv, x: candidate.x, y: candidate.y, d: secret };
}

/**
 * Copia cifrada del registro de identidad.
 *
 * Es la pieza que ata la clave al equipo: `safeStorage` (DPAPI/Keychain) o el
 * Android Keystore solo descifran en la misma máquina y usuario, así que
 * copiar `%APPDATA%\palmyra` a otro PC deja un sobre ilegible y la app rehace
 * la identidad (el lease anterior deja de valer allí). Nunca lanza.
 *
 * Devuelve true solo si el llavero del SO escribió la copia con material
 * privado dentro; en cualquier otro caso el llamador conserva la CryptoKey.
 */
async function persistBoundDeviceKey(key: DeviceKey): Promise<boolean> {
  try {
    const store = getDefaultSecureStore();
    // Solo se sella si el sistema cifra de verdad: IndexedDB plano no aporta
    // vinculación y el registro estructurado ya es la fuente de verdad.
    if (!(await store.isEncryptionActive())) return false;

    const seal = devicePrivateSeal(key.privateKey);
    const record: SecureDeviceKeyRecord = {
      v: seal ? 2 : 1,
      fingerprint: key.fingerprint,
      publicJwk: key.publicJwk
    };
    if (seal) {
      record.sealedPrivate = seal;
    } else if (key.privateKey?.extractable === true) {
      try {
        const jwk = privateJwkOf(await crypto.subtle.exportKey("jwk", key.privateKey));
        if (jwk) record.privateJwk = jwk;
      } catch {
        // Sin material exportable no hay vinculación posible.
      }
    }
    // Un registro sin material privado no ata nada: mejor no escribirlo.
    if (!record.sealedPrivate && !record.privateJwk) return false;
    return await store.set(LICENSE_SECURE_KEYS.deviceKey, JSON.stringify(record));
  } catch {
    return false;
  }
}

/** Reconstruye la identidad desde el secure store. Verifica la huella. */
async function loadSecureDeviceKey(): Promise<DeviceKey | null> {
  let raw: string | null;
  try {
    raw = await getDefaultSecureStore().get(LICENSE_SECURE_KEYS.deviceKey);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Partial<SecureDeviceKeyRecord>;
  if (record.v !== 1 && record.v !== 2) return null;
  if (typeof record.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(record.fingerprint)) {
    return null;
  }
  if (!isPublicJwk(record.publicJwk)) return null;
  const privateJwk = privateJwkOf(record.privateJwk) ?? privateJwkOf(record.sealedPrivate?.privateJwk);
  if (!privateJwk) return null;

  // Reimportación no extraíble + pareja x/y contra la pública almacenada.
  const privateKey = await importStoredPrivateKey(privateJwk, record.publicJwk);
  if (!privateKey) return null;
  try {
    // La huella se recomputa: un registro manipulado no puede suplantar equipo.
    const recomputed = await fingerprintFromPublicJwk(record.publicJwk);
    if (recomputed !== record.fingerprint) return null;
  } catch {
    return null;
  }
  return { publicJwk: record.publicJwk, privateKey, fingerprint: record.fingerprint };
}

/**
 * Si la identidad se guardó sin vinculación (sin llavero), una copia sellada
 * de otra identidad quedaría huérfana y podría resucitar en la siguiente
 * carga. Se descarta cuando su huella no coincide. Nunca lanza.
 */
async function discardStaleSecureCopy(fingerprint: string): Promise<void> {
  try {
    const store = getDefaultSecureStore();
    const raw = await store.get(LICENSE_SECURE_KEYS.deviceKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { fingerprint?: unknown } | null;
    if (parsed && typeof parsed.fingerprint === "string" && parsed.fingerprint !== fingerprint) {
      await store.delete(LICENSE_SECURE_KEYS.deviceKey);
    }
  } catch {
    // Best-effort: el registro estructurado manda en este modo.
  }
}

/* ------------------------------------------------------------------ */
/* Lease firmado                                                       */
/* ------------------------------------------------------------------ */

const LEASE_DATE_FIELDS = [
  "paidThrough",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "offlineUntil",
  "serverTimeAnchor"
] as const;

function leaseKey(companyId: string): string {
  return LICENSE_STORE_KEYS.leasePrefix + encodeURIComponent(companyId);
}

/** Clave de la copia cifrada del lease en el almacén del sistema operativo. */
function secureLeaseKey(companyId: string): string {
  return LICENSE_SECURE_KEYS.leasePrefix + encodeURIComponent(companyId);
}

function isCompanyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isLeaseLike(value: unknown, companyId: string): value is SignedLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Partial<SignedLease>;
  if (lease.v !== LICENSE_VERSION) return false;
  if (lease.companyId !== companyId) return false;
  if (typeof lease.leaseId !== "string" || lease.leaseId.length === 0) return false;
  if (lease.signatureAlg !== LICENSE_SIGNATURE_ALG) return false;
  if (typeof lease.signature !== "string" || lease.signature.length === 0) return false;
  return LEASE_DATE_FIELDS.every((field) => isIsoDate(lease[field]));
}

export async function saveLease(
  store: LicenseKeyValueStore,
  lease: SignedLease,
  companyId: string
): Promise<void> {
  if (!isCompanyId(companyId)) return;
  await store.set(leaseKey(companyId), lease);
  // Copia cifrada por el llavero del SO: sobrevive a que se borre IndexedDB.
  // El lease va firmado, así que la copia no da privilegios nuevos; solo evita
  // perder la ventana offline por una limpieza del perfil.
  await mirrorLeaseToSecureStore(lease, companyId);
}

/** Devuelve null ante un registro ausente, alterado o de otra empresa. */
export async function loadLease(
  store: LicenseKeyValueStore,
  companyId: string
): Promise<SignedLease | null> {
  if (!isCompanyId(companyId)) return null;
  let raw: unknown = null;
  let missing = false;
  try {
    raw = await store.get<unknown>(leaseKey(companyId));
    missing = raw === null || raw === undefined;
  } catch {
    // Un fallo de lectura no descarta la copia cifrada.
    missing = true;
  }
  if (isLeaseLike(raw, companyId)) return raw;
  // Un registro presente pero alterado se respeta como inválido: la copia del
  // llavero solo se usa cuando el registro primario no está.
  if (!missing) return null;
  return loadLeaseFromSecureStore(companyId);
}

export async function clearLease(
  store: LicenseKeyValueStore,
  companyId: string
): Promise<void> {
  if (!isCompanyId(companyId)) return;
  await store.delete(leaseKey(companyId));
  await clearLeaseSecureCopy(companyId);
}

async function mirrorLeaseToSecureStore(
  lease: SignedLease,
  companyId: string
): Promise<void> {
  try {
    const secure = getDefaultSecureStore();
    if (!(await secure.isEncryptionActive())) return;
    await secure.set(secureLeaseKey(companyId), JSON.stringify(lease));
  } catch {
    // Best-effort: el lease ya quedó en el almacén primario.
  }
}

async function loadLeaseFromSecureStore(companyId: string): Promise<SignedLease | null> {
  try {
    const secure = getDefaultSecureStore();
    if (!(await secure.isEncryptionActive())) return null;
    const raw = await secure.get(secureLeaseKey(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isLeaseLike(parsed, companyId) ? parsed : null;
  } catch {
    return null;
  }
}

async function clearLeaseSecureCopy(companyId: string): Promise<void> {
  try {
    await getDefaultSecureStore().delete(secureLeaseKey(companyId));
  } catch {
    // Silencioso: borrar una copia ausente no es un error.
  }
}

/* ------------------------------------------------------------------ */
/* Marca de agua del reloj                                             */
/* ------------------------------------------------------------------ */

type WatermarkRecord = Record<string, number>;

// Serializa las lecturas-modificaciones-escrituras por almacén para que dos
// avances concurrentes del reloj no puedan pisarse.
const watermarkLocks = new WeakMap<LicenseKeyValueStore, Promise<void>>();

function withWatermarkLock<T>(
  store: LicenseKeyValueStore,
  operation: () => Promise<T>
): Promise<T> {
  const previous = watermarkLocks.get(store) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  watermarkLocks.set(
    store,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function isFiniteMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function readWatermarks(store: LicenseKeyValueStore): Promise<WatermarkRecord> {
  const raw = await store.get<unknown>(LICENSE_STORE_KEYS.watermark);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record: WatermarkRecord = {};
  for (const [companyId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isFiniteMs(value)) record[companyId] = value;
  }
  return record;
}

export async function loadWatermark(
  store: LicenseKeyValueStore,
  companyId: string
): Promise<number | null> {
  if (!isCompanyId(companyId)) return null;
  try {
    const record = await readWatermarks(store);
    const value = record[companyId];
    return isFiniteMs(value) ? value : null;
  } catch {
    return null;
  }
}

/** Solo avanza: un valor menor o igual al guardado se ignora (anti-retroceso). */
export async function saveWatermark(
  store: LicenseKeyValueStore,
  companyId: string,
  ms: number
): Promise<void> {
  if (!isCompanyId(companyId) || !isFiniteMs(ms)) return;
  await withWatermarkLock(store, async () => {
    const record = await readWatermarks(store);
    const current = record[companyId];
    if (isFiniteMs(current) && current >= ms) return;
    record[companyId] = ms;
    await store.set(LICENSE_STORE_KEYS.watermark, record);
  });
}

/**
 * Registra una lectura del reloj del servidor. La marca es el máximo entre lo
 * que diga el servidor, el reloj local y lo ya guardado, y se devuelve.
 */
export async function recordServerTime(
  store: LicenseKeyValueStore,
  companyId: string,
  serverMs: number,
  nowMs: number
): Promise<number> {
  if (!isCompanyId(companyId)) {
    const fallback = [serverMs, nowMs].filter(isFiniteMs);
    return fallback.length > 0 ? Math.max(...fallback) : 0;
  }
  return withWatermarkLock(store, async () => {
    const record = await readWatermarks(store);
    const current = record[companyId];
    const candidates = [serverMs, nowMs, current].filter(isFiniteMs);
    const next = candidates.length > 0 ? Math.max(...candidates) : 0;
    if (!isFiniteMs(current) || next > current) {
      record[companyId] = next;
      await store.set(LICENSE_STORE_KEYS.watermark, record);
    }
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Telemetría local de manipulación del reloj                          */
/* ------------------------------------------------------------------ */

/**
 * Tope de eventos guardados. Al superarse se descartan los más antiguos: la
 * telemetría es una señal acotada, nunca un registro que crece sin límite.
 */
export const LICENSE_CLOCK_TELEMETRY_MAX_EVENTS = 20;

/** Repeticiones del mismo tipo dentro de esta ventana se agrupan en un evento. */
export const LICENSE_CLOCK_TELEMETRY_DEDUPE_MS = 10 * 60 * 1000;

/**
 * Evento local de manipulación del reloj. Deliberadamente SIN datos personales
 * ni de la empresa: solo clase de anomalía, origen, magnitud y marcas de tiempo,
 * para poder enviarlo al reconectar y vaciarlo después.
 */
export interface ClockTamperEvent {
  kind: ClockTamperKind;
  source: ClockTamperSource;
  /** Magnitud del retroceso detectado (ms, redondeada). */
  skewMs: number;
  /** Veces agrupadas dentro de la ventana de deduplicación (>= 1). */
  count: number;
  /** Momento de la primera detección del grupo. */
  firstSeenAt: number;
  /** Momento de la última detección del grupo. */
  lastSeenAt: number;
}

const TAMPER_KINDS: readonly ClockTamperKind[] = ["wall-rollback", "monotonic-regression"];
const TAMPER_SOURCES: readonly ClockTamperSource[] = ["watermark", "server-anchor", "monotonic"];

function isTamperKind(value: unknown): value is ClockTamperKind {
  return typeof value === "string" && TAMPER_KINDS.includes(value as ClockTamperKind);
}

function isTamperSource(value: unknown): value is ClockTamperSource {
  return typeof value === "string" && TAMPER_SOURCES.includes(value as ClockTamperSource);
}

/** Descarta registros alterados sin lanzar: la telemetría nunca rompe la app. */
function sanitizeTamperEvent(raw: unknown): ClockTamperEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<ClockTamperEvent>;
  if (!isTamperKind(candidate.kind) || !isTamperSource(candidate.source)) return null;
  if (!isFiniteMs(candidate.firstSeenAt) || !isFiniteMs(candidate.lastSeenAt)) return null;
  const firstSeenAt = candidate.firstSeenAt;
  const lastSeenAt = Math.max(firstSeenAt, candidate.lastSeenAt);
  return {
    kind: candidate.kind,
    source: candidate.source,
    skewMs: isFiniteMs(candidate.skewMs) ? Math.round(candidate.skewMs) : 0,
    count: isFiniteMs(candidate.count) && candidate.count >= 1 ? Math.floor(candidate.count) : 1,
    firstSeenAt,
    lastSeenAt
  };
}

async function readClockTamperEvents(store: LicenseKeyValueStore): Promise<ClockTamperEvent[]> {
  const raw = await store.get<unknown>(LICENSE_STORE_KEYS.clockTelemetry);
  if (!Array.isArray(raw)) return [];
  const events: ClockTamperEvent[] = [];
  for (const item of raw) {
    const event = sanitizeTamperEvent(item);
    if (event) events.push(event);
  }
  // Se conserva la cola más reciente si el registro excede el tope.
  return events.slice(-LICENSE_CLOCK_TELEMETRY_MAX_EVENTS);
}

/**
 * Persiste una detección de manipulación. Agrupa repeticiones del mismo tipo y
 * origen dentro de la ventana de deduplicación, recorta al tope de eventos y no
 * toca el lease, la identidad ni la marca de agua. Nunca lanza.
 */
export async function recordClockTamperEvent(
  store: LicenseKeyValueStore,
  draft: ClockTamperDraft
): Promise<void> {
  const detectedAt = isFiniteMs(draft?.detectedAtMs) ? draft.detectedAtMs : Date.now();
  const base = sanitizeTamperEvent({
    kind: draft?.kind,
    source: draft?.source,
    skewMs: draft?.skewMs,
    count: 1,
    firstSeenAt: detectedAt,
    lastSeenAt: detectedAt
  });
  if (!base) return;
  try {
    await withWatermarkLock(store, async () => {
      const events = await readClockTamperEvents(store);
      const last = events[events.length - 1];
      if (
        last &&
        last.kind === base.kind &&
        last.source === base.source &&
        base.lastSeenAt >= last.lastSeenAt &&
        base.lastSeenAt - last.lastSeenAt <= LICENSE_CLOCK_TELEMETRY_DEDUPE_MS
      ) {
        last.count += 1;
        last.lastSeenAt = base.lastSeenAt;
        last.skewMs = Math.max(last.skewMs, base.skewMs);
      } else {
        events.push(base);
      }
      while (events.length > LICENSE_CLOCK_TELEMETRY_MAX_EVENTS) events.shift();
      await store.set(LICENSE_STORE_KEYS.clockTelemetry, events);
    });
  } catch {
    // Un fallo de almacenamiento no puede bloquear la operación ni la licencia.
  }
}

/** Lee los eventos pendientes de envío (copia; no los vacía). Nunca lanza. */
export async function loadClockTamperEvents(
  store: LicenseKeyValueStore
): Promise<ClockTamperEvent[]> {
  try {
    return await withWatermarkLock(store, () => readClockTamperEvents(store));
  } catch {
    return [];
  }
}

/**
 * Lee y vacía los eventos: se usa al reconectar para enviarlos al servidor.
 * Si el borrado falla se devuelven igualmente los eventos leídos (no se pierden
 * en esta sesión) y se reintentará en el siguiente envío. Nunca lanza.
 */
export async function drainClockTamperEvents(
  store: LicenseKeyValueStore
): Promise<ClockTamperEvent[]> {
  try {
    return await withWatermarkLock(store, async () => {
      const events = await readClockTamperEvents(store);
      if (events.length === 0) return events;
      try {
        await store.delete(LICENSE_STORE_KEYS.clockTelemetry);
      } catch {
        // Se devuelven los eventos ya leídos; el almacén los conserva.
      }
      return events;
    });
  } catch {
    return [];
  }
}

/** Vacía la telemetría sin devolverla. Solo afecta a la clave de telemetría. */
export async function clearClockTamperEvents(store: LicenseKeyValueStore): Promise<void> {
  try {
    await withWatermarkLock(store, () => store.delete(LICENSE_STORE_KEYS.clockTelemetry));
  } catch {
    // Silencioso a propósito: la telemetría es best-effort.
  }
}
