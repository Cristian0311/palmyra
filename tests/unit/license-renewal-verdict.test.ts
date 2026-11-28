import test from "node:test";
import assert from "node:assert/strict";
import { leaseSigningInput, toBase64Url } from "../../src/services/license/contract";
import type { LeasePayloadV1, SignedLease } from "../../src/services/license/contract";
import { createDeviceKey } from "../../src/services/license/deviceKey";
import {
  createMemoryLicenseStore,
  saveDeviceKey,
  saveLease,
  loadLease
} from "../../src/services/license/storage";
import { createLicenseRuntime } from "../../src/services/license/runtime";
import type {
  LicenseFetch,
  LicenseRuntimeClient,
  LicenseSnapshot
} from "../../src/services/license/runtime";
import {
  assertLicenseWritable,
  isLicenseReadOnly,
  setLicenseReadOnly
} from "../../src/services/license/guard";
import { resetLeaseRevocationCache } from "../../src/services/license/revocation";

/**
 * Regresión reportada por el dueño: «inicié sesión en un dispositivo y, al
 * entrar, mi cuenta y mi plan se verifican, pero al cabo de 20 segundos la app
 * pasa a solo lectura sin que yo haga nada».
 *
 * Causa: el lease renovado se emite DURANTE la pasada de licencia (viaja en la
 * respuesta de `issue-lease`), pero se evaluaba con la marca de tiempo leída
 * antes de la petición de red (`atMs`). El servidor firma `notBefore` = hora de
 * emisión, así que `atMs < notBefore` y la evaluación respondía «todavía no
 * vigente» (`invalid` + `readOnly`), justo después de haber publicado el plan
 * verificado y escribible de la primera pasada.
 */

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
/** Latencia de la Edge Function: lo que el dueño percibió como «20 segundos». */
const ROUND_TRIP_MS = 20_000;
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
    leaseId: `lease-renovacion-${leaseSeq}`,
    companyId: COMPANY_ID,
    deviceId: "equipo-test",
    devicePubKeyFp: deviceKey.fingerprint,
    planCode: "growth",
    billingMonths: 1,
    limits: { warehouses: 3 },
    featureKeys: ["pos", "transfers"],
    storageMode: "cloud",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - 13 * HOUR),
    notBefore: iso(NOW - 13 * HOUR),
    expiresAt: iso(NOW + 40 * DAY),
    offlineUntil: iso(NOW + 20 * DAY),
    graceDays: 5,
    maxOfflineDays: 35,
    serverTimeAnchor: iso(NOW - 13 * HOUR),
    seq: leaseSeq,
    keyId: "test-key",
    ...overrides
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    serverKeys.privateKey,
    new TextEncoder().encode(leaseSigningInput({ ...payload, signature: "", signatureAlg: "ES256" }))
  );
  return { ...payload, signature: toBase64Url(signature), signatureAlg: "ES256" };
}

const keyFetch: LicenseFetch = async () =>
  new Response(JSON.stringify({ keyId: "test-key", jwk: serverPublicJwk }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

function clientWithSession(invoke: () => Promise<{ data: unknown; error: unknown }>) {
  const client: LicenseRuntimeClient = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: "token-de-prueba" } }, error: null };
      }
    },
    functions: { invoke }
  };
  return client;
}

function makeRuntime(args: {
  store: ReturnType<typeof createMemoryLicenseStore>;
  now: () => number;
  client?: LicenseRuntimeClient;
  prefix: string;
}) {
  return createLicenseRuntime({
    store: args.store,
    fetchImpl: keyFetch,
    now: args.now,
    getClient: () => args.client ?? null,
    storageKeyPrefix: args.prefix,
    bundledPublicKey: null
  });
}

/* ------------------------------------------------------------------ */
/* El caso del dueño: verificado y, 20 s después, solo lectura         */
/* ------------------------------------------------------------------ */

test("el lease renovado durante la pasada no deja la app en solo lectura 20 s después", async () => {
  setLicenseReadOnly(false);
  resetLeaseRevocationCache();
  // El lease guardado tiene 13 h: la pasada decide renovarlo (LEASE_MAX_AGE_MS)
  // y la respuesta del servidor llega 20 s más tarde, ya emitida «en el futuro»
  // respecto del instante en que arrancó la evaluación.
  const store = createMemoryLicenseStore();
  await saveDeviceKey(store, deviceKey);
  await saveLease(store, await makeLease(), COMPANY_ID);

  const issuedAt = NOW + ROUND_TRIP_MS;
  const renewed = await makeLease({
    issuedAt: iso(issuedAt),
    notBefore: iso(issuedAt),
    serverTimeAnchor: iso(issuedAt)
  });

  let clock = NOW;
  const client = clientWithSession(async () => {
    // La red tarda: el servidor firma con SU hora, posterior a `atMs`.
    clock = NOW + ROUND_TRIP_MS;
    return { data: { lease: renewed }, error: null };
  });

  const runtime = makeRuntime({ store, now: () => clock, client, prefix: "renovacion-20s" });
  const published: LicenseSnapshot[] = [];
  runtime.subscribe((next) => published.push(next));

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  // Primera pasada (solo con lo que hay en disco): el plan ya se verifica.
  assert.equal(published[0].mode, "active");
  assert.equal(published[0].readOnly, false);
  assert.equal(published[0].planCode, "growth");

  // Ninguna publicación de la pasada puede retirar la escritura: el lease que
  // llega del servidor está firmado y vigente desde su propia emisión.
  const degraded = published.filter((entry) => entry.readOnly);
  assert.deepEqual(
    degraded.map((entry) => `${entry.mode}:${entry.reason}`),
    [],
    "una licencia verificada no puede pasar a solo lectura sola"
  );

  assert.equal(snapshot.mode, "active", "el lease recién emitido está vigente");
  assert.equal(snapshot.reason, "valid");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.planCode, "growth");
  assert.deepEqual(await loadLease(store, COMPANY_ID), renewed, "el lease se adopta");
  assert.equal(isLicenseReadOnly(), false);
  assert.doesNotThrow(() => assertLicenseWritable());
  setLicenseReadOnly(false);
});

test("un reloj 20 s atrás del servidor no convierte un lease vigente en solo lectura", async () => {
  setLicenseReadOnly(false);
  resetLeaseRevocationCache();
  // Equipo recién activado cuyo reloj va 20 s por detrás del servidor: el lease
  // guardado empieza a valer «después» de la hora local, pero está firmado y es
  // el mismo que la nube acaba de emitir. No es un lease futuro sospechoso.
  const store = createMemoryLicenseStore();
  await saveDeviceKey(store, deviceKey);
  await saveLease(
    store,
    await makeLease({
      issuedAt: iso(NOW + ROUND_TRIP_MS),
      notBefore: iso(NOW + ROUND_TRIP_MS),
      serverTimeAnchor: iso(NOW + ROUND_TRIP_MS)
    }),
    COMPANY_ID
  );

  const runtime = makeRuntime({ store, now: () => NOW, prefix: "reloj-20s" });
  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "active");
  assert.equal(snapshot.readOnly, false);
  assert.equal(isLicenseReadOnly(), false);
  assert.doesNotThrow(() => assertLicenseWritable());
  setLicenseReadOnly(false);
});

test("un lease que empieza una hora en el futuro sigue sin ser vigente", async () => {
  setLicenseReadOnly(false);
  resetLeaseRevocationCache();
  // El margen es acotado: no se acepta cualquier lease «del futuro», solo la
  // diferencia normal entre el reloj del equipo y la emisión del servidor.
  const store = createMemoryLicenseStore();
  await saveDeviceKey(store, deviceKey);
  const future = NOW + HOUR;
  await saveLease(
    store,
    await makeLease({
      issuedAt: iso(future),
      notBefore: iso(future),
      serverTimeAnchor: iso(future)
    }),
    COMPANY_ID
  );

  const runtime = makeRuntime({ store, now: () => NOW, prefix: "reloj-futuro" });
  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "invalid");
  assert.equal(snapshot.reason, "not-yet-valid");
  setLicenseReadOnly(false);
});
