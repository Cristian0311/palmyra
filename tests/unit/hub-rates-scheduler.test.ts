import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  RATE_BOOT_DELAY_MS,
  RATE_DEFAULT_FRESH_MS,
  RATE_FAILURE_MAX_MS,
  RATE_FAILURE_MIN_MS,
  RATE_JITTER_MS,
  RATE_MAX_MS,
  RATE_MIN_MS,
  RATE_SNAPSHOT_MAX_AGE_MS,
  RATE_TARGET_MS,
  buildRateSnapshot,
  clampRateDelayMs,
  isRateFresh,
  mergeRateSnapshot,
  nextRateDelayMs,
  planRateRun,
  rateFailureDelayMs,
  rateJitterMs,
  rateSnapshotAgeMs,
  readRateSnapshot,
  type HubRateSnapshot
} from "../../src/services/lanHub/rateScheduler";
import {
  CLIENT_RATE_ROUTE,
  AUTO_RATE_MIN_GAP_MS,
  clientRateEndpoint
} from "../../src/services/autoExchangeRate";
import { AUTO_RATE_CHECK_MS } from "../../src/hooks/useAutoRateSync";
import { RATE_HUB_FRESH_MS } from "../../src/services/exchangeRatesHub";
import { createHubRatesProvider } from "../../src/services/lanHub/rates";
import type { HubRateQuote } from "../../src/services/lanHub/protocol";

const MINUTE = 60 * 1000;
const NOW_MS = Date.parse("2026-07-01T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const ROOT = process.cwd();

const quote = (code: string, rate: number, capturedAt = NOW_ISO, stale = false): HubRateQuote => ({
  code,
  rate,
  capturedAt,
  source: "elTOQUE API",
  stale
});

/* ------------------------------------------------------------------ */
/* Cadencia 30–60 y jitter ±3 min                                     */
/* ------------------------------------------------------------------ */

test("la cadencia normal siempre queda entre 30 y 60 minutos", () => {
  assert.equal(RATE_MIN_MS, 30 * MINUTE);
  assert.equal(RATE_TARGET_MS, 45 * MINUTE);
  assert.equal(RATE_MAX_MS, 60 * MINUTE);

  assert.equal(clampRateDelayMs(0), RATE_MIN_MS);
  assert.equal(clampRateDelayMs(90 * MINUTE), RATE_MAX_MS);
  assert.equal(clampRateDelayMs(Number.NaN), RATE_TARGET_MS);

  for (const random of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const delay = nextRateDelayMs({ failures: 0, random });
    assert.ok(delay >= RATE_MIN_MS, `delay ${delay} por debajo del mínimo`);
    assert.ok(delay <= RATE_MAX_MS, `delay ${delay} por encima del máximo`);
  }
  // Un estado sin datos usa la cadencia objetivo.
  assert.equal(nextRateDelayMs({}), RATE_TARGET_MS);
  // Consulta inmediata tras el arranque.
  assert.equal(RATE_BOOT_DELAY_MS, 10_000);
});

test("el jitter es determinista y no excede ±3 minutos", () => {
  assert.equal(RATE_JITTER_MS, 3 * MINUTE);
  assert.equal(rateJitterMs(0), -RATE_JITTER_MS);
  assert.equal(rateJitterMs(1), RATE_JITTER_MS);
  assert.equal(rateJitterMs(0.5), 0);
  assert.equal(rateJitterMs(Number.NaN), 0);

  // Cinco equipos con la misma semilla esperan exactamente lo mismo.
  const seeds = [0.1, 0.3, 0.5, 0.7, 0.9];
  for (const random of seeds) {
    const first = nextRateDelayMs({ random });
    const second = nextRateDelayMs({ random });
    assert.equal(first, second);
    assert.ok(Math.abs(first - RATE_TARGET_MS) <= RATE_JITTER_MS);
  }
  // Semillas distintas no se alinean entre sí.
  assert.notEqual(nextRateDelayMs({ random: 0.1 }), nextRateDelayMs({ random: 0.9 }));
});

/* ------------------------------------------------------------------ */
/* Retroceso por fallos y reinicio con éxito                          */
/* ------------------------------------------------------------------ */

test("el retroceso por fallos es 5→10→20→30 y se repite con tope", () => {
  assert.equal(RATE_FAILURE_MIN_MS, 5 * MINUTE);
  assert.equal(RATE_FAILURE_MAX_MS, 30 * MINUTE);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 9].map(rateFailureDelayMs),
    [5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 30 * MINUTE, 30 * MINUTE, 30 * MINUTE]
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(failures => nextRateDelayMs({ failures, random: 0.5 })),
    [5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 30 * MINUTE, 30 * MINUTE]
  );
  // Fallos inválidos o ausentes no aceleran la consulta.
  assert.equal(nextRateDelayMs({ failures: -3 }), RATE_TARGET_MS);
});

test("un éxito reinicia el retroceso y vuelve a la cadencia de 45 min", () => {
  assert.equal(nextRateDelayMs({ failures: 3 }), 20 * MINUTE);
  // Tras el éxito el estado llega con failures: 0.
  assert.equal(nextRateDelayMs({ failures: 0, random: 0.5 }), RATE_TARGET_MS);

  // planRateRun respeta el reintento programado y el ancla del último intento.
  const state = { failures: 1, lastAttemptAt: NOW_MS - 4 * MINUTE, random: 0.5 };
  const waiting = planRateRun(state, NOW_MS);
  assert.equal(waiting.delayMs, 5 * MINUTE);
  assert.equal(waiting.dueAt, NOW_MS + MINUTE);
  assert.equal(waiting.shouldRun, false);

  const due = planRateRun(state, NOW_MS + MINUTE);
  assert.equal(due.shouldRun, true);

  // Sin historial, la primera consulta está vencida (el arranque aplica su espera).
  const cold = planRateRun({}, NOW_MS);
  assert.equal(cold.shouldRun, true);
  assert.equal(cold.dueAt, NOW_MS);
});

/* ------------------------------------------------------------------ */
/* Detección de copia vencida                                         */
/* ------------------------------------------------------------------ */

test("isRateFresh distingue copia vigente y vencida", () => {
  assert.equal(RATE_DEFAULT_FRESH_MS, 30 * MINUTE);
  const snapshot = buildRateSnapshot([quote("USD", 400)], NOW_MS, "hub");
  assert.ok(snapshot);
  assert.equal(isRateFresh(snapshot, NOW_MS), true);
  assert.equal(isRateFresh(snapshot, NOW_MS + RATE_DEFAULT_FRESH_MS), true);
  assert.equal(isRateFresh(snapshot, NOW_MS + RATE_DEFAULT_FRESH_MS + 1), false);
  // El hub tolera su propia cadencia: 60 min por defecto en el proveedor.
  assert.equal(RATE_SNAPSHOT_MAX_AGE_MS, RATE_MAX_MS);
  assert.equal(isRateFresh(snapshot, NOW_MS + RATE_SNAPSHOT_MAX_AGE_MS + 1, RATE_SNAPSHOT_MAX_AGE_MS), false);
  assert.equal(rateSnapshotAgeMs(snapshot, NOW_MS + 12 * MINUTE), 12 * MINUTE);
  assert.equal(isRateFresh(null, NOW_MS), false);
  assert.equal(rateSnapshotAgeMs(null, NOW_MS), null);
});

/* ------------------------------------------------------------------ */
/* Persistencia y fusión                                              */
/* ------------------------------------------------------------------ */

test("la copia persistida sobrevive un viaje por JSON", () => {
  const snapshot = buildRateSnapshot([
    quote("USD", 400),
    quote("EUR", 450),
    quote("MLC", 220)
  ], NOW_MS, "hub");
  assert.ok(snapshot);
  const restored = readRateSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored, snapshot);
  assert.equal(restored?.source, "hub");
  assert.equal(restored?.stale, false);

  // Archivos corruptos no producen tasas inventadas.
  assert.equal(readRateSnapshot(null), null);
  assert.equal(readRateSnapshot({}), null);
  assert.equal(readRateSnapshot({ quotes: [], fetchedAt: NOW_ISO }), null);
  assert.equal(readRateSnapshot({ quotes: [{ code: "USD", rate: 0 }], fetchedAt: NOW_ISO }), null);
  assert.equal(readRateSnapshot({ quotes: [quote("USD", 400)], fetchedAt: "no-es-fecha" }), null);
  assert.equal(buildRateSnapshot([], NOW_MS), null);

  const cloud = buildRateSnapshot([quote("USD", 410)], NOW_MS, "cloud");
  assert.equal(cloud?.source, "cloud");
  assert.equal(readRateSnapshot(cloud)?.source, "cloud");
});

test("mergeRateSnapshot conserva la captura más reciente", () => {
  const newer = buildRateSnapshot([
    quote("USD", 400, new Date(NOW_MS).toISOString()),
    quote("EUR", 450, new Date(NOW_MS).toISOString())
  ], NOW_MS, "hub");
  const older: HubRateSnapshot = {
    quotes: [quote("USD", 380, new Date(NOW_MS - 45 * MINUTE).toISOString()), quote("MLC", 200)],
    fetchedAt: new Date(NOW_MS - 45 * MINUTE).toISOString(),
    source: "hub",
    stale: false
  };
  const merged = mergeRateSnapshot(older, newer);
  assert.equal(merged?.fetchedAt, newer?.fetchedAt);
  assert.equal(merged?.quotes.find(item => item.code === "USD")?.rate, 400);
  // Las divisas que solo traía la copia vieja no se pierden.
  assert.equal(merged?.quotes.find(item => item.code === "MLC")?.rate, 200);

  // Una copia "nueva" con fecha anterior no pisa a la buena.
  const olderFresh: HubRateSnapshot = {
    quotes: [quote("USD", 999)],
    fetchedAt: new Date(NOW_MS - 60 * MINUTE).toISOString(),
    source: "hub",
    stale: false
  };
  const kept = mergeRateSnapshot(newer, olderFresh);
  assert.equal(kept?.fetchedAt, newer?.fetchedAt);
  assert.equal(kept?.quotes.find(item => item.code === "USD")?.rate, 400);

  // Sin una de las partes, se conserva la que exista.
  assert.deepEqual(mergeRateSnapshot(null, newer), newer);
  assert.deepEqual(mergeRateSnapshot(older, null), older);
  // Una copia sin tasas nunca borra la última válida.
  assert.deepEqual(mergeRateSnapshot(newer, null), newer);
});

/* ------------------------------------------------------------------ */
/* El cliente jamás apunta a elTOQUE                                  */
/* ------------------------------------------------------------------ */

test("el cliente usa solo la ruta propia y nunca tasas.eltoque.com", () => {
  assert.equal(CLIENT_RATE_ROUTE, "/api/exchange-rates");
  assert.equal(clientRateEndpoint(), CLIENT_RATE_ROUTE);
  assert.doesNotMatch(clientRateEndpoint(), /eltoque|https?:/i);

  const rendererFiles = [
    "src/services/autoExchangeRate.ts",
    "src/services/exchangeRatesHub.ts",
    "src/services/lanHub/rates.ts",
    "src/services/lanHub/rateScheduler.ts",
    "src/hooks/useAutoRateSync.ts",
    "src/pages/ExchangeRate.tsx"
  ];
  for (const file of rendererFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /tasas\.eltoque\.com/i, `${file} no debe apuntar a elTOQUE`);
  }
});

/* ------------------------------------------------------------------ */
/* El hub sirve su caché primero                                      */
/* ------------------------------------------------------------------ */

const localPayload = {
  provider: "eltoque",
  source: "elTOQUE API",
  market: "informal",
  capturedAt: NOW_ISO,
  data: { tasas: { USD: 500, ECU: 460 } }
};

function scriptedFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(localPayload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, impl };
}

test("el hub sirve la copia inyectada sin tocar la red", async () => {
  const snapshot = buildRateSnapshot([quote("USD", 512)], NOW_MS, "hub");
  let fetches = 0;
  const provider = createHubRatesProvider({
    now: () => NOW_MS,
    cacheReader: () => snapshot,
    fetchImpl: (async () => {
      fetches += 1;
      throw new Error("la red no debe usarse con caché");
    }) as typeof fetch
  });

  const quotes = await provider();
  assert.equal(fetches, 0);
  assert.deepEqual(quotes.map(item => [item.code, item.rate, item.stale]), [["USD", 512, false]]);

  // Una copia vieja se sirve igual, pero marcada como no viva.
  const old = buildRateSnapshot([quote("USD", 512, new Date(NOW_MS - 90 * MINUTE).toISOString())], NOW_MS - 90 * MINUTE);
  const staleProvider = createHubRatesProvider({
    now: () => NOW_MS,
    cacheReader: () => old,
    maxAgeMs: RATE_SNAPSHOT_MAX_AGE_MS
  });
  const stale = await staleProvider();
  assert.equal(stale[0].stale, true);
});

test("sin copia el hub solo consulta si tiene credencial, y no repite el intento", async () => {
  const { calls, impl } = scriptedFetch();
  const withoutToken = createHubRatesProvider({
    now: () => NOW_MS,
    cacheReader: () => null,
    fetchImpl: impl
  });
  await assert.rejects(withoutToken(), /no hay una tasa válida/i);
  assert.equal(calls.length, 0);

  let now = NOW_MS;
  const failingFetch = (async () => { throw new TypeError("sin red"); }) as typeof fetch;
  const withToken = createHubRatesProvider({
    now: () => now,
    cacheReader: () => null,
    tokenProvider: () => "token-de-prueba",
    fetchImpl: failingFetch,
    localBaseUrl: "http://127.0.0.1:10000"
  });
  await assert.rejects(withToken(), /no se pudo consultar la tasa automática/i);
  // Enfriamiento de 5 min: no se reintenta en cada petición.
  await assert.rejects(withToken(), /reintentando/i);

  now += 5 * MINUTE;
  const { calls: okCalls, impl: okFetch } = scriptedFetch();
  const recovered = createHubRatesProvider({
    now: () => now,
    cacheReader: () => null,
    tokenProvider: () => "token-de-prueba",
    fetchImpl: okFetch,
    localBaseUrl: "http://127.0.0.1:10000"
  });
  const quotes = await recovered();
  assert.equal(okCalls.length, 1);
  assert.equal(okCalls[0].url, "http://127.0.0.1:10000/api/exchange-rates");
  const headers = JSON.stringify(okCalls[0].init.headers ?? {});
  assert.equal(headers.includes("token-de-prueba"), false);
  assert.equal(headers.toLowerCase().includes("authorization"), false);
  assert.equal(quotes.find(item => item.code === "USD")?.rate, 500);
});

test("la cadencia de la UI sigue los 45 min del hub y no bucles de 25", () => {
  assert.equal(AUTO_RATE_CHECK_MS, RATE_TARGET_MS);
  assert.equal(RATE_HUB_FRESH_MS, RATE_MAX_MS);
  assert.equal(AUTO_RATE_MIN_GAP_MS, 40 * MINUTE);
  assert.ok(AUTO_RATE_MIN_GAP_MS >= 30 * MINUTE);
});
