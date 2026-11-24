import assert from "node:assert/strict";
import test from "node:test";
import { syncAutoRates, type AutoRateStoreView } from "../../src/services/autoExchangeRate";
import { resolveExchangeRates } from "../../src/services/exchangeRatesHub";
import { shouldRunAutoRates } from "../../src/hooks/useAutoRateSync";
import type { HubRateQuote } from "../../src/services/lanHub/protocol";
import type { HubSession } from "../../src/services/lanHub/session";

const NOW_ISO = new Date().toISOString();

const quote = (code: string, rate: number, stale = false): HubRateQuote => ({
  code,
  rate,
  capturedAt: NOW_ISO,
  source: "elTOQUE API",
  stale
});

function makeStore(): { store: AutoRateStoreView; updates: Array<{ code: string; rate: number }> } {
  const updates: Array<{ code: string; rate: number }> = [];
  const store: AutoRateStoreView = {
    storeConfig: { autoRateSync: true },
    currencies: [
      { code: "USD", rateToBase: 400 },
      { code: "EUR", rateToBase: 450 },
      { code: "MLC", rateToBase: 220 }
    ],
    getBaseCurrency: () => ({ code: "CUP" }),
    updateCurrencyRate: async (code: string, rate: number) => {
      updates.push({ code, rate });
      return true;
    }
  };
  return { store, updates };
}

function localPayload(rates: Record<string, number>) {
  return {
    provider: "eltoque",
    source: "elTOQUE API",
    market: "informal",
    capturedAt: NOW_ISO,
    data: { tasas: rates }
  };
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("runAutoRateSync prefiere el hub y no consulta elTOQUE por su cuenta", async () => {
  const { store, updates } = makeStore();
  let fallbackCalls = 0;
  const failingFetch = (async () => {
    fallbackCalls += 1;
    throw new Error("elTOQUE no debe consultarse cuando el hub responde");
  }) as typeof fetch;

  const run = await withFetch(failingFetch, () => syncAutoRates(store, {
    force: true,
    hubRates: async () => [quote("USD", 500)]
  }));

  assert.equal(fallbackCalls, 0);
  assert.deepEqual(run.applied, [{ code: "USD", from: 400, to: 500, confirmed: true }]);
  assert.deepEqual(updates, [{ code: "USD", rate: 500 }]);
  assert.equal(run.capturedAt, NOW_ISO);
});

test("el umbral de 5 CUP se mantiene con tasas del hub", async () => {
  const { store, updates } = makeStore();
  const run = await withFetch((async () => { throw new Error("sin red"); }) as typeof fetch, () =>
    syncAutoRates(store, { force: true, hubRates: async () => [quote("USD", 404)] })
  );

  assert.deepEqual(run.applied, []);
  assert.deepEqual(run.skipped, [{ code: "USD", from: 400, to: 404, delta: 4 }]);
  assert.deepEqual(updates, []);
});

test("si el hub falla continúa con /api/exchange-rates y aplica la tasa", async () => {
  const { store, updates } = makeStore();
  let fallbackCalls = 0;
  const localFetch = (async (input: RequestInfo | URL) => {
    fallbackCalls += 1;
    assert.equal(String(input), "/api/exchange-rates");
    return new Response(JSON.stringify(localPayload({ USD: 410, ECU: 460 })), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const run = await withFetch(localFetch, () => syncAutoRates(store, {
    force: true,
    hubRates: async () => { throw new Error("hub LAN sin respuesta"); }
  }));

  assert.equal(fallbackCalls, 1);
  assert.deepEqual(updates, [{ code: "USD", rate: 410 }, { code: "EUR", rate: 460 }]);
  assert.deepEqual(run.applied.map(item => item.code), ["USD", "EUR"]);
  assert.equal(run.error, undefined);
});

test("una tasa stale del hub no mueve precios ni dispara el respaldo", async () => {
  const { store, updates } = makeStore();
  let fallbackCalls = 0;
  const failingFetch = (async () => {
    fallbackCalls += 1;
    throw new Error("no debe consultarse elTOQUE");
  }) as typeof fetch;

  const run = await withFetch(failingFetch, () => syncAutoRates(store, {
    force: true,
    hubRates: async () => [quote("USD", 500, true)]
  }));

  assert.equal(fallbackCalls, 0);
  assert.deepEqual(run.applied, []);
  assert.deepEqual(updates, []);
  assert.match(String(run.error), /no respondió en vivo/i);
  assert.equal(run.capturedAt, NOW_ISO);
});

test("si el hub y el respaldo fallan se conserva el estado sin aplicar tasas", async () => {
  const { store, updates } = makeStore();
  const offlineFetch = (async () => { throw new TypeError("sin red"); }) as typeof fetch;

  const run = await withFetch(offlineFetch, () => syncAutoRates(store, {
    force: true,
    hubRates: async () => { throw new Error("hub caído"); }
  }));

  assert.deepEqual(run.applied, []);
  assert.deepEqual(run.skipped, []);
  assert.ok(run.error && run.error.length > 0);
  assert.doesNotMatch(String(run.error), /fetch|TypeError/i);
  assert.deepEqual(updates, []);
});

/* ------------------------------------------------------------------ */
/* Decisión pura del hook automático                                   */
/* ------------------------------------------------------------------ */

test("offline con sesión de hub: la tasa se pide igual (la LAN no usa Internet)", () => {
  assert.equal(shouldRunAutoRates({ online: false, hasHubSession: true, visibility: "visible" }), true);
});

test("offline sin sesión de hub: no se consulta nada", () => {
  assert.equal(shouldRunAutoRates({ online: false, hasHubSession: false, visibility: "visible" }), false);
});

test("pestaña oculta: no se trabaja aunque haya red y hub", () => {
  assert.equal(shouldRunAutoRates({ online: true, hasHubSession: true, visibility: "hidden" }), false);
});

test("online sin hub: sigue consultando la nube", () => {
  assert.equal(shouldRunAutoRates({ online: true, hasHubSession: false, visibility: "visible" }), true);
});

/* ------------------------------------------------------------------ */
/* Resolución hub → respaldo                                           */
/* ------------------------------------------------------------------ */

const session: HubSession = {
  hubId: "hub-prueba",
  deviceId: "equipo-prueba",
  token: "token-de-prueba",
  baseUrl: "http://192.168.1.10:48900",
  joinedAt: NOW_ISO,
  cursor: 0
};

test("resolveExchangeRates prefiere el hub y no toca el respaldo", async () => {
  let fallbackCalls = 0;
  const hubFetch = (async () => new Response(JSON.stringify({
    rates: [{ code: "USD", rate: 512, capturedAt: NOW_ISO, source: "elTOQUE API", stale: false }],
    serverTime: NOW_ISO
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  const resolved = await resolveExchangeRates({
    session,
    hubEnabled: true,
    fetchImpl: hubFetch,
    now: () => Date.parse(NOW_ISO),
    fallback: async () => { fallbackCalls += 1; return [quote("USD", 480)]; }
  });

  assert.equal(fallbackCalls, 0);
  assert.equal(resolved.source, "hub");
  assert.equal(resolved.stale, false);
  assert.deepEqual(resolved.rates.map(item => [item.code, item.rate]), [["USD", 512]]);
});

test("sin hub, el respaldo conserva la última tasa y la marca stale", async () => {
  const resolved = await resolveExchangeRates({
    session: null,
    fallback: async () => [quote("USD", 480, true)]
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.stale, true);
  assert.deepEqual(resolved.rates.map(item => [item.code, item.rate]), [["USD", 480]]);
});

test("el respaldo fresco no se marca stale", async () => {
  const resolved = await resolveExchangeRates({
    session: null,
    fallback: async () => [quote("USD", 480)]
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.stale, false);
});

test("si el hub falla se usa el respaldo aunque haya sesión", async () => {
  const failingFetch = (async () => { throw new Error("hub caído"); }) as typeof fetch;
  const resolved = await resolveExchangeRates({
    session,
    fetchImpl: failingFetch,
    fallback: async () => [quote("USD", 470, true)]
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.stale, true);
  assert.equal(resolved.rates[0].rate, 470);
});

/* ------------------------------------------------------------------ */
/* Respaldo de nube: Windows/APK sin credencial local                  */
/* ------------------------------------------------------------------ */

test("sin tasa local, la resolución cae a la nube de producción y la devuelve en vivo", async () => {
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("127.0.0.1")) {
      return new Response(JSON.stringify({ error: "Falta configurar la credencial de elTOQUE en el servidor." }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify(localPayload({ USD: 460, EUR: 505 })), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const resolved = await resolveExchangeRates({ session: null, fetchImpl: impl, now: () => Date.parse(NOW_ISO) });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.stale, false);
  assert.deepEqual(resolved.rates.map(item => [item.code, item.rate]), [["USD", 460], ["EUR", 505]]);
  assert.equal(resolved.error, undefined);
});

test("si la nube tampoco responde, el aviso trae el motivo de la nube sin tecnicismos", async () => {
  const offline = (async () => { throw new TypeError("sin red"); }) as typeof fetch;

  const resolved = await resolveExchangeRates({ session: null, fetchImpl: offline, now: () => Date.parse(NOW_ISO) });

  assert.equal(resolved.source, "fallback");
  assert.deepEqual(resolved.rates, []);
  assert.equal(resolved.stale, true);
  assert.match(String(resolved.error), /nube/i);
  assert.doesNotMatch(String(resolved.error), /TypeError|fetch|servidor local|LAN/i);
});

test("con un respaldo inyectado no se consulta la nube", async () => {
  let calls = 0;
  const exploding = (async () => { calls += 1; throw new Error("la nube no debe consultarse"); }) as typeof fetch;

  const resolved = await resolveExchangeRates({
    session: null,
    fetchImpl: exploding,
    fallback: async () => []
  });

  assert.equal(calls, 0);
  assert.deepEqual(resolved.rates, []);
  assert.equal(resolved.stale, true);
});

test("la sincronización automática aplica la tasa de la nube cuando la ruta local falla", async () => {
  const { store, updates } = makeStore();
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/") || url.includes("127.0.0.1")) {
      throw new TypeError("sin servidor local");
    }
    return new Response(JSON.stringify(localPayload({ USD: 415 })), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const run = await withFetch(impl, () => syncAutoRates(store, { force: true }));

  assert.deepEqual(run.applied.map(item => item.code), ["USD"]);
  assert.deepEqual(updates, [{ code: "USD", rate: 415 }]);
  assert.equal(run.error, undefined);
});

test("si la ruta local y la nube fallan, la sincronización conserva el error sin aplicar tasas", async () => {
  const { store, updates } = makeStore();
  const offlineFetch = (async () => { throw new TypeError("sin red"); }) as typeof fetch;

  const run = await withFetch(offlineFetch, () => syncAutoRates(store, { force: true }));

  assert.deepEqual(run.applied, []);
  assert.deepEqual(updates, []);
  assert.ok(run.error && run.error.length > 0);
  assert.doesNotMatch(String(run.error), /fetch|TypeError|nube/i);
});
