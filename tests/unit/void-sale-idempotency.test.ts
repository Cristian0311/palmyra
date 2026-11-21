import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildLocalVoidTransactionPatch,
  buildLocalVoidTransactionsPatch,
  canVoidSales,
  getRemainingVoidItems,
} from '../../src/store/utils/localVoidTransaction';
import { collectPendingInventoryKeys } from '../../src/store/utils/offlineProtection';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const audit = { userId: 'user-1', reason: 'Anulación de venta desde Reportes', date: '2026-11-18T12:00:00.000Z' };

function sale(overrides: Record<string, any> = {}) {
  return {
    id: 'ticket-1',
    remoteId: '11111111-1111-4111-8111-111111111111',
    branchId: 'w1',
    userId: 'user-1',
    date: '2026-11-18T10:00:00.000Z',
    total: 2000,
    status: 'completed',
    notes: '',
    payments: [],
    items: [{
      id: 'line-1',
      product: { id: 'p1', name: 'Blusa', price: 1000, costPrice: 400, isKit: false },
      quantity: 2,
      price: 1000,
      total: 2000,
      variantLabel: 'Talla M',
    }],
    ...overrides,
  } as any;
}

function state(overrides: Record<string, any> = {}) {
  return {
    transactions: [sale()],
    inventory: [{ productId: 'p1', branchId: 'w1', variantLabel: 'Talla M', quantity: 8, minQuantity: 0 }],
    bankTransactions: [],
    bankCards: [],
    returns: [],
    ...overrides,
  } as any;
}

test('voiding a two-unit sale restores exactly +2 and a replay restores nothing', () => {
  const first = buildLocalVoidTransactionPatch(state(), state().transactions[0], audit);
  assert.equal(first.inventory[0].quantity, 10, '2 blouses must come back exactly once');
  assert.equal(first.transactions[0].deletedAt, audit.date);
  assert.equal(first.transactions[0].deleteReason, audit.reason);

  // Replay against the already voided state (reload, retry, double click).
  const second = buildLocalVoidTransactionPatch(
    { ...state(), ...first },
    first.transactions[0],
    audit,
  );
  assert.equal(second.inventory[0].quantity, 10, 'a replay must never add stock again');
  assert.equal(second.transactions, first.transactions, 'the tombstone is kept untouched');
});

test('void restores the exact variant row and creates it when missing', () => {
  const tx = sale({
    items: [
      { id: 'a', product: { id: 'p1', name: 'Blusa' }, quantity: 1, price: 1000, total: 1000, variantLabel: 'Talla M' },
      { id: 'b', product: { id: 'p1', name: 'Blusa' }, quantity: 1, price: 1000, total: 1000, variantLabel: 'Talla L' },
    ],
  });
  const patch = buildLocalVoidTransactionPatch(
    state({ transactions: [tx], inventory: [{ productId: 'p1', branchId: 'w1', variantLabel: 'Talla M', quantity: 3, minQuantity: 0 }] }),
    tx,
    audit,
  );
  const m = patch.inventory.find((row: any) => row.variantLabel === 'Talla M');
  const l = patch.inventory.find((row: any) => row.variantLabel === 'Talla L');
  assert.equal(m.quantity, 4);
  assert.equal(l.quantity, 1, 'missing variant rows are created instead of mixing variants');
});

test('units already credited by a completed return are not restored twice', () => {
  const tx = sale({
    items: [{ id: 'a', product: { id: 'p1', name: 'Blusa' }, quantity: 3, price: 1000, total: 3000, variantLabel: 'Talla M' }],
  });
  const returns = [{
    id: 'r1', transactionId: tx.id, productId: 'p1', quantity: 2, status: 'completed',
    type: 'refund', reason: 'defective', date: '2026-11-18T11:00:00.000Z', variantLabel: 'Talla M',
  }];
  assert.equal(getRemainingVoidItems(tx, returns as any)[0].quantity, 1, 'only the unreturned unit remains');
  const patch = buildLocalVoidTransactionPatch(
    state({ transactions: [tx], returns, inventory: [{ productId: 'p1', branchId: 'w1', variantLabel: 'Talla M', quantity: 5, minQuantity: 0 }] }),
    tx,
    audit,
  );
  assert.equal(patch.inventory[0].quantity, 6, '3 sold - 2 already returned = +1');
});

test('a completed return of the whole sale means voiding adds no stock', () => {
  const tx = sale();
  const returns = [{
    id: 'r1', transactionId: tx.id, productId: 'p1', quantity: 2, status: 'completed',
    type: 'refund', reason: 'defective', date: '2026-11-18T11:00:00.000Z', variantLabel: 'Talla M',
  }];
  const patch = buildLocalVoidTransactionPatch(state({ transactions: [tx], returns }), tx, audit);
  assert.equal(patch.inventory[0].quantity, 8, 'fully returned sale keeps stock unchanged');
});

test('kit sales restore their components instead of the bundle row', () => {
  const tx = sale({
    items: [{
      id: 'a', quantity: 1, price: 3000, total: 3000,
      product: { id: 'kit-1', name: 'Combo', isKit: true, kitComponents: [{ productId: 'c1', quantity: 2 }] },
    }],
  });
  const patch = buildLocalVoidTransactionPatch(
    state({ transactions: [tx], inventory: [{ productId: 'c1', branchId: 'w1', quantity: 4, minQuantity: 0 }] }),
    tx,
    audit,
  );
  assert.equal(patch.inventory[0].quantity, 6);
  assert.ok(!patch.inventory.some((row: any) => row.productId === 'kit-1'), 'bundles are not stocked');
});

test('bank receipts are reversed once by a deterministic withdrawal', () => {
  const tx = sale({
    payments: [{ currencyCode: 'USD', amount: 20, exchangeRate: 1, method: 'transfer', bankCardId: 'card-1' }],
    total: 2000,
  });
  const initial = state({
    transactions: [tx],
    bankCards: [{ id: 'card-1', name: 'Banco', balance: 1000 }],
    bankTransactions: [{ id: 'bt-1', cardId: 'card-1', type: 'payment_received', amount: 500, date: '2026-11-18T10:00:00.000Z', transactionId: tx.id }],
  });
  const first = buildLocalVoidTransactionPatch(initial, tx, audit);
  assert.equal(first.bankCards[0].balance, 500);
  assert.equal(first.bankTransactions.filter((row: any) => row.type === 'withdrawal').length, 1);
  assert.equal(first.bankTransactions[0].id, 'bt-1', 'the original receipt is preserved for audit');

  const second = buildLocalVoidTransactionPatch({ ...initial, ...first }, first.transactions[0], audit);
  assert.equal(second.bankCards[0].balance, 500, 'replay must not withdraw again');
  assert.equal(second.bankTransactions.filter((row: any) => row.type === 'withdrawal').length, 1);
});

test('an unaffordable bank reversal aborts the void without partial changes', () => {
  const tx = sale({
    payments: [{ currencyCode: 'USD', amount: 20, exchangeRate: 1, method: 'transfer', bankCardId: 'card-1' }],
  });
  const initial = state({
    transactions: [tx],
    bankCards: [{ id: 'card-1', name: 'Banco', balance: 100 }],
    bankTransactions: [{ id: 'bt-1', cardId: 'card-1', type: 'payment_received', amount: 500, date: '2026-11-18T10:00:00.000Z', transactionId: tx.id }],
  });
  assert.throws(() => buildLocalVoidTransactionPatch(initial, tx, audit), /Saldo bancario insuficiente/);
  assert.equal(initial.inventory[0].quantity, 8, 'nothing is mutated in place');
  assert.equal(tx.deletedAt, undefined);
});

test('batch void (cancelling a shift) skips sales already voided', () => {
  const openSale = sale({ id: 'ticket-2', remoteId: '22222222-2222-4222-8222-222222222222' });
  const voidedSale = sale({ id: 'ticket-3', remoteId: '33333333-3333-4333-8333-333333333333', deletedAt: '2026-11-18T09:00:00.000Z' });
  const initial = state({
    transactions: [openSale, voidedSale],
    inventory: [{ productId: 'p1', branchId: 'w1', variantLabel: 'Talla M', quantity: 8, minQuantity: 0 }],
  });
  const patch = buildLocalVoidTransactionsPatch(initial, [openSale, voidedSale], audit);
  assert.equal(patch.inventory[0].quantity, 10, 'only the open sale returns its 2 units');
  assert.ok(patch.transactions.every((row: any) => row.id === 'ticket-3' || row.deletedAt));

  const replay = buildLocalVoidTransactionsPatch({ ...initial, ...patch }, [openSale, voidedSale], audit);
  assert.equal(replay.inventory[0].quantity, 10, 'replaying the whole shift stays idempotent');
});

test('void permission requires sales.refund inside the sale warehouse', () => {
  const cashier = { id: 'u', role: 'employee', isActive: true, permissions: ['sales.refund'], warehouseId: 'w1', allowedWarehouseIds: ['w1'] } as any;
  assert.equal(canVoidSales(cashier, 'w1'), true);
  assert.equal(canVoidSales(cashier, 'w2'), false, 'another warehouse is out of scope');
  const noPermission = { ...cashier, permissions: ['sales.create'] };
  assert.equal(canVoidSales(noPermission, 'w1'), false);
  assert.equal(canVoidSales({ ...cashier, role: 'admin' }, 'w2'), true);
  assert.equal(canVoidSales({ ...cashier, isActive: false }, 'w1'), false);
});

test('the client serializes voids per sale and treats a tombstone as done', () => {
  const action = source('src/store/utils/voidTransactionAction.ts');
  assert.match(action, /const inFlight = new Map<string, Promise<boolean>>\(\)/);
  assert.match(action, /if \(inFlight\.has\(id\)\) return inFlight\.get\(id\)!/);
  assert.match(action, /if \(tx\.deletedAt\) return true;/);
  assert.match(action, /deps\.set\(current => buildLocalVoidTransactionPatch\(current, tx, audit\)\)/);

  const posActions = source('src/store/actions/posActions.ts');
  assert.match(posActions, /deleteTransaction: createVoidTransactionAction\(/);
  assert.match(posActions, /buildLocalVoidTransactionsPatch\(state, sales, audit\)/);
  assert.match(posActions, /purgeCancelledShift\(state, sessionId, sales\.map\(sale => sale\.id\)\)/);
  assert.match(posActions, /Array\.isArray\(res\.data\?\.voided_sale_ids\)/);
});

test('the server migration restores only unreturned units and reports the voided sales', () => {
  const sql = source('supabase/migrations/20261118150000_idempotent_sale_and_shift_void.sql');
  assert.match(sql, /if v_sale\.status in \('voided', 'refunded'\) then/);
  assert.match(sql, /and r\.status = 'completed'/);
  assert.match(sql, /v_net := coalesce\(it\.quantity, 0\) - coalesce\(v_returned, 0\)/);
  assert.match(sql, /continue when v_net <= 0/);
  assert.match(sql, /'voided_sale_ids', v_voided/);
  assert.match(sql, /perform public\.palmyra_void_sale\(v_sale_id, p_company_id, v_reason\)/);
});

test('the offline outbox protects the restored stock while a void is pending', () => {
  const processor = source('src/services/offline/processQueueItem.ts');
  assert.match(processor, /case 'void_transaction'/);
  assert.match(processor, /\['voided','refunded'\]\.includes\(persistedVoid\.status\)/);

  const pending = collectPendingInventoryKeys(
    [{ type: 'void_transaction', data: { id: 'ticket-1', remoteId: 'remote-1' } } as any],
    { transactions: [sale()] },
  );
  assert.ok(pending.has('p1_w1_Talla M'), 'the sold variant stays protected until the void replays');
});
