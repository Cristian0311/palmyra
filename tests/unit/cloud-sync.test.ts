import test from "node:test";
import assert from "node:assert/strict";
import type { LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  CLOUD_EXCLUDED_TABLES,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_REQUESTS_PER_DAY,
  DEFAULT_MIN_INTERVAL_MS,
  MAX_BACKOFF_MS,
  computeBackoff,
  createCloudSync,
  dayKeyFor,
  loadRows,
  planNextCursor,
  type BudgetSnapshot,
  type BudgetStore,
  type CloudChangeBatch,
  type CloudSyncOptions,
  type CloudTransport,
  type CursorStore
} from "../../src/services/cloudSync";

const START_MS = Date.parse("2026-05-01T08:00:00.000Z");
const COMPANY = "co-1";
const DELETED_AT = "2026-05-01T09:00:00.000Z";

interface TestClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

function makeClock(start = START_MS): TestClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    }
  };
}

function makeRow(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: new Date(START_MS).toISOString(),
    origin_device: "dev-1",
    deleted_at: null,
    ...fields
  };
}

interface TestCursors extends CursorStore {
  value: number;
  saved: Array<{ companyId: string; seq: number }>;
}

function makeCursors(initial = 0): TestCursors {
  const saved: Array<{ companyId: string; seq: number }> = [];
  const cursors: TestCursors = {
    value: initial,
    saved,
    async load(): Promise<number> {
      return cursors.value;
    },
    async save(companyId: string, seq: number): Promise<void> {
      saved.push({ companyId, seq });
      cursors.value = seq;
    }
  };
  return cursors;
}

interface TestBudget extends BudgetStore {
  days: Map<string, BudgetSnapshot>;
  saved: Array<{ dayKey: string; value: BudgetSnapshot }>;
}

function makeBudget(): TestBudget {
  const days = new Map<string, BudgetSnapshot>();
  const saved: Array<{ dayKey: string; value: BudgetSnapshot }> = [];
  const budget: TestBudget = {
    days,
    saved,
    async load(dayKey: string): Promise<BudgetSnapshot> {
      const stored = days.get(dayKey);
      return stored ? { ...stored } : { requests: 0, lastRequestAt: 0 };
    },
    async save(dayKey: string, value: BudgetSnapshot): Promise<void> {
      const copy = { ...value };
      days.set(dayKey, copy);
      saved.push({ dayKey, value: copy });
    }
  };
  return budget;
}

interface TestTransport extends CloudTransport {
  batches: CloudChangeBatch[];
  fail: boolean;
  ack?: (batch: CloudChangeBatch) => number;
  onPush?: (batch: CloudChangeBatch) => void;
}

function makeTransport(): TestTransport {
  const transport: TestTransport = {
    batches: [],
    fail: false,
    async push(batch: CloudChangeBatch): Promise<{ acceptedThrough: number }> {
      transport.batches.push(batch);
      transport.onPush?.(batch);
      if (transport.fail) throw new Error("La nube no respondió");
      const acceptedThrough = transport.ack ? transport.ack(batch) : batch.cursor;
      return { acceptedThrough };
    }
  };
  return transport;
}

interface Harness {
  clock: TestClock;
  driver: ReturnType<typeof createMemoryDriver>;
  cursors: TestCursors;
  budget: TestBudget;
  transport: TestTransport;
  sync: ReturnType<typeof createCloudSync>;
}

async function setup(overrides: Partial<CloudSyncOptions> = {}): Promise<Harness> {
  const clock = makeClock();
  const driver = createMemoryDriver({ now: () => new Date(clock.now()).toISOString() });
  await driver.ready();
  const cursors = makeCursors();
  const budget = makeBudget();
  const transport = makeTransport();
  const sync = createCloudSync({
    driver,
    transport,
    cursors,
    budget,
    now: () => clock.now(),
    companyId: COMPANY,
    ...overrides
  });
  return { clock, driver, cursors, budget, transport, sync };
}

test("sin cambios devuelve idle sin tocar la red ni el presupuesto", async () => {
  const { sync, transport, cursors, budget } = await setup();

  const outcome = await sync.syncOnce();

  assert.deepEqual(outcome, { status: "idle", pushed: 0, cursor: 0 });
  assert.equal(transport.batches.length, 0);
  assert.deepEqual(cursors.saved, []);
  assert.deepEqual(budget.saved, []);
});

test("sube un lote y persiste el cursor solo después del acuse", async () => {
  const { driver, sync, transport, cursors, budget } = await setup();
  await driver.put("products", [makeRow("p1", { name: "Arroz" }), makeRow("p2", { name: "Frijol" })]);

  let savedDuringPush = -1;
  transport.onPush = () => {
    savedDuringPush = cursors.saved.length;
  };

  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "synced");
  assert.equal(outcome.pushed, 2);
  assert.equal(outcome.cursor, 2);
  assert.equal(transport.batches.length, 1);
  assert.equal(transport.batches[0].companyId, COMPANY);
  assert.equal(transport.batches[0].cursor, 2);
  assert.deepEqual(
    transport.batches[0].changes.map((change) => change.seq),
    [1, 2]
  );
  assert.equal(transport.batches[0].changes[0].op, "upsert");
  assert.equal(transport.batches[0].changes[0].row?.name, "Arroz");
  // El cursor no se escribió mientras la solicitud estaba en vuelo.
  assert.equal(savedDuringPush, 0);
  assert.deepEqual(cursors.saved, [{ companyId: COMPANY, seq: 2 }]);
  assert.equal(budget.saved.length, 1);
  assert.deepEqual(budget.saved[0].value, { requests: 1, lastRequestAt: START_MS });
});

test("una segunda sincronización no reenvía lo ya confirmado", async () => {
  const { clock, driver, sync, transport } = await setup();
  await driver.put("products", [makeRow("p1")]);
  await sync.syncOnce();

  clock.advance(DEFAULT_MIN_INTERVAL_MS);
  const again = await sync.syncOnce();

  assert.equal(again.status, "idle");
  assert.equal(again.pushed, 0);
  assert.equal(again.cursor, 1);
  assert.equal(transport.batches.length, 1);
});

test("el cursor no retrocede si el servidor acusa menos de lo guardado", async () => {
  const { clock, driver, sync, transport, cursors } = await setup();
  await driver.put("products", [makeRow("p1"), makeRow("p2")]);
  await sync.syncOnce();
  assert.equal(cursors.value, 2);

  clock.advance(DEFAULT_MIN_INTERVAL_MS);
  await driver.put("products", [makeRow("p3")]);
  transport.ack = () => 1;

  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "synced");
  assert.equal(outcome.cursor, 2);
  assert.equal(cursors.value, 2);
  assert.deepEqual(
    cursors.saved.map((entry) => entry.seq),
    [2, 2]
  );

  // El cambio no confirmado sigue pendiente y se reenvía en el próximo ciclo.
  clock.advance(DEFAULT_MIN_INTERVAL_MS);
  transport.ack = undefined;
  const retried = await sync.syncOnce();
  assert.equal(retried.status, "synced");
  assert.deepEqual(
    transport.batches[1].changes.map((change) => change.seq),
    [3]
  );
  assert.equal(retried.cursor, 3);
});

test("respeta batchSize y no hace más de un lote por llamada", async () => {
  const { driver, sync, transport } = await setup({ batchSize: 2 });
  await driver.put(
    "products",
    [1, 2, 3, 4, 5].map((index) => makeRow(`p${index}`))
  );

  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "synced");
  assert.equal(outcome.pushed, 2);
  assert.equal(outcome.cursor, 2);
  assert.equal(transport.batches.length, 1);
  assert.deepEqual(
    transport.batches[0].changes.map((change) => change.seq),
    [1, 2]
  );
});

test("sin conexión no consume presupuesto ni toca el transporte", async () => {
  const { driver, sync, transport, budget, cursors } = await setup({ isOnline: () => false });
  await driver.put("products", [makeRow("p1")]);

  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "offline");
  assert.equal(outcome.pushed, 0);
  assert.equal(outcome.cursor, 0);
  assert.equal(transport.batches.length, 0);
  assert.deepEqual(budget.saved, []);
  assert.deepEqual(cursors.saved, []);
});

test("respeta el intervalo mínimo entre solicitudes", async () => {
  const { clock, driver, sync, transport } = await setup();
  await driver.put("products", [makeRow("p1")]);
  await sync.syncOnce();
  await driver.put("products", [makeRow("p2")]);

  clock.advance(60_000);
  const throttled = await sync.syncOnce();

  assert.equal(throttled.status, "throttled");
  assert.equal(throttled.pushed, 0);
  assert.equal(throttled.cursor, 1);
  assert.equal(throttled.nextRetryAt, START_MS + DEFAULT_MIN_INTERVAL_MS);
  assert.equal(transport.batches.length, 1);

  clock.set(throttled.nextRetryAt!);
  const allowed = await sync.syncOnce();
  assert.equal(allowed.status, "synced");
  assert.equal(allowed.pushed, 1);
  assert.equal(allowed.cursor, 2);
});

test("respeta el presupuesto diario y reanuda al día siguiente UTC", async () => {
  const { clock, driver, sync, transport, budget } = await setup({
    maxRequestsPerDay: 2,
    minIntervalMs: 0
  });

  await driver.put("products", [makeRow("p1")]);
  assert.equal((await sync.syncOnce()).status, "synced");
  await driver.put("products", [makeRow("p2")]);
  assert.equal((await sync.syncOnce()).status, "synced");
  await driver.put("products", [makeRow("p3")]);

  const throttled = await sync.syncOnce();

  assert.equal(throttled.status, "throttled");
  assert.equal(throttled.cursor, 2);
  assert.equal(throttled.nextRetryAt, Date.parse("2026-05-02T00:00:00.000Z"));
  assert.equal(transport.batches.length, 2);
  assert.equal(budget.days.get("2026-05-01")?.requests, 2);

  clock.set(throttled.nextRetryAt!);
  const nextDay = await sync.syncOnce();

  assert.equal(nextDay.status, "synced");
  assert.equal(nextDay.cursor, 3);
  assert.equal(budget.days.get("2026-05-02")?.requests, 1);
  assert.ok(DEFAULT_MAX_REQUESTS_PER_DAY > 2);
});

test("un fallo devuelve failed con backoff exponencial hasta el tope", async () => {
  const { clock, driver, sync, transport } = await setup({ minIntervalMs: 0 });
  await driver.put("products", [makeRow("p1")]);
  transport.fail = true;

  const delays: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const outcome = await sync.syncOnce();
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.pushed, 0);
    assert.equal(outcome.cursor, 0);
    assert.equal(typeof outcome.error, "string");
    const delay = outcome.nextRetryAt! - clock.now();
    delays.push(delay);
    clock.advance(delay);
  }

  assert.deepEqual(delays.slice(0, 3), [
    DEFAULT_BACKOFF_MS,
    DEFAULT_BACKOFF_MS * 2,
    DEFAULT_BACKOFF_MS * 4
  ]);
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index] >= delays[index - 1], "el backoff nunca disminuye");
  }
  assert.equal(delays[delays.length - 1], MAX_BACKOFF_MS);
  assert.equal(transport.batches.length, 8);
});

test("el backoff en memoria evita reintentos inmediatos", async () => {
  const { driver, sync, transport } = await setup({ minIntervalMs: 0 });
  await driver.put("products", [makeRow("p1")]);
  transport.fail = true;

  const first = await sync.syncOnce();
  const blocked = await sync.syncOnce();

  assert.equal(first.status, "failed");
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.nextRetryAt, first.nextRetryAt);
  assert.equal(blocked.error, first.error);
  assert.equal(transport.batches.length, 1);
});

test("un éxito posterior reinicia el backoff", async () => {
  const { clock, driver, sync, transport } = await setup({ minIntervalMs: 0 });
  await driver.put("products", [makeRow("p1")]);
  transport.fail = true;

  const first = await sync.syncOnce();
  clock.set(first.nextRetryAt!);
  const second = await sync.syncOnce();
  assert.equal(second.nextRetryAt! - clock.now(), DEFAULT_BACKOFF_MS * 2);

  clock.advance(DEFAULT_BACKOFF_MS * 2);
  transport.fail = false;
  const recovered = await sync.syncOnce();
  assert.equal(recovered.status, "synced");
  assert.equal(recovered.pushed, 1);

  await driver.put("products", [makeRow("p2")]);
  transport.fail = true;
  const failedAgain = await sync.syncOnce();
  assert.equal(failedAgain.status, "failed");
  assert.equal(failedAgain.nextRetryAt! - clock.now(), DEFAULT_BACKOFF_MS);
});

test("las filas borradas viajan como delete con su marca", async () => {
  const { driver, sync, transport } = await setup();
  await driver.put("products", [makeRow("p1"), makeRow("p2")]);
  await driver.put("products", [makeRow("p2", { version: 2, deleted_at: DELETED_AT })]);

  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "synced");
  assert.equal(transport.batches.length, 1);
  const batch = transport.batches[0];
  assert.equal(batch.cursor, 3);
  const tombstone = batch.changes.find((change) => change.rowId === "p2" && change.op === "delete");
  assert.ok(tombstone);
  assert.equal(tombstone?.deletedAt, DELETED_AT);
  assert.equal(tombstone?.row, undefined);
  // p1 sigue viajando como upsert.
  assert.equal(batch.changes.find((change) => change.rowId === "p1")?.op, "upsert");
  assert.equal(outcome.cursor, 3);
});

test("loadRows omite los upserts cuya fila ya no existe", async () => {
  const driver = createMemoryDriver({ now: () => new Date(START_MS).toISOString() });
  await driver.ready();
  await driver.put("products", [makeRow("p1")]);
  const journal = await driver.changes();

  await driver.remove("products", ["p1"], { company_id: COMPANY, origin_device: "dev-1" });
  const changes = await loadRows(driver, journal);

  assert.deepEqual(changes, []);
});

test("excluye las tablas internas del hub y el outbox", async () => {
  const { driver, sync, transport, cursors } = await setup();
  await driver.put("products", [makeRow("p1")]);
  await driver.put("hub_devices", [makeRow("dev-1")]);
  await driver.put("outbox", [makeRow("out-1")]);
  await driver.put("products", [makeRow("p2")]);

  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "synced");
  assert.equal(outcome.pushed, 2);
  const batch = transport.batches[0];
  assert.deepEqual(
    batch.changes.map((change) => change.seq),
    [1, 4]
  );
  assert.ok(
    batch.changes.every((change) => !CLOUD_EXCLUDED_TABLES.includes(change.table)),
    "ningún cambio de tabla interna viaja a la nube"
  );
  // El cursor avanza aunque la ventana terminara en filas internas.
  assert.equal(batch.cursor, 4);
  assert.equal(cursors.value, 4);
});

test("usa el reloj inyectado para dayKey y para el intervalo", async () => {
  const { clock, driver, sync, budget } = await setup();
  clock.set(Date.parse("2026-05-01T23:50:00.000Z"));

  await driver.put("products", [makeRow("p1")]);
  await sync.syncOnce();
  assert.deepEqual(budget.saved[0], {
    dayKey: "2026-05-01",
    value: { requests: 1, lastRequestAt: Date.parse("2026-05-01T23:50:00.000Z") }
  });

  // 20 minutos después ya es otro día UTC y el intervalo mínimo se cumplió.
  clock.advance(20 * 60 * 1000);
  await driver.put("products", [makeRow("p2")]);
  const outcome = await sync.syncOnce();

  assert.equal(outcome.status, "synced");
  assert.equal(dayKeyFor(clock.now()), "2026-05-02");
  assert.deepEqual(Array.from(budget.days.keys()).sort(), ["2026-05-01", "2026-05-02"]);
  assert.equal(budget.days.get("2026-05-02")?.requests, 1);
});

test("helpers puros: computeBackoff, dayKeyFor y planNextCursor", () => {
  assert.equal(computeBackoff(0), 0);
  assert.equal(computeBackoff(-3), 0);
  assert.equal(computeBackoff(1), DEFAULT_BACKOFF_MS);
  assert.equal(computeBackoff(2), DEFAULT_BACKOFF_MS * 2);
  assert.equal(computeBackoff(7), MAX_BACKOFF_MS);
  assert.equal(computeBackoff(50), MAX_BACKOFF_MS);

  assert.equal(dayKeyFor(Date.parse("2026-05-01T23:59:59.999Z")), "2026-05-01");
  assert.equal(dayKeyFor(0), "1970-01-01");

  assert.equal(planNextCursor(0, 3, 5), 3);
  assert.equal(planNextCursor(3, 2, 5), 3);
  assert.equal(planNextCursor(3, 99, 5), 5);
  assert.equal(planNextCursor(5, 5, 5), 5);
  assert.equal(planNextCursor(0, -1, 5), 0);
});
