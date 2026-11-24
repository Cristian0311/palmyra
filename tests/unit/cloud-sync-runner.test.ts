import test from "node:test";
import assert from "node:assert/strict";
import {
  createCloudSyncRunner,
  type CloudSync,
  type CloudSyncRunnerStatus,
  type RunnerTimers,
  type SyncOutcome
} from "../../src/services/cloudSync";

const NOW = Date.parse("2026-05-01T08:00:00.000Z");

function outcome(partial: Partial<SyncOutcome> = {}): SyncOutcome {
  return { status: "synced", pushed: 2, cursor: 4, ...partial };
}

interface SyncSpy extends Pick<CloudSync, "syncOnce"> {
  calls: number;
}

function makeSync(result: SyncOutcome | (() => Promise<SyncOutcome>)): SyncSpy {
  const spy: SyncSpy = {
    calls: 0,
    async syncOnce(): Promise<SyncOutcome> {
      spy.calls += 1;
      return typeof result === "function" ? result() : result;
    }
  };
  return spy;
}

interface FakeTimers extends RunnerTimers {
  size(): number;
  delay(): number;
  fire(): void;
  cleared(): number;
}

function makeTimers(): FakeTimers {
  const jobs = new Map<number, () => void>();
  let nextId = 1;
  let interval = 0;
  let cleared = 0;
  return {
    setInterval(handler: () => void, ms: number) {
      interval = ms;
      const id = nextId;
      nextId += 1;
      jobs.set(id, handler);
      return id;
    },
    clearInterval(handle: unknown) {
      cleared += 1;
      jobs.delete(handle as number);
    },
    size: () => jobs.size,
    delay: () => interval,
    fire: () => {
      for (const handler of Array.from(jobs.values())) handler();
    },
    cleared: () => cleared
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeWindow {
  listeners: Map<string, Set<() => void>>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  emit(type: string): void;
  count(type: string): number;
}

function makeWindow(): FakeWindow {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of Array.from(listeners.get(type) ?? [])) listener();
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    }
  };
}

async function withWindow(run: (window: FakeWindow) => Promise<void>): Promise<void> {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  const fake = makeWindow();
  scope.window = fake;
  try {
    await run(fake);
  } finally {
    scope.window = previous;
  }
}

test("start hace un tick inmediato y agenda el intervalo", async () => {
  const timers = makeTimers();
  const sync = makeSync(outcome());
  const runner = createCloudSyncRunner({
    sync,
    timers,
    intervalMs: 1000,
    isOnline: () => true,
    now: () => NOW
  });

  const first = await runner.start();

  assert.deepEqual(first, outcome());
  assert.equal(sync.calls, 1);
  assert.equal(runner.running, true);
  assert.equal(timers.size(), 1);
  assert.equal(timers.delay(), 1000);

  timers.fire();
  await flush();
  assert.equal(sync.calls, 2);

  runner.stop();
  assert.equal(runner.running, false);
  assert.equal(timers.size(), 0);
});

test("un solo tick en vuelo aunque se pida dos veces", async () => {
  let resolve!: (value: SyncOutcome) => void;
  const pending = new Promise<SyncOutcome>((done) => {
    resolve = done;
  });
  const sync = makeSync(() => pending);
  const runner = createCloudSyncRunner({ sync, timers: null, isOnline: () => true });

  const first = runner.tick();
  const second = runner.tick();
  assert.equal(sync.calls, 1);

  resolve(outcome());
  const [a, b] = await Promise.all([first, second]);

  assert.equal(sync.calls, 1);
  assert.equal(a, b);
  assert.deepEqual(a, outcome());
});

test("start mientras hay un tick en vuelo no duplica la llamada", async () => {
  let resolve!: (value: SyncOutcome) => void;
  const pending = new Promise<SyncOutcome>((done) => {
    resolve = done;
  });
  const sync = makeSync(() => pending);
  const runner = createCloudSyncRunner({ sync, timers: null, isOnline: () => true });

  const tick = runner.tick();
  const started = runner.start();
  assert.equal(sync.calls, 1);

  resolve(outcome());
  await Promise.all([tick, started]);
  assert.equal(sync.calls, 1);
  runner.stop();
});

test("sin conexión no llama al motor y reporta offline", async () => {
  const timers = makeTimers();
  const sync = makeSync(outcome());
  const statuses: CloudSyncRunnerStatus[] = [];
  const runner = createCloudSyncRunner({
    sync,
    timers,
    isOnline: () => false,
    now: () => NOW,
    onStatus: (entry) => statuses.push(entry)
  });

  const result = await runner.start();
  await runner.tick();

  assert.equal(result, null);
  assert.equal(sync.calls, 0);
  assert.equal(statuses.length, 2);
  assert.deepEqual(statuses[0], { at: NOW, status: "offline", pushed: 0, cursor: 0 });
  runner.stop();
});

test("start es idempotente y stop no deja timers ni listeners", async () => {
  await withWindow(async (window) => {
    const timers = makeTimers();
    const sync = makeSync(outcome());
    const runner = createCloudSyncRunner({
      sync,
      timers,
      intervalMs: 500,
      isOnline: () => true,
      now: () => NOW
    });

    await runner.start();
    const secondStart = await runner.start();

    assert.equal(secondStart, null);
    assert.equal(sync.calls, 1);
    assert.equal(timers.size(), 1);
    assert.equal(window.count("online"), 1);

    runner.stop();
    runner.stop();

    assert.equal(timers.size(), 0);
    assert.equal(window.count("online"), 0);
    assert.equal(runner.running, false);

    // Reiniciar vuelve a agendar un único intervalo.
    await runner.start();
    assert.equal(timers.size(), 1);
    assert.equal(window.count("online"), 1);
    runner.stop();
  });
});

test("el evento online dispara un tick extra", async () => {
  await withWindow(async (window) => {
    const timers = makeTimers();
    const sync = makeSync(outcome());
    const runner = createCloudSyncRunner({
      sync,
      timers,
      isOnline: () => true,
      now: () => NOW
    });

    await runner.start();
    assert.equal(sync.calls, 1);

    window.emit("online");
    await flush();
    assert.equal(sync.calls, 2);
    assert.equal(timers.size(), 1);

    runner.stop();
  });
});

test("onStatus recibe solo campos saneados y nunca tumba el tick", async () => {
  const statuses: Array<Record<string, unknown>> = [];
  const noisy = {
    status: "synced",
    pushed: 2,
    cursor: 4,
    error: `fallo   de\nred ${"x".repeat(500)}`,
    nextRetryAt: NOW + 1000,
    rows: [{ id: "p1", name: "Arroz" }]
  } as unknown as SyncOutcome;
  const sync = makeSync(noisy);
  const runner = createCloudSyncRunner({
    sync,
    timers: null,
    isOnline: () => true,
    now: () => NOW,
    onStatus: (entry) => statuses.push(entry as unknown as Record<string, unknown>)
  });

  await runner.tick();

  assert.equal(statuses.length, 1);
  assert.deepEqual(Object.keys(statuses[0]).sort(), ["at", "cursor", "error", "pushed", "status"]);
  assert.equal(statuses[0].at, NOW);
  assert.equal(statuses[0].status, "synced");
  assert.equal(statuses[0].cursor, 4);
  assert.ok(String(statuses[0].error).length <= 300);
  assert.equal("rows" in statuses[0], false);

  const throwing = createCloudSyncRunner({
    sync: makeSync(outcome()),
    timers: null,
    isOnline: () => true,
    onStatus: () => {
      throw new Error("consumidor roto");
    }
  });
  const result = await throwing.tick();
  assert.deepEqual(result, outcome());
});

test("un fallo del motor se reporta como failed sin lanzar", async () => {
  const statuses: CloudSyncRunnerStatus[] = [];
  const sync = makeSync(() => Promise.reject(new Error("sin red")));
  const runner = createCloudSyncRunner({
    sync,
    timers: null,
    isOnline: () => true,
    now: () => NOW,
    onStatus: (entry) => statuses.push(entry)
  });

  const result = await runner.tick();

  assert.equal(result, null);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status, "failed");
  assert.equal(statuses[0].error, "sin red");
  assert.equal(statuses[0].pushed, 0);
});

test("una respuesta inválida del motor se marca como failed", async () => {
  const statuses: CloudSyncRunnerStatus[] = [];
  const sync = makeSync(null as unknown as SyncOutcome);
  const runner = createCloudSyncRunner({
    sync,
    timers: null,
    isOnline: () => true,
    now: () => NOW,
    onStatus: (entry) => statuses.push(entry)
  });

  const result = await runner.tick();

  assert.equal(result, null);
  assert.equal(statuses[0].status, "failed");
  assert.ok(statuses[0].error);
});

test("sin timers disponibles el start sigue funcionando una sola vez", async () => {
  const sync = makeSync(outcome({ status: "throttled", pushed: 0 }));
  const runner = createCloudSyncRunner({ sync, timers: null, isOnline: () => true });

  const first = await runner.start();
  assert.deepEqual(first, outcome({ status: "throttled", pushed: 0 }));
  assert.equal(sync.calls, 1);
  runner.stop();
});
