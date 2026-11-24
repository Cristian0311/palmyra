/**
 * Regresiones de durabilidad offline.
 *
 * El producto promete que toda operación confirmada en la UI sigue existiendo
 * en IndexedDB hasta que la nube la confirme, incluso si la app se cierra a
 * mitad del envío. Estas pruebas cubren los tres escenarios del informe:
 *  - recarga con operaciones encoladas,
 *  - cierre abrupto mientras se enviaba (misma clave idempotente, un reintento),
 *  - arranque sin red que debe hidratar cola + datos locales.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  INTERRUPTED_RETRY_BASE_MS,
  hydrateOfflineQueueForBoot,
  interruptedRetryDelayMs,
  isQueueItemDeferred,
  recoverInterruptedQueueItems,
  type OfflineQueueHydrationPorts
} from "../../src/services/offline/durability";
import { offlineIdempotencyKey } from "../../src/services/offline/syncContract";
import type { OfflineActionType, OfflineQueueItem } from "../../src/services/offlineQueueTypes";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { hydrateFromLocalDb } from "../../src/services/localDb/bootHydration";
import { openOfflineQueueDb, resetOfflineQueueDbCache } from "../../src/services/offlineQueueStorage";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AT = "2026-11-26T12:00:00.000Z";
const NOW = Date.parse(AT);

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function queued(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: overrides.id || "row-1",
    actionId: overrides.actionId || "sale-1",
    type: (overrides.type || "transaction") as OfflineActionType,
    data: overrides.data || { id: overrides.actionId || "sale-1", total: 25 },
    timestamp: overrides.timestamp || AT,
    queuedAt: overrides.queuedAt || AT,
    retryCount: overrides.retryCount ?? 0,
    status: overrides.status || "pending",
    ...overrides
  } as OfflineQueueItem;
}

/**
 * Espejo durable mínimo: sobrevive al "reinicio" porque vive fuera de la
 * ventana simulada, igual que IndexedDB. Cada escritura es un único put por
 * operación (operación + payload en el mismo registro).
 */
function fakeDurableStore() {
  let rows: OfflineQueueItem[] = [];
  return {
    put(item: OfflineQueueItem) { rows = [...rows.filter(row => row.id !== item.id), structuredClone(item)]; },
    replaceAll(items: OfflineQueueItem[]) { rows = structuredClone(items); },
    remove(id: string) { rows = rows.filter(row => row.id !== id); },
    read: async () => structuredClone(rows) as OfflineQueueItem[],
    snapshot: () => structuredClone(rows) as OfflineQueueItem[]
  };
}

/** Ventana simulada: memoria independiente + espejo durable compartido. */
function bootWindow(durable: ReturnType<typeof fakeDurableStore>, options: { durableFails?: boolean } = {}) {
  const memory: { queue: OfflineQueueItem[]; writes: number } = { queue: [], writes: 0 };
  const ports: OfflineQueueHydrationPorts = {
    ready: async () => {},
    readMemory: () => memory.queue,
    readDurable: async () => {
      if (options.durableFails) throw new Error("IndexedDB bloqueado");
      return durable.read();
    },
    writeMemory: (items) => { memory.queue = [...items]; },
    persist: async (items) => { memory.writes += 1; durable.replaceAll(items); },
    now: () => NOW,
    random: () => 0.5
  };
  return { memory, ports };
}

test("una operación encolada sobrevive a la recarga y conserva su clave idempotente", async () => {
  const durable = fakeDurableStore();

  // Sesión 1: la venta se encola (registro durable ANTES de avisar a la UI).
  const first = bootWindow(durable);
  const booted1 = await hydrateOfflineQueueForBoot(first.ports);
  assert.equal(booted1.queue.length, 0);
  const sale = queued({ id: "row-sale", actionId: "sale-abc", data: { id: "sale-abc", total: 25 } });
  durable.put(sale);
  const keyBeforeReload = offlineIdempotencyKey(sale);

  // Sesión 2: memoria nueva, mismo almacén (recarga/reapertura de la app).
  const second = bootWindow(durable);
  const booted2 = await hydrateOfflineQueueForBoot(second.ports);

  assert.equal(booted2.queue.length, 1, "la venta pendiente debe reaparecer tras la recarga");
  assert.equal(booted2.restored, 1);
  assert.equal(booted2.queue[0].id, "row-sale");
  assert.equal(booted2.queue[0].actionId, "sale-abc");
  assert.equal(offlineIdempotencyKey(booted2.queue[0]), keyBeforeReload);
  assert.equal(second.memory.queue.length, 1, "la memoria se repara desde el espejo durable");
});

test("un cierre a mitad del envío reintenta una sola vez con la misma clave idempotente", async () => {
  const durable = fakeDurableStore();
  // Estado persistido por el cierre abrupto: la operación estaba en vuelo.
  durable.put(queued({ id: "row-sending", actionId: "sale-crash", status: "processing", retryCount: 2 }));
  const keyWhileSending = offlineIdempotencyKey(durable.snapshot()[0]);

  const session = bootWindow(durable);
  const booted = await hydrateOfflineQueueForBoot(session.ports);

  assert.equal(booted.recovered, 1);
  const resumed = booted.queue[0];
  assert.equal(resumed.status, "pending", "un envío interrumpido vuelve a pendiente, nunca se descarta");
  assert.equal(resumed.id, "row-sending");
  assert.equal(resumed.actionId, "sale-crash");
  assert.equal(offlineIdempotencyKey(resumed), keyWhileSending, "el reintento usa la misma clave");
  assert.equal(resumed.retryCount, 2, "un cierre no cuenta como rechazo del servidor");
  assert.ok(Number(resumed.nextRetryAt) > NOW, "se reintenta con backoff");
  assert.ok(resumed.interruptedAt, "queda marca de diagnóstico");
  // El backoff se respeta: el motor de sync no lo envía en la misma pasada.
  assert.equal(isQueueItemDeferred(resumed, NOW), true);
  // retryCount 2 ⇒ 30 s × 4 (con jitter neutro al 50 %) = 120 s.
  assert.ok(Number(resumed.nextRetryAt) <= NOW + 5 * 60_000);
  assert.equal(isQueueItemDeferred(resumed, NOW + 5 * 60_000), false);

  // Y solo se reintenta una vez por arranque: la segunda hidratación no vuelve
  // a moverlo ni cambia su clave.
  const again = await hydrateOfflineQueueForBoot(session.ports);
  assert.equal(again.recovered, 0);
  assert.equal(offlineIdempotencyKey(again.queue[0]), keyWhileSending);
  assert.equal(durable.snapshot()[0].status, "pending");
});

test("el arranque offline hidrata cola y datos locales sin red", async () => {
  const durable = fakeDurableStore();
  durable.put(queued({ id: "row-offline", actionId: "sale-offline" }));

  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  await driver.put("products", [{
    id: "p-1",
    company_id: COMPANY,
    version: 1,
    updated_at: AT,
    origin_device: "device-a",
    deleted_at: null,
    name: "Café",
    sku: "CAF-1",
    price: 2.5
  }]);

  const session = bootWindow(durable);
  const [queue, snapshot] = await Promise.all([
    hydrateOfflineQueueForBoot(session.ports),
    hydrateFromLocalDb(COMPANY, { driver })
  ]);

  assert.equal(queue.queue.length, 1, "la cola pendiente queda disponible antes de leer pantallas");
  assert.equal(queue.source, "merged");
  assert.equal(snapshot?.products[0]?.id, "p-1", "el snapshot local se hidrata sin red");
  assert.equal(snapshot?.products[0]?.name, "Café");
});

test("si el espejo durable no responde, la cola en memoria nunca se vacía", async () => {
  const durable = fakeDurableStore();
  const session = bootWindow(durable, { durableFails: true });
  session.memory.queue = [queued({ id: "row-mem", actionId: "sale-mem" })];

  const booted = await hydrateOfflineQueueForBoot(session.ports);

  assert.equal(booted.source, "durable-unavailable");
  assert.equal(booted.queue.length, 1);
  assert.equal(booted.queue[0].actionId, "sale-mem");
  assert.equal(session.memory.queue.length, 1);
});

test("una operación confirmada durante la hidratación no la borra la instantánea", async () => {
  const durable = fakeDurableStore();
  durable.put(queued({ id: "row-crash", actionId: "sale-crash", status: "processing" }));
  const memory: OfflineQueueItem[] = [];
  const persisted: OfflineQueueItem[][] = [];
  const ports: OfflineQueueHydrationPorts = {
    ready: async () => {},
    readMemory: () => [...memory],
    readDurable: async () => {
      const rows = await durable.read();
      // La UI confirma una venta justo mientras se lee el espejo durable.
      memory.push(queued({ id: "row-new", actionId: "sale-new", timestamp: "2026-11-26T12:00:00.500Z" }));
      return rows;
    },
    writeMemory: (items) => { memory.length = 0; memory.push(...items); },
    persist: async (items) => { persisted.push(structuredClone(items)); },
    now: () => NOW,
    random: () => 0.5
  };

  const booted = await hydrateOfflineQueueForBoot(ports);

  assert.equal(booted.recovered, 1);
  assert.ok(booted.queue.some(item => item.actionId === "sale-new"), "lo confirmado durante la hidratación no se pierde");
  const lastPersisted = persisted[persisted.length - 1] || [];
  assert.equal(lastPersisted.length, 2, "la instantánea persistida incluye la venta nueva");
  assert.ok(lastPersisted.some(item => item.actionId === "sale-new"));
  assert.ok(memory.some(item => item.actionId === "sale-new"));
});

test("la migración de la cola no reenvía en bloque los envíos interrumpidos", () => {
  const queue = source("src/services/offlineQueue.ts");
  const migration = queue.slice(
    queue.indexOf("async function migrateLegacyQueue"),
    queue.indexOf("export async function setOfflineQueueScope")
  );
  assert.match(migration, /interruptedRetryDelayMs\(/, "un cierre abrupto respeta el backoff");
  assert.match(migration, /nextRetryAt/, "el reintento no sale en la misma pasada");
  assert.match(migration, /INTERRUPTED_RETRY_MESSAGE/, "el operador ve por qué se reintenta");
});

test("una apertura bloqueada de IndexedDB se rechaza en vez de colgar la cola", async () => {
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
  const factory = {
    open() {
      const request = {
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        onblocked: null as null | (() => void),
        result: undefined,
        error: null
      };
      setTimeout(() => request.onblocked?.(), 0);
      return request;
    }
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = factory;
  resetOfflineQueueDbCache();
  try {
    await assert.rejects(
      openOfflineQueueDb("palmyra-offline-blocked-test", true),
      /bloqueada|blocked|timed out|open/
    );
  } finally {
    resetOfflineQueueDbCache();
    if (previous === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
    else (globalThis as { indexedDB?: unknown }).indexedDB = previous;
  }
});

test("el backoff de una operación interrumpida crece y lleva jitter", () => {
  const first = interruptedRetryDelayMs(0, () => 0.5);
  const third = interruptedRetryDelayMs(3, () => 0.5);
  assert.equal(first, INTERRUPTED_RETRY_BASE_MS);
  assert.ok(third > first);
  assert.ok(interruptedRetryDelayMs(0, () => 0) < first, "el jitter baja el retraso hasta un 20 %");
  assert.ok(interruptedRetryDelayMs(0, () => 1) > first, "y lo sube hasta un 20 %");
  assert.equal(interruptedRetryDelayMs(40, () => 0.5), 15 * 60_000, "el backoff tiene tope");
});

test("un reloj retrocedido no congela la cola: el backoff absurdo se ignora", () => {
  // Marca legítima (2 min): se respeta.
  const normal = queued({ id: "row-b1", actionId: "sale-b1", interruptedAt: AT, nextRetryAt: NOW + 2 * 60_000 });
  assert.equal(isQueueItemDeferred(normal, NOW), true);
  // Marca a 60 días (reloj adelantado en otro arranque): no es una espera real.
  const skewed = queued({ id: "row-b2", actionId: "sale-b2", interruptedAt: AT, nextRetryAt: NOW + 60 * 24 * 3600_000 });
  assert.equal(isQueueItemDeferred(skewed, NOW), false);
});

test("una hidratación durante un drenaje activo no reinicia el envío en vuelo", async () => {
  const durable = fakeDurableStore();
  const inFlight = queued({ id: "row-live", actionId: "sale-live", status: "processing" });
  const session = bootWindow(durable);
  session.memory.queue = [inFlight];
  durable.put(inFlight);

  const booted = await hydrateOfflineQueueForBoot(session.ports, { recover: false });

  assert.equal(booted.recovered, 0);
  assert.equal(booted.queue[0].status, "processing", "un envío real no puede duplicarse");
  assert.equal(offlineIdempotencyKey(booted.queue[0]), offlineIdempotencyKey(inFlight));
});

test("el motor de sync recupera envíos interrumpidos antes del replay y vacía al cerrar", () => {
  const sync = source("src/services/offlineSync.ts");
  const hydration = sync.indexOf("const hydratedQueue = getOfflineQueue();");
  const recovery = sync.indexOf("recoverInterruptedQueueItems(hydratedQueue");
  const snapshot = sync.indexOf("const queueAtStart = allQueueAtStart.filter");
  assert.ok(hydration >= 0, "el replay parte de la cola hidratada");
  assert.ok(recovery > hydration, "el replay debe reparar los elementos que quedaron en vuelo");
  assert.ok(snapshot > recovery, "la reparación ocurre antes de tomar la instantánea a procesar");
  assert.match(sync, /isQueueItemDeferred\(item\)/, "el backoff debe respetarse en la pasada");
  assert.match(sync, /addEventListener\('pagehide'/, "debe existir un vaciado best-effort al cerrar");
  assert.match(sync, /addEventListener\('visibilitychange'/, "debe vaciarse al ocultar la pestaña");
  assert.match(sync, /resumeOfflineOperations\(\{ reason: 'boot' \}\)/, "el arranque debe reanudar lo pendiente");
  assert.match(sync, /hydrateOfflineQueueForBoot\(\{/, "la reanudación hidrata la cola antes de contar");
});

test("la confirmación de la venta espera la escritura durable en IndexedDB", () => {
  const pos = source("src/store/actions/posActions.ts");
  assert.match(
    pos,
    /await enqueueOfflineItem\('transaction', durableTransaction, transaction\.id\)[\s\S]{0,400}return false;/,
    "si la cola no puede persistir la venta, el cobro no puede reportarse como exitoso"
  );
  assert.match(pos, /await waitForOfflineQueueReady\(\)/);
});
