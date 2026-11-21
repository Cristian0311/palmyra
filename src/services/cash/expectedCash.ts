import type { CashRegisterSession, Currency, Transaction } from '../../types';

export type ExpectedBalance = {
  currencyCode: string;
  method: 'cash' | 'transfer';
  amount: number;
};

const normalizeMethod = (method: string): 'cash' | 'transfer' => (
  method === 'transfer' || method === 'bank_transfer' ? 'transfer' : 'cash'
);

const round6 = (value: number) => Math.round(value * 1000000) / 1000000;

/**
 * Expected balance per currency and method for a shift, built from completed
 * sales, change given and registered cash movements.
 */
export function calculateExpectedBalances(
  session: CashRegisterSession,
  transactions: Transaction[],
  baseCurrency: Currency
): ExpectedBalance[] {
  const expected: ExpectedBalance[] = [
    { currencyCode: baseCurrency.code, method: 'cash', amount: Number(session.openingBalance) || 0 },
  ];

  const findRow = (currencyCode: string, method: 'cash' | 'transfer') => {
    const existing = expected.find(e => e.currencyCode === currencyCode && e.method === method);
    if (existing) return existing;
    const created = { currencyCode, method, amount: 0 };
    expected.push(created);
    return created;
  };

  const sessionTxs = (transactions || []).filter(tx =>
    tx.status === 'completed' &&
    !tx.deletedAt &&
    !String(tx.notes || '').startsWith('AJUSTE_') &&
    (tx.sessionId
      ? tx.sessionId === session.id
      : tx.branchId === session.branchId &&
        new Date(tx.date).getTime() >= new Date(session.openedAt).getTime() &&
        (!session.closedAt || new Date(tx.date).getTime() <= new Date(session.closedAt).getTime()))
  );

  for (const tx of sessionTxs) {
    for (const payment of tx.payments || []) {
      if (!payment || !payment.currencyCode || !Number.isFinite(Number(payment.amount))) continue;
      findRow(payment.currencyCode, normalizeMethod(String(payment.method))).amount += Number(payment.amount);
    }
    if (tx.changePayments && tx.changePayments.length > 0) {
      for (const change of tx.changePayments) {
        if (!change || !change.currencyCode || !Number.isFinite(Number(change.amount))) continue;
        findRow(change.currencyCode, normalizeMethod(String(change.method))).amount -= Number(change.amount);
      }
    } else if (tx.changeGiven && tx.changeGiven > 0) {
      findRow(baseCurrency.code, 'cash').amount -= Number(tx.changeGiven);
    }
  }

  for (const movement of session.movements || []) {
    const amount = Number(movement.amount) || 0;
    findRow(movement.currencyCode, 'cash').amount += movement.type === 'income' ? amount : -amount;
  }

  return expected.map(row => ({ ...row, amount: round6(row.amount) }));
}

export function calculateExpectedCashBase(
  session: CashRegisterSession,
  transactions: Transaction[],
  currencies: Currency[]
): number {
  const currencyRate = (code: string, fallback = 1) => {
    const row = currencies.find((item) => item.code === code);
    const rate = Number(row?.rateToBase);
    return Number.isFinite(rate) && rate > 0 ? rate : fallback;
  };
  let expected = Number(session.openingBalance) || 0;
  const sessionTxs = (transactions || []).filter((tx) =>
    tx.status === 'completed' &&
    !tx.deletedAt &&
    !String(tx.notes || '').startsWith('AJUSTE_') &&
    (tx.sessionId
      ? tx.sessionId === session.id
      : (tx.branchId === session.branchId &&
         new Date(tx.date).getTime() >= new Date(session.openedAt).getTime() &&
         (!session.closedAt || new Date(tx.date).getTime() <= new Date(session.closedAt).getTime())))
  );
  for (const tx of sessionTxs) {
    for (const payment of tx.payments || []) {
      if (payment.method !== 'cash') continue;
      const amount = Number(payment.amount) || 0;
      const explicitRate = Number(payment.exchangeRate);
      const rate = Number.isFinite(explicitRate) && explicitRate > 0 ? explicitRate : currencyRate(payment.currencyCode);
      expected += amount * rate;
    }
    if (tx.changePayments?.length) {
      for (const change of tx.changePayments) {
        if (change.method !== 'cash') continue;
        const amount = Number(change.amount) || 0;
        const explicitRate = Number(change.exchangeRate);
        const rate = Number.isFinite(explicitRate) && explicitRate > 0 ? explicitRate : currencyRate(change.currencyCode);
        expected -= amount * rate;
      }
    } else if (Number(tx.changeGiven) > 0) {
      expected -= Number(tx.changeGiven) || 0;
    }
  }
  for (const movement of session.movements || []) {
    const amount = Number(movement.amount) || 0;
    expected += (movement.type === 'income' ? amount : -amount) * currencyRate(movement.currencyCode);
  }
  return Math.round(expected * 1000000) / 1000000;
}
