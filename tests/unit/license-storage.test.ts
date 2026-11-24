import test from "node:test";
import assert from "node:assert/strict";

import {
  createDeviceKey,
  fingerprintFromPublicJwk
} from "../../src/services/license/deviceKey";
import {
  LICENSE_STORE_KEYS,
  clearLease,
  createMemoryLicenseStore,
  loadDeviceKey,
  loadLease,
  loadWatermark,
  recordServerTime,
  saveDeviceKey,
  saveLease,
  saveWatermark
} from "../../src/services/license/storage";
import {
  LICENSE_SIGNATURE_ALG,
  LICENSE_VERSION,
  type SignedLease
} from "../../src/services/license/contract";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

function makeLease(companyId = COMPANY_A, seq = 1): SignedLease {
  return {
    v: LICENSE_VERSION,
    leaseId: `lease-${seq}`,
    companyId,
    deviceId: "device-1",
    devicePubKeyFp: "fp-de-prueba",
    planCode: "starter",
    billingMonths: 1,
    limits: { users: 3 },
    featureKeys: ["pos", "reports"],
    storageMode: "hybrid",
    paidThrough: "2026-12-31T23:59:59.000Z",
    issuedAt: "2026-11-01T00:00:00.000Z",
    notBefore: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-12-31T23:59:59.000Z",
    offlineUntil: "2026-12-20T23:59:59.000Z",
    graceDays: 7,
    maxOfflineDays: 30,
    serverTimeAnchor: "2026-11-01T00:00:00.000Z",
    seq,
    keyId: "key-2026-11",
    signature: "firma-base64url",
    signatureAlg: LICENSE_SIGNATURE_ALG
  };
}

test("createDeviceKey genera un par P-256 con privada no extraíble y huella estable", async () => {
  const first = await createDeviceKey();
  const second = await createDeviceKey();

  assert.equal(first.privateKey.extractable, false);
  assert.deepEqual(first.privateKey.usages, ["sign"]);
  assert.equal(first.privateKey.type, "private");
  assert.equal(first.publicJwk.kty, "EC");
  assert.equal(first.publicJwk.crv, "P-256");

  // Estable entre llamadas sobre la misma pública y al recomputar desde JWK.
  const recomputed = await fingerprintFromPublicJwk(first.publicJwk);
  assert.equal(recomputed, first.fingerprint);
  assert.equal(await fingerprintFromPublicJwk(first.publicJwk), recomputed);

  // Equipos distintos producen huellas distintas.
  assert.notEqual(first.fingerprint, second.fingerprint);

  // La privada reimportada sirve para firmar y la pública para verificar.
  const data = new TextEncoder().encode("lease-canónico");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    first.privateKey,
    data
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    first.publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
  assert.ok(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      data
    )
  );

  // La huella coincide con el SPKI exportado por separado.
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(first.fingerprint, expected);
});

test("saveDeviceKey/loadDeviceKey conservan la identidad y rechazan registros corruptos", async () => {
  const store = createMemoryLicenseStore();
  assert.equal(await loadDeviceKey(store), null);

  const key = await createDeviceKey();
  await saveDeviceKey(store, key);
  const loaded = await loadDeviceKey(store);

  assert.ok(loaded);
  assert.equal(loaded.fingerprint, key.fingerprint);
  assert.deepEqual(loaded.publicJwk, key.publicJwk);
  assert.equal(loaded.privateKey.extractable, false);
  assert.equal(await fingerprintFromPublicJwk(loaded.publicJwk), key.fingerprint);

  // La privada cargada sigue firmando (no solo se guardó la forma).
  const data = new TextEncoder().encode("tras-recargar");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    loaded.privateKey,
    data
  );
  assert.ok(signature.byteLength > 0);

  // Registros incompletos o con huella inválida se descartan sin lanzar.
  const broken: unknown[] = [
    "no-es-un-objeto",
    { fingerprint: key.fingerprint },
    { publicJwk: key.publicJwk, privateKey: key.privateKey },
    { publicJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" }, privateKey: "x", fingerprint: "corta" }
  ];
  for (const value of broken) {
    await store.set(LICENSE_STORE_KEYS.deviceKey, value);
    assert.equal(await loadDeviceKey(store), null);
  }
});

test("saveLease/loadLease/clearLease aíslan por empresa y descartan lease corrupto", async () => {
  const store = createMemoryLicenseStore();
  const lease = makeLease();

  assert.equal(await loadLease(store, COMPANY_A), null);

  await saveLease(store, lease, COMPANY_A);
  assert.deepEqual(await loadLease(store, COMPANY_A), lease);
  // Otra empresa no ve el lease de A.
  assert.equal(await loadLease(store, COMPANY_B), null);

  await saveLease(store, makeLease(COMPANY_B, 2), COMPANY_B);
  assert.equal((await loadLease(store, COMPANY_B))?.seq, 2);
  assert.equal((await loadLease(store, COMPANY_A))?.seq, 1);

  // Datos alterados sin campos firmados o con forma dudosa: null, sin throw.
  const corrupt = [
    "{json a medias",
    null,
    { v: LICENSE_VERSION, signature: "solo-firma" },
    { ...lease, v: 99 },
    { ...lease, signature: "" },
    { ...lease, expiresAt: "no-es-fecha" },
    { ...lease, companyId: COMPANY_B }
  ];
  for (const value of corrupt) {
    await store.set(LICENSE_STORE_KEYS.leasePrefix + encodeURIComponent(COMPANY_A), value);
    assert.equal(await loadLease(store, COMPANY_A), null);
  }

  await clearLease(store, COMPANY_A);
  assert.equal(await loadLease(store, COMPANY_A), null);
  // Borrar A no toca el lease de B.
  assert.equal((await loadLease(store, COMPANY_B))?.seq, 2);
});

test("la marca de agua del reloj nunca retrocede", async () => {
  const store = createMemoryLicenseStore();
  assert.equal(await loadWatermark(store, COMPANY_A), null);

  await saveWatermark(store, COMPANY_A, 1_000);
  assert.equal(await loadWatermark(store, COMPANY_A), 1_000);

  await saveWatermark(store, COMPANY_A, 2_000);
  assert.equal(await loadWatermark(store, COMPANY_A), 2_000);

  // Intentos de retroceso se ignoran.
  await saveWatermark(store, COMPANY_A, 500);
  await saveWatermark(store, COMPANY_A, 2_000);
  assert.equal(await loadWatermark(store, COMPANY_A), 2_000);

  // Cada empresa lleva su propia marca.
  assert.equal(await loadWatermark(store, COMPANY_B), null);
  await saveWatermark(store, COMPANY_B, 800);
  assert.equal(await loadWatermark(store, COMPANY_B), 800);
  assert.equal(await loadWatermark(store, COMPANY_A), 2_000);

  // Valores no finitos no ensucian el registro.
  await saveWatermark(store, COMPANY_A, Number.NaN);
  await saveWatermark(store, COMPANY_A, -5);
  assert.equal(await loadWatermark(store, COMPANY_A), 2_000);
});

test("recordServerTime toma el máximo entre servidor, reloj local y marca previa", async () => {
  const store = createMemoryLicenseStore();

  // El reloj del servidor manda cuando es mayor que el local.
  assert.equal(await recordServerTime(store, COMPANY_A, 5_000, 3_000), 5_000);
  assert.equal(await loadWatermark(store, COMPANY_A), 5_000);

  // El local manda cuando el ancla del servidor viene atrasada.
  assert.equal(await recordServerTime(store, COMPANY_A, 4_000, 9_000), 9_000);
  assert.equal(await loadWatermark(store, COMPANY_A), 9_000);

  // La marca previa impide que el reloj vuelva a bajar.
  assert.equal(await recordServerTime(store, COMPANY_A, 1_000, 100), 9_000);
  assert.equal(await loadWatermark(store, COMPANY_A), 9_000);

  // Un ancla nueva y mayor avanza la marca.
  assert.equal(await recordServerTime(store, COMPANY_A, 12_000, 10_000), 12_000);
  assert.equal(await loadWatermark(store, COMPANY_A), 12_000);

  // Empresas independientes.
  assert.equal(await recordServerTime(store, COMPANY_B, 7_000, 7_500), 7_500);
  assert.equal(await loadWatermark(store, COMPANY_A), 12_000);
});
