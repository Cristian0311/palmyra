import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDesktopReport,
  desktopFileBasename,
  formatReportForClipboard
} from "../../src/lib/desktopReport";

const COMPANY_ID = "8f14e45f-ceea-467a-9e4c-1d2a3b4c5d6e";
const PAIRING_CODE = "483920";

function fullSnapshot() {
  return {
    appVersion: "1.3.5",
    generatedAt: "2026-11-22T10:30:00.000Z",
    db: {
      ready: true,
      driver: "sqljs",
      filePath: "C:\\Users\\Ana\\AppData\\Roaming\\palmyra\\desktop.db",
      sizeBytes: 2.5 * 1024 * 1024,
      schemaVersion: 4,
      lastWriteAt: Date.parse("2026-11-22T09:58:00.000Z"),
      lastError: ""
    },
    hub: {
      enabled: true,
      running: true,
      host: "192.168.1.10",
      port: 10000,
      companyId: COMPANY_ID,
      pairingCode: PAIRING_CODE,
      pairingExpiresAt: "2026-11-22T10:45:00.000Z",
      lastError: ""
    },
    updater: {
      status: "not-available",
      currentVersion: "1.3.5",
      version: "1.3.6",
      percent: 0,
      transferred: 0,
      total: 0,
      message: "Todo al día",
      error: "",
      updatedAt: Date.parse("2026-11-22T10:00:00.000Z")
    }
  };
}

test("Un informe completo conserva los datos útiles y solo el nombre del archivo", () => {
  const report = buildDesktopReport(fullSnapshot());

  assert.equal(report.appVersion, "1.3.5");
  assert.equal(report.generatedAt, "2026-11-22T10:30:00.000Z");
  assert.equal(report.db.ready, true);
  assert.equal(report.db.driver, "sqljs");
  assert.equal(report.db.sizeMb, 2.5);
  assert.equal(report.db.schemaVersion, 4);
  assert.equal(report.db.file, "desktop.db");
  assert.equal(report.db.lastWriteAt, "2026-11-22T09:58:00.000Z");
  assert.equal(report.hub.address, "192.168.1.10:10000");
  assert.equal(report.hub.pairingActive, true);
  assert.equal(report.hub.pairingExpiresAt, "2026-11-22T10:45:00.000Z");
  assert.equal(report.updater.status, "not-available");
  assert.equal(report.updater.currentVersion, "1.3.5");
  assert.equal(report.updater.version, "1.3.6");
  assert.equal(report.updater.updatedAt, "2026-11-22T10:00:00.000Z");

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("C:\\Users"), false);
  assert.equal(serialized.includes("Ana"), false);
  assert.equal(serialized.includes(COMPANY_ID), false);
  assert.equal(serialized.includes(PAIRING_CODE), false);
});

test("Datos ausentes o corruptos producen valores vacíos coherentes y nunca lanzan", () => {
  for (const input of [undefined, null, {}, { db: "roto", hub: 42, updater: [] }]) {
    const report = buildDesktopReport(input as any);
    assert.equal(typeof report.appVersion, "string");
    assert.equal(report.generatedAt, "");
    assert.equal(report.db.ready, false);
    assert.equal(report.db.driver, "unavailable");
    assert.equal(report.db.sizeMb, 0);
    assert.equal(report.db.file, "");
    assert.equal(report.db.lastWriteAt, "");
    assert.equal(report.hub.address, "");
    assert.equal(report.hub.pairingActive, false);
    assert.equal(report.hub.pairingExpiresAt, "");
    assert.equal(report.updater.status, "idle");
    assert.equal(report.updater.percent, 0);
    assert.equal(report.updater.updatedAt, "");
  }

  const withBadDate = buildDesktopReport({ generatedAt: "no-es-una-fecha" });
  assert.equal(withBadDate.generatedAt, "");

  const clamped = buildDesktopReport({ updater: { status: "descargando", percent: 150 } });
  assert.equal(clamped.updater.status, "idle");
  assert.equal(clamped.updater.percent, 100);
  assert.equal(clamped.updater.updatedAt, "");
});

test("Las rutas completas se reducen al basename o a un marcador neutro", () => {
  const windows = buildDesktopReport({
    db: {
      ready: true,
      filePath: "C:\\Users\\Ana Pérez\\AppData\\Roaming\\PALMYRA\\desktop.db",
      lastError: 'No se pudo abrir "C:\\Users\\Ana Pérez\\AppData\\Roaming\\PALMYRA\\desktop.db"'
    }
  });
  assert.equal(windows.db.file, "desktop.db");
  assert.equal(windows.db.error.includes("C:\\Users"), false);
  assert.equal(windows.db.error.includes("[ruta]"), true);

  const posix = buildDesktopReport({
    db: { filePath: "/home/ana/.config/palmyra/desktop.db", lastError: "Error en /home/ana/.config/palmyra/desktop.db" },
    hub: { lastError: `Empresa ${COMPANY_ID} rechazada` },
    updater: { message: "token " + "a".repeat(48) }
  });
  assert.equal(posix.db.file, "desktop.db");
  assert.equal(posix.db.error.includes("/home/ana"), false);
  assert.equal(posix.hub.error.includes(COMPANY_ID), false);
  assert.equal(posix.hub.error.includes("[id]"), true);
  assert.equal(posix.updater.message.includes("a".repeat(48)), false);

  assert.equal(desktopFileBasename("desktop.db"), "desktop.db");
  assert.equal(desktopFileBasename("/var/lib/palmyra/desktop.db"), "desktop.db");
  assert.equal(desktopFileBasename(""), "");
  assert.equal(desktopFileBasename(undefined), "");
});

test("Un emparejamiento caducado o sin código no se reporta como vigente", () => {
  const expired = buildDesktopReport({
    generatedAt: "2026-11-22T11:00:00.000Z",
    hub: {
      running: true,
      host: "192.168.1.10",
      port: 10000,
      pairingCode: PAIRING_CODE,
      pairingExpiresAt: "2026-11-22T10:45:00.000Z"
    }
  });
  assert.equal(expired.hub.pairingActive, false);

  const noExpiry = buildDesktopReport({
    generatedAt: "2026-11-22T11:00:00.000Z",
    hub: { running: true, pairingCode: PAIRING_CODE }
  });
  assert.equal(noExpiry.hub.pairingActive, false);

  const stopped = buildDesktopReport(fullSnapshot());
  assert.equal(
    buildDesktopReport({ ...fullSnapshot(), hub: { ...fullSnapshot().hub, running: false } }).hub.pairingActive,
    false
  );
  assert.equal(stopped.hub.address, "192.168.1.10:10000");

  const noPort = buildDesktopReport({ hub: { host: "192.168.1.10", port: 0 } });
  assert.equal(noPort.hub.address, "");
});

test("El texto para portapapeles lleva encabezado, versión y fecha sin secretos", () => {
  const text = formatReportForClipboard(buildDesktopReport(fullSnapshot()));

  assert.equal(text.startsWith("PALMYRA · diagnóstico\n"), true);
  assert.match(text, /Versión: 1\.3\.5/);
  assert.match(text, /Fecha: 2026-11-22 10:30 UTC/);
  assert.match(text, /BASE LOCAL[\s\S]*Archivo: desktop\.db/);
  assert.match(text, /RED LOCAL[\s\S]*Dirección: 192\.168\.1\.10:10000/);
  assert.match(text, /Emparejamiento: vigente hasta 2026-11-22 10:45 UTC/);
  assert.match(text, /ACTUALIZADOR[\s\S]*Estado: Todo al día/);
  assert.equal(text.includes("C:\\Users"), false);
  assert.equal(text.includes("Ana Pérez"), false);
  assert.equal(text.includes(COMPANY_ID), false);
  assert.equal(text.includes(PAIRING_CODE), false);
});

test("El formateador tolera informes vacíos o manipulados sin filtrar rutas", () => {
  const empty = formatReportForClipboard(null);
  assert.equal(empty.startsWith("PALMYRA · diagnóstico\n"), true);
  assert.match(empty, /Base local/i);

  const unsafe = {
    appVersion: "1.3.5",
    generatedAt: "2026-11-22T10:30:00.000Z",
    db: { ready: true, driver: "sqljs", schemaVersion: 1, sizeMb: 1.2, file: "C:\\Users\\Ana\\x.db", lastWriteAt: "", error: "" },
    hub: { enabled: true, running: false, address: "", pairingActive: false, pairingExpiresAt: "", error: "" },
    updater: { status: "idle", currentVersion: "", version: "", percent: 0, message: "", error: "", updatedAt: "" }
  };
  const text = formatReportForClipboard(unsafe as any);

  assert.equal(text.includes("C:\\Users"), false);
  assert.match(text, /Archivo: x\.db/);
});
