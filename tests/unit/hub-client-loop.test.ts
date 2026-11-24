import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import type { LocalRow } from "../../src/services/localDb/contract";
import { createHubHandler } from "../../src/services/lanHub/handler";
import { readChangeFeed } from "../../src/services/lanHub/changesFeed";
import { createHubNodeServer } from "../../src/services/lanHub/nodeServer";
import { joinHub } from "../../src/services/lanHub/pairing";
import { openHubEvents, type HubEventPage } from "../../src/services/lanHub/events";
import { startHubClientLoop } from "../../src/services/lanHub/clientLoop";
import {
  clearHubSession,
  getHubSession,
  saveHubSession
} from "../../src/services/lanHub/session";

const COMPANY = "co-1";
const HUB_ID = "hub-1";
const DEVICE = "pc-secundario";
const TOKEN = "token-loop-secreto_ABC123";
const BASE_URL = "http://192.168.1.10:48900";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const CODE = "48219307";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Tiempo de espera agotado");
    await delay(10);
  }
}

function productRow(id: string): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: "hub",
    deleted_at: null,
    name: `Producto ${id}`
  };
}

function changePage(id: string) {
  return {
    changes: [
      {
        seq: 1,
        table: "products",
        row_id: id,
        op: "upsert",
        company_id: COMPANY,
        updated_at: FIXED_ISO,
        origin_device: "hub",
        recorded_at: FIXED_ISO,
        row: productRow(id)
      }
    ],
    latestSeq: 1,
    serverTime: FIXED_ISO,
    hasMore: false
  };
}

test("el bucle es idempotente, cae a sondeo y aplica cada cambio una sola vez", async () => {
  await clearHubSession();
  await saveHubSession({
    hubId: HUB_ID,
    deviceId: DEVICE,
    token: TOKEN,
    baseUrl: BASE_URL,
    joinedAt: FIXED_ISO,
    cursor: 0
  });

  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();

  const sinceCalls: number[] = [];
  let served = false;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // El hub simulado no expone SSE: el bucle debe caer a /changes.
    if (url.includes("/lan/v1/events")) return jsonResponse({ error: "not_found" }, 404);
    // El bucle también propone escrituras: el hub simulado las acusa para que
    // no se confundan con sondeos de `/changes` (llevan otro parámetro `since`).
    if (url.includes("/lan/v1/ops")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      const ops = Array.isArray(body.ops) ? body.ops : [];
      return jsonResponse({
        results: ops.map((op: { actionId: string }) => ({ actionId: op.actionId, status: "applied" })),
        latestSeq: 1,
        serverTime: FIXED_ISO
      });
    }
    const since = Number(new URL(url).searchParams.get("since") ?? "0");
    sinceCalls.push(since);
    if (!served) {
      served = true;
      return jsonResponse(changePage("p1"));
    }
    return jsonResponse({ changes: [], latestSeq: 1, serverTime: FIXED_ISO, hasMore: false });
  }) as typeof fetch;

  const results: Array<{ applied: number; deleted: number; cursor: number; source: string }> = [];
  const options = {
    companyId: COMPANY,
    driver,
    fetchImpl: impl,
    pollMs: 20,
    eventsBaseDelayMs: 5,
    onChanges: (result: { applied: number; deleted: number; cursor: number; source: string }) => {
      results.push(result);
    }
  };

  const first = startHubClientLoop(options);
  const second = startHubClientLoop(options);
  assert.equal(second, first, "un segundo arranque devuelve el mismo mando");

  await waitFor(() => sinceCalls.length >= 2);
  first.stop();
  first.stop();
  assert.equal(first.isRunning(), false);

  assert.equal(results.length, 1, "solo la página con cambios notifica");
  assert.equal(results[0].applied, 1);
  assert.equal(results[0].source, "poll");
  const row = await driver.get<LocalRow>("products", "p1");
  assert.equal(row?.name, "Producto p1");

  const stored = await getHubSession();
  assert.equal(stored?.cursor, 1, "el cursor se persiste tras aplicar");
  // El segundo tick parte del cursor ya avanzado: el cambio no se reaplica.
  assert.deepEqual(sinceCalls.slice(0, 2), [0, 1]);

  const afterStop = results.length;
  await delay(120);
  assert.ok(results.length <= afterStop + 1, "detener no deja el bucle duplicado");

  await clearHubSession();
});

test("openHubEvents entrega la página del hub real por SSE y cierra al abortar", async () => {
  await clearHubSession();
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  const hub = createHubHandler({
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => FIXED_MS,
    pairingCode: () => CODE
  });
  const server = await createHubNodeServer({
    handler: hub,
    changes: (input) => readChangeFeed(driver, { ...input, companyId: COMPANY }),
    eventsPollMs: 20,
    eventsPingMs: 5000
  });

  try {
    const pairing = hub.createPairingSession();
    await joinHub({
      baseUrl: server.url,
      code: pairing.code,
      deviceName: "Caja 2",
      companyId: COMPANY,
      fetchImpl: fetch,
      now: () => FIXED_MS
    });
    await driver.put("products", [productRow("p9")]);

    const controller = new AbortController();
    const pages: HubEventPage[] = [];
    const running = openHubEvents({
      since: 0,
      signal: controller.signal,
      fetchImpl: fetch,
      now: () => FIXED_MS,
      baseDelayMs: 10,
      onChanges: (page) => {
        pages.push(page);
        controller.abort();
      }
    });

    await Promise.race([
      running,
      delay(5000).then(() => {
        throw new Error("El canal SSE no entregó cambios a tiempo");
      })
    ]);

    assert.ok(pages.length >= 1);
    // El journal del hub incluye el alta interna de `hub_devices` (seq 1); se
    // descarta y solo se entrega el producto, pero el cursor avanza a 2.
    assert.equal(pages[0].changes.length, 1);
    assert.equal(pages[0].changes[0].row_id, "p9");
    assert.equal(pages[0].cursor, 2);
  } finally {
    await server.close();
    await clearHubSession();
  }
});
