import test from "node:test";
import assert from "node:assert/strict";
import { leaseSigningInput, toBase64Url } from "../../src/services/license/contract";
import type { LeasePayloadV1, SignedLease } from "../../src/services/license/contract";
import { createDeviceKey } from "../../src/services/license/deviceKey";
import {
  LICENSE_STORE_KEYS,
  createMemoryLicenseStore,
  saveDeviceKey,
  saveLease,
  loadLease,
  loadPinnedPublicKey,
  type LicenseKeyValueStore
} from "../../src/services/license/storage";
import { createLicenseRuntime } from "../../src/services/license/runtime";
import type { LicenseFetch, LicenseRuntimeClient } from "../../src/services/license/runtime";
import {
  assertLicenseWritable,
  isLicenseReadOnly,
  LicenseReadOnlyError,
  setLicenseReadOnly
} from "../../src/services/license/guard";

/**
 * Arranque offline-first de la licencia.
 *
 * Regresión reportada: con un plan de pago ya comprado, cerrar la app con la
 * conexión desactivada y volver a abrirla decía «licencia sin verificar».
 * El lease firmado estaba en disco, pero el runtime salía a la red por la clave
 * pública antes de evaluarlo y, al fallar, publicaba `unmanaged/network-error`
 * (y, sin lease legible, `unmanaged/lease-missing`) sin mirar el lease cacheado.
 */

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const iso = (ms: number): string => new Date(ms).toISOString();

const serverKeys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
])) as CryptoKeyPair;
const serverPublicJwk = await crypto.subtle.exportKey("jwk", serverKeys.publicKey);
const deviceKey = await createDeviceKey();

let leaseSeq = 0;

async function makeLease(overrides: Partial<LeasePayloadV1> = {}): Promise<SignedLease> {
  leaseSeq += 1;
  const payload: LeasePayloadV1 = {
    v: 1,
    leaseId: `offline-lease-${leaseSeq}`,
    companyId: COMPANY_ID,
    deviceId: "equipo-offline",
    devicePubKeyFp: deviceKey.fingerprint,
    planCode: "growth",
    billingMonths: 1,
    limits: { warehouses: 3 },
    featureKeys: ["pos", "transfers"],
    storageMode: "cloud",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - 2 * 60 * 60 * 1000),
    notBefore: iso(NOW - DAY),
    expiresAt: iso(NOW + 40 * DAY),
    offlineUntil: iso(NOW + 20 * DAY),
    graceDays: 5,
    maxOfflineDays: 35,
    serverTimeAnchor: iso(NOW - 2 * 60 * 60 * 1000),
    seq: leaseSeq,
    keyId: "test-key",
    ...overrides
  };
  const signingInput = leaseSigningInput({ ...payload, signature: "", signatureAlg: "ES256" });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    serverKeys.privateKey,
    new TextEncoder().encode(signingInput)
  );
  return { ...payload, signature: toBase64Url(signature), signatureAlg: "ES256" };
}

function keyFetch(jwk: JsonWebKey = serverPublicJwk): LicenseFetch {
  return async () =>
    new Response(JSON.stringify({ keyId: "test-key", jwk }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
}

/** Sin red: cualquier salida a internet lanza como `fetch` cuando falla. */
const offlineFetch: LicenseFetch = async () => {
  throw new TypeError("Failed to fetch");
};

async function seededStore(
  lease: SignedLease | null,
  options: { withDeviceKey?: boolean } = {}
): Promise<LicenseKeyValueStore> {
  const store = createMemoryLicenseStore();
  if (options.withDeviceKey !== false) await saveDeviceKey(store, deviceKey);
  if (lease) await saveLease(store, lease, COMPANY_ID);
  return store;
}

/**
 * Almacén con fallos de lectura conmutables: reproduce IndexedDB bloqueada o
 * abortada en una clave concreta sin perder lo que sigue guardado.
 */
function flakyStore() {
  const data = new Map<string, unknown>();
  const fail = { lease: false, key: "" };
  const store: LicenseKeyValueStore = {
    async get<T = unknown>(key: string): Promise<T | null> {
      return data.has(key) ? (data.get(key) as T) : null;
    },
    async getStrict<T = unknown>(key: string): Promise<T | null> {
      const isLease = key.startsWith(LICENSE_STORE_KEYS.leasePrefix);
      if ((fail.lease && isLease) || (fail.key !== "" && key === fail.key)) {
        throw new Error("IndexedDB transitoriamente no disponible");
      }
      return data.has(key) ? (data.get(key) as T) : null;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    }
  };
  return { store, data, fail };
}

function makeRuntime(args: {
  store: LicenseKeyValueStore;
  fetchImpl?: LicenseFetch;
  now?: () => number;
  getClient?: () => LicenseRuntimeClient | null;
  prefix: string;
}) {
  return createLicenseRuntime({
    store: args.store,
    fetchImpl: args.fetchImpl ?? keyFetch(),
    now: args.now ?? (() => NOW),
    getClient: args.getClient,
    storageKeyPrefix: args.prefix
  });
}

/** Cliente con sesión válida cuyo `issue-lease` siempre falla (red/5xx). */
function failingClient(): LicenseRuntimeClient {
  return {
    auth: {
      async getSession() {
        return { data: { session: { access_token: "token" } }, error: null };
      }
    },
    functions: {
      async invoke() {
        throw new TypeError("network down");
      }
    }
  };
}

/* ------------------- lease válido + arranque sin conexión ---------------- */

test("offline: lease de pago cacheado se evalúa al arrancar y permite escribir", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const store = await seededStore(lease);

  // Primer arranque con red: se ancla la clave pública del servidor.
  const online = makeRuntime({ store, prefix: "offline-boot" });
  const first = await online.start({ companyId: COMPANY_ID });
  assert.equal(first.mode, "active");
  const pinned = await loadPinnedPublicKey(store);
  assert.equal(pinned?.kty, "EC");
  assert.equal(pinned?.crv, "P-256");
  assert.equal(pinned?.x, serverPublicJwk.x);
  assert.equal(pinned?.y, serverPublicJwk.y);

  // Cierre y reapertura sin conexión: nuevo runtime, mismo disco, sin red.
  const offline = makeRuntime({
    store,
    prefix: "offline-boot",
    fetchImpl: offlineFetch,
    getClient: () => null,
    now: () => NOW + 60 * 60 * 1000
  });
  const snapshot = await offline.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "active");
  assert.equal(snapshot.reason, "valid");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.keyConfigured, true);
  assert.equal(snapshot.leasePresent, true);
  assert.equal(snapshot.offlineVerified, true, "verificado sin conexión con el lease guardado");
  assert.equal(snapshot.pendingActivation, false, "no es «sin verificar por primera vez»");
  assert.equal(snapshot.planCode, "growth");

  // El POS puede vender: la guarda no bloquea la escritura.
  assert.doesNotThrow(() => assertLicenseWritable());
  assert.equal(isLicenseReadOnly(), false);
  assert.deepEqual(await loadLease(store, COMPANY_ID), lease);
});

test("offline: sin lease nunca emitido es activación pendiente, no error de red", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(null);
  const runtime = makeRuntime({ store, prefix: "offline-pending", getClient: () => null });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "unmanaged");
  assert.equal(snapshot.reason, "lease-missing");
  assert.equal(snapshot.pendingActivation, true);
  assert.equal(snapshot.offlineVerified, false);
  assert.equal(snapshot.readOnly, false);
  assert.doesNotThrow(() => assertLicenseWritable());
});

test("offline: lease vencido pasa a solo lectura y bloquea escrituras", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease({
    paidThrough: iso(NOW - 2 * DAY),
    offlineUntil: iso(NOW - DAY),
    expiresAt: iso(NOW + 10 * DAY)
  });
  const store = await seededStore(lease);

  const online = makeRuntime({ store, prefix: "offline-expired" });
  await online.start({ companyId: COMPANY_ID });

  const offline = makeRuntime({
    store,
    prefix: "offline-expired",
    fetchImpl: offlineFetch,
    getClient: () => null
  });
  const snapshot = await offline.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "expired");
  assert.equal(snapshot.reason, "expired");
  assert.equal(snapshot.readOnly, true);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(() => assertLicenseWritable(), LicenseReadOnlyError);
});

test("offline: plan Gratis opera indefinidamente aunque las fechas estén vencidas", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease({
    planCode: "free",
    billingMonths: 0,
    paidThrough: iso(NOW - 300 * DAY),
    offlineUntil: iso(NOW - 300 * DAY),
    expiresAt: iso(NOW - 300 * DAY)
  });
  const store = await seededStore(lease);

  const online = makeRuntime({ store, prefix: "offline-free" });
  await online.start({ companyId: COMPANY_ID });

  const offline = makeRuntime({
    store,
    prefix: "offline-free",
    fetchImpl: offlineFetch,
    getClient: () => null,
    now: () => NOW + 400 * DAY
  });
  const snapshot = await offline.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "free");
  assert.equal(snapshot.readOnly, false);
  assert.doesNotThrow(() => assertLicenseWritable());
});

/* ------------------- fallos de red durante la renovación ----------------- */

test("fallo transitorio al renovar: se conserva el lease anterior y su evaluación", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const store = await seededStore(lease);

  const runtime = makeRuntime({
    store,
    prefix: "offline-renew",
    getClient: failingClient
  });
  const first = await runtime.start({ companyId: COMPANY_ID });
  assert.equal(first.mode, "active");

  // Segundo refresco sin red: ni el lease ni el estado se degradan.
  const offline = makeRuntime({
    store,
    prefix: "offline-renew",
    fetchImpl: offlineFetch,
    getClient: failingClient,
    now: () => NOW + DAY
  });
  const second = await offline.start({ companyId: COMPANY_ID });

  assert.equal(second.mode, "active");
  assert.equal(second.readOnly, false);
  assert.equal(second.pendingActivation, false);
  assert.deepEqual(await loadLease(store, COMPANY_ID), lease, "el lease guardado no se borra");
  assert.doesNotThrow(() => assertLicenseWritable());
});

/* ---------------- fallos transitorios del almacén local ------------------ */

test("offline: un fallo al leer el lease no muestra «sin verificar» ni lo borra", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const flaky = flakyStore();
  await saveDeviceKey(flaky.store, deviceKey);
  await saveLease(flaky.store, lease, COMPANY_ID);

  // Arranque con red: deja la clave pública anclada en el almacén.
  const online = makeRuntime({ store: flaky.store, prefix: "offline-unreadable" });
  assert.equal((await online.start({ companyId: COMPANY_ID })).mode, "active");

  // Cierre y reapertura sin conexión con IndexedDB fallando al leer el lease.
  flaky.fail.lease = true;
  const offline = makeRuntime({
    store: flaky.store,
    prefix: "offline-unreadable",
    fetchImpl: offlineFetch,
    getClient: () => null
  });
  const snapshot = await offline.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.reason, "storage-error");
  assert.notEqual(snapshot.reason, "lease-missing");
  assert.equal(snapshot.pendingActivation, false, "no es la primera activación del equipo");
  assert.equal(snapshot.readOnly, false);
  assert.doesNotThrow(() => assertLicenseWritable());
  const stored = flaky.data.get(`${LICENSE_STORE_KEYS.leasePrefix}${COMPANY_ID}`) as SignedLease | undefined;
  assert.equal(stored?.leaseId, lease.leaseId, "el lease sigue guardado pese al fallo de lectura");
});

test("offline: un fallo al leer la identidad no genera una clave nueva", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const flaky = flakyStore();
  await saveDeviceKey(flaky.store, deviceKey);
  await saveLease(flaky.store, lease, COMPANY_ID);

  const online = makeRuntime({ store: flaky.store, prefix: "offline-key-unreadable" });
  assert.equal((await online.start({ companyId: COMPANY_ID })).mode, "active");

  flaky.fail.key = LICENSE_STORE_KEYS.deviceKey;
  const offline = makeRuntime({
    store: flaky.store,
    prefix: "offline-key-unreadable",
    fetchImpl: offlineFetch,
    getClient: () => null
  });
  const snapshot = await offline.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.reason, "device-key-unavailable");
  assert.equal(snapshot.pendingActivation, false);
  assert.equal(snapshot.readOnly, false, "un fallo local no bloquea la caja");
  const identity = flaky.data.get(LICENSE_STORE_KEYS.deviceKey) as
    | { fingerprint?: string; privateKey?: unknown }
    | undefined;
  assert.equal(identity?.fingerprint, deviceKey.fingerprint, "la identidad guardada no se reemplaza");
  assert.ok(identity?.privateKey, "la clave privada sigue en disco");
  assert.doesNotThrow(() => assertLicenseWritable());
});

/* --------------------- firma y vínculo no se relajan -------------------- */
test("offline: una firma inválida no se acepta aunque la clave esté anclada", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const store = await seededStore(lease);
  const online = makeRuntime({ store, prefix: "offline-forged" });
  await online.start({ companyId: COMPANY_ID });

  const forged: SignedLease = {
    ...lease,
    signature: (lease.signature[0] === "A" ? "B" : "A") + lease.signature.slice(1)
  };
  await saveLease(store, forged, COMPANY_ID);

  const offline = makeRuntime({
    store,
    prefix: "offline-forged",
    fetchImpl: offlineFetch,
    getClient: () => null
  });
  const snapshot = await offline.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "invalid");
  assert.equal(snapshot.reason, "invalid-signature");
  assert.notEqual(snapshot.mode, "active");
});

test("identidad regenerada: se informa como rotación y el lease no se borra", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const store = await seededStore(lease);
  // Clave anclada de una sesión previa con red.
  const online = makeRuntime({ store, prefix: "offline-rotated" });
  await online.start({ companyId: COMPANY_ID });

  // Perfil copiado a otro equipo: la identidad pública queda, la privada se
  // perdió (no hay copia del llavero) y el runtime genera una clave nueva.
  await store.set(LICENSE_STORE_KEYS.deviceKey, {
    v: 2,
    publicJwk: deviceKey.publicJwk,
    fingerprint: deviceKey.fingerprint
  });

  const offline = makeRuntime({
    store,
    prefix: "offline-rotated",
    fetchImpl: offlineFetch,
    getClient: () => null
  });
  const snapshot = await offline.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "invalid");
  assert.equal(snapshot.reason, "device-key-rotated");
  assert.equal(snapshot.pendingActivation, false, "no es la primera activación");
  assert.equal(snapshot.readOnly, false, "sin bloquear la operación en curso");
  assert.deepEqual(await loadLease(store, COMPANY_ID), lease, "el lease se conserva para reparar");
});
