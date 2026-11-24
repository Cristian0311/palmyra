/**
 * Contrato de la OTA de Android (`applyAndroidUpdate` / `validateAndroidUpdate`).
 *
 * El shell nativo no se ejecuta aquí: se usa un puente falso que captura los
 * argumentos exactos de `startUpdate` / `startApkUpdate` para comprobar que la
 * web repite las garantías del manifiesto (HTTPS, SHA-256, versión creciente,
 * tamaño acotado) antes de tocar el dispositivo.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PalmyraNativeBridge } from "../../src/lib/nativeApp";
import {
  ANDROID_UPDATE_ERROR_EVENT,
  ANDROID_UPDATE_EVENT,
  applyAndroidUpdate,
  isAndroidUpdateArtifact,
  validateAndroidUpdate,
  type AndroidUpdateArtifact
} from "../../src/services/updates/android";

const SHA = "a".repeat(64);
const URL_OK = "https://downloads.palmyra.app/palmyra-web-1.4.0.zip";

function artifact(overrides: Partial<AndroidUpdateArtifact> = {}): AndroidUpdateArtifact {
  return { kind: "bundle", version: "1.4.0", url: URL_OK, sha256: SHA, bytes: 1024, ...overrides };
}

type Call = { method: string; args: unknown[] };

function fakeBridge(calls: Call[], overrides: Partial<PalmyraNativeBridge> = {}): PalmyraNativeBridge {
  return {
    getInfo: () =>
      JSON.stringify({ platform: "android", shellVersion: "1.3.5", webVersion: "1.3.5", ota: true }),
    confirmBoot: () => undefined,
    startUpdate: (...args: unknown[]) => {
      calls.push({ method: "startUpdate", args });
    },
    startApkUpdate: (...args: unknown[]) => {
      calls.push({ method: "startApkUpdate", args });
    },
    ...overrides
  } as PalmyraNativeBridge;
}

function installWindow(bridge: PalmyraNativeBridge | null): void {
  (globalThis as unknown as { window: unknown }).window = bridge ? { PALMYRA_NATIVE: bridge } : {};
}

function removeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

// Primero de todos: getNativeAppInfo() memoriza la primera lectura del puente.
test("sin currentVersion usa la webVersion del shell (1.3.5)", () => {
  const calls: Call[] = [];
  installWindow(fakeBridge(calls));
  try {
    assert.deepEqual(applyAndroidUpdate(artifact(), { bridge: fakeBridge(calls) }), { ok: true });
    assert.deepEqual(calls, [{ method: "startUpdate", args: ["1.4.0", URL_OK, SHA, 1024] }]);
  } finally {
    removeWindow();
  }
});

test("isAndroidUpdateArtifact exige forma estricta", () => {
  assert.equal(isAndroidUpdateArtifact(artifact()), true);
  assert.equal(isAndroidUpdateArtifact(artifact({ kind: "apk" })), true);
  assert.equal(isAndroidUpdateArtifact(artifact({ sha256: "A".repeat(64) })), true);
  assert.equal(isAndroidUpdateArtifact(null), false);
  assert.equal(isAndroidUpdateArtifact([]), false);
  assert.equal(isAndroidUpdateArtifact([artifact()]), false);
  assert.equal(isAndroidUpdateArtifact("https://x/y.zip"), false);
  assert.equal(isAndroidUpdateArtifact(artifact({ kind: "exe" as unknown as "apk" })), false);
  assert.equal(isAndroidUpdateArtifact(artifact({ version: "   " })), false);
  assert.equal(isAndroidUpdateArtifact(artifact({ version: 140 as unknown as string })), false);
  assert.equal(isAndroidUpdateArtifact(artifact({ url: "" })), false);
  assert.equal(isAndroidUpdateArtifact(artifact({ sha256: undefined as unknown as string })), false);
  assert.equal(isAndroidUpdateArtifact(artifact({ bytes: "1024" as unknown as number })), false);
  assert.equal(isAndroidUpdateArtifact(artifact({ bytes: Number.NaN })), false);
});

test("validateAndroidUpdate solo acepta HTTPS sin loopback ni credenciales", () => {
  assert.deepEqual(validateAndroidUpdate(artifact(), "1.3.5"), { ok: true });
  const insecure = [
    "http://downloads.palmyra.app/palmyra-web-1.4.0.zip",
    "javascript:alert(1)",
    "https://localhost/palmyra-web-1.4.0.zip",
    "https://localhost:8443/x.zip",
    "https://127.0.0.1/x.zip",
    "https://127.8.9.10/x.zip",
    "https://[::1]/x.zip",
    "https://user:pass@downloads.palmyra.app/x.zip",
    "no-es-una-url",
    ""
  ];
  for (const url of insecure) {
    assert.deepEqual(validateAndroidUpdate(artifact({ url }), "1.3.5"), {
      ok: false,
      code: "invalid_url"
    });
  }
});

test("sha256 debe ser hexadecimal de 64 caracteres", () => {
  const bad = ["", "a".repeat(63), "a".repeat(65), "g".repeat(64), ` ${SHA} `];
  for (const sha256 of bad) {
    assert.deepEqual(validateAndroidUpdate(artifact({ sha256 }), "1.3.5"), {
      ok: false,
      code: "invalid_hash"
    });
  }
  assert.deepEqual(validateAndroidUpdate(artifact({ sha256: "B".repeat(64) }), "1.3.5"), { ok: true });
});

test("la versión debe ser semver estricta y estrictamente más nueva", () => {
  assert.deepEqual(validateAndroidUpdate(artifact({ version: "1.3.6" }), "1.3.5"), { ok: true });
  assert.deepEqual(validateAndroidUpdate(artifact({ version: "1.3.5" }), "1.3.5"), {
    ok: false,
    code: "not_newer"
  });
  assert.deepEqual(validateAndroidUpdate(artifact({ version: "1.3.4" }), "1.3.5"), {
    ok: false,
    code: "not_newer"
  });
  // Una beta es anterior a su estable: no se instala sobre 1.4.0.
  assert.deepEqual(validateAndroidUpdate(artifact({ version: "1.4.0-beta.1" }), "1.4.0"), {
    ok: false,
    code: "not_newer"
  });
  // La estable 1.4.0 sí es más nueva que 1.4.0-beta.2 y que 1.3.5.
  assert.deepEqual(validateAndroidUpdate(artifact({ version: "1.4.0" }), "1.4.0-beta.2"), { ok: true });
  assert.deepEqual(validateAndroidUpdate(artifact({ version: "1.4.0-beta.2" }), "1.4.0-beta.1"), {
    ok: true
  });
  const invalid = ["1.4", "01.4.0", "1.4.0.0", "1.4.0-rc.1", "", "   "];
  for (const version of invalid) {
    assert.deepEqual(validateAndroidUpdate(artifact({ version }), "1.3.5"), {
      ok: false,
      code: "invalid_version"
    });
  }
});

test("bytes debe ser entero entre 1 y 512 MB", () => {
  const bad = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 512 * 1024 * 1024 + 1];
  for (const bytes of bad) {
    assert.deepEqual(validateAndroidUpdate(artifact({ bytes }), "1.3.5"), {
      ok: false,
      code: "too_large"
    });
  }
  assert.deepEqual(validateAndroidUpdate(artifact({ bytes: 1 }), "1.3.5"), { ok: true });
  assert.deepEqual(validateAndroidUpdate(artifact({ bytes: 512 * 1024 * 1024 }), "1.3.5"), {
    ok: true
  });
});

test("sin puente la actualización queda no disponible", () => {
  const result = applyAndroidUpdate(artifact(), { currentVersion: "1.3.5", bridge: null });
  assert.deepEqual(result, {
    ok: false,
    error: "Las actualizaciones no están disponibles en este equipo."
  });
});

test("un puente sin startApkUpdate rechaza el APK", () => {
  const calls: Call[] = [];
  const bridge = fakeBridge(calls, { startApkUpdate: undefined });
  assert.deepEqual(
    applyAndroidUpdate(artifact({ kind: "apk" }), { currentVersion: "1.3.5", bridge }),
    { ok: false, error: "El instalador no admite APK." }
  );
  assert.deepEqual(calls, []);
});

test("bundle y APK llaman al método nativo correcto con argumentos exactos", () => {
  const calls: Call[] = [];
  const bridge = fakeBridge(calls);
  const bundle = artifact({ bytes: 12_345 });
  assert.deepEqual(applyAndroidUpdate(bundle, { currentVersion: "1.3.5", bridge }), { ok: true });

  const apk = artifact({
    kind: "apk",
    version: "1.4.0",
    url: "https://downloads.palmyra.app/palmyra-1.4.0.apk",
    sha256: "0123456789abcdef".repeat(4),
    bytes: 34_567_890
  });
  assert.deepEqual(applyAndroidUpdate(apk, { currentVersion: "1.3.5", bridge }), { ok: true });

  assert.deepEqual(calls, [
    { method: "startUpdate", args: ["1.4.0", URL_OK, SHA, 12_345] },
    {
      method: "startApkUpdate",
      args: [
        "1.4.0",
        "https://downloads.palmyra.app/palmyra-1.4.0.apk",
        "0123456789abcdef".repeat(4),
        34_567_890
      ]
    }
  ]);
});

test("un error del puente se traduce sin lanzar", () => {
  const bridge = fakeBridge([], {
    startUpdate: () => {
      throw new Error("bridge down");
    },
    startApkUpdate: () => {
      throw new Error("bridge down");
    }
  });
  const expected = { ok: false, error: "No se pudo iniciar la actualización." };
  assert.deepEqual(applyAndroidUpdate(artifact(), { currentVersion: "1.3.5", bridge }), expected);
  assert.deepEqual(
    applyAndroidUpdate(artifact({ kind: "apk" }), { currentVersion: "1.3.5", bridge }),
    expected
  );
});

test("un artefacto inválido se rechaza antes de tocar el puente", () => {
  const calls: Call[] = [];
  const bridge = fakeBridge(calls);
  const result = applyAndroidUpdate(null as unknown as AndroidUpdateArtifact, {
    currentVersion: "1.3.5",
    bridge
  });
  assert.deepEqual(result, { ok: false, error: "La actualización recibida no es válida." });
  assert.deepEqual(calls, []);
});

test("los eventos nativos tienen el nombre que instala el shell", () => {
  assert.equal(ANDROID_UPDATE_EVENT, "palmyra:ota-installed");
  assert.equal(ANDROID_UPDATE_ERROR_EVENT, "palmyra:ota-error");
});
