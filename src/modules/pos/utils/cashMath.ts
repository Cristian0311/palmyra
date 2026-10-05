import type { CashRegisterSession, Currency, Payment, Transaction } from '../../../types';

export function calculateExpectedSessionBalances(
  session: CashRegisterSession | undefined,
  transactions: Transaction[],
  currentBranchId: string,
  baseCurrency: Currency,
  currencies: Currency[],
): Payment[] {
  if (!session) return [];

  const currencyByCode = new Map(currencies.map(currency => [currency.code, currency]));
  const expected: Payment[] = [
    {
      currencyCode: baseCurrency.code as Payment['currencyCode'],
      amount: session.openingBalance,
      exchangeRate: 1,
      method: 'cash',
    },
  ];

  const sessionTxs = transactions.filter(
    transaction =>
      transaction.branchId === currentBranchId &&
      transaction.sessionId === session.id,
  );

  const expectedMap = new Map<string, Payment>();
  const addExpected = (payment: Payment, amountDelta?: number) => {
    const key = payment.currencyCode + '::' + payment.method;
    const existing = expectedMap.get(key);
    if (existing) {
      existing.amount += amountDelta ?? payment.amount;
      return;
    }
    expectedMap.set(key, {
      ...payment,
      amount: amountDelta ?? payment.amount,
    });
  };

  addExpected(expected[0]);

  sessionTxs.forEach(transaction => {
    (transaction.payments || []).forEach(payment => addExpected(payment));

    if (transaction.changePayments?.length) {
      transaction.changePayments.forEach(change =>
        addExpected(change, -change.amount),
      );
    } else if (transaction.changeGiven && transaction.changeGiven > 0) {
      addExpected(
        {
          currencyCode: baseCurrency.code as Payment['currencyCode'],
          amount: transaction.changeGiven,
          exchangeRate: 1,
          method: 'cash',
        },
        -transaction.changeGiven,
      );
    }
  });

  (session.movements || []).forEach(movement => {
    addExpected(
      {
        currencyCode: movement.currencyCode as Payment['currencyCode'],
        amount: movement.amount,
        exchangeRate:
          currencyByCode.get(movement.currencyCode)?.rateToBase || 1,
        method: 'cash',
      },
      movement.type === 'income' ? movement.amount : -movement.amount,
    );
  });

  return Array.from(expectedMap.values()).filter(payment => payment.amount !== 0);
}
