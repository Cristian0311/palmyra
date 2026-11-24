import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryUpdateStorage,
  createUpdateClient,
  DEFAULT_UPDATE_INTERVAL_MS,
  isSecureManifestUrl,
  MAX_MANIFEST_BYTES
} from "../../src/services/updates/client";
import type { UpdateCheckStorage, UpdateClientOptions } from "../../src/services/updates/client";
import type { UpdateManifestV1 } from "../../src/services/updates/manifest";
import { UPDATE_MANIFEST_VERSION } from "../../src/services/updates/manifest";
import { signUpdateManifest } from "../../src/services/updates/verify";

/** Par real ES256 (ECDSA P-256), igual que en update-manifest.test.ts. */
const signingKeys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);
const publicJwk = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
const otherKeys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const MANIFEST_URL = "https://example.test/releases/manifest.json";

function baseManifest(overrides: Partial<UpdateManifestV1> = {}): UpdateManifestV1 {
  return {
    v: UPDATE_MANIFEST_VERSION,
    version: "1.4.0",
    channel: "stable",
    releasedAt: "2026-11-22T00:00:00.000Z",
    rollout: 100,
    artifacts: [
      {
        platform: "windows",
        name: "PALMYRA-POS-Setup.exe",
        url: "https://example.test/releases/PALMYRA-POS-Setup.exe",
        sha256: "b".repeat(64),
        bytes: 98765432
      }
    ],
    ...overrides
  };
}

async function signed(overrides: Partial<UpdateManifestV1> = {}): Promise<UpdateManifestV1> {
  return signUpdateManifest(baseManifest(overrides), signingKeys.privateKey, "clave-2026");
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init
  });
}

function htmlResponse(): Response {
  return new Response("<html><body>Mantenimiento del CDN</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

/** Fetch falso: cuenta llamadas y delega en el manejador indicado. */
function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

function makeClient(overrides: Partial<UpdateClientOptions> = {}) {
  return createUpdateClient({
    manifestUrl: MANIFEST_URL,
    publicJwk,
    currentVersion: "1.3.5",
    deviceId: "device-1",
    channel: "stable",
    storage: createMemoryUpdateStorage(),
    now: () => NOW,
    fetchImpl: fakeFetch(async () => jsonResponse(await signed())).impl,
    ...overrides
  });
}

test("sin manifestUrl queda unconfigured y no toca la red", async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(await signed()));
  const storage = createMemoryUpdateStorage();
  const client = makeClient({ manifestUrl: undefined, fetchImpl: impl, storage });

  const result = await client.check({ force: true });

  assert.equal(result.status, "unconfigured");
  assert.equal(result.code, "unconfigured");
  assert.equal(result.checkedAt, NOW);
  assert.equal(calls.length, 0);
  assert.equal(await storage.load(), null);
});

test("una URL no HTTPS (fuera de localhost) se rechaza antes de la red", async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(await signed()));

  for (const manifestUrl of [
    "http://cdn.example.test/releases/manifest.json",
    "ftp://example.test/manifest.json",
    "no-es-una-url"
  ]) {
    const client = makeClient({ manifestUrl, fetchImpl: impl });
    const result = await client.check({ force: true });
    assert.equal(result.status, "error", manifestUrl);
    assert.equal(result.code, "insecure-url", manifestUrl);
    assert.match(result.error ?? "", /https/, manifestUrl);
  }
  assert.equal(calls.length, 0, "nunca se descarga por un canal inseguro");
});

test("isSecureManifestUrl solo admite https o http en loopback", () => {
  assert.equal(isSecureManifestUrl("https://example.test/manifest.json"), true);
  assert.equal(isSecureManifestUrl("http://localhost:5173/manifest.json"), true);
  assert.equal(isSecureManifestUrl("http://127.0.0.1:5173/manifest.json"), true);
  assert.equal(isSecureManifestUrl("http://example.test/manifest.json"), false);
  assert.equal(isSecureManifestUrl("ftp://example.test/manifest.json"), false);
  assert.equal(isSecureManifestUrl(""), false);
  assert.equal(isSecureManifestUrl("no-es-una-url"), false);
});

test("localhost por HTTP se permite en desarrollo y no se declara available", async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(baseManifest()));
  const client = makeClient({
    manifestUrl: "http://localhost:5173/update-manifest.json",
    publicJwk: undefined,
    fetchImpl: impl
  });

  const result = await client.check({ force: true });

  assert.equal(result.status, "unverified");
  assert.equal(calls.length, 1);
});

test("una redirección a HTTP (downgrade del canal) se rechaza", async () => {
  const redirected = new Response(JSON.stringify(await signed()), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  Object.defineProperty(redirected, "url", { value: "http://cdn.example.test/manifest.json" });
  const { impl } = fakeFetch(async () => redirected);

  const result = await makeClient({ fetchImpl: impl }).check({ force: true });

  assert.equal(result.status, "error");
  assert.equal(result.code, "insecure-url");
  assert.match(result.error ?? "", /redirección/);
});

test("dentro de 24 h no vuelve a consultar y force lo salta", async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(await signed()));
  const storage = createMemoryUpdateStorage({
    lastCheckAt: NOW - 60 * 60 * 1000,
    lastStatus: "up-to-date"
  });
  const client = makeClient({ fetchImpl: impl, storage });

  const skipped = await client.check();
  assert.equal(skipped.status, "not-due");
  assert.equal(skipped.code, "not-due");
  assert.equal(calls.length, 0, "no debe salir a la red");
  assert.equal((await storage.load())?.lastCheckAt, NOW - 60 * 60 * 1000, "not-due no reescribe la marca");

  const forced = await client.check({ force: true });
  assert.equal(forced.status, "available");
  assert.equal(forced.code, "available");
  assert.equal(calls.length, 1, "force ignora la cadencia");
});

test("pasadas las 24 h la comprobación vuelve a salir a la red", async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(await signed()));
  const stale = createMemoryUpdateStorage({
    lastCheckAt: NOW - DEFAULT_UPDATE_INTERVAL_MS - 1000,
    lastStatus: "up-to-date"
  });

  const result = await makeClient({ fetchImpl: impl, storage: stale }).check();

  assert.equal(result.status, "available");
  assert.equal(calls.length, 1);
});

test("una página HTML se reporta como error accionable, no como JSON", async () => {
  const { impl } = fakeFetch(async () => htmlResponse());
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "error");
  assert.equal(result.code, "not-json");
  assert.match(result.error ?? "", /no es JSON/);
  assert.match(result.error ?? "", /manifestUrl/);
});

test("un JSON mal formado se reporta como error sin lanzar", async () => {
  const { impl } = fakeFetch(
    async () =>
      new Response('{"v":1,"version":"1.4.0"', {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  );
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "error");
  assert.equal(result.code, "json-invalid");
  assert.match(result.error ?? "", /mal formado/);
});

test("un manifiesto desmesurado se rechaza por tamaño", async () => {
  const { impl } = fakeFetch(
    async () => jsonResponse({ v: 1, relleno: "x".repeat(MAX_MANIFEST_BYTES + 64) })
  );
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "error");
  assert.equal(result.code, "too-large");
  assert.match(result.error ?? "", /tamaño máximo/);
});

test("un fetch que nunca responde se corta por timeout y no cuelga", async () => {
  const { impl } = fakeFetch(() => new Promise<Response>(() => undefined));
  const client = makeClient({ fetchImpl: impl, timeoutMs: 30 });

  const started = Date.now();
  const result = await client.check({ force: true });
  const elapsed = Date.now() - started;

  assert.equal(result.status, "error");
  assert.equal(result.code, "timeout");
  assert.match(result.error ?? "", /tardó más de/);
  assert.ok(elapsed < 2_000, `la comprobación debe terminar rápido (tardó ${elapsed} ms)`);
});

test("un HTTP de error se reporta con el código y una pista", async () => {
  const { impl } = fakeFetch(async () => new Response("Not Found", { status: 404 }));
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "error");
  assert.equal(result.code, "http-status");
  assert.match(result.error ?? "", /HTTP 404/);
});

const MIRROR_A = "https://raw.example.test/palmyra/manifest.json";
const MIRROR_B = "https://cdn.example.test/palmyra/manifest.json";

test("si el asset principal falla por CORS se usa el mirror CORS-safe", async () => {
  const manifest = await signed();
  const { impl, calls } = fakeFetch(async (url) => {
    if (url === MANIFEST_URL) throw new TypeError("Failed to fetch");
    return jsonResponse(manifest);
  });
  const client = makeClient({ fetchImpl: impl, manifestMirrors: [MIRROR_A] });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.equal(result.version, "1.4.0");
  assert.deepEqual(calls, [MANIFEST_URL, MIRROR_A]);
});

test("un mirror con HTTP 404 no detiene la cadena: se prueba el siguiente", async () => {
  const manifest = await signed();
  const { impl, calls } = fakeFetch(async (url) => {
    if (url === MANIFEST_URL) throw new TypeError("Failed to fetch");
    if (url === MIRROR_A) return new Response("Not Found", { status: 404 });
    return jsonResponse(manifest);
  });
  const client = makeClient({ fetchImpl: impl, manifestMirrors: [MIRROR_A, MIRROR_B] });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.deepEqual(calls, [MANIFEST_URL, MIRROR_A, MIRROR_B]);
});

test("si todos los orígenes fallan se conserva el último error accionable", async () => {
  const { impl, calls } = fakeFetch(async (url) => {
    if (url === MIRROR_B) throw new TypeError("Failed to fetch");
    return new Response("Not Found", { status: 404 });
  });
  const client = makeClient({ fetchImpl: impl, manifestMirrors: [MIRROR_A, MIRROR_B] });

  const result = await client.check({ force: true });

  assert.equal(result.status, "error");
  assert.equal(result.code, "network");
  assert.match(result.error ?? "", /conectar/i);
  assert.equal(calls.length, 3);
});

test("un mirror sirviendo text/plain con cuerpo JSON se acepta", async () => {
  const manifest = await signed();
  const { impl } = fakeFetch(async (url) => {
    if (url === MANIFEST_URL) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  });
  const client = makeClient({ fetchImpl: impl, manifestMirrors: [MIRROR_A] });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.equal(result.version, "1.4.0");
});

test("un mirror con URL insegura se salta y se usa el siguiente seguro", async () => {
  const manifest = await signed();
  const { impl, calls } = fakeFetch(async (url) => {
    if (url === MIRROR_B) return jsonResponse(manifest);
    throw new TypeError("Failed to fetch");
  });
  const client = makeClient({
    fetchImpl: impl,
    manifestMirrors: ["http://cdn.example.test/manifest.json", MIRROR_B]
  });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.ok(!calls.some((url) => url.startsWith("http://cdn.example.test")));
  assert.ok(calls.includes(MIRROR_B));
});

test("los mirrors duplicados se descargan una sola vez", async () => {
  const manifest = await signed();
  const { impl, calls } = fakeFetch(async (url) => {
    if (url === MANIFEST_URL) throw new TypeError("Failed to fetch");
    return jsonResponse(manifest);
  });
  const client = makeClient({
    fetchImpl: impl,
    manifestMirrors: [MIRROR_A, MIRROR_A, MANIFEST_URL]
  });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.equal(calls.filter((url) => url === MIRROR_A).length, 1);
  assert.deepEqual(calls, [MANIFEST_URL, MIRROR_A]);
});

test("una respuesta incompleta del fetch no lanza y se trata como red", async () => {
  const impl = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "error");
  assert.equal(result.code, "network");
});

test("manifiesto válido sin firma y con publicJwk queda blocked", async () => {
  const { impl } = fakeFetch(async () => jsonResponse(baseManifest()));
  const storage = createMemoryUpdateStorage();
  const client = makeClient({ fetchImpl: impl, storage });

  const result = await client.check({ force: true });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "missing-signature");
  assert.equal(result.reason, "missing-signature");
  assert.equal(result.version, undefined, "no se anuncia versión sin firma comprobada");
  assert.equal((await storage.load())?.lastStatus, "blocked");
});

test("una firma de otra clave queda blocked sin anunciar versión", async () => {
  const forged = await signUpdateManifest(baseManifest(), otherKeys.privateKey, "clave-2026");
  const { impl } = fakeFetch(async () => jsonResponse(forged));
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "invalid-signature");
  assert.equal(result.reason, "invalid-signature");
  assert.equal(result.version, undefined);
});

test("una clave pública débil o un algoritmo distinto se bloquean", async () => {
  const { impl } = fakeFetch(async () => jsonResponse(await signed()));

  const weakKey = makeClient({
    fetchImpl: impl,
    publicJwk: { ...publicJwk, x: (publicJwk.x as string).slice(0, 12) }
  });
  const weakResult = await weakKey.check({ force: true });
  assert.equal(weakResult.status, "blocked");
  assert.equal(weakResult.code, "invalid-key");

  const wrongAlg = makeClient({ fetchImpl: impl, publicJwk: { ...publicJwk, alg: "ES384" } });
  const algResult = await wrongAlg.check({ force: true });
  assert.equal(algResult.status, "blocked");
  assert.equal(algResult.code, "unsupported-algorithm");
});

test("un JSON válido fuera del contrato queda blocked con su código de detalle", async () => {
  const { impl } = fakeFetch(async () => jsonResponse({ v: 1, version: "1.4.0" }));
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "invalid-manifest");
  assert.equal(result.reason, "invalid-manifest");
  assert.equal(result.detail, "channel-invalid");
  assert.equal(result.version, undefined);
});

test("payloads con forma inesperada nunca lanzan", async () => {
  for (const body of [null, [], "texto", 42]) {
    const { impl } = fakeFetch(async () => jsonResponse(body));
    const client = makeClient({ fetchImpl: impl });
    const result = await client.check({ force: true });
    assert.equal(result.status, "blocked", JSON.stringify(body));
    assert.equal(result.code, "invalid-manifest", JSON.stringify(body));
  }
});

test("firma válida y versión nueva produce available y guarda la marca", async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(await signed()));
  const storage = createMemoryUpdateStorage();
  const client = makeClient({ fetchImpl: impl, storage });

  const result = await client.check();

  assert.equal(result.status, "available");
  assert.equal(result.code, "available");
  assert.equal(result.version, "1.4.0");
  assert.equal(result.checkedAt, NOW);
  assert.equal(calls[0], MANIFEST_URL);
  assert.deepEqual(await storage.load(), { lastCheckAt: NOW, lastStatus: "available" });
});

test("la misma versión se informa como up-to-date", async () => {
  const { impl } = fakeFetch(async () => jsonResponse(await signed()));
  const client = makeClient({ fetchImpl: impl, currentVersion: "1.4.0" });

  const result = await client.check({ force: true });

  assert.equal(result.status, "up-to-date");
  assert.equal(result.code, "up-to-date");
  assert.equal(result.version, "1.4.0");
});

test("una beta instalada detecta la estable publicada (1.3.8 sobre 1.3.8-beta.1)", async () => {
  // La estable siempre es posterior a su pre-release: un equipo en beta no
  // debe quedarse sin el aviso cuando se publica la versión definitiva.
  const { impl } = fakeFetch(async () => jsonResponse(await signed({ version: "1.3.8" })));
  const client = makeClient({ fetchImpl: impl, currentVersion: "1.3.8-beta.1" });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.equal(result.version, "1.3.8");
});

test("una beta publicada anterior a la estable instalada se bloquea como downgrade", async () => {
  const { impl } = fakeFetch(async () => jsonResponse(await signed({ version: "1.4.0-beta.1" })));
  const client = makeClient({ fetchImpl: impl, currentVersion: "1.4.0" });

  const result = await client.check({ force: true });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "downgrade");
  assert.equal(result.reason, "downgrade");
});

test("una beta publicada más nueva que la beta instalada se ofrece", async () => {
  const { impl } = fakeFetch(async () => jsonResponse(await signed({ version: "1.4.0-beta.2" })));
  const client = makeClient({ fetchImpl: impl, currentVersion: "1.4.0-beta.1" });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.equal(result.version, "1.4.0-beta.2");
});

test("la misma versión con canal estable aplica aunque el equipo no aporte canal", async () => {
  // El canal por defecto del cliente es «stable»: un manifiesto stable nunca
  // debe bloquearse por canal aunque el llamador no lo indique explícito.
  const { impl } = fakeFetch(async () => jsonResponse(await signed()));
  const client = createUpdateClient({
    manifestUrl: MANIFEST_URL,
    publicJwk,
    currentVersion: "1.3.5",
    deviceId: "device-1",
    storage: createMemoryUpdateStorage(),
    now: () => NOW,
    fetchImpl: impl
  });

  const result = await client.check({ force: true });

  assert.equal(result.status, "available");
  assert.equal(result.code, "available");
});

test("una versión anterior se bloquea como downgrade", async () => {
  const { impl } = fakeFetch(async () => jsonResponse(await signed()));
  const client = makeClient({ fetchImpl: impl, currentVersion: "1.5.0" });

  const result = await client.check({ force: true });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "downgrade");
  assert.equal(result.reason, "downgrade");
});

test("un manifiesto de otro canal se bloquea aunque la firma sea válida", async () => {
  const beta = await signed({ channel: "beta", version: "1.5.0-beta.1" });
  const { impl } = fakeFetch(async () => jsonResponse(beta));
  const client = makeClient({ fetchImpl: impl });

  const result = await client.check({ force: true });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "channel");
  assert.equal(result.reason, "channel");
  assert.equal(result.version, "1.5.0-beta.1");
});

test("notBefore futuro bloquea y pasada la fecha se ofrece la versión", async () => {
  const future = await signed({ notBefore: "2026-12-01T00:00:00.000Z" });
  const blocked = await makeClient({
    fetchImpl: fakeFetch(async () => jsonResponse(future)).impl
  }).check({ force: true });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.code, "not-before");
  assert.equal(blocked.reason, "not-before");

  const alreadyActive = await signed({
    releasedAt: "2026-10-01T00:00:00.000Z",
    notBefore: "2026-11-01T00:00:00.000Z"
  });
  const available = await makeClient({
    fetchImpl: fakeFetch(async () => jsonResponse(alreadyActive)).impl
  }).check({ force: true });
  assert.equal(available.status, "available");
  assert.equal(available.code, "available");
});

test("el rollout por equipo decide: 0 bloquea a todos y 100 habilita a todos", async () => {
  const zero = await signed({ rollout: 0 });
  const zeroResult = await makeClient({
    fetchImpl: fakeFetch(async () => jsonResponse(zero)).impl
  }).check({ force: true });
  assert.equal(zeroResult.status, "blocked");
  assert.equal(zeroResult.code, "rollout");

  const all = await signed({ rollout: 100 });
  for (const deviceId of ["equipo-a", "equipo-b", "equipo-c"]) {
    const result = await makeClient({
      deviceId,
      fetchImpl: fakeFetch(async () => jsonResponse(all)).impl
    }).check({ force: true });
    assert.equal(result.status, "available", deviceId);
  }
});

test("sin publicJwk la versión se informa como unverified, nunca available", async () => {
  const { impl } = fakeFetch(async () => jsonResponse(await signed()));
  const storage = createMemoryUpdateStorage();
  const client = makeClient({ publicJwk: undefined, fetchImpl: impl, storage });

  const result = await client.check({ force: true });

  assert.equal(result.status, "unverified");
  assert.equal(result.code, "unverified");
  assert.equal(result.version, "1.4.0");
  assert.equal(result.reason, "signature-not-checked");
  assert.equal((await storage.load())?.lastStatus, "unverified");
});

test("la marca solo se guarda cuando la comprobación termina bien", async () => {
  const storage = createMemoryUpdateStorage();
  const failing = makeClient({
    fetchImpl: fakeFetch(async () => htmlResponse()).impl,
    storage
  });

  const failed = await failing.check({ force: true });
  assert.equal(failed.status, "error");
  assert.equal(await storage.load(), null, "un fallo de red no debe avanzar la cadencia");

  const working = makeClient({
    fetchImpl: fakeFetch(async () => jsonResponse(await signed())).impl,
    storage
  });
  const ok = await working.check({ force: true });
  assert.equal(ok.status, "available");
  assert.deepEqual(await storage.load(), { lastCheckAt: NOW, lastStatus: "available" });
});

test("nunca lanza aunque la red, el almacén o el reloj fallen", async () => {
  const networkDown = makeClient({
    fetchImpl: fakeFetch(async () => {
      throw new Error("sin red");
    }).impl
  });
  const networkResult = await networkDown.check({ force: true });
  assert.equal(networkResult.status, "error");
  assert.equal(networkResult.code, "network");
  assert.match(networkResult.error ?? "", /sin red/);

  const brokenStorage: UpdateCheckStorage = {
    async load() {
      throw new Error("disco no disponible");
    },
    async save() {
      throw new Error("disco lleno");
    }
  };
  const withBrokenStorage = makeClient({
    fetchImpl: fakeFetch(async () => jsonResponse(await signed())).impl,
    storage: brokenStorage
  });
  const storageResult = await withBrokenStorage.check({ force: true });
  assert.equal(storageResult.status, "available", "un almacén roto no impide evaluar");

  const brokenClock = makeClient({
    fetchImpl: fakeFetch(async () => jsonResponse(await signed())).impl,
    now: () => {
      throw new Error("reloj roto");
    }
  });
  const clockResult = await brokenClock.check({ force: true });
  assert.equal(clockResult.status, "error");
  assert.equal(clockResult.code, "unexpected");
  assert.equal(clockResult.checkedAt, 0);
});

test("sin conexión conocida (navigator.onLine false) el error dice qué hacer", async () => {
  const { impl } = fakeFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  const target = globalThis as unknown as { navigator?: unknown };
  const original = target.navigator;
  Object.defineProperty(target, "navigator", {
    configurable: true,
    value: { onLine: false }
  });
  try {
    const client = makeClient({ fetchImpl: impl });
    const result = await client.check({ force: true });
    assert.equal(result.status, "error");
    assert.equal(result.code, "network");
    assert.match(result.error ?? "", /Sin conexión/i);
  } finally {
    if (original === undefined) {
      delete target.navigator;
    } else {
      Object.defineProperty(target, "navigator", { configurable: true, value: original });
    }
  }
});

test("un error de máquina del navegador se traduce a un mensaje accionable", async () => {
  const { impl } = fakeFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  const client = makeClient({ fetchImpl: impl });
  const result = await client.check({ force: true });
  assert.equal(result.status, "error");
  assert.equal(result.code, "network");
  assert.match(result.error ?? "", /No se pudo conectar con el servidor de actualizaciones/i);
});

test("el intervalo por defecto es de 24 h", () => {
  assert.equal(DEFAULT_UPDATE_INTERVAL_MS, 86_400_000);
});
