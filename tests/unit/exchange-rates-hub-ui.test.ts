import assert from "node:assert/strict";
import test from "node:test";
import {
  HUB_RATES_TIMEOUT_MS,
  RATE_SOURCE_FRESH_MS,
  describeExchangeRateSource,
  resolveLocalHubBaseUrl,
  type ResolvedExchangeRates
} from "../../src/services/exchangeRatesHub";
import type { HubRateQuote } from "../../src/services/lanHub/protocol";

const NOW_MS = Date.parse("2026-05-01T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();

const quote = (code: string, rate: number, capturedAt = NOW_ISO, stale = false): HubRateQuote => ({
  code,
  rate,
  capturedAt,
  source: "elTOQUE API",
  stale
});

const resolved = (overrides: Partial<ResolvedExchangeRates> = {}): ResolvedExchangeRates => ({
  source: "fallback",
  rates: [quote("USD", 480)],
  stale: false,
  ...overrides
});

/* ------------------------------------------------------------------ */
/* Insignia de fuente: hub LAN / nube / última guardada                */
/* ------------------------------------------------------------------ */

test("el hub LAN se muestra como fuente real cuando responde en vivo", () => {
  const view = describeExchangeRateSource(resolved({ source: "hub" }), NOW_MS);
  assert.equal(view.kind, "hub");
  assert.equal(view.label, "Hub LAN");
  assert.equal(view.stale, false);
  assert.doesNotMatch(view.detail, /nube|guardada/i);
});

test("un hub con copia vencida sigue siendo hub pero se marca stale", () => {
  const view = describeExchangeRateSource(resolved({ source: "hub", stale: true }), NOW_MS);
  assert.equal(view.kind, "hub");
  assert.equal(view.stale, true);
  assert.match(view.detail, /última tasa válida/i);
});

test("la nube se muestra cuando el respaldo trae tasas frescas", () => {
  const view = describeExchangeRateSource(resolved(), NOW_MS);
  assert.equal(view.kind, "cloud");
  assert.equal(view.label, "elTOQUE · nube");
  assert.equal(view.stale, false);
});

test("un respaldo marcado stale se resume como última tasa guardada", () => {
  const view = describeExchangeRateSource(resolved({ stale: true }), NOW_MS);
  assert.equal(view.kind, "cached");
  assert.equal(view.stale, true);
  assert.match(view.detail, /última tasa válida/i);
});

test("sin cotizaciones la pantalla muestra la última guardada y el error", () => {
  const view = describeExchangeRateSource({
    source: "fallback",
    rates: [],
    stale: true,
    error: "Este equipo no tiene sesión con el hub LAN; se usará la tasa local."
  }, NOW_MS);
  assert.equal(view.kind, "cached");
  assert.equal(view.label, "Última tasa guardada");
  assert.equal(view.stale, true);
  assert.match(view.detail, /hub LAN/);
});

test("una captura de más de 30 minutos se considera stale aunque la fuente no lo diga", () => {
  const old = new Date(NOW_MS - RATE_SOURCE_FRESH_MS - 60_000).toISOString();
  const view = describeExchangeRateSource(resolved({ rates: [quote("USD", 480, old)] }), NOW_MS);
  assert.equal(view.stale, true);
  assert.equal(view.kind, "cached");
});

/* ------------------------------------------------------------------ */
/* Puerto del servidor local resuelto sin asumir 10000                 */
/* ------------------------------------------------------------------ */

test("el origen loopback real de la ventana manda sobre el puerto 10000", () => {
  assert.equal(resolveLocalHubBaseUrl({ origin: "http://127.0.0.1:10000" }), "http://127.0.0.1:10000");
  assert.equal(resolveLocalHubBaseUrl({ origin: "http://localhost:31337", port: 48900 }), "http://localhost:31337");
});

test("un origen remoto no se usa y se toma el puerto del runtime", () => {
  assert.equal(resolveLocalHubBaseUrl({ origin: "https://palmyra.example", port: 48900 }), "http://127.0.0.1:48900");
});

test("sin pistas válidas se delega al último recurso del proveedor", () => {
  assert.equal(resolveLocalHubBaseUrl(), undefined);
  assert.equal(resolveLocalHubBaseUrl({ origin: "https://palmyra.example", port: 0 }), undefined);
  assert.equal(resolveLocalHubBaseUrl({ port: 70000 }), undefined);
});

test("el tiempo del hub en LAN se mantiene corto para caer al respaldo", () => {
  assert.equal(HUB_RATES_TIMEOUT_MS, 4_000);
});
