import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  HUB_AUTH_HEADERS,
  HUB_CLOCK_SKEW_MS,
  HUB_PROTOCOL_VERSION,
  createHubHandler,
  hashDeviceToken,
  signHubRequest,
  type HubHandler,
  type HubOpsResponse,
  type HubPairResponse,
  type HubRequest,
  type HubResponse
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

interface TestHub {
  clock: TestClock;
  driver: LocalDbDriver;
  hub: HubHandler;
}

async function setup(): Promise<TestHub> {
  const clock = makeClock();
  const driver = createMemoryDriver({ now: () => new Date(clock.now()).toISOString() });
  await driver.ready();
  const hub = createHubHandler({
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => clock.now(),
    pairingCode: () => PAIRING_CODE
  });
  return { clock, driver, hub };
}

async function pairDevice(hub: HubHandler, deviceId = "dev-1"): Promise<string> {
  const session = hub.createPairingSession();
  const res = await hub({
    method: "POST",
    path: "/lan/v1/pair",
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({
      pairingCode: session.code,
      deviceId,
      deviceName: "Caja 1",
      platform: "windows",
      companyId: COMPANY
    })
  });
  assert.equal(res.status, 200);
  return (JSON.parse(res.body) as HubPairResponse).deviceToken;
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
}

function buildSigned(clock: TestClock, input: SignedInput): HubRequest {
  const deviceId = input.deviceId ?? "dev-1";
  const method = input.method ?? "POST";
  const body = input.body ?? "";
  const timestamp = input.timestamp ?? clock.now();
  const nonce = input.nonce ?? `nonce-${++nonceSeq}`;
  const signature = signHubRequest({
    token: input.token,
    method,
    path: input.path,
    timestamp,
    nonce,
    body
  });
  return {
    method,
    path: input.path,
    headers: {
      [HUB_AUTH_HEADERS.device]: deviceId,
      [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
      [HUB_AUTH_HEADERS.nonce]: nonce,
      [HUB_AUTH_HEADERS.signature]: signature
    },
    bodyText: body
  };
}

async function send(hub: HubHandler, clock: TestClock, input: SignedInput): Promise<HubResponse> {
  return hub(buildSigned(clock, input));
}

function json<T>(res: HubResponse): T {
  return JSON.parse(res.body) as T;
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

test("emparejamientos: el código válido entrega el token y el inválido se rechaza", async () => {
  const { driver, hub } = await setup();
  const token = await pairDevice(hub);

  assert.ok(token.length >= 32);
  const device = await driver.get<LocalRow>("hub_devices", "dev-1");
  assert.ok(device);
  assert.equal(device!.company_id, COMPANY);
  assert.equal(device!.version, 1);
  assert.equal(device!.device_name, "Caja 1");
  assert.equal(device!.platform, "windows");
  assert.equal(device!.revoked_at, null);
  assert.equal(device!.token_hash, hashDeviceToken(token));
  assert.notEqual(device!.token_hash, token);

  hub.createPairingSession();
  const bad = await hub({
    method: "POST",
    path: "/lan/v1/pair",
    headers: {},
    bodyText: JSON.stringify({
      pairingCode: "00000000",
      deviceId: "dev-2",
      deviceName: "Caja 2",
      platform: "android",
      companyId: COMPANY
    })
  });
  assert.equal(bad.status, 401);
  assert.equal(json<{ error: string }>(bad).error, "invalid_pairing_code");
  assert.equal(await driver.get("hub_devices", "dev-2"), null);
});

test("una firma válida aplica la venta y confirma el recibo", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);
  const baseline = await driver.latestSeq();

  const res = await send(hub, clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([
      { actionId: "a-1", table: "sales", rows: [product("sale-1", { total: 250 })] }
    ])
  });

  assert.equal(res.status, 200);
  const body = json<HubOpsResponse>(res);
  assert.deepEqual(body.results, [{ actionId: "a-1", status: "applied" }]);
  assert.equal(body.latestSeq, baseline + 2); // fila de la venta + recibo
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))?.total, 250);
  assert.equal((await driver.query({ table: "hub_receipts" })).length, 1);
});

test("reintentar el mismo actionId responde duplicate sin duplicar filas", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);
  const body = opsBody([{ actionId: "a-1", table: "products", rows: [product("p1")] }]);

  const first = await send(hub, clock, { token, path: "/lan/v1/ops", body });
  assert.equal(json<HubOpsResponse>(first).results[0].status, "applied");
  const seqAfterFirst = await driver.latestSeq();

  const second = await send(hub, clock, { token, path: "/lan/v1/ops", body });
  assert.equal(second.status, 200);
  assert.deepEqual(json<HubOpsResponse>(second).results, [
    { actionId: "a-1", status: "duplicate" }
  ]);
  assert.equal(await driver.latestSeq(), seqAfterFirst);
  assert.equal((await driver.query({ table: "products" })).length, 1);
  assert.equal((await driver.query({ table: "hub_receipts" })).length, 1);
});

test("una firma corrupta se rechaza con 401 y no escribe nada", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);
  const baseline = await driver.latestSeq();

  const req = buildSigned(clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([{ actionId: "a-1", table: "products", rows: [product("p1")] }])
  });
  req.headers[HUB_AUTH_HEADERS.signature] = "f".repeat(64);

  const res = await hub(req);
  assert.equal(res.status, 401);
  assert.equal(json<{ error: string }>(res).error, "invalid_signature");
  assert.equal(await driver.get("products", "p1"), null);
  assert.equal(await driver.latestSeq(), baseline);
});

test("un timestamp fuera de la tolerancia de reloj se rechaza con 401", async () => {
  const { hub, clock, driver } = await setup();
  const token = await pairDevice(hub);

  const res = await send(hub, clock, {
    token,
    path: "/lan/v1/ops",
    timestamp: clock.now() - HUB_CLOCK_SKEW_MS - 1000,
    body: opsBody([{ actionId: "a-1", table: "products", rows: [product("p1")] }])
  });
  assert.equal(res.status, 401);
  assert.equal(json<{ error: string }>(res).error, "clock_skew");
  assert.equal(await driver.get("products", "p1"), null);
});

test("reutilizar un nonce en otra petición se rechaza con 401", async () => {
  const { hub, clock, driver } = await setup();
  const token = await pairDevice(hub);
  const nonce = "nonce-repetido-0001";

  const first = await send(hub, clock, {
    token,
    nonce,
    path: "/lan/v1/ops",
    body: opsBody([{ actionId: "a-1", table: "products", rows: [product("p1")] }])
  });
  assert.equal(json<HubOpsResponse>(first).results[0].status, "applied");

  const second = await send(hub, clock, {
    token,
    nonce,
    path: "/lan/v1/ops",
    body: opsBody([{ actionId: "a-2", table: "products", rows: [product("p2")] }])
  });
  assert.equal(second.status, 401);
  assert.equal(json<{ error: string }>(second).error, "replayed_nonce");
  assert.equal(await driver.get("products", "p2"), null);
});

test("una operación inválida se rechaza sin tumbar las válidas", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);
  const baseline = await driver.latestSeq();

  const brokenRow = { id: "p-bad", company_id: COMPANY, updated_at: FIXED_ISO };
  const res = await send(hub, clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([
      { actionId: "ok-1", table: "products", rows: [product("p-good")] },
      { actionId: "bad-row", table: "products", rows: [brokenRow] },
      { actionId: "bad-table", table: "no_existe", rows: [product("p-x")] },
      { actionId: "bad-internal", table: "hub_devices", rows: [product("p-y")] },
      { actionId: "bad-company", table: "products", rows: [product("p-z", { company_id: "co-2" })] }
    ])
  });

  assert.equal(res.status, 200);
  const results = json<HubOpsResponse>(res).results;
  assert.deepEqual(
    results.map((item) => [item.actionId, item.status, item.error ?? null]),
    [
      ["ok-1", "applied", null],
      ["bad-row", "rejected", "invalid_row"],
      ["bad-table", "rejected", "unknown_table"],
      ["bad-internal", "rejected", "forbidden_table"],
      ["bad-company", "rejected", "company_mismatch"]
    ]
  );
  assert.ok(await driver.get("products", "p-good"));
  assert.equal(await driver.get("products", "p-bad"), null);
  assert.equal(await driver.get("products", "p-z"), null);
  assert.equal(await driver.latestSeq(), baseline + 2); // fila buena + recibo
});

test("los deletes del cliente eliminan filas del hub", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);

  await send(hub, clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([
      { actionId: "put-1", table: "products", rows: [product("p1"), product("p2")] }
    ])
  });
  const res = await send(hub, clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([{ actionId: "del-1", table: "products", rows: [], deletes: ["p1"] }])
  });

  const outcome = json<HubOpsResponse>(res).results[0];
  assert.equal(outcome.status, "applied");
  assert.equal(await driver.get("products", "p1"), null);
  assert.ok(await driver.get("products", "p2"));
  const journal = await driver.changes();
  assert.ok(journal.some((change) => change.op === "delete" && change.row_id === "p1"));
});

test("changes entrega un cursor creciente y marca hasMore", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);
  const baseline = await driver.latestSeq();

  await send(hub, clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([{ actionId: "a-1", table: "products", rows: [product("p1")] }])
  });
  await send(hub, clock, {
    token,
    path: "/lan/v1/ops",
    body: opsBody([{ actionId: "a-2", table: "products", rows: [product("p2")] }])
  });

  const first = await send(hub, clock, {
    token,
    method: "GET",
    path: `/lan/v1/changes?since=${baseline}&limit=2`
  });
  assert.equal(first.status, 200);
  const firstPage = json<{ changes: { seq: number }[]; latestSeq: number; hasMore: boolean }>(first);
  assert.deepEqual(firstPage.changes.map((change) => change.seq), [baseline + 1, baseline + 2]);
  assert.equal(firstPage.latestSeq, baseline + 4);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.latestSeq, await driver.latestSeq());

  const cursor = firstPage.changes[firstPage.changes.length - 1].seq;
  const second = await send(hub, clock, {
    token,
    method: "GET",
    path: `/lan/v1/changes?since=${cursor}&limit=10`
  });
  const secondPage = json<{ changes: { seq: number }[]; latestSeq: number; hasMore: boolean }>(second);
  assert.deepEqual(secondPage.changes.map((change) => change.seq), [baseline + 3, baseline + 4]);
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(
    [...firstPage.changes, ...secondPage.changes].map((change) => change.seq),
    [baseline + 1, baseline + 2, baseline + 3, baseline + 4]
  );
});

test("snapshot respeta el límite, filtra la empresa y oculta tablas internas", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);
  const baseline = await driver.latestSeq();
  await driver.put("products", [product("p1"), product("p2"), product("p3")]);

  const res = await send(hub, clock, {
    token,
    method: "GET",
    path: "/lan/v1/snapshot?table=products&companyId=co-1&limit=2"
  });
  assert.equal(res.status, 200);
  const snapshot = json<{ rows: LocalRow[]; latestSeq: number }>(res);
  assert.deepEqual(snapshot.rows.map((row) => row.id), ["p1", "p2"]);
  assert.equal(snapshot.latestSeq, baseline + 3);

  const unknown = await send(hub, clock, {
    token,
    method: "GET",
    path: "/lan/v1/snapshot?table=desconocida&limit=2"
  });
  assert.equal(unknown.status, 404);
  assert.equal(json<{ error: string }>(unknown).error, "unknown_table");

  const internal = await send(hub, clock, {
    token,
    method: "GET",
    path: "/lan/v1/snapshot?table=hub_devices"
  });
  assert.equal(internal.status, 403);
  assert.equal(internal.body.includes("token_hash"), false);
});

test("un dispositivo revocado recibe 403", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub, "dev-r");
  const device = await driver.get<LocalRow>("hub_devices", "dev-r");
  assert.ok(device);
  await driver.put("hub_devices", [
    { ...device!, version: Number(device!.version) + 1, revoked_at: FIXED_ISO }
  ]);

  const res = await send(hub, clock, {
    token,
    deviceId: "dev-r",
    path: "/lan/v1/ops",
    body: opsBody(
      [{ actionId: "a-1", table: "products", rows: [product("p1")] }],
      "dev-r"
    )
  });
  assert.equal(res.status, 403);
  assert.equal(json<{ error: string }>(res).error, "device_revoked");
});

test("health responde sin firma y cuenta los equipos activos", async () => {
  const { driver, hub } = await setup();

  const before = await hub({ method: "GET", path: "/lan/v1/health", headers: {}, bodyText: "" });
  assert.equal(before.status, 200);
  const initial = json<{ ok: boolean; protocol: number; hubId: string; devices: number }>(before);
  assert.equal(initial.ok, true);
  assert.equal(initial.protocol, HUB_PROTOCOL_VERSION);
  assert.equal(initial.hubId, HUB_ID);
  assert.equal(initial.devices, 0);

  await pairDevice(hub);
  const after = await hub({ method: "GET", path: "/lan/v1/health", headers: {}, bodyText: "" });
  assert.equal(json<{ devices: number }>(after).devices, 1);
  assert.equal((await driver.query({ table: "hub_devices" })).length, 1);
});
