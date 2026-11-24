import type { CashRegisterSession, Currency, Payment, Transaction } from '../../../types';

/**
 * FUENTE ÚNICA DE VERDAD del esperado de caja.
 *
 * Tanto el arqueo del POS (calculateExpectedSessionBalances) como el esperado
 * que se envía al cierre y al camino offline (calculateExpectedBalances /
 * calculateExpectedCashBase en services/cash/expectedCash.ts) salen de este
 * mismo cálculo. Cualquier cambio aquí debe mantener la paridad exacta entre
 * ambas vistas o el RPC palmyra_close_cash_session rechazará el cierre con
 * cash_difference_mismatch.
 */

/** Redondeo compartido por todos los cálculos de esperado (espejo del ROUND(..., 6) del servidor). */
export const round6 = (value: number) => Math.round(value * 1000000) / 1000000;

/** Solo una diferencia mayor que el ruido de punto flotante es una diferencia real. */
export const DISCREPANCY_EPSILON = 1e-9;

export const hasRealDifference = (difference: number) => Math.abs(difference) > DISCREPANCY_EPSILON;

const normalizeMethod = (method: string): 'cash' | 'transfer' => (
  method === 'transfer' || method === 'bank_transfer' ? 'transfer' : 'cash'
);

/**
 * Ventas que cuentan para el esperado: completadas, no borradas, no AJUSTE_*.
 * Las ventas legadas sin sessionId cuentan solo si son del mismo almacén y
 * caen dentro de la ventana horaria del turno.
 */
export function collectSessionTransactions(
  session: CashRegisterSession,
  transactions: Transaction[],
): Transaction[] {
  const sessionOpenedAt = new Date(session.openedAt || 0).getTime();
  const sessionClosedAt = session.closedAt
    ? new Date(session.closedAt).getTime()
    : Number.POSITIVE_INFINITY;
  return transactions.filter(transaction => {
    if (transaction.status !== 'completed' || transaction.deletedAt || String(transaction.notes || '').startsWith('AJUSTE_')) return false;
    if (transaction.sessionId) return transaction.sessionId === session.id;
    const transactionAt = new Date(transaction.date).getTime();
    return transaction.branchId === session.branchId && Number.isFinite(transactionAt) &&
      transactionAt >= sessionOpenedAt && transactionAt <= sessionClosedAt;
  });
}

type ExpectedRow = {
  currencyCode: string;
  method: 'cash' | 'transfer';
  amount: number;
  exchangeRate: number;
  /** Aporte convertido a moneda base, acumulado aporte por aporte con su propia tasa. */
  baseAmount: number;
};

/** Tasa a usar: explícita del pago si es válida, si no la tasa vigente de la moneda, si no 1. */
const resolveRate = (code: string, currencies: Map<string, Currency>, explicit?: number): number => {
  const explicitRate = Number(explicit);
  if (Number.isFinite(explicitRate) && explicitRate > 0) return explicitRate;
  const rate = Number(currencies.get(code as Currency['code'])?.rateToBase);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
};

function buildExpectedRows(
  session: CashRegisterSession,
  transactions: Transaction[],
  baseCurrency: Currency,
  currencies: Currency[],
): { rows: ExpectedRow[]; cashBaseTotal: number } {
  const currencyByCode = new Map(currencies.map(currency => [currency.code, currency]));
  const rows = new Map<string, ExpectedRow>();
  const getRow = (currencyCode: string, method: 'cash' | 'transfer', fallbackRate: number): ExpectedRow => {
    const key = `${currencyCode}::${method}`;
    const existing = rows.get(key);
    if (existing) return existing;
    const created: ExpectedRow = { currencyCode, method, amount: 0, exchangeRate: fallbackRate, baseAmount: 0 };
    rows.set(key, created);
    return created;
  };
  const addContribution = (row: ExpectedRow, amount: number, rate: number) => {
    row.amount += amount;
    row.baseAmount += amount * rate;
  };

  // Fondo de apertura, siempre en moneda base.
  addContribution(getRow(baseCurrency.code, 'cash', 1), Number(session.openingBalance) || 0, 1);

  for (const tx of collectSessionTransactions(session, transactions)) {
    // Cierre y Cuadre Perfecto deben incluir cada medio de cobro por separado.
    // Antes solo se agregaba cash, por lo que las transferencias se quedaban en
    // cero y el cierre las marcaba como descuadre aunque estuvieran cobradas.
    for (const payment of tx.payments || []) {
      if (!payment || !payment.currencyCode) continue;
      const amount = Number(payment.amount);
      if (!Number.isFinite(amount)) continue;
      const method = normalizeMethod(String(payment.method));
      const rate = resolveRate(String(payment.currencyCode), currencyByCode, payment.exchangeRate);
      addContribution(getRow(String(payment.currencyCode), method, rate), amount, rate);
    }
    if (tx.changePayments && tx.changePayments.length > 0) {
      for (const change of tx.changePayments) {
        if (!change || !change.currencyCode) continue;
        const amount = Number(change.amount);
        if (!Number.isFinite(amount)) continue;
        const method = normalizeMethod(String(change.method));
        const rate = resolveRate(String(change.currencyCode), currencyByCode, change.exchangeRate);
        addContribution(getRow(String(change.currencyCode), method, rate), -amount, rate);
      }
    } else if (Number(tx.changeGiven) > 0) {
      addContribution(getRow(baseCurrency.code, 'cash', 1), -Number(tx.changeGiven), 1);
    }
  }

  for (const movement of session.movements || []) {
    const amount = Number(movement.amount);
    if (!Number.isFinite(amount)) continue;
    const code = String(movement.currencyCode);
    const rate = resolveRate(code, currencyByCode);
    addContribution(getRow(code, 'cash', rate), movement.type === 'income' ? amount : -amount, rate);
  }

  const allRows = Array.from(rows.values())
    .map(row => ({ ...row, amount: round6(row.amount), baseAmount: round6(row.baseAmount) }));

  // El total base se calcula sobre TODAS las filas (incluidas las de importe
  // cero) para no perder aportes netos cero con tasas mixtas (p. ej. cobro y
  // vuelto en la misma moneda a tasas distintas).
  return {
    rows: allRows.filter(row => row.amount !== 0),
    cashBaseTotal: round6(
      allRows.filter(row => row.method === 'cash').reduce((sum, row) => sum + row.baseAmount, 0)
    ),
  };
}

export function calculateExpectedSessionBalances(
  session: CashRegisterSession | undefined,
  transactions: Transaction[],
  _currentBranchId: string,
  baseCurrency: Currency,
  currencies: Currency[],
): Payment[] {
  if (!session) return [];
  return buildExpectedRows(session, transactions, baseCurrency, currencies).rows.map(row => ({
    currencyCode: row.currencyCode as Payment['currencyCode'],
    amount: row.amount,
    exchangeRate: row.exchangeRate,
    method: row.method,
  }));
}

/**
 * Suma en moneda base del esperado en efectivo, aporte por aporte (cada pago y
 * movimiento se convierte con su propia tasa). Es el número que se graba como
 * expectedBalance/expected_cash y el que el servidor contrasta con el físico.
 */
export function calculateExpectedCashBaseTotal(
  session: CashRegisterSession,
  transactions: Transaction[],
  baseCurrency: Currency,
  currencies: Currency[],
): number {
  return buildExpectedRows(session, transactions, baseCurrency, currencies).cashBaseTotal;
}
