import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { createDbMain } = requireCjs("../../electron/dbMain.cjs");

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-db-"));
  return path.join(dir, "palmyra.db");
}

async function openDb(filePath: string) {
  const db = createDbMain({ filePath });
  await db.init();
  return db;
}

async function query(db: any, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const request = params ? { op: "all", sql, params } : { op: "all", sql };
  const result = await db.invoke("renderer", request);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.rows as Record<string, unknown>[];
}

test("crea la base, inserta con comillas y conserva los datos al reabrir", async () => {
  const filePath = tempDbPath();
  const db = await openDb(filePath);
  const status = db.status();
  assert.equal(status.ready, true);
  assert.equal(status.driver, "sqljs");
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.lastError, "");

  const created = await db.invoke("renderer", {
    op: "exec",
    sql: "CREATE TABLE notas (id TEXT PRIMARY KEY, texto TEXT, peso REAL)"
  });
  assert.equal(created.ok, true);

  const inserted = await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO notas (id, texto, peso) VALUES (?, ?, ?)",
    params: ["a", "o'brien dijo \"hola\";", 1.5]
  });
  assert.deepEqual(inserted, { ok: true, changes: 1 });

  const rows = await query(db, "SELECT id, texto, peso FROM notas ORDER BY id");
  assert.deepEqual(rows, [{ id: "a", texto: "o'brien dijo \"hola\";", peso: 1.5 }]);

  assert.equal(db.flush(), true);
  assert.ok(db.status().lastWriteAt > 0);
  assert.ok(fs.statSync(filePath).size > 0);

  const reopened = await openDb(filePath);
  const again = await query(reopened, "SELECT texto FROM notas");
  assert.deepEqual(again, [{ texto: "o'brien dijo \"hola\";" }]);
});

test("transporta binarios como b64 sin perder bytes", async () => {
  const filePath = tempDbPath();
  const db = await openDb(filePath);
  await db.invoke("renderer", { op: "exec", sql: "CREATE TABLE archivos (id TEXT PRIMARY KEY, datos BLOB)" });

  const bytes = Buffer.from([0, 1, 2, 127, 128, 250, 255]);
  const inserted = await db.invoke("renderer", {
    op: "run",
    sql: "INSERT INTO archivos (id, datos) VALUES (?, ?)",
    params: ["f1", { b64: bytes.toString("base64") }]
  });
  assert.equal(inserted.ok, true);

  const rows = await query(db, "SELECT datos FROM archivos WHERE id = ?", ["f1"]);
  assert.deepEqual(rows, [{ datos: { b64: bytes.toString("base64") } }]);
});

test("una transacción revertida no deja filas ni llega al disco", async () => {
  const filePath = tempDbPath();
  const db = await openDb(filePath);
  await db.invoke("renderer", { op: "exec", sql: "CREATE TABLE notas (id TEXT PRIMARY KEY)" });

  assert.equal((await db.invoke("renderer", { op: "exec", sql: "BEGIN IMMEDIATE" })).ok, true);
  assert.equal(
    (await db.invoke("renderer", { op: "run", sql: "INSERT INTO notas (id) VALUES (?)", params: ["tx"] })).ok,
    true
  );
  assert.equal((await db.invoke("renderer", { op: "exec", sql: "ROLLBACK" })).ok, true);
  assert.deepEqual(await query(db, "SELECT COUNT(*) AS total FROM notas"), [{ total: 0 }]);

  db.flush();
  const reopened = await openDb(filePath);
  assert.deepEqual(await query(reopened, "SELECT COUNT(*) AS total FROM notas"), [{ total: 0 }]);
});

test("una transacción del renderer bloquea al hub hasta el COMMIT", async () => {
  const filePath = tempDbPath();
  const db = await openDb(filePath);
  await db.invoke("renderer", { op: "exec", sql: "CREATE TABLE notas (id TEXT PRIMARY KEY)" });

  assert.equal((await db.invoke("renderer", { op: "exec", sql: "BEGIN IMMEDIATE" })).ok, true);
  await db.invoke("renderer", { op: "run", sql: "INSERT INTO notas (id) VALUES (?)", params: ["tx"] });

  let hubFinished = false;
  const hubRead = db
    .invoke("hub", { op: "all", sql: "SELECT id FROM notas" })
    .then((result: any) => {
      hubFinished = true;
      return result;
    });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hubFinished, false, "el hub no debe leer dentro de la transacción del renderer");

  assert.equal((await db.invoke("renderer", { op: "exec", sql: "COMMIT" })).ok, true);
  const result = await hubRead;
  assert.equal(hubFinished, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [{ id: "tx" }]);
});

test("flush persiste aunque no haya cambios pendientes", async () => {
  const filePath = tempDbPath();
  const db = await openDb(filePath);
  await db.invoke("renderer", { op: "exec", sql: "CREATE TABLE notas (id TEXT PRIMARY KEY)" });
  const before = db.status().lastWriteAt;

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.flush(), true);
  assert.ok(db.status().lastWriteAt >= before);
  assert.ok(db.status().sizeBytes > 0);
});

test("rechaza peticiones fuera del contrato sin lanzar", async () => {
  const db = await openDb(tempDbPath());

  const badOp = await db.invoke("renderer", { op: "drop" });
  assert.equal(badOp.ok, false);
  assert.equal(typeof badOp.error, "string");

  const longSql = await db.invoke("renderer", { op: "exec", sql: "SELECT 1;".repeat(30000) });
  assert.equal(longSql.ok, false);

  const badParam = await db.invoke("renderer", { op: "all", sql: "SELECT ?", params: [{ nope: true }] });
  assert.equal(badParam.ok, false);

  const badSource = await db.invoke("intruso", { op: "status" });
  assert.equal(badSource.ok, false);

  const brokenSql = await db.invoke("renderer", { op: "all", sql: "SELECT * FROM tabla_inexistente" });
  assert.equal(brokenSql.ok, false);
  assert.ok(String(brokenSql.error).length <= 200);
});
