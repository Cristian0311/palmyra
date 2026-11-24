/**
 * Canal de eventos del hub: lectura del journal (`changesFeed`) y
 * comportamiento del cliente SSE (`events`).
 *
 * El servidor HTTP que monta el stream se prueba en `lan-hub-server.test.ts`;
 * aquí se cubren las dos piezas puras: la página que sirve el hub sin firmar y
 * el bucle del cliente que solo reconecta cuando la conexión se cae de verdad.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeRecord, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { readChangeFeed } from "../../src/services/lanHub/changesFeed";
import { openHubEvents } from "../../src/services/lanHub/events";
import { clearHubSession, saveHubSession } from "../../src/services/lanHub/session";

const COMPANY = "co-1";
const OTHER_COMPANY = "co-2";
const HUB_ID = "hub-events";
const DEVICE = "dev-events";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const PRODUCTS = "products";

function row(id: string, companyId = COMPANY, name = `Producto ${id}`): LocalRow {
  return {
    id,
    company_id: companyId,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: "hub",
    deleted_at: null,
    name
  };
}

async function makeDriver(): Promise<ReturnType<typeof createMemoryDriver>> {
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  return driver;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("readChangeFeed pagina el journal y adjunta solo filas vigentes de la empresa", async () => {
  const driver = await makeDriver();
  try {
    // Journal: p1(1), p2(2), borrado de p1(3), upsert de otra empresa(4),
    // cambio de tabla interna(5).
    await driver.put(PRODUCTS, [row("p1"), row("p2")]);
    await driver.remove(PRODUCTS, ["p1"], {
      company_id: COMPANY,
      origin_device: "hub",
      at: FIXED_ISO
    });
    await driver.put(PRODUCTS, [row("x1", OTHER_COMPANY)]);
    await driver.put("hub_devices", [
      {
        id: "dev-1",
        company_id: COMPANY,
        version: 1,
        updated_at: FIXED_ISO,
        origin_device: "hub",
        deleted_at: null,
        token_hash: "hash-secreto"
      }
    ]);

    const first = await readChangeFeed(driver, {
      companyId: COMPANY,
      since: 0,
      limit: 2,
      now: () => FIXED_MS
    });
    assert.equal(first.latestSeq, 5);
    assert.equal(first.hasMore, true);
    assert.equal(first.serverTime, FIXED_ISO);
    assert.deepEqual(first.changes.map((c) => c.seq), [1, 2]);
    // p1 se borró después de su upsert: la página vigente ya no tiene fila y el
    // cambio se degrada a lápida para que un equipo tardío no lo resucite.
    assert.equal(first.changes[0].op, "delete");
    assert.equal((first.changes[0] as { row?: LocalRow }).row, undefined);
    assert.equal(first.changes[1].op, "upsert");
    assert.equal((first.changes[1] as { row?: LocalRow }).row?.name, "Producto p2");

    const second = await readChangeFeed(driver, { companyId: COMPANY, since: 2, limit: 2 });
    assert.equal(second.hasMore, true);
    assert.deepEqual(second.changes.map((c) => c.seq), [3, 4]);
    assert.equal(second.changes[0].op, "delete", "el borrado viaja tal cual");
    // El upsert de otra empresa se degrada a lápida y no expone su fila.
    assert.equal(second.changes[1].op, "delete");
    assert.equal((second.changes[1] as { row?: LocalRow }).row, undefined);

    const third = await readChangeFeed(driver, { companyId: COMPANY, since: 4, limit: 2 });
    assert.equal(third.hasMore, false);
    assert.deepEqual(third.changes.map((c) => c.seq), [5]);
    assert.equal(third.changes[0].table, "hub_devices");
    assert.equal(third.changes[0].op, "delete", "las tablas internas no entregan fila");
    assert.equal(JSON.stringify(third).includes("hash-secreto"), false);
  } finally {
    await driver.close();
  }
});

test("readChangeFeed exige companyId y acota since/limit", async () => {
  const driver = await makeDriver();
  try {
    await driver.put(PRODUCTS, [row("p1")]);
    await assert.rejects(() => readChangeFeed(driver, { companyId: "  " }), /companyId/);

    // since negativo y limit inválido caen a los valores por defecto.
    const feed = await readChangeFeed(driver, {
      companyId: COMPANY,
      since: -10,
      limit: 0,
      now: () => FIXED_MS
    });
    assert.equal(feed.changes.length, 1);
    assert.equal(feed.changes[0].row_id, "p1");
  } finally {
    await driver.close();
  }
});

// ─── Cliente SSE ────────────────────────────────────────────────────────────

function pageEvent(seq: number, rowId: string): string {
  const change: ChangeRecord = {
    seq,
    table: PRODUCTS,
    row_id: rowId,
    op: "upsert",
    company_id: COMPANY,
    updated_at: FIXED_ISO,
    origin_device: "hub",
    recorded_at: FIXED_ISO
  };
  return `data: ${JSON.stringify({
    changes: [change],
    latestSeq: seq,
    serverTime: FIXED_ISO,
    hasMore: false
  })}\n\n`;
}

function sseResponse(body: string): Response {
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

async function bindSession(cursor: number): Promise<void> {
  await saveHubSession({
    hubId: HUB_ID,
    deviceId: DEVICE,
    token: "token-sse-secreto",
    baseUrl: "http://127.0.0.1:48900",
    joinedAt: FIXED_ISO,
    cursor
  });
}

test("con el stream vivo el cliente no encadena reconexiones", async () => {
  await clearHubSession();
  await bindSession(0);

  const urls: string[] = [];
  let closeStream: (() => void) | null = null;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(pageEvent(1, "p1")));
        // No se cierra: simula un canal SSE sano y ocioso.
        closeStream = () => {
          try {
            controller.close();
          } catch {
            // El stream ya estaba cerrado.
          }
        };
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof fetch;

  const controller = new AbortController();
  let pages = 0;
  let received: (() => void) | null = null;
  const firstPage = new Promise<void>((resolve) => {
    received = resolve;
  });

  const running = openHubEvents({
    since: 0,
    signal: controller.signal,
    fetchImpl,
    now: () => FIXED_MS,
    baseDelayMs: 5,
    maxDelayMs: 20,
    onChanges: (page) => {
      pages += 1;
      assert.equal(page.cursor, 1);
      received?.();
    }
  });

  try {
    await Promise.race([
      firstPage,
      delay(2000).then(() => {
        throw new Error("La primera página no llegó a tiempo");
      })
    ]);
    // Margen suficiente para varios intervalos de backoff si reconectara.
    await delay(150);
    assert.equal(pages, 1);
    assert.equal(urls.length, 1, "un stream vivo no debe reabrir la conexión");
  } finally {
    controller.abort();
    closeStream?.();
    await running;
    await clearHubSession();
  }
});

test("un error de red inicial se reintenta con backoff y reanuda desde el cursor", async () => {
  await clearHubSession();
  await bindSession(0);

  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("red caída");
    return sseResponse(pageEvent(5, "p5"));
  }) as typeof fetch;

  const controller = new AbortController();
  const cursors: number[] = [];

  await openHubEvents({
    since: 0,
    signal: controller.signal,
    fetchImpl,
    now: () => FIXED_MS,
    baseDelayMs: 2,
    maxDelayMs: 20,
    maxInitialAttempts: 3,
    onChanges: (page) => {
      cursors.push(page.cursor);
      controller.abort();
    }
  });

  assert.equal(attempts, 2, "un fallo de red y una reconexión");
  assert.deepEqual(cursors, [5], "reanuda con el cursor aplicado");
  await clearHubSession();
});

test("un rechazo de autenticación no se reintenta en bucle", async () => {
  await clearHubSession();
  await bindSession(0);

  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    if (attempts === 1) return sseResponse(pageEvent(1, "p1"));
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  await assert.rejects(
    () =>
      openHubEvents({
        since: 0,
        signal: new AbortController().signal,
        fetchImpl,
        now: () => FIXED_MS,
        baseDelayMs: 2,
        maxDelayMs: 20,
        onChanges: () => {
          // La primera página se aplica; la reconexión choca con el 401.
        }
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "http");
      assert.equal((error as { status?: number }).status, 401);
      return true;
    }
  );
  assert.equal(attempts, 2, "no hay reintentos tras un 401");
  await clearHubSession();
});
