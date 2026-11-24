/**
 * Respaldo programado en Android: decisión de cadencia y rotación en Descargas.
 *
 * Todo se prueba con un reloj fijo y un dispositivo simulado en memoria: no se
 * toca el almacén local, ni WebCrypto, ni el puente nativo.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_BACKUP_KEEP_LIMIT,
  SCHEDULED_BACKUP_INTERVAL_MS,
  decideScheduledBackup,
  runScheduledBackup,
  selectBackupsToRemove,
  type ScheduledBackupDeps,
  type ScheduledBackupFile
} from "../../src/services/localDb/backup/schedule";

const NOW_ISO = "2026-06-15T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const HOUR = 60 * 60 * 1000;

function isoBefore(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function deviceBackup(day: number): ScheduledBackupFile {
  const stamp = `202606${String(day).padStart(2, "0")}-030405`;
  return {
    name: `palmyra-backup-${stamp}.bin`,
    bytes: 2048,
    savedAt: new Date(Date.UTC(2026, 5, day, 3, 4, 5)).toISOString()
  };
}

type Harness = {
  deps: ScheduledBackupDeps;
  saved: Array<{ fileName: string; bytes: number }>;
  removed: string[];
  created: number;
  listed: number;
};

function harness(
  options: {
    lastBackupAt?: string | null;
    existing?: ScheduledBackupFile[];
    saveResult?: (fileName: string) => { ok: boolean; error?: string };
    createError?: Error;
    removeResult?: (name: string) => { ok: boolean; error?: string };
    fileName?: string;
  } = {}
): Harness {
  const state: Harness = {
    saved: [],
    removed: [],
    created: 0,
    listed: 0,
    deps: {} as ScheduledBackupDeps
  };
  const existing = options.existing ?? [];

  state.deps = {
    lastBackupAt: options.lastBackupAt ?? null,
    now: () => NOW_ISO,
    create: async () => {
      state.created += 1;
      if (options.createError) throw options.createError;
      const fileName = options.fileName ?? "palmyra-backup-20260615-120000.bin";
      return { bytes: new Uint8Array([1, 2, 3, 4]), summary: { fileName } };
    },
    save: async (bytes, fileName) => {
      state.saved.push({ fileName, bytes: bytes.length });
      return options.saveResult ? options.saveResult(fileName) : { ok: true };
    },
    list: async () => {
      state.listed += 1;
      // El shell devuelve la lista ya con el archivo recién guardado.
      return { ok: true, backups: [...existing, ...state.saved.map((item) => ({
        name: item.fileName,
        bytes: item.bytes,
        savedAt: NOW_ISO
      }))] };
    },
    remove: async (name) => {
      state.removed.push(name);
      return options.removeResult ? options.removeResult(name) : { ok: true };
    }
  };

  return state;
}

// ── Decisión ────────────────────────────────────────────────────────────────

test("sin respaldo previo siempre toca respaldar", () => {
  assert.deepEqual(
    decideScheduledBackup({ lastBackupAt: null, now: NOW_ISO }),
    { due: true, reason: "no-backup" }
  );
  assert.deepEqual(
    decideScheduledBackup({ lastBackupAt: "", now: NOW_ISO }),
    { due: true, reason: "no-backup" }
  );
});

test("23 h 59 min todavía no toca; 24 h exactas sí", () => {
  const almost = decideScheduledBackup({ lastBackupAt: isoBefore(24 * HOUR - 60_000), now: NOW_ISO });
  assert.deepEqual(almost, { due: false, reason: "fresh" });

  const exact = decideScheduledBackup({ lastBackupAt: isoBefore(24 * HOUR), now: NOW_ISO });
  assert.deepEqual(exact, { due: true, reason: "stale" });
});

test("una fecha inválida se trata como «nunca se respaldó» y no lanza", () => {
  for (const value of ["ayer", "2026-13-45T99:99:99Z", Number.NaN as unknown as number, undefined]) {
    assert.deepEqual(
      decideScheduledBackup({ lastBackupAt: value, now: NOW_ISO }),
      { due: true, reason: "no-backup" }
    );
  }
});

test("una fecha futura no bloquea el respaldo: cuenta como vieja", () => {
  assert.deepEqual(
    decideScheduledBackup({ lastBackupAt: isoBefore(-3 * 24 * HOUR), now: NOW_ISO }),
    { due: true, reason: "stale" }
  );
  // Un reloj inválido en `now` cae a la hora real sin romper la decisión.
  const decision = decideScheduledBackup({ lastBackupAt: null, now: "no-es-fecha" });
  assert.equal(decision.due, true);
});

// ── Ejecución ───────────────────────────────────────────────────────────────

test("con un respaldo reciente no crea, no guarda y no borra nada", async () => {
  const state = harness({ lastBackupAt: isoBefore(HOUR), existing: [deviceBackup(14)] });
  const result = await runScheduledBackup(state.deps);

  assert.equal(result.ran, false);
  assert.equal(result.reason, "fresh");
  assert.equal(state.created, 0);
  assert.equal(state.saved.length, 0);
  assert.equal(state.listed, 0);
  assert.deepEqual(result.removed, []);
});

test("crea, guarda y rota: de 9 archivos previos quedan 7 y el nuevo nunca se borra", async () => {
  const existing = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(deviceBackup);
  const state = harness({ lastBackupAt: null, existing });
  const result = await runScheduledBackup(state.deps);

  assert.equal(result.ran, true);
  assert.equal(result.reason, "no-backup");
  assert.equal(result.fileName, "palmyra-backup-20260615-120000.bin");
  assert.equal(state.saved.length, 1);
  assert.equal(result.removed.length, 3, "9 previos + 1 nuevo = 10: sobran 3");
  assert.ok(
    result.removed.every((name) => /^palmyra-backup-.+\.bin$/.test(name)),
    "solo se borran archivos del patrón"
  );
  assert.ok(!result.removed.includes(result.fileName!));
  assert.equal(result.error, undefined);
  // Los tres borrados son los más antiguos.
  assert.deepEqual(
    [...result.removed].sort(),
    [deviceBackup(1).name, deviceBackup(2).name, deviceBackup(3).name].sort()
  );
  assert.deepEqual(state.removed, result.removed);
});

test("un fallo al guardar se informa sin lanzar y no toca la retención", async () => {
  const existing = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(deviceBackup);
  const state = harness({
    lastBackupAt: null,
    existing,
    saveResult: () => ({ ok: false, error: "save_failed" })
  });
  const result = await runScheduledBackup(state.deps);

  assert.equal(result.ran, false);
  assert.equal(result.error, "save_failed");
  assert.equal(result.fileName, "palmyra-backup-20260615-120000.bin");
  assert.equal(state.listed, 0, "sin archivo nuevo no se borra ningún respaldo anterior");
  assert.deepEqual(result.removed, []);
});

test("un fallo al crear el respaldo se informa sin lanzar", async () => {
  const state = harness({ lastBackupAt: null, createError: new Error("WebCrypto no disponible") });
  const result = await runScheduledBackup(state.deps);

  assert.equal(result.ran, false);
  assert.equal(result.error, "WebCrypto no disponible");
  assert.equal(state.saved.length, 0);
  assert.deepEqual(result.removed, []);
});

test("`remove` solo recibe nombres del patrón y se ignoran los archivos ajenos", async () => {
  const existing: ScheduledBackupFile[] = [
    { name: "foto-vacaciones.jpg", bytes: 10, savedAt: isoBefore(100 * HOUR) },
    { name: "nota.txt", bytes: 10, savedAt: isoBefore(90 * HOUR) },
    { name: "palmyra-respaldo-20260101-000000.pmybak", bytes: 10, savedAt: isoBefore(80 * HOUR) },
    ...Array.from({ length: 9 }, (_, index) => ({
      name: `palmyra-backup-2026010${index + 1}-010101.bin`,
      bytes: 10,
      savedAt: new Date(Date.UTC(2026, 0, index + 1, 1, 1, 1)).toISOString()
    }))
  ];
  const state = harness({ lastBackupAt: null, existing, fileName: "palmyra-backup-20260615-120000.bin" });
  const result = await runScheduledBackup(state.deps);

  assert.equal(result.removed.length, 3);
  for (const name of state.removed) {
    assert.match(name, /^palmyra-backup-[\w.-]+\.bin$/);
    assert.ok(!name.includes("foto"), "no se borran archivos ajenos");
    assert.ok(!name.endsWith(".pmybak"), "solo el patrón de Descargas entra en la rotación");
  }
});

test("la rotación prefiere savedAt y usa el nombre como desempate", () => {
  const newestWithoutDate: ScheduledBackupFile = {
    name: "palmyra-backup-20260615-120000.bin",
    bytes: 1,
    savedAt: null
  };
  const files: ScheduledBackupFile[] = [
    ...Array.from({ length: ANDROID_BACKUP_KEEP_LIMIT }, (_, index) => ({
      name: `palmyra-backup-2026060${index + 1}-000000.bin`,
      bytes: 1,
      savedAt: new Date(Date.UTC(2026, 5, index + 1)).toISOString()
    })),
    newestWithoutDate
  ];

  const toRemove = selectBackupsToRemove(files, newestWithoutDate.name);

  assert.equal(toRemove.length, 1);
  assert.equal(toRemove[0], "palmyra-backup-20260601-000000.bin");
  assert.ok(!toRemove.includes(newestWithoutDate.name), "el recién creado no se borra ni sin fecha");
});

test("una retención que falla no oculta el respaldo ya guardado", async () => {
  const state = harness({ lastBackupAt: null, existing: [deviceBackup(1)] });
  state.deps.list = async () => ({ ok: false, backups: [], error: "list_failed" });
  const result = await runScheduledBackup(state.deps);

  assert.equal(result.ran, true);
  assert.equal(result.error, "list_failed");
  assert.deepEqual(result.removed, []);
  assert.equal(SCHEDULED_BACKUP_INTERVAL_MS, 24 * HOUR);
});
