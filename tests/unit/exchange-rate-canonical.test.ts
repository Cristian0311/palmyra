import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalRateCode,
  canonicalizeRates,
  canonicalizeRateSnapshots,
  parseExchangeRates
} from '../../src/lib/exchangeRates';

const data = { tasas: { USD: 400, ECU: 450, MLC: 220 } };

test('canonicalRateCode presents ECU as EUR and leaves every other code intact', () => {
  assert.equal(canonicalRateCode('ECU'), 'EUR');
  assert.equal(canonicalRateCode('ecu'), 'EUR');
  assert.equal(canonicalRateCode(' EUR '), 'EUR');
  assert.equal(canonicalRateCode('USD'), 'USD');
  assert.equal(canonicalRateCode('MLC'), 'MLC');
});

test('canonicalizeRates merges ECU into one EUR card without changing parseExchangeRates', () => {
  const raw = parseExchangeRates(data);
  assert.deepEqual(raw.map(rate => rate.code), ['USD', 'ECU', 'MLC']);
  assert.deepEqual(canonicalizeRates(raw), [
    { code: 'USD', value: 400, buy: undefined, sell: undefined },
    { code: 'EUR', value: 450, buy: undefined, sell: undefined },
    { code: 'MLC', value: 220, buy: undefined, sell: undefined }
  ]);
});

test('a live EUR row wins over ECU and missing fields fall back to the alias', () => {
  const merged = canonicalizeRates([
    { code: 'ECU', value: 440, buy: 430, sell: 460 },
    { code: 'EUR', value: 450 }
  ]);
  assert.deepEqual(merged, [{ code: 'EUR', value: 450, buy: 430, sell: 460 }]);
});

test('history snapshots merge ECU into EUR and prefer an explicitly quoted EUR', () => {
  const snapshots = [
    { capturedAt: '2026-11-18T10:00:00Z', rates: { USD: 400, ECU: 450 } },
    { capturedAt: '2026-11-18T11:00:00Z', rates: { USD: 405, ECU: 440, EUR: 455 } }
  ];
  assert.deepEqual(canonicalizeRateSnapshots(snapshots), [
    { capturedAt: '2026-11-18T10:00:00Z', rates: { USD: 400, EUR: 450 } },
    { capturedAt: '2026-11-18T11:00:00Z', rates: { USD: 405, EUR: 455 } }
  ]);
  // The raw ECU observation is preserved for the stored history.
  assert.equal(snapshots[0].rates.ECU, 450);
});

test('codes compacted by the monitor cron map back to the raw elTOQUE form', () => {
  // elTOQUE publica USDT_TRC20; la historia verificada guarda USDTTRC20.
  assert.equal(canonicalRateCode('USDTTRC20'), 'USDT_TRC20');
  assert.equal(canonicalRateCode('USDTTRC'), 'USDT_TRC20');
  assert.equal(canonicalRateCode('USDT_TRC20'), 'USDT_TRC20');
  assert.equal(canonicalRateCode('USDT_ERC20'), 'USDT_ERC20');
});

test('canonicalizeRates merges USDTTRC20 into one USDT_TRC20 card with the live value winning', () => {
  const merged = canonicalizeRates([
    { code: 'USDTTRC20', value: 1165 },
    { code: 'USDT_TRC20', value: 1170, buy: 1160, sell: 1180 }
  ]);
  assert.deepEqual(merged, [{ code: 'USDT_TRC20', value: 1170, buy: 1160, sell: 1180 }]);
});

test('history snapshots feed the USDT_TRC20 series from stored USDTTRC20 observations', () => {
  const snapshots = [
    { capturedAt: '2026-11-24T17:25:02Z', rates: { USDTTRC20: 1165 } },
    { capturedAt: '2026-11-24T17:35:02Z', rates: { USDT_TRC20: 1168 } }
  ];
  assert.deepEqual(canonicalizeRateSnapshots(snapshots), [
    { capturedAt: '2026-11-24T17:25:02Z', rates: { USDT_TRC20: 1165 } },
    { capturedAt: '2026-11-24T17:35:02Z', rates: { USDT_TRC20: 1168 } }
  ]);
});
