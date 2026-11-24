/**
 * Diagnóstico de Android con dependencias inyectadas.
 *
 * No hay tablet ni puentes reales en Node: cada prueba sustituye la lectura
 * del shell, los puentes, el almacenamiento y el estimador para verificar el
 * contrato del informe, incluido que ningún valor de localStorage cruce al
 * JSON exportado.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_BACKUP_STATUS_STORAGE_KEY,
  androidDiagnosticsFileName,
  androidDiagnosticsJson,
  collectAndroidDiagnostics,
  type AndroidDiagnosticsDeps,
  type DiagnosticsStorage
} from "../../src/services/diagnostics/android";

class FakeStorage implements DiagnosticsStorage {
  private readonly map = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.map.set(key, value);
  }

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key) ?? null : null;
  }
}

function baseDeps(storage: DiagnosticsStorage): AndroidDiagnosticsDeps {
  return {
    now: () => new Date("2026-11-17T12:00:00.000Z"),
    appVersion: "1.3.5",
    getNativeAppInfo: () => ({
      platform: "android",
      shellVersion: "1.3.5",
      webVersion: "1.3.5",
      ota: true
    }),
    getKeystoreBridge: () => ({ sealSecret: () => "", openSecret: () => "" }),
    getBackupBridge: () => ({ save: () => "" }),
    getNativeBridge: () => ({ getInfo: () => "" }),
    getDbBridge: () => ({
      integrity: () => JSON.stringify({ ok: true, result: "ok" })
    }),
    getStorage: () => storage,
    estimateStorage: async () => ({ usage: 1024, quota: 4096 }),
    countRows: async (table) => (table === "sales" ? 42 : 7)
  };
}

function bridgePresence(
  report: Awaited<ReturnType<typeof collectAndroidDiagnostics>>
): Record<string, boolean> {
  return Object.fromEntries(report.bridges.map((bridge) => [bridge.id, bridge.present]));
}

test("con todos los puentes presentes el informe queda correcto", async () => {
  const report = await collectAndroidDiagnostics(baseDeps(new FakeStorage()));

  assert.equal(report.generatedAt, "2026-11-17T12:00:00.000Z");
  assert.equal(report.platform.name, "android");
  assert.equal(report.platform.isAndroid, true);
  assert.deepEqual(report.versions, {
    app: "1.3.5",
    shell: "1.3.5",
    web: "1.3.5",
    ota: true
  });
  assert.deepEqual(bridgePresence(report), {
    PALMYRA_DB: true,
    PALMYRA_KEYSTORE: true,
    PALMYRA_BACKUP: true,
    PALMYRA_NATIVE: true
  });
  assert.equal(report.database.integrity, "ok");
  assert.equal(report.database.sales, 42);
  assert.equal(report.database.products, 7);
  assert.equal(report.storage.usageBytes, 1024);
  assert.equal(report.storage.quotaBytes, 4096);
  assert.deepEqual(report.notes, []);
});

test("sin puentes el informe sigue siendo válido y explica lo omitido", async () => {
  const report = await collectAndroidDiagnostics({
    ...baseDeps(new FakeStorage()),
    getNativeAppInfo: () => null,
    getKeystoreBridge: () => null,
    getBackupBridge: () => null,
    getNativeBridge: () => null,
    getDbBridge: () => null
  });

  assert.deepEqual(bridgePresence(report), {
    PALMYRA_DB: false,
    PALMYRA_KEYSTORE: false,
    PALMYRA_BACKUP: false,
    PALMYRA_NATIVE: false
  });
  assert.equal(report.database.integrity, "unavailable");
  assert.equal(report.database.sales, null);
  assert.equal(report.database.products, null);
  assert.ok(report.notes.some((note) => note.includes("PALMYRA_DB")));
  assert.ok(report.notes.some((note) => note.includes("shell nativo")));
  assert.ok(report.bridges.every((bridge) => bridge.present === false));
});

test("integrity con ok:false marca la base con fallo y conserva el detalle", async () => {
  const report = await collectAndroidDiagnostics({
    ...baseDeps(new FakeStorage()),
    getDbBridge: () => ({
      integrity: () =>
        JSON.stringify({ ok: false, result: "database disk image is malformed" })
    })
  });

  assert.equal(report.database.integrity, "failed");
  assert.equal(report.database.integrityDetail, "database disk image is malformed");
  const db = report.bridges.find((bridge) => bridge.id === "PALMYRA_DB");
  assert.equal(db?.healthy, false);
  assert.ok(report.notes.some((note) => note.includes("integridad")));
});

test("un integrity que lanza no rompe el informe", async () => {
  const report = await collectAndroidDiagnostics({
    ...baseDeps(new FakeStorage()),
    getDbBridge: () => ({
      integrity: () => {
        throw new Error("bridge roto");
      }
    })
  });

  assert.equal(report.database.integrity, "failed");
  assert.equal(report.database.integrityDetail, "No se pudo ejecutar integrity_check.");
  assert.equal(report.database.sales, 42);
});

test("sin storage.estimate el almacenamiento queda sin cifras y con nota", async () => {
  const report = await collectAndroidDiagnostics({
    ...baseDeps(new FakeStorage()),
    estimateStorage: async () => null
  });

  assert.equal(report.storage.estimateSupported, false);
  assert.equal(report.storage.usageBytes, null);
  assert.equal(report.storage.quotaBytes, null);
  assert.ok(report.notes.some((note) => note.includes("storage.estimate")));
});

test("un estado de respaldo corrupto no lanza y se reporta", async () => {
  const storage = new FakeStorage({
    [ANDROID_BACKUP_STATUS_STORAGE_KEY]: "{ esto no es json"
  });
  const report = await collectAndroidDiagnostics(baseDeps(storage));

  assert.equal(report.backup.present, true);
  assert.equal(report.backup.status, "corrupt");
  assert.equal(report.backup.lastBackupAt, null);
  assert.ok(report.notes.some((note) => note.includes("corrupto")));
});

test("localStorage se mide por longitudes y nunca expone claves ni valores", async () => {
  const storage = new FakeStorage({
    "sb-access-token": "VALOR-PRIVADO-123",
    "palmyra-theme": "oscuro-secreto"
  });
  const report = await collectAndroidDiagnostics(baseDeps(storage));

  const expectedChars =
    "sb-access-token".length + "VALOR-PRIVADO-123".length + "palmyra-theme".length + "oscuro-secreto".length;
  assert.equal(report.storage.localStorageKeys, 2);
  assert.equal(report.storage.localStorageBytes, expectedChars * 2);

  const json = androidDiagnosticsJson(report);
  assert.ok(!json.includes("VALOR-PRIVADO-123"));
  assert.ok(!json.includes("oscuro-secreto"));
  assert.ok(!json.includes("sb-access-token"));
  assert.ok(!json.includes("palmyra-theme"));
});

test("el estado del respaldo solo aporta campos conocidos y sanea rutas", async () => {
  const storage = new FakeStorage({
    [ANDROID_BACKUP_STATUS_STORAGE_KEY]: JSON.stringify({
      lastBackupAt: "2026-11-17T10:00:00.000Z",
      fileName: "palmyra-backup-20261117-100000.bin",
      location: "/data/user/0/cu.palmyra/cache/palmyra-backup-20261117-100000.bin",
      error: null,
      attemptAt: "2026-11-17T10:00:00.000Z",
      token: "TOKEN-EN-ESTADO"
    })
  });
  const report = await collectAndroidDiagnostics(baseDeps(storage));

  assert.equal(report.backup.status, "ok");
  assert.equal(report.backup.lastBackupAt, "2026-11-17T10:00:00.000Z");
  assert.equal(report.backup.fileName, "palmyra-backup-20261117-100000.bin");
  assert.equal(report.backup.location, "palmyra-backup-20261117-100000.bin");
  assert.equal(report.backup.error, null);
  assert.ok(!("token" in report.backup));

  const json = androidDiagnosticsJson(report);
  assert.ok(!json.includes("TOKEN-EN-ESTADO"));
  assert.ok(!json.includes("/data/user"));
});

test("un respaldo con error se marca como error y deja nota", async () => {
  const storage = new FakeStorage({
    [ANDROID_BACKUP_STATUS_STORAGE_KEY]: JSON.stringify({
      lastBackupAt: "2026-11-16T10:00:00.000Z",
      error: "save_failed"
    })
  });
  const report = await collectAndroidDiagnostics(baseDeps(storage));

  assert.equal(report.backup.status, "error");
  assert.equal(report.backup.error, "save_failed");
  assert.ok(report.notes.some((note) => note.includes("terminó con error")));
});

test("dependencias hostiles no hacen lanzar la recolección", async () => {
  const report = await collectAndroidDiagnostics({
    now: () => new Date(Number.NaN),
    getNativeAppInfo: () => {
      throw new Error("shell roto");
    },
    getKeystoreBridge: () => {
      throw new Error("keystore roto");
    },
    getStorage: () => {
      throw new Error("storage roto");
    },
    estimateStorage: async () => {
      throw new Error("estimate roto");
    },
    countRows: async () => {
      throw new Error("conteo roto");
    },
    getDbBridge: () => ({ integrity: () => "{}" })
  });

  assert.ok(Number.isFinite(Date.parse(report.generatedAt)));
  assert.ok(report.notes.length > 0);
});

test("el nombre del archivo sigue el patrón solicitado", () => {
  assert.equal(
    androidDiagnosticsFileName("2026-11-17T12:00:00.000Z"),
    "palmyra-diagnostico-android-2026-11-17.json"
  );
  assert.match(
    androidDiagnosticsFileName("fecha inválida"),
    /^palmyra-diagnostico-android-\d{4}-\d{2}-\d{2}\.json$/
  );
});
