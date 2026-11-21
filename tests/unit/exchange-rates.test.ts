import assert from 'node:assert/strict';
import test from 'node:test';
import { appendRateSnapshot, isElToquePayload, parseExchangeRates, readRateSnapshots } from '../../src/lib/exchangeRates';
import { createExchangeRateProvider } from '../../src/services/exchangeRateProvider';

const data = { tasas: { USD: 400, ECU: 450, MLC: 220 }, date: '2026-11-18' };

test('rates preserve only quoted codes and do not manufacture buy/sell or rename ECU', () => {
  assert.deepEqual(parseExchangeRates(data), [
    { code: 'USD', value: 400, buy: undefined, sell: undefined },
    { code: 'ECU', value: 450, buy: undefined, sell: undefined },
    { code: 'MLC', value: 220, buy: undefined, sell: undefined }
  ]);
  assert.deepEqual(parseExchangeRates({ rates: { USD: 0, BTC: -1, ETH: false, count: 123, timestamp: 456 } }), []);
  assert.equal(parseExchangeRates({ rates: [{ code: 'USDT', compra: '430,5', venta: 440 }] })[0].value, undefined);
});

test('unrelated provider and unprovenanced legacy payloads are not elTOQUE cache', () => {
  assert.equal(isElToquePayload({ provider: 'official', source: 'currency-api', data }), false);
  assert.equal(isElToquePayload({ source: 'elTOQUE API', capturedAt: new Date().toISOString(), data }), false);
});

test('missing token performs no external request and reports configuration accurately', async () => {
  const provider = createExchangeRateProvider((async () => { throw new Error('must not fetch'); }) as typeof fetch);
  const result = await provider('');
  assert.equal(result.status, 503);
  assert.equal('configured' in result.body && result.body.configured, false);
});

test('provider deduplicates requests, preserves payload and does not round rates', async () => {
  let calls = 0;
  const provider = createExchangeRateProvider((async (url, init) => {
    calls++;
    assert.equal(url, 'https://tasas.eltoque.com/v1/trmi');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    return Response.json(data);
  }) as typeof fetch, () => Date.parse('2026-11-18T12:00:00Z'));
  const [a, b] = await Promise.all([provider('test-token'), provider('test-token')]);
  await provider('test-token');
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.ok(isElToquePayload(a.body));
  assert.deepEqual(a.body.data, data);
});

test('expired cache survives failure without changing timestamp or leaking provider text', async () => {
  let now = Date.parse('2026-11-18T12:00:00Z');
  let calls = 0;
  const provider = createExchangeRateProvider((async () => ++calls === 1 ? Response.json(data) : Response.json({ error: 'secret-token-text' }, { status: 401 })) as typeof fetch, () => now);
  const a = await provider('test');
  now += 360000;
  const b = await provider('test');
  assert.ok(isElToquePayload(a.body) && isElToquePayload(b.body));
  assert.equal(b.body.stale, true);
  assert.equal(a.body.capturedAt, b.body.capturedAt);
  assert.doesNotMatch(JSON.stringify(b), /secret-token-text/);
  assert.deepEqual(appendRateSnapshot([], b.body), []);
});

test('invalid JSON, empty rates and network failure never produce synthetic rates', async () => {
  for (const mock of [async () => Response.json({}), async () => new Response('bad'), async () => { throw new Error('offline'); }]) {
    const result = await createExchangeRateProvider(mock as typeof fetch)('test');
    assert.equal(result.status, 502);
    assert.equal('data' in result.body, false);
  }
});

test('local history ignores malformed points and deduplicates observation timestamp', () => {
  assert.deepEqual(readRateSnapshots([{ capturedAt: 'wrong', rates: { USD: 400 } }]), []);
  const payload = { provider: 'eltoque', source: 'elTOQUE API', market: 'informal', capturedAt: '2026-11-18T12:00:00Z', data } as const;
  const history = appendRateSnapshot([], payload);
  assert.equal(appendRateSnapshot(history, payload).length, 1);
  assert.deepEqual(history[0].rates, { USD: 400, ECU: 450, MLC: 220 });
});
