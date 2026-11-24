import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createCloudSync } from "../../src/services/cloudSync/sync";
import {
  PULL_BATCH,
  PULL_INTERVAL_MS,
  PULL_MAX_DAYS,
  MAX_REMOTE_ROW_BYTES,
  createSupabasePullTransport,
  inclusiveSince,
  localTableForCloud,
  readPullPayload,
  type RemotePullRequest,
  type RemotePullResult,
  type RemotePullTransport
} from "../../src/services/cloudSync/pullRemote";
import { createCloudPull, type PullOutcome } from "../../src/services/cloudSync/pullEngine";
import { createCloudSyncRunner } from "../../src/services/cloudSync/runner";
import {
  createLocalStoragePullCursorStore,
  createMemoryPullCursorStore,
  createMemoryCursorStore,
  createMemoryBudgetStore,
  type CloudStorage
} from "../../src/services/cloudSync/stores";
import type { PullCursorState } from "../../src/services/cloudSync/contract";
import type { CloudRpcClient, CloudRpcResult } from "../../src/services/cloudSync/supabaseTransport";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const OTHER_COMPANY = "22222222-2222-2222-2222-222222222222";
const START_MS = Date.parse("2026-06-01T08:00:00.000Z");

function at(minutes: number): string {
  return new Date(START_MS + minutes * 60_000).toISOString();
}

interface TestClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

function makeClock(start = START_MS): TestClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    }
  };
}

function makeRow(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: at(0),
    origin_device: "dev-1",
    deleted_at: null,
    name: `fila-${id}`,
    ...fields
  } as LocalRow;
}

async function makeDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => at(120) });
  await driver.ready();
  return driver;
}

interface FakeTransport extends RemotePullTransport {
  calls: RemotePullRequest[];
}

function makeTransport(
  result: RemotePullResult | (() => RemotePullResult)
): FakeTransport {
  const calls: RemotePullRequest[] = [];
  return {
    calls,
    async pull(request: RemotePullRequest): Promise<RemotePullResult> {
      calls.push(request);
      return typeof result === "function" ? result() : result;
    }
  };
}

function change(id: string, updatedAt: string, fields: Record<string, unknown> = {}) {
  return {
    table: "products" as const,
    rowId: id,
    op: "upsert" as const,
    row: makeRow(id, { updated_at: updatedAt, ...fields }),
    updatedAt
  };
}

interface ReportRecord {
  route: string;
  ok?: boolean;
  ms?: number;
}

function makeReporter(): { records: ReportRecord[]; report: (route: string, outcome: { ms?: number; ok?: boolean }) => void } {
  const records: ReportRecord[] = [];
  return {
    records,
    report: (route, outcome) => {
      records.push({ route, ok: outcome.ok, ms: outcome.ms });
    }
  };
}

function makeEngine(options: {
  driver: LocalDbDriver;
  transport: RemotePullTransport;
  cursors: ReturnType<typeof createMemoryPullCursorStore>;
  clock: TestClock;
  budgetTotal?: () => number;
  report?: (route: string, outcome: { ms?: number; ok?: boolean }) => void;
  companyId?: string;
}) {
  return createCloudPull({
    driver: options.driver,
    transport: options.transport,
    cursors: options.cursors,
    companyId: options.companyId ?? COMPANY,
    now: () => options.clock.now(),
    isOnline: () => true,
    budgetTotal: options.budgetTotal ?? (() => 0),
    report: options.report
  });
}

test("el cursor solo avanza cuando el lote se aplicó completo", async () => {
  const driver = await makeDriver();
  const cursors = createMemoryPullCursorStore();
  await cursors.save(COMPANY, { cursor: at(0), updatedAt: null });
  const clock = makeClock();
  const transport = makeTransport({
    changes: [change("p1", at(5), { name: "remoto" })],
    nextCursor: at(5),
    hasMore: false
  });
  const { records, report } = makeReporter();
  const pull = makeEngine({ driver, transport, cursors, clock, report });

  const outcome = await pull.pullOnce({ manual: true });

  assert.equal(outcome.status, "pulled");
  assert.equal(outcome.applied, 1);
  assert.equal(outcome.cursor, at(5));
  assert.deepEqual(transport.calls[0], { companyId: COMPANY, cursor: at(0), limit: PULL_BATCH });
  assert.deepEqual(await cursors.load(COMPANY), { cursor: at(5), updatedAt: START_MS });
  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored?.name, "remoto");
  assert.equal(stored?.version, 1);
  assert.deepEqual(records, [{ route: "cloud/pull", ok: true, ms: 0 }]);
});

test("un error deja el cursor intacto y no consume la cadencia", async () => {
  const driver = await makeDriver();
  const cursors = createMemoryPullCursorStore();
  await cursors.save(COMPANY, { cursor: at(0), updatedAt: null });
  const clock = makeClock();
  const transport = makeTransport({
    changes: [],
    nextCursor: null,
    hasMore: false,
    error: "No se pudo descargar de la nube: sin red"
  });
  const { records, report } = makeReporter();
  const pull = makeEngine({ driver, transport, cursors, clock, report });

  const outcome = await pull.pullOnce();

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.applied, 0);
  assert.equal(outcome.error, "No se pudo descargar de la nube: sin red");
  assert.deepEqual(await cursors.load(COMPANY), { cursor: at(0), updatedAt: null });
  assert.deepEqual(records, [{ route: "cloud/pull", ok: false, ms: 0 }]);

  // Sin `updatedAt` persistido, el siguiente intento no queda bloqueado.
  const retry = await pull.pullOnce();
  assert.equal(retry.status, "failed");
  assert.equal(transport.calls.length, 2);
});

test("el lote se corta en el límite pedido y marca hasMore", async () => {
  const payload = {
    changes: ["p1", "p2", "p3"].map((id) => ({
      table: "products",
      row_id: id,
      op: "upsert",
      row: makeRow(id, { updated_at: at(5) }),
      updated_at: at(5)
    })),
    nextCursor: at(5),
    hasMore: false
  };

  const result = readPullPayload(payload, COMPANY, null, 2);

  assert.equal(result.changes.length, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.rejected, 1);
  assert.equal(result.error, undefined);
});

test("repetir la misma fila es un no-op y no reescribe el almacén", async () => {
  const driver = await makeDriver();
  const cursors = createMemoryPullCursorStore();
  const clock = makeClock();
  const transport = makeTransport({
    changes: [change("p1", at(5), { name: "remoto" })],
    nextCursor: at(5),
    hasMore: false
  });
  const pull = makeEngine({ driver, transport, cursors, clock });

  const first = await pull.pullOnce({ manual: true });
  assert.equal(first.status, "pulled");
  const seqAfterFirst = await driver.latestSeq();

  const second = await pull.pullOnce({ manual: true });
  assert.equal(second.status, "idle");
  assert.equal(second.applied, 0);
  assert.equal(second.skipped, 1);
  assert.equal(await driver.latestSeq(), seqAfterFirst);
  assert.equal(second.cursor, at(5));
});

test("las filas de otra empresa se rechazan antes de tocar el almacén", async () => {
  const driver = await makeDriver();
  const payload = {
    changes: [
      {
        table: "products",
        row_id: "p1",
        op: "upsert",
        row: makeRow("p1", { company_id: OTHER_COMPANY, updated_at: at(30) }),
        updated_at: at(30)
      },
      {
        table: "products",
        row_id: "p2",
        op: "upsert",
        row: makeRow("p2", { company_id: "", updated_at: at(30) }),
        updated_at: at(30)
      }
    ],
    nextCursor: at(30),
    hasMore: false
  };

  const result = readPullPayload(payload, COMPANY, null, PULL_BATCH);

  assert.deepEqual(result.changes, []);
  assert.equal(result.rejected, 2);
  assert.equal(await driver.latestSeq(), 0);

  // Defensa en profundidad: el aplicador LWW también rechaza filas ajenas.
  const cursors = createMemoryPullCursorStore();
  const pull = makeEngine({
    driver,
    cursors,
    clock: makeClock(),
    transport: makeTransport({
      changes: [{ ...change("p1", at(30)), row: makeRow("p1", { company_id: OTHER_COMPANY, updated_at: at(30) }) }],
      nextCursor: at(30),
      hasMore: false
    })
  });
  const outcome = await pull.pullOnce({ manual: true });
  assert.equal(outcome.applied, 0);
  assert.equal(outcome.conflicts, 1);
  assert.equal(await driver.get("products", "p1"), null);
});

test("un tombstone remoto borra la fila local y queda en el journal", async () => {
  const driver = await makeDriver();
  await driver.put("products", [makeRow("p1", { updated_at: at(0) })]);
  const cursors = createMemoryPullCursorStore();
  const clock = makeClock();
  const transport = makeTransport({
    changes: [
      {
        table: "products",
        rowId: "p1",
        op: "delete",
        row: makeRow("p1", { updated_at: at(20), deleted_at: at(20) }),
        updatedAt: at(20)
      }
    ],
    nextCursor: at(20),
    hasMore: false
  });
  const pull = makeEngine({ driver, transport, cursors, clock });

  const outcome = await pull.pullOnce({ manual: true });

  assert.equal(outcome.applied, 1);
  assert.equal(await driver.get("products", "p1"), null);
  const journal = await driver.changes(0, 100);
  const last = journal[journal.length - 1];
  assert.equal(last.op, "delete");
  assert.equal(last.row_id, "p1");
});

test("el pull nunca pisa una fila local más nueva", async () => {
  const driver = await makeDriver();
  await driver.put("products", [makeRow("p1", { version: 4, updated_at: at(60), name: "local-gana" })]);
  const cursors = createMemoryPullCursorStore();
  const pull = makeEngine({
    driver,
    cursors,
    clock: makeClock(),
    transport: makeTransport({
      changes: [change("p1", at(10), { name: "remoto-viejo" })],
      nextCursor: at(10),
      hasMore: false
    })
  });

  const outcome = await pull.pullOnce({ manual: true });

  assert.equal(outcome.applied, 0);
  assert.equal(outcome.conflicts, 1);
  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored?.name, "local-gana");
  assert.equal(stored?.version, 4);
});

test("la cadencia de 30 minutos se respeta entre descargas programadas", async () => {
  const driver = await makeDriver();
  const cursors = createMemoryPullCursorStore();
  const clock = makeClock();
  const transport = makeTransport({
    changes: [],
    nextCursor: at(5),
    hasMore: false
  });
  const pull = makeEngine({ driver, transport, cursors, clock });

  const first = await pull.pullOnce();
  assert.equal(first.status, "idle");
  assert.equal(transport.calls.length, 1);
  assert.equal(PULL_INTERVAL_MS, 30 * 60 * 1000);

  clock.advance(PULL_INTERVAL_MS - 60_000);
  const early = await pull.pullOnce();
  assert.equal(early.status, "throttled");
  assert.equal(transport.calls.length, 1);
  assert.equal(early.nextPullAt, START_MS + PULL_INTERVAL_MS);

  clock.advance(120_000);
  const due = await pull.pullOnce();
  assert.equal(due.status, "idle");
  assert.equal(transport.calls.length, 2);
});

test("con 90 solicitudes hechas no se programa descarga; el manual sí pasa", async () => {
  const driver = await makeDriver();
  const cursors = createMemoryPullCursorStore();
  const clock = makeClock();
  const transport = makeTransport({ changes: [], nextCursor: at(5), hasMore: false });
  let spent = 89;
  const pull = makeEngine({ driver, transport, cursors, clock, budgetTotal: () => spent });

  const below = await pull.pullOnce();
  assert.equal(below.status, "idle");
  assert.equal(transport.calls.length, 1);

  spent = 90;
  clock.advance(PULL_INTERVAL_MS + 1);
  const skipped = await pull.pullOnce();
  assert.equal(skipped.status, "throttled");
  assert.equal(transport.calls.length, 1);

  const manual = await pull.pullOnce({ manual: true });
  assert.equal(manual.status, "idle");
  assert.equal(transport.calls.length, 2);
});

test("sin empresa conocida no se pide nada a la nube", async () => {
  const driver = await makeDriver();
  const cursors = createMemoryPullCursorStore();
  const transport = makeTransport({ changes: [], nextCursor: at(5), hasMore: false });
  const pull = createCloudPull({
    driver,
    transport,
    cursors,
    now: () => START_MS,
    isOnline: () => true,
    budgetTotal: () => 0
  });

  const outcome = await pull.pullOnce({ manual: true });

  assert.equal(outcome.status, "unknown-company");
  assert.equal(transport.calls.length, 0);
  assert.deepEqual(await cursors.load(COMPANY), { cursor: null, updatedAt: null });
});

test("el cursor corrupto se reescribe a null y usa la clave por empresa", async () => {
  const key = `palmyra:cloudsync:pull:${COMPANY}`;
  const values = new Map<string, string>([[key, "{no-json"]]);
  const storage: CloudStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    }
  };
  const cursors = createLocalStoragePullCursorStore("palmyra:cloudsync", storage);

  assert.deepEqual(await cursors.load(COMPANY), { cursor: null, updatedAt: null });

  values.set(key, JSON.stringify({ cursor: "fecha-imposible", updatedAt: "nope" }));
  assert.deepEqual(await cursors.load(COMPANY), { cursor: null, updatedAt: null });

  await cursors.save(COMPANY, { cursor: at(10), updatedAt: START_MS } as PullCursorState);
  assert.deepEqual(JSON.parse(values.get(key) ?? "{}"), { cursor: at(10), updatedAt: START_MS });
  assert.deepEqual(await cursors.load(COMPANY), { cursor: at(10), updatedAt: START_MS });
});

test("tablas cloud desconocidas y filas gigantes no entran en el lote", async () => {
  const big = "x".repeat(MAX_REMOTE_ROW_BYTES + 10);
  const payload = {
    changes: [
      { table: "pg_catalog_secrets", row_id: "x", op: "upsert", row: makeRow("x"), updated_at: at(5) },
      {
        table: "products",
        row_id: "p1",
        op: "upsert",
        row: makeRow("p1", { updated_at: at(5), notes: big }),
        updated_at: at(5)
      },
      { table: "products", row_id: "p2", op: "upsert", row: makeRow("p2", { updated_at: at(5) }), updated_at: at(5) }
    ],
    nextCursor: at(5),
    hasMore: false
  };

  const result = readPullPayload(payload, COMPANY, null, PULL_BATCH);

  assert.deepEqual(
    result.changes.map((entry) => entry.rowId),
    ["p2"]
  );
  assert.equal(result.rejected, 2);
  assert.equal(localTableForCloud("payments"), "sale_payments");
  assert.equal(localTableForCloud("sales_returns"), "returns");
  assert.equal(localTableForCloud("pg_catalog_secrets"), null);
});

test("el transporte llama al RPC con la ventana y valida el cursor devuelto", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: CloudRpcClient = {
    rpc(name: string, args: Record<string, unknown>): CloudRpcResult {
      calls.push({ name, args });
      return {
        data: {
          changes: [
            {
              table: "products",
              row_id: "p1",
              op: "upsert",
              row: makeRow("p1", { updated_at: at(5) }),
              updated_at: at(5)
            }
          ],
          nextCursor: at(5),
          hasMore: false
        },
        error: null
      };
    }
  };
  const transport = createSupabasePullTransport({ client, now: () => START_MS });

  const result = await transport.pull({ companyId: COMPANY, cursor: null, limit: 5 });

  assert.equal(result.error, undefined);
  assert.equal(result.nextCursor, at(5));
  assert.equal(result.changes.length, 1);
  assert.equal(calls[0].name, "pull_cloud_changes");
  assert.equal(calls[0].args.p_company_id, COMPANY);
  assert.equal(calls[0].args.p_limit, 5);
  const since = Date.parse(String(calls[0].args.p_since));
  assert.ok(Number.isFinite(since));
  assert.ok(START_MS - since <= PULL_MAX_DAYS * 86_400_000 + 1_000);

  // Un cursor anterior nunca se acepta como retroceso.
  const stale = readPullPayload({ changes: [], nextCursor: at(0), hasMore: false }, COMPANY, at(10), 500);
  assert.equal(stale.nextCursor, at(10));

  // Un cursor ilegible no inventa avance.
  const broken = readPullPayload({ changes: [], nextCursor: "roto", hasMore: false }, COMPANY, null, 500);
  assert.equal(broken.nextCursor, null);
  assert.ok(broken.error);
});

/**
 * Servidor falso con la semántica real de `pull_cloud_changes`: filtra
 * `updated_at > p_since`, ordena por (`updated_at`, tabla, `row_id`) y pide una
 * fila de más para informar `hasMore`.
 */
function makePullServer(rows: Array<{ id: string; updatedAt: string }>) {
  const calls: Array<Record<string, unknown>> = [];
  const sorted = [...rows].sort(
    (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id)
  );
  const client: CloudRpcClient = {
    rpc(_name: string, args: Record<string, unknown>): CloudRpcResult {
      calls.push(args);
      const since = Date.parse(String(args.p_since));
      const limit = Number(args.p_limit);
      const window = sorted.filter((row) => Date.parse(row.updatedAt) > since);
      const page = window.slice(0, limit);
      return {
        data: {
          changes: page.map((row) => ({
            table: "products",
            row_id: row.id,
            op: "upsert",
            row: makeRow(row.id, { updated_at: row.updatedAt }),
            updated_at: row.updatedAt
          })),
          nextCursor:
            page.length > 0 ? page[page.length - 1].updatedAt : new Date(since).toISOString(),
          hasMore: window.length > page.length
        },
        error: null
      };
    }
  };
  return { client, calls };
}

test("inclusiveSince pide el milisegundo anterior y respeta un texto ilegible", () => {
  assert.equal(inclusiveSince(at(5)), new Date(Date.parse(at(5)) - 1).toISOString());
  assert.equal(inclusiveSince("no-es-fecha"), "no-es-fecha");
});

test("un corte en un timestamp repetido no pierde filas del borde", async () => {
  const server = makePullServer([
    { id: "p1", updatedAt: at(0) },
    { id: "p2", updatedAt: at(5) },
    { id: "p3", updatedAt: at(5) }
  ]);
  const transport = createSupabasePullTransport({ client: server.client, now: () => START_MS });

  const first = await transport.pull({ companyId: COMPANY, cursor: null, limit: 2 });
  assert.deepEqual(first.changes.map((entry) => entry.rowId), ["p1", "p2"]);
  assert.equal(first.nextCursor, at(5));
  assert.equal(first.hasMore, true);

  // p2 y p3 comparten marca: la ventana se pide un milisegundo antes para que
  // el `>` del servidor se comporte como `>=` y p3 no quede fuera.
  const second = await transport.pull({ companyId: COMPANY, cursor: first.nextCursor, limit: 2 });
  assert.equal(Date.parse(String(server.calls[1].p_since)), Date.parse(at(5)) - 1);
  assert.deepEqual(second.changes.map((entry) => entry.rowId), ["p2", "p3"]);
  assert.equal(second.hasMore, false);

  // Repetir la ventana solo devuelve claves ya vistas: el cursor no oscila.
  const third = await transport.pull({ companyId: COMPANY, cursor: second.nextCursor, limit: 2 });
  assert.deepEqual(third.changes.map((entry) => entry.rowId), ["p2", "p3"]);
  assert.equal(third.nextCursor, at(5));
  assert.equal(third.hasMore, false);
});

test("una página llena de duplicados no se anuncia como backlog infinito", async () => {
  const server = makePullServer(
    ["p1", "p2", "p3", "p4", "p5"].map((id) => ({ id, updatedAt: at(5) }))
  );
  const transport = createSupabasePullTransport({ client: server.client, now: () => START_MS });

  const first = await transport.pull({ companyId: COMPANY, cursor: null, limit: 2 });
  assert.equal(first.nextCursor, at(5));
  assert.equal(first.hasMore, true);

  const second = await transport.pull({ companyId: COMPANY, cursor: at(5), limit: 2 });
  assert.deepEqual(second.changes.map((entry) => entry.rowId), ["p1", "p2"]);
  // Página llena con la misma marca: repetirla no aporta nada y no debe girar.
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, at(5));
});

test("la misma clave repetida en una página viaja una sola vez", () => {
  const payload = {
    changes: [
      { table: "products", row_id: "p1", op: "upsert", row: makeRow("p1", { updated_at: at(5) }), updated_at: at(5) },
      { table: "products", row_id: "p1", op: "upsert", row: makeRow("p1", { updated_at: at(5) }), updated_at: at(5) },
      { table: "customers", row_id: "p1", op: "upsert", row: makeRow("p1", { updated_at: at(5) }), updated_at: at(5) }
    ],
    nextCursor: at(5),
    hasMore: false
  };

  const result = readPullPayload(payload, COMPANY, null, PULL_BATCH);

  assert.deepEqual(
    result.changes.map((entry) => `${entry.table}:${entry.rowId}`),
    ["products:p1", "customers:p1"]
  );
  assert.equal(result.rejected, 1);
  assert.equal(result.hasMore, false);
});

test("el runner no programa tráfico con 90 solicitudes y el manual lo ignora", async () => {
  let syncCalls = 0;
  const sync = {
    async syncOnce() {
      syncCalls += 1;
      return { status: "synced" as const, pushed: 1, cursor: 1 };
    }
  };
  let pullCalls = 0;
  const pull = {
    async pullOnce(): Promise<PullOutcome> {
      pullCalls += 1;
      return { status: "idle", applied: 0, skipped: 0, conflicts: 0, cursor: null, hasMore: false };
    }
  };
  let spent = 90;
  const statuses: unknown[] = [];
  const runner = createCloudSyncRunner({
    sync,
    pull,
    timers: null,
    isOnline: () => true,
    now: () => START_MS,
    budgetTotal: () => spent,
    onStatus: (status) => statuses.push(status)
  });

  const scheduled = await runner.tick();
  assert.equal(scheduled, null);
  assert.equal(syncCalls, 0);
  assert.equal(pullCalls, 0);
  assert.equal((statuses[0] as { status: string }).status, "throttled");

  spent = 200;
  const manual = await runner.syncNow();
  assert.equal(syncCalls, 1);
  assert.equal(pullCalls, 1);
  assert.equal(manual.push?.status, "synced");
  assert.equal(manual.pull?.status, "idle");
  assert.equal(manual.status.pull?.applied, 0);

  // Un solo tick hace como mucho una subida y una descarga.
  assert.equal(syncCalls, 1);
  assert.equal(pullCalls, 1);
});

test("la descarga corre tras una subida correcta y no tras un fallo", async () => {
  let pullCalls = 0;
  const pull = {
    async pullOnce(): Promise<PullOutcome> {
      pullCalls += 1;
      return { status: "pulled", applied: 1, skipped: 0, conflicts: 0, cursor: at(5), hasMore: false };
    }
  };
  const failing = createCloudSyncRunner({
    sync: {
      async syncOnce() {
        return { status: "failed" as const, pushed: 0, cursor: 0, error: "sin red" };
      }
    },
    pull,
    timers: null,
    isOnline: () => true,
    now: () => START_MS,
    budgetTotal: () => 0
  });

  await failing.tick();
  assert.equal(pullCalls, 0);

  const statuses: unknown[] = [];
  const healthy = createCloudSyncRunner({
    sync: {
      async syncOnce() {
        return { status: "idle" as const, pushed: 0, cursor: 3 };
      }
    },
    pull,
    timers: null,
    isOnline: () => true,
    now: () => START_MS,
    budgetTotal: () => 0,
    onStatus: (status) => statuses.push(status)
  });

  await healthy.tick();
  assert.equal(pullCalls, 1);
  const reported = statuses[0] as { status: string; pull?: { status: string; applied: number } };
  assert.equal(reported.status, "idle");
  assert.equal(reported.pull?.status, "pulled");
  assert.equal(reported.pull?.applied, 1);
});

test("la subida se mide como cloud/push con latencia y resultado", async () => {
  const driver = await makeDriver();
  await driver.put("products", [makeRow("p1")]);
  const { records, report } = makeReporter();
  const sync = createCloudSync({
    driver,
    cursors: createMemoryCursorStore(),
    budget: createMemoryBudgetStore(),
    companyId: COMPANY,
    now: () => START_MS,
    isOnline: () => true,
    report,
    transport: {
      async push(batch) {
        return { acceptedThrough: batch.cursor };
      }
    }
  });

  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "synced");
  assert.equal(records.length, 1);
  assert.equal(records[0].route, "cloud/push");
  assert.equal(records[0].ok, true);
  assert.ok(typeof records[0].ms === "number");
});
