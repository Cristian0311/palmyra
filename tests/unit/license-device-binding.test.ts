import test from "node:test";
import assert from "node:assert/strict";

import { createDeviceKey, fingerprintFromPublicJwk } from "../../src/services/license/deviceKey";
import {
  LICENSE_SECURE_KEYS,
  LICENSE_STORE_KEYS,
  clearLease,
  createMemoryLicenseStore,
  getDeviceIdentityReport,
  loadDeviceKey,
  loadLease,
  saveDeviceKey,
  saveLease
} from "../../src/services/license/storage";
import {
  createMemorySecureStore,
  createNativeKeystoreSecureStore,
  createSecureStore,
  setDefaultSecureStore,
  type SecureStoreBridge,
  type SecureStoreBridgeResult,
  type SecureStringStore
} from "../../src/services/license/secureStore";
import { LICENSE_SIGNATURE_ALG, LICENSE_VERSION, type SignedLease } from "../../src/services/license/contract";

/**
 * Identidad criptográfica ligada al sistema operativo.
 *
 * Escenario central: la clave privada se sella con el llavero del SO
 * (safeStorage / Android Keystore). Copiar la carpeta del perfil a otro equipo
 * deja el registro estructurado (pública y huella) y, como mucho, un sobre que
 * esa otra máquina no puede descifrar: la identidad NO se reproduce.
 */

const COMPANY_A = "11111111-1111-4111-8111-111111111111";

function memoryFallback(atRestEncryption = false): SecureStringStore {
  return createMemorySecureStore({}, { atRestEncryption });
}

function unavailableBridge(): SecureStoreBridge & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const unavailable: SecureStoreBridgeResult = {
    ok: false,
    unavailable: true,
    error: "El llavero de este equipo no puede descifrar el sobre."
  };
  return {
    data,
    async get() {
      return unavailable;
    },
    async set() {
      return unavailable;
    },
    async delete() {
      return unavailable;
    }
  };
}

async function verifiesWith(publicJwk: JsonWebKey, privateKey: CryptoKey): Promise<boolean> {
  const data = new TextEncoder().encode("lease-canónico");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, data);
}

test("con llavero la identidad se sella y el registro estructurado no lleva la clave", async () => {
  const secure = memoryFallback(true);
  setDefaultSecureStore(secure);
  try {
    const store = createMemoryLicenseStore();
    const key = await createDeviceKey();
    await saveDeviceKey(store, key);

    const structured = (await store.get(LICENSE_STORE_KEYS.deviceKey)) as Record<string, unknown> | null;
    assert.ok(structured);
    assert.equal(structured!.v, 2);
    assert.equal(structured!.fingerprint, key.fingerprint);
    // Sin CryptoKey: copiar este registro a otro equipo no da una identidad.
    assert.equal(structured!.privateKey, undefined);

    const sealed = await secure.get(LICENSE_SECURE_KEYS.deviceKey);
    assert.ok(sealed);
    const record = JSON.parse(sealed as string) as { v: number; privateJwk?: unknown; sealedPrivate?: unknown };
    assert.equal(record.v, 2);
    assert.equal(record.privateJwk, undefined);
    assert.ok(record.sealedPrivate);

    const loaded = await loadDeviceKey(store);
    assert.ok(loaded);
    assert.equal(loaded!.fingerprint, key.fingerprint);
    assert.equal(loaded!.privateKey.extractable, false);
    assert.deepEqual(loaded!.publicJwk, key.publicJwk);
    assert.equal(await verifiesWith(loaded!.publicJwk, loaded!.privateKey), true);
    assert.equal(await fingerprintFromPublicJwk(loaded!.publicJwk), key.fingerprint);

    const report = getDeviceIdentityReport();
    assert.equal(report.bound, true);
    assert.equal(report.source, "os-store");
  } finally {
    setDefaultSecureStore(null);
  }
});

test("copiar la carpeta a otro equipo no reproduce la identidad", async () => {
  const originSecure = memoryFallback(true);
  setDefaultSecureStore(originSecure);
  let copied: Record<string, unknown> | null = null;
  let fingerprint = "";
  let sealedBlob = "";
  try {
    const origin = createMemoryLicenseStore();
    const key = await createDeviceKey();
    fingerprint = key.fingerprint;
    await saveDeviceKey(origin, key);
    // Lo que viajaría al copiar `%APPDATA%\palmyra`: el registro estructurado
    // y el archivo con el sobre cifrado por DPAPI/Keystore.
    copied = (await origin.get(LICENSE_STORE_KEYS.deviceKey)) as Record<string, unknown> | null;
    sealedBlob = (await originSecure.get(LICENSE_SECURE_KEYS.deviceKey)) ?? "";
    assert.ok(copied && sealedBlob);

    // En la máquina original la identidad se recupera con normalidad.
    const local = await loadDeviceKey(origin);
    assert.equal(local?.fingerprint, fingerprint);
  } finally {
    setDefaultSecureStore(null);
  }

  // Otro PC: mismo registro copiado y el sobre presente, pero el llavero de esa
  // máquina no puede descifrarlo (safeStorage/DPAPI es por máquina y usuario).
  const otherPcSecure = createSecureStore({
    bridge: unavailableBridge(),
    fallback: memoryFallback()
  });
  setDefaultSecureStore(otherPcSecure);
  try {
    assert.notEqual(sealedBlob, "");
    const cloned = createMemoryLicenseStore();
    await cloned.set(LICENSE_STORE_KEYS.deviceKey, copied);
    // El sobre no se puede leer: el almacén no lo entrega y se degrada.
    assert.equal(await otherPcSecure.get(LICENSE_SECURE_KEYS.deviceKey), null);

    assert.equal(await loadDeviceKey(cloned), null);
    const report = getDeviceIdentityReport();
    assert.equal(report.bound, false);
    assert.notEqual(report.source, "os-store");
  } finally {
    setDefaultSecureStore(null);
  }
});

test("sin llavero se mantiene la CryptoKey no extraíble en el perfil (navegador/PWA)", async () => {
  const secure = memoryFallback();
  setDefaultSecureStore(secure);
  try {
    const store = createMemoryLicenseStore();
    const key = await createDeviceKey();
    await saveDeviceKey(store, key);

    const structured = (await store.get(LICENSE_STORE_KEYS.deviceKey)) as Record<string, unknown> | null;
    assert.ok(structured);
    assert.equal(structured!.privateKey, key.privateKey);
    assert.equal(await secure.get(LICENSE_SECURE_KEYS.deviceKey), null);

    const loaded = await loadDeviceKey(store);
    assert.ok(loaded);
    assert.equal(loaded!.fingerprint, key.fingerprint);
    assert.equal(loaded!.privateKey.extractable, false);
    assert.equal(getDeviceIdentityReport().bound, false);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("un sobre corrupto, ajeno o manipulado no lanza y se descarta", async () => {
  const store = createMemoryLicenseStore();
  const secure = memoryFallback(true);
  setDefaultSecureStore(secure);
  try {
    const key = await createDeviceKey();
    await saveDeviceKey(store, key);

    const cases = [
      "no-es-json",
      "null",
      JSON.stringify({ v: 2, fingerprint: key.fingerprint, publicJwk: key.publicJwk }),
      JSON.stringify({ v: 9, fingerprint: key.fingerprint, publicJwk: key.publicJwk, sealedPrivate: {} }),
      // Sobre con la privada de OTRA pareja (x/y no coincide con la pública).
      JSON.stringify({
        v: 2,
        fingerprint: key.fingerprint,
        publicJwk: key.publicJwk,
        sealedPrivate: {
          alg: "ES256",
          privateJwk: { kty: "EC", crv: "P-256", x: "aW50cnVzby1pbnRlbnRv", y: "aW50cnVzby1pbnRlbnRv", d: "c2VjcmV0bw" }
        }
      })
    ];

    for (const value of cases) {
      await secure.set(LICENSE_SECURE_KEYS.deviceKey, value);
      assert.equal(await loadDeviceKey(store), null);
    }

    // Y no deja basura que impida volver a guardar la identidad buena.
    await saveDeviceKey(store, key);
    const recovered = await loadDeviceKey(store);
    assert.ok(recovered);
    assert.equal(recovered!.fingerprint, key.fingerprint);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("un puente que lanza no rompe el arranque: se guarda la identidad del perfil", async () => {
  const throwingBridge: SecureStoreBridge = {
    async get() {
      throw new Error("llavero bloqueado");
    },
    async set() {
      throw new Error("llavero bloqueado");
    },
    async delete() {
      throw new Error("llavero bloqueado");
    }
  };
  const store = createMemoryLicenseStore();
  setDefaultSecureStore(createSecureStore({ bridge: throwingBridge, fallback: memoryFallback() }));
  try {
    const key = await createDeviceKey();
    await saveDeviceKey(store, key);
    const loaded = await loadDeviceKey(store);
    assert.ok(loaded);
    assert.equal(loaded!.fingerprint, key.fingerprint);
    assert.equal(getDeviceIdentityReport().bound, false);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("el Keystore del APK sella la identidad y solo el sobre llega al almacén", async () => {
  const sealing = {
    async seal(text: string) {
      return `gcm:${text}`;
    },
    async open(envelope: string) {
      return envelope.startsWith("gcm:") ? envelope.slice(4) : null;
    }
  };
  const backing = createMemorySecureStore();
  const keystore = createNativeKeystoreSecureStore({ engine: sealing, backing });

  assert.equal(keystore.kind, "keystore");
  assert.equal(await keystore.isEncryptionActive(), true);
  assert.equal(await keystore.set("license-device-key", "sobre-en-claro"), true);

  // Lo persistido es el sobre, nunca el texto.
  const persisted = await backing.get("license-device-key");
  assert.equal(persisted, "gcm:sobre-en-claro");
  assert.equal(await keystore.get("license-device-key"), "sobre-en-claro");

  // Otra tableta no puede abrir el sobre: devuelve null, no lanza.
  const foreign = createNativeKeystoreSecureStore({
    engine: { async seal() { return "gcm:x"; }, async open() { return null; } },
    backing
  });
  assert.equal(await foreign.get("license-device-key"), null);

  // Keystore roto: se declara sin cifrado y no escribe nada.
  const broken = createNativeKeystoreSecureStore({
    engine: {
      async seal() {
        throw new Error("keystore roto");
      },
      async open() {
        throw new Error("keystore roto");
      }
    },
    backing: createMemorySecureStore()
  });
  assert.equal(await broken.isEncryptionActive(), false);
  assert.equal(await broken.set("license-device-key", "x"), false);
  assert.equal(await broken.get("license-device-key"), null);
});

test("el lease se duplica cifrado por el llavero y se recupera si falta el primario", async () => {
  const secure = memoryFallback(true);
  setDefaultSecureStore(secure);
  try {
    const store = createMemoryLicenseStore();
    const lease: SignedLease = {
      v: LICENSE_VERSION,
      leaseId: "lease-1",
      companyId: COMPANY_A,
      deviceId: "device-1",
      devicePubKeyFp: "fp-de-prueba",
      planCode: "starter",
      billingMonths: 1,
      limits: { users: 3 },
      featureKeys: ["pos"],
      storageMode: "hybrid",
      paidThrough: "2026-12-31T23:59:59.000Z",
      issuedAt: "2026-11-01T00:00:00.000Z",
      notBefore: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-31T23:59:59.000Z",
      offlineUntil: "2026-12-20T23:59:59.000Z",
      graceDays: 7,
      maxOfflineDays: 30,
      serverTimeAnchor: "2026-11-01T00:00:00.000Z",
      seq: 1,
      keyId: "key-2026-11",
      signature: "firma-base64url",
      signatureAlg: LICENSE_SIGNATURE_ALG
    };

    await saveLease(store, lease, COMPANY_A);
    assert.equal(await secure.get(LICENSE_SECURE_KEYS.leasePrefix + COMPANY_A), JSON.stringify(lease));

    // Se pierde el registro primario (limpieza del perfil): la copia cifrada sirve.
    await store.delete(LICENSE_STORE_KEYS.leasePrefix + encodeURIComponent(COMPANY_A));
    const recovered = await loadLease(store, COMPANY_A);
    assert.deepEqual(recovered, lease);

    // Borrar el lease limpia también la copia cifrada.
    await saveLease(store, lease, COMPANY_A);
    await clearLease(store, COMPANY_A);
    assert.equal(await loadLease(store, COMPANY_A), null);
    assert.equal(await secure.get(LICENSE_SECURE_KEYS.leasePrefix + COMPANY_A), null);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("la huella se mantiene estable entre recargas y publicaciones nuevas", async () => {
  const secure = memoryFallback(true);
  setDefaultSecureStore(secure);
  try {
    const store = createMemoryLicenseStore();
    const key = await createDeviceKey();
    await saveDeviceKey(store, key);

    const first = await loadDeviceKey(store);
    const second = await loadDeviceKey(store);
    assert.ok(first && second);
    assert.equal(first!.fingerprint, second!.fingerprint);
    assert.deepEqual(first!.publicJwk, second!.publicJwk);

    // Una identidad nueva sí cambia de huella.
    const another = await createDeviceKey();
    assert.notEqual(another.fingerprint, key.fingerprint);
  } finally {
    setDefaultSecureStore(null);
  }
});
