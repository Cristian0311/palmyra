import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  BINARY_BACKUP_KIND,
  BINARY_SNAPSHOT_MAX_BYTES,
  binaryBackupCapability,
  createBinarySnapshot,
  isSqliteFile,
  readBinaryBackup,
  restoreBinarySnapshot,
  snapshotToBackupBytes,
  tryCreateBinaryBackup,
  validateBinaryRestore
} from "../../src/services/localDb/backup/binary";
import { BackupError, decryptBackupEnvelope, parseBackupEnvelope } from "../../src/services/localDb/backup/format";

const requireCjs = createRequire(import.meta.url);
const { createDbMain } = requireCjs("../../electron/dbMain.cjs");

const SQLITE_HEADER = "SQLite format 3\u0000";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-bin-"));
  return path.join(dir, "palmyra.db");
}

async function openDb(filePath: string, extra: Record<string, unknown> = {}): Promise<any> {
  const db = createDbMain({ filePath, ...extra });
  await db.init();
  return db;
}

async function query(db: any, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const request = params ? { op: "all", sql, params } : { op: "all", sql };
  const result = await db.invoke("renderer", request);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.rows as Record<string, unknown>[];
}

function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function sqliteImage(extra?: Buffer): Buffer {
  return Buffer.concat([Buffer.from(SQLITE_HEADER, "latin1"), Buffer.alloc(200, 3), extra ?? Buffer.alloc(0)]);
}

async function seed(db: any): Promise<void> {
  await db.invoke("renderer", { op: "exec", sql: "CREATE TABLE notas (id TEXT PRIMARY KEY, texto TEXT)" });
  await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO notas (id, texto) VALUES (?, ?)",
    params: ["antes", "guardado en la imagen"]
  });
  // Journal local mínimo: el respaldo debe declarar el mismo seq que la imagen.
  await db.invoke("renderer", {
    op: "exec",
    sql: "CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)"
  });
  await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO _meta (key, value) VALUES (?, ?)",
    params: ["seq", "41"]
  });
  await db.invoke("renderer", {
    op: "exec",
    sql: "CREATE TABLE _changes (seq INTEGER PRIMARY KEY, table_name TEXT)"
  });
  await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO _changes (seq, table_name) VALUES (?, ?)",
    params: [42, "notas"]
  });
}

/* ------------------------------------------------------------------ */
/* IPC del proceso principal (snapshot / restore)                      */
/* ------------------------------------------------------------------ */

test("exporta bytesBase64, hash y latestSeq, y restaura la imagen completa", async () => {
  const filePath = tempDbPath();
  const db = await openDb(filePath);
  await seed(db);

  const snapshot = await db.snapshotBinary();
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const bytes = Buffer.from(snapshot.bytesBase64, "base64");
  assert.equal(bytes.length, snapshot.size);
  assert.equal(bytes.subarray(0, 16).toString("latin1"), SQLITE_HEADER);
  assert.equal(sha256Hex(bytes), snapshot.sha256);
  assert.equal(snapshot.latestSeq, 42);

  // Cambio posterior al respaldo: debe desaparecer al restaurar.
  await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO notas (id, texto) VALUES (?, ?)",
    params: ["despues", "no debe sobrevivir"]
  });
  assert.deepEqual(
    (await query(db, "SELECT id FROM notas ORDER BY id")).map((row) => row.id),
    ["antes", "despues"]
  );

  const restored = await db.restoreBinary({
    bytesBase64: snapshot.bytesBase64,
    expectedSha256: snapshot.sha256
  });
  assert.deepEqual(restored, {
    ok: true,
    restartRequired: true,
    size: snapshot.size,
    sha256: snapshot.sha256,
    latestSeq: 42
  });
  assert.deepEqual(
    (await query(db, "SELECT id FROM notas ORDER BY id")).map((row) => row.id),
    ["antes"]
  );
  assert.equal(db.status().ready, true);
  assert.equal(db.status().lastError, "");

  // El archivo real también quedó reemplazado de forma atómica.
  const reopened = await openDb(filePath);
  assert.deepEqual(
    (await query(reopened, "SELECT id FROM notas ORDER BY id")).map((row) => row.id),
    ["antes"]
  );
});

test("tras restaurar, el motor y el disco siguen coherentes para escrituras nuevas", async () => {
  const filePath = tempDbPath();
  const db = await openDb(filePath);
  await seed(db);
  const snapshot = await db.snapshotBinary();
  assert.equal(snapshot.ok, true);

  await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO notas (id, texto) VALUES (?, ?)",
    params: ["despues", "se pierde"]
  });
  const restored = await db.restoreBinary({
    bytesBase64: snapshot.bytesBase64,
    expectedSha256: snapshot.sha256
  });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(db.status().schemaVersion, 1);
  assert.equal(db.status().ready, true);

  // La secuencia restaurada se conserva y una escritura posterior se persiste.
  assert.equal((await db.snapshotBinary()).latestSeq, 42);
  await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO notas (id, texto) VALUES (?, ?)",
    params: ["posterior", "sobrevive al reinicio"]
  });
  const reopened = await openDb(filePath);
  assert.deepEqual(
    (await query(reopened, "SELECT id FROM notas ORDER BY id")).map((row) => row.id),
    ["antes", "posterior"]
  );
  assert.equal(db.status().lastError, "");
});

test("rechaza una restauración cuyo hash no coincide y no toca la base", async () => {
  const db = await openDb(tempDbPath());
  await seed(db);
  const snapshot = await db.snapshotBinary();
  assert.equal(snapshot.ok, true);

  await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO notas (id, texto) VALUES (?, ?)",
    params: ["actual", "debe seguir"]
  });

  const result = await db.restoreBinary({
    bytesBase64: snapshot.bytesBase64,
    expectedSha256: "0".repeat(64)
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /hash/i);
  assert.deepEqual(
    (await query(db, "SELECT id FROM notas ORDER BY id")).map((row) => row.id),
    ["actual", "antes"]
  );
});

test("rechaza cargas que no son SQLite y hashes mal formados", async () => {
  const db = await openDb(tempDbPath());
  const payload = Buffer.from("esto no es una base de datos SQLite, solo texto plano", "utf8");

  const notSqlite = await db.restoreBinary({
    bytesBase64: payload.toString("base64"),
    expectedSha256: sha256Hex(payload)
  });
  assert.equal(notSqlite.ok, false);
  assert.match(String(notSqlite.error), /SQLite/i);

  const badHash = await db.restoreBinary({ bytesBase64: payload.toString("base64"), expectedSha256: "xyz" });
  assert.equal(badHash.ok, false);
  assert.match(String(badHash.error), /hash/i);
});

test("rechaza una imagen por encima del tamaño máximo configurado", async () => {
  const db = await openDb(tempDbPath(), { maxBinaryBytes: 1024 });
  const tooBig = Buffer.alloc(4096, 7);
  const result = await db.restoreBinary({
    bytesBase64: tooBig.toString("base64"),
    expectedSha256: sha256Hex(tooBig)
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /tamaño máximo/i);
});

test("el hub LAN en servicio bloquea la restauración con busy", async () => {
  const source = await openDb(tempDbPath());
  await seed(source);
  const snapshot = await source.snapshotBinary();
  assert.equal(snapshot.ok, true);

  const target = await openDb(tempDbPath(), { isHubBusy: () => true });
  const result = await target.restoreBinary({
    bytesBase64: snapshot.bytesBase64,
    expectedSha256: snapshot.sha256
  });
  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
  assert.match(String(result.error), /hub LAN/i);
});

test("no exporta la imagen con una transacción abierta", async () => {
  const db = await openDb(tempDbPath());
  await seed(db);
  assert.equal((await db.invoke("renderer", { op: "exec", sql: "BEGIN IMMEDIATE" })).ok, true);

  const snapshot = await db.snapshotBinary();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.busy, true);

  assert.equal((await db.invoke("renderer", { op: "exec", sql: "ROLLBACK" })).ok, true);
  const after = await db.snapshotBinary();
  assert.equal(after.ok, true);
});

/* ------------------------------------------------------------------ */
/* Helpers puros                                                       */
/* ------------------------------------------------------------------ */

test("isSqliteFile y validateBinaryRestore validan cabecera y tamaño", () => {
  const good = sqliteImage();
  assert.equal(isSqliteFile(good), true);
  assert.equal(isSqliteFile(Buffer.alloc(64, 1)), false);
  assert.equal(isSqliteFile(Buffer.from(SQLITE_HEADER).subarray(0, 15)), false);
  assert.equal(isSqliteFile(Buffer.from(SQLITE_HEADER)), true);
  assert.equal(isSqliteFile("SQLite format 3"), false);
  assert.equal(isSqliteFile(null), false);

  assert.deepEqual(validateBinaryRestore(good), { ok: true, size: good.length });
  assert.equal(validateBinaryRestore(Buffer.alloc(0)).ok, false);
  assert.equal(validateBinaryRestore(Buffer.from("no-sqlite")).ok, false);
  assert.equal(validateBinaryRestore("texto").ok, false);
  const oversize = validateBinaryRestore(good, { maxBytes: 16 });
  assert.equal(oversize.ok, false);
  assert.match(String(oversize.error), /límite/i);
  assert.equal(validateBinaryRestore(good, { maxBytes: BINARY_SNAPSHOT_MAX_BYTES }).ok, true);
});

/* ------------------------------------------------------------------ */
/* Sobre cifrado sobre bytes binarios                                  */
/* ------------------------------------------------------------------ */

test("snapshotToBackupBytes y readBinaryBackup hacen ida/vuelta con bytes binarios", async () => {
  const db = await openDb(tempDbPath());
  await seed(db);
  const snapshot = await db.snapshotBinary();
  assert.equal(snapshot.ok, true);

  const backup = await snapshotToBackupBytes({
    snapshot,
    passphrase: "frase-de-prueba-segura",
    meta: { appVersion: "1.3.5", schemaVersion: 1 },
    iterations: 310_000,
    now: () => "2026-11-23T10:00:00.000Z"
  });
  assert.equal(backup.summary.kind, BINARY_BACKUP_KIND);
  assert.equal(backup.summary.size, snapshot.size);
  assert.equal(backup.summary.sha256, snapshot.sha256);
  assert.equal(backup.summary.latestSeq, 42);
  assert.equal(backup.summary.appVersion, "1.3.5");

  // Es el mismo sobre del respaldo lógico: JSON con versión/KDF/IV/ciphertext.
  const envelope = parseBackupEnvelope(backup.bytes);
  assert.equal(envelope.v, 1);
  assert.equal(envelope.kdf, "PBKDF2-SHA256");
  assert.ok(envelope.ciphertext.length > 0);
  const outer = JSON.parse(new TextDecoder().decode(backup.bytes)) as Record<string, unknown>;
  assert.equal(outer.kind, BINARY_BACKUP_KIND);

  const read = await readBinaryBackup({ bytes: backup.bytes, passphrase: "frase-de-prueba-segura" });
  assert.equal(read.summary.size, snapshot.size);
  assert.equal(read.summary.sha256, snapshot.sha256);
  assert.equal(read.summary.latestSeq, 42);
  assert.equal(read.summary.appVersion, "1.3.5");
  assert.equal(sha256Hex(read.image), snapshot.sha256);
  assert.equal(Buffer.from(read.image.subarray(0, 16)).toString("latin1"), SQLITE_HEADER);

  // La imagen descifrada restaura exactamente lo mismo que la exportación directa.
  const restored = await db.restoreBinary({
    bytesBase64: Buffer.from(read.image).toString("base64"),
    expectedSha256: read.summary.sha256
  });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.latestSeq, 42);
});

test("el sobre binario rechaza frase incorrecta y contenido que no es SQLite", async () => {
  const image = sqliteImage(Buffer.alloc(64, 9));
  const snapshot = {
    ok: true as const,
    bytesBase64: image.toString("base64"),
    size: image.length,
    sha256: sha256Hex(image),
    latestSeq: 0
  };
  const backup = await snapshotToBackupBytes({ snapshot, passphrase: "frase-de-prueba-segura" });

  await assert.rejects(
    () => readBinaryBackup({ bytes: backup.bytes, passphrase: "otra-frase-distinta" }),
    (error: unknown) => error instanceof BackupError && error.code === "decrypt_failed"
  );

  const notSqlite = Buffer.from("contenido plano que no es una base de datos", "utf8");
  await assert.rejects(
    () =>
      snapshotToBackupBytes({
        snapshot: {
          ok: true,
          bytesBase64: notSqlite.toString("base64"),
          size: notSqlite.length,
          sha256: sha256Hex(notSqlite),
          latestSeq: 0
        },
        passphrase: "frase-de-prueba-segura"
      }),
    (error: unknown) => error instanceof BackupError && /SQLite/i.test(error.message)
  );

  // Un respaldo lógico (sin `kind: sqlite-binary`) no se acepta como binario.
  const envelope = parseBackupEnvelope(backup.bytes);
  const plaintext = await decryptBackupEnvelope(envelope, "frase-de-prueba-segura");
  assert.match(plaintext, /sqlite-binary/);
});

test("el hash declarado por el snapshot se recombina antes de cifrar", async () => {
  const image = sqliteImage();
  const snapshot = {
    ok: true as const,
    bytesBase64: image.toString("base64"),
    size: image.length,
    sha256: "f".repeat(64),
    latestSeq: 0
  };
  await assert.rejects(
    () => snapshotToBackupBytes({ snapshot, passphrase: "frase-de-prueba-segura" }),
    (error: unknown) => error instanceof BackupError && error.code === "integrity_failed"
  );
});

/* ------------------------------------------------------------------ */
/* Puente del preload                                                  */
/* ------------------------------------------------------------------ */

test("sin puente de escritorio el respaldo binario no está disponible y nunca lanza", async () => {
  const capability = binaryBackupCapability();
  assert.equal(capability.available, false);
  assert.equal(typeof capability.reason, "string");

  const snapshot = await createBinarySnapshot();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.unavailable, true);

  const restore = await restoreBinarySnapshot({ bytesBase64: "", expectedSha256: "" });
  assert.equal(restore.ok, false);
  assert.equal(restore.unavailable, true);

  assert.equal(await tryCreateBinaryBackup(), null);
});

test("con puente simulado valida forma, latestSeq y hash antes de cruzar el IPC", async () => {
  const image = sqliteImage(Buffer.alloc(120, 1));
  const bytesBase64 = image.toString("base64");
  const sha256 = sha256Hex(image);
  const calls: string[] = [];

  (globalThis as { window?: unknown }).window = {
    palmyraDbSnapshot: async () => {
      calls.push("snapshot");
      return { ok: true, bytesBase64, size: image.length, sha256, latestSeq: 7 };
    },
    palmyraDbRestore: async (request: { bytesBase64: string; expectedSha256: string }) => {
      calls.push("restore");
      return {
        ok: true,
        restartRequired: true,
        size: request.bytesBase64.length,
        sha256: request.expectedSha256,
        latestSeq: 7
      };
    }
  };

  try {
    assert.equal(binaryBackupCapability().available, true);

    const snapshot = await createBinarySnapshot({ driver: { kind: "sqlite" } });
    assert.deepEqual(snapshot, { ok: true, bytesBase64, size: image.length, sha256, latestSeq: 7 });

    const blocked = await createBinarySnapshot({ driver: { kind: "indexeddb" } });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.unavailable, true);

    assert.deepEqual(await tryCreateBinaryBackup(), new Uint8Array(image));

    const badHash = await restoreBinarySnapshot({ bytesBase64, expectedSha256: "no-es-hash" });
    assert.equal(badHash.ok, false);
    // createBinarySnapshot + tryCreateBinaryBackup: aún ninguna restauración.
    assert.deepEqual(calls, ["snapshot", "snapshot"]);

    const restored = await restoreBinarySnapshot({ bytesBase64, expectedSha256: sha256 });
    assert.equal(restored.ok, true);
    assert.equal(restored.restartRequired, true);
    assert.equal(restored.latestSeq, 7);
    assert.deepEqual(calls, ["snapshot", "snapshot", "restore"]);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
