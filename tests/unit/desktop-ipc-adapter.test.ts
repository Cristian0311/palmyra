import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopDbRequest, DesktopDbResult } from "../../src/lib/desktopRuntime";
import type { SqlValue } from "../../src/services/localDb/sqlite/adapter";
import { createNodeSqliteAdapter } from "../../src/services/localDb/sqlite/bindingNode";
import { createSqliteDriver } from "../../src/services/localDb/sqlite/driver";
import { createIpcSqliteAdapter } from "../../src/services/localDb/sqlite/ipcAdapter";

type Handler = (request: DesktopDbRequest) => Promise<DesktopDbResult>;

function makeBridge(handler: Handler) {
  const calls: DesktopDbRequest[] = [];
  return {
    calls,
    bridge: {
      invoke: async (request: DesktopDbRequest): Promise<DesktopDbResult> => {
        calls.push(request);
        return handler(request);
      }
    }
  };
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function toText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

test("exec, run y all traducen la llamada al puente y respetan close()", async () => {
  const { calls, bridge } = makeBridge(async (request) => {
    if (request.op === "exec") return { ok: true, changes: 0 };
    if (request.op === "run") return { ok: true, changes: 2 };
    if (request.op === "all") return { ok: true, rows: [{ id: "p1", name: "Café" }] };
    throw new Error("operación inesperada");
  });
  const adapter = createIpcSqliteAdapter(bridge);

  await adapter.exec("CREATE TABLE productos (id TEXT)");
  assert.deepEqual(calls[0], { op: "exec", sql: "CREATE TABLE productos (id TEXT)" });

  const run = await adapter.run("INSERT INTO productos VALUES (?)", ["p1", 1, null]);
  assert.equal(run.changes, 2);
  assert.deepEqual(calls[1], {
    op: "run",
    sql: "INSERT INTO productos VALUES (?)",
    params: ["p1", 1, null]
  });

  const rows = await adapter.all<{ id: string; name: string }>("SELECT * FROM productos");
  assert.deepEqual(rows, [{ id: "p1", name: "Café" }]);

  // close() es no-op: no habla con el puente y el adaptador sigue usable.
  adapter.close();
  assert.equal(calls.length, 3);
  await adapter.exec("PRAGMA user_version");
  assert.equal(calls.length, 4);
});

test("los binarios viajan como {b64} en params y vuelven como Uint8Array", async () => {
  const payload = new Uint8Array([0, 1, 2, 250, 251, 252]);
  const { calls, bridge } = makeBridge(async (request) => {
    if (request.op === "run") return { ok: true, changes: 1 };
    return {
      ok: true,
      rows: [{ id: "blob-1", data: { b64: toBase64("contenido binario") } }]
    };
  });
  const adapter = createIpcSqliteAdapter(bridge);

  await adapter.run("INSERT INTO adjuntos VALUES (?)", [payload]);
  const sent = calls[0];
  assert.equal(sent.op, "run");
  const encoded = sent.op === "run" ? sent.params?.[0] : undefined;
  assert.deepEqual(encoded, { b64: Buffer.from(payload).toString("base64") });

  const rows = await adapter.all<{ id: string; data: Uint8Array }>("SELECT * FROM adjuntos");
  assert.equal(rows[0].id, "blob-1");
  assert.ok(rows[0].data instanceof Uint8Array);
  assert.equal(toText(rows[0].data), "contenido binario");
});

test("un rechazo del puente se propaga con su texto", async () => {
  const { bridge } = makeBridge(async () => ({ ok: false, error: "disco lleno" }));
  const adapter = createIpcSqliteAdapter(bridge);
  await assert.rejects(adapter.run("INSERT INTO x VALUES (?)", ["a"]), /disco lleno/);

  const broken = {
    invoke: async (): Promise<DesktopDbResult> => {
      throw new Error("puente roto");
    }
  };
  const adapter2 = createIpcSqliteAdapter(broken);
  await assert.rejects(adapter2.all("SELECT 1"), /puente roto/);
});

test("una forma inesperada del puente se convierte en error controlado", async () => {
  const allBridge = makeBridge(async () => ({ ok: true, changes: 0 }));
  await assert.rejects(
    createIpcSqliteAdapter(allBridge.bridge).all("SELECT 1"),
    /respuesta inesperada en all/
  );

  const runBridge = makeBridge(async () => ({ ok: true, rows: [] }));
  await assert.rejects(
    createIpcSqliteAdapter(runBridge.bridge).run("SELECT 1"),
    /respuesta inesperada en run/
  );
});

test("una invocación que nunca resuelve agota el tiempo máximo", async () => {
  const never = { invoke: (): Promise<DesktopDbResult> => new Promise<DesktopDbResult>(() => {}) };
  const adapter = createIpcSqliteAdapter(never, { timeoutMs: 25 });
  await assert.rejects(adapter.exec("PRAGMA user_version"), /no respondió en 25 ms/);
});

test("el driver SQLite opera completo sobre un adaptador asíncrono, como el puente IPC", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "palmyra-async-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "desktop.db");
  const sync = await createNodeSqliteAdapter(filePath);
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const asyncAdapter = {
    async exec(sql: string) {
      await tick();
      sync.exec(sql);
    },
    async run(sql: string, params?: SqlValue[]) {
      await tick();
      return sync.run(sql, params);
    },
    async all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]) {
      await tick();
      return sync.all<T>(sql, params);
    },
    async close() {
      sync.close();
    }
  };

  const driver = await createSqliteDriver({ adapter: asyncAdapter, filePath });
  const row = {
    id: "p-1",
    company_id: "co-1",
    version: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
    origin_device: "dev-1",
    deleted_at: null,
    name: "Café"
  };
  assert.equal(await driver.put("products", [row]), 1);
  assert.equal((await driver.get<typeof row>("products", "p-1"))?.name, "Café");

  await driver.transaction(async (tx) => {
    await tx.put("products", [{ ...row, id: "p-2", name: "Té" }]);
    assert.equal((await tx.get<typeof row>("products", "p-2"))?.name, "Té");
  });

  const rows = await driver.query({ table: "products", orderBy: { field: "id", direction: "asc" } });
  assert.deepEqual(rows.map((item) => item.id), ["p-1", "p-2"]);
  assert.equal(await driver.latestSeq(), 2);
  assert.equal((await driver.changes(0)).length, 2);
  await driver.close();
});
