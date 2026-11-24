import test from "node:test";
import assert from "node:assert/strict";

import {
  createIndexedDbSecureStore,
  createMemorySecureStore,
  createSecureStore,
  getDefaultSecureStore,
  readDesktopSecureBridge,
  sanitizeSecureKey,
  secureStoreAsKeyValue,
  setDefaultSecureStore,
  type SecureStoreBridge,
  type SecureStoreBridgeResult,
  type SecureStringStore
} from "../../src/services/license/secureStore";
import {
  createMemoryLicenseStore,
  loadDeviceKey,
  saveDeviceKey
} from "../../src/services/license/storage";
import { createDeviceKey, fingerprintFromPublicJwk } from "../../src/services/license/deviceKey";

function fakeBridge(behavior: {
  available?: boolean;
  failSet?: boolean;
  failGet?: boolean;
}): SecureStoreBridge & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const unavailable: SecureStoreBridgeResult = {
    ok: false,
    unavailable: true,
    error: "sin llavero"
  };
  return {
    data,
    async get(key) {
      if (behavior.failGet) throw new Error("puente roto");
      if (behavior.available === false) return unavailable;
      return { ok: true, value: data.has(key) ? (data.get(key) as string) : null };
    },
    async set(key, value) {
      if (behavior.failSet) return { ok: false, error: "no se pudo cifrar" };
      if (behavior.available === false) return unavailable;
      data.set(key, value);
      return { ok: true, value: null };
    },
    async delete(key) {
      if (behavior.available === false) return unavailable;
      data.delete(key);
      return { ok: true, value: null };
    }
  };
}

function memoryFallback(atRestEncryption = false): SecureStringStore {
  return createMemorySecureStore({}, { atRestEncryption });
}

test("con safeStorage disponible se usa el puente y se marca cifrado en reposo", async () => {
  const bridge = fakeBridge({ available: true });
  const store = createSecureStore({ bridge, fallback: memoryFallback() });

  assert.equal(await store.set("license-device-key", "secreto-1"), true);
  assert.equal(await store.get("license-device-key"), "secreto-1");
  assert.equal(store.kind, "electron");
  assert.equal(store.atRestEncryption, true);
  assert.equal(bridge.data.get("license-device-key"), "secreto-1");

  await store.delete("license-device-key");
  assert.equal(await store.get("license-device-key"), null);
  assert.equal(bridge.data.size, 0);
});

test("sin backend del sistema degrada a IndexedDB/memoria sin lanzar", async () => {
  const bridge = fakeBridge({ available: false });
  const fallback = memoryFallback();
  const store = createSecureStore({ bridge, fallback });

  assert.equal(await store.set("license-lease", "valor"), true);
  assert.equal(await store.get("license-lease"), "valor");
  assert.equal(store.kind, "memory");
  assert.equal(store.atRestEncryption, false);
  assert.equal(bridge.data.size, 0);
});

test("si el puente falla a mitad de escritura se cae al respaldo local", async () => {
  const bridge = fakeBridge({ available: true, failSet: true });
  const fallback = memoryFallback();
  const store = createSecureStore({ bridge, fallback });

  assert.equal(await store.set("license-lease", "valor-2"), true);
  assert.equal(await store.get("license-lease"), "valor-2");
});

test("un puente que lanza en get no rompe la lectura", async () => {
  const bridge = fakeBridge({ failGet: true });
  const fallback = memoryFallback();
  await fallback.set("license-lease", "respaldo");
  const store = createSecureStore({ bridge, fallback });

  assert.equal(await store.get("license-lease"), "respaldo");
});

test("claves y valores inválidos se rechazan", async () => {
  const store = createMemorySecureStore();
  assert.equal(sanitizeSecureKey("licencia:v1"), "licencia:v1");
  assert.equal(sanitizeSecureKey("../escape"), null);
  assert.equal(sanitizeSecureKey(""), null);
  assert.equal(sanitizeSecureKey("x".repeat(200)), null);
  assert.equal(await store.set("../escape", "valor"), false);
  assert.equal(await store.get("../escape"), null);
});

test("el fallback de IndexedDB queda inerte sin factory y no lanza", async () => {
  const store = createIndexedDbSecureStore();
  assert.equal(await store.get("license-device-key"), null);
  assert.equal(await store.set("license-device-key", "x"), true);
  await store.delete("license-device-key");
});

test("readDesktopSecureBridge devuelve null fuera de Electron", () => {
  assert.equal(readDesktopSecureBridge(), null);
});

test("secureStoreAsKeyValue solo transporta texto", async () => {
  const store = createMemorySecureStore();
  const kv = secureStoreAsKeyValue(store);
  await kv.set("a", "texto");
  await kv.set("b", { no: "texto" });
  assert.equal(await kv.get("a"), "texto");
  assert.equal(await kv.get("b"), null);
  await kv.delete("a");
  assert.equal(await kv.get("a"), null);
});

test("Linux sin llavero (basic_text) responde unavailable y degrada sin escribir en el puente", async () => {
  // Mismo resultado que devuelve main.electron.cjs cuando Electron solo ofrece
  // `basic_text`: nunca se guarda un secreto en claro en el disco del sistema.
  let probes = 0;
  let writes = 0;
  const bridge: SecureStoreBridge = {
    async get() {
      probes += 1;
      return { ok: false, unavailable: true, error: "Linux sin llavero (basic_text)." };
    },
    async set() {
      writes += 1;
      return { ok: false, unavailable: true, error: "Linux sin llavero (basic_text)." };
    },
    async delete() {
      writes += 1;
      return { ok: false, unavailable: true, error: "Linux sin llavero (basic_text)." };
    }
  };
  const fallback = createMemorySecureStore();
  const store = createSecureStore({ bridge, fallback });

  assert.equal(await store.set("license-lease", "valor-linux"), true);
  assert.equal(await store.get("license-lease"), "valor-linux");
  assert.equal(store.kind, "memory");
  assert.equal(await store.isEncryptionActive(), false);
  assert.equal(writes, 0);
  // La degradación se recuerda: no se vuelve a sondear el llavero en cada lectura.
  assert.equal(await store.get("license-lease"), "valor-linux");
  assert.equal(probes, 1);
});

test("una sonda que lanza deja el almacén degradado y nunca bloquea", async () => {
  let calls = 0;
  const bridge: SecureStoreBridge = {
    async get() {
      calls += 1;
      throw new Error("llavero bloqueado");
    },
    async set() {
      calls += 1;
      throw new Error("llavero bloqueado");
    },
    async delete() {
      calls += 1;
      throw new Error("llavero bloqueado");
    }
  };
  const fallback = createMemorySecureStore();
  const store = createSecureStore({ bridge, fallback });

  assert.equal(await store.set("license-device-key", "respaldo-local"), true);
  assert.equal(await store.get("license-device-key"), "respaldo-local");
  assert.equal(store.kind, "memory");
  assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ */
/* Integración con la identidad del dispositivo                        */
/* ------------------------------------------------------------------ */

test("saveDeviceKey guarda una copia cifrada recuperable si la clave es exportable", async () => {
  const secure = createMemorySecureStore({}, { atRestEncryption: true });
  setDefaultSecureStore(secure);
  try {
    // Par equivalente a `createDeviceKey` pero exportable, como en migraciones.
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify"
    ])) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    );
    const fingerprint = await fingerprintFromPublicJwk(publicJwk);

    const licenseStore = createMemoryLicenseStore();
    await saveDeviceKey(licenseStore, { publicJwk, privateKey, fingerprint });

    const stored = await secure.get("license-device-key");
    assert.ok(stored);
    const record = JSON.parse(stored) as { v: number; fingerprint: string; privateJwk?: { d?: string } };
    assert.equal(record.v, 1);
    assert.equal(record.fingerprint, fingerprint);
    assert.equal(typeof record.privateJwk?.d, "string");

    // Sin el registro estructurado, la identidad se reconstruye desde el secure store.
    const recovered = await loadDeviceKey(createMemoryLicenseStore());
    assert.ok(recovered);
    assert.equal(recovered!.fingerprint, fingerprint);
    assert.equal(recovered!.privateKey.extractable, false);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      recovered!.privateKey,
      new TextEncoder().encode("tras-perder-indexeddb")
    );
    assert.ok(signature.byteLength > 0);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("una clave no extraíble no filtra material privado y sigue cargando", async () => {
  const secure = createMemorySecureStore({}, { atRestEncryption: true });
  setDefaultSecureStore(secure);
  try {
    const key = await createDeviceKey();
    const licenseStore = createMemoryLicenseStore();
    await saveDeviceKey(licenseStore, key);

    const stored = await secure.get("license-device-key");
    assert.ok(stored);
    const record = JSON.parse(stored) as { fingerprint: string; privateJwk?: unknown };
    assert.equal(record.fingerprint, key.fingerprint);
    assert.equal(record.privateJwk, undefined);

    // El registro estructurado sigue siendo la fuente de verdad.
    const loaded = await loadDeviceKey(licenseStore);
    assert.ok(loaded);
    assert.equal(loaded!.fingerprint, key.fingerprint);
    assert.equal(loaded!.privateKey.extractable, false);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("sin cifrado en reposo no se duplica la identidad en el secure store", async () => {
  const secure = createMemorySecureStore();
  setDefaultSecureStore(secure);
  try {
    const key = await createDeviceKey();
    await saveDeviceKey(createMemoryLicenseStore(), key);
    assert.equal(await secure.get("license-device-key"), null);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("un registro seguro con huella manipulada se descarta", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify"
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const secure = createMemorySecureStore(
    {
      "license-device-key": JSON.stringify({
        v: 1,
        // Huella que no corresponde a la pública: debe rechazarse.
        fingerprint: "A".repeat(43),
        publicJwk,
        privateJwk
      })
    },
    { atRestEncryption: true }
  );
  setDefaultSecureStore(secure);
  try {
    const licenseStore = createMemoryLicenseStore();
    assert.equal(await loadDeviceKey(licenseStore), null);
  } finally {
    setDefaultSecureStore(null);
  }
});

test("getDefaultSecureStore es estable y tolerante", async () => {
  setDefaultSecureStore(null);
  const first = getDefaultSecureStore();
  assert.equal(getDefaultSecureStore(), first);
  assert.equal(await first.get("license-device-key"), null);
});
