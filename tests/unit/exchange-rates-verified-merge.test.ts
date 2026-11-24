import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchCloudRateQuotes,
  mergeVerifiedHistoryRows
} from "../../src/services/exchangeRatesHub";
import type { HubRateQuote } from "../../src/services/lanHub/protocol";

/* ------------------------------------------------------------------ */
/* Copia verificada de Supabase: fusión del set completo               */
/* ------------------------------------------------------------------ */

const NOW_MS = Date.parse("2026-11-24T18:00:00.000Z");

/**
 * Grupos reales observados del RPC `get_verified_exchange_rate_history` el
 * 2026-11-24: el cron solo escribe los códigos que cambiaron en cada corrida,
 * así que cada punto es PARCIAL. La fusión debe reconstruir el set completo
 * que sirve elTOQUE (USD, EUR, MLC, BNB, BTC, TRX, USDT_TRC20).
 */
const OBSERVED_ROWS = [
  { captured_at: "2026-11-24T17:05:02.89+00:00", rates: { EUR: 1035, TRX: 412.6 } },
  { captured_at: "2026-11-24T17:15:01.5+00:00", rates: { BTC: 804.33, MLC: 820.18 } },
  { captured_at: "2026-11-24T17:25:02.381+00:00", rates: { MLC: 830.18, USDTTRC20: 1165 } },
  { captured_at: "2026-11-24T17:35:02.166+00:00", rates: { TRX: 416.69, USD: 970 } },
  { captured_at: "2026-11-24T17:40:03.152+00:00", rates: { MLC: 830.19, TRX: 417 } }
];

const quote = (code: string, rate: number, capturedAt: string): HubRateQuote => ({
  code,
  rate,
  capturedAt,
  source: "elTOQUE API",
  stale: false
});

test("la fusión reconstruye el set completo de monedas activas desde grupos parciales", () => {
  const merged = mergeVerifiedHistoryRows(OBSERVED_ROWS);
  const byCode = new Map(merged.map(item => [item.code, item]));

  // Cada código conserva el valor de su observación más reciente.
  assert.equal(byCode.get("USD")?.rate, 970);
  assert.equal(byCode.get("EUR")?.rate, 1035);
  assert.equal(byCode.get("MLC")?.rate, 830.19);
  assert.equal(byCode.get("BTC")?.rate, 804.33);
  assert.equal(byCode.get("TRX")?.rate, 417);
  assert.equal(byCode.get("USDT_TRC20")?.rate, 1165);

  // La captura de cada cotización es la del grupo donde se observó.
  assert.equal(byCode.get("USD")?.capturedAt, new Date("2026-11-24T17:35:02.166+00:00").toISOString());
  assert.equal(byCode.get("EUR")?.capturedAt, new Date("2026-11-24T17:05:02.89+00:00").toISOString());
  assert.equal(byCode.get("MLC")?.capturedAt, new Date("2026-11-24T17:40:03.152+00:00").toISOString());

  // El código compactado por el cron vuelve a la forma cruda de elTOQUE.
  assert.equal(byCode.has("USDTTRC20"), false);

  // Una sola tarjeta por moneda: 6 códigos distintos.
  assert.equal(merged.length, 6);
});

test("la fusión ignora filas inválidas, valores no positivos y entradas vacías", () => {
  const rows = [
    { captured_at: "not-a-date", rates: { USD: 400 } },
    { rates: { USD: 401 } },
    null,
    { captured_at: "2026-11-24T17:40:03.152+00:00", rates: { USD: 0, EUR: -5, MLC: 830.19, BAD: null } }
  ];
  const merged = mergeVerifiedHistoryRows(rows);
  const byCode = new Map(merged.map(item => [item.code, item]));
  assert.equal(byCode.get("MLC")?.rate, 830.19);
  assert.equal(byCode.has("USD"), false);
  assert.equal(byCode.has("EUR"), false);
  assert.equal(byCode.has("BAD"), false);
  assert.deepEqual(mergeVerifiedHistoryRows([]), []);
  assert.deepEqual(mergeVerifiedHistoryRows([null, undefined]), []);
});

/* ------------------------------------------------------------------ */
/* Frescura del conjunto fusionado                                     */
/* ------------------------------------------------------------------ */

function neverFetch(): typeof fetch {
  return (() => {
    throw new Error("Render no debe consultarse en esta prueba");
  }) as unknown as typeof fetch;
}

test("el conjunto fusionado se acepta si su captura más reciente es fresca, aunque un código tenga 45 min", async () => {
  const fresh = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
  const oldish = new Date(NOW_MS - 45 * 60 * 1000).toISOString();
  const rates = await fetchCloudRateQuotes({
    fetchImpl: neverFetch(),
    now: () => NOW_MS,
    verifiedQuotes: async () => [quote("USD", 970, fresh), quote("EUR", 1035, oldish)]
  });
  const byCode = new Map(rates.map(item => [item.code, item]));
  assert.equal(byCode.get("USD")?.rate, 970);
  assert.equal(byCode.get("EUR")?.rate, 1035);
});

test("un código estable (p. ej. BNB) observado hace horas se conserva en el conjunto fresco", async () => {
  const fresh = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
  const bnbAt = new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString();
  const rates = await fetchCloudRateQuotes({
    fetchImpl: neverFetch(),
    now: () => NOW_MS,
    verifiedQuotes: async () => [quote("USD", 970, fresh), quote("BNB", 450, bnbAt)]
  });
  const byCode = new Map(rates.map(item => [item.code, item]));
  assert.equal(byCode.get("USD")?.rate, 970);
  assert.equal(byCode.get("BNB")?.rate, 450);
});

test("una observación más vieja que la ventana de 6 h se descarta aunque el conjunto esté fresco", async () => {
  const fresh = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
  const expired = new Date(NOW_MS - 7 * 60 * 60 * 1000).toISOString();
  const rates = await fetchCloudRateQuotes({
    fetchImpl: neverFetch(),
    now: () => NOW_MS,
    verifiedQuotes: async () => [quote("USD", 970, fresh), quote("EUR", 1035, expired)]
  });
  const byCode = new Map(rates.map(item => [item.code, item]));
  assert.equal(byCode.get("USD")?.rate, 970);
  assert.equal(byCode.has("EUR"), false);
});

test("si la captura más reciente supera los 30 min el conjunto entero cae a la nube directa", async () => {
  const stale = new Date(NOW_MS - 40 * 60 * 1000).toISOString();
  let renderTouched = false;
  const rates = await fetchCloudRateQuotes({
    fetchImpl: (async () => {
      renderTouched = true;
      return new Response(JSON.stringify({
        provider: "eltoque",
        source: "elTOQUE API",
        market: "informal",
        capturedAt: new Date(NOW_MS).toISOString(),
        data: { tasas: { USD: 460 } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    now: () => NOW_MS,
    verifiedQuotes: async () => [quote("USD", 300, stale)]
  });
  assert.equal(renderTouched, true);
  assert.deepEqual(rates.map(item => [item.code, item.rate]), [["USD", 460]]);
});
