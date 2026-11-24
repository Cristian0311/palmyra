import assert from "node:assert/strict";
import test from "node:test";
import {
  HUB_RATES_TTL_MS,
  createHubRatesProvider,
  hubQuotesToPayload,
  serverPortFromStatus,
  localExchangeRatesUrl,
  resolveLocalServerBaseUrl
} from "../../src/services/lanHub/rates";
import { formatRateAge, resolveExchangeRates } from "../../src/services/exchangeRatesHub";

const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();

type Call = { url: string; init: RequestInit };

const payload = (capturedAt = FIXED_ISO, stale = false) => ({
  provider: "eltoque",
  source: "elTOQUE API",
  market: "informal",
  capturedAt,
  data: { tasas: { USD: 400, ECU: 450, MLC: 220 } },
  ...(stale ? { stale: true } : {})
});

function scriptedFetch(steps: Array<{ body?: unknown; status?: number; reject?: boolean }>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps.shift();
    if (!step) throw new Error("fetch inesperado en la prueba");
    if (step.reject) throw new TypeError("sin red");
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, impl };
}

test("normaliza la respuesta local a HubRateQuote y usa el puerto 10000 por defecto", async () => {
  const { calls, impl } = scriptedFetch([{ body: payload() }]);
  const provider = createHubRatesProvider({ fetchImpl: impl, now: () => FIXED_MS });

  const quotes = await provider();
  assert.deepEqual(
    quotes.map(quote => quote.code).sort(),
    ["EUR", "MLC", "USD"]
  );
  const usd = quotes.find(quote => quote.code === "USD");
  assert.deepEqual(usd, {
    code: "USD",
    rate: 400,
    capturedAt: FIXED_ISO,
    source: "elTOQUE API",
    stale: false
  });
  // La fuente publica el euro como ECU y el POS habla EUR.
  assert.equal(quotes.find(quote => quote.code === "EUR")?.rate, 450);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:10000/api/exchange-rates");
  const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Accept, "application/json");
  assert.equal("authorization" in headers, false);
  assert.equal(JSON.stringify(headers).includes("eltoque.com"), false);
});

test("acepta una base local explícita y no repite la consulta dentro del TTL", async () => {
  let now = FIXED_MS;
  const { calls, impl } = scriptedFetch([{ body: payload() }, { body: { ...payload(), data: { tasas: { USD: 420 } } } }]);
  const provider = createHubRatesProvider({
    fetchImpl: impl,
    localBaseUrl: "http://192.168.1.10:48900/",
    ttlMs: HUB_RATES_TTL_MS,
    now: () => now
  });

  await provider();
  now += HUB_RATES_TTL_MS - 1;
  const cached = await provider();
  assert.equal(calls.length, 1);
  assert.equal(cached.find(quote => quote.code === "USD")?.rate, 400);
  assert.equal(calls[0].url, "http://192.168.1.10:48900/api/exchange-rates");

  now += 2;
  const refreshed = await provider();
  assert.equal(calls.length, 2);
  assert.equal(refreshed.find(quote => quote.code === "USD")?.rate, 420);
});

test("un fallo con copia previa sirve la última tasa válida marcada como stale", async () => {
  let now = FIXED_MS;
  const { calls, impl } = scriptedFetch([{ body: payload() }, { reject: true }]);
  const provider = createHubRatesProvider({ fetchImpl: impl, now: () => now });

  const live = await provider();
  assert.ok(live.every(quote => quote.stale === false));

  now += HUB_RATES_TTL_MS + 1;
  const stale = await provider();
  assert.equal(calls.length, 2);
  assert.ok(stale.length > 0);
  assert.ok(stale.every(quote => quote.stale === true));
  assert.equal(stale.find(quote => quote.code === "USD")?.rate, 400);
  // La copia conserva la hora real de captura de elTOQUE.
  assert.equal(stale.find(quote => quote.code === "USD")?.capturedAt, FIXED_ISO);
});

test("sin copia previa lanza en vez de inventar tasas", async () => {
  const offline = createHubRatesProvider({ fetchImpl: scriptedFetch([{ reject: true }]).impl, now: () => FIXED_MS });
  await assert.rejects(offline(), /tasa|cotizaci/i);

  const unavailable = createHubRatesProvider({
    fetchImpl: scriptedFetch([{ status: 503, body: { error: "sin credencial" } }]).impl,
    now: () => FIXED_MS
  });
  await assert.rejects(unavailable(), /tasa/i);

  const empty = createHubRatesProvider({
    fetchImpl: scriptedFetch([{ body: { provider: "eltoque", capturedAt: FIXED_ISO, data: {} } }]).impl,
    now: () => FIXED_MS
  });
  await assert.rejects(empty(), /cotizaciones válidas/i);
});

test("la URL se construye siempre contra el servidor local, nunca contra elTOQUE", () => {
  assert.equal(localExchangeRatesUrl(), "http://127.0.0.1:10000/api/exchange-rates");
  assert.equal(localExchangeRatesUrl("http://127.0.0.1:48900/"), "http://127.0.0.1:48900/api/exchange-rates");
});

test("la base local se descubre sin asumir 10000: explícita, VITE, ventana y runtime", () => {
  // 1) La raíz explícita manda sobre cualquier otra pista.
  assert.equal(
    resolveLocalServerBaseUrl({
      localBaseUrl: "http://127.0.0.1:48900/",
      envUrl: "http://127.0.0.1:5055",
      windowOrigin: "http://127.0.0.1:10000",
      runtimePort: 6000
    }),
    "http://127.0.0.1:48900"
  );
  // 2) VITE_DESKTOP_SERVER_URL manda sobre el origen de la ventana.
  assert.equal(
    resolveLocalServerBaseUrl({
      envUrl: "https://127.0.0.1:5055/",
      windowOrigin: "http://127.0.0.1:10000",
      runtimePort: 6000
    }),
    "https://127.0.0.1:5055"
  );
  // 3) El shell se sirve desde el propio servidor local: su origen es la base.
  assert.equal(
    resolveLocalServerBaseUrl({ windowOrigin: "http://192.168.1.10:10000/", runtimePort: 6000 }),
    "http://192.168.1.10:10000"
  );
  assert.equal(resolveLocalServerBaseUrl({ windowOrigin: "file:///app/index.html", runtimePort: 48911 }), "http://127.0.0.1:48911");
  // 4) Sin ninguna pista se devuelve undefined (último recurso en el proveedor).
  assert.equal(resolveLocalServerBaseUrl(), undefined);
  assert.equal(resolveLocalServerBaseUrl({ localBaseUrl: "file:///tmp/x", envUrl: "no-es-url", runtimePort: 70000 }), undefined);
});

test("el proveedor respeta VITE_DESKTOP_SERVER_URL inyectada antes que el 10000", async () => {
  const { calls, impl } = scriptedFetch([{ body: payload() }]);
  const provider = createHubRatesProvider({ fetchImpl: impl, envUrl: "http://127.0.0.1:5055/", now: () => FIXED_MS });
  await provider();
  assert.equal(calls[0].url, "http://127.0.0.1:5055/api/exchange-rates");
  // La caché de 30 min aplica a la URL descubierta.
  await provider();
  assert.equal(calls.length, 1);
});

test("sin URL inyectada se usa el puerto del servidor local y se ignora el del hub", async () => {
  const { calls, impl } = scriptedFetch([{ body: payload() }]);
  const provider = createHubRatesProvider({
    fetchImpl: impl,
    desktopStatus: async () => ({ ok: true, status: { running: true, serverPort: 48911 } }),
    now: () => FIXED_MS
  });
  await provider();
  assert.equal(calls[0].url, "http://127.0.0.1:48911/api/exchange-rates");

  // El estado real del puente publica el puerto del hub LAN (48900), que no
  // sirve las tasas: no debe usarse como servidor local.
  const hubPortCalls: string[] = [];
  const hubPortFetch = (async (input: RequestInfo | URL) => {
    hubPortCalls.push(String(input));
    return new Response(JSON.stringify(payload()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const hubPortProvider = createHubRatesProvider({
    fetchImpl: hubPortFetch,
    desktopStatus: async () => ({ ok: true, status: { running: true, port: 48900 } }),
    now: () => FIXED_MS
  });
  await hubPortProvider();
  assert.equal(hubPortCalls[0], "http://127.0.0.1:10000/api/exchange-rates");

  const fallbackCalls: string[] = [];
  const fallbackFetch = (async (input: RequestInfo | URL) => {
    fallbackCalls.push(String(input));
    return new Response(JSON.stringify(payload()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const broken = createHubRatesProvider({
    fetchImpl: fallbackFetch,
    desktopStatus: () => { throw new Error("puente caído"); },
    now: () => FIXED_MS
  });
  const quotes = await broken();
  assert.ok(quotes.length > 0);
  assert.equal(fallbackCalls[0], "http://127.0.0.1:10000/api/exchange-rates");
});

test("serverPortFromStatus solo acepta puertos explícitos del servidor HTTP", () => {
  assert.equal(serverPortFromStatus({ ok: true, status: { serverPort: 5055 } }), 5055);
  assert.equal(serverPortFromStatus({ httpPort: 5056 }), 5056);
  // `port` es el hub LAN: no sirve /api/exchange-rates.
  assert.equal(serverPortFromStatus({ ok: true, status: { port: 48900 } }), null);
  assert.equal(serverPortFromStatus({ ok: false, error: "sin permiso", status: { serverPort: 5055 } }), null);
  assert.equal(serverPortFromStatus({ ok: true, status: { serverPort: 0 } }), null);
  assert.equal(serverPortFromStatus(null), null);
});

test("formatRateAge expresa la antigüedad de la captura en español", () => {
  assert.equal(formatRateAge(null), "sin fecha");
  assert.equal(formatRateAge(30_000), "hace menos de 1 min");
  assert.equal(formatRateAge(12 * 60_000), "hace 12 min");
  assert.equal(formatRateAge(3 * 3_600_000), "hace 3 h");
  assert.equal(formatRateAge(50 * 3_600_000), "hace 2 días");
  assert.equal(formatRateAge(-500), "hace menos de 1 min");
});

test("resolveExchangeRates firma la petición al hub y cae al respaldo sin filtrar el token", async () => {
  const session = {
    hubId: "hub-1",
    deviceId: "dev-1",
    token: "token-secreto-dev-1_ABC123",
    baseUrl: "http://192.168.1.10:48900",
    joinedAt: FIXED_ISO,
    cursor: 0
  };
  const { calls, impl } = scriptedFetch([{
    body: {
      rates: [{ code: "USD", rate: 400, capturedAt: FIXED_ISO, source: "elTOQUE API", stale: false }],
      serverTime: FIXED_ISO
    }
  }]);
  const fromHub = await resolveExchangeRates({ session, fetchImpl: impl, now: () => FIXED_MS });
  assert.equal(fromHub.source, "hub");
  assert.equal(fromHub.stale, false);
  assert.equal(fromHub.rates[0].rate, 400);
  assert.equal(calls[0].url, "http://192.168.1.10:48900/lan/v1/rates");
  assert.equal(calls[0].init.method, "GET");
  const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
  assert.match(headers["x-palmyra-signature"], /^[0-9a-f]{64}$/);
  assert.equal(headers["x-palmyra-device"], "dev-1");
  assert.equal(JSON.stringify(headers).includes(session.token), false);

  const unavailable = scriptedFetch([{ status: 503, body: { error: "rates_unavailable" } }]);
  const fromFallback = await resolveExchangeRates({
    session,
    fetchImpl: unavailable.impl,
    now: () => FIXED_MS,
    fallback: async () => [{ code: "USD", rate: 390, capturedAt: FIXED_ISO, source: "local", stale: false }]
  });
  assert.equal(fromFallback.source, "fallback");
  assert.equal(fromFallback.rates[0].rate, 390);
  assert.equal(fromFallback.stale, false);

  const withoutSession = await resolveExchangeRates({ session: null, fallback: async () => [] });
  assert.equal(withoutSession.source, "fallback");
  assert.deepEqual(withoutSession.rates, []);
  assert.equal(withoutSession.stale, true);
});

test("hubQuotesToPayload produce el payload que ya consume el POS y propaga stale", () => {
  const live = hubQuotesToPayload([
    { code: "USD", rate: 400, capturedAt: FIXED_ISO, source: "elTOQUE API", stale: false },
    { code: "EUR", rate: 450, capturedAt: FIXED_ISO, source: "elTOQUE API", stale: false }
  ], FIXED_MS);
  assert.ok(live);
  assert.equal(live!.provider, "eltoque");
  assert.equal(live!.capturedAt, FIXED_ISO);
  assert.deepEqual(live!.data, { tasas: { USD: 400, EUR: 450 } });
  assert.equal(live!.stale, undefined);

  const stale = hubQuotesToPayload([
    { code: "USD", rate: 400, capturedAt: FIXED_ISO, source: "elTOQUE API", stale: true }
  ], FIXED_MS);
  assert.equal(stale?.stale, true);
  assert.match(String(stale?.notice), /no es una consulta en vivo/i);

  assert.equal(hubQuotesToPayload([], FIXED_MS), null);
});
