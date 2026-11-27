/**
 * Descarga de archivos generados (`src/utils/downloadFile.ts`).
 *
 * El puente `PALMYRA_NATIVE.saveFile` se simula en globalThis.window: estas
 * pruebas cubren el contrato del helper (Base64, envelopes, enlace blob: y
 * ausencia del puente) con respuestas falsas idénticas a las del shell.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { toBase64 } from "../../src/services/localDb/backup/format";
import {
  bytesToBase64,
  downloadGeneratedFile,
  NATIVE_EXPORT_MAX_BYTES,
  saveExportViaNativeBridge
} from "../../src/utils/downloadFile";

type FakeSaveFile = (name: string, data: string, mime: string) => string | Promise<string>;

function installBridge(saveFile: FakeSaveFile | undefined): void {
  const native = saveFile ? { saveFile } : {};
  (globalThis as unknown as { window: unknown }).window = { PALMYRA_NATIVE: native };
}

function clearWindow(): void {
  (globalThis as unknown as { window: unknown }).window = {};
}

test("bytesToBase64 coincide con el codificador probado del respaldo", () => {
  const small = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 104, 111, 108, 97]);
  assert.equal(bytesToBase64(small), toBase64(small));
  const large = new Uint8Array(20_000);
  for (let index = 0; index < large.length; index += 1) {
    large[index] = (index * 31) % 256;
  }
  assert.equal(bytesToBase64(large), toBase64(large));
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
});

test("sin puente el helper degrada al enlace blob: y nunca lanza", () => {
  clearWindow();
  assert.equal(saveExportViaNativeBridge(new Uint8Array([1]), "a.xlsx", "application/x"), null);
  // Sin document (Node) el enlace blob: no puede iniciarse: resultado 'unavailable'.
  const outcome = downloadGeneratedFile(new Uint8Array([1]), "a.xlsx", "application/x");
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.fileName, "a.xlsx");
});

test("el puente nativo guarda el Base64 con nombre y MIME correctos", () => {
  let captured: { name: string; data: string; mime: string } | null = null;
  installBridge((name, data, mime) => {
    captured = { name, data, mime };
    return JSON.stringify({ ok: true, location: "Download/a.xlsx" });
  });
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(
    saveExportViaNativeBridge(bytes, "a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "saved"
  );
  assert.ok(captured);
  assert.equal(captured?.name, "a.xlsx");
  assert.equal(captured?.data, toBase64(bytes));
  assert.equal(
    captured?.mime,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  // downloadGeneratedFile usa el puente antes que el enlace blob: y confirma guardado.
  const saved = downloadGeneratedFile(bytes, "a.xlsx", "application/x");
  assert.equal(saved.status, "saved");
  assert.equal(saved.via, "native");
  assert.equal(saved.fileName, "a.xlsx");
});

test("un envelope con ok:false se traduce a failed", () => {
  installBridge(() => JSON.stringify({ ok: false, error: "write_failed" }));
  assert.equal(saveExportViaNativeBridge(new Uint8Array([1]), "a.xlsx", "x"), "failed");
});

test("un puente roto devuelve failed y downloadGeneratedFile lo reporta sin lanzar", () => {
  installBridge(() => {
    throw new Error("boom");
  });
  assert.equal(saveExportViaNativeBridge(new Uint8Array([1]), "a.xlsx", "x"), "failed");
  const outcome = downloadGeneratedFile(new Uint8Array([1]), "a.xlsx", "x");
  assert.equal(outcome.status, "failed");
});

test("una respuesta thenable (puente no síncrono) se rechaza", () => {
  installBridge(() => Promise.resolve(JSON.stringify({ ok: true })));
  assert.equal(saveExportViaNativeBridge(new Uint8Array([1]), "a.xlsx", "x"), "failed");
});

test("bytes vacíos o fuera de techo se rechazan sin llamar al puente", () => {
  let calls = 0;
  installBridge(() => {
    calls += 1;
    return JSON.stringify({ ok: true });
  });
  assert.equal(saveExportViaNativeBridge(new Uint8Array(0), "a.xlsx", "x"), "failed");
  assert.equal(
    saveExportViaNativeBridge(new Uint8Array(NATIVE_EXPORT_MAX_BYTES + 1), "a.xlsx", "x"),
    "failed"
  );
  assert.equal(calls, 0);
});
