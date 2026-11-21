import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalCompletedSalePatch } from '../../src/store/utils/localCompletedSale';
import { purgeCancelledShift } from '../../src/store/utils/purgeCancelledShift';

function inventory(productId: string, quantity: number, variantLabel = '') {
  return { productId, branchId: 'w1', variantLabel, quantity, minQuantity: 0 } as any;
}

function sale(overrides: Record<string, any> = {}) {
  return {
    id: 'sale-1',
    branchId: 'w1',
    sessionId: 'session-1',
    userId: 'user-1',
    customerId: 'c1',
    date: '2026-11-20T10:00:00.000Z',
    total: 2000,
    status: 'completed',
    notes: '',
    payments: [],
    items: [{
      id: 'line-1',
      product: { id: 'p1', name: 'Blusa', price: 1000, isKit: false },
      quantity: 2,
      price: 1000,
      total: 2000,
    }],
    ...overrides,
  } as any;
}

function baseState(overrides: Record<string, any> = {}) {
  return {
    transactions: [],
    inventory: [inventory('p1', 10)],
    warranties: [],
    customers: [{ id: 'c1', name: 'Ana' }],
    ...overrides,
  } as any;
}

test('una venta descuenta el stock exactamente una vez', () => {
  const patch = buildLocalCompletedSalePatch(baseState(), sale());
  assert.equal(patch.inventory[0].quantity, 8);
});

test('registrar la misma venta dos veces no vuelve a descontar stock', () => {
  const first = buildLocalCompletedSalePatch(baseState(), sale());
  const second = buildLocalCompletedSalePatch({ ...baseState(), transactions: first.transactions, inventory: first.inventory }, sale());
  assert.equal(second.inventory.find((i: any) => i.productId === 'p1').quantity, 8);
});

test('el stock no baja de cero aunque se venda de más', () => {
  const patch = buildLocalCompletedSalePatch(baseState({ inventory: [inventory('p1', 1)] }), sale());
  assert.equal(patch.inventory[0].quantity, 0);
});

test('un kit descuenta sus componentes, no el producto del kit', () => {
  const kitSale = sale({
    items: [{
      id: 'line-kit',
      product: {
        id: 'kit-1',
        name: 'Combo',
        price: 2000,
        isKit: true,
        kitComponents: [
          { productId: 'comp-a', quantity: 2 },
          { productId: 'comp-b', quantity: 1 },
        ],
      },
      quantity: 3,
      price: 2000,
      total: 6000,
    }],
  });
  const patch = buildLocalCompletedSalePatch(
    baseState({ inventory: [inventory('kit-1', 5), inventory('comp-a', 10), inventory('comp-b', 10)] }),
    kitSale,
  );
  assert.equal(patch.inventory.find((i: any) => i.productId === 'kit-1').quantity, 5);
  assert.equal(patch.inventory.find((i: any) => i.productId === 'comp-a').quantity, 4);
  assert.equal(patch.inventory.find((i: any) => i.productId === 'comp-b').quantity, 7);
});

test('la variante correcta es la que se descuenta', () => {
  const variantSale = sale({
    items: [{
      id: 'line-1',
      product: { id: 'p1', name: 'Blusa', price: 1000 },
      quantity: 1,
      price: 1000,
      total: 1000,
      variantLabel: 'Talla M',
    }],
  });
  const patch = buildLocalCompletedSalePatch(
    baseState({ inventory: [inventory('p1', 10, 'Talla M'), inventory('p1', 6, 'Talla S')] }),
    variantSale,
  );
  assert.equal(patch.inventory.find((i: any) => i.variantLabel === 'Talla M').quantity, 9);
  assert.equal(patch.inventory.find((i: any) => i.variantLabel === 'Talla S').quantity, 6);
});

test('cancelar un turno borra el turno, sus ventas y su liquidación sin dejar rastro', () => {
  const state = {
    transactions: [
      sale({ id: 'sale-1', sessionId: 'session-1' }),
      sale({ id: 'sale-2', sessionId: 'session-1' }),
      sale({ id: 'sale-3', sessionId: 'session-2' }),
    ],
    cashSessions: [
      { id: 'session-1', status: 'open' },
      { id: 'session-2', status: 'open' },
    ],
    salarySettlements: [
      { id: 'pay-1', sessionId: 'session-1' },
      { id: 'pay-2', sessionId: 'session-2' },
    ],
  } as any;

  const purged = purgeCancelledShift(state, 'session-1', ['sale-1', 'sale-2']);

  assert.deepEqual(purged.transactions.map(tx => tx.id), ['sale-3']);
  assert.deepEqual(purged.cashSessions.map(s => s.id), ['session-2']);
  assert.deepEqual(purged.salarySettlements.map(s => s.id), ['pay-2']);
  assert.ok(purged.transactions.every(tx => tx.status !== 'cancelled'));
});
