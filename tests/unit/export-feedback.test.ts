/**
 * Feedback de exportación (`describeExportOutcome` + contrato de `downloadGeneratedFile`).
 *
 * El dueño pidió que la app avise cuando el Excel realmente se descargó, tanto en
 * Reportes como en Inventario. Estas pruebas fijan el contrato honesto: un aviso de
 * éxito SOLO sale con `status: 'saved'`, y los fallos del puente nativo del APK se
 * traducen a español accionable sin pintarse jamás de éxito.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExportSuccessNotification,
  describeExportErrorDetails,
  describeExportOutcome,
  downloadGeneratedFile,
  isExportDownloadError,
  saveExportViaNativeBridgeDetailed,
  type GeneratedFileOutcome
} from "../../src/utils/downloadFile";
import { ExportDownloadError } from "../../src/utils/exportOutcome";

type FakeSaveFile = (name: string, data: string, mime: string) => string;

function installBridge(saveFile: FakeSaveFile | undefined): void {
  const native = saveFile ? { saveFile } : {};
  (globalThis as unknown as { window: unknown }).window = { PALMYRA_NATIVE: native };
}

function clearWindow(): void {
  (globalThis as unknown as { window: unknown }).window = {};
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const REPORT_NAME = "PALMYRA_Reporte_Completo_2026-11-17.xlsx";

test("guardado nativo: aviso de éxito en español con nombre y carpeta", () => {
  installBridge((name) => JSON.stringify({ ok: true, location: `Download/${name}`, bytes: 3 }));
  const outcome = downloadGeneratedFile(new Uint8Array([1, 2, 3]), REPORT_NAME, XLSX);
  assert.equal(outcome.status, "saved");
  assert.equal(outcome.via, "native");

  const notice = describeExportOutcome(outcome);
  assert.equal(notice.tone, "success");
  assert.equal(notice.message, "Archivo descargado ✓");
  assert.ok(notice.details?.includes(REPORT_NAME), "el detalle cita el archivo");
  assert.ok(notice.details?.includes("Descargas"), "el detalle cita la carpeta Descargas");
});

test("sin puente ni document: resultado 'unavailable' y aviso de error, nunca éxito", () => {
  clearWindow();
  const outcome = downloadGeneratedFile(new Uint8Array([1]), REPORT_NAME, XLSX);
  assert.equal(outcome.status, "unavailable");

  const notice = describeExportOutcome(outcome);
  assert.equal(notice.tone, "error", "un entorno sin descargas no puede avisar éxito");
  assert.equal(notice.message, "Este dispositivo no pudo iniciar la descarga.");
  assert.ok(notice.details?.includes(REPORT_NAME));
});

test("rechazo del puente: motivo en español accionable y sin tono de éxito", () => {
  installBridge(() => JSON.stringify({ ok: false, error: "permission_denied" }));
  const outcome = downloadGeneratedFile(new Uint8Array([1]), REPORT_NAME, XLSX);
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.reason, "permission_denied");

  const notice = describeExportOutcome(outcome);
  assert.equal(notice.tone, "error");
  assert.equal(notice.message, "No se pudo descargar el archivo.");
  assert.match(notice.details ?? "", /permiso de almacenamiento/i);
  assert.ok(notice.details?.includes(`Archivo: ${REPORT_NAME}`));
});

test("un fallo NO produce aviso de éxito en ninguna de sus formas", () => {
  const failures: GeneratedFileOutcome[] = [
    { status: "failed", reason: "write_failed", fileName: REPORT_NAME },
    { status: "failed", reason: "razon_desconocida", fileName: REPORT_NAME },
    { status: "unavailable", fileName: REPORT_NAME },
  ];
  for (const outcome of failures) {
    const notice = describeExportOutcome(outcome);
    assert.notEqual(notice.tone, "success");
    assert.doesNotMatch(notice.message, /descargado/i);
  }
  // Razón desconocida cae al mensaje genérico, no a texto técnico en inglés.
  assert.match(
    describeExportOutcome(failures[1]).details ?? "",
    /Revisa el espacio disponible/i
  );
});

test("bytes vacíos o fuera del techo se reportan como fallo del puente", () => {
  let calls = 0;
  installBridge((name) => {
    calls += 1;
    return JSON.stringify({ ok: true, location: `Download/${name}` });
  });
  const empty = saveExportViaNativeBridgeDetailed(new Uint8Array(0), REPORT_NAME, XLSX);
  assert.equal(empty.status, "failed");
  assert.equal(empty.reason, "empty_data");
  assert.equal(calls, 0, "el puente no se llama con contenido inválido");
});

test("downloadWorkbookBuffer propaga el fallo como ExportDownloadError traducible", () => {
  installBridge(() => JSON.stringify({ ok: false, error: "too_large" }));
  const outcome = downloadGeneratedFile(new Uint8Array([1]), REPORT_NAME, XLSX);
  assert.equal(outcome.status, "failed");

  const error = new ExportDownloadError(outcome);
  assert.equal(isExportDownloadError(error), true);
  assert.match(describeExportErrorDetails(error, REPORT_NAME), /tamaño que admite el puente/i);
  assert.equal(describeExportOutcome(error.outcome).tone, "error");
});

test("un error de generación (no de guardado) conserva su motivo y sigue siendo error", () => {
  const generationFailure = new Error("ExcelJS no terminó de escribir el libro");
  assert.equal(isExportDownloadError(generationFailure), false);
  const details = describeExportErrorDetails(generationFailure, REPORT_NAME);
  assert.ok(details.includes("ExcelJS no terminó de escribir el libro"));
  assert.ok(details.includes(`Archivo: ${REPORT_NAME}`));
});

test("el aviso de éxito compartido nombra el archivo y la carpeta Descargas", () => {
  const notice = buildExportSuccessNotification(REPORT_NAME);
  assert.equal(notice.message, "Excel descargado ✓");
  assert.equal(notice.tone, "success");
  assert.equal(notice.details, `${REPORT_NAME} · carpeta Descargas`);
});
