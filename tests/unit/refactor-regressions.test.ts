import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInventoryCsv } from '../../src/modules/inventory/utils/buildInventoryCsv';
import { buildDetailedMovements, calculatePerfectSessionBalances } from '../../src/modules/reports/utils/reportSessionCalculations';
import {
  buildCashMovementReceiptLines,
  buildDiscrepancyReceiptLines,
  buildShiftReceiptLines,
  buildTransferReceiptLines,
} from '../../src/modules/reports/utils/reportReceiptLines';
import { getClosureReceiptLines } from '../../src/modules/pos/utils/getClosureReceiptLines';
import { aggregateTransferPayments, buildTransactionTicketId, finalizeCheckoutPayments } from '../../src/modules/pos/utils/checkoutUtils';

const formatMoney = (amount: number, code = 'CUP') => `${code} ${amount.toFixed(2)}`;
const format58mmLine = (label: string, value: string | number) => `${label} ${value}`;

test('inventory CSV escapes commas, quotes and newlines', () => {
  const csv = buildInventoryCsv([
    {
      id: 'p1',
      name: 'Producto, "especial"',
      sku: 'SKU-1',
      barcode: '123',
      categoryId: 'c1',
      costPrice: 10,
      price: 20,
      totalStock: 3,
      unit: 'uds',
      status: 'active',
    },
  ], [{ id: 'c1', name: 'Higiene, "premium"', department: 'Aseo' } as any]);

  assert.match(csv, /p1,"Producto, ""especial""",SKU-1/);
  assert.match(csv, /"Higiene, ""premium"""/);
});

test('perfect-session calculation preserves payments, change and cash movements', () => {
  const session = {
    id: 's1',
    branchId: 'w1',
    openedAt: '2026-10-05T10:00:00Z',
    closedAt: '2026-10-05T12:00:00Z',
    openingBalance: 100,
    movements: [
      { id: 'm1', type: 'income', amount: 50, currencyCode: 'CUP' },
      { id: 'm2', type: 'expense', amount: 20, currencyCode: 'CUP' },
    ],
  } as any;

  const transactions = [{
    id: 't1',
    branchId: 'w1',
    sessionId: 's1',
    date: '2026-10-05T11:00:00Z',
    total: 130,
    items: [],
    payments: [{ currencyCode: 'CUP', method: 'cash', amount: 100 }],
    changeGiven: 10,
  }] as any;

  const balances = calculatePerfectSessionBalances(session, {
    baseCurrencyCode: 'CUP',
    currencies: [{ code: 'CUP', rateToBase: 1 }] as any,
    transactions,
  });

  assert.equal(balances[0].currencyCode, 'CUP');
  assert.equal(balances[0].method, 'cash');
  assert.equal(balances[0].amount, 220);
  assert.equal(balances[0].exchangeRate, 1);
});

test('detailed movements preserve historical turn order and session ownership', () => {
  const sessions = [
    {
      id: 's2',
      branchId: 'w1',
      userId: 'u1',
      workerName: 'Ana',
      turnNumber: 12,
      movements: [{ id: 'm2', type: 'expense', amount: 20, currencyCode: 'CUP', description: 'Compra', date: '2026-10-12T11:00:00Z' }],
    },
    {
      id: 's1',
      branchId: 'w1',
      userId: 'u1',
      workerName: 'Ana',
      turnNumber: 3,
      movements: [{ id: 'm1', type: 'income', amount: 50, currencyCode: 'CUP', description: 'Entrada', date: '2026-10-03T11:00:00Z' }],
    },
  ] as any;

  const result = buildDetailedMovements(
    sessions,
    new Map([['s1', 'Turno-3'], ['s2', 'Turno-12']]),
    [{ id: 'w1', name: 'Almacén Central' }] as any,
    [{ id: 'u1', name: 'Ana' }] as any,
    (a, b) => Number(a.turnNumber) - Number(b.turnNumber),
  );

  assert.deepEqual(result.map(x => x.turnLabel), ['Turno-3', 'Turno-12']);
  assert.equal(result[0].session.id, 's1');
});

test('receipt line builders keep the main business data in printable output', () => {
  const session = {
    id: 's1',
    branchId: 'w1',
    userId: 'u1',
    workerName: 'Ana',
    openedAt: '2026-10-05T10:00:00Z',
    openingBalance: 100,
    closingBalances: [{ currencyCode: 'CUP', method: 'cash', amount: 220 }],
    expectedBalance: 220,
    discrepancyDetails: [{ currencyCode: 'CUP', method: 'cash', difference: -5 }],
    hasDiscrepancy: true,
    auditStatus: 'pending_review',
    auditNotes: 'Revisar caja',
    movements: [],
  } as any;

  const payroll = {
    sessionId: 's1',
    baseSalary: 100,
    commissions: 30,
    totalSalary: 130,
    status: 'paid',
    workerName: 'Ana',
  };

  const shiftLines = buildShiftReceiptLines(session, {
    branchName: 'Almacén Central',
    sequentialTurn: 'Turno-3',
    workerName: 'Ana',
    transactions: [{ id: 't1', branchId: 'w1', sessionId: 's1', total: 130, items: [{ product: { name: 'Test', price: 130 }, quantity: 1, total: 130 }] }] as any,
    products: [],
    payrollItem: payroll,
    getProductName: () => 'Test',
    formatMoney,
    format58mmLine,
  });
  assert.ok(shiftLines.some(line => line.includes('TOTAL VENTAS')));
  assert.ok(shiftLines.some(line => line.includes('TOTAL SALARIO')));

  const discrepancyLines = buildDiscrepancyReceiptLines(session, {
    hasDiscrepancy: true,
    isForcedClose: false,
    details: [{ currencyCode: 'CUP', method: 'cash', expected: 220, actual: 215, difference: -5 }],
    totalShortageBase: 5,
    totalOverageBase: 0,
    netDifferenceBase: -5,
    deducted: true,
    deductionAmount: 5,
    aiDiagnostic: undefined,
    matchingProducts: [],
    auditStatus: 'pending_review',
    auditNotes: 'Revisar caja',
  } as any, {
    branchName: 'Almacén Central',
    sequentialTurn: 'Turno-3',
    workerName: 'Ana',
    formatMoney,
    format58mmLine,
  });
  assert.ok(discrepancyLines.some(line => line.includes('TOTAL FALTANTE')));

  const movementLines = buildCashMovementReceiptLines({
    id: 'm1',
    turnLabel: 'Turno-3',
    branchName: 'Almacén Central',
    workerName: 'Ana',
    type: 'income',
    amount: 50,
    currencyCode: 'CUP',
    description: 'Entrada de caja',
    date: '2026-10-05T10:30:00Z',
  }, { formatMoney, format58mmLine });
  assert.ok(movementLines.some(line => line.includes('ENTRADA DE CAJA')));

  const transferLines = buildTransferReceiptLines({
    id: 'tr1',
    productName: 'Producto',
    quantity: 2,
    variantLabel: 'M',
    fromBranchId: 'w1',
    toBranchId: 'w2',
    date: '2026-10-05T10:30:00Z',
    userId: 'u1',
  } as any, {
    businessName: 'PALMYRA',
    userName: 'Ana',
    fromBranchName: 'Origen',
    toBranchName: 'Destino',
    width: '58mm',
    formatMoney,
    format58mmLine,
  });
  assert.ok(transferLines.some(line => line.includes('VALE DE TRANSFERENCIA STOCK')));
});

test('closure receipt formatter includes session totals, physical count and payroll', () => {
  const lines = getClosureReceiptLines({
    id: 's1',
    branchId: 'w1',
    userId: 'u1',
    workerName: 'Ana',
    openedAt: '2026-10-05T10:00:00Z',
    closingDate: '2026-10-05T12:00:00Z',
    openingBalance: 100,
    closingBalances: [{ currencyCode: 'CUP', method: 'cash', amount: 220 }],
    expectedBalance: 220,
    movements: [],
  } as any, {
    receiptConfig: { businessName: 'PALMYRA', showAddress: false, showPhone: false },
    transactions: [{
      id: 't1',
      sessionId: 's1',
      total: 130,
      items: [{ id: 'i1', product: { id: 'p1', name: 'Test', price: 130, costPrice: 100 }, quantity: 1, price: 130 }],
      payments: [{ currencyCode: 'CUP', method: 'cash', amount: 130 }],
    }] as any,
    products: [{ id: 'p1', name: 'Test', price: 130, costPrice: 100, commissionValue: 10 }] as any,
    currencies: [{ code: 'CUP', symbol: 'CUP', rateToBase: 1, isBase: true }] as any,
    branches: [{ id: 'w1', name: 'Almacén' }] as any,
    users: [{ id: 'u1', name: 'Ana', role: 'employee', baseSalary: 100 }] as any,
    currentUser: null,
    salarySettlements: [],
    baseCurrency: { code: 'CUP', symbol: 'CUP', rateToBase: 1, isBase: true } as any,
    formatMoney,
    formatSalaryCUP: value => `CUP ${value.toFixed(2)}`,
  });

  assert.ok(lines.some(line => line.includes('TOTAL VENTAS')));
  assert.ok(lines.some(line => line.includes('ARQUEO FISICO')));
  assert.ok(lines.some(line => line.includes('TOTAL SALARIO')));
});


test('checkout helpers normalize currencies, ticket ids and bank transfers', () => {
  const payments = finalizeCheckoutPayments(
    [
      { code: 'CUP', amount: 100.8, method: 'cash' },
      { code: 'USD', amount: 10.126, method: 'cash' },
      { code: 'USD', amount: 5, method: 'transfer', bankCardId: 'bank-1' },
      { code: 'USD', amount: 2, method: 'transfer', bankCardId: 'bank-1' },
    ],
    [
      { code: 'CUP', symbol: 'CUP', rateToBase: 1, isBase: true },
      { code: 'USD', symbol: 'USD', rateToBase: 370, isBase: false },
    ] as any,
    { code: 'CUP', symbol: 'CUP', rateToBase: 1, isBase: true } as any,
  );

  assert.equal(payments[0].amount, 101);
  assert.equal(payments[1].amount, 10.13);
  assert.equal(payments.length, 4);
  assert.deepEqual(Array.from(aggregateTransferPayments(payments).entries()), [['bank-1', 7]]);

  const ticket = buildTransactionTicketId([
    { id: 'PALMYRA-TK05-OLD', total: 1 } as any,
    { id: 'PALMYRA-TK12-OLD', total: 1 } as any,
  ], 'aabbccdd-1111-2222-3333-444444444444');
  assert.equal(ticket, 'PALMYRA-TK13-AABBCCDD');
});
