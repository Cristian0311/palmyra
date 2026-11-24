import test from "node:test";
import assert from "node:assert/strict";
import {
  PILOT_RISK_DAYS_KEY,
  PILOT_SUPPORT_TICKETS_KEY,
  PILOT_UPDATE_HISTORY_KEY,
  classifyPilotRequestBudget,
  exportPilotMetrics,
  formatPilotMetricsText,
  readPilotMetrics,
  readSupportTickets,
  readUpdateHistory,
  recordSupportTicket,
  recordUpdateOutcome
} from "../../src/services/pilot/metrics";
import type { RequestBudgetSnapshot } from "../../src/services/requestBudget";

/**
 * Métricas del piloto F7-B. Todo se prueba con almacén en memoria inyectado:
 * nunca toca localStorage real, la red ni Supabase.
 */

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function createStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    raw(key: string) {
      return map.get(key) ?? null;
    }
  };
}

const DAY_MS = 86_400_000;
// Fijado al mediodía UTC del día actual: evita que NOW-1h y NOW-30min caigan
// en días distintos cuando la suite corre cerca de la medianoche UTC.
const NOW_MS = (() => {
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  return noon.getTime();
})();

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyBudget(overrides: Partial<RequestBudgetSnapshot> = {}): RequestBudgetSnapshot {
  return {
    day: dayKey(NOW_MS),
    total: 0,
    errors: 0,
    averageLatencyMs: null,
    lastAt: null,
    byRoute: {},
    days: [],
    ...overrides
  };
}

test("empty storage still returns a complete snapshot", () => {
  const storage = createStorage();
  const now = new Date(NOW_MS);
  const snapshot = readPilotMetrics(now, {
    storage,
    queue: { failed: 0, conflicts: 0 }
  });

  assert.equal(snapshot.day, dayKey(NOW_MS));
  assert.equal(snapshot.generatedAt, now.toISOString());
  assert.equal(snapshot.riskSales, 0);
  assert.equal(snapshot.conflicts, 0);
  assert.equal(snapshot.sync.lastPushAt, null);
  assert.equal(snapshot.sync.lastPullAt, null);
  assert.equal(snapshot.sync.lastCycleMs, null);
  assert.equal(snapshot.requests.total, 0);
  assert.equal(snapshot.requests.limit, 100);
  assert.equal(snapshot.requests.level, "ok");
  assert.equal(snapshot.requests.averageLatencyMs, null);
  assert.equal(snapshot.updates.success, 0);
  assert.equal(snapshot.updates.failure, 0);
  assert.equal(snapshot.updates.lastVersion, null);
  assert.equal(snapshot.tickets, 0);
  assert.equal(snapshot.days.length, 7);
  assert.equal(snapshot.days[6].day, dayKey(NOW_MS));
  assert.ok(snapshot.days.every((day) => day.requests === 0 && day.tickets === 0));
});

test("aggregates the last 7 days across every local source", () => {
  const storage = createStorage({
    [PILOT_RISK_DAYS_KEY]: JSON.stringify([
      { day: dayKey(NOW_MS - 5 * DAY_MS), riskSales: 4, conflicts: 1 }
    ])
  });
  const offsets = [6, 5, 4, 3, 2, 1, 0];
  const budgetDays = offsets.map((offset) => ({
    day: dayKey(NOW_MS - offset * DAY_MS),
    total: (7 - offset) * 2,
    errors: offset === 0 ? 2 : 0,
    latencyMs: 100 * (7 - offset),
    samples: 7 - offset,
    lastAt: null,
    byRoute: {}
  }));
  const budget = emptyBudget({
    total: 14,
    errors: 2,
    averageLatencyMs: 100,
    days: budgetDays
  });

  recordUpdateOutcome(
    { status: "success", version: "1.3.6", at: NOW_MS - 3 * DAY_MS },
    storage
  );
  recordUpdateOutcome(
    { status: "failure", version: "1.3.6", at: NOW_MS - DAY_MS },
    storage
  );
  recordUpdateOutcome({ status: "success", version: "1.3.6", at: NOW_MS }, storage);
  recordSupportTicket(new Date(NOW_MS - 2 * DAY_MS), storage);
  recordSupportTicket(new Date(NOW_MS - 2 * DAY_MS), storage);
  recordSupportTicket(new Date(NOW_MS), storage);

  const snapshot = readPilotMetrics(new Date(NOW_MS), {
    storage,
    requestBudget: budget,
    syncLedger: {
      lastPushAt: new Date(NOW_MS).toISOString(),
      lastPullAt: new Date(NOW_MS - 120_000).toISOString()
    },
    queue: { failed: 1, conflicts: 1 }
  });

  assert.equal(snapshot.days.length, 7);
  assert.equal(snapshot.days[0].day, dayKey(NOW_MS - 6 * DAY_MS));
  const requestsTotal = snapshot.days.reduce((sum, day) => sum + day.requests, 0);
  assert.equal(requestsTotal, budgetDays.reduce((sum, day) => sum + day.total, 0));

  const row = (offset: number) =>
    snapshot.days.find((day) => day.day === dayKey(NOW_MS - offset * DAY_MS));
  assert.equal(row(6)?.requests, 2);
  assert.equal(row(3)?.updatesSuccess, 1);
  assert.equal(row(1)?.updatesFailure, 1);
  assert.equal(row(2)?.tickets, 2);
  assert.equal(row(5)?.riskSales, 4);
  assert.equal(row(5)?.conflicts, 1);
  assert.equal(row(0)?.requests, 14);
  assert.equal(row(0)?.requestErrors, 2);
  assert.equal(row(0)?.averageLatencyMs, 100);

  assert.equal(snapshot.updates.success, 1);
  assert.equal(snapshot.updates.failure, 0);
  assert.equal(snapshot.updates.lastVersion, "1.3.6");
  assert.equal(snapshot.updates.lastAt, new Date(NOW_MS).toISOString());
  assert.equal(snapshot.tickets, 1);
  assert.equal(snapshot.sync.lastCycleMs, 120_000);
});

test("riskSales combines failed queue items with unresolved conflicts", () => {
  const storage = createStorage();
  const snapshot = readPilotMetrics(new Date(NOW_MS), {
    storage,
    requestBudget: emptyBudget(),
    queue: { failed: 3, conflicts: 2 }
  });

  assert.equal(snapshot.conflicts, 2);
  assert.equal(snapshot.riskSales, 5);
  assert.equal(snapshot.days[6].riskSales, 5);
  assert.equal(snapshot.days[6].conflicts, 2);
  // El pico del día queda guardado para la revisión posterior del piloto.
  const stored = JSON.parse(storage.raw(PILOT_RISK_DAYS_KEY) ?? "[]") as Array<{
    riskSales: number;
  }>;
  assert.equal(stored[stored.length - 1].riskSales, 5);
});

test("update outcomes dedupe by day+version+status and prune beyond 90 days", () => {
  const storage = createStorage();
  recordUpdateOutcome({ status: "success", version: "1.3.6", at: NOW_MS - 3_600_000 }, storage);
  recordUpdateOutcome({ status: "success", version: "1.3.6", at: NOW_MS - 1_800_000 }, storage);
  assert.equal(readUpdateHistory(storage).length, 1, "same day+version+status is one entry");

  recordUpdateOutcome({ status: "failure", version: "1.3.6", at: NOW_MS - 1_200_000 }, storage);
  assert.equal(readUpdateHistory(storage).length, 2);

  recordUpdateOutcome(
    { status: "success", version: "1.2.9", at: NOW_MS - 120 * DAY_MS },
    storage
  );
  const versions = readUpdateHistory(storage).map((entry) => entry.version);
  assert.ok(!versions.includes("1.2.9"), "entries older than 90 days are dropped");
});

test("update history keeps at most 200 entries, newest last", () => {
  const seeded = Array.from({ length: 250 }, (_, index) => ({
    day: dayKey(NOW_MS - index * 60_000),
    at: NOW_MS - index * 60_000,
    status: "success",
    version: `1.0.${index}`
  }));
  const storage = createStorage({ [PILOT_UPDATE_HISTORY_KEY]: JSON.stringify(seeded) });

  recordUpdateOutcome({ status: "success", version: "1.3.6", at: NOW_MS + 1_000 }, storage);
  const history = readUpdateHistory(storage);
  assert.equal(history.length, 200);
  assert.equal(history[history.length - 1].version, "1.3.6");
});

test("support tickets count per day and ignore broken rows", () => {
  const storage = createStorage();
  recordSupportTicket(new Date(NOW_MS - 3 * DAY_MS), storage);
  recordSupportTicket(new Date(NOW_MS - 3 * DAY_MS), storage);
  recordSupportTicket(new Date(NOW_MS), storage);

  const days = readSupportTickets(storage);
  assert.deepEqual(
    days.map((day) => ({ day: day.day, count: day.count })),
    [
      { day: dayKey(NOW_MS - 3 * DAY_MS), count: 2 },
      { day: dayKey(NOW_MS), count: 1 }
    ]
  );

  const broken = createStorage({
    [PILOT_SUPPORT_TICKETS_KEY]: JSON.stringify([1, null, "x", { day: "nope" }, { day: dayKey(NOW_MS), count: -2 }])
  });
  assert.deepEqual(readSupportTickets(broken), []);
});

test("export returns a stable filename and the full snapshot JSON", () => {
  const storage = createStorage();
  const snapshot = readPilotMetrics(new Date("2026-11-17T14:05:00.000Z"), {
    storage,
    requestBudget: emptyBudget({ day: "2026-11-17" }),
    queue: { failed: 0, conflicts: 0 }
  });
  const { filename, json } = exportPilotMetrics(snapshot);

  assert.equal(filename, "metricas-piloto-20261117-1405.json");
  const parsed = JSON.parse(json) as {
    kind: string;
    schema: number;
    snapshot: { day: string; days: unknown[] };
  };
  assert.equal(parsed.kind, "pilot-metrics");
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.snapshot.day, "2026-11-17");
  assert.equal(parsed.snapshot.days.length, 7);
  assert.match(formatPilotMetricsText(snapshot), /Ventas en riesgo/);
});

test("malformed storage degrades to empty values without throwing", () => {
  const storage = createStorage({
    [PILOT_UPDATE_HISTORY_KEY]: "{esto no es json",
    [PILOT_SUPPORT_TICKETS_KEY]: "no-json",
    [PILOT_RISK_DAYS_KEY]: "null"
  });
  assert.deepEqual(readUpdateHistory(storage), []);
  assert.deepEqual(readSupportTickets(storage), []);

  const snapshot = readPilotMetrics(new Date(NOW_MS), {
    storage,
    requestBudget: emptyBudget(),
    queue: { failed: 0, conflicts: 0 }
  });
  assert.equal(snapshot.updates.success, 0);
  assert.equal(snapshot.tickets, 0);
  assert.equal(snapshot.riskSales, 0);

  const hostile = {
    getItem() {
      throw new Error("bloqueado");
    },
    setItem() {
      throw new Error("bloqueado");
    }
  } satisfies Storage;
  assert.doesNotThrow(() => readUpdateHistory(hostile));
  assert.doesNotThrow(() => recordSupportTicket(new Date(NOW_MS), hostile));
  assert.doesNotThrow(() =>
    readPilotMetrics(new Date(NOW_MS), {
      storage: hostile,
      requestBudget: emptyBudget(),
      queue: { failed: 0, conflicts: 0 }
    })
  );
});

test("request classification uses the 1-device and 5-device limits", () => {
  assert.deepEqual(classifyPilotRequestBudget(50, 1), { level: "ok", limit: 100 });
  assert.deepEqual(classifyPilotRequestBudget(80, 1), { level: "warn", limit: 100 });
  assert.deepEqual(classifyPilotRequestBudget(150, 1), { level: "over", limit: 100 });
  assert.deepEqual(classifyPilotRequestBudget(350, 5), { level: "ok", limit: 500 });
  assert.deepEqual(classifyPilotRequestBudget(450, 5), { level: "warn", limit: 500 });
  assert.deepEqual(classifyPilotRequestBudget(600, 5), { level: "over", limit: 500 });

  const snapshot = readPilotMetrics(new Date(NOW_MS), {
    storage: createStorage(),
    requestBudget: emptyBudget({ total: 450 }),
    queue: { failed: 0, conflicts: 0 },
    devices: 5
  });
  assert.equal(snapshot.requests.limit, 500);
  assert.equal(snapshot.requests.level, "warn");
});
