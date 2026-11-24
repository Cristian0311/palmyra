import assert from "node:assert/strict";
import test from "node:test";
import {
  RATE_OFFLINE_NOTICE,
  fetchCloudRateQuotes,
  isDeviceOffline,
  resolveExchangeRates
} from "../../src/services/exchangeRatesHub";
import { syncAutoRates, type AutoRateStoreView } from "../../src/services/autoExchangeRate";
import { EXCHANGE_RATE_CACHE_KEY } from "../../src/lib/exchangeRates";
import type { HubRateQuote } from "../../src/services/lanHub/protocol";

/* ------------------------------------------------------------------ */
/* Respaldo de nube para escritorio y APK (777c256 + copia verificada) */
/* ------------------------------------------------------------------ */

const NOW_MS = Date.parse("2026-11-20T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const LIVE_ISO = new Date().toISOString();

const quote = (code: string, rate: number, capturedAt = NOW_ISO): HubRateQuote => ({
  code,
  rate,
  capturedAt,
  source: "elTOQUE API",
  stale: false
});

function cloudPayload(rates: Record<string, number>) {
  return {
    provider: "eltoque",
    source: "elTOQUE API",
    market: "informal",
    capturedAt: NOW_ISO,
    data: { tasas: rates }
  };
}

const credential503 = () =>
  new Response(JSON.stringify({ error: "Falta configurar la credencial de elTOQUE en el servidor." }), {
    status: 503,
    headers: { "content-type": "application/json" }
  });

/* Fetch compartido: la ruta local y la nube directa son intercambiables por
 * prueba; la caché del proveedor local conserva esta misma función, así que
 * el comportamiento se configura con `script` y no con cierres nuevos. */
let script: { local?: (url: string) => Response; render?: (url: string) => Response } = {};
let calls: string[] = [];
const dispatcher = (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (url.startsWith("/") || url.includes("127.0.0.1") || url.includes("localhost")) {
    if (!script.local) throw new TypeError("sin servidor local");
    return script.local(url);
  }
  if (!script.render) throw new TypeError("sin nube");
  return script.render(url);
}) as typeof fetch;

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

async function withNavigator<T>(value: { onLine?: boolean } | undefined, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { value, configurable: true });
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

async function withLocalStorage<T>(store: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: () => undefined,
        removeItem: () => undefined
      },
      configurable: true
    });
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

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

/* ------------------------------------------------------------------ */
/* Detección de conexión                                               */
/* ------------------------------------------------------------------ */

test("isDeviceOffline solo es true con navigator.onLine === false", async () => {
  await withNavigator({ onLine: false }, async () => {
    assert.equal(isDeviceOffline(), true);
  });
  await withNavigator({ onLine: true }, async () => {
    assert.equal(isDeviceOffline(), false);
  });
  // Sin onLine (entornos mínimos) nunca se declara offline.
  assert.equal(isDeviceOffline(), false);
});

/* ------------------------------------------------------------------ */
/* Copia verificada de la nube (CORS abierto: escritorio y APK)        */
/* ------------------------------------------------------------------ */

test("con la ruta local en 503 credencial se usa la copia verificada fresca sin tocar Render", async () => {
  calls = [];
  script = {
    local: credential503,
    render: () => {
      throw new Error("Render no debe consultarse con una copia verificada fresca");
    }
  };

  const resolved = await resolveExchangeRates({
    session: null,
    fetchImpl: dispatcher,
    now: () => NOW_MS,
    verifiedQuotes: async () => [quote("USD", 455)]
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.stale, false);
  assert.deepEqual(resolved.rates.map(item => [item.code, item.rate]), [["USD", 455]]);
  assert.equal(resolved.error, undefined);
  assert.ok(calls.length > 0, "se consultó la ruta local");
  assert.ok(
    calls.every(url => url.startsWith("/") || url.includes("127.0.0.1")),
    "solo se consultó la ruta local, nunca la nube directa"
  );
});

test("una copia verificada de más de 30 min se descarta y se consulta la nube directa", async () => {
  calls = [];
  script = {
    local: credential503,
    render: () =>
      new Response(JSON.stringify(cloudPayload({ USD: 460 })), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  };

  const staleCapturedAt = new Date(NOW_MS - 40 * 60 * 1000).toISOString();
  const resolved = await resolveExchangeRates({
    session: null,
    fetchImpl: dispatcher,
    now: () => NOW_MS,
    verifiedQuotes: async () => [quote("USD", 300, staleCapturedAt)]
  });

  assert.equal(resolved.stale, false);
  assert.deepEqual(resolved.rates.map(item => [item.code, item.rate]), [["USD", 460]]);
  assert.ok(
    calls.some(url => url.includes("palmyracrm.onrender.com")),
    "la nube directa respondió la consulta"
  );
});

test("fetchCloudRateQuotes prefiere la copia verificada fresca y no toca Render", async () => {
  calls = [];
  script = {
    render: () => {
      throw new Error("Render no debe consultarse");
    }
  };

  const rates = await fetchCloudRateQuotes({
    fetchImpl: dispatcher,
    now: () => NOW_MS,
    verifiedQuotes: async () => [quote("USD", 440)]
  });

  assert.deepEqual(rates.map(item => [item.code, item.rate]), [["USD", 440]]);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* Sin Internet: última tasa guardada + aviso claro, sin red           */
/* ------------------------------------------------------------------ */

test("sin Internet se devuelve al instante la última tasa guardada sin tocar la red", async () => {
  calls = [];
  script = {};

  await withLocalStorage(
    {
      [EXCHANGE_RATE_CACHE_KEY]: JSON.stringify({
        provider: "eltoque",
        source: "elTOQUE API",
        market: "informal",
        capturedAt: NOW_ISO,
        data: { tasas: { USD: 410 } }
      })
    },
    async () =>
      withNavigator({ onLine: false }, async () => {
        const resolved = await resolveExchangeRates({ session: null, fetchImpl: dispatcher, now: () => NOW_MS });
        assert.equal(resolved.source, "fallback");
        assert.equal(resolved.stale, true);
        assert.deepEqual(resolved.rates.map(item => [item.code, item.rate]), [["USD", 410]]);
        assert.equal(resolved.error, undefined);
        assert.equal(calls.length, 0, "sin conexión no se consulta nada");
      })
  );
});

test("sin Internet y sin tasa guardada el aviso es el offline, nunca la credencial", async () => {
  calls = [];
  script = {};

  await withNavigator({ onLine: false }, async () => {
    const resolved = await resolveExchangeRates({ session: null, fetchImpl: dispatcher, now: () => NOW_MS });
    assert.deepEqual(resolved.rates, []);
    assert.equal(resolved.stale, true);
    assert.equal(resolved.error, RATE_OFFLINE_NOTICE);
    assert.doesNotMatch(resolved.error ?? "", /credencial|servidor|nube/i);
    assert.equal(calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Sincronización automática en cada superficie                        */
/* ------------------------------------------------------------------ */

test("syncAutoRates aplica la copia verificada cuando la ruta local responde 503 credencial", async () => {
  const { store, updates } = makeStore();
  script = {
    local: credential503,
    render: () => {
      throw new Error("Render no debe consultarse con una copia verificada fresca");
    }
  };

  const run = await withFetch(dispatcher, () =>
    syncAutoRates(store, {
      force: true,
      verifiedQuotes: async () => [quote("USD", 460, LIVE_ISO)]
    })
  );

  assert.deepEqual(run.applied.map(item => [item.code, item.from, item.to]), [["USD", 400, 460]]);
  assert.deepEqual(updates, [{ code: "USD", rate: 460 }]);
  assert.equal(run.error, undefined);
});

test("syncAutoRates offline conserva el error de conexión sin hablar de credenciales", async () => {
  const { store, updates } = makeStore();
  script = {};

  const run = await withNavigator({ onLine: false }, async () =>
    withFetch(dispatcher, () => syncAutoRates(store, { force: true }))
  );

  assert.deepEqual(run.applied, []);
  assert.deepEqual(updates, []);
  assert.match(String(run.error ?? ""), /Sin conexión/);
  assert.doesNotMatch(String(run.error ?? ""), /credencial|servidor|nube/i);
});
