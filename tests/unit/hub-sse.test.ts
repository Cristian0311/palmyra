import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import type { ChangeRecord, LocalRow } from "../../src/services/localDb/contract";
import { createHubHandler } from "../../src/services/lanHub/handler";
import { createHubNodeServer, type HubNodeServer } from "../../src/services/lanHub/nodeServer";
import { readChangeFeed } from "../../src/services/lanHub/changesFeed";
import { openHubEvents } from "../../src/services/lanHub/events";
import { HUB_AUTH_HEADERS } from "../../src/services/lanHub/shared";
import { HUB_ROUTES } from "../../src/services/lanHub/protocol";
import type { HubChangesResponse } from "../../src/services/lanHub/protocol";
import type { HubHandler } from "../../src/services/lanHub/handler";
import { signHubRequest } from "../../src/services/lanHub/auth";
import { clearHubSession, saveHubSession } from "../../src/services/lanHub/session";

const COMPANY = "co-1";
const HUB_ID = "hub-sse";
const DEVICE = "dev-sse";
const PAIRING_CODE = "48219307";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const PRODUCT_TABLE = "products";

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

function productRow(id: string, companyId = COMPANY): LocalRow {
  return {
    id,
    company_id: companyId,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: "hub",
    deleted_at: null,
    name: `Producto ${id}`
  };
}

function changeRecord(seq: number, rowId: string): ChangeRecord & { row: LocalRow } {
  return {
    seq,
    table: PRODUCT_TABLE,
    row_id: rowId,
    op: "upsert",
    company_id: COMPANY,
    updated_at: FIXED_ISO,
    origin_device: "hub",
    recorded_at: FIXED_ISO,
    row: productRow(rowId)
  };
}

function pageOf(change: ChangeRecord, hasMore: boolean, latestSeq = 2): HubChangesResponse {
  return { changes: [change], latestSeq, serverTime: FIXED_ISO, hasMore };
}

interface Harness {
  driver: ReturnType<typeof createMemoryDriver>;
  hub: HubHandler;
  server: HubNodeServer;
}

async function setup(changes?: HubNodeServerOptionsChanges): Promise<Harness> {
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  const hub = createHubHandler({
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => FIXED_MS,
    pairingCode: () => PAIRING_CODE
  });
  const server = await createHubNodeServer({
    handler: hub,
    eventsPollMs: 20,
    eventsPingMs: 60_000,
    ...(changes ? { changes } : {})
  });
  return { driver, hub, server };
}

type HubNodeServerOptionsChanges = (input: { since: number; limit: number }) => Promise<HubChangesResponse>;

async function pairDevice(hub: HubHandler, server: HubNodeServer): Promise<string> {
  const session = hub.createPairingSession();
  const res = await fetch(`${server.url}${HUB_ROUTES.pair}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode: session.code,
      deviceId: DEVICE,
      deviceName: "Caja SSE",
      platform: "windows",
      companyId: COMPANY
    })
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { deviceToken: string };
  return body.deviceToken;
}

let nonceSeq = 0;

function signedHeaders(token: string): Record<string, string> {
  const timestamp = FIXED_MS;
  const nonce = `sse-nonce-${++nonceSeq}`;
  const signature = signHubRequest({
    token,
    method: "GET",
    path: HUB_ROUTES.changes,
    timestamp,
    nonce,
    body: ""
  });
  return {
    [HUB_AUTH_HEADERS.device]: DEVICE,
    [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
    [HUB_AUTH_HEADERS.nonce]: nonce,
    [HUB_AUTH_HEADERS.signature]: signature,
    accept: "text/event-stream"
  };
}

/** Lee los bloques `data:` del stream y devuelve cada página ya parseada. */
async function readDataPages(
  body: ReadableStream<Uint8Array>,
  wanted: number
): Promise<Array<Record<string, unknown>>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pages: Array<Record<string, unknown>> = [];
  while (pages.length < wanted) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (dataLine) pages.push(JSON.parse(dataLine.slice(5).trim()));
      cut = buffer.indexOf("\n\n");
    }
  }
  return pages;
}

test("readChangeFeed adjunta la fila vigente y degrada a lápida lo no servible", async () => {
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  await driver.put(PRODUCT_TABLE, [productRow("p1"), productRow("p2")]);
  await driver.put("hub_devices", [
    {
      id: "dev-x",
      company_id: COMPANY,
      version: 1,
      updated_at: FIXED_ISO,
      origin_device: "hub",
      deleted_at: null,
      token_hash: "hash-secreto"
    }
  ]);
  // p2 desaparece después del upsert: su cambio debe viajar como borrado.
  await driver.remove(PRODUCT_TABLE, ["p2"], {
    company_id: COMPANY,
    origin_device: "hub",
    at: FIXED_ISO
  });

  const feed = await readChangeFeed(driver, { companyId: COMPANY, since: 0, limit: 200, now: () => FIXED_MS });

  assert.equal(feed.latestSeq, 4);
  assert.equal(feed.hasMore, false);
  assert.equal(feed.serverTime, FIXED_ISO);
  const productUpsert = feed.changes.find((c) => c.row_id === "p1");
  assert.ok(productUpsert);
  assert.equal(productUpsert.op, "upsert");
  assert.equal((productUpsert as { row?: LocalRow }).row?.name, "Producto p1");

  const missingRow = feed.changes.find((c) => c.row_id === "p2" && c.op === "upsert");
  assert.equal(missingRow, undefined, "el upsert sin fila vigente se degrada");

  const deviceChange = feed.changes.find((c) => c.table === "hub_devices");
  assert.ok(deviceChange);
  assert.equal(deviceChange.op, "delete", "las tablas internas no entregan su fila");
  assert.equal((deviceChange as { row?: LocalRow }).row, undefined);
  assert.equal(JSON.stringify(feed).includes("hash-secreto"), false);
});

test("el SSE entrega dos páginas seguidas en la misma conexión y sigue sondeando", async () => {
  const feedCalls: number[] = [];
  const changes: HubNodeServerOptionsChanges = async ({ since }) => {
    feedCalls.push(since);
    if (since === 0) return pageOf(changeRecord(1, "p1"), true);
    if (since === 1) return pageOf(changeRecord(2, "p2"), false);
    return { changes: [], latestSeq: 2, serverTime: FIXED_ISO, hasMore: false };
  };
  const h = await setup(changes);
  try {
    const token = await pairDevice(h.hub, h.server);
    const controller = new AbortController();
    const res = await fetch(`${h.server.url}/lan/v1/events?since=0`, {
      headers: signedHeaders(token),
      signal: controller.signal
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.startsWith("text/event-stream"), true);
    assert.ok(res.body);

    const pages = await readDataPages(res.body, 2);
    assert.equal(pages.length, 2, "dos páginas en el mismo stream");
    const first = pages[0] as { changes: Array<{ row_id: string }> };
    const second = pages[1] as { changes: Array<{ row_id: string }> };
    assert.equal(first.changes[0].row_id, "p1");
    assert.equal(second.changes[0].row_id, "p2");

    // La conexión no se corta tras la primera página: el sondeo continúa.
    const callsAfterPages = feedCalls.length;
    await waitFor(() => feedCalls.length > callsAfterPages);
    assert.deepEqual(feedCalls.slice(0, 3), [0, 1, 2]);
    controller.abort();
  } finally {
    await h.server.close();
  }
});

test("el SSE sin firma responde 401 y no abre el stream", async () => {
  const h = await setup(async () => ({ changes: [], latestSeq: 0, serverTime: FIXED_ISO, hasMore: false }));
  try {
    const res = await fetch(`${h.server.url}/lan/v1/events?since=0`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  } finally {
    await h.server.close();
  }
});

test("el SSE sin fuente de cambios responde 503 events_unavailable", async () => {
  const h = await setup();
  try {
    const token = await pairDevice(h.hub, h.server);
    const res = await fetch(`${h.server.url}/lan/v1/events?since=0`, {
      headers: signedHeaders(token)
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "events_unavailable" });
  } finally {
    await h.server.close();
  }
});

function sseStream(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function eventBody(change: ChangeRecord): string {
  return `data: ${JSON.stringify({
    changes: [change],
    latestSeq: change.seq,
    serverTime: FIXED_ISO,
    hasMore: false
  })}\n\n`;
}

test("el cliente reconecta desde el cursor confirmado tras fin del cuerpo", async () => {
  await clearHubSession();
  await saveHubSession({
    hubId: HUB_ID,
    deviceId: DEVICE,
    token: "token-sse-secreto",
    baseUrl: "http://127.0.0.1:48900",
    joinedAt: FIXED_ISO,
    cursor: 0
  });

  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const since = Number(new URL(url).searchParams.get("since") ?? "0");
    const page = { ...changeRecord(since + 5, `p${since + 5}`) };
    return sseStream(eventBody(page));
  }) as typeof fetch;

  const controller = new AbortController();
  const cursors: number[] = [];
  const running = openHubEvents({
    since: 0,
    signal: controller.signal,
    fetchImpl,
    now: () => FIXED_MS,
    baseDelayMs: 5,
    maxDelayMs: 50,
    onChanges: (page) => {
      cursors.push(page.cursor);
      if (cursors.length >= 2) controller.abort();
    }
  });

  await Promise.race([
    running,
    delay(3000).then(() => {
      throw new Error("El cliente no reconectó a tiempo");
    })
  ]);

  assert.ok(urls.length >= 2, "hubo reconexión");
  assert.equal(new URL(urls[0]).searchParams.get("since"), "0");
  assert.equal(new URL(urls[1]).searchParams.get("since"), "5", "reconecta desde el cursor aplicado");
  assert.deepEqual(cursors.slice(0, 2), [5, 10]);
  await clearHubSession();
});

test("event: reset obliga al cliente a reanudar desde cero", async () => {
  await clearHubSession();
  await saveHubSession({
    hubId: HUB_ID,
    deviceId: DEVICE,
    token: "token-sse-secreto",
    baseUrl: "http://127.0.0.1:48900",
    joinedAt: FIXED_ISO,
    cursor: 10
  });
  const controller = new AbortController();
  const cursors: number[] = [];
  const fetchImpl = (async () =>
    sseStream(
      `event: reset\ndata: {"since":0,"latestSeq":3}\n\n${eventBody(changeRecord(3, "p3"))}`
    )) as typeof fetch;

  await Promise.race([
    openHubEvents({
      since: 10,
      signal: controller.signal,
      fetchImpl,
      now: () => FIXED_MS,
      baseDelayMs: 5,
      onChanges: (page) => {
        cursors.push(page.cursor);
        controller.abort();
      }
    }),
    delay(3000).then(() => {
      throw new Error("El cliente no aplicó el reset a tiempo");
    })
  ]);

  assert.deepEqual(cursors, [3], "el cursor retrocede al journal reiniciado");
  await clearHubSession();
});
