import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_RATE_MAX_THRESHOLD,
  AUTO_RATE_MIN_THRESHOLD,
  collectCupRates,
  decideAutoRate,
  normalizeAutoRateThreshold,
  rateToBaseFromCup
} from '../../src/lib/autoRatePolicy';

const data = { tasas: { USD: 400, ECU: 450, MLC: 220 } };

test('threshold defaults to 5 CUP and clamps invalid input', () => {
  assert.equal(normalizeAutoRateThreshold(undefined), 5);
  assert.equal(normalizeAutoRateThreshold(''), 5);
  assert.equal(normalizeAutoRateThreshold(0), 5);
  assert.equal(normalizeAutoRateThreshold(-3), 5);
  assert.equal(normalizeAutoRateThreshold(4.6), 5);
  assert.equal(normalizeAutoRateThreshold(0.2), AUTO_RATE_MIN_THRESHOLD);
  assert.equal(normalizeAutoRateThreshold(9999), AUTO_RATE_MAX_THRESHOLD);
});

test('rates apply only when the movimiento reaches the 5 CUP margin', () => {
  assert.equal(decideAutoRate(400, 405, 5)?.apply, true);
  assert.equal(decideAutoRate(400, 395, 5)?.apply, true);
  assert.equal(decideAutoRate(400, 404.99, 5)?.apply, false);
  assert.equal(decideAutoRate(400, 396, 5)?.apply, false);
  assert.deepEqual(decideAutoRate(400, 401, 5), { from: 400, to: 401, delta: 1, apply: false });
});

test('first observation is applied so a new device starts with a real rate', () => {
  assert.deepEqual(decideAutoRate(null, 400, 5), { from: 0, to: 400, delta: 400, apply: true });
  assert.equal(decideAutoRate(400, undefined, 5), null);
  assert.equal(decideAutoRate(400, 0, 5), null);
});

test('elTOQUE values are converted with ECU alias and cross-rates for non-CUP bases', () => {
  const rates = collectCupRates(data);
  assert.deepEqual(rates, { USD: 400, ECU: 450, MLC: 220 });
  assert.equal(rateToBaseFromCup(rates, 'USD', 'CUP'), 400);
  assert.equal(rateToBaseFromCup(rates, 'EUR', 'CUP'), 450);
  assert.equal(rateToBaseFromCup(rates, 'USD', 'MLC'), 1.82);
  assert.equal(rateToBaseFromCup(rates, 'CUP', 'CUP'), undefined);
  assert.equal(rateToBaseFromCup({ USD: 400 }, 'USD', 'EUR'), undefined);
});
