import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { calculateExpectedSessionBalances } from '../../src/modules/pos/utils/cashMath';
import { calculatePerfectSessionBalances } from '../../src/modules/reports/utils/reportSessionCalculations';
import { getLocalDateYMD } from '../../src/hooks/useReportsAnalytics';
import { getCartLineSubtotal, getCartLineUnitPrice } from '../../src/modules/pos/utils/checkoutUtils';

const currencies = [
  { code: 'CUP', name: 'Peso cubano', symbol: 'CUP', rateToBase: 1, isBase: true },
  { code: 'USD', name: 'Dólar', symbol: 'USD', rateToBase: 300, isBase: false },
] as any;

test('Cuadre Perfecto includes cash, transfer payments, change and movements separately', () => {
  const session = {
    id: 'session-1',
    branchId: 'warehouse-1',
    openedAt: '2026-10-15T10:00:00.000Z',
    openingBalance: 100,
    status: 'open',
    userId: 'employee-1',
    movements: [
      { id: 'movement-1', type: 'expense', amount: 10, currencyCode: 'CUP' },
      { id: 'movement-2', type: 'income', amount: 4, currencyCode: 'USD' },
    ],
  } as any;
  const transactions = [{
    id: 'sale-1',
    sessionId: 'session-1',
    status: 'completed',
    deletedAt: undefined,
    notes: '',
    payments: [
      { currencyCode: 'CUP', amount: 500, exchangeRate: 1, method: 'cash' },
      { currencyCode: 'CUP', amount: 300, exchangeRate: 1, method: 'transfer' },
      { currencyCode: 'USD', amount: 10, exchangeRate: 300, method: 'cash' },
    ],
    changeGiven: 50,
  }] as any;

  const balances = calculateExpectedSessionBalances(session, transactions, 'warehouse-1', currencies[0], currencies);
  const amount = (code: string, method: string) => balances.find(row => row.currencyCode === code && row.method === method)?.amount ?? 0;

  assert.equal(amount('CUP', 'cash'), 540, 'opening + cash sale - change - expense');
  assert.equal(amount('CUP', 'transfer'), 300, 'bank transfers must be included in closing count');
  assert.equal(amount('USD', 'cash'), 14, 'foreign cash sale + cash income movement');
});

test('checkout total uses the cart line price snapshot when the product catalog is stale', () => {
  const item = {
    id: 'line-1',
    product: { id: 'product-1', name: 'Artículo', price: 1250 },
    price: 900,
    quantity: 2,
    total: 1800,
  } as any;

  assert.equal(getCartLineUnitPrice(item), 900);
  assert.equal(getCartLineSubtotal(item), 1800, 'checkout subtotal must use the same line total that is persisted');
  assert.equal(getCartLineSubtotal({ ...item, total: Number.NaN }), 1800, 'fallback to captured unit price × quantity when stored line total is invalid');
  assert.equal(getCartLineSubtotal({ ...item, total: 0 }), 0, 'a valid zero line total must not fall back to the catalog price');
  assert.equal(getCartLineUnitPrice({ ...item, price: Number.NaN }), 1250, 'fallback to catalog price only when the line price is invalid');
});

test('production entry points are served with no-store headers to reduce stale application shells', () => {
  const server = readFileSync('server.ts', 'utf8');
  assert.match(server, /\['index\.html', 'version\.json', 'sw\.js', 'registerSW\.js', 'manifest\.webmanifest'\]/);
  assert.match(server, /Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'/);
  const main = readFileSync('src/main.tsx', 'utf8');
  assert.match(main, /addEventListener\('online', checkForFreshWorker\)/);
});


test('historical bank_transfer methods normalize to transfer in reports and audit balances', () => {
  const balances = calculatePerfectSessionBalances({
    id: 'closed-session', branchId: 'warehouse-1', openedAt: '2026-10-15T10:00:00.000Z',
    openingBalance: 20, status: 'closed', userId: 'employee-1', movements: [],
  } as any, { baseCurrencyCode: 'CUP', currencies, transactions: [{
    id: 'sale-old-schema', sessionId: 'closed-session', branchId: 'warehouse-1', date: '2026-10-15T11:00:00.000Z',
    payments: [{ currencyCode: 'CUP', amount: 75, exchangeRate: 1, method: 'bank_transfer' }],
    items: [], total: 75, status: 'completed',
  } as any] });
  assert.equal(balances.find(row => row.currencyCode === 'CUP' && row.method === 'transfer')?.amount, 75);
});

test('report day filters are tied to Cuba time and not the device timezone', () => {
  assert.equal(getLocalDateYMD('2026-10-15T02:30:00.000Z'), '2026-10-14');
});


test('full synchronization does not silently cap sales, inventory transfers, or bank history', () => {
  const pull = readFileSync('src/services/supabaseSync/pull.ts', 'utf8');
  assert.match(pull, /loadSales\(undefined,0\)/, 'full snapshots must request all sale pages');
  assert.match(pull, /from\('transfers'\)[\s\S]*?\.range\(from,from\+pageSize-1\)/, 'transfer parents should be paginated rather than capped at 500');
  assert.match(pull, /from\('bank_transactions'\)[\s\S]*?\.range\(from,from\+pageSize-1\)/, 'bank ledger should be paginated rather than capped at 1,000');
  assert.match(pull, /from\('sale_items'\)[\s\S]*?\.range\(from,from\+499\)/, 'sale item rows should be paginated');
});
