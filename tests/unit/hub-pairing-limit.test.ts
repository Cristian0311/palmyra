/**
 * Límites del emparejamiento del hub LAN.
 *
 * El código tiene 8 dígitos y caduca a los 10 minutos; sin tope de intentos un
 * equipo de la LAN podría probarlos todos. Aquí se cubren los dos frenos:
 * 10 fallos queman el código vigente y 5 fallos bloquean al equipo, con 429
 * `too_many_attempts` en ambos casos y sin revelar si el código existía.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDbDriver } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  HUB_AUTH_HEADERS,
  HUB_PAIR_DEVICE_MAX_FAILURES,
  HUB_PAIR_DEVICE_WINDOW_MS,
  HUB_PAIR_ERRORS,
  HUB_PAIR_MAX_FAILURES,
  HUB_PAIRING_TTL_MS,
  createHubHandler,
  type HubHandler,
  type HubPairResponse,
  type HubRequest,
  type HubResponse
} from "../../src/services/lanHub";

const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const COMPANY = "co-1";
const HUB_ID = "hub-1";
/** Ningún código generado por la fábrica de prueba coincide con este valor. */
const WRONG_CODE = "00000000";

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
  let seq = 0;
  const hub = createHubHandler({
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => clock.now(),
    // Códigos deterministas y distintos en cada llamada: así la rotación se ve.
    pairingCode: () => String(10_000_000 + ++seq)
  });
  return { clock, driver, hub };
}

/** Petición de emparejamiento; `header` es el `x-palmyra-device` opcional. */
function pairAttempt(code: string, deviceId: string, header?: string): HubRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== undefined) headers[HUB_AUTH_HEADERS.device] = header;
  return {
    method: "POST",
    path: "/lan/v1/pair",
    headers,
    bodyText: JSON.stringify({
      pairingCode: code,
      deviceId,
      deviceName: `Caja ${deviceId}`,
      platform: "windows",
      companyId: COMPANY
    })
  };
}

function json<T>(res: HubResponse): T {
  return JSON.parse(res.body) as T;
}

/** Fallo normal de código: 401 sin pistas. Devuelve la respuesta para comparar. */
async function failAttempt(hub: HubHandler, deviceId: string): Promise<HubResponse> {
  const res = await hub(pairAttempt(WRONG_CODE, deviceId, deviceId));
  assert.equal(res.status, 401);
  assert.deepEqual(json(res), { error: HUB_PAIR_ERRORS.invalidCode });
  assert.equal(res.body.includes(WRONG_CODE), false);
  return res;
}

test("cinco fallos del mismo equipo lo bloquean con 429 y queman el código", async () => {
  const { driver, hub } = await setup();
  const session = hub.createPairingSession();

  // Los cuatro primeros fallos son intentos normales: la sesión sigue viva.
  for (let i = 1; i < HUB_PAIR_DEVICE_MAX_FAILURES; i++) {
    await failAttempt(hub, "caja-intrusa");
    assert.equal(hub.currentPairingSession()?.code, session.code);
  }

  // El quinto tope invalida la sesión y responde 429 sin decir nada del código.
  const blocked = await hub(pairAttempt(WRONG_CODE, "caja-intrusa", "caja-intrusa"));
  assert.equal(blocked.status, 429);
  assert.deepEqual(json(blocked), {
    error: HUB_PAIR_ERRORS.tooManyAttempts,
    retryAfterMs: HUB_PAIR_DEVICE_WINDOW_MS
  });
  assert.equal(blocked.body.includes(WRONG_CODE), false);
  assert.equal(hub.currentPairingSession(), null);

  // Aunque pruebe el código correcto, el equipo sigue bloqueado y no se escribe.
  const retry = await hub(pairAttempt(session.code, "caja-otra", "caja-intrusa"));
  assert.equal(retry.status, 429);
  assert.equal(json<{ error: string }>(retry).error, HUB_PAIR_ERRORS.tooManyAttempts);
  assert.equal(await driver.get("hub_devices", "caja-otra"), null);
  assert.equal(await driver.get("hub_devices", "caja-intrusa"), null);
});

test("diez fallos repartidos queman el código y el código rotado vuelve a servir", async () => {
  const { driver, hub } = await setup();
  const session = hub.createPairingSession();

  // Nueve equipos distintos: ninguno llega a su tope, pero el código acumula.
  for (let i = 1; i < HUB_PAIR_MAX_FAILURES; i++) {
    await failAttempt(hub, `intruso-${i}`);
    assert.equal(hub.currentPairingSession()?.code, session.code);
  }

  const burned = await hub(pairAttempt(WRONG_CODE, `intruso-${HUB_PAIR_MAX_FAILURES}`));
  assert.equal(burned.status, 429);
  assert.deepEqual(json(burned), {
    error: HUB_PAIR_ERRORS.tooManyAttempts,
    retryAfterMs: HUB_PAIRING_TTL_MS
  });
  assert.equal(hub.currentPairingSession(), null);

  // El código quemado ya no empareja a nadie.
  const stale = await hub(pairAttempt(session.code, "caja-1", "caja-1"));
  assert.equal(stale.status, 401);
  assert.deepEqual(json(stale), { error: HUB_PAIR_ERRORS.invalidCode });

  // Un código nuevo sí funciona y se consume al primer uso.
  const rotated = hub.createPairingSession();
  assert.notEqual(rotated.code, session.code);
  const ok = await hub(pairAttempt(rotated.code, "caja-1", "caja-1"));
  assert.equal(ok.status, 200);
  const ack = json<HubPairResponse>(ok);
  assert.equal(ack.deviceId, "caja-1");
  assert.equal(ack.companyId, COMPANY);
  assert.ok(ack.deviceToken.length >= 32);
  assert.equal(ok.body.includes("token_hash"), false);
  assert.ok(await driver.get("hub_devices", "caja-1"));
  assert.equal(hub.currentPairingSession(), null);

  const replay = await hub(pairAttempt(rotated.code, "caja-2", "caja-2"));
  assert.equal(replay.status, 401);
  assert.equal(await driver.get("hub_devices", "caja-2"), null);
});

test("un acierto perdona los fallos previos del equipo", async () => {
  const { hub } = await setup();
  const first = hub.createPairingSession();

  for (let i = 1; i < HUB_PAIR_DEVICE_MAX_FAILURES; i++) {
    await failAttempt(hub, "caja-3");
  }
  const ok = await hub(pairAttempt(first.code, "caja-3", "caja-3"));
  assert.equal(ok.status, 200);

  // Con el contador a cero, cuatro fallos nuevos no bloquean; el quinto sí.
  hub.createPairingSession();
  for (let i = 1; i < HUB_PAIR_DEVICE_MAX_FAILURES; i++) {
    await failAttempt(hub, "caja-3");
  }
  const blocked = await hub(pairAttempt(WRONG_CODE, "caja-3", "caja-3"));
  assert.equal(blocked.status, 429);
  assert.equal(json<{ error: string }>(blocked).error, HUB_PAIR_ERRORS.tooManyAttempts);
});

test("el bloqueo del equipo sobrevive a la rotación hasta que vence su ventana", async () => {
  const { clock, driver, hub } = await setup();
  hub.createPairingSession();

  for (let i = 1; i < HUB_PAIR_DEVICE_MAX_FAILURES; i++) {
    await failAttempt(hub, "caja-4");
  }
  const burned = await hub(pairAttempt(WRONG_CODE, "caja-4", "caja-4"));
  assert.equal(burned.status, 429);
  assert.equal(hub.currentPairingSession(), null);

  // El código nuevo no reabre el contador del equipo bloqueado, pero sí sirve
  // a los demás: el bloqueo es del equipo, no del hub.
  const rotated = hub.createPairingSession();
  const stillBlocked = await hub(pairAttempt(rotated.code, "caja-4", "caja-4"));
  assert.equal(stillBlocked.status, 429);
  const clean = await hub(pairAttempt(rotated.code, "caja-5", "caja-5"));
  assert.equal(clean.status, 200);
  assert.equal(await driver.get("hub_devices", "caja-4"), null);

  // Vencida la ventana, el mismo equipo vuelve a emparejar con un código nuevo.
  clock.advance(HUB_PAIR_DEVICE_WINDOW_MS + 1);
  const refreshed = hub.createPairingSession();
  const unlocked = await hub(pairAttempt(refreshed.code, "caja-4", "caja-4"));
  assert.equal(unlocked.status, 200);
  assert.ok(await driver.get("hub_devices", "caja-4"));
});

test("vencido, erróneo y sin código vigente responden igual y sin eco", async () => {
  const { clock, hub } = await setup();

  // Sin sesión: no hay código con el que comparar.
  const none = await failAttempt(hub, "caja-a");

  const session = hub.createPairingSession();
  const wrong = await failAttempt(hub, "caja-b");
  // Mismo estado y mismo cuerpo: no se distingue "no hay código" de "no es ese".
  assert.equal(wrong.status, none.status);
  assert.equal(wrong.body, none.body);

  clock.advance(HUB_PAIRING_TTL_MS + 1);
  const expired = await hub(pairAttempt(session.code, "caja-c", "caja-c"));
  assert.equal(expired.status, 401);
  assert.equal(expired.body, wrong.body);
  assert.equal(expired.body.includes(session.code), false);
  assert.equal(hub.currentPairingSession(), null);
});
