import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createHubHandler } from "../../src/services/lanHub/handler";
import { readChangeFeed } from "../../src/services/lanHub/changesFeed";
import { createHubNodeServer, type HubNodeServer } from "../../src/services/lanHub/nodeServer";
import { joinHub } from "../../src/services/lanHub/pairing";
import { startHubClientLoop, type HubPushResult } from "../../src/services/lanHub/clientLoop";
import {
  clearHubSession,
  configureHubSessionStorage,
  createMemoryHubSessionStore,
  getHubSession,
  loadHubOutboxCursor
} from "../../src/services/lanHub/session";

const COMPANY = "co-1";
const HUB_ID = "hub-1";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const CODE = "48219307";

// Cada archivo de pruebas corre en su propio proceso: este almacén volátil
// evita tocar IndexedDB y aísla la sesión y el cursor de salida entre pruebas.
configureHubSessionStorage(createMemoryHubSessionStore());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error("Tiempo de espera agotado");
    await delay(10);
  }
}

// El equipo escribe el journal local con su identidad de dispositivo (la misma
// que usa la presencia LAN). El id de sesión del hub es distinto: sirve para
// firmar con el token, no para decidir qué filas son propias.
const LOCAL_DEVICE = "pc-caja";
let originDevice = LOCAL_DEVICE;

function productRow(id: string, version = 1): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version,
    updated_at: FIXED_ISO,
    origin_device: originDevice,
    deleted_at: null,
    name: `Producto ${id}`
  };
}

function internalRow(id: string): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: originDevice,
    deleted_at: null
  };
}

interface Harness {
  hubDriver: LocalDbDriver;
  server: HubNodeServer;
}

/** Hub real en loopback con un equipo ya emparejado y su sesión guardada. */
async function startHarness(): Promise<Harness> {
  const hubDriver = createMemoryDriver({ now: () => FIXED_ISO });
  await hubDriver.ready();
  const handler = createHubHandler({
    driver: hubDriver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => FIXED_MS,
    pairingCode: () => CODE
  });
  const server = await createHubNodeServer({
    handler,
    changes: (input) => readChangeFeed(hubDriver, { ...input, companyId: COMPANY }),
    eventsPollMs: 20,
    eventsPingMs: 5000
  });
  const pairing = handler.createPairingSession();
  await joinHub({
    baseUrl: server.url,
    code: pairing.code,
    deviceName: "Caja 2",
    companyId: COMPANY,
    fetchImpl: fetch,
    now: () => FIXED_MS
  });
  const session = await getHubSession();
  assert.ok(session?.deviceId, "el emparejamiento debe guardar la sesión");
  assert.notEqual(session.deviceId, LOCAL_DEVICE, "el id del hub no es la identidad local");
  originDevice = LOCAL_DEVICE;
  return { hubDriver, server };
}

interface FetchScript {
  impl: typeof fetch;
  opsCalls: () => number;
}

/**
 * Deja mudo el canal de entrada (SSE 404 y páginas vacías) para medir el push
 * sin el eco del pull, y reenvía `/lan/v1/ops` al hub real contando llamadas.
 */
function quietPullFetch(override?: (call: number, forward: () => Promise<Response>) => Promise<Response>): FetchScript {
  let ops = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/lan/v1/events")) return jsonResponse({ error: "not_found" }, 404);
    if (url.includes("/lan/v1/changes")) {
      return jsonResponse({ changes: [], latestSeq: 0, serverTime: FIXED_ISO, hasMore: false });
    }
    if (url.includes("/lan/v1/ops")) {
      ops += 1;
      const call = ops;
      return override ? override(call, () => fetch(input, init)) : fetch(input, init);
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { impl, opsCalls: () => ops };
}

function loopOptions(
  driver: LocalDbDriver,
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof startHubClientLoop>[0]> = {}
) {
  return {
    companyId: COMPANY,
    driver,
    fetchImpl,
    // Identidad con la que el equipo escribe su propio journal local.
    localDeviceId: LOCAL_DEVICE,
    // El hub del arnés firma con reloj fijo: el cliente debe usar el mismo.
    now: () => FIXED_MS,
    // Sondeo de entrada lento: el push se prueba aislado.
    pollMs: 30_000,
    pushMs: 20,
    pushLimit: 50,
    pushBackoffMs: 40,
    eventsBaseDelayMs: 5,
    ...extra
  };
}

test("un producto escrito en el cliente llega al driver del hub", async () => {
  await clearHubSession();
  const { hubDriver, server } = await startHarness();
  const clientDriver = createMemoryDriver({ now: () => FIXED_ISO });
  await clientDriver.ready();
  await clientDriver.put("products", [productRow("p1")]);

  const loop = startHubClientLoop(loopOptions(clientDriver, quietPullFetch().impl));
  try {
    await waitFor(async () => (await hubDriver.get<LocalRow>("products", "p1")) !== null);
    const row = await hubDriver.get<LocalRow>("products", "p1");
    assert.equal(row?.name, "Producto p1");
    // El acuse del hub deja avanzado el cursor de salida.
    await waitFor(async () => (await loadHubOutboxCursor()) >= 1);
  } finally {
    loop.stop();
    await server.close();
    await clearHubSession();
  }
});

test("una fila recibida de otro equipo no se devuelve al hub", async () => {
  await clearHubSession();
  const { hubDriver, server } = await startHarness();
  const clientDriver = createMemoryDriver({ now: () => FIXED_ISO });
  await clientDriver.ready();
  // Simula una fila aplicada por el pull: el journal local la registra, pero
  // su origen es otro equipo y devolverla al hub solo generaría eco.
  await clientDriver.put("products", [{ ...productRow("p-ajena"), origin_device: "otro-pc" }]);

  const script = quietPullFetch();
  const loop = startHubClientLoop(loopOptions(clientDriver, script.impl));
  try {
    await waitFor(async () => (await loadHubOutboxCursor()) >= 1);
    assert.equal(await hubDriver.get<LocalRow>("products", "p-ajena"), null);
    assert.equal(script.opsCalls(), 0, "no se propuso ninguna operación ajena");
  } finally {
    loop.stop();
    await server.close();
    await clearHubSession();
  }
});

test("reenviar el mismo lote se acusa como duplicate y el cursor avanza", async () => {
  await clearHubSession();
  const { hubDriver, server } = await startHarness();
  const clientDriver = createMemoryDriver({ now: () => FIXED_ISO });
  await clientDriver.ready();
  await clientDriver.put("products", [productRow("p1")]);

  const script = quietPullFetch(async (call, forward) => {
    const response = await forward();
    // El primer envío sí aplicó en el hub, pero el acuse se pierde: el canal
    // responde 503 y el cliente reenvía el mismo lote con los mismos actionId.
    return call === 1 ? jsonResponse({ error: "unavailable" }, 503) : response;
  });
  const reports: HubPushResult[] = [];
  const loop = startHubClientLoop(
    loopOptions(clientDriver, script.impl, {
      onPush: (result) => reports.push(result)
    })
  );

  try {
    await waitFor(async () => (await loadHubOutboxCursor()) >= 1);
    assert.ok(script.opsCalls() >= 2, "el lote se reenvió tras el 503");
    const row = await hubDriver.get<LocalRow>("products", "p1");
    assert.equal(row?.name, "Producto p1");
    const duplicated = reports.reduce((total, report) => total + report.duplicated, 0);
    const accepted = reports.reduce((total, report) => total + report.accepted, 0);
    assert.equal(accepted, 0, "el hub ya lo tenía: no hay altas nuevas");
    assert.equal(duplicated, 1, "el reintento se acusa como duplicate");
  } finally {
    loop.stop();
    await server.close();
    await clearHubSession();
  }
});

test("un rechazo no avanza el cursor y las operaciones siguientes llegan", async () => {
  await clearHubSession();
  const { hubDriver, server } = await startHarness();
  // El hub ya tiene p1 en versión 5: la propuesta en versión 1 queda obsoleta.
  await hubDriver.put("products", [productRow("p1", 5)]);

  const clientDriver = createMemoryDriver({ now: () => FIXED_ISO });
  await clientDriver.ready();
  await clientDriver.put("products", [productRow("p1", 1)]);
  await clientDriver.put("products", [productRow("p2", 1)]);

  const reports: HubPushResult[] = [];
  const loop = startHubClientLoop(
    loopOptions(clientDriver, quietPullFetch().impl, {
      onPush: (result) => reports.push(result)
    })
  );

  try {
    await waitFor(() => reports.some((report) => report.rejected > 0));
    // La operación posterior viaja en el mismo lote y el hub la aplica.
    await waitFor(async () => (await hubDriver.get<LocalRow>("products", "p2")) !== null);
    const rejected = reports.find((report) => report.rejected > 0) as HubPushResult;
    assert.equal(rejected.rejectedActionIds.length, 1);
    assert.match(rejected.rejectedActionIds[0], /:products:p1:/);
    // Nada se da por confirmado mientras el lote tenga una rechazada.
    assert.equal(await loadHubOutboxCursor(), 0);
  } finally {
    loop.stop();
    await server.close();
    await clearHubSession();
  }
});

test("stop() detiene el push y no se envían filas nuevas", async () => {
  await clearHubSession();
  const { hubDriver, server } = await startHarness();
  const clientDriver = createMemoryDriver({ now: () => FIXED_ISO });
  await clientDriver.ready();
  await clientDriver.put("products", [productRow("p1")]);

  const loop = startHubClientLoop(loopOptions(clientDriver, quietPullFetch().impl));
  try {
    await waitFor(async () => (await hubDriver.get<LocalRow>("products", "p1")) !== null);
    await waitFor(async () => (await loadHubOutboxCursor()) >= 1);
    loop.stop();
    // Margen para que un tick en vuelo termine antes de escribir de nuevo.
    await delay(80);

    const cursorAtStop = await loadHubOutboxCursor();
    await clientDriver.put("products", [productRow("p2")]);
    await delay(200);

    assert.equal(await hubDriver.get<LocalRow>("products", "p2"), null);
    assert.equal(await loadHubOutboxCursor(), cursorAtStop);
  } finally {
    loop.stop();
    await server.close();
    await clearHubSession();
  }
});

test("las tablas internas no se envían y el cursor las salta", async () => {
  await clearHubSession();
  const { hubDriver, server } = await startHarness();
  const clientDriver = createMemoryDriver({ now: () => FIXED_ISO });
  await clientDriver.ready();
  await clientDriver.put("outbox", [internalRow("ob-1")]);
  await clientDriver.put("hub_receipts", [internalRow("rc-1")]);
  await clientDriver.put("hub_devices", [internalRow("dev-1")]);

  const script = quietPullFetch();
  const loop = startHubClientLoop(loopOptions(clientDriver, script.impl));
  try {
    // Solo había tablas filtradas: el cursor avanza sin tocar la red.
    await waitFor(async () => (await loadHubOutboxCursor()) >= 3);
    assert.equal(script.opsCalls(), 0, "no se propone nada al hub");

    await clientDriver.put("products", [productRow("p1")]);
    await waitFor(async () => (await hubDriver.get<LocalRow>("products", "p1")) !== null);
    assert.equal(script.opsCalls(), 1, "solo viaja el lote del producto");

    assert.equal(await hubDriver.get<LocalRow>("outbox", "ob-1"), null);
    assert.equal(await hubDriver.get<LocalRow>("hub_receipts", "rc-1"), null);
    assert.equal(await hubDriver.get<LocalRow>("hub_devices", "dev-1"), null);
  } finally {
    loop.stop();
    await server.close();
    await clearHubSession();
  }
});
