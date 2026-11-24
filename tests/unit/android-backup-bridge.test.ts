/**
 * Puente de respaldo Android (`PALMYRA_BACKUP`) simulado en globalThis.window.
 *
 * El shell escribe archivos reales y no se puede ejecutar aquí: estas pruebas
 * cubren el contrato del wrapper (Base64, envelopes, ensamblado por trozos y
 * ausencia del puente) con respuestas falsas idénticas a las de AndroidBackup.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  isAndroidBackupAvailable,
  listDeviceBackups,
  pickBackupFromDevice,
  removeDeviceBackup,
  saveBackupToDevice
} from "../../src/services/localDb/backup/android";

type TestBridge = {
  save: (name: string, data: string, sha: string) => string | Promise<string>;
  list: () => string | Promise<string>;
  remove: (name: string) => string | Promise<string>;
  openPicker: () => void | Promise<void>;
  pendingInfo: () => string | Promise<string>;
  readPending: (offset: number, length: number) => string | Promise<string>;
  clearPending: () => string | Promise<string>;
};

/** Instala un puente completo (las funciones no usadas responden OK). */
function installBridge(overrides: Partial<TestBridge> = {}): void {
  const bridge: TestBridge = {
    save: () => JSON.stringify({ ok: true, location: "Download/respaldo.bin" }),
    list: () => JSON.stringify({ ok: true, backups: [] }),
    remove: () => JSON.stringify({ ok: true }),
    openPicker: () => undefined,
    pendingInfo: () => JSON.stringify({ ok: false, error: "no_pending" }),
    readPending: () => JSON.stringify({ ok: false, error: "no_pending" }),
    clearPending: () => JSON.stringify({ ok: true }),
    ...overrides
  };
  (globalThis as unknown as { window: unknown }).window = { PALMYRA_BACKUP: bridge };
}

function removeBridge(): void {
  (globalThis as unknown as { window: unknown }).window = {};
}

test("sin puente el wrapper degrada y nunca lanza", async () => {
  removeBridge();
  assert.equal(isAndroidBackupAvailable(), false);
  assert.deepEqual(await saveBackupToDevice(new Uint8Array([1, 2, 3]), "x.bin"), {
    ok: false,
    error: "unavailable"
  });
  assert.deepEqual(await listDeviceBackups(), {
    ok: false,
    backups: [],
    error: "unavailable"
  });
  assert.deepEqual(await removeDeviceBackup("palmyra-backup-x.bin"), {
    ok: false,
    error: "unavailable"
  });
  assert.deepEqual(await pickBackupFromDevice(), { ok: false, error: "unavailable" });
});

test("guardar envía el contenido en Base64 y devuelve la ubicación", async () => {
  const calls: Array<{ name: string; data: string; sha: string }> = [];
  installBridge({
    save: (name, data, sha) => {
      calls.push({ name, data, sha });
      return JSON.stringify({ ok: true, location: `Download/${name}`, bytes: 5 });
    }
  });
  assert.equal(isAndroidBackupAvailable(), true);

  const result = await saveBackupToDevice(
    new Uint8Array([0x00, 0x01, 0x02, 0xfa, 0xff]),
    "palmyra-backup-20260101-000000.bin"
  );

  assert.deepEqual(result, { ok: true, location: "Download/palmyra-backup-20260101-000000.bin" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "palmyra-backup-20260101-000000.bin");
  // [0,1,2,250,255] en Base64 estándar con relleno.
  assert.equal(calls[0].data, "AAEC+v8=");
  // Sin hash esperado el wrapper no inventa uno.
  assert.equal(calls[0].sha, "");
});

test("guardar propaga los envelopes de error del shell", async () => {
  installBridge({ save: () => JSON.stringify({ ok: false, error: "permission_denied" }) });
  assert.deepEqual(await saveBackupToDevice(new Uint8Array([9]), "palmyra-backup-a.bin"), {
    ok: false,
    error: "permission_denied"
  });

  installBridge({ save: () => "esto no es json" });
  assert.deepEqual(await saveBackupToDevice(new Uint8Array([9]), "palmyra-backup-a.bin"), {
    ok: false,
    error: "invalid_response"
  });

  // Un archivo vacío no se envía al shell.
  installBridge();
  assert.deepEqual(await saveBackupToDevice(new Uint8Array(0), "palmyra-backup-a.bin"), {
    ok: false,
    error: "empty_data"
  });
});

test("listar conserva savedAt null cuando el sistema no da fecha", async () => {
  installBridge({
    list: () =>
      JSON.stringify({
        ok: true,
        backups: [
          { name: "palmyra-backup-20260101-000000.bin", bytes: 12, savedAt: null },
          { name: "palmyra-backup-20260102-000000.bin", bytes: 7, savedAt: "2026-01-02T00:00:00.000Z" }
        ]
      })
  });

  const listed = await listDeviceBackups();
  assert.equal(listed.ok, true);
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.backups, [
    { name: "palmyra-backup-20260101-000000.bin", bytes: 12, savedAt: null },
    { name: "palmyra-backup-20260102-000000.bin", bytes: 7, savedAt: "2026-01-02T00:00:00.000Z" }
  ]);
});

test("listar informa el error del shell con la lista vacía", async () => {
  installBridge({ list: () => JSON.stringify({ ok: false, error: "list_failed" }) });
  assert.deepEqual(await listDeviceBackups(), {
    ok: false,
    backups: [],
    error: "list_failed"
  });
});

test("borrar respeta el envelope del shell", async () => {
  const removed: string[] = [];
  installBridge({
    remove: (name) => {
      removed.push(name);
      return JSON.stringify({ ok: true });
    }
  });
  assert.deepEqual(await removeDeviceBackup("palmyra-backup-20260101-000000.bin"), { ok: true });
  assert.deepEqual(removed, ["palmyra-backup-20260101-000000.bin"]);

  installBridge({ remove: () => JSON.stringify({ ok: false, error: "not_found" }) });
  assert.deepEqual(await removeDeviceBackup("palmyra-backup-otro.bin"), {
    ok: false,
    error: "not_found"
  });
});

test("restaurar ensambla los tres trozos del archivo importado", async () => {
  const payload = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const offsets: number[] = [];
  let cleared = 0;
  let opened = 0;

  installBridge({
    openPicker: () => {
      opened += 1;
    },
    clearPending: () => {
      cleared += 1;
      return JSON.stringify({ ok: true });
    },
    pendingInfo: () =>
      JSON.stringify({
        ok: true,
        name: "respaldo-del-negocio.pmybak",
        bytes: payload.length,
        sha256: "0".repeat(64)
      }),
    readPending: (offset, length) => {
      offsets.push(offset);
      assert.ok(length > 0, "el wrapper no pide trozos vacíos");
      // El shell puede devolver menos de lo pedido: aquí 4, 4 y 2 bytes.
      const slice = payload.slice(offset, Math.min(offset + 4, payload.length));
      return JSON.stringify({
        ok: true,
        dataBase64: Buffer.from(slice).toString("base64"),
        eof: offset + slice.length >= payload.length
      });
    }
  });

  const result = await pickBackupFromDevice();

  assert.equal(result.ok, true);
  assert.equal(result.name, "respaldo-del-negocio.pmybak");
  assert.deepEqual(Array.from(result.bytes ?? []), Array.from(payload));
  assert.deepEqual(offsets, [0, 4, 8]);
  assert.equal(opened, 1);
  // Se limpia antes de abrir el selector y al terminar.
  assert.equal(cleared, 2);
});

test("restaurar espera mientras el archivo aún no está disponible", async () => {
  const payload = Uint8Array.from([42]);
  let polls = 0;
  installBridge({
    pendingInfo: () => {
      polls += 1;
      return polls === 1
        ? JSON.stringify({ ok: false, error: "no_pending" })
        : JSON.stringify({ ok: true, name: "respaldo.bin", bytes: payload.length, sha256: "" });
    },
    readPending: (offset, length) =>
      JSON.stringify({
        ok: true,
        dataBase64: Buffer.from(payload.slice(offset, offset + length)).toString("base64"),
        eof: true
      })
  });

  const result = await pickBackupFromDevice();
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.bytes ?? []), [42]);
  assert.equal(polls, 2);
});

test("restaurar corta con el error del shell y limpia el temporal", async () => {
  let cleared = 0;
  installBridge({
    clearPending: () => {
      cleared += 1;
      return JSON.stringify({ ok: true });
    },
    pendingInfo: () => JSON.stringify({ ok: false, error: "too_large" })
  });

  assert.deepEqual(await pickBackupFromDevice(), { ok: false, error: "too_large" });
  assert.equal(cleared, 2);
});

test("restaurar detecta un archivo incompleto", async () => {
  installBridge({
    pendingInfo: () =>
      JSON.stringify({ ok: true, name: "respaldo.bin", bytes: 10, sha256: "" }),
    // El shell anuncia 10 bytes pero el último trozo llega antes de tiempo.
    readPending: () =>
      JSON.stringify({
        ok: true,
        dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
        eof: true
      })
  });

  assert.deepEqual(await pickBackupFromDevice(), { ok: false, error: "incomplete" });
});
