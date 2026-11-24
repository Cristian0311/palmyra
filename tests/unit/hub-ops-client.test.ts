import test from "node:test";
import assert from "node:assert/strict";
import {
  HUB_AUTH_HEADERS,
  createReplayGuard,
  verifyHubRequest
} from "../../src/services/lanHub/auth";
import {
  createHubOpsClient,
  isHubOpSuccess,
  type HubOperation
} from "../../src/services/lanHub/opsClient";

const TOKEN = "token-secreto-ops-dev_ABC123";
const DEVICE = "dev-1";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const BASE_URL = "http://192.168.1.10:48900";
const OPS_URL = `${BASE_URL}/lan/v1/ops`;

interface FetchCall {
  url: string;
  init: RequestInit;
  body: string;
  headers: Record<string, string>;
}

type Step = { status?: number; body?: unknown } | Error;

/** Fetch simulado por pasos: cada llamada consume el siguiente (el último se repite). */
function scriptedFetch(steps: Step[]) {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init: init ?? {},
      body: typeof init?.body === "string" ? init.body : "",
      headers: (init?.headers ?? {}) as Record<string, string>
    });
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step?.body ?? {}), {
      status: step?.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, impl };
}

interface ExtraOptions {
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

function makeClient(impl: typeof fetch, extra: ExtraOptions = {}) {
  return createHubOpsClient({
    baseUrl: `${BASE_URL}/`,
    token: TOKEN,
    deviceId: DEVICE,
    fetchImpl: impl,
    now: () => FIXED_MS,
    ...extra
  });
}

function sampleRow(id: string, companyId = "c-1") {
  return {
    id,
    company_id: companyId,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: DEVICE
  };
}

function sampleOps(): HubOperation[] {
  return [
    { actionId: "a-1", table: "products", rows: [sampleRow("p1")], deletes: [] },
    { actionId: "a-2", table: "sales", rows: [], deletes: ["s-9"] }
  ];
}

test("un lote aceptado devuelve un acuse por operación y firma el cuerpo exacto", async () => {
  const { calls, impl } = scriptedFetch([
    {
      body: {
        results: [
          { actionId: "a-1", status: "applied" },
          { actionId: "a-2", status: "applied" }
        ],
        latestSeq: 12,
        serverTime: FIXED_ISO
      }
    }
  ]);

  const result = await makeClient(impl).push(sampleOps());
  assert.ok(result.ok, "el lote debe aceptarse");
  assert.deepEqual(result.results, [
    { actionId: "a-1", status: "accepted" },
    { actionId: "a-2", status: "accepted" }
  ]);
  assert.equal(result.latestSeq, 12);
  assert.equal(result.serverTime, FIXED_ISO);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, OPS_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");
  assert.equal(call.headers.accept, "application/json");
  // El sobre viaja tal cual: deviceId + operaciones idempotentes, sin el token.
  assert.deepEqual(JSON.parse(call.body), { deviceId: DEVICE, ops: sampleOps() });
  assert.equal(call.body.includes(TOKEN), false);
  assert.equal(call.url.includes(TOKEN), false);
});

test("la firma del lote la acepta el verificador del hub con el mismo token", async () => {
  const { calls, impl } = scriptedFetch([
    {
      body: {
        results: [{ actionId: "a-1", status: "applied" }],
        latestSeq: 1,
        serverTime: FIXED_ISO
      }
    }
  ]);

  const result = await makeClient(impl).push([sampleOps()[0]]);
  assert.ok(result.ok);

  const call = calls[0];
  const headers = call.headers;
  assert.equal(headers[HUB_AUTH_HEADERS.device], DEVICE);
  assert.equal(headers[HUB_AUTH_HEADERS.timestamp], String(FIXED_MS));
  assert.match(headers[HUB_AUTH_HEADERS.nonce], /^[0-9a-f]{32}$/);

  const signed = {
    token: TOKEN,
    deviceId: DEVICE,
    method: "POST",
    path: "/lan/v1/ops",
    timestamp: headers[HUB_AUTH_HEADERS.timestamp],
    nonce: headers[HUB_AUTH_HEADERS.nonce],
    signature: headers[HUB_AUTH_HEADERS.signature],
    body: call.body,
    now: FIXED_MS
  };
  assert.deepEqual(verifyHubRequest(signed), { ok: true });

  // Cualquier cambio en el cuerpo invalida la firma: el hub firma el texto exacto.
  assert.deepEqual(verifyHubRequest({ ...signed, body: call.body.replace("a-1", "a-9") }), {
    ok: false,
    reason: "invalid_signature"
  });

  // El nonce también protege contra repetición del mismo lote.
  const replay = createReplayGuard({ now: () => FIXED_MS });
  assert.deepEqual(verifyHubRequest({ ...signed, replay }), { ok: true });
  assert.deepEqual(verifyHubRequest({ ...signed, replay }), { ok: false, reason: "replayed_nonce" });
});

test("un duplicado del hub cuenta como éxito", async () => {
  const { calls, impl } = scriptedFetch([
    {
      body: {
        results: [{ actionId: "a-1", status: "duplicate" }],
        latestSeq: 5,
        serverTime: FIXED_ISO
      }
    }
  ]);

  const result = await makeClient(impl).push([sampleOps()[0]]);
  assert.ok(result.ok);
  assert.deepEqual(result.results, [{ actionId: "a-1", status: "duplicate" }]);
  assert.equal(isHubOpSuccess(result.results[0].status), true);
  assert.equal(calls.length, 1);
});

test("un rechazo del hub se conserva por operación y no invalida el lote", async () => {
  const { impl } = scriptedFetch([
    {
      body: {
        results: [
          { actionId: "a-1", status: "applied" },
          { actionId: "a-2", status: "rejected", error: "unknown_table" }
        ],
        latestSeq: 5,
        serverTime: FIXED_ISO
      }
    }
  ]);

  const result = await makeClient(impl).push(sampleOps());
  assert.ok(result.ok);
  assert.deepEqual(result.results, [
    { actionId: "a-1", status: "accepted" },
    { actionId: "a-2", status: "rejected", error: "unknown_table" }
  ]);
  assert.equal(isHubOpSuccess("rejected"), false);
});

test("un 401 no se reintenta", async () => {
  const { calls, impl } = scriptedFetch([
    { status: 401, body: { error: "unauthorized" } },
    { body: { results: [], latestSeq: 0, serverTime: FIXED_ISO } }
  ]);
  const waits: number[] = [];

  const result = await makeClient(impl, {
    sleep: async (ms) => {
      waits.push(ms);
    }
  }).push(sampleOps());

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("un 401 no debe aceptarse");
  assert.equal(result.error, "unauthorized");
  assert.equal(result.retryable, false);
  assert.equal(result.error.includes(TOKEN), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, [], "un 4xx no consume backoff");
});

test("un 503 reintenta con backoff acotado y acepta el duplicado final", async () => {
  const { calls, impl } = scriptedFetch([
    { status: 503, body: { error: "unavailable" } },
    { status: 503, body: { error: "unavailable" } },
    {
      body: {
        results: [{ actionId: "a-1", status: "duplicate" }],
        latestSeq: 9,
        serverTime: FIXED_ISO
      }
    }
  ]);
  const waits: number[] = [];

  const result = await makeClient(impl, {
    sleep: async (ms) => {
      waits.push(ms);
    }
  }).push([sampleOps()[0]]);

  assert.ok(result.ok);
  assert.deepEqual(result.results, [{ actionId: "a-1", status: "duplicate" }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [250, 500], "backoff exponencial desde baseDelayMs");
  // Reintentar reenvía la misma propuesta: mismo cuerpo y mismo actionId…
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[1].body, calls[2].body);
  // …pero cada intento lleva un nonce nuevo.
  assert.notEqual(calls[0].headers[HUB_AUTH_HEADERS.nonce], calls[1].headers[HUB_AUTH_HEADERS.nonce]);
  assert.notEqual(calls[1].headers[HUB_AUTH_HEADERS.nonce], calls[2].headers[HUB_AUTH_HEADERS.nonce]);
});

test("el backoff se corta en maxAttempts y maxDelayMs", async () => {
  const { calls, impl } = scriptedFetch([{ status: 500, body: { error: "internal_error" } }]);
  const waits: number[] = [];

  const result = await makeClient(impl, {
    maxAttempts: 4,
    baseDelayMs: 300,
    maxDelayMs: 500,
    sleep: async (ms) => {
      waits.push(ms);
    }
  }).push([sampleOps()[0]]);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("un 500 sostenido no debe aceptarse");
  assert.equal(result.error, "internal_error");
  assert.equal(result.retryable, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [300, 500, 500]);
});

test("un fallo de red reintenta con el mismo actionId y sin esperas reales", async () => {
  const { calls, impl } = scriptedFetch([
    new TypeError("fetch failed"),
    {
      body: {
        results: [{ actionId: "a-1", status: "applied" }],
        latestSeq: 2,
        serverTime: FIXED_ISO
      }
    }
  ]);
  const waits: number[] = [];

  const result = await makeClient(impl, {
    sleep: async (ms) => {
      waits.push(ms);
    }
  }).push([sampleOps()[0]]);

  assert.ok(result.ok);
  assert.deepEqual(result.results, [{ actionId: "a-1", status: "accepted" }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [250]);
  assert.equal(calls[0].body, calls[1].body);
});

test("un hub que no responde se corta por timeout y queda reintentable", async () => {
  const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;

  const result = await makeClient(hanging, { maxAttempts: 1, timeoutMs: 10 }).push([sampleOps()[0]]);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("un timeout no debe aceptarse");
  assert.equal(result.error, "timeout");
  assert.equal(result.retryable, true);
});

test("un lote vacío no golpea al hub", async () => {
  const { calls, impl } = scriptedFetch([{ body: { results: [] } }]);

  const result = await makeClient(impl).push([]);
  assert.ok(result.ok);
  assert.deepEqual(result.results, []);
  assert.equal(calls.length, 0);
});

test("valida la configuración y las operaciones antes de firmar", async () => {
  assert.throws(
    () => createHubOpsClient({ baseUrl: "ftp://192.168.1.10:48900", token: TOKEN, deviceId: DEVICE }),
    /http o https/
  );
  assert.throws(
    () => createHubOpsClient({ baseUrl: BASE_URL, token: "  ", deviceId: DEVICE }),
    /token/
  );
  assert.throws(
    () => createHubOpsClient({ baseUrl: BASE_URL, token: TOKEN, deviceId: "" }),
    /identificador/
  );

  const { calls, impl } = scriptedFetch([{ body: { results: [] } }]);
  const client = makeClient(impl);
  await assert.rejects(
    client.push([{ actionId: "   ", table: "products", rows: [sampleRow("p1")], deletes: [] }]),
    /actionId/
  );
  await assert.rejects(client.push([{ actionId: "a-1", table: " ", rows: [], deletes: [] }]), /tabla/);
  assert.equal(calls.length, 0, "una propuesta inválida no se envía");
});
