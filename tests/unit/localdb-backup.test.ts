import test from "node:test";
import assert from "node:assert/strict";

import { type LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { LOCAL_DB_VERSION } from "../../src/services/localDb/schema";
import {
  BACKUP_MIN_ITERATIONS,
  BACKUP_PAYLOAD_FORMAT,
  BackupError,
  canonicalJson,
  createBackup,
  createBackupResult,
  decryptBackupEnvelope,
  encryptBackupPayload,
  parseBackupEnvelope,
  pruneBackups,
  restoreBackup,
  utf8,
  type BackupRetentionEntry
} from "../../src/services/localDb/backup/index";

const PASSPHRASE = "frase de respaldo 2026";
const NOW = "2026-11-23T10:00:00.000Z";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function makeRow(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: "co-1",
    version: 1,
    updated_at: FIXED_NOW,
    origin_device: "dev-1",
    deleted_at: null,
    ...fields
  };
}

async function readyDriver() {
  const driver = createMemoryDriver({ now: () => FIXED_NOW });
  await driver.ready();
  return driver;
}

async function seed(driver: Awaited<ReturnType<typeof readyDriver>>) {
  await driver.put("products", [
    makeRow("p1", { name: "Arroz", price: 10 }),
    // Fila borrada lógicamente: debe viajar en el respaldo tal cual.
    makeRow("p2", { name: "Retirado", deleted_at: FIXED_NOW })
  ]);
  await driver.put("sales", [makeRow("s1", { total: 25, created_at: FIXED_NOW })]);
  await driver.put("outbox", [makeRow("o1", { status: "pending" })]);
}

async function dumpTables(driver: Awaited<ReturnType<typeof readyDriver>>) {
  const tables: Record<string, LocalRow[]> = {};
  for (const table of ["products", "sales", "outbox"] as const) {
    tables[table] = await driver.query<LocalRow>({ table, includeDeleted: true });
  }
  return tables;
}

function rejectsAs(code: string) {
  return (error: unknown) => error instanceof BackupError && error.code === code;
}

test("ida y vuelta: el respaldo cifrado restaura todas las tablas y filas borradas", async () => {
  const source = await readyDriver();
  await seed(source);

  const bytes = await createBackup({ driver: source, passphrase: PASSPHRASE, now: () => NOW });
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 100);

  const text = new TextDecoder().decode(bytes);
  const envelope = JSON.parse(text) as Record<string, unknown>;
  assert.equal(envelope.v, 1);
  assert.equal(envelope.kdf, "PBKDF2-SHA256");
  assert.ok(Number(envelope.iterations) >= BACKUP_MIN_ITERATIONS);
  for (const field of ["salt", "iv", "ciphertext"]) {
    assert.equal(typeof envelope[field], "string");
    assert.ok((envelope[field] as string).length > 0);
  }
  // El contenido no puede aparecer en claro en el archivo.
  assert.equal(text.includes("Arroz"), false);
  assert.equal(text.includes("co-1"), false);

  const target = await readyDriver();
  // Una fila previa que NO está en el respaldo debe desaparecer al restaurar.
  await target.put("products", [makeRow("viejo", { name: "No está en el respaldo" })]);

  const report = await restoreBackup({
    bytes,
    passphrase: PASSPHRASE,
    driver: target,
    now: () => NOW
  });

  assert.equal(report.createdAt, NOW);
  assert.equal(report.totalRows, 4);
  assert.equal(report.written, 4);
  assert.equal(report.removed, 1);
  assert.equal(report.schemaVersion, LOCAL_DB_VERSION);
  assert.match(report.hash, /^[a-f0-9]{64}$/);

  const before = await dumpTables(source);
  const after = await dumpTables(target);
  assert.deepEqual(after.products, before.products);
  assert.deepEqual(after.sales, before.sales);
  assert.deepEqual(after.outbox, before.outbox);
  assert.equal(await target.get("products", "viejo"), null);
});

test("el resumen incluye latestSeq y conteos por tabla", async () => {
  const driver = await readyDriver();
  await seed(driver);
  const expectedSeq = await driver.latestSeq();

  const result = await createBackupResult({ driver, passphrase: PASSPHRASE, now: () => NOW });
  assert.equal(result.summary.latestSeq, expectedSeq);
  assert.equal(result.summary.counts.products, 2);
  assert.equal(result.summary.counts.sales, 1);
  assert.equal(result.summary.counts.outbox, 1);
  assert.equal(result.summary.totalRows, 4);
  assert.match(result.summary.fileName, /^palmyra-respaldo-.*\.pmybak$/);
  assert.equal(result.summary.sizeBytes, result.bytes.byteLength);
});

test("una frase incorrecta no descifra ni escribe nada", async () => {
  const source = await readyDriver();
  await seed(source);
  const bytes = await createBackup({ driver: source, passphrase: PASSPHRASE, now: () => NOW });

  const target = await readyDriver();
  await target.put("products", [makeRow("p1", { name: "Intacto" })]);

  await assert.rejects(
    restoreBackup({ bytes, passphrase: "otra frase distinta", driver: target }),
    rejectsAs("decrypt_failed")
  );
  assert.equal((await target.get<LocalRow>("products", "p1"))?.name, "Intacto");
  assert.equal(await target.get("sales", "s1"), null);
});

test("un ciphertext manipulado falla la autenticación GCM", async () => {
  const driver = await readyDriver();
  await seed(driver);
  const bytes = await createBackup({ driver, passphrase: PASSPHRASE, now: () => NOW });

  const envelope = parseBackupEnvelope(bytes);
  const cipher = envelope.ciphertext;
  // Se cambia el último carácter base64 por otro válido y distinto.
  const tail = cipher.endsWith("A") ? "B" : "A";
  const tampered = { ...envelope, ciphertext: cipher.slice(0, -1) + tail };

  const target = await readyDriver();
  await assert.rejects(
    restoreBackup({
      bytes: utf8(JSON.stringify(tampered)),
      passphrase: PASSPHRASE,
      driver: target
    }),
    rejectsAs("decrypt_failed")
  );
  assert.equal(await target.latestSeq(), 0);
});

test("un cambio en la cabecera (iteraciones) también invalida el respaldo", async () => {
  const driver = await readyDriver();
  await seed(driver);
  const bytes = await createBackup({ driver, passphrase: PASSPHRASE, now: () => NOW });

  const envelope = parseBackupEnvelope(bytes);
  const tampered = { ...envelope, iterations: envelope.iterations + 1 };
  await assert.rejects(
    restoreBackup({ bytes: utf8(JSON.stringify(tampered)), passphrase: PASSPHRASE, driver: await readyDriver() }),
    rejectsAs("decrypt_failed")
  );
});

test("hash manipulado se rechaza antes de escribir", async () => {
  const driver = await readyDriver();
  await seed(driver);
  const bytes = await createBackup({ driver, passphrase: PASSPHRASE, now: () => NOW });

  const envelope = parseBackupEnvelope(bytes);
  const plaintext = await decryptBackupEnvelope(envelope, PASSPHRASE);
  const payload = JSON.parse(plaintext) as Record<string, unknown>;
  payload.totalRows = Number(payload.totalRows) + 1;
  const resigned = await encryptBackupPayload(canonicalJson(payload), PASSPHRASE);

  const target = await readyDriver();
  await assert.rejects(
    restoreBackup({ bytes: utf8(JSON.stringify(resigned)), passphrase: PASSPHRASE, driver: target }),
    rejectsAs("integrity_failed")
  );
  assert.equal(await target.latestSeq(), 0);
});

test("conteos inconsistentes con el contenido se rechazan", async () => {
  const driver = await readyDriver();
  await seed(driver);
  const bytes = await createBackup({ driver, passphrase: PASSPHRASE, now: () => NOW });

  const envelope = parseBackupEnvelope(bytes);
  const payload = JSON.parse(await decryptBackupEnvelope(envelope, PASSPHRASE)) as {
    counts: Record<string, number>;
  };
  payload.counts.products = 99;
  const resigned = await encryptBackupPayload(canonicalJson(payload), PASSPHRASE);

  await assert.rejects(
    restoreBackup({ bytes: utf8(JSON.stringify(resigned)), passphrase: PASSPHRASE, driver: await readyDriver() }),
    rejectsAs("integrity_failed")
  );
});

test("un respaldo de esquema futuro se rechaza con un mensaje claro", async () => {
  const payload = {
    format: BACKUP_PAYLOAD_FORMAT,
    schemaVersion: LOCAL_DB_VERSION + 1,
    createdAt: NOW,
    latestSeq: 0,
    meta: {},
    tables: {},
    counts: {},
    totalRows: 0,
    hash: "0".repeat(64)
  };
  const envelope = await encryptBackupPayload(canonicalJson(payload), PASSPHRASE, {
    iterations: BACKUP_MIN_ITERATIONS
  });

  const target = await readyDriver();
  await assert.rejects(
    restoreBackup({ bytes: utf8(JSON.stringify(envelope)), passphrase: PASSPHRASE, driver: target }),
    (error: unknown) => {
      assert.ok(error instanceof BackupError);
      assert.equal(error.code, "schema_too_new");
      assert.match(error.message, /Actualiza PALMYRA/);
      return true;
    }
  );
  assert.equal(await target.latestSeq(), 0);
});

test("la frase debe tener al menos 8 caracteres", async () => {
  const driver = await readyDriver();
  await assert.rejects(
    createBackup({ driver, passphrase: "corta" }),
    rejectsAs("invalid_passphrase")
  );
});

test("retención: se conservan 7 diarios y 4 semanales", () => {
  const reference = Date.parse("2026-11-23T12:00:00.000Z");
  const entries: BackupRetentionEntry[] = [];
  for (let daysAgo = 0; daysAgo < 40; daysAgo += 1) {
    const ms = reference - daysAgo * 86_400_000;
    entries.push({ id: `bk-${daysAgo}`, createdAt: new Date(ms).toISOString() });
  }

  const plan = pruneBackups(entries, new Date(reference));
  assert.equal(plan.keep.length, 7 + 4);
  assert.equal(plan.remove.length, entries.length - plan.keep.length);

  // Los 7 más recientes (un día cada uno) siempre sobreviven.
  const keptIds = new Set(plan.keep.map((entry) => entry.id));
  for (let daysAgo = 0; daysAgo < 7; daysAgo += 1) {
    assert.ok(keptIds.has(`bk-${daysAgo}`), `falta el respaldo diario bk-${daysAgo}`);
  }
  // No se conserva más de un respaldo por día.
  const keptDays = new Set(plan.keep.map((entry) => entry.createdAt.slice(0, 10)));
  assert.equal(keptDays.size, plan.keep.length);

  // Cuatro entradas en cuatro semanas distintas se conservan todas.
  const weekly: BackupRetentionEntry[] = [0, 7, 14, 21].map((daysAgo) => ({
    id: `w-${daysAgo}`,
    createdAt: new Date(reference - daysAgo * 86_400_000).toISOString()
  }));
  const weeklyPlan = pruneBackups(weekly, new Date(reference));
  assert.equal(weeklyPlan.keep.length, 4);
  assert.equal(weeklyPlan.remove.length, 0);

  // Entradas sin fecha válida no ocupan cupo y se descartan.
  const mixed = pruneBackups(
    [
      { id: "ok", createdAt: new Date(reference).toISOString() },
      { id: "roto", createdAt: "no-es-fecha" }
    ],
    new Date(reference)
  );
  assert.deepEqual(mixed.keep.map((entry) => entry.id), ["ok"]);
  assert.deepEqual(mixed.remove.map((entry) => entry.id), ["roto"]);
});
