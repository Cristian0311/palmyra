/**
 * F2-C: PIN offline por equipo y revocación desde el hub LAN.
 *
 * Cubre el hash PBKDF2 (WebCrypto puro), el PIN opcional del pareo, el login
 * local con freno por equipo y las rutas administrativas de solo loopback:
 * listar equipos (sin `token_hash`) y revocar (idempotente).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  HUB_AUTH_HEADERS,
  HUB_LOGIN_ERRORS,
  HUB_LOGIN_MAX_FAILURES,
  HUB_LOGIN_WINDOW_MS,
  HUB_ROUTES,
  createHubHandler,
  signHubRequest,
  type HubDeviceInfo,
  type HubDevicesResponse,
  type HubHandler,
  type HubHandlerOptions,
  type HubLoginResponse,
  type HubPairResponse,
  type HubRequest,
  type HubResponse,
  type HubRevokeResponse
} from "../../src/services/lanHub";
import {
  PIN_ITERATIONS,
  createDevicePinVerifier,
  hashPin,
  isPinHash,
  isValidPin,
  verifyPin
} from "../../src/services/lanHub/devicePin";

const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const COMPANY = "co-1";
const HUB_ID = "hub-1";
const PIN = "4821";
const WRONG_PIN = "9173";

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

async function setup(
  pinRateLimit?: { maxFailures?: number; windowMs?: number }
): Promise<TestHub> {
  const clock = makeClock();
  const driver = createMemoryDriver({ now: () => new Date(clock.now()).toISOString() });
  await driver.ready();
  let seq = 0;
  const options: HubHandlerOptions = {
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => clock.now(),
    // Códigos deterministas y distintos en cada sesión.
    pairingCode: () => String(10_000_000 + ++seq)
  };
  if (pinRateLimit) options.pinRateLimit = pinRateLimit;
  return { clock, driver, hub: createHubHandler(options) };
}

function json<T>(res: HubResponse): T {
  return JSON.parse(res.body) as T;
}

async function pair(
  hub: HubHandler,
  deviceId: string,
  pin?: string
): Promise<HubResponse> {
  const session = hub.createPairingSession();
  const body: Record<string, unknown> = {
    pairingCode: session.code,
    deviceId,
    deviceName: `Caja ${deviceId}`,
    platform: "windows",
    companyId: COMPANY
  };
  if (pin !== undefined) body.pin = pin;
  return hub({
    method: "POST",
    path: HUB_ROUTES.pair,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify(body)
  });
}

async function pairToken(hub: HubHandler, deviceId: string, pin?: string): Promise<string> {
  const res = await pair(hub, deviceId, pin);
  assert.equal(res.status, 200);
  return json<HubPairResponse>(res).deviceToken;
}

function loginRequest(deviceId: string, pin: string): HubRequest {
  return {
    method: "POST",
    path: HUB_ROUTES.login,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({ deviceId, pin })
  };
}

function adminRequest(
  method: "GET" | "POST",
  path: string,
  remoteAddr: string | undefined,
  body?: unknown
): HubRequest {
  const req: HubRequest = {
    method,
    path,
    headers: { "content-type": "application/json" },
    bodyText: body === undefined ? "" : JSON.stringify(body)
  };
  if (remoteAddr !== undefined) req.remoteAddr = remoteAddr;
  return req;
}

let nonceSeq = 0;

/** Petición firmada con HMAC, como la que manda un equipo ya emparejado. */
function signedRequest(clock: TestClock, token: string, path: string): HubRequest {
  const timestamp = clock.now();
  const nonce = `nonce-pin-${++nonceSeq}`;
  const signature = signHubRequest({
    token,
    method: "GET",
    path,
    timestamp,
    nonce,
    body: ""
  });
  return {
    method: "GET",
    path,
    headers: {
      [HUB_AUTH_HEADERS.device]: "dev-hmac",
      [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
      [HUB_AUTH_HEADERS.nonce]: nonce,
      [HUB_AUTH_HEADERS.signature]: signature
    },
    bodyText: "",
    remoteAddr: "192.168.1.30"
  };
}

test("hashPin usa PBKDF2-SHA256 de 210 000 iteraciones y verifyPin valida solo el PIN correcto", async () => {
  const stored = await hashPin(PIN);
  assert.match(stored, /^pbkdf2\$sha256\$210000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(stored.split("$")[2], String(PIN_ITERATIONS));
  assert.equal(stored.includes(PIN), false);
  assert.equal(isPinHash(stored), true);
  assert.equal(await verifyPin(PIN, stored), true);
  assert.equal(await verifyPin(WRONG_PIN, stored), false);
  // Dos derivaciones del mismo PIN no comparten salt ni hash.
  assert.notEqual(await hashPin(PIN), stored);
});

test("isValidPin acepta 4-8 dígitos ASCII y nada más", () => {
  assert.equal(isValidPin("1234"), true);
  assert.equal(isValidPin("00000000"), true);
  assert.equal(isValidPin("123"), false);
  assert.equal(isValidPin("123456789"), false);
  assert.equal(isValidPin("12a4"), false);
  assert.equal(isValidPin(" 1234"), false);
  assert.equal(isValidPin("１２３４"), false);
  assert.equal(isValidPin(1234), false);
  assert.equal(isValidPin(null), false);
  assert.equal(isValidPin(undefined), false);
});

test("verifyPin trata almacenes corruptos como PIN erróneo y nunca lanza", async () => {
  const corrupt = [
    null,
    undefined,
    "",
    "1234",
    "pbkdf2$sha256$210000$abcd$ef",
    "pbkdf2$md5$210000$00112233445566778899aabbccddeeff$000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "pbkdf2$sha256$0$00112233445566778899aabbccddeeff$000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "pbkdf2$sha256$210000$zz112233445566778899aabbccddeeff$000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  ];
  for (const stored of corrupt) {
    assert.equal(await verifyPin(PIN, stored), false);
  }

  const verifier = createDevicePinVerifier(PIN);
  const good = await hashPin(PIN);
  assert.equal(await verifier(good), true);
  assert.equal(await verifier("basura"), false);
  assert.equal(await verifier(null), false);

  // Un PIN mal formado no se puede derivar, y el mensaje no lo repite.
  await assert.rejects(() => hashPin("12ab"), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(String((error as Error).message).includes("12ab"), false);
    return true;
  });
  assert.equal(await createDevicePinVerifier("12ab")(good), false);
});

test("el pareo con PIN guarda pin_hash y sin PIN deja la columna en null", async () => {
  const { driver, hub } = await setup();

  const withPin = await pair(hub, "caja-pin", PIN);
  assert.equal(withPin.status, 200);
  assert.equal(withPin.body.includes(PIN), false);
  assert.equal(withPin.body.includes("pin_hash"), false);
  const row = await driver.get<LocalRow>("hub_devices", "caja-pin");
  assert.ok(row);
  assert.equal(typeof row.pin_hash, "string");
  assert.equal(isPinHash(row.pin_hash), true);
  assert.notEqual(row.pin_hash, PIN);

  const withoutPin = await pair(hub, "caja-sin-pin");
  assert.equal(withoutPin.status, 200);
  const plain = await driver.get<LocalRow>("hub_devices", "caja-sin-pin");
  assert.ok(plain);
  assert.equal(plain.pin_hash, null);

  // Sin PIN el login responde igual que un PIN erróneo, sin pistas.
  const res = await hub(loginRequest("caja-sin-pin", PIN));
  assert.equal(res.status, 401);
  assert.deepEqual(json(res), { error: HUB_LOGIN_ERRORS.invalidPin });
});

test("el pareo rechaza un PIN mal formado con 400 sin escribir el equipo", async () => {
  const { driver, hub } = await setup();
  const res = await pair(hub, "caja-invalida", "12ab");
  assert.equal(res.status, 400);
  assert.deepEqual(json(res), { error: HUB_LOGIN_ERRORS.invalidPin });
  assert.equal(await driver.get("hub_devices", "caja-invalida"), null);
});

test("el login correcto responde 200 con empresa y reloj del hub", async () => {
  const { hub, clock } = await setup();
  await pairToken(hub, "caja-1", PIN);

  const res = await hub(loginRequest("caja-1", PIN));
  assert.equal(res.status, 200);
  assert.deepEqual(json<HubLoginResponse>(res), {
    ok: true,
    deviceId: "caja-1",
    companyId: COMPANY,
    serverTime: new Date(clock.now()).toISOString()
  });
  assert.equal(res.body.includes(PIN), false);

  // Un equipo ajeno o inventado no existe para el login.
  const unknown = await hub(loginRequest("no-existe", PIN));
  assert.equal(unknown.status, 401);
  assert.deepEqual(json(unknown), { error: HUB_LOGIN_ERRORS.invalidPin });
});

test("tras N PIN erróneos el login responde 429 y vuelve a 200 al vencer la ventana", async () => {
  const { hub, clock } = await setup({ maxFailures: 3, windowMs: 60_000 });
  await pairToken(hub, "caja-2", PIN);

  for (let i = 1; i < 3; i += 1) {
    const res = await hub(loginRequest("caja-2", WRONG_PIN));
    assert.equal(res.status, 401);
    assert.deepEqual(json(res), { error: HUB_LOGIN_ERRORS.invalidPin });
  }

  const blocked = await hub(loginRequest("caja-2", WRONG_PIN));
  assert.equal(blocked.status, 429);
  assert.deepEqual(json(blocked), {
    error: HUB_LOGIN_ERRORS.tooManyAttempts,
    retryAfterMs: 60_000
  });
  assert.equal(blocked.body.includes(WRONG_PIN), false);

  // Bloqueado no se libra ni con el PIN correcto.
  const stillBlocked = await hub(loginRequest("caja-2", PIN));
  assert.equal(stillBlocked.status, 429);
  assert.equal(json<{ error: string }>(stillBlocked).error, HUB_LOGIN_ERRORS.tooManyAttempts);

  clock.advance(60_000);
  const recovered = await hub(loginRequest("caja-2", PIN));
  assert.equal(recovered.status, 200);
  assert.equal(json<HubLoginResponse>(recovered).ok, true);
});

test("los límites por defecto son 5 fallos por 10 minutos", async () => {
  assert.equal(HUB_LOGIN_MAX_FAILURES, 5);
  assert.equal(HUB_LOGIN_WINDOW_MS, 600_000);
  const { hub } = await setup();
  await pairToken(hub, "caja-def", PIN);

  for (let i = 1; i < HUB_LOGIN_MAX_FAILURES; i += 1) {
    assert.equal((await hub(loginRequest("caja-def", WRONG_PIN))).status, 401);
  }
  const blocked = await hub(loginRequest("caja-def", WRONG_PIN));
  assert.equal(blocked.status, 429);
  assert.deepEqual(json(blocked), {
    error: HUB_LOGIN_ERRORS.tooManyAttempts,
    retryAfterMs: HUB_LOGIN_WINDOW_MS
  });
});

test("el contador de PIN de un equipo no afecta a otro", async () => {
  const { hub } = await setup({ maxFailures: 2, windowMs: 60_000 });
  await pairToken(hub, "caja-a", PIN);
  await pairToken(hub, "caja-b", PIN);

  assert.equal((await hub(loginRequest("caja-a", WRONG_PIN))).status, 401);
  assert.equal((await hub(loginRequest("caja-a", WRONG_PIN))).status, 429);
  assert.equal((await hub(loginRequest("caja-b", PIN))).status, 200);
});

test("el login de un equipo revocado responde device_revoked y su HMAC deja de valer", async () => {
  const { hub, clock, driver } = await setup();
  const token = await pairToken(hub, "dev-hmac", PIN);

  const before = await hub(signedRequest(clock, token, `${HUB_ROUTES.changes}?since=0&limit=1`));
  assert.equal(before.status, 200);

  const revoked = await hub(
    adminRequest("POST", HUB_ROUTES.revoke, "127.0.0.1", { deviceId: "dev-hmac" })
  );
  assert.equal(revoked.status, 200);
  const ack = json<HubRevokeResponse>(revoked);
  assert.deepEqual(Object.keys(ack).sort(), ["deviceId", "ok", "revokedAt"]);
  assert.equal(ack.ok, true);
  assert.equal(ack.deviceId, "dev-hmac");
  assert.equal(ack.revokedAt, new Date(clock.now()).toISOString());
  const row = await driver.get<LocalRow>("hub_devices", "dev-hmac");
  assert.equal(row?.revoked_at, ack.revokedAt);
  assert.equal(row?.version, 2);

  const login = await hub(loginRequest("dev-hmac", PIN));
  assert.equal(login.status, 403);
  assert.deepEqual(json(login), { error: "device_revoked" });

  const denied = await hub(signedRequest(clock, token, `${HUB_ROUTES.changes}?since=0&limit=1`));
  assert.equal(denied.status, 403);
  assert.deepEqual(json(denied), { error: "device_revoked" });
});

test("revocar es idempotente y conserva la fecha original", async () => {
  const { hub, clock, driver } = await setup();
  await pairToken(hub, "caja-3", PIN);

  const first = await hub(adminRequest("POST", HUB_ROUTES.revoke, "::1", { deviceId: "caja-3" }));
  assert.equal(first.status, 200);
  const firstAt = json<HubRevokeResponse>(first).revokedAt;

  clock.advance(5_000);
  const second = await hub(adminRequest("POST", HUB_ROUTES.revoke, "::1", { deviceId: "caja-3" }));
  assert.equal(second.status, 200);
  assert.equal(json<HubRevokeResponse>(second).revokedAt, firstAt);
  // La segunda no reescribe la fila.
  const row = await driver.get<LocalRow>("hub_devices", "caja-3");
  assert.equal(row?.version, 2);
  assert.equal(row?.revoked_at, firstAt);

  const unknown = await hub(adminRequest("POST", HUB_ROUTES.revoke, "::1", { deviceId: "no-existe" }));
  assert.equal(unknown.status, 404);
});

test("las rutas administrativas solo se atienden desde loopback", async () => {
  const { hub } = await setup();
  await pairToken(hub, "caja-4", PIN);

  for (const remoteAddr of ["192.168.1.40", "10.0.0.7", "::ffff:192.168.1.40"]) {
    const devices = await hub(adminRequest("GET", HUB_ROUTES.devices, remoteAddr));
    assert.equal(devices.status, 403);
    assert.deepEqual(json(devices), { error: "forbidden" });

    const revoke = await hub(
      adminRequest("POST", HUB_ROUTES.revoke, remoteAddr, { deviceId: "caja-4" })
    );
    assert.equal(revoke.status, 403);
    assert.deepEqual(json(revoke), { error: "forbidden" });
  }
});

test("devices lista los equipos de la empresa con hasPin y sin token_hash", async () => {
  const { hub, clock } = await setup();
  await pairToken(hub, "caja-pin", PIN);
  await pairToken(hub, "caja-libre");
  await pairToken(hub, "caja-fuera", PIN);
  clock.advance(1_000);
  await hub(adminRequest("POST", HUB_ROUTES.revoke, "::ffff:127.0.0.1", { deviceId: "caja-fuera" }));

  const res = await hub(adminRequest("GET", HUB_ROUTES.devices, "127.0.0.1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.includes("token_hash"), false);
  assert.equal(res.body.includes(PIN), false);

  const { devices } = json<HubDevicesResponse>(res);
  assert.equal(devices.length, 3);
  const byId = new Map<string, HubDeviceInfo>(devices.map((item) => [item.deviceId, item]));
  const withPin = byId.get("caja-pin");
  assert.ok(withPin);
  assert.equal(withPin.hasPin, true);
  assert.equal(withPin.deviceName, "Caja caja-pin");
  assert.equal(withPin.platform, "windows");
  assert.equal(withPin.revokedAt, null);
  assert.equal(typeof withPin.pairedAt, "string");
  assert.equal(byId.get("caja-libre")?.hasPin, false);
  const revoked = byId.get("caja-fuera");
  assert.equal(revoked?.hasPin, true);
  assert.equal(typeof revoked?.revokedAt, "string");

  // Sin remoteAddr (llamada interna o prueba) también se considera loopback.
  const internal = await hub(adminRequest("GET", HUB_ROUTES.devices, undefined));
  assert.equal(internal.status, 200);
});

test("las rutas de PIN y administración validan método y cuerpo", async () => {
  const { hub } = await setup();

  assert.equal((await hub(adminRequest("GET", HUB_ROUTES.login, "127.0.0.1"))).status, 405);
  assert.equal((await hub(adminRequest("GET", HUB_ROUTES.revoke, "127.0.0.1"))).status, 405);
  assert.equal((await hub(adminRequest("POST", HUB_ROUTES.devices, "127.0.0.1"))).status, 405);

  const garbage: HubRequest = {
    method: "POST",
    path: HUB_ROUTES.login,
    headers: { "content-type": "application/json" },
    bodyText: "{no-json"
  };
  assert.equal((await hub(garbage)).status, 400);
  assert.equal((await hub(loginRequest("", PIN))).status, 400);

  const revokeNoBody = await hub(adminRequest("POST", HUB_ROUTES.revoke, "127.0.0.1", {}));
  assert.equal(revokeNoBody.status, 400);
  assert.deepEqual(json(revokeNoBody), { error: "invalid_body" });
});
