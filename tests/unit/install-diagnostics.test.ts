/**
 * Diagnóstico de instalación con dependencias inyectadas.
 *
 * En Node no hay ventana, service workers, cachés ni puentes: cada prueba
 * sustituye el entorno para verificar el contrato del informe, la clasificación
 * de comprobaciones y que ningún valor de localStorage cruce al texto copiable.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UPDATE_MANIFEST_URL,
  INSTALL_ERROR_KEY,
  classifyInstallCheck,
  collectInstallDiagnostics,
  detectInstallSurface,
  formatInstallDiagnostics,
  getUpdateOrigin,
  readLastInstallError,
  recordInstallError,
  type InstallStorage
} from "../../src/services/diagnostics/install";

class FakeStorage implements InstallStorage {
  private readonly map = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.map.set(key, value);
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const ANDROID_INFO = {
  platform: "android",
  shellVersion: "1.3.5",
  webVersion: "1.3.5",
  ota: true
};

const FIXED_NOW = () => new Date("2026-11-17T12:00:00.000Z");

test("detectInstallSurface prioriza Android, luego los puentes de escritorio y luego http(s)", () => {
  assert.equal(
    detectInstallSurface({
      nativeInfo: () => ANDROID_INFO,
      scope: { location: { protocol: "https:" } }
    }),
    "android"
  );
  assert.equal(
    detectInstallSurface({ nativeInfo: () => null, scope: { palmyraDesktopUpdate: {} } }),
    "windows"
  );
  assert.equal(
    detectInstallSurface({ nativeInfo: () => null, scope: { palmyraDesktopDb: {} } }),
    "windows"
  );
  // El escritorio gana a una ubicación http(s) del propio renderer.
  assert.equal(
    detectInstallSurface({
      nativeInfo: () => null,
      scope: { palmyraDesktopDb: {}, location: { protocol: "https:" } }
    }),
    "windows"
  );
  assert.equal(
    detectInstallSurface({ nativeInfo: () => null, scope: { location: { protocol: "http:" } } }),
    "web"
  );
  assert.equal(
    detectInstallSurface({ nativeInfo: () => null, scope: { location: { protocol: "file:" } } }),
    "unknown"
  );
  assert.equal(detectInstallSurface({ nativeInfo: () => null, scope: null }), "unknown");
});

test("detectInstallSurface nunca lanza y tolera puentes rotos", () => {
  assert.equal(
    detectInstallSurface({
      nativeInfo: () => {
        throw new Error("puente roto");
      },
      scope: { location: { protocol: "https:" } }
    }),
    "web"
  );
  assert.equal(detectInstallSurface({ scope: 42 }), "unknown");
  // Sin ventana (Node) la superficie por defecto es desconocida.
  assert.equal(detectInstallSurface(), "unknown");
});

test("getUpdateOrigin usa la variable inyectada, su valor por defecto y no enmascara la URL", () => {
  assert.equal(
    getUpdateOrigin({ env: { VITE_UPDATE_MANIFEST_URL: "https://example.test/update-manifest.json" } }),
    "https://example.test/update-manifest.json"
  );
  assert.equal(getUpdateOrigin({ env: { VITE_UPDATE_MANIFEST_URL: "   " } }), DEFAULT_UPDATE_MANIFEST_URL);
  assert.equal(getUpdateOrigin({ env: {} }), DEFAULT_UPDATE_MANIFEST_URL);
  assert.equal(getUpdateOrigin(), DEFAULT_UPDATE_MANIFEST_URL);
  // Una URL http se devuelve tal cual: el aviso lo da la comprobación.
  assert.equal(
    getUpdateOrigin({ env: { VITE_UPDATE_MANIFEST_URL: "http://mirror.test/update-manifest.json" } }),
    "http://mirror.test/update-manifest.json"
  );
});

test("readLastInstallError acepta un registro válido y descarta los corruptos", () => {
  const valid = new FakeStorage({
    [INSTALL_ERROR_KEY]: JSON.stringify({
      message: "Fallo al aplicar la actualización OTA",
      at: "2026-11-16T09:30:00.000Z"
    })
  });
  assert.deepEqual(readLastInstallError(valid), {
    message: "Fallo al aplicar la actualización OTA",
    at: "2026-11-16T09:30:00.000Z"
  });

  assert.equal(INSTALL_ERROR_KEY, "palmyra-install-last-error");
  assert.equal(readLastInstallError(new FakeStorage()), null);
  assert.equal(readLastInstallError(new FakeStorage({ [INSTALL_ERROR_KEY]: "no es json" })), null);
  assert.equal(readLastInstallError(new FakeStorage({ [INSTALL_ERROR_KEY]: "[]" })), null);
  assert.equal(
    readLastInstallError(new FakeStorage({ [INSTALL_ERROR_KEY]: JSON.stringify({ at: "2026-11-16T09:30:00.000Z" }) })),
    null
  );
  assert.equal(
    readLastInstallError(
      new FakeStorage({ [INSTALL_ERROR_KEY]: JSON.stringify({ message: "sin fecha", at: "ayer" }) })
    ),
    null
  );
  assert.equal(readLastInstallError(null), null);
});

test("readLastInstallError trunca mensajes enormes a 300 caracteres y no lanza si el almacén falla", () => {
  const huge = new FakeStorage({
    [INSTALL_ERROR_KEY]: JSON.stringify({ message: "x".repeat(500), at: "2026-11-16T09:30:00.000Z" })
  });
  const parsed = readLastInstallError(huge);
  assert.ok(parsed);
  assert.equal(parsed.message.length, 300);
  assert.equal(parsed.message, "x".repeat(300));

  const broken: InstallStorage = {
    getItem() {
      throw new Error("almacenamiento bloqueado");
    }
  };
  assert.equal(readLastInstallError(broken), null);
});

test("recordInstallError escribe la clave, trunca, aplana y no lanza", () => {
  const storage = new FakeStorage();
  recordInstallError("x".repeat(500), storage);
  const raw = storage.getItem(INSTALL_ERROR_KEY);
  assert.ok(raw);
  const parsed = JSON.parse(raw) as { message: string; at: string };
  assert.equal(parsed.message, "x".repeat(300));
  assert.equal(typeof parsed.at, "string");
  assert.ok(Number.isFinite(Date.parse(parsed.at)));

  recordInstallError("primera línea\nsegunda línea", storage);
  assert.equal(readLastInstallError(storage)?.message, "primera línea segunda línea");

  const broken: InstallStorage = {
    getItem: () => null,
    setItem() {
      throw new Error("cuota llena");
    }
  };
  assert.doesNotThrow(() => recordInstallError("sin espacio", broken));
  assert.doesNotThrow(() => recordInstallError("sin almacén", null));
});

test("classifyInstallCheck traduce el hecho medido a estado visible", () => {
  assert.equal(classifyInstallCheck({ ok: true }), "ok");
  assert.equal(classifyInstallCheck({ ok: false }), "warn");
  assert.equal(classifyInstallCheck({ ok: false, severity: "warn" }), "warn");
  assert.equal(classifyInstallCheck({ ok: false, severity: "error" }), "error");
  assert.equal(classifyInstallCheck({ ok: null }), "unknown");
  assert.equal(classifyInstallCheck({ ok: undefined }), "unknown");
  assert.equal(
    classifyInstallCheck({ ok: false, severity: "error", surface: "android", appliesTo: ["web"] }),
    "unknown"
  );
  assert.equal(
    classifyInstallCheck({ ok: true, surface: "web", appliesTo: ["web"] }),
    "ok"
  );
});

test("collectInstallDiagnostics arma el informe web con dependencias inyectadas", async () => {
  const storage = new FakeStorage({
    [INSTALL_ERROR_KEY]: JSON.stringify({ message: "OTA cancelada", at: "2026-11-16T09:30:00.000Z" })
  });

  const report = await collectInstallDiagnostics({
    surface: "web",
    now: FIXED_NOW,
    navigatorImpl: {
      serviceWorker: {
        getRegistration: async () => ({
          scope: "https://palmyra.test/?token=no-debe-cruzar",
          active: { state: "activated" }
        })
      },
      storage: { estimate: async () => ({ usage: 2048, quota: 4096 }) }
    },
    cacheStorage: { keys: async () => ["palmyra-b", "palmyra-a", "palmyra-a"] },
    storage,
    env: { VITE_UPDATE_MANIFEST_URL: "https://example.test/update-manifest.json" }
  });

  assert.equal(report.generatedAt, "2026-11-17T12:00:00.000Z");
  assert.equal(report.surface, "web");
  assert.equal(report.updateOrigin, "https://example.test/update-manifest.json");
  assert.equal(report.serviceWorker.registered, true);
  assert.equal(report.serviceWorker.state, "activated");
  assert.equal(report.serviceWorker.scope, "https://palmyra.test/");
  assert.deepEqual(report.caches, ["palmyra-a", "palmyra-b"]);
  assert.equal(report.localServer.kind, "node-web");
  assert.equal(report.localServer.state, "unknown");
  assert.deepEqual(report.lastError, { message: "OTA cancelada", at: "2026-11-16T09:30:00.000Z" });
  assert.deepEqual(report.storage, { usage: 2048, quota: 4096 });
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ["version", "update-origin", "service-worker", "cache", "local-server", "last-error"]
  );
  assert.equal(report.checks.find((check) => check.id === "update-origin")?.state, "ok");
  assert.equal(report.checks.find((check) => check.id === "service-worker")?.state, "ok");
  assert.equal(report.checks.find((check) => check.id === "cache")?.state, "ok");
  assert.equal(report.checks.find((check) => check.id === "local-server")?.state, "unknown");
  assert.equal(report.checks.find((check) => check.id === "last-error")?.state, "warn");
  assert.ok(report.notes.some((note) => note.includes("error de instalación registrado")));
});

test("collectInstallDiagnostics avisa cuando el manifiesto no usa HTTPS", async () => {
  const report = await collectInstallDiagnostics({
    surface: "web",
    now: FIXED_NOW,
    navigatorImpl: null,
    cacheStorage: null,
    storage: null,
    env: { VITE_UPDATE_MANIFEST_URL: "http://mirror.test/update-manifest.json" }
  });

  assert.equal(report.checks.find((check) => check.id === "update-origin")?.state, "warn");
  assert.equal(report.checks.find((check) => check.id === "service-worker")?.state, "warn");
  assert.equal(report.checks.find((check) => check.id === "cache")?.state, "unknown");
  assert.equal(report.storage, null);
});

test("collectInstallDiagnostics mapea el hub de escritorio listo y con error", async () => {
  const base = {
    surface: "windows" as const,
    now: FIXED_NOW,
    navigatorImpl: null,
    cacheStorage: null,
    storage: null,
    env: { VITE_UPDATE_MANIFEST_URL: "https://example.test/update-manifest.json" },
    hubTimeoutMs: 50
  };

  const ready = await collectInstallDiagnostics({
    ...base,
    desktopHub: {
      status: async () => ({ ok: true, status: { running: true, host: "192.168.1.9", port: 8443 } })
    }
  });
  assert.equal(ready.localServer.kind, "desktop-hub");
  assert.equal(ready.localServer.state, "ready");
  assert.ok(ready.localServer.detail.includes("192.168.1.9:8443"));
  assert.equal(ready.checks.find((check) => check.id === "local-server")?.state, "ok");
  assert.equal(ready.checks.find((check) => check.id === "service-worker")?.state, "unknown");

  const failed = await collectInstallDiagnostics({
    ...base,
    desktopHub: { status: async () => ({ ok: false, error: "Hub no disponible." }) }
  });
  assert.equal(failed.localServer.state, "error");
  assert.equal(failed.localServer.detail, "Hub no disponible.");
  assert.equal(failed.checks.find((check) => check.id === "local-server")?.state, "error");

  const threw = await collectInstallDiagnostics({
    ...base,
    desktopHub: {
      status: () => {
        throw new Error("ipc caído");
      }
    }
  });
  assert.equal(threw.localServer.state, "error");
});

test("un hub que nunca responde no bloquea el informe", async () => {
  const started = Date.now();
  const report = await collectInstallDiagnostics({
    surface: "windows",
    now: FIXED_NOW,
    navigatorImpl: null,
    cacheStorage: null,
    storage: null,
    env: { VITE_UPDATE_MANIFEST_URL: "https://example.test/update-manifest.json" },
    desktopHub: { status: () => new Promise(() => {}) },
    hubTimeoutMs: 20
  });

  assert.equal(report.localServer.kind, "desktop-hub");
  assert.equal(report.localServer.state, "unknown");
  assert.ok(report.localServer.detail.includes("Sin respuesta"));
  assert.ok(report.notes.some((note) => note.includes("no respondió")));
  assert.ok(Date.now() - started < 1000);
});

test("collectInstallDiagnostics en Android depende del puente PALMYRA_NATIVE", async () => {
  const base = {
    surface: "android" as const,
    now: FIXED_NOW,
    navigatorImpl: null,
    cacheStorage: null,
    storage: null,
    env: { VITE_UPDATE_MANIFEST_URL: "https://example.test/update-manifest.json" },
    nativeInfo: () => ANDROID_INFO
  };

  const withBridge = await collectInstallDiagnostics({
    ...base,
    scope: { PALMYRA_NATIVE: { getInfo: () => "{}" } }
  });
  assert.equal(withBridge.version, "1.3.5");
  assert.equal(withBridge.localServer.kind, "android-shell");
  assert.equal(withBridge.localServer.state, "ready");
  assert.equal(withBridge.checks.find((check) => check.id === "version")?.state, "ok");
  assert.equal(withBridge.checks.find((check) => check.id === "service-worker")?.state, "unknown");

  const withoutBridge = await collectInstallDiagnostics({ ...base, scope: {} });
  assert.equal(withoutBridge.localServer.state, "error");
  assert.equal(withoutBridge.checks.find((check) => check.id === "local-server")?.state, "error");
});

test("collectInstallDiagnostics detecta la superficie inyectada y nunca lanza con un entorno hostil", async () => {
  const hostile = await collectInstallDiagnostics({
    nativeInfo: () => {
      throw new Error("puente roto");
    },
    scope: null,
    navigatorImpl: {
      get serviceWorker(): never {
        throw new Error("serviceWorker roto");
      },
      get storage(): never {
        throw new Error("storage roto");
      }
    },
    cacheStorage: {
      keys() {
        throw new Error("caché roto");
      }
    },
    storage: {
      getItem() {
        throw new Error("localStorage roto");
      }
    },
    env: { VITE_UPDATE_MANIFEST_URL: "no-es-una-url" }
  });

  assert.equal(hostile.surface, "unknown");
  assert.equal(hostile.serviceWorker.registered, false);
  assert.deepEqual(hostile.caches, []);
  assert.equal(hostile.lastError, null);
  assert.equal(hostile.storage, null);
  assert.equal(hostile.checks.find((check) => check.id === "update-origin")?.state, "error");
  assert.ok(hostile.notes.length > 0);

  // Ruta por defecto: en Node no hay ventana, pero el informe se genera igual.
  const fallback = await collectInstallDiagnostics();
  assert.equal(fallback.surface, "unknown");
  assert.equal(fallback.localServer.kind, "none");
  assert.equal(fallback.checks.length, 6);
  assert.equal(typeof fallback.version, "string");
  assert.equal(typeof fallback.updateOrigin, "string");
  assert.ok(fallback.notes.length > 0);
});

test("formatInstallDiagnostics incluye versión y origen pero ningún secreto del almacén", async () => {
  const storage = new FakeStorage({
    "palmyra-auth-token": "SECRET-TOKEN-123",
    "palmyra-font-scale": "1.1",
    [INSTALL_ERROR_KEY]: JSON.stringify({ message: "Fallo de red al actualizar", at: "2026-11-16T09:30:00.000Z" })
  });

  const report = await collectInstallDiagnostics({
    surface: "web",
    now: FIXED_NOW,
    navigatorImpl: {
      serviceWorker: { getRegistration: async () => ({ active: { state: "activated" } }) },
      storage: { estimate: async () => ({ usage: 2048, quota: 4096 }) }
    },
    cacheStorage: { keys: async () => ["palmyra-a"] },
    storage,
    env: { VITE_UPDATE_MANIFEST_URL: "https://example.test/update-manifest.json" }
  });

  const text = formatInstallDiagnostics(report);
  assert.ok(text.includes("PALMYRA · Diagnóstico de instalación"));
  assert.ok(text.includes(`Versión: ${report.version}`));
  assert.ok(text.includes("https://example.test/update-manifest.json"));
  assert.ok(text.includes("Web (navegador)"));
  assert.ok(text.includes("Fallo de red al actualizar"));
  assert.ok(text.includes("2.00 KB usados de 4.00 KB"));
  assert.ok(text.includes("[Aviso] Último error de instalación"));
  assert.ok(text.includes("Sin tokens, claves ni valores de almacenamiento."));

  assert.ok(!text.includes("SECRET-TOKEN-123"));
  assert.ok(!text.includes("palmyra-auth-token"));
  assert.ok(!text.includes("palmyra-font-scale"));
});
