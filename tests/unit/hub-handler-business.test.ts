import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  HUB_AUTH_HEADERS,
  createHubHandler,
  signHubRequest,
  type HubHandler,
  type HubHandlerOptions,
  type HubOpsResponse,
  type HubPairResponse,
  type HubRateQuote,
  type HubRatesResponse,
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
}

function makeClock(): TestClock {
  return { now: () => FIXED_MS };
}

interface TestHub {
  clock: TestClock;
  driver: LocalDbDriver;
  hub: HubHandler;
}

async function setup(rates?: () => Promise<HubRateQuote[]>): Promise<TestHub> {
  const clock = makeClock();
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  const options: HubHandlerOptions = {
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => clock.now(),
    pairingCode: () => PAIRING_CODE
  };
  if (rates) options.rates = rates;
  return { clock, driver, hub: createHubHandler(options) };
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
  method?: "GET" | "POST";
  path: string;
  body?: string;
}

function buildSigned(clock: TestClock, input: SignedInput): HubRequest {
  const method = input.method ?? "POST";
  const body = input.body ?? "";
  const timestamp = clock.now();
  const nonce = `nonce-biz-${++nonceSeq}`;
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
      [HUB_AUTH_HEADERS.device]: "dev-1",
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

function row(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: "dev-1",
    deleted_at: null,
    ...fields
  };
}

function product(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return row(id, { name: `Producto ${id}`, ...fields });
}

function balance(id: string, productId: string, warehouseId: string, quantity: number): LocalRow {
  return row(id, { product_id: productId, warehouse_id: warehouseId, quantity });
}

function opsBody(ops: unknown[], deviceId = "dev-1"): string {
  return JSON.stringify({ deviceId, ops });
}

async function pushOps(hub: HubHandler, clock: TestClock, token: string, ops: unknown[]): Promise<HubOpsResponse> {
  const res = await send(hub, clock, { token, path: "/lan/v1/ops", body: opsBody(ops) });
  assert.equal(res.status, 200);
  return json<HubOpsResponse>(res);
}

test("/ops: un lote mixto aplica lo válido y devuelve el código de cada rechazo", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);

  const original = product("p-old", { version: 3, name: "Viejo", total: 10 });
  const sale = row("sale-1", { total: 250, status: "paid" });
  const stock = balance("stock:p1:w1:base", "p1", "w1", 1);
  await pushOps(hub, clock, token, [
    { actionId: "seed-old", table: "products", rows: [original] },
    { actionId: "seed-sale", table: "sales", rows: [sale] },
    { actionId: "seed-stock", table: "stock_balances", rows: [stock] }
  ]);
  const seqAfterSeed = await driver.latestSeq();
  assert.equal((await driver.query({ table: "hub_receipts" })).length, 3);

  const result = await pushOps(hub, clock, token, [
    { actionId: "ok-new", table: "products", rows: [product("p-new")] },
    { actionId: "stale", table: "products", rows: [{ ...original, version: 2, name: "Atrasado" }] },
    { actionId: "conflict", table: "products", rows: [{ ...original, name: "Distinto" }] },
    { actionId: "duplicate-row", table: "products", rows: [{ ...original }] },
    { actionId: "append-update", table: "sales", rows: [{ ...sale, version: 2, total: 999 }] },
    { actionId: "append-delete", table: "sales", rows: [], deletes: ["sale-1"] },
    { actionId: "stock-negative", table: "stock_balances", rows: [{ ...stock, version: 2, quantity: -1 }] },
    { actionId: "other-company", table: "products", rows: [product("p-ajeno", { company_id: "co-2" })] }
  ]);

  assert.deepEqual(
    result.results.map((item) => [item.actionId, item.status, item.error ?? null]),
    [
      ["ok-new", "applied", null],
      ["stale", "rejected", "stale_version"],
      ["conflict", "rejected", "version_conflict"],
      ["duplicate-row", "duplicate", null],
      ["append-update", "rejected", "append_only"],
      ["append-delete", "rejected", "append_only"],
      ["stock-negative", "rejected", "negative_stock"],
      ["other-company", "rejected", "company_mismatch"]
    ]
  );

  // Solo se aplicó la fila nueva: el resto del lote quedó intacto.
  const storedOld = await driver.get<LocalRow>("products", "p-old");
  assert.equal(storedOld!.name, "Viejo");
  assert.equal(storedOld!.version, 3);
  assert.ok(await driver.get("products", "p-new"));
  assert.equal(await driver.get("products", "p-ajeno"), null);
  assert.equal((await driver.get<LocalRow>("sales", "sale-1"))!.total, 250);
  assert.equal((await driver.get<LocalRow>("stock_balances", "stock:p1:w1:base"))!.quantity, 1);
  assert.equal((await driver.query({ table: "hub_receipts" })).length, 4);
  assert.equal(await driver.latestSeq(), seqAfterSeed + 2);
});

test("/ops: reenviar la misma fila con otro actionId responde duplicate sin escribir", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);

  const first = await pushOps(hub, clock, token, [
    { actionId: "put-1", table: "products", rows: [product("p1")] }
  ]);
  assert.equal(first.results[0].status, "applied");
  const seqAfterFirst = await driver.latestSeq();

  const second = await pushOps(hub, clock, token, [
    { actionId: "put-1-retry", table: "products", rows: [product("p1")] }
  ]);
  assert.deepEqual(second.results, [{ actionId: "put-1-retry", status: "duplicate" }]);
  assert.equal(await driver.latestSeq(), seqAfterFirst);
  assert.equal((await driver.query({ table: "products" })).length, 1);
});

test("/ops: una versión mayor sí actualiza una fila que no es append-only", async () => {
  const { driver, hub, clock } = await setup();
  const token = await pairDevice(hub);

  await pushOps(hub, clock, token, [
    { actionId: "v1", table: "products", rows: [product("p1", { name: "Nombre 1" })] }
  ]);
  const updated = await pushOps(hub, clock, token, [
    { actionId: "v2", table: "products", rows: [product("p1", { version: 2, name: "Nombre 2" })] }
  ]);
  assert.equal(updated.results[0].status, "applied");
  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored!.version, 2);
  assert.equal(stored!.name, "Nombre 2");
});

test("/rates: sin proveedor responde 503 y exige firma", async () => {
  const { hub, clock } = await setup();
  const token = await pairDevice(hub);

  const unsigned = await hub({ method: "GET", path: "/lan/v1/rates", headers: {}, bodyText: "" });
  assert.equal(unsigned.status, 401);
  assert.equal(json<{ error: string }>(unsigned).error, "unauthorized");

  const res = await send(hub, clock, { token, method: "GET", path: "/lan/v1/rates" });
  assert.equal(res.status, 503);
  assert.deepEqual(json<{ error: string }>(res), { error: "rates_unavailable" });
});

test("/rates: con proveedor responde 200 y solo expone cotizaciones", async () => {
  const quotes: HubRateQuote[] = [
    { code: "USD", rate: 320.5, capturedAt: FIXED_ISO, source: "elTOQUE", stale: false },
    { code: "EUR", rate: 1.08, capturedAt: FIXED_ISO, source: "elTOQUE", stale: true }
  ];
  const { hub, clock } = await setup(async () => quotes);
  const token = await pairDevice(hub);

  const res = await send(hub, clock, { token, method: "GET", path: "/lan/v1/rates" });
  assert.equal(res.status, 200);
  const body = json<HubRatesResponse>(res);
  assert.deepEqual(body.rates, quotes);
  assert.equal(body.serverTime, FIXED_ISO);
  assert.equal(res.body.includes(token), false);
  assert.equal(res.body.includes("Caja 1"), false);
  assert.equal(res.body.includes("x-palmyra"), false);
});

test("/rates: un proveedor que falla o publica basura responde 503 sin filtrar detalles", async () => {
  const failing = await setup(async () => {
    throw new Error("boom token=secreto");
  });
  const failingToken = await pairDevice(failing.hub);
  const failure = await send(failing.hub, failing.clock, {
    token: failingToken,
    method: "GET",
    path: "/lan/v1/rates"
  });
  assert.equal(failure.status, 503);
  assert.deepEqual(json<{ error: string }>(failure), { error: "rates_unavailable" });
  assert.equal(failure.body.includes("boom"), false);

  const garbage = await setup(async () => [
    { code: "USD", rate: -1, capturedAt: FIXED_ISO, source: "elTOQUE", stale: false }
  ]);
  const garbageToken = await pairDevice(garbage.hub);
  const invalid = await send(garbage.hub, garbage.clock, {
    token: garbageToken,
    method: "GET",
    path: "/lan/v1/rates"
  });
  assert.equal(invalid.status, 503);
  assert.deepEqual(json<{ error: string }>(invalid), { error: "rates_unavailable" });
});

test("/rates: solo admite GET autenticado", async () => {
  const quotes: HubRateQuote[] = [
    { code: "USD", rate: 320.5, capturedAt: FIXED_ISO, source: "elTOQUE", stale: false }
  ];
  const { hub, clock } = await setup(async () => quotes);
  const token = await pairDevice(hub);

  const res = await send(hub, clock, { token, method: "POST", path: "/lan/v1/rates", body: "{}" });
  assert.equal(res.status, 405);
  assert.equal(json<{ error: string }>(res).error, "method_not_allowed");
});
