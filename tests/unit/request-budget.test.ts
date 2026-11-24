import test from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS_DAILY_BUDGET,
  DEVICE_DAILY_BUDGET,
  classifyRequestBudget,
  formatRequestBudget,
  readRequestBudget,
  recordRequest
} from "../../src/services/requestBudget";

/**
 * Registro local del presupuesto F6. Todo se prueba con un almacén en memoria
 * inyectado: nunca toca localStorage ni la red.
 */

function createStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    raw() {
      return map.get("palmyra:request-budget:v1") ?? null;
    }
  };
}

const DAY_ONE = new Date("2026-11-17T10:00:00.000Z");
const DAY_TWO = new Date("2026-11-18T09:00:00.000Z");

test("recordRequest increments the day total and groups by route", () => {
  const storage = createStorage();
  recordRequest("cloud/bootstrap", { ms: 100, ok: true }, DAY_ONE, storage);
  recordRequest("cloud/bootstrap", { ms: 300, ok: true }, DAY_ONE, storage);
  recordRequest("license/lease", { ms: 50, ok: true }, DAY_ONE, storage);

  const snapshot = readRequestBudget(DAY_ONE, storage);
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.byRoute["cloud/bootstrap"], 2);
  assert.equal(snapshot.byRoute["license/lease"], 1);
  assert.equal(snapshot.day, "2026-11-17");
  assert.equal(snapshot.errors, 0);
});

test("the route table is capped at 32 entries, keeping the busiest", () => {
  const storage = createStorage();
  for (let index = 0; index < 40; index += 1) {
    recordRequest(`route-${index}`, { ok: true }, DAY_ONE, storage);
  }
  const snapshot = readRequestBudget(DAY_ONE, storage);
  assert.equal(snapshot.total, 40);
  assert.equal(Object.keys(snapshot.byRoute).length, 32);
});

test("ok:false counts as an error and latency is averaged over samples", () => {
  const storage = createStorage();
  recordRequest("license/lease", { ms: 100, ok: true }, DAY_ONE, storage);
  recordRequest("license/lease", { ms: 300, ok: true }, DAY_ONE, storage);
  recordRequest("license/lease", { ms: 900, ok: false }, DAY_ONE, storage);

  const snapshot = readRequestBudget(DAY_ONE, storage);
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.averageLatencyMs, Math.round((100 + 300 + 900) / 3));
  assert.ok(snapshot.lastAt === DAY_ONE.getTime());
});

test("a new day starts a separate bucket instead of resetting history", () => {
  const storage = createStorage();
  recordRequest("cloud/bootstrap", { ms: 80, ok: true }, DAY_ONE, storage);
  recordRequest("cloud/bootstrap", { ms: 80, ok: true }, DAY_TWO, storage);

  const first = readRequestBudget(DAY_ONE, storage);
  const second = readRequestBudget(DAY_TWO, storage);
  assert.equal(first.total, 1);
  assert.equal(second.total, 1);
  assert.equal(second.days.length, 2);
  assert.deepEqual(second.days.map((day) => day.day), ["2026-11-17", "2026-11-18"]);
});

test("history is pruned to the last 7 days", () => {
  const storage = createStorage();
  for (let offset = 0; offset < 12; offset += 1) {
    const day = new Date(Date.parse("2026-11-01T12:00:00.000Z") + offset * 86_400_000);
    recordRequest("cloud/bootstrap", { ms: 10, ok: true }, day, storage);
  }
  const snapshot = readRequestBudget(new Date("2026-11-12T12:00:00.000Z"), storage);
  assert.ok(snapshot.days.length <= 7, `expected <= 7 days, got ${snapshot.days.length}`);
  const oldest = snapshot.days[0]?.day ?? "";
  assert.ok(oldest >= "2026-11-05", `old day ${oldest} should have been pruned`);
});

test("classification: 79 ok, 80 warn, 101 over for one device", () => {
  assert.equal(DEVICE_DAILY_BUDGET, 100);
  assert.deepEqual(classifyRequestBudget(79, 1), { level: "ok", limit: 100 });
  assert.deepEqual(classifyRequestBudget(80, 1), { level: "warn", limit: 100 });
  assert.deepEqual(classifyRequestBudget(99, 1), { level: "warn", limit: 100 });
  assert.deepEqual(classifyRequestBudget(101, 1), { level: "over", limit: 100 });
  assert.equal(classifyRequestBudget(0, 1).level, "ok");
});

test("classification uses the 500/day budget when the business has 5 devices", () => {
  assert.equal(BUSINESS_DAILY_BUDGET, 500);
  assert.deepEqual(classifyRequestBudget(99, 5), { level: "ok", limit: 500 });
  assert.deepEqual(classifyRequestBudget(101, 5), { level: "ok", limit: 500 });
  assert.deepEqual(classifyRequestBudget(400, 5), { level: "warn", limit: 500 });
  assert.deepEqual(classifyRequestBudget(501, 5), { level: "over", limit: 500 });
});

test("malformed storage never throws and reads as empty", () => {
  const broken = createStorage({
    "palmyra:request-budget:v1": "{not-json"
  });
  assert.doesNotThrow(() => readRequestBudget(DAY_ONE, broken));
  assert.equal(readRequestBudget(DAY_ONE, broken).total, 0);

  const wrongShape = createStorage({
    "palmyra:request-budget:v1": JSON.stringify({ days: [{ day: 42, total: "lots" }, null] })
  });
  assert.doesNotThrow(() => recordRequest("license/lease", { ms: 5 }, DAY_ONE, wrongShape));
  assert.equal(readRequestBudget(DAY_ONE, wrongShape).total, 1);

  assert.doesNotThrow(() => recordRequest("license/lease", {}, DAY_ONE, null));
  assert.equal(readRequestBudget(DAY_ONE, null).total, 0);
});

test("formatRequestBudget reports total, errors, latency and level", () => {
  const storage = createStorage();
  recordRequest("license/lease", { ms: 120, ok: false }, DAY_ONE, storage);
  recordRequest("cloud/bootstrap", { ms: 80, ok: true }, DAY_ONE, storage);

  const text = formatRequestBudget(readRequestBudget(DAY_ONE, storage), 1);
  assert.match(text, /^2\/100 solicitudes hoy/);
  assert.match(text, /1 con error/);
  assert.match(text, /latencia media 100 ms/);
  assert.doesNotMatch(text, /presupuesto excedido/);

  for (let index = 0; index < 100; index += 1) {
    recordRequest("cloud/bootstrap", { ms: 10, ok: true }, DAY_ONE, storage);
  }
  const over = formatRequestBudget(readRequestBudget(DAY_ONE, storage), 1);
  assert.match(over, /presupuesto excedido/);
});
