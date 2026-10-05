import type { CashRegisterSession, Currency, Transaction } from '../../types';

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
    tx.sessionId
      ? tx.sessionId === session.id
      : (tx.branchId === session.branchId &&
         new Date(tx.date).getTime() >= new Date(session.openedAt).getTime() &&
         (!session.closedAt || new Date(tx.date).getTime() <= new Date(session.closedAt).getTime()))
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
