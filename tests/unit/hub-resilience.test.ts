import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { createHubOutbox } from "../../src/services/localDb/hubOutbox";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { startHubClientLoop, type HubPushResult } from "../../src/services/lanHub/clientLoop";
import {
  HUB_CONFLICT_LIMIT,
  clearResolvedHubConflicts,
  conflictSummary,
  configureHubConflictStore,
  createMemoryConflictStore,
  dismissHubConflict,
  listHubConflicts,
  recordHubConflict,
  resetHubConflictsForTests
} from "../../src/services/lanHub/conflicts";
import {
  HUB_OFFLINE_LIMIT_MS,
  HUB_READONLY_EXPORT_FORMAT,
  buildReadOnlyExport,
  canWriteToHub,
  configureHubResilienceStore,
  createMemoryResilienceStore,
  getHubResilienceState,
  markHubUnreachable,
  recordHubContact,
  resetHubResilienceForTests
} from "../../src/services/lanHub/resilience";
import {
  clearHubSession,
  configureHubSessionStorage,
  createMemoryHubSessionStore,
  loadHubOutboxCursor,
  saveHubSession
} from "../../src/services/lanHub/session";

const COMPANY = "co-1";
const HUB_ID = "hub-1";
const DEVICE = "pc-caja";
const TOKEN = "token-pruebas-resiliencia_ABC123";
const BASE_URL = "http://192.168.1.10:48900";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const HOUR_MS = 60 * 60 * 1000;

// Cada archivo de pruebas corre en su propio proceso: almacenes volátiles para
// no tocar IndexedDB ni localStorage y aislar el estado entre pruebas.
configureHubSessionStorage(createMemoryHubSessionStore());
configureHubResilienceStore(createMemoryResilienceStore());
configureHubConflictStore(createMemoryConflictStore());

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

function baseRow(id: string, extra: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: DEVICE,
    deleted_at: null,
    ...extra
  };
}

function productRow(id: string, extra: Record<string, unknown> = {}): LocalRow {
  return { ...baseRow(id, extra), name: `Producto ${id}` };
}

async function openSession(): Promise<void> {
  await clearHubSession();
  await saveHubSession({
    hubId: HUB_ID,
    deviceId: DEVICE,
    token: TOKEN,
    baseUrl: BASE_URL,
    joinedAt: FIXED_ISO,
    cursor: 0
  });
}

/** Pull mudo: SSE inexistente y páginas vacías. */
function quietChanges(): Response {
  return jsonResponse({ changes: [], latestSeq: 0, serverTime: FIXED_ISO, hasMore: false });
}

function loopOptions(driver: LocalDbDriver, fetchImpl: typeof fetch, onPush?: (result: HubPushResult) => void) {
  return {
    companyId: COMPANY,
    driver,
    fetchImpl,
    // Las filas de este arnés se sellan con DEVICE, no con el id de sesión.
    localDeviceId: DEVICE,
    // Mismo reloj fijo que el estado de resiliencia sembrado en cada prueba.
    now: () => FIXED_MS,
    pollMs: 20,
    eventsBaseDelayMs: 5,
    pushMs: 20,
    pushLimit: 50,
    pushBackoffMs: 30,
    ...(onPush ? { onPush } : {})
  };
}

/* ------------------------------------------------------------------ */
/* Plazos de 72 h                                                      */
/* ------------------------------------------------------------------ */

test("sin historial el equipo no queda en solo lectura", () => {
  resetHubResilienceForTests();
  const state = getHubResilienceState(FIXED_MS);
  assert.equal(state.mode, "offline_ok");
  assert.equal(state.lastContactAt, null);
  assert.equal(state.offlineMs, 0);
  assert.equal(state.remainingMs, HUB_OFFLINE_LIMIT_MS);
  assert.equal(state.limitMs, HUB_OFFLINE_LIMIT_MS);
  assert.deepEqual(canWriteToHub(FIXED_MS), { allowed: true, reason: "ok" });
});

test("0 h y 71 h sin hub siguen siendo offline_ok; a las 72 h pasa a solo lectura", () => {
  resetHubResilienceForTests();
  // Recién perdido el contacto: 10 s sin hub.
  recordHubContact(FIXED_MS - 10_000);
  markHubUnreachable(FIXED_MS);
  let state = getHubResilienceState(FIXED_MS);
  assert.equal(state.mode, "offline_ok");
  assert.equal(state.offlineMs, 10_000);
  assert.equal(state.remainingMs, HUB_OFFLINE_LIMIT_MS - 10_000);
  assert.equal(canWriteToHub(FIXED_MS).allowed, true);

  // 71 h de caída: queda una hora de margen.
  resetHubResilienceForTests();
  recordHubContact(FIXED_MS - 71 * HOUR_MS);
  markHubUnreachable(FIXED_MS);
  state = getHubResilienceState(FIXED_MS);
  assert.equal(state.mode, "offline_ok");
  assert.equal(state.offlineMs, 71 * HOUR_MS);
  assert.equal(state.remainingMs, HOUR_MS);
  assert.deepEqual(canWriteToHub(FIXED_MS), { allowed: true, reason: "ok" });

  // Exactamente 72 h: se cierra la escritura.
  resetHubResilienceForTests();
  recordHubContact(FIXED_MS - HUB_OFFLINE_LIMIT_MS);
  markHubUnreachable(FIXED_MS);
  state = getHubResilienceState(FIXED_MS);
  assert.equal(state.mode, "read_only");
  assert.equal(state.offlineMs, HUB_OFFLINE_LIMIT_MS);
  assert.equal(state.remainingMs, 0);
  assert.deepEqual(canWriteToHub(FIXED_MS), { allowed: false, reason: "offline_limit" });
});

test("un contacto correcto devuelve el estado a online", () => {
  resetHubResilienceForTests();
  recordHubContact(FIXED_MS - 80 * HOUR_MS);
  markHubUnreachable(FIXED_MS - HOUR_MS);
  assert.equal(getHubResilienceState(FIXED_MS).mode, "read_only");

  recordHubContact(FIXED_MS);
  const state = getHubResilienceState(FIXED_MS);
  assert.equal(state.mode, "online");
  assert.equal(state.offlineMs, 0);
  assert.equal(canWriteToHub(FIXED_MS).allowed, true);
});

/* ------------------------------------------------------------------ */
/* Bloqueo del push y recuperación desde el pull                       */
/* ------------------------------------------------------------------ */

test("a las 72 h sin hub el push no llama al hub y el outbox queda intacto", async () => {
  await openSession();
  resetHubResilienceForTests();
  resetHubConflictsForTests();
  recordHubContact(FIXED_MS - HUB_OFFLINE_LIMIT_MS - 1);
  markHubUnreachable(FIXED_MS);

  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  await driver.put("products", [productRow("p1")]);

  let opsCalls = 0;
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/lan/v1/events")) return jsonResponse({ error: "not_found" }, 404);
    if (url.includes("/lan/v1/ops")) {
      opsCalls += 1;
      return jsonResponse({ results: [], latestSeq: 0, serverTime: FIXED_ISO });
    }
    // Hub caído: el pull tampoco obtiene páginas, así que el estado no se
    // rejuvenece mientras dure la caída.
    return jsonResponse({ error: "unavailable" }, 503);
  }) as typeof fetch;

  const reports: HubPushResult[] = [];
  const loop = startHubClientLoop(loopOptions(driver, impl, (result) => reports.push(result)));
  try {
    await waitFor(() => reports.some((result) => result.blocked === true));
    assert.equal(opsCalls, 0, "no se propuso nada al hub");

    const blocked = reports.find((result) => result.blocked === true) as HubPushResult;
    assert.equal(blocked.mode, "read_only");
    assert.equal(blocked.pushed, 0);
    assert.equal(blocked.rejected, 0);

    await delay(80);
    assert.equal(opsCalls, 0, "seguir en solo lectura no reintenta el envío");
    assert.equal(await loadHubOutboxCursor(), 0, "el cursor de salida no se mueve");

    const outbox = createHubOutbox(driver, {
      deviceId: DEVICE,
      companyId: COMPANY,
      originDevice: DEVICE
    });
    const pending = await outbox.collect();
    assert.equal(pending.ops.length, 1, "la operación sigue esperando en el outbox");
  } finally {
    loop.stop();
    await clearHubSession();
  }
});

test("un pull acusado por el hub devuelve el estado a online y reabre el push", async () => {
  await openSession();
  resetHubResilienceForTests();
  recordHubContact(FIXED_MS - HUB_OFFLINE_LIMIT_MS - 1);
  markHubUnreachable(FIXED_MS);

  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  await driver.put("products", [productRow("p1")]);

  let changesCalls = 0;
  let opsCalls = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/lan/v1/events")) return jsonResponse({ error: "not_found" }, 404);
    if (url.includes("/lan/v1/ops")) {
      opsCalls += 1;
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      const ops = Array.isArray(body.ops) ? (body.ops as Array<{ actionId: string }>) : [];
      return jsonResponse({
        results: ops.map((op) => ({ actionId: op.actionId, status: "applied" })),
        latestSeq: 1,
        serverTime: FIXED_ISO
      });
    }
    changesCalls += 1;
    // Los dos primeros sondeos caen (hub recién vuelto a la red); el resto ya
    // obtiene una página vacía, que es un acuse de contacto.
    if (changesCalls <= 2) return jsonResponse({ error: "unavailable" }, 503);
    return quietChanges();
  }) as typeof fetch;

  const loop = startHubClientLoop(loopOptions(driver, impl));
  try {
    await waitFor(() => getHubResilienceState(FIXED_MS).mode === "online");
    // El hub respondió al sondeo: la escritura vuelve a estar permitida.
    await waitFor(() => opsCalls >= 1);
  } finally {
    loop.stop();
    await clearHubSession();
  }
});

/* ------------------------------------------------------------------ */
/* Conflictos visibles                                                 */
/* ------------------------------------------------------------------ */

test("un rechazo del hub deja conflicto visible y el acuse posterior lo limpia", async () => {
  await openSession();
  resetHubResilienceForTests();
  resetHubConflictsForTests();

  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  await driver.put("products", [productRow("p1")]);

  let opsCalls = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/lan/v1/events")) return jsonResponse({ error: "not_found" }, 404);
    if (url.includes("/lan/v1/changes")) return quietChanges();
    if (url.includes("/lan/v1/ops")) {
      opsCalls += 1;
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      const ops = Array.isArray(body.ops) ? (body.ops as Array<{ actionId: string }>) : [];
      // Primer intento: el hub rechaza por versión desfasada. Después aplica.
      const first = opsCalls === 1;
      return jsonResponse({
        results: ops.map((op) => ({
          actionId: op.actionId,
          status: first ? "rejected" : "applied",
          ...(first ? { error: "version_conflict" } : {})
        })),
        latestSeq: 1,
        serverTime: FIXED_ISO
      });
    }
    return jsonResponse({ error: "not_found" }, 404);
  }) as typeof fetch;

  const reports: HubPushResult[] = [];
  const loop = startHubClientLoop(loopOptions(driver, impl, (result) => reports.push(result)));
  try {
    await waitFor(() => reports.some((result) => result.rejected > 0));

    const rejectedReport = reports.find((result) => result.rejected > 0) as HubPushResult;
    assert.equal(rejectedReport.rejectedActionIds.length, 1);
    const actionId = rejectedReport.rejectedActionIds[0];
    assert.match(actionId, /:products:p1:/);
    assert.equal(rejectedReport.rejectedCodes?.[actionId], "version_conflict");
    assert.equal(rejectedReport.mode, "online");
    // Un rechazo congela el cursor: la operación no se da por enviada.
    assert.equal(await loadHubOutboxCursor(), 0);

    const conflicts = listHubConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].actionId, actionId);
    assert.equal(conflicts[0].table, "products");
    assert.deepEqual(conflicts[0].rowIds, ["p1"]);
    assert.equal(conflicts[0].code, "version_conflict");
    assert.equal(conflicts[0].attempts, 1);
    assert.deepEqual(conflictSummary(), { total: 1, byCode: { version_conflict: 1 }, lastAt: conflicts[0].at });

    // El reintento se acusa como aplicado y el aviso desaparece solo.
    await waitFor(() => listHubConflicts().length === 0);
    await waitFor(async () => (await loadHubOutboxCursor()) >= 1);
    assert.equal(conflictSummary().total, 0);
  } finally {
    loop.stop();
    await clearHubSession();
  }
});

test("el registro de conflictos tope 200, acumula intentos y permite descartar", () => {
  resetHubConflictsForTests();
  const total = HUB_CONFLICT_LIMIT + 5;
  for (let index = 0; index < total; index += 1) {
    recordHubConflict({
      actionId: `op-${index}`,
      table: "products",
      rowIds: [`r-${index}`],
      code: index % 2 === 0 ? "invalid_change" : "append_only",
      at: FIXED_MS + index
    });
  }
  const kept = listHubConflicts();
  assert.equal(kept.length, HUB_CONFLICT_LIMIT);
  assert.equal(kept.some((item) => item.actionId === "op-0"), false, "los más antiguos se descartan");
  assert.equal(kept.some((item) => item.actionId === `op-${total - 1}`), true);
  // Los más recientes primero, para la UI.
  assert.equal(kept[0].actionId, `op-${total - 1}`);

  const lastActionId = `op-${total - 1}`;
  recordHubConflict({
    actionId: lastActionId,
    table: "products",
    rowIds: ["r-nueva", "r-nueva"],
    code: "version_conflict",
    at: FIXED_MS + 10_000
  });
  const refreshed = listHubConflicts().find((item) => item.actionId === lastActionId);
  assert.equal(refreshed?.attempts, 2);
  assert.equal(refreshed?.code, "version_conflict");
  assert.deepEqual(refreshed?.rowIds, [`r-${total - 1}`, "r-nueva"]);

  const summary = conflictSummary();
  assert.equal(summary.total, HUB_CONFLICT_LIMIT);
  assert.equal(summary.lastAt, FIXED_MS + 10_000);

  assert.equal(dismissHubConflict(lastActionId), true);
  assert.equal(dismissHubConflict(lastActionId), false);
  assert.equal(listHubConflicts().some((item) => item.actionId === lastActionId), false);

  assert.equal(clearResolvedHubConflicts(["op-100", "op-101", "no-existe"]), 2);
  assert.equal(conflictSummary().total, HUB_CONFLICT_LIMIT - 3);
});

/* ------------------------------------------------------------------ */
/* Exportación de solo lectura                                         */
/* ------------------------------------------------------------------ */

test("la exportación incluye tablas de negocio y excluye las internas del hub", async () => {
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  for (let index = 0; index < 5; index += 1) {
    await driver.put("products", [productRow(`p${index}`, { price: index })]);
  }
  await driver.put("products", [productRow("p-borrado", { deleted_at: FIXED_ISO })]);
  await driver.put("sales", [baseRow("s1", { total: 100 })]);
  await driver.put("hub_devices", [baseRow("dev-1", { token_hash: "no-debe-salir" })]);
  await driver.put("hub_receipts", [baseRow("rc-1")]);
  await driver.put("outbox", [baseRow("ob-1")]);
  await driver.put("products", [{ ...productRow("p-otra"), company_id: "co-2" }]);

  const exported = await buildReadOnlyExport(driver, { companyId: COMPANY });
  assert.equal(exported.format, HUB_READONLY_EXPORT_FORMAT);
  assert.equal(exported.companyId, COMPANY);
  assert.ok(!Number.isNaN(Date.parse(exported.createdAt)), "createdAt es ISO-8601");
  assert.equal(exported.counts.products, 6, "incluye la fila borrada y excluye otra empresa");
  assert.equal(exported.counts.sales, 1);
  assert.equal(exported.rows.hub_devices, undefined);
  assert.equal(exported.rows.hub_receipts, undefined);
  assert.equal(exported.rows.outbox, undefined);
  assert.equal(exported.counts.hub_devices, undefined);
  const deleted = exported.rows.products.find((item) => item.id === "p-borrado");
  assert.equal(deleted?.deleted_at, FIXED_ISO);
  assert.equal(exported.rows.products.some((item) => item.id === "p-otra"), false);

  // Subconjunto explícito de tablas.
  const onlyProducts = await buildReadOnlyExport(driver, { companyId: COMPANY, tables: ["products"] });
  assert.deepEqual(Object.keys(onlyProducts.rows), ["products"]);
  assert.equal(onlyProducts.counts.products, 6);

  // Un driver que recorta el límite por página no debe perder filas.
  const capped: LocalDbDriver = {
    ...driver,
    query: (spec) => driver.query({ ...spec, limit: Math.min(spec.limit ?? 2, 2) })
  };
  const paged = await buildReadOnlyExport(capped, { companyId: COMPANY, tables: ["products"] });
  assert.equal(paged.counts.products, 6);
  assert.deepEqual(
    paged.rows.products.map((item) => item.id),
    exported.rows.products.map((item) => item.id),
    "la paginación conserva el orden por id"
  );
});
