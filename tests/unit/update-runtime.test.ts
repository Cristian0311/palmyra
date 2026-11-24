import test from "node:test";
import assert from "node:assert/strict";
import {
  androidUpdateKindForArtifact,
  createAppUpdateRuntime,
  createRuntimeStorage,
  DEFAULT_UPDATE_MANIFEST_URL,
  getUpdateDeviceId,
  getUpdateManifestUrl,
  getUpdatePlatform,
  getUpdatePublicJwk,
  selectUpdateArtifact,
  UPDATE_CHECK_STORAGE_KEY,
  UPDATE_DEVICE_STORAGE_KEY,
  UPDATE_DISMISSED_STORAGE_KEY
} from "../../src/services/updates/runtime";
import type { UpdateCheckResult, UpdateClient } from "../../src/services/updates/client";
import { parseUpdateManifest, UPDATE_MANIFEST_VERSION } from "../../src/services/updates/manifest";
import type { UpdateManifestV1 } from "../../src/services/updates/manifest";
import { signUpdateManifest } from "../../src/services/updates/verify";

/**
 * Pruebas del runtime de actualizaciones (sin red y sin React).
 *
 * Todo lo del entorno (fetch, reloj, almacenamiento y `window`) se simula por
 * prueba; el manifiesto firmado se genera con una clave ES256 efímera, igual
 * que en update-client.test.ts.
 */

const signingKeys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);
const publicJwk = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const MANIFEST_URL = "https://example.test/releases/update-manifest.json";

interface FakeStorage {
  map: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    }
  };
}

function installLocalStorage(storage: FakeStorage | null): void {
  const target = globalThis as unknown as { localStorage?: unknown };
  if (storage === null) {
    delete target.localStorage;
    return;
  }
  target.localStorage = storage;
}

function installWindow(value: Record<string, unknown> | null): void {
  const target = globalThis as unknown as { window?: unknown };
  if (value === null) {
    delete target.window;
    return;
  }
  target.window = value;
}

function baseManifest(overrides: Partial<UpdateManifestV1> = {}): UpdateManifestV1 {
  return {
    v: UPDATE_MANIFEST_VERSION,
    version: "1.4.0",
    channel: "stable",
    releasedAt: "2026-11-22T00:00:00.000Z",
    rollout: 100,
    notes: "Correcciones de caja y sincronización.",
    artifacts: [
      {
        platform: "windows",
        name: "PALMYRA-POS-Setup.exe",
        url: "https://example.test/releases/PALMYRA-POS-Setup.exe",
        sha256: "b".repeat(64),
        bytes: 98_765_432
      },
      {
        platform: "android",
        name: "PALMYRA-Android.apk",
        url: "https://example.test/releases/PALMYRA-Android.apk",
        sha256: "c".repeat(64),
        bytes: 12_345_678
      },
      {
        platform: "web",
        name: "palmyra-web.zip",
        url: "https://example.test/releases/palmyra-web.zip",
        sha256: "d".repeat(64),
        bytes: 4_000_000
      }
    ],
    ...overrides
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function countingFetch(handler: () => Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return handler();
  }) as typeof fetch;
  return { impl, calls };
}

function fixingClient(
  results: UpdateCheckResult[],
  calls: Array<boolean | undefined> = []
): UpdateClient {
  let index = 0;
  return {
    async check(options?: { force?: boolean }) {
      calls.push(options?.force);
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      return next;
    }
  };
}

function result(status: UpdateCheckResult["status"], checkedAt = NOW, extra: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return { status, code: status as UpdateCheckResult["code"], checkedAt, ...extra };
}

test("getUpdateManifestUrl respeta el entorno y cae al release oficial", () => {
  assert.equal(
    getUpdateManifestUrl("https://cdn.example.test/update-manifest.json"),
    "https://cdn.example.test/update-manifest.json"
  );
  assert.equal(getUpdateManifestUrl("  "), DEFAULT_UPDATE_MANIFEST_URL);
  assert.equal(getUpdateManifestUrl(null), DEFAULT_UPDATE_MANIFEST_URL);
  // Sin import.meta.env (Node/pruebas) se usa el manifiesto del release.
  assert.equal(getUpdateManifestUrl(), DEFAULT_UPDATE_MANIFEST_URL);
  assert.match(DEFAULT_UPDATE_MANIFEST_URL, /^https:\/\/github\.com\//);
});

test("getUpdatePublicJwk solo acepta una JWK pública EC P-256", () => {
  const parsed = getUpdatePublicJwk(JSON.stringify(publicJwk));
  assert.ok(parsed);
  assert.equal(parsed?.kty, "EC");
  assert.equal(parsed?.crv, "P-256");
  assert.equal(parsed?.x, publicJwk.x);
  assert.equal(parsed?.y, publicJwk.y);
  assert.equal((parsed as { d?: unknown }).d, undefined);

  assert.equal(getUpdatePublicJwk(null), null);
  assert.equal(getUpdatePublicJwk(""), null);
  assert.equal(getUpdatePublicJwk("no-es-json"), null);
  assert.equal(getUpdatePublicJwk("{}"), null);
  assert.equal(
    getUpdatePublicJwk(JSON.stringify({ kty: "RSA", n: "abc", e: "AQAB" })),
    null
  );
  // Una JWK que trae la componente privada nunca se usa para verificar.
  assert.equal(
    getUpdatePublicJwk(JSON.stringify({ ...publicJwk, d: "privado" })),
    null
  );
  // Sin entorno Vite se usa la clave pública incrustada en el build.
  const baked = getUpdatePublicJwk();
  assert.ok(baked);
  assert.equal(baked?.kty, "EC");
  assert.equal(baked?.crv, "P-256");
  assert.equal(baked?.kid, "palmyra-stable-2026-11");
  assert.equal((baked as { d?: unknown }).d, undefined);
});

test("getUpdateDeviceId es estable y respeta el identificador guardado", () => {
  const seeded = fakeStorage({ [UPDATE_DEVICE_STORAGE_KEY]: "equipo-fijo-1234" });
  assert.equal(getUpdateDeviceId(seeded), "equipo-fijo-1234");
  assert.equal(getUpdateDeviceId(seeded), "equipo-fijo-1234");
  assert.equal(seeded.map.get(UPDATE_DEVICE_STORAGE_KEY), "equipo-fijo-1234");

  const other = fakeStorage({ [UPDATE_DEVICE_STORAGE_KEY]: "otro-equipo-9999" });
  assert.equal(getUpdateDeviceId(other), "otro-equipo-9999");

  const empty = fakeStorage();
  const first = getUpdateDeviceId(empty);
  const second = getUpdateDeviceId(empty);
  assert.equal(first, second);
  assert.ok(first.length > 0);
  assert.equal(empty.map.get(UPDATE_DEVICE_STORAGE_KEY), first);
});

test("getUpdateDeviceId no lanza con un almacén roto", () => {
  const broken = {
    getItem() {
      throw new Error("sin permisos");
    },
    setItem() {
      throw new Error("sin cuota");
    }
  };
  const value = getUpdateDeviceId(broken);
  assert.equal(typeof value, "string");
  assert.ok(value.length > 0);
});

test("getUpdatePlatform distingue Android, escritorio y navegador", () => {
  installWindow(null);
  assert.equal(getUpdatePlatform(), "web");

  installWindow({ PALMYRA_NATIVE: { getInfo: () => "{}" } });
  assert.equal(getUpdatePlatform(), "android");

  installWindow({ palmyraDesktopUpdate: {} });
  assert.equal(getUpdatePlatform(), "windows");

  installWindow({ palmyraDesktopDb: {} });
  assert.equal(getUpdatePlatform(), "windows");

  installWindow({});
  assert.equal(getUpdatePlatform(), "web");

  installWindow(null);
});

test("selectUpdateArtifact devuelve el artefacto de la plataforma o null", () => {
  const manifest = parseUpdateManifest(baseManifest());

  const android = selectUpdateArtifact(manifest, "android");
  assert.ok(android);
  assert.equal(android?.platform, "android");
  assert.equal(android?.name, "PALMYRA-Android.apk");

  const windows = selectUpdateArtifact(manifest, "windows");
  assert.equal(windows?.platform, "windows");

  const onlyWindows = parseUpdateManifest(
    baseManifest({ artifacts: [baseManifest().artifacts[0]] })
  );
  assert.equal(selectUpdateArtifact(onlyWindows, "android"), null);
  assert.equal(selectUpdateArtifact(null, "android"), null);
  assert.equal(androidUpdateKindForArtifact({ name: "PALMYRA-Android.apk" }), "apk");
  assert.equal(androidUpdateKindForArtifact({ name: "palmyra-web.zip" }), "bundle");
  assert.equal(androidUpdateKindForArtifact(null), "bundle");
});

test("un manifiesto con plataformas repetidas no llega a seleccionarse", () => {
  const duplicated = baseManifest({
    artifacts: [baseManifest().artifacts[0], { ...baseManifest().artifacts[0], name: "otro.exe" }]
  });
  assert.throws(() => parseUpdateManifest(duplicated), /plataforma/i);
});

test("un runtime sin configuración no toca la red", async () => {
  const { impl, calls } = countingFetch(async () => jsonResponse(baseManifest()));

  // La clave incrustada configura el canal, pero crear el runtime no descarga.
  const baked = createAppUpdateRuntime({ fetchImpl: impl, now: () => NOW });
  assert.ok(baked.client);
  assert.equal(baked.state.phase, "idle");
  assert.equal(calls.length, 0);

  // Sin clave pública (canal desactivado) no hay cliente ni red.
  const fromEnv = createAppUpdateRuntime({ publicJwk: null, fetchImpl: impl, now: () => NOW });
  assert.equal(fromEnv.client, null);
  assert.equal(fromEnv.state.phase, "unconfigured");
  assert.match(String(fromEnv.state.error), /canal/i);
  assert.equal(fromEnv.state.manual, false);

  // Un cliente nulo explícito se comporta igual y tampoco descarga.
  const disabled = createAppUpdateRuntime({ client: null, fetchImpl: impl, now: () => NOW });
  const afterManual = await disabled.check(true);
  assert.equal(afterManual.phase, "unconfigured");
  assert.equal(afterManual.manual, true);
  assert.match(String(afterManual.error), /canal/i);

  assert.equal(calls.length, 0);
});

test("un runtime configurado llama al cliente una vez por comprobación forzada", async () => {
  const calls: Array<boolean | undefined> = [];
  const client = fixingClient([result("up-to-date")], calls);
  const runtime = createAppUpdateRuntime({ client, now: () => NOW });

  const first = await runtime.check(true);
  assert.equal(first.phase, "up-to-date");
  assert.equal(first.manual, true);
  assert.equal(first.lastCheckAt, NOW);
  assert.equal(first.artifact, null);

  await runtime.check(true);
  assert.deepEqual(calls, [true, true]);
});

test("el runtime traduce cada estado del cliente a su fase", async () => {
  const cases: Array<[UpdateCheckResult["status"], string]> = [
    ["available", "available"],
    ["up-to-date", "up-to-date"],
    ["blocked", "blocked"],
    ["unverified", "unverified"],
    ["error", "error"]
  ];

  for (const [status, phase] of cases) {
    const client = fixingClient([
      result(status, NOW, status === "error" ? { error: "Sin conexión." } : {})
    ]);
    const runtime = createAppUpdateRuntime({ client, now: () => NOW });
    const next = await runtime.check(true);
    assert.equal(next.phase, phase, status);
    assert.equal(next.result?.status, status, status);
    assert.equal(next.lastCheckAt, NOW, status);
  }
});

test("not-due conserva la fase y la marca de la última comprobación", async () => {
  const client = fixingClient([result("not-due")]);
  const runtime = createAppUpdateRuntime({ client, now: () => NOW });
  const before = runtime.state;
  const after = await runtime.check(false);
  assert.equal(before.phase, "idle");
  assert.equal(after.phase, "idle");
  assert.equal(after.lastCheckAt, null);
  assert.equal(after.manual, false);
});

test("un cliente que lanza se reporta como error sin propagar", async () => {
  const client: UpdateClient = {
    async check() {
      throw new Error("puente roto");
    }
  };
  const runtime = createAppUpdateRuntime({ client, now: () => NOW });
  const next = await runtime.check(true);
  assert.equal(next.phase, "error");
  assert.equal(next.error, "puente roto");
});

test("el manifiesto firmado publica artefacto y notas con una sola descarga", async () => {
  installWindow({});
  installLocalStorage(fakeStorage());
  try {
    const signed = await signUpdateManifest(baseManifest(), signingKeys.privateKey, "clave-2026");
    const { impl, calls } = countingFetch(async () => jsonResponse(signed));
    const runtime = createAppUpdateRuntime({
      manifestUrl: MANIFEST_URL,
      publicJwk,
      fetchImpl: impl,
      now: () => NOW
    });

    const first = await runtime.check(true);
    assert.equal(first.phase, "available");
    assert.equal(first.result?.version, "1.4.0");
    assert.equal(first.artifact?.platform, "web");
    assert.equal(first.artifact?.name, "palmyra-web.zip");
    assert.equal(first.artifact?.sha256, "d".repeat(64));
    assert.match(String(first.notes), /Correcciones de caja/);
    assert.equal(first.platform, "web");
    assert.equal(calls.length, 1);

    // La cadencia de 24 h la impone el cliente: no hay segunda descarga.
    const second = await runtime.check(false);
    assert.equal(second.phase, "available");
    assert.equal(second.lastCheckAt, NOW);
    assert.equal(calls.length, 1);
  } finally {
    installLocalStorage(null);
    installWindow(null);
  }
});

test("una firma que no verifica no publica artefacto", async () => {
  installWindow({});
  try {
    const unsigned = baseManifest();
    const { impl, calls } = countingFetch(async () => jsonResponse(unsigned));
    const runtime = createAppUpdateRuntime({
      manifestUrl: MANIFEST_URL,
      publicJwk,
      fetchImpl: impl,
      now: () => NOW
    });

    const next = await runtime.check(true);
    assert.equal(next.phase, "blocked");
    assert.equal(next.artifact, null);
    assert.equal(calls.length, 1);
  } finally {
    installWindow(null);
  }
});

test("dismiss descarta una versión, avisa a la UI y persiste", () => {
  const storage = fakeStorage();
  installLocalStorage(storage);
  try {
    const runtime = createAppUpdateRuntime({ client: null, now: () => NOW });
    const seen: string[] = [];
    const unsubscribe = runtime.subscribe((state) => seen.push(state.phase));

    assert.equal(runtime.isDismissed("1.4.0"), false);
    runtime.dismiss("  1.4.0  ");
    assert.equal(runtime.isDismissed("1.4.0"), true);
    assert.equal(runtime.isDismissed("1.5.0"), false);
    assert.equal(storage.map.get(UPDATE_DISMISSED_STORAGE_KEY), "1.4.0");
    assert.equal(seen.length, 1);

    // Un runtime nuevo recupera el descarte desde el almacenamiento.
    const reloaded = createAppUpdateRuntime({ client: null, now: () => NOW });
    assert.equal(reloaded.isDismissed("1.4.0"), true);

    runtime.dismiss("");
    assert.equal(runtime.isDismissed(""), false);

    unsubscribe();
    runtime.dismiss("2.0.0");
    assert.equal(seen.length, 1);
  } finally {
    installLocalStorage(null);
  }
});

test("el almacén de comprobación tolera valores corruptos y guarda enteros válidos", async () => {
  const storage = fakeStorage({ [UPDATE_CHECK_STORAGE_KEY]: "{{{no-es-json" });
  installLocalStorage(storage);
  try {
    const runtimeStorage = createRuntimeStorage();
    assert.equal(await runtimeStorage.load(), null);

    storage.map.set(
      UPDATE_CHECK_STORAGE_KEY,
      JSON.stringify({ lastCheckAt: "ayer", lastStatus: "available" })
    );
    assert.equal(await runtimeStorage.load(), null);

    storage.map.set(
      UPDATE_CHECK_STORAGE_KEY,
      JSON.stringify({ lastCheckAt: -1, lastStatus: "available" })
    );
    assert.equal(await runtimeStorage.load(), null);

    await runtimeStorage.save({ lastCheckAt: NOW, lastStatus: "available" });
    assert.deepEqual(await runtimeStorage.load(), {
      lastCheckAt: NOW,
      lastStatus: "available"
    });

    // Guardar algo inválido no escribe basura.
    await runtimeStorage.save({ lastCheckAt: Number.NaN, lastStatus: "available" });
    assert.deepEqual(await runtimeStorage.load(), {
      lastCheckAt: NOW,
      lastStatus: "available"
    });
  } finally {
    installLocalStorage(null);
  }
});

test("sin localStorage el almacén y el descarte no lanzan", async () => {
  installLocalStorage(null);
  const runtimeStorage = createRuntimeStorage();
  assert.equal(await runtimeStorage.load(), null);
  await runtimeStorage.save({ lastCheckAt: NOW, lastStatus: "up-to-date" });
  assert.equal(await runtimeStorage.load(), null);

  const runtime = createAppUpdateRuntime({ client: null, now: () => NOW });
  runtime.dismiss("1.4.0");
  assert.equal(runtime.isDismissed("1.4.0"), true);
});

test("un descarte corrupto en el almacén no se interpreta como versión", () => {
  installLocalStorage(fakeStorage({ [UPDATE_DISMISSED_STORAGE_KEY]: "   " }));
  try {
    const runtime = createAppUpdateRuntime({ client: null, now: () => NOW });
    assert.equal(runtime.isDismissed("1.4.0"), false);
  } finally {
    installLocalStorage(null);
  }
});
