import test from "node:test";
import assert from "node:assert/strict";
import {
  androidUpdateKindForArtifact,
  buildUpdateManifestUrlList,
  createAppUpdateRuntime,
  createRuntimeStorage,
  DEFAULT_UPDATE_MANIFEST_MIRRORS,
  DEFAULT_UPDATE_MANIFEST_URL,
  getUpdateDeviceId,
  getUpdateManifestUrl,
  getUpdatePlatform,
  getUpdatePublicJwk,
  selectUpdateArtifact,
  UPDATE_CHECK_STORAGE_KEY,
  UPDATE_DEVICE_STORAGE_KEY,
  UPDATE_DISMISSED_STORAGE_KEY,
  UPDATE_ENTRY_RETRY_MS
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

/** Sustituye `navigator.onLine`; devuelve la restauración. */
function installNavigatorOnline(online: boolean): () => void {
  const target = globalThis as unknown as { navigator?: unknown };
  const original = target.navigator;
  Object.defineProperty(target, "navigator", {
    configurable: true,
    value: { onLine: online }
  });
  return () => {
    if (original === undefined) {
      delete target.navigator;
    } else {
      Object.defineProperty(target, "navigator", { configurable: true, value: original });
    }
  };
}

/** Colección de listeners de window/document para simular el ciclo de vida. */
function collectListeners(): {
  map: Map<string, Array<() => void>>;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
} {
  const map = new Map<string, Array<() => void>>();
  return {
    map,
    addEventListener(type: string, handler: () => void) {
      const list = map.get(type) ?? [];
      list.push(handler);
      map.set(type, list);
    },
    removeEventListener(type: string, handler: () => void) {
      const list = map.get(type) ?? [];
      map.set(type, list.filter((item) => item !== handler));
    }
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

test("buildUpdateManifestUrlList: el entorno explícito sustituye toda la cadena", () => {
  assert.deepEqual(
    buildUpdateManifestUrlList("https://cdn.example.test/update-manifest.json", "https://app.example.com"),
    ["https://cdn.example.test/update-manifest.json"]
  );
});

test("buildUpdateManifestUrlList: proxy del propio origen + asset oficial + mirrors", () => {
  const list = buildUpdateManifestUrlList(null, "https://app.palmyra.example.com");
  assert.equal(list[0], "https://app.palmyra.example.com/api/updates/manifest");
  assert.equal(list[1], DEFAULT_UPDATE_MANIFEST_URL);
  assert.deepEqual(list.slice(2), DEFAULT_UPDATE_MANIFEST_MIRRORS);
});

test("buildUpdateManifestUrlList: loopback http sí usa el proxy; LAN http no", () => {
  const loopback = buildUpdateManifestUrlList(null, "http://127.0.0.1:10000");
  assert.equal(loopback[0], "http://127.0.0.1:10000/api/updates/manifest");

  const lan = buildUpdateManifestUrlList(null, "http://192.168.1.5:10000");
  assert.equal(lan[0], DEFAULT_UPDATE_MANIFEST_URL);
});

test("buildUpdateManifestUrlList: un origen ilegible no rompe la cadena", () => {
  const list = buildUpdateManifestUrlList(null, "no-es-origen");
  assert.equal(list[0], DEFAULT_UPDATE_MANIFEST_URL);
  assert.equal(list.length, 1 + DEFAULT_UPDATE_MANIFEST_MIRRORS.length);
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

test("una comprobación forzada no la absorbe una de cadencia en vuelo", async () => {
  // El botón «Buscar actualización» (force) debe llegar a la red aunque una
  // comprobación automática esté en vuelo: esta puede resolver «not-due» sin
  // consultar nada y el usuario se quedaría creyendo que ya está al día.
  const calls: Array<boolean | undefined> = [];
  let releaseNotDue!: () => void;
  const client: UpdateClient = {
    check(options?: { force?: boolean }) {
      calls.push(options?.force);
      if (options?.force) {
        return Promise.resolve(result("up-to-date"));
      }
      return new Promise<UpdateCheckResult>((resolve) => {
        releaseNotDue = () => resolve(result("not-due"));
      });
    }
  };
  const runtime = createAppUpdateRuntime({ client, now: () => NOW });

  const cadence = runtime.check(false);
  const manual = runtime.check(true);
  releaseNotDue();
  const [autoState, manualState] = await Promise.all([cadence, manual]);

  assert.deepEqual(calls, [false, true], "la forzada sale a la red tras la de cadencia");
  assert.equal(autoState.phase, "idle");
  assert.equal(autoState.manual, false);
  assert.equal(manualState.phase, "up-to-date");
  assert.equal(manualState.manual, true);
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

test("Android acepta el bundle web (.zip) cuando el manifiesto no publica APK", () => {
  const windows = baseManifest().artifacts[0];
  const web = baseManifest().artifacts[2];
  const onlyWeb = parseUpdateManifest(baseManifest({ artifacts: [windows, web] }));

  const picked = selectUpdateArtifact(onlyWeb, "android");
  assert.ok(picked);
  assert.equal(picked?.name, "palmyra-web.zip");
  // Se etiqueta como android para que la UI lo trate como OTA nativo; la URL y
  // el sha256 son los mismos que cubre la firma del manifiesto.
  assert.equal(picked?.platform, "android");
  assert.equal(picked?.sha256, "d".repeat(64));
  assert.equal(picked?.url, web.url);
  assert.equal(androidUpdateKindForArtifact(picked), "bundle");

  // Un artefacto web que no sea .zip no sirve como bundle OTA.
  const notZip = parseUpdateManifest(
    baseManifest({ artifacts: [windows, { ...web, name: "palmyra-web.tar" }] })
  );
  assert.equal(selectUpdateArtifact(notZip, "android"), null);
});

test("startAutoCheck comprueba forzada al entrar, con cadencia al foco y cada 24 h", async () => {
  const calls: Array<boolean | undefined> = [];
  const client = fixingClient([result("up-to-date")], calls);
  const timers: Array<() => void> = [];
  const windowSurface = collectListeners();
  const documentSurface = collectListeners();
  let scheduledMs = 0;
  let cleared = 0;

  const fakeWindow = {
    ...windowSurface,
    setInterval(handler: () => void, ms: number) {
      timers.push(handler);
      scheduledMs = ms;
      return 1;
    },
    clearInterval() {
      cleared += 1;
    }
  };
  const fakeDocument = { visibilityState: "visible", ...documentSurface };

  const globals = globalThis as unknown as { document?: unknown };
  installWindow(fakeWindow as unknown as Record<string, unknown>);
  globals.document = fakeDocument;
  try {
    const runtime = createAppUpdateRuntime({ client, now: () => NOW });
    // La vigilancia se instala sola al crear el runtime en un entorno con DOM.
    assert.equal(scheduledMs, 86_400_000, "el reloj periódico es de 24 h");
    await flushAsync();
    assert.deepEqual(calls, [true], "la entrada consulta la red de verdad (forzada)");

    // Volver a primer plano respeta la cadencia (y no duplica peticiones).
    windowSurface.map.get("focus")?.forEach((handler) => handler());
    await flushAsync();
    assert.equal(calls.length, 2);
    assert.equal(calls[1], false);

    // La reanudación del shell Android (MainActivity.onResume) también comprueba.
    windowSurface.map.get("palmyra:native-resume")?.forEach((handler) => handler());
    await flushAsync();
    assert.equal(calls.length, 3);
    assert.equal(calls[2], false);

    // Recuperar internet fuerza la comprobación: es «entrar con conexión».
    windowSurface.map.get("online")?.forEach((handler) => handler());
    await flushAsync();
    assert.equal(calls.length, 4);
    assert.equal(calls[3], true);

    // Un segundo «online» inmediato no multiplica peticiones (margen de 60 s).
    windowSurface.map.get("online")?.forEach((handler) => handler());
    await flushAsync();
    assert.equal(calls.length, 4, "el margen corto absorbe el segundo online");

    // El reloj periódico fuerza la consulta para no dejar pasar un release.
    timers[0]();
    await flushAsync();
    assert.equal(calls.length, 5);
    assert.equal(calls[4], true);

    // startAutoCheck es idempotente y stopAutoCheck limpia temporizador y listeners.
    const again = runtime.startAutoCheck();
    assert.equal(timers.length, 1);
    again();
    assert.equal(cleared, 1);
    assert.equal(windowSurface.map.get("focus")?.length, 0);
    runtime.stopAutoCheck();
    assert.equal(cleared, 1, "parar dos veces no hace nada");
  } finally {
    delete globals.document;
    installWindow(null);
  }
});

test("sin document (Node) no se instala ninguna vigilancia automática", () => {
  installWindow({});
  try {
    const runtime = createAppUpdateRuntime({
      client: fixingClient([result("up-to-date")]),
      now: () => NOW
    });
    // Sin document no hay temporizadores ni listeners: el proceso de pruebas
    // no queda vivo por la vigilancia.
    assert.equal(typeof runtime.startAutoCheck(), "function");
    runtime.stopAutoCheck();
  } finally {
    installWindow(null);
  }
});

test("al entrar con internet un release nuevo se detecta y queda disponible", async () => {
  // Flujo completo de entrada: el runtime arranca con la vigilancia (DOM
  // presente), consulta el manifiesto firmado DE VERDAD (forzada, sin dejarse
  // frenar por la cadencia persistida) y publica la fase «available» que
  // dispara la burbuja/la tarjeta OTA.
  installLocalStorage(fakeStorage());
  const signedManifest = await signUpdateManifest(baseManifest(), signingKeys.privateKey, "clave-2026");
  const { impl, calls } = countingFetch(async () => jsonResponse(signedManifest));
  const windowSurface = collectListeners();
  const documentSurface = collectListeners();
  const fakeWindow = {
    ...windowSurface,
    setInterval() {
      return 1;
    },
    clearInterval() {}
  };
  const fakeDocument = { visibilityState: "visible", ...documentSurface };

  const globals = globalThis as unknown as { document?: unknown };
  installWindow(fakeWindow as unknown as Record<string, unknown>);
  globals.document = fakeDocument;
  try {
    const runtime = createAppUpdateRuntime({
      manifestUrl: MANIFEST_URL,
      publicJwk,
      fetchImpl: impl,
      now: () => NOW
    });
    // La verificación ES256 y el snapshot se resuelven en varios turnos del
    // bucle: esperamos hasta que la comprobación de entrada termine.
    for (let i = 0; i < 50 && runtime.state.phase === "checking"; i += 1) {
      await flushAsync();
    }
    assert.equal(calls.length, 1, "la entrada consulta el manifiesto de verdad");
    assert.equal(runtime.state.phase, "available");
    assert.equal(runtime.state.result?.version, "1.4.0");
    assert.equal(runtime.state.artifact?.platform, "web");
    assert.equal(runtime.state.lastCheckAt, NOW);
  } finally {
    delete globals.document;
    installWindow(null);
    installLocalStorage(null);
  }
});

test("la comprobación de entrada se salta en silencio sin conexión", async () => {
  const calls: Array<boolean | undefined> = [];
  const client = fixingClient([result("up-to-date")], calls);
  const windowSurface = collectListeners();
  const documentSurface = collectListeners();
  const fakeWindow = {
    ...windowSurface,
    setInterval() {
      return 1;
    },
    clearInterval() {}
  };
  const fakeDocument = { visibilityState: "visible", ...documentSurface };
  const restore = installNavigatorOnline(false);

  const globals = globalThis as unknown as { document?: unknown };
  installWindow(fakeWindow as unknown as Record<string, unknown>);
  globals.document = fakeDocument;
  try {
    const seen: string[] = [];
    const runtime = createAppUpdateRuntime({ client, now: () => NOW });
    runtime.subscribe((state) => seen.push(state.phase));

    await flushAsync();
    assert.equal(calls.length, 0, "sin conexión la entrada no toca la red");
    assert.equal(runtime.state.phase, "idle");
    assert.equal(runtime.state.error, undefined);
    assert.equal(seen.length, 0, "ni «checking» ni «error»: salto silencioso sin avisos");
  } finally {
    delete globals.document;
    installWindow(null);
    restore();
  }
});

test("sin sesión de Supabase (login offline-first) la entrada comprueba igual", async () => {
  // El runtime de actualizaciones no depende de la sesión de Supabase: un
  // arranque offline-first (usuario local verificado, sin sesión en la nube)
  // debe comprobar el manifiesto al entrar con internet exactamente igual.
  const calls: Array<boolean | undefined> = [];
  const client = fixingClient([result("available", NOW, { version: "1.4.0" })], calls);
  const windowSurface = collectListeners();
  const documentSurface = collectListeners();
  const fakeWindow = {
    ...windowSurface,
    setInterval() {
      return 1;
    },
    clearInterval() {}
  };
  const fakeDocument = { visibilityState: "visible", ...documentSurface };

  const globals = globalThis as unknown as { document?: unknown };
  installWindow(fakeWindow as unknown as Record<string, unknown>);
  globals.document = fakeDocument;
  try {
    const runtime = createAppUpdateRuntime({ client, now: () => NOW });
    await flushAsync();
    assert.deepEqual(calls, [true], "la entrada comprueba forzada aunque no haya sesión");
    assert.equal(runtime.state.phase, "available");
    assert.equal(runtime.state.result?.version, "1.4.0");
  } finally {
    delete globals.document;
    installWindow(null);
  }
});

test("la comprobación de entrada reintenta una sola vez si la red falla", async () => {
  const calls: Array<boolean | undefined> = [];
  const client: UpdateClient = {
    check(options?: { force?: boolean }) {
      calls.push(options?.force);
      return Promise.resolve(result("error", NOW, { error: "sin red" }));
    }
  };
  const windowSurface = collectListeners();
  const documentSurface = collectListeners();
  let retryHandler: (() => void) | null = null;
  let retryDelayMs = 0;
  const fakeWindow = {
    ...windowSurface,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout(handler: () => void, ms: number) {
      retryHandler = handler;
      retryDelayMs = ms;
      return 1;
    },
    clearTimeout() {
      retryHandler = null;
    }
  };
  const fakeDocument = { visibilityState: "visible", ...documentSurface };

  const globals = globalThis as unknown as { document?: unknown };
  installWindow(fakeWindow as unknown as Record<string, unknown>);
  globals.document = fakeDocument;
  try {
    const runtime = createAppUpdateRuntime({ client, now: () => NOW });
    await flushAsync();
    assert.deepEqual(calls, [true]);
    assert.equal(runtime.state.phase, "error");
    assert.equal(retryDelayMs, UPDATE_ENTRY_RETRY_MS, "el reintento es corto");
    assert.ok(retryHandler, "se programa el reintento único");

    retryHandler();
    await flushAsync();
    assert.deepEqual(calls, [true, true], "un solo reintento, sin encadenar más");
  } finally {
    delete globals.document;
    installWindow(null);
  }
});

test("la búsqueda manual llega a la red aunque el navegador esté sin conexión", async () => {
  // El botón «Buscar actualización» de Ajustes nunca se salta: sin conexión
  // debe intentar y reportar el motivo (a diferencia de la entrada automática).
  const restore = installNavigatorOnline(false);
  try {
    const calls: Array<boolean | undefined> = [];
    const client = fixingClient([result("error", NOW, { error: "Sin conexión a internet." })], calls);
    const runtime = createAppUpdateRuntime({ client, now: () => NOW });
    const next = await runtime.check(true);
    assert.deepEqual(calls, [true], "la búsqueda manual nunca se salta");
    assert.equal(next.phase, "error");
    assert.equal(next.manual, true);
    assert.match(String(next.error), /Sin conexión/i);
  } finally {
    restore();
  }
});

test("una comprobación de cadencia comparte la forzada en vuelo", async () => {
  const calls: Array<boolean | undefined> = [];
  let release!: () => void;
  const client: UpdateClient = {
    check(options?: { force?: boolean }) {
      calls.push(options?.force);
      return new Promise<UpdateCheckResult>((resolve) => {
        release = () => resolve(result("available", NOW, { version: "1.4.0" }));
      });
    }
  };
  const runtime = createAppUpdateRuntime({ client, now: () => NOW });

  const forced = runtime.check(true);
  const cadence = runtime.check(false);
  release();
  const [forcedState, cadenceState] = await Promise.all([forced, cadence]);

  assert.deepEqual(calls, [true], "la de cadencia no duplica la petición");
  assert.equal(forcedState.phase, "available");
  assert.equal(cadenceState.phase, "available");
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
