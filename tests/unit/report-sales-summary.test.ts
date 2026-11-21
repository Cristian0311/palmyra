import assert from 'node:assert/strict';
import test from 'node:test';

import { filterReportTransactions, reportLineTotal, summarizeReportSales } from '../../src/modules/reports/utils/reportSalesSummary';

function item(overrides: Record<string, any> = {}) {
  return {
    id: 'line-1',
    product: { id: 'p1', name: 'Blusa', price: 1000, costPrice: 400, sku: 'BL-1', categoryId: 'c1' },
    quantity: 2,
    price: 1000,
    total: 2000,
    variantLabel: 'Talla M',
    ...overrides,
  } as any;
}

function ticket(overrides: Record<string, any> = {}) {
  return {
    id: 't1',
    branchId: 'w1',
    userId: 'u1',
    date: '2026-11-18T12:00:00.000Z',
    total: 2000,
    status: 'completed',
    notes: '',
    items: [item()],
    ...overrides,
  } as any;
}

test('summary uses the stored line total and the recorded purchase cost', () => {
  const summary = summarizeReportSales([ticket()]);
  assert.equal(summary.total, 2000);
  assert.equal(summary.units, 2);
  assert.equal(summary.tickets, 1);
  assert.equal(summary.cost, 800);
  assert.equal(summary.profit, 1200);
  assert.equal(Number(summary.margin.toFixed(1)), 60);
  assert.equal(summary.missingCostUnits, 0);
});

test('a discounted line keeps the recorded total, not price times quantity', () => {
  const discounted = ticket({ items: [item({ total: 1800 })] });
  assert.equal(reportLineTotal(discounted.items[0]), 1800);
  assert.equal(summarizeReportSales([discounted]).total, 2000);
  assert.equal(summarizeReportSales([discounted]).products[0].revenue, 1800);
});

test('products without a cost are flagged instead of reporting fake profit', () => {
  const noCost = ticket({ items: [item({ product: { id: 'p9', name: 'Sin costo', price: 500 } })] });
  const summary = summarizeReportSales([noCost]);
  assert.equal(summary.missingCostUnits, 2);
  assert.equal(summary.cost, 0);
  assert.equal(summary.profit, 2000, 'profit falls back to revenue, but the UI is warned');
});

test('the catalog cost is used when the sale snapshot has none', () => {
  const legacy = ticket({ items: [item({ product: 'p1' })] });
  const summary = summarizeReportSales([legacy], [{ id: 'p1', name: 'Blusa', price: 1000, costPrice: 250 } as any]);
  assert.equal(summary.cost, 500);
  assert.equal(summary.missingCostUnits, 0);
});

test('kit lines are costed by their components', () => {
  const kit = ticket({
    items: [item({
      product: { id: 'kit', name: 'Combo', isKit: true, kitComponents: [{ productId: 'c1', quantity: 2 }, { productId: 'c2', quantity: 1 }] },
    })],
  });
  const summary = summarizeReportSales([kit], [
    { id: 'c1', name: 'Camisa', costPrice: 100 } as any,
    { id: 'c2', name: 'Pañuelo', costPrice: 50 } as any,
  ]);
  assert.equal(summary.cost, 500, '(2 x 100 + 1 x 50) x 2 units');
});

test('variants are grouped separately and refunded or voided tickets are excluded', () => {
  const refunded = ticket({ id: 't2', status: 'refunded', total: 9999 });
  const voided = ticket({ id: 't3', deletedAt: '2026-11-18T13:00:00.000Z' });
  const adjustment = ticket({ id: 't4', notes: 'AJUSTE_AUDITORIA' });
  const otherVariant = ticket({ id: 't5', items: [item({ variantLabel: 'Talla L' })] });
  const summary = summarizeReportSales([ticket(), otherVariant, refunded, voided, adjustment]);
  assert.equal(summary.tickets, 2);
  assert.equal(summary.products.length, 2, 'each size is its own row');
  assert.deepEqual(summary.products.map(row => row.variant).sort(), ['Talla L', 'Talla M']);
});

test('report filters combine warehouse, worker and calendar day', () => {
  const rows = [
    ticket({ id: 'a', date: '2026-11-18T12:00:00.000Z' }),
    ticket({ id: 'b', branchId: 'w2', date: '2026-11-18T12:00:00.000Z' }),
    ticket({ id: 'c', date: '2026-11-17T12:00:00.000Z' }),
    ticket({ id: 'd', date: '2026-11-18T12:00:00.000Z', sellerEmployeeIds: ['emp-9'] }),
  ];
  assert.deepEqual(
    filterReportTransactions(rows, { branchId: 'w1', workerId: 'all', date: '2026-11-18', period: 'custom' }).map(row => row.id),
    ['a', 'd'],
  );
  assert.deepEqual(
    filterReportTransactions(rows, { branchId: 'all', workerId: 'emp-9', date: '', period: 'all' }).map(row => row.id),
    ['d'],
  );
});
