import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateTransferStock,
  setCanonicalInventoryQuantity,
} from '../../src/store/utils/inventoryTransforms';
import {
  getSafeRateToBase,
  toBaseAmount,
  roundBaseAmount,
  formatMoney,
} from '../../src/modules/pos/utils/paymentMath';
import { calculateExpectedCashBase } from '../../src/services/cash/expectedCash';
import { buildSessionTurnMap } from '../../src/modules/reports/useReportsSessions';

test('inventory transfer validation aggregates duplicate requirements', () => {
  const inventory = [{
    productId: 'p1',
    branchId: 'w1',
    quantity: 5,
    minQuantity: 0,
  }];

  assert.equal(validateTransferStock(inventory, [
    { productId: 'p1', branchId: 'w1', quantity: 2 },
    { productId: 'p1', branchId: 'w1', quantity: 3 },
  ]).ok, true);

  const insufficient = validateTransferStock(inventory, [
    { productId: 'p1', branchId: 'w1', quantity: 4 },
    { productId: 'p1', branchId: 'w1', quantity: 2 },
  ]);

  assert.equal(insufficient.ok, false);
  assert.match(insufficient.message || '', /Stock insuficiente/);
});

test('canonical inventory update only changes the requested warehouse/variant', () => {
  const inventory = [
    { productId: 'p1', branchId: 'w1', variantLabel: '', quantity: 4, minQuantity: 0 },
    { productId: 'p1', branchId: 'w2', variantLabel: '', quantity: 8, minQuantity: 0 },
    { productId: 'p1', branchId: 'w1', variantLabel: 'M', quantity: 7, minQuantity: 0 },
  ];

  const updated = setCanonicalInventoryQuantity(inventory, 'p1', 'w1', '', 10);

  assert.equal(updated[0].quantity, 10);
  assert.equal(updated[1].quantity, 8);
  assert.equal(updated[2].quantity, 7);
});

test('POS payment math uses configured exchange rates and safe rounding', () => {
  const currencies = [
    { code: 'CUP', name: 'Peso', symbol: 'CUP', rateToBase: 1, isBase: true },
    { code: 'USD', name: 'Dólar', symbol: 'USD', rateToBase: 300, isBase: false },
  ] as const;
  const base = currencies[0];

  assert.equal(getSafeRateToBase('CUP', base, currencies as any), 1);
  assert.equal(getSafeRateToBase('USD', base, currencies as any), 300);
  assert.equal(toBaseAmount(10, 'USD', base, currencies as any), 3000);
  assert.equal(roundBaseAmount(12.6, true), 13);
  assert.equal(roundBaseAmount(12.345, false), 12.35);
  assert.equal(formatMoney(1250, 'CUP'), 'CUP 1,250');
});

test('expected cash is calculated in base currency without counting transfers', () => {
  const session = {
    id: 's1',
    branchId: 'w1',
    openedAt: '2026-10-05T00:00:00.000Z',
    openingBalance: 1000,
    status: 'open',
    userId: 'u1',
    movements: [
      {
        id: 'm1',
        type: 'income',
        amount: 50,
        currencyCode: 'USD',
        description: 'Entrada',
        date: '2026-10-05T01:00:00.000Z',
      },
      {
        id: 'm2',
        type: 'expense',
        amount: 100,
        currencyCode: 'CUP',
        description: 'Salida',
        date: '2026-10-05T01:30:00.000Z',
      },
    ],
  } as any;

  const transactions = [
    {
      id: 't1',
      branchId: 'w1',
      userId: 'u1',
      date: '2026-10-05T02:00:00.000Z',
      total: 1800,
      status: 'completed',
      items: [],
      payments: [
        { currencyCode: 'CUP', amount: 1000, exchangeRate: 1, method: 'cash' },
        { currencyCode: 'USD', amount: 5, exchangeRate: 300, method: 'transfer' },
      ],
      changeGiven: 100,
    },
  ] as any;

  const currencies = [
    { code: 'CUP', name: 'Peso', symbol: 'CUP', rateToBase: 1, isBase: true },
    { code: 'USD', name: 'Dólar', symbol: 'USD', rateToBase: 300, isBase: false },
  ] as any;

  // 1000 opening + 1000 cash payment - 100 change + 15000 income - 100 expense.
  assert.equal(calculateExpectedCashBase(session, transactions, currencies), 16800);
});


test('reports preserve persisted turn numbers after a lower turn disappears', () => {
  const sessions = [
    { id: 's3', turnNumber: 3, status: 'closed', branchId: 'w1', openedAt: '2026-10-03T10:00:00Z', userId: 'u1', openingBalance: 0 } as any,
    { id: 's12', turnNumber: 12, status: 'closed', branchId: 'w1', openedAt: '2026-10-12T10:00:00Z', userId: 'u1', openingBalance: 0 } as any,
  ];
  const map = buildSessionTurnMap(sessions);
  assert.equal(map.get('s3'), 'Turno-3');
  assert.equal(map.get('s12'), 'Turno-12');
});
