import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { HUB_AUTH_HEADERS } from "../../src/services/lanHub/auth";
import { HubClientError, createHubClient } from "../../src/services/lanHub/client";
import type { HubOpInput } from "../../src/services/lanHub/protocol";
import type { LocalRow } from "../../src/services/localDb/contract";

const TOKEN = "token-secreto-dev-1_ABC123";
const DEVICE = "dev-1";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const BASE_URL = "http://192.168.1.10:48900";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(body: unknown, status = 200) {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, impl };
}

function headersOf(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

/** Implementación independiente con node:crypto, como la del hub. */
function expectedSignature(
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  body: string
): string {
  const key = createHash("sha256").update(TOKEN).digest("hex");
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = [method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join("\n");
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

test("changes firma la ruta sin query y envía las cabeceras del protocolo", async () => {
  const { calls, impl } = makeFetch({
    changes: [],
    latestSeq: 7,
    serverTime: FIXED_ISO,
    hasMore: false
  });
  const client = createHubClient({
    baseUrl: BASE_URL + "/",
    deviceId: DEVICE,
    token: TOKEN,
    fetchImpl: impl,
    now: () => FIXED_MS
  });

  const result = await client.changes({ since: 5, limit: 50 });
  assert.equal(result.latestSeq, 7);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, `${BASE_URL}/lan/v1/changes?since=5&limit=50`);
  assert.equal(call.init.method, "GET");
  assert.equal(call.url.includes(TOKEN), false);

  const headers = headersOf(call);
  assert.equal(headers[HUB_AUTH_HEADERS.device], DEVICE);
  assert.equal(headers[HUB_AUTH_HEADERS.timestamp], String(FIXED_MS));
  const nonce = headers[HUB_AUTH_HEADERS.nonce];
  assert.match(nonce, /^[0-9a-f]{32}$/);
  // La firma se calcula sobre /lan/v1/changes, sin `?since=…&limit=…`.
  assert.equal(
    headers[HUB_AUTH_HEADERS.signature],
    expectedSignature("GET", "/lan/v1/changes", FIXED_MS, nonce, "")
  );
});

test("pushOps firma el cuerpo exacto y no expone el token", async () => {
  const row: LocalRow = {
    id: "p1",
    company_id: "co-1",
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: DEVICE,
    deleted_at: null,
    name: "Café"
  };
  const ops: HubOpInput[] = [{ actionId: "a-1", table: "products", rows: [row] }];
  const { calls, impl } = makeFetch({
    results: [{ actionId: "a-1", status: "applied" }],
    latestSeq: 3,
    serverTime: FIXED_ISO
  });
  const client = createHubClient({
    baseUrl: BASE_URL,
    deviceId: DEVICE,
    token: TOKEN,
    fetchImpl: impl,
    now: () => FIXED_MS
  });

  const result = await client.pushOps({ ops });
  assert.deepEqual(result.results, [{ actionId: "a-1", status: "applied" }]);

  const call = calls[0];
  assert.equal(call.url, `${BASE_URL}/lan/v1/ops`);
  assert.equal(call.init.method, "POST");
  const bodyText = String(call.init.body ?? "");
  assert.deepEqual(JSON.parse(bodyText), { deviceId: DEVICE, ops });
  assert.equal(bodyText.includes(TOKEN), false);

  const headers = headersOf(call);
  assert.equal(headers["content-type"], "application/json");
  assert.equal(
    headers[HUB_AUTH_HEADERS.signature],
    expectedSignature("POST", "/lan/v1/ops", FIXED_MS, headers[HUB_AUTH_HEADERS.nonce], bodyText)
  );
});

test("un 401 y un 409 se normalizan sin incluir el token en el mensaje", async () => {
  const unauthorized = makeFetch({ error: "invalid_signature" }, 401);
  const client401 = createHubClient({
    baseUrl: BASE_URL,
    deviceId: DEVICE,
    token: TOKEN,
    fetchImpl: unauthorized.impl,
    now: () => FIXED_MS
  });
  await assert.rejects(client401.health(), (error: unknown) => {
    assert.ok(error instanceof HubClientError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "invalid_signature");
    assert.match(error.message, /401/);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });

  const conflict = makeFetch({ error: "conflict" }, 409);
  const client409 = createHubClient({
    baseUrl: BASE_URL,
    deviceId: DEVICE,
    token: TOKEN,
    fetchImpl: conflict.impl,
    now: () => FIXED_MS
  });
  await assert.rejects(client409.pushOps({ ops: [] }), (error: unknown) => {
    assert.ok(error instanceof HubClientError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "conflict");
    assert.match(error.message, /conflicto/);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test("un hub que no responde produce timeout controlado", async () => {
  const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;
  const client = createHubClient({
    baseUrl: BASE_URL,
    deviceId: DEVICE,
    token: TOKEN,
    fetchImpl: hanging,
    now: () => FIXED_MS,
    timeoutMs: 25
  });
  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof HubClientError);
    assert.equal(error.status, 0);
    assert.equal(error.code, "timeout");
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test("snapshot recorre una tabla por petición y rechaza las internas", async () => {
  const { calls, impl } = makeFetch({ rows: [], latestSeq: 9 });
  const client = createHubClient({
    baseUrl: BASE_URL,
    deviceId: DEVICE,
    token: TOKEN,
    fetchImpl: impl,
    now: () => FIXED_MS
  });

  const page = await client.snapshot({ tables: ["products", "sales"] });
  assert.deepEqual(page, { rows: [], latestSeq: 9 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/lan\/v1\/snapshot\?table=products$/);
  assert.match(calls[1].url, /\/lan\/v1\/snapshot\?table=sales$/);

  await assert.rejects(client.snapshot({ tables: ["hub_devices"] }), /interna del hub/);
});

test("una dirección que no es http(s) se rechaza al crear el cliente", () => {
  assert.throws(
    () =>
      createHubClient({
        baseUrl: "ftp://192.168.1.10:48900",
        deviceId: DEVICE,
        token: TOKEN
      }),
    /http o https/
  );
});
