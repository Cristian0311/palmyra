import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_TAMPER_REPORTS_TABLE,
  CLOCK_TELEMETRY_FLUSH_INTERVAL_MS,
  CLOCK_TELEMETRY_MAX_ATTEMPTS,
  CLOCK_TELEMETRY_MAX_REPORTS_PER_FLUSH,
  CLOCK_TELEMETRY_QUEUE_MAX,
  drainClockTelemetry,
  flushClockTamperReports,
  loadQueuedClockTamperReports,
  queueClockTamperEvent,
  queueClockTamperReport,
  type ClockTamperQueuedReport,
  type ClockTamperReportRow,
  type ClockTamperTelemetryClient
} from "../../src/services/license/telemetry";
import {
  createMemoryLicenseStore,
  loadClockTamperEvents,
  type LicenseKeyValueStore
} from "../../src/services/license/storage";
import { createLicenseRuntime, type LicenseRuntimeClient } from "../../src/services/license/runtime";

/**
 * Telemetría de reloj hacia la Edge Function: buzón durable acotado y
 * deduplicado, envío con Bearer, descarte solo con 2xx/409 y reintento con tope.
 */

const NOW = Date.parse("2026-11-23T15:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANY_ID = "44444444-4444-4444-8444-444444444444";
const DEVICE_ID = "dev-prueba-telemetria";
const LEASE_ID = "lease-telemetria-1";
const TOKEN = "token-de-prueba-no-real";

interface FetchCall {
  url: string;
  init?: RequestInit;
  body: { reports?: ClockTamperReportRow[] } & Record<string, unknown>;
}

function makeFetch(responses: Array<number | "network"> = [202]) {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, init, body });
    const status = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (status === "network") throw new Error("sin red");
    return new Response(null, { status: status as number });
  };
  return { fetchImpl, calls };
}

function makeClient(overrides: Partial<ClockTamperTelemetryClient> = {}): ClockTamperTelemetryClient {
  return {
    from(table: string) {
      assert.equal(table, CLOCK_TAMPER_REPORTS_TABLE);
      return {
        insert() {
          throw new Error("no debería usarse la tabla cuando hay token");
        }
      };
    },
    auth: {
      async getSession() {
        return { data: { session: { access_token: TOKEN } } };
      }
    },
    supabaseUrl: "https://proyecto.supabase.co",
    ...overrides
  };
}

async function queueDraft(
  store: LicenseKeyValueStore,
  overrides: { kind?: "wall-rollback" | "monotonic-regression"; detectedAtMs?: number } = {},
  context: { companyId?: string; deviceId?: string | null } = {}
): Promise<void> {
  await queueClockTamperReport(
    store,
    {
      kind: overrides.kind ?? "wall-rollback",
      source: overrides.kind === "monotonic-regression" ? "monotonic" : "watermark",
      skewMs: 30 * 60 * 1000,
      detectedAtMs: overrides.detectedAtMs ?? NOW
    },
    {
      companyId: context.companyId ?? COMPANY_ID,
      deviceId: context.deviceId === undefined ? DEVICE_ID : context.deviceId,
      leaseId: LEASE_ID
    }
  );
}

test("el buzón deduplica por empresa, dispositivo, día y motivo", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  await queueDraft(store); // mismo día y motivo: se agrupa
  await queueDraft(store, {}, { deviceId: "otro-dispositivo" }); // otro equipo
  await queueDraft(store, { kind: "monotonic-regression" }); // otro motivo
  await queueDraft(store, { detectedAtMs: NOW + DAY_MS }); // otro día
  await queueDraft(store, {}, { companyId: OTHER_COMPANY_ID }); // otra empresa

  const queue = await loadQueuedClockTamperReports(store);
  assert.equal(queue.length, 5);
  const grouped = queue.find(
    (entry) => entry.company_id === COMPANY_ID && entry.kind === "wall-rollback" && entry.device_id === DEVICE_ID
  ) as ClockTamperQueuedReport;
  assert.ok(grouped);
  assert.equal(grouped.count, 2);
});

test("el buzón respeta el tope de 50 y descarta los más antiguos", async () => {
  const store = createMemoryLicenseStore();
  for (let day = 0; day < 60; day += 1) {
    await queueDraft(store, { detectedAtMs: NOW + day * DAY_MS });
  }
  const queue = await loadQueuedClockTamperReports(store);
  assert.equal(queue.length, CLOCK_TELEMETRY_QUEUE_MAX);
  assert.equal(queue[0].detected_at, new Date(NOW + 10 * DAY_MS).toISOString());
  assert.equal(queue[queue.length - 1].detected_at, new Date(NOW + 59 * DAY_MS).toISOString());
});

test("flush envía el token en Bearer y limpia solo con 2xx", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  await queueDraft(store, { kind: "monotonic-regression" });
  const { fetchImpl, calls } = makeFetch([202]);

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl
  });

  assert.deepEqual(result, { sent: 2, pending: 0, status: 202 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proyecto.supabase.co/functions/v1/license-telemetry");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].body.reports as ClockTamperReportRow[]).length, 2);
  assert.deepEqual(await loadQueuedClockTamperReports(store), []);
});

test("un 409 (ya reportado) también descarta el reporte", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  const { fetchImpl } = makeFetch([409]);

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl
  });

  assert.equal(result.sent, 1);
  assert.equal(result.status, 409);
  assert.deepEqual(await loadQueuedClockTamperReports(store), []);
});

test("un fallo de red conserva la cola y respeta el tope de intentos", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  const failing = makeFetch(["network"]);

  const failed = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl: failing.fetchImpl,
    maxAttempts: 2
  });

  assert.deepEqual(failed, { sent: 0, pending: 1, status: null });
  assert.equal(failing.calls.length, 2);
  assert.equal((await loadQueuedClockTamperReports(store)).length, 1);

  // El siguiente vaciado con red vuelve a enviarlo y recién ahí lo descarta.
  const healthy = makeFetch([200]);
  const retry = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl: healthy.fetchImpl
  });
  assert.equal(retry.sent, 1);
  assert.equal((await loadQueuedClockTamperReports(store)).length, 0);
});

test("un 500 no descarta la cola y no reintenta sin control", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  const failing = makeFetch([500]);

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl: failing.fetchImpl
  });

  assert.equal(result.sent, 0);
  assert.equal(result.status, 500);
  assert.equal(failing.calls.length, CLOCK_TELEMETRY_MAX_ATTEMPTS);
  assert.equal((await loadQueuedClockTamperReports(store)).length, 1);
});

test("sin token no hay inserción directa: la tabla está cerrada y el reporte queda pendiente", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  let tableWrites = 0;
  const client: ClockTamperTelemetryClient = {
    from() {
      tableWrites += 1;
      throw new Error("la telemetría no debe escribir en tablas");
    }
  };

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client,
    baseUrl: null,
    endpoint: null
  });

  // Sin Edge Function no hay envío ni respaldo: el reporte espera, no falla.
  assert.deepEqual(result, { sent: 0, pending: 1, status: null });
  assert.equal(tableWrites, 0);
  assert.equal((await loadQueuedClockTamperReports(store)).length, 1);
});

test("un 401/403 descarta el lote de forma definitiva en lugar de reintentar eterno", async () => {
  for (const status of [401, 403]) {
    const store = createMemoryLicenseStore();
    await queueDraft(store);
    await queueDraft(store, { kind: "monotonic-regression" });
    const forbidden = makeFetch([status]);

    const result = await flushClockTamperReports({
      store,
      companyId: COMPANY_ID,
      client: makeClient(),
      fetchImpl: forbidden.fetchImpl
    });

    assert.equal(result.sent, 0);
    assert.equal(result.status, status);
    assert.equal(result.pending, 0);
    // No se aisla fila a fila: el permiso denegado aplica al lote completo.
    assert.equal(forbidden.calls.length, 1);
    assert.deepEqual(await loadQueuedClockTamperReports(store), []);
  }
});

test("el SQLSTATE 42501 reenviado por la función también se descarta", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  let calls = 0;
  // `Response` no admite el estado 42501: se simula la respuesta reenviada.
  const denied = async (): Promise<Response> => {
    calls += 1;
    return { status: 42501 } as Response;
  };

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl: denied
  });

  assert.equal(result.sent, 0);
  assert.equal(result.status, 42501);
  assert.equal(calls, 1);
  assert.deepEqual(await loadQueuedClockTamperReports(store), []);
});

test("el payload no lleva token ni campos ajenos al contrato", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  const { fetchImpl, calls } = makeFetch([202]);

  await flushClockTamperReports({ store, companyId: COMPANY_ID, client: makeClient(), fetchImpl });

  const reports = calls[0].body.reports as ClockTamperReportRow[];
  assert.equal(reports.length, 1);
  assert.deepEqual(Object.keys(reports[0]).sort(), [
    "company_id",
    "detected_at",
    "device_id",
    "kind",
    "lease_id",
    "skew_ms",
    "source"
  ]);
  assert.deepEqual(Object.keys(calls[0].body), ["reports"]);
  const serialized = JSON.stringify(calls[0].body);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes("access_token"), false);
  assert.equal(serialized.includes("Authorization"), false);
  assert.equal("count" in reports[0], false);
  assert.equal("key" in reports[0], false);
});

test("drainClockTelemetry traduce los eventos locales y los envía con el runtime", async () => {
  const store = createMemoryLicenseStore();
  await queueClockTamperEvent(store, {
    kind: "wall-rollback",
    source: "watermark",
    skewMs: 40 * 60 * 1000,
    detectedAtMs: NOW
  });
  assert.equal((await loadClockTamperEvents(store)).length, 1);
  const { fetchImpl, calls } = makeFetch([202]);

  const result = await drainClockTelemetry({
    store,
    client: makeClient(),
    companyId: COMPANY_ID,
    deviceId: DEVICE_ID,
    leaseId: LEASE_ID,
    fetchImpl
  });

  assert.deepEqual(result, { sent: 1, pending: 0 });
  assert.equal(calls.length, 1);
  const rows = calls[0].body.reports as ClockTamperReportRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_id, COMPANY_ID);
  assert.equal(rows[0].device_id, DEVICE_ID);
  assert.equal(rows[0].lease_id, LEASE_ID);
  assert.equal(rows[0].kind, "wall-rollback");
  assert.equal(rows[0].source, "watermark");
  assert.equal(rows[0].skew_ms, 40 * 60 * 1000);
  assert.equal(rows[0].detected_at, new Date(NOW).toISOString());
  assert.deepEqual(await loadClockTamperEvents(store), []);
  assert.deepEqual(await loadQueuedClockTamperReports(store), []);
});

test("cada vaciado envía como máximo el tope por ciclo", async () => {
  const store = createMemoryLicenseStore();
  for (let day = 0; day < CLOCK_TELEMETRY_MAX_REPORTS_PER_FLUSH + 2; day += 1) {
    await queueDraft(store, { detectedAtMs: NOW + day * DAY_MS });
  }
  const { fetchImpl, calls } = makeFetch([202]);

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal((calls[0].body.reports as ClockTamperReportRow[]).length, CLOCK_TELEMETRY_MAX_REPORTS_PER_FLUSH);
  assert.equal(result.sent, CLOCK_TELEMETRY_MAX_REPORTS_PER_FLUSH);
  assert.equal(result.pending, 2);
  assert.equal((await loadQueuedClockTamperReports(store)).length, 2);
});

test("un 429 conserva la cola y detiene el ciclo en lugar de martillar", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  await queueDraft(store, { kind: "monotonic-regression" });
  const { fetchImpl, calls } = makeFetch([429]);

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.status, 429);
  assert.equal((await loadQueuedClockTamperReports(store)).length, 2);
});

test("un 400 aísla el lote fila a fila y descarta solo la inválida", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store);
  await queueDraft(store, { kind: "monotonic-regression" });
  let request = 0;
  const fetchImpl = async (): Promise<Response> => {
    request += 1;
    // El lote completo es inválido; las filas por separado se aceptan salvo la
    // segunda, que el servidor rechaza siempre (400).
    if (request === 1) return new Response(null, { status: 400 });
    return new Response(null, { status: request === 3 ? 400 : 202 });
  };

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl
  });

  assert.equal(request, 3);
  assert.equal(result.sent, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(await loadQueuedClockTamperReports(store), []);
});

test("los reportes de otra empresa no se envían con la sesión actual", async () => {
  const store = createMemoryLicenseStore();
  await queueDraft(store, {}, { companyId: OTHER_COMPANY_ID });
  const { fetchImpl, calls } = makeFetch([202]);

  const result = await flushClockTamperReports({
    store,
    companyId: COMPANY_ID,
    client: makeClient(),
    fetchImpl
  });

  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
  assert.equal((await loadQueuedClockTamperReports(store)).length, 1);
});

test("runtime.refresh envía la telemetría por la Edge Function", async () => {
  const store = createMemoryLicenseStore();
  await queueClockTamperEvent(store, {
    kind: "monotonic-regression",
    source: "monotonic",
    skewMs: 900,
    detectedAtMs: NOW
  });

  const serverKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", serverKeys.publicKey);

  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/license-telemetry")) {
      calls.push({ url, init, body: JSON.parse(String(init?.body || "{}")) });
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify({ keyId: "test-key", jwk: publicJwk }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const client: LicenseRuntimeClient = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: TOKEN } }, error: null };
      }
    },
    functions: {
      async invoke() {
        return { data: null, error: "sin sesión" };
      }
    },
    from() {
      throw new Error("no debería usarse la tabla");
    },
    supabaseUrl: "https://proyecto.supabase.co"
  };

  const runtime = createLicenseRuntime({
    store,
    now: () => NOW,
    storageKeyPrefix: "telemetria",
    getClient: () => client,
    fetchImpl
  });

  // El runtime no reenvía su `fetchImpl` a la telemetría: en producción usa el
  // `fetch` global, así que la prueba lo sustituye y lo restaura al final.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(String(input), init)) as typeof fetch;
  let snapshot;
  try {
    snapshot = await runtime.start({ companyId: COMPANY_ID });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Sin lease la licencia no bloquea; la telemetría se envía igual.
  assert.equal(snapshot.mode, "unmanaged");
  assert.equal(snapshot.readOnly, false);
  assert.equal(calls.length, 1);
  const rows = calls[0].body.reports as ClockTamperReportRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_id, COMPANY_ID);
  assert.equal(rows[0].kind, "monotonic-regression");
  assert.equal(rows[0].source, "monotonic");
  assert.equal(rows[0].lease_id, null);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(await loadClockTamperEvents(store), []);
  assert.deepEqual(await loadQueuedClockTamperReports(store), []);
});

test("la cadencia de vaciado desde la interfaz es de 5 minutos", () => {
  assert.equal(CLOCK_TELEMETRY_FLUSH_INTERVAL_MS, 5 * 60 * 1000);
});
