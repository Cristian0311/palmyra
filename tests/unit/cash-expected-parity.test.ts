import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateExpectedCashBaseTotal,
  calculateExpectedSessionBalances,
  hasRealDifference,
  round6,
} from '../../src/modules/pos/utils/cashMath';
import {
  buildDiscrepancyDetails,
  calculateExpectedBalances,
  calculateExpectedCashBase,
  hasRefundMovement,
  resolveCloseRate,
  resolveRefundTargetSession,
  shortageBaseAtClose,
} from '../../src/services/cash/expectedCash';
import { getSessionDiscrepancyInfo } from '../../src/modules/reports/utils/getSessionDiscrepancyInfo';

const currencies = [
  { code: 'CUP', name: 'Peso cubano', symbol: 'CUP', rateToBase: 1, isBase: true },
  { code: 'USD', name: 'Dólar', symbol: 'USD', rateToBase: 300, isBase: false },
  { code: 'EUR', name: 'Euro', symbol: 'EUR', rateToBase: 340, isBase: false },
] as any;
const baseCurrency = currencies[0];

const makeSession = (overrides: any = {}) => ({
  id: 'session-1',
  branchId: 'warehouse-1',
  openedAt: '2026-11-20T08:00:00.000Z',
  openingBalance: 1000,
  status: 'open',
  userId: 'employee-1',
  movements: [],
  ...overrides,
}) as any;

const sale = (overrides: any = {}) => ({
  id: 'sale-1',
  sessionId: 'session-1',
  branchId: 'warehouse-1',
  date: '2026-11-20T09:00:00.000Z',
  status: 'completed',
  deletedAt: undefined,
  notes: '',
  payments: [{ currencyCode: 'CUP', amount: 500, exchangeRate: 1, method: 'cash' }],
  changeGiven: 0,
  changePayments: [],
  ...overrides,
}) as any;

const amount = (rows: any[], code: string, method: string) =>
  rows.find(row => row.currencyCode === code && row.method === method)?.amount ?? 0;

/**
 * El arqueo del POS (cashMath), el esperado del servicio de cierre
 * (expectedCash) y el esperado base que contrasta el RPC deben dar EXACTAMENTE
 * los mismos números o el servidor rechaza el cierre con cash_difference_mismatch.
 */
const assertExactParity = (session: any, transactions: any[]) => {
  const pos = calculateExpectedSessionBalances(session, transactions, session.branchId, baseCurrency, currencies);
  const svc = calculateExpectedBalances(session, transactions, baseCurrency);

  assert.equal(svc.length, pos.length, 'POS y servicio listan las mismas filas esperadas');
  for (const row of svc) {
    const match = pos.find(p => p.currencyCode === row.currencyCode && p.method === row.method);
    assert.ok(match, `fila ${row.currencyCode}/${row.method} presente en el arqueo del POS`);
    assert.equal(row.amount, round6(Number(match.amount)), `paridad de importe ${row.currencyCode}/${row.method}`);
  }

  const direct = calculateExpectedCashBaseTotal(session, transactions, baseCurrency, currencies);
  assert.equal(calculateExpectedCashBase(session, transactions, currencies), direct, 'esperado base idéntico por ambas vías');
  return { pos, svc, cashBase: direct };
};

test('esperado solo efectivo: fondo + venta en efectivo', () => {
  const { svc, cashBase } = assertExactParity(makeSession(), [sale()]);
  assert.equal(amount(svc, 'CUP', 'cash'), 1500, 'fondo 1000 + pago cash 500');
  assert.equal(cashBase, 1500);
});

test('esperado con transferencia: la transferencia no es efectivo físico', () => {
  const { svc, cashBase } = assertExactParity(makeSession(), [
    sale({ payments: [{ currencyCode: 'CUP', amount: 300, exchangeRate: 1, method: 'transfer' }] }),
  ]);
  assert.equal(amount(svc, 'CUP', 'transfer'), 300, 'la transferencia cuenta en su propio medio');
  assert.equal(amount(svc, 'CUP', 'cash'), 1000, 'solo el fondo queda como efectivo esperado');
  assert.equal(cashBase, 1000);
});

test('vuelto: changeGiven y changePayments descuentan del efectivo esperado', () => {
  const withChangeGiven = assertExactParity(makeSession(), [sale({ changeGiven: 50 })]);
  assert.equal(amount(withChangeGiven.svc, 'CUP', 'cash'), 1450, '500 cobrados − 50 devueltos');

  const withChangePayments = assertExactParity(makeSession(), [
    sale({ changeGiven: 0, changePayments: [{ currencyCode: 'CUP', amount: 50, exchangeRate: 1, method: 'cash' }] }),
  ]);
  assert.equal(amount(withChangePayments.svc, 'CUP', 'cash'), 1450, 'changePayments descuentan igual que changeGiven');
});

test('movimientos de ingreso y egreso entran en el esperado', () => {
  const session = makeSession({
    movements: [
      { id: 'mov-1', type: 'expense', amount: 10, currencyCode: 'CUP' },
      { id: 'mov-2', type: 'income', amount: 4, currencyCode: 'USD' },
    ],
  });
  const { svc, cashBase } = assertExactParity(session, [sale()]);
  assert.equal(amount(svc, 'CUP', 'cash'), 1490, 'fondo + venta − egreso');
  assert.equal(amount(svc, 'USD', 'cash'), 4, 'ingreso en USD');
  assert.equal(cashBase, 1490 + 4 * 300, 'egreso en base + ingreso convertido a su tasa');
});

test('venta borrada, no completada o AJUSTE_* quedan excluidas del esperado', () => {
  const deleted = assertExactParity(makeSession(), [sale({ deletedAt: '2026-11-20T10:00:00.000Z' })]);
  assert.equal(deleted.cashBase, 1000, 'venta con deletedAt no cuenta');

  const pending = assertExactParity(makeSession(), [sale({ status: 'pending' })]);
  assert.equal(pending.cashBase, 1000, 'venta no completada no cuenta');

  const ajuste = assertExactParity(makeSession(), [sale({ notes: 'AJUSTE_inventario' })]);
  assert.equal(ajuste.cashBase, 1000, 'venta AJUSTE_* no cuenta');
});

test('multimoneda: cada aporte se convierte con su propia tasa y la moneda desconocida cae a tasa 1', () => {
  const session = makeSession({
    movements: [{ id: 'mov-usd', type: 'income', amount: 1, currencyCode: 'USD' }],
  });
  const txs = [
    sale({
      payments: [
        { currencyCode: 'USD', amount: 10, exchangeRate: 120, method: 'cash' },
        { currencyCode: 'EUR', amount: 20, exchangeRate: 1, method: 'cash' },
        { currencyCode: 'MLC', amount: 5, exchangeRate: undefined, method: 'cash' },
      ],
    }),
  ];
  const { pos, svc, cashBase } = assertExactParity(session, txs);

  assert.equal(amount(svc, 'USD', 'cash'), 11, 'pago USD + ingreso USD');
  assert.equal(pos.find(r => r.currencyCode === 'USD' && r.method === 'cash').exchangeRate, 120, 'tasa explícita del pago');
  assert.equal(amount(svc, 'EUR', 'cash'), 20);
  assert.equal(amount(svc, 'MLC', 'cash'), 5);
  assert.equal(pos.find(r => r.currencyCode === 'MLC' && r.method === 'cash').exchangeRate, 1, 'moneda sin configurar cae a tasa 1');
  // 1000 (fondo) + 10·120 + 1·300 (USD) + 20·1 (EUR) + 5·1 (MLC)
  assert.equal(cashBase, 1000 + 1200 + 300 + 20 + 5);
});

test('moneda configurada sin tasa explícita en el pago usa su tasa vigente', () => {
  const txs = [
    sale({ payments: [{ currencyCode: 'EUR', amount: 20, exchangeRate: undefined, method: 'cash' }] }),
  ];
  const { pos, cashBase } = assertExactParity(makeSession(), txs);
  assert.equal(pos.find(r => r.currencyCode === 'EUR' && r.method === 'cash').exchangeRate, 340, 'tasa vigente de EUR');
  assert.equal(cashBase, 1000 + 20 * 340);
});

test('la máscara de 0.01 desapareció: toda diferencia real cuenta', () => {
  assert.equal(hasRealDifference(0), false, 'cero exacto no es diferencia');
  assert.equal(hasRealDifference(0.004), true, '0.004 es una diferencia real');
  assert.equal(hasRealDifference(-0.004), true);
  assert.equal(hasRealDifference(1e-12), false, 'ruido de punto flotante no es diferencia');

  const details = buildDiscrepancyDetails(
    [{ currencyCode: 'CUP', method: 'cash', amount: 100 }],
    [{ currencyCode: 'CUP', method: 'cash', amount: 99.996 }],
  );
  assert.equal(details.length, 1, 'un faltante de 0.004 se registra como descuadre');
  assert.equal(details[0].difference, -0.004);
});

test('la deducción salarial usa la tasa del cierre, no la tasa vigente', () => {
  const closeCurrencies = [
    { code: 'CUP', name: 'Peso cubano', symbol: 'CUP', rateToBase: 1, isBase: true },
    { code: 'USD', name: 'Dólar', symbol: 'USD', rateToBase: 400, isBase: false },
  ] as any;
  const closingBalances = [{ currencyCode: 'USD', method: 'cash', amount: 8, exchangeRate: 300 }] as any;
  const expected = [{ currencyCode: 'USD', method: 'cash', amount: 10 }];

  assert.equal(resolveCloseRate('USD', closingBalances, closeCurrencies), 300, 'tasa registrada al cerrar');
  const details = buildDiscrepancyDetails(expected, closingBalances);
  assert.equal(details.length, 1);
  assert.equal(details[0].difference, -2);
  assert.equal(shortageBaseAtClose(details, closingBalances, closeCurrencies), 600, '2 USD × 300 (cierre), no × 400 (hoy)');

  // Sin tasa registrada en el cierre se cae a la vigente.
  assert.equal(
    shortageBaseAtClose(details, [{ currencyCode: 'USD', method: 'cash', amount: 8 }], closeCurrencies),
    800,
    'sin tasa registrada usa la vigente',
  );
});

test('Reportes valora el faltante histórico con la misma tasa del cierre', () => {
  const closeCurrencies = [
    { code: 'CUP', name: 'Peso cubano', symbol: 'CUP', rateToBase: 1, isBase: true },
    { code: 'USD', name: 'Dólar', symbol: 'USD', rateToBase: 400, isBase: false },
  ] as any;
  const closingBalances = [{ currencyCode: 'USD', method: 'cash', amount: 8, exchangeRate: 300 }] as any;
  const session = {
    id: 'session-2',
    branchId: 'warehouse-1',
    openedAt: '2026-11-20T08:00:00.000Z',
    closedAt: '2026-11-20T20:00:00.000Z',
    openingBalance: 0,
    status: 'closed',
    userId: 'employee-1',
    movements: [],
    closingBalances,
  } as any;
  const txs = [
    {
      id: 'sale-usd',
      sessionId: 'session-2',
      branchId: 'warehouse-1',
      date: '2026-11-20T09:00:00.000Z',
      status: 'completed',
      deletedAt: undefined,
      notes: '',
      payments: [{ currencyCode: 'USD', amount: 10, exchangeRate: 300, method: 'cash' }],
      changeGiven: 0,
      changePayments: [],
    },
  ] as any;

  const info = getSessionDiscrepancyInfo(session, {
    currencies: closeCurrencies,
    salarySettlements: [],
    baseCurrency: closeCurrencies[0],
    transactions: txs,
    products: [],
  });

  assert.ok(info, 'un faltante real produce información de descuadre');
  assert.equal(info!.totalShortageBase, 600, 'mismo total que shortageBaseAtClose en el POS');
  assert.equal(shortageBaseAtClose(info!.details, closingBalances, closeCurrencies), info!.totalShortageBase);
});

test('reembolso fuera de turno: turno destino y egreso idempotente', () => {
  const sessions = [
    { id: 's-closed', status: 'closed', deletedAt: undefined },
    { id: 's-open', status: 'open', deletedAt: undefined },
    { id: 's-deleted', status: 'open', deletedAt: '2026-11-20T12:00:00.000Z' },
  ] as any;

  assert.equal(resolveRefundTargetSession(sessions[1], 's-closed', sessions)?.id, 's-open', 'gana el turno abierto de la caja');
  assert.equal(resolveRefundTargetSession(undefined, 's-open', sessions)?.id, 's-open', 'sin turno abierto usa el turno aún abierto de la venta');
  assert.equal(resolveRefundTargetSession(undefined, 's-deleted', sessions), undefined, 'un turno borrado no sirve');
  assert.equal(resolveRefundTargetSession(undefined, 's-closed', sessions), undefined, 'un turno cerrado no sirve');
  assert.equal(resolveRefundTargetSession(undefined, undefined, sessions), undefined, 'sin referencia no hay turno');

  const target = {
    id: 's-open',
    movements: [
      { id: 'mov-1', category: 'devolucion', description: 'Reembolso RET-123 · ticket TK-456' },
    ],
  } as any;
  assert.equal(hasRefundMovement(target, 'mov-1', 'RET-123'), true, 'mismo id de movimiento');
  assert.equal(hasRefundMovement(target, 'mov-otro', 'RET-123'), true, 'misma referencia de devolución');
  assert.equal(hasRefundMovement(target, 'mov-otro', 'RET-999'), false, 'otra devolución no bloquea');
  assert.equal(hasRefundMovement({} as any, 'mov-otro', 'RET-123'), false, 'turno sin movimientos no registra');
});
