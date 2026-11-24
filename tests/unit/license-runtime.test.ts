import test from "node:test";
import assert from "node:assert/strict";
import { leaseSigningInput, toBase64Url } from "../../src/services/license/contract";
import type { LeasePayloadV1, SignedLease } from "../../src/services/license/contract";
import { createDeviceKey } from "../../src/services/license/deviceKey";
import {
  createMemoryLicenseStore,
  saveDeviceKey,
  saveLease,
  loadLease,
  loadWatermark
} from "../../src/services/license/storage";
import { createLicenseRuntime } from "../../src/services/license/runtime";
import type { LicenseFetch, LicenseRuntimeClient } from "../../src/services/license/runtime";
import {
  assertLicenseWritable,
  isLicenseReadOnly,
  LicenseReadOnlyError,
  setLicenseReadOnly,
  subscribeReadOnly
} from "../../src/services/license/guard";

/**
 * Runtime de licencia: lease real firmado ES256 con WebCrypto de Node, un
 * almacén en memoria y un fetch falso para la clave pública del servidor.
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
    leaseId: `lease-${leaseSeq}`,
    companyId: COMPANY_ID,
    deviceId: "equipo-test",
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
  const signingInput = leaseSigningInput({
    ...payload,
    signature: "",
    signatureAlg: "ES256"
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    serverKeys.privateKey,
    new TextEncoder().encode(signingInput)
  );
  return {
    ...payload,
    signature: toBase64Url(signature),
    signatureAlg: "ES256"
  };
}

function keyFetch(jwk: JsonWebKey = serverPublicJwk): LicenseFetch {
  return async () =>
    new Response(JSON.stringify({ keyId: "test-key", jwk }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
}

function missingKeyFetch(): LicenseFetch {
  return async () =>
    new Response(JSON.stringify({ error: "not_configured" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
}

function sealedStore() {
  const store = createMemoryLicenseStore();
  return store;
}

async function seededStore(lease: SignedLease | null): Promise<ReturnType<typeof createMemoryLicenseStore>> {
  const store = sealedStore();
  await saveDeviceKey(store, deviceKey);
  if (lease) await saveLease(store, lease, COMPANY_ID);
  return store;
}

function makeRuntime(args: {
  store: ReturnType<typeof createMemoryLicenseStore>;
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

function tamperSignature(lease: SignedLease): SignedLease {
  const first = lease.signature[0] === "A" ? "B" : "A";
  return { ...lease, signature: first + lease.signature.slice(1) };
}

/* ------------------------------- estados ------------------------------- */

test("plan Gratis: nunca solo lectura", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(
    await makeLease({
      planCode: "free",
      billingMonths: 0,
      paidThrough: iso(NOW - 200 * DAY),
      offlineUntil: iso(NOW - 200 * DAY),
      expiresAt: iso(NOW - 200 * DAY)
    })
  );
  const runtime = makeRuntime({ store, prefix: "free" });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "free");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.keyConfigured, true);
  assert.equal(snapshot.leasePresent, true);
  assert.equal(snapshot.planCode, "free");
  assert.equal(isLicenseReadOnly(), false);
  assert.doesNotThrow(() => assertLicenseWritable());
});

test("lease vigente: activo y editable", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const store = await seededStore(lease);
  const runtime = makeRuntime({ store, prefix: "active" });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "active");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.reason, "valid");
  assert.equal(snapshot.paidThrough, lease.paidThrough);
  assert.equal(snapshot.offlineUntil, lease.offlineUntil);
  assert.equal(snapshot.expiresAt, lease.expiresAt);
  assert.equal(snapshot.clockWarning, false);
  assert.equal(snapshot.lastCheckedAt, NOW);
  assert.equal(isLicenseReadOnly(), false);
});

test("dentro de la ventana offline: gracia operativa", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(
    await makeLease({
      paidThrough: iso(NOW - 2 * DAY),
      offlineUntil: iso(NOW + 5 * DAY)
    })
  );
  const runtime = makeRuntime({ store, prefix: "grace" });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "grace");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.reason, "grace");
  assert.equal(isLicenseReadOnly(), false);
});

test("lease vencido: solo lectura y la guarda impide escribir", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(
    await makeLease({
      paidThrough: iso(NOW - 10 * DAY),
      offlineUntil: iso(NOW - 2 * DAY)
    })
  );
  const runtime = makeRuntime({ store, prefix: "expired" });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "expired");
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.reason, "expired");
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(
    () => assertLicenseWritable(),
    (error: unknown) =>
      error instanceof LicenseReadOnlyError &&
      error.code === "license_read_only" &&
      error.message ===
        "Tu suscripción venció: la app está en solo lectura. Renueva para seguir vendiendo. Tus datos no se borran."
  );
});

/* ------------------------------ anti-bloqueo ---------------------------- */

test("firma inválida sin evaluación previa: avisa pero no bloquea", async () => {
  setLicenseReadOnly(false);
  const tampered = tamperSignature(await makeLease());
  const store = await seededStore(tampered);
  const runtime = makeRuntime({ store, prefix: "tampered" });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "invalid");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.reason, "invalid-signature");
  assert.equal(snapshot.keyConfigured, true);
  assert.equal(snapshot.leasePresent, true);
  assert.equal(isLicenseReadOnly(), false);
  assert.doesNotThrow(() => assertLicenseWritable());
});

test("firma inválida tras una evaluación válida: se conserva la anterior", async () => {
  setLicenseReadOnly(false);
  const validLease = await makeLease();
  const store = await seededStore(validLease);
  const runtime = makeRuntime({ store, prefix: "keep-last" });

  const first = await runtime.start({ companyId: COMPANY_ID });
  assert.equal(first.mode, "active");
  assert.equal(first.readOnly, false);

  await saveLease(store, tamperSignature(validLease), COMPANY_ID);
  const second = await runtime.refresh();

  assert.equal(second.mode, "active");
  assert.equal(second.readOnly, false);
  assert.equal(second.planCode, "growth");
  assert.equal(second.lastCheckedAt, NOW);
});

test("sin clave pública configurada: unmanaged sin bloquear", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(await makeLease());
  const runtime = makeRuntime({ store, fetchImpl: missingKeyFetch(), prefix: "unmanaged" });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "unmanaged");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.keyConfigured, false);
  assert.equal(snapshot.reason, "license-key-missing");
  assert.equal(isLicenseReadOnly(), false);
});

test("clave configurada pero sin lease: no bloquea la primera sincronización", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(null);
  const runtime = makeRuntime({ store, prefix: "no-lease" });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "unmanaged");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.keyConfigured, true);
  assert.equal(snapshot.leasePresent, false);
  assert.equal(snapshot.reason, "lease-missing");
  assert.equal(isLicenseReadOnly(), false);
});

test("fallo de red: conserva el último snapshot y no degrada a solo lectura", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(await makeLease());
  let networkDown = false;
  const runtime = makeRuntime({
    store,
    prefix: "network",
    fetchImpl: async () => {
      if (networkDown) throw new TypeError("network down");
      return keyFetch()("/license-public-key.json");
    }
  });

  const first = await runtime.start({ companyId: COMPANY_ID });
  assert.equal(first.mode, "active");
  assert.equal(first.lastCheckedAt, NOW);

  networkDown = true;
  const second = await runtime.refresh();

  assert.equal(second.mode, "active");
  assert.equal(second.readOnly, false);
  assert.equal(second.lastCheckedAt, NOW);
  assert.equal(isLicenseReadOnly(), false);
});

/* --------------------------------- reloj -------------------------------- */

test("la marca de agua avanza y un reloj atrasado no reabre la ventana", async () => {
  setLicenseReadOnly(false);
  let clock = NOW;
  const store = await seededStore(await makeLease());
  const runtime = makeRuntime({ store, prefix: "watermark", now: () => clock });

  const first = await runtime.start({ companyId: COMPANY_ID });
  assert.equal(first.mode, "active");
  assert.equal(await loadWatermark(store, COMPANY_ID), NOW);

  // Quince días después el pago venció y se está dentro de la ventana offline.
  clock = NOW + 15 * DAY;
  const second = await runtime.refresh();
  assert.equal(second.mode, "grace");
  assert.equal(second.clockWarning, false);
  const advanced = await loadWatermark(store, COMPANY_ID);
  assert.equal(advanced, NOW + 15 * DAY);

  // El usuario atrasa el reloj: con el reloj crudo volvería a «active», pero la
  // marca de agua congela la evaluación en gracia y la guarda marca la
  // manipulación en solo lectura hasta que el reloj vuelva a ser coherente.
  clock = NOW + 1 * DAY;
  const third = await runtime.refresh();
  assert.equal(third.mode, "grace");
  assert.equal(third.clockWarning, true);
  assert.equal(third.readOnly, true);
  assert.equal(await loadWatermark(store, COMPANY_ID), NOW + 15 * DAY);
});

/* ------------------------------- renovación ----------------------------- */

test("sin lease y con sesión: invoca issue-lease y persiste el lease verificado", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(null);
  const freshLease = await makeLease();
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];

  const client: LicenseRuntimeClient = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: "token-de-prueba" } }, error: null };
      }
    },
    functions: {
      async invoke(name, options) {
        calls.push({ name, body: options.body });
        return { data: { lease: freshLease }, error: null };
      }
    }
  };

  const runtime = makeRuntime({
    store,
    prefix: "renew",
    getClient: () => client
  });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "issue-lease");
  assert.equal(calls[0].body.companyId, COMPANY_ID);
  assert.equal(calls[0].body.devicePubKeyFp, deviceKey.fingerprint);
  assert.equal(typeof calls[0].body.deviceId, "string");
  assert.ok((calls[0].body.deviceId as string).length > 0);
  assert.equal(snapshot.mode, "active");
  assert.deepEqual(await loadLease(store, COMPANY_ID), freshLease);
});

/* ------------------------- errores de activación ------------------------ */

test("sin sesión y sin lease: publica activationError no-session al concluir", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(null);
  let invoked = 0;
  const client: LicenseRuntimeClient = {
    auth: {
      async getSession() {
        return { data: { session: null }, error: null };
      }
    },
    functions: {
      async invoke() {
        invoked += 1;
        return { data: null, error: null };
      }
    }
  };
  const runtime = makeRuntime({ store, prefix: "no-session", getClient: () => client });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "unmanaged");
  assert.equal(snapshot.reason, "lease-missing");
  assert.equal(snapshot.pendingActivation, true);
  assert.equal(snapshot.activationSettled, true);
  assert.equal(snapshot.activationError, "no-session");
  // Sin sesión no se llega a invocar issue-lease.
  assert.equal(invoked, 0);
  assert.equal(isLicenseReadOnly(), false);
});

test("el servidor rechaza 403: publica activationError server-rejected:403:permission_denied", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(null);
  const client: LicenseRuntimeClient = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: "token-de-prueba" } }, error: null };
      }
    },
    functions: {
      async invoke() {
        return { data: null, error: { status: 403, error: "permission_denied" } };
      }
    }
  };
  const runtime = makeRuntime({ store, prefix: "rejected", getClient: () => client });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "unmanaged");
  assert.equal(snapshot.reason, "lease-missing");
  assert.equal(snapshot.activationSettled, true);
  assert.equal(snapshot.activationError, "server-rejected:403:permission_denied");
  assert.equal(isLicenseReadOnly(), false);
});

test("lease adoptado tras renovar: el snapshot no lleva activationError", async () => {
  setLicenseReadOnly(false);
  const store = await seededStore(null);
  const freshLease = await makeLease();
  const client: LicenseRuntimeClient = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: "token-de-prueba" } }, error: null };
      }
    },
    functions: {
      async invoke() {
        return { data: { lease: freshLease }, error: null };
      }
    }
  };
  const runtime = makeRuntime({ store, prefix: "adopted", getClient: () => client });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "active");
  assert.equal(snapshot.leasePresent, true);
  assert.equal(snapshot.pendingActivation, false);
  assert.equal(snapshot.activationError, undefined);
});

/* --------------------------------- guarda ------------------------------- */

test("guarda de solo lectura: notifica cambios y no deja pasar escrituras", () => {
  setLicenseReadOnly(false);
  const seen: boolean[] = [];
  const unsubscribe = subscribeReadOnly((value) => seen.push(value));

  setLicenseReadOnly(true);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(() => assertLicenseWritable(), LicenseReadOnlyError);
  assert.deepEqual(seen, [true]);

  setLicenseReadOnly(true);
  assert.equal(seen.length, 1);

  setLicenseReadOnly(false);
  assert.equal(isLicenseReadOnly(), false);
  assert.doesNotThrow(() => assertLicenseWritable());
  assert.deepEqual(seen, [true, false]);

  unsubscribe();
  setLicenseReadOnly(false);
});

test("cola offline: con solo lectura no encola trabajo nuevo", async () => {
  const { enqueueOfflineItem } = await import("../../src/services/offlineQueue");
  setLicenseReadOnly(true);
  // La guarda es síncrona: la operación se rechaza antes de tocar la cola.
  assert.throws(
    () => enqueueOfflineItem("transaction", { id: "venta-bloqueada" }),
    (error: unknown) => error instanceof LicenseReadOnlyError && error.code === "license_read_only"
  );
  setLicenseReadOnly(false);
});
