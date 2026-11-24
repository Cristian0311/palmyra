import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { ChangeRecord, LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  HUB_AUTH_HEADERS,
  HUB_PROTOCOL_VERSION,
  HUB_ROUTES,
  createHubHandler,
  createHubNodeServer,
  signHubRequest,
  type HubChangesResponse,
  type HubHandler,
  type HubNodeServer,
  type HubNodeServerOptions,
  type HubOpsResponse,
  type HubPairResponse
} from "../../src/services/lanHub";

const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const COMPANY = "co-1";
const HUB_ID = "hub-1";
const PAIRING_CODE = "48219307";

interface TestClock {
  now(): number;
  advance(ms: number): void;
}

function makeClock(): TestClock {
  let current = FIXED_MS;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

interface Harness {
  clock: TestClock;
  driver: LocalDbDriver;
  hub: HubHandler;
  server: HubNodeServer;
  logs: string[];
}

interface HarnessOptions {
  port?: number;
  maxBodyBytes?: number;
  changes?: HubNodeServerOptions["changes"];
  eventsPollMs?: number;
}

function makeHub(clock: TestClock, driver: LocalDbDriver): HubHandler {
  return createHubHandler({
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => clock.now(),
    pairingCode: () => PAIRING_CODE
  });
}

async function setup(options: HarnessOptions = {}): Promise<Harness> {
  const clock = makeClock();
  const driver = createMemoryDriver({ now: () => new Date(clock.now()).toISOString() });
  await driver.ready();
  const hub = makeHub(clock, driver);
  const logs: string[] = [];
  const server = await createHubNodeServer({
    handler: hub,
    port: options.port ?? 0,
    maxBodyBytes: options.maxBodyBytes,
    ...(options.eventsPollMs ? { eventsPollMs: options.eventsPollMs } : {}),
    ...(options.changes ? { changes: options.changes } : {}),
    log: (line) => logs.push(line)
  });
  return { clock, driver, hub, server, logs };
}

async function pairDevice(hub: HubHandler, server: HubNodeServer, deviceId = "dev-1"): Promise<string> {
  const session = hub.createPairingSession();
  const res = await fetch(`${server.url}/lan/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode: session.code,
      deviceId,
      deviceName: "Caja 1",
      platform: "windows",
      companyId: COMPANY
    })
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as HubPairResponse).deviceToken;
}

let nonceSeq = 0;

interface SignedInput {
  token: string;
  deviceId?: string;
  method?: "GET" | "POST";
  path: string;
  body?: string;
  timestamp?: number;
  nonce?: string;
  signature?: string;
}

async function signedFetch(
  server: HubNodeServer,
  clock: TestClock,
  input: SignedInput
): Promise<Response> {
  const method = input.method ?? "POST";
  const body = input.body ?? "";
  const timestamp = input.timestamp ?? clock.now();
  const nonce = input.nonce ?? `nonce-${++nonceSeq}`;
  const signature =
    input.signature ??
    signHubRequest({
      token: input.token,
      method,
      path: input.path,
      timestamp,
      nonce,
      body
    });
  return fetch(`${server.url}${input.path}`, {
    method,
    headers: {
      "content-type": "application/json",
      [HUB_AUTH_HEADERS.device]: input.deviceId ?? "dev-1",
      [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
      [HUB_AUTH_HEADERS.nonce]: nonce,
      [HUB_AUTH_HEADERS.signature]: signature
    },
    body: method === "POST" ? body : undefined
  });
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Cliente crudo: `fetch` prohíbe cuerpo en GET y aquí sí hace falta. */
function rawRequest(
  server: HubNodeServer,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<RawResponse> {
  const url = new URL(server.url);
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        method: options.method,
        path: options.path,
        headers: options.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function product(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: "dev-1",
    deleted_at: null,
    name: `Producto ${id}`,
    ...fields
  };
}

function opsBody(ops: unknown[], deviceId = "dev-1"): string {
  return JSON.stringify({ deviceId, ops });
}

test("health responde 200 JSON sin firma y con cabeceras del protocolo", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const res = await fetch(`${h.server.url}/lan/v1/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-palmyra-protocol"), String(HUB_PROTOCOL_VERSION));

  const body = (await res.json()) as { ok: boolean; protocol: number; hubId: string; devices: number };
  assert.equal(body.ok, true);
  assert.equal(body.protocol, HUB_PROTOCOL_VERSION);
  assert.equal(body.hubId, HUB_ID);
  assert.equal(body.devices, 0);
});

test("emparejar y enviar una operación firmada por HTTP aplica la fila", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const token = await pairDevice(h.hub, h.server);
  const res = await signedFetch(h.server, h.clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([
      { actionId: "a-1", table: "sales", rows: [product("sale-1", { total: 250 })] }
    ])
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as HubOpsResponse;
  assert.deepEqual(body.results, [{ actionId: "a-1", status: "applied" }]);
  assert.equal((await h.driver.get<LocalRow>("sales", "sale-1"))?.total, 250);

  const access = h.logs[h.logs.length - 1];
  assert.match(access, /\[lan-hub\] POST \/lan\/v1\/ops 200 \d+ms 127\.0\.0\.1/);
  assert.equal(access.includes(token), false);
  assert.equal(access.includes("x-palmyra-signature"), false);
  assert.equal(access.includes("nonce-"), false);
});

test("reintentar el mismo actionId por HTTP responde duplicate sin duplicar", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const token = await pairDevice(h.hub, h.server);
  const body = opsBody([
    { actionId: "a-1", table: "products", rows: [product("p1")] }
  ]);

  const first = await signedFetch(h.server, h.clock, { token, path: "/lan/v1/ops", body });
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as HubOpsResponse).results[0].status, "applied");

  const second = await signedFetch(h.server, h.clock, { token, path: "/lan/v1/ops", body });
  assert.equal(second.status, 200);
  assert.deepEqual(((await second.json()) as HubOpsResponse).results, [
    { actionId: "a-1", status: "duplicate" }
  ]);
  assert.equal((await h.driver.query({ table: "products" })).length, 1);
  assert.equal((await h.driver.query({ table: "hub_receipts" })).length, 1);
});

test("una firma inválida por HTTP se rechaza con 401 y no escribe nada", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const token = await pairDevice(h.hub, h.server);
  const res = await signedFetch(h.server, h.clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([{ actionId: "a-1", table: "products", rows: [product("p1")] }]),
    signature: "f".repeat(64)
  });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "invalid_signature" });
  assert.equal(await h.driver.get("products", "p1"), null);
});

test("un GET con cuerpo JSON no rompe y responde el health", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const body = JSON.stringify({ ignorado: true });
  const res = await rawRequest(h.server, {
    method: "GET",
    path: "/lan/v1/health?desconocido=1",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers["x-palmyra-protocol"], String(HUB_PROTOCOL_VERSION));
  assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, true);
});

test("un cuerpo mayor que el tope responde 413 y cierra la conexión", async (t) => {
  const h = await setup({ maxBodyBytes: 512 });
  t.after(() => h.server.close());

  const big = opsBody([
    {
      actionId: "a-big",
      table: "products",
      rows: [product("p-big", { blob: "x".repeat(4096) })]
    }
  ]);
  assert.ok(big.length > 512);

  const res = await fetch(`${h.server.url}/lan/v1/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: big
  });

  assert.equal(res.status, 413);
  assert.equal(res.headers.get("connection"), "close");
  assert.deepEqual(await res.json(), { error: "body_too_large" });

  // El servidor sigue vivo: la conexión cerrada era solo la de esta petición.
  const health = await fetch(`${h.server.url}/lan/v1/health`);
  assert.equal(health.status, 200);
});

test("un método no permitido responde 405 JSON", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const res = await fetch(`${h.server.url}/lan/v1/health`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}"
  });

  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, POST");
  assert.deepEqual(await res.json(), { error: "method_not_allowed" });
});

test("una ruta desconocida responde 404 JSON", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const res = await fetch(`${h.server.url}/lan/v1/desconocido`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("un host no loopback sin allowLan se rechaza antes de escuchar", async () => {
  const clock = makeClock();
  const driver = createMemoryDriver({ now: () => new Date(clock.now()).toISOString() });
  await driver.ready();
  const hub = makeHub(clock, driver);

  await assert.rejects(
    () => createHubNodeServer({ handler: hub, host: "192.168.1.10", port: 0 }),
    /LAN deshabilitada/
  );
});

test("close() libera el puerto y permite reabrirlo", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const port = h.server.port;
  assert.ok(port > 0);
  const health = await fetch(`${h.server.url}/lan/v1/health`);
  assert.equal(health.status, 200);

  await h.server.close();

  const reopened = await createHubNodeServer({ handler: h.hub, port });
  try {
    assert.equal(reopened.port, port);
    const res = await fetch(`${reopened.url}/lan/v1/health`);
    assert.equal(res.status, 200);
  } finally {
    await reopened.close();
  }
});

test("si el handler lanza, responde 500 genérico sin detalles", async (t) => {
  const throwing: HubHandler = Object.assign(
    async () => {
      throw new Error("boom token=secreto");
    },
    {
      createPairingSession: () => ({ code: "00000000", expiresAt: FIXED_ISO }),
      currentPairingSession: () => null
    }
  );
  const server = await createHubNodeServer({ handler: throwing });
  t.after(() => server.close());

  const res = await fetch(`${server.url}/lan/v1/health`);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: "internal_error" });
  assert.equal(text.includes("boom"), false);
});

// ─── Canal SSE ──────────────────────────────────────────────────────────────

let eventNonceSeq = 0;

/**
 * Cabeceras firmadas del canal. La firma canónica usa `/lan/v1/changes` (la
 * ruta que el handler autentica), igual que hace `events.ts` en el cliente.
 */
function eventHeaders(
  clock: TestClock,
  token: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  const timestamp = clock.now();
  const nonce = `event-nonce-${++eventNonceSeq}`;
  return {
    [HUB_AUTH_HEADERS.device]: "dev-1",
    [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
    [HUB_AUTH_HEADERS.nonce]: nonce,
    [HUB_AUTH_HEADERS.signature]: signHubRequest({
      token,
      method: "GET",
      path: HUB_ROUTES.changes,
      timestamp,
      nonce,
      body: ""
    }),
    accept: "text/event-stream",
    ...overrides
  };
}

function changeRecord(seq: number, rowId: string): ChangeRecord {
  return {
    seq,
    table: "products",
    row_id: rowId,
    op: "upsert",
    company_id: COMPANY,
    updated_at: FIXED_ISO,
    origin_device: "dev-1",
    recorded_at: FIXED_ISO
  };
}

function changesPage(
  changes: ChangeRecord[],
  latestSeq: number,
  hasMore = false
): HubChangesResponse {
  return { changes, latestSeq, serverTime: FIXED_ISO, hasMore };
}

interface EventReader {
  next(): Promise<Record<string, unknown>>;
  cancel(): Promise<void>;
}

/** Extrae bloques `data:` de un `text/event-stream` y descarta los `: ping`. */
function openEventReader(body: NonNullable<Response["body"]>): EventReader {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const cut = buffer.indexOf("\n\n");
        if (cut !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
          if (dataLine) return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("el stream terminó antes de la página esperada");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        // El stream ya estaba cerrado por el aborto de la petición.
      }
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Tiempo de espera agotado");
    await delay(10);
  }
}

test("el canal SSE entrega dos páginas seguidas sin cerrar la conexión", async (t) => {
  const calls: number[] = [];
  const changes: HubNodeServerOptions["changes"] = async ({ since }) => {
    calls.push(since);
    if (since === 0) return changesPage([changeRecord(1, "p1")], 2, true);
    if (since === 1) return changesPage([changeRecord(2, "p2")], 2);
    return changesPage([], 2);
  };
  const h = await setup({ changes, eventsPollMs: 20 });
  const controller = new AbortController();
  let reader: EventReader | null = null;
  t.after(async () => {
    controller.abort();
    if (reader) await reader.cancel();
    await h.server.close();
  });

  const token = await pairDevice(h.hub, h.server);
  const res = await fetch(`${h.server.url}/lan/v1/events?since=0`, {
    headers: eventHeaders(h.clock, token),
    signal: controller.signal
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(res.body);

  reader = openEventReader(res.body);
  const first = (await reader.next()) as { changes: Array<{ row_id: string }> };
  const second = (await reader.next()) as { changes: Array<{ row_id: string }> };
  assert.equal(first.changes[0].row_id, "p1");
  assert.equal(second.changes[0].row_id, "p2");

  // La conexión sigue viva: el sondeo continúa desde el cursor confirmado.
  const before = calls.length;
  await waitFor(() => calls.length > before);
  assert.deepEqual(calls.slice(0, 3), [0, 1, 2]);
});

test("una firma inválida no abre el canal SSE", async (t) => {
  const h = await setup({
    changes: async () => changesPage([], 0),
    eventsPollMs: 20
  });
  t.after(() => h.server.close());

  const token = await pairDevice(h.hub, h.server);
  const res = await fetch(`${h.server.url}/lan/v1/events?since=0`, {
    headers: eventHeaders(h.clock, token, { [HUB_AUTH_HEADERS.signature]: "f".repeat(64) })
  });

  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), { error: "invalid_signature" });
});

test("sin fuente de cambios el canal SSE responde 503 events_unavailable", async (t) => {
  const h = await setup();
  t.after(() => h.server.close());

  const token = await pairDevice(h.hub, h.server);
  const res = await fetch(`${h.server.url}/lan/v1/events?since=0`, {
    headers: eventHeaders(h.clock, token)
  });

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "events_unavailable" });
});

test("una segunda conexión SSE del mismo equipo se rechaza y la primera sigue viva", async (t) => {
  let released = false;
  const calls: number[] = [];
  const changes: HubNodeServerOptions["changes"] = async ({ since }) => {
    calls.push(since);
    if (since === 0) return changesPage([changeRecord(1, "p1")], 2);
    if (since === 1 && released) return changesPage([changeRecord(2, "p2")], 2);
    return changesPage([], 2);
  };
  const h = await setup({ changes, eventsPollMs: 20 });
  const controller = new AbortController();
  let reader: EventReader | null = null;
  t.after(async () => {
    controller.abort();
    if (reader) await reader.cancel();
    await h.server.close();
  });

  const token = await pairDevice(h.hub, h.server);
  const first = await fetch(`${h.server.url}/lan/v1/events?since=0`, {
    headers: eventHeaders(h.clock, token),
    signal: controller.signal
  });
  assert.equal(first.status, 200);
  assert.ok(first.body);
  reader = openEventReader(first.body);
  const page = (await reader.next()) as { changes: Array<{ row_id: string }> };
  assert.equal(page.changes[0].row_id, "p1");

  // Segundo canal con nonce nuevo: la firma es válida, pero el equipo ya tiene
  // un stream abierto.
  const second = await fetch(`${h.server.url}/lan/v1/events?since=1`, {
    headers: eventHeaders(h.clock, token)
  });
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "events_already_open" });

  // El primer canal no se vio afectado: sigue entregando páginas.
  released = true;
  const next = (await reader.next()) as { changes: Array<{ row_id: string }> };
  assert.equal(next.changes[0].row_id, "p2");
});

