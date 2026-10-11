import assert from 'node:assert/strict';
import test from 'node:test';

import { generateItemsSoldDetailSheet } from '../../src/utils/excel/itemsSheet';
import { generateSummarySheet } from '../../src/utils/excel/summarySheet';
import { generateProductsPerformanceSheet } from '../../src/utils/excel/sheets/productsPerformanceSheet';

const baseCurrency = { code: 'CUP', symbol: '$', rateToBase: 1, isBase: true } as any;
const currencies = [
  baseCurrency,
  { code: 'USD', symbol: 'US$', rateToBase: 370, isBase: false },
] as any;

function validSale(overrides: Record<string, any> = {}) {
  return {
    id: 'ticket-1',
    branchId: 'warehouse-1',
    userId: 'employee-1',
    customerId: undefined,
    date: '2026-10-03T12:00:00.000Z',
    subtotal: 30000,
    tax: 0,
    discount: 0,
    total: 30000,
    payments: [
      { currencyCode: 'USD', method: 'cash', amount: 20, exchangeRate: 780 },
      { currencyCode: 'USD', method: 'cash', amount: 20, exchangeRate: 780 },
    ],
    changeGiven: 1200,
    items: [
      {
        id: 'line-1',
        product: {
          id: 'product-1',
          name: 'Producto prueba',
          price: 100,
          costPrice: 10,
          sku: 'SKU-1',
          barcode: '123',
          categoryId: 'category-1',
        },
        quantity: 2,
        price: 100,
        total: 180,
      },
    ],
    status: 'completed',
    notes: '',
    ...overrides,
  } as any;
}

function exportData(transactions: any[]) {
  return {
    businessName: 'MARE',
    transactions,
    cashSessions: [],
    salarySettlements: [],
    products: [{
      id: 'product-1',
      name: 'Producto prueba',
      price: 100,
      costPrice: 10,
      sku: 'SKU-1',
      barcode: '123',
      categoryId: 'category-1',
      category: 'General',
      commissionValue: 5,
      status: 'active',
    }] as any,
    categories: [{ id: 'category-1', name: 'General' }] as any,
    currencies,
    branches: [{ id: 'warehouse-1', name: 'Almacén Principal' }] as any,
    users: [{ id: 'employee-1', name: 'Empleado' }] as any,
    customers: [],
    bankTransactions: [],
    bankCards: [],
    inventory: [],
    transfers: [],
    baseCurrency,
    dateFilterLabel: 'Todo el historial',
  } as any;
}

test('Excel detail uses the stored line total instead of recalculating price times quantity', () => {
  const sale = validSale();
  const rows = generateItemsSoldDetailSheet(exportData([sale]));
  assert.equal(rows[1][11], 2, 'quantity should be preserved');
  assert.equal(rows[1][12], 100, 'effective unit price should be preserved');
  assert.equal(rows[1][14], 180, 'stored discounted line total should be used');
  assert.equal(rows[1][16], 160, 'gross profit should use recorded line total minus cost');
  assert.equal(rows[1][20], 30000, 'invoice total should be visible alongside the detail');
  assert.equal(rows[1][21], 29820, 'the invoice-to-detail mismatch should be explicit');
});

test('Excel product performance uses recorded revenue and excludes refunded tickets', () => {
  const sale = validSale();
  const refunded = validSale({
    id: 'ticket-refunded',
    status: 'refunded',
    total: 9999,
    items: [{
      id: 'line-refunded',
      product: {
        id: 'product-1',
        name: 'Producto prueba',
        price: 100,
        costPrice: 10,
        sku: 'SKU-1',
        barcode: '123',
        categoryId: 'category-1',
      },
      quantity: 5,
      price: 100,
      total: 500,
    }],
  });
  const rows = generateProductsPerformanceSheet(exportData([sale, refunded]));
  const productRow = rows[1];
  assert.equal(productRow[12], 2, 'only completed units should count');
  assert.equal(productRow[13], 180, 'actual recorded line revenue should count');
  assert.equal(productRow[14], 160, 'gross profit should use actual revenue less acquisition cost');
});

test('Excel summary counts valid tickets and reconciles multi-payment cash and historical change', () => {
  const sale = validSale();
  const refunded = validSale({
    id: 'ticket-refunded',
    status: 'refunded',
    total: 9000,
    payments: [{ currencyCode: 'CUP', method: 'cash', amount: 9000, exchangeRate: 1 }],
  });
  const rows = generateSummarySheet(exportData([sale, refunded]));

  assert.equal(rows[6][2], 30000, 'total sales should exclude refunded tickets');
  assert.equal(rows[6][3], '1 ventas completadas registradas');
  assert.equal(rows[7][2], 30000, 'average ticket should use same valid-ticket denominator');

  const usdRow = rows.find(row => row[0] === 'USD');
  const cupRow = rows.find(row => row[0] === 'CUP');
  assert.ok(usdRow, 'USD payment details should be present');
  assert.ok(cupRow, 'CUP base-currency change should be shown');
  assert.equal(usdRow[3], 40, 'all cash payment rows must be summed');
  assert.equal(usdRow[6], 31200, 'saved sale-time rate must be used, not current USD rate');
  assert.equal(cupRow[3], -1200, 'legacy change given should reduce base-currency cash');
  assert.equal(cupRow[6], -1200, 'base-currency change should be netted from equivalent-base amounts');
  assert.equal(usdRow[6] + cupRow[6], 30000, 'net payment equivalent should reconcile to invoice total');
});
