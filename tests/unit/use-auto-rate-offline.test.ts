import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunAutoRates } from "../../src/hooks/useAutoRateSync";
import { createHubRatesProvider } from "../../src/services/lanHub/rates";
import { resolveExchangeRates } from "../../src/services/exchangeRatesHub";
import type { HubRateQuote } from "../../src/services/lanHub/protocol";
import type { HubSession } from "../../src/services/lanHub/session";

const NOW_MS = Date.parse("2026-06-01T09:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();

/* ------------------------------------------------------------------ */
/* Guard puro del ciclo automático                                     */
/* ------------------------------------------------------------------ */

test("shouldRunAutoRates: las cuatro combinaciones de red y sesión de hub", () => {
  const run = (online: boolean, hasHubSession: boolean) =>
    shouldRunAutoRates({ visibility: "visible", online, hasHubSession });

  // Con red y hub: se consulta (hub primero).
  assert.equal(run(true, true), true);
  // Con red y sin hub: sigue la vía de la nube.
  assert.equal(run(true, false), true);
  // Sin red pero con hub: la LAN no necesita Internet.
  assert.equal(run(false, true), true);
  // Sin red ni hub: no hay a quién preguntar.
  assert.equal(run(false, false), false);
});

test("shouldRunAutoRates solo se detiene con la pestaña oculta", () => {
  assert.equal(shouldRunAutoRates({ visibility: "hidden", online: true, hasHubSession: true }), false);
  assert.equal(shouldRunAutoRates({ visibility: "hidden", online: false, hasHubSession: false }), false);
  assert.equal(shouldRunAutoRates({ visibility: "prerender", online: true, hasHubSession: false }), true);
  assert.equal(
    shouldRunAutoRates({ visibility: undefined, online: false, hasHubSession: true }),
    true
  );
  // Estado ausente (llamada defensiva) nunca habilita trabajo.
  assert.equal(shouldRunAutoRates(undefined as never), false);
});

/* ------------------------------------------------------------------ */
/* Sin navegador: el proveedor y el guard no explotan                  */
/* ------------------------------------------------------------------ */

test("sin navigator ni window el proveedor descubre la URL sin explotar", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hadWindow = "window" in globalThis;
  try {
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    assert.equal(typeof (globalThis as { navigator?: unknown }).navigator, "undefined");

    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        provider: "eltoque",
        source: "elTOQUE API",
        market: "informal",
        capturedAt: NOW_ISO,
        data: { tasas: { USD: 420 } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const provider = createHubRatesProvider({ fetchImpl, now: () => NOW_MS });
    const quotes = await provider();
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].code, "USD");
    assert.equal(quotes[0].rate, 420);
    // Sin pistas de runtime queda el último recurso: el servidor local.
    assert.match(calls[0], /^http:\/\/127\.0\.0\.1:\d+\/api\/exchange-rates$/);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
  assert.equal("window" in globalThis, hadWindow);
});

/* ------------------------------------------------------------------ */
/* Resolución hub → última válida                                      */
/* ------------------------------------------------------------------ */

const quote = (code: string, rate: number, stale = false): HubRateQuote => ({
  code,
  rate,
  capturedAt: NOW_ISO,
  source: "elTOQUE API",
  stale
});

const session: HubSession = {
  hubId: "hub-offline",
  deviceId: "equipo-offline",
  token: "token-de-prueba",
  baseUrl: "http://192.168.1.20:48900",
  joinedAt: NOW_ISO,
  cursor: 0
};

test("resolveExchangeRates cae al respaldo local cuando el hub no responde", async () => {
  const offlineFetch = (async () => { throw new TypeError("LAN sin respuesta"); }) as typeof fetch;
  const resolved = await resolveExchangeRates({
    session,
    fetchImpl: offlineFetch,
    now: () => NOW_MS,
    fallback: async () => [quote("USD", 445)]
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.stale, false);
  assert.deepEqual(resolved.rates.map(item => [item.code, item.rate]), [["USD", 445]]);
});

test("sin ninguna fuente la resolución queda vacía y marcada como no viva", async () => {
  const resolved = await resolveExchangeRates({
    session: null,
    fallback: async () => []
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.stale, true);
  assert.deepEqual(resolved.rates, []);
});
