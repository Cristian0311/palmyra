import test from "node:test";
import assert from "node:assert/strict";
import { HubPairingError, joinHub, leaveHub } from "../../src/services/lanHub/pairing";
import {
  advanceCursor,
  clearHubSession,
  getHubSession,
  saveHubSession,
  subscribeHubSession
} from "../../src/services/lanHub/session";

const COMPANY = "co-1";
const HUB_ID = "hub-1";
const DEVICE = "pc-secundario";
const TOKEN = "token-pair-secreto_ABC123";
const BASE_URL = "http://192.168.1.10:48900";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const CODE = "48219307";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: typeof input === "string" ? input : input.toString(), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, impl };
}

function ackBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceToken: TOKEN,
    deviceId: DEVICE,
    hubId: HUB_ID,
    serverTime: FIXED_ISO,
    companyId: COMPANY,
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("joinHub canjea el código y guarda la sesión tras un acuse válido", async () => {
  await clearHubSession();
  const { calls, impl } = makeFetch(() => jsonResponse(ackBody()));

  const result = await joinHub({
    baseUrl: `${BASE_URL}/`,
    code: CODE,
    deviceName: "Caja 2",
    companyId: COMPANY,
    platform: "windows",
    fetchImpl: impl,
    now: () => FIXED_MS
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, `${BASE_URL}/lan/v1/pair`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.url.includes(TOKEN), false);
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");

  const sent = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.equal(sent.pairingCode, CODE);
  assert.equal(sent.companyId, COMPANY);
  assert.equal(sent.deviceName, "Caja 2");
  assert.equal(sent.platform, "windows");
  assert.equal(typeof sent.deviceId, "string");
  assert.ok(String(sent.deviceId).length > 0);

  const stored = await getHubSession();
  assert.ok(stored);
  assert.equal(stored?.hubId, HUB_ID);
  assert.equal(stored?.deviceId, DEVICE);
  assert.equal(stored?.token, TOKEN);
  assert.equal(stored?.baseUrl, BASE_URL);
  assert.equal(stored?.cursor, 0);
  assert.equal(stored?.joinedAt, FIXED_ISO);
  assert.equal(result.session.hubId, HUB_ID);

  await leaveHub();
  assert.equal(await getHubSession(), null);
});

test("un código rechazado no guarda sesión y responde en español", async () => {
  await clearHubSession();
  const { impl } = makeFetch(() => jsonResponse({ error: "invalid_pairing_code" }, 401));

  await assert.rejects(
    () =>
      joinHub({
        baseUrl: BASE_URL,
        code: CODE,
        deviceName: "Caja 2",
        companyId: COMPANY,
        fetchImpl: impl,
        now: () => FIXED_MS
      }),
    (error: unknown) => {
      assert.ok(error instanceof HubPairingError);
      assert.equal(error.code, "invalid_code");
      assert.match(error.message, /código inválido o vencido/);
      return true;
    }
  );
  assert.equal(await getHubSession(), null);
});

test("un hub inalcanzable informa el fallo de red sin sesión", async () => {
  await clearHubSession();
  const impl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      joinHub({
        baseUrl: BASE_URL,
        code: CODE,
        deviceName: "Caja 2",
        companyId: COMPANY,
        fetchImpl: impl,
        now: () => FIXED_MS
      }),
    (error: unknown) => {
      assert.ok(error instanceof HubPairingError);
      assert.equal(error.code, "unreachable");
      assert.match(error.message, /hub inalcanzable/);
      return true;
    }
  );
  assert.equal(await getHubSession(), null);
});

test("un acuse incompleto no vincula el equipo", async () => {
  await clearHubSession();
  const { impl } = makeFetch(() => jsonResponse({ hubId: HUB_ID, serverTime: FIXED_ISO }));

  await assert.rejects(
    () =>
      joinHub({
        baseUrl: BASE_URL,
        code: CODE,
        deviceName: "Caja 2",
        companyId: COMPANY,
        fetchImpl: impl,
        now: () => FIXED_MS
      }),
    (error: unknown) => {
      assert.ok(error instanceof HubPairingError);
      assert.equal(error.code, "invalid_response");
      return true;
    }
  );
  assert.equal(await getHubSession(), null);
});

test("el cursor persistido solo avanza y la sesión notifica a los suscriptores", async () => {
  await clearHubSession();
  const seen: Array<number | null> = [];
  const unsubscribe = subscribeHubSession((session) => {
    seen.push(session ? session.cursor : null);
  });

  await saveHubSession({
    hubId: HUB_ID,
    deviceId: DEVICE,
    token: TOKEN,
    baseUrl: BASE_URL,
    joinedAt: FIXED_ISO,
    cursor: 2
  });
  assert.equal(await advanceCursor(5), 5);
  assert.equal(await advanceCursor(3), 5);
  assert.equal(await advanceCursor(Number.NaN), 5);
  const stored = await getHubSession();
  assert.equal(stored?.cursor, 5);

  // Guardar de nuevo con un cursor menor no hace retroceder la sesión.
  await saveHubSession({ ...(stored as NonNullable<typeof stored>), cursor: 1 });
  assert.equal((await getHubSession())?.cursor, 5);

  // Avisos: guardado, avances y borrado (aquí sí se ve el null).
  await clearHubSession();
  assert.equal(seen[seen.length - 1], null);
  unsubscribe();
  assert.ok(seen.length >= 3);
});
