import type { CashRegisterSession, Currency, Payment, Transaction } from '../../../types';

export function calculateExpectedSessionBalances(
  session: CashRegisterSession | undefined,
  transactions: Transaction[],
  _currentBranchId: string,
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

  const sessionOpenedAt = new Date(session.openedAt || 0).getTime();
  const sessionClosedAt = session.closedAt ? new Date(session.closedAt).getTime() : Number.POSITIVE_INFINITY;
  const sessionTxs = transactions.filter(transaction => {
    if (transaction.status !== 'completed' || transaction.deletedAt || String(transaction.notes || '').startsWith('AJUSTE_')) return false;
    if (transaction.sessionId) return transaction.sessionId === session.id;
    // Legacy/imported tickets may not have a sessionId. Count them only when
    // they belong to this warehouse and fall inside this turn's time interval.
    const transactionAt = new Date(transaction.date).getTime();
    return transaction.branchId === session.branchId && Number.isFinite(transactionAt) &&
      transactionAt >= sessionOpenedAt && transactionAt <= sessionClosedAt;
  });

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
    // Cierre y Cuadre Perfecto deben incluir cada medio de cobro por separado.
    // Antes solo se agregaba cash, por lo que las transferencias se quedaban en
    // cero y el cierre las marcaba como descuadre aunque estuvieran cobradas.
    (transaction.payments || []).forEach(payment => {
      const method = (payment.method as string) === 'transfer' || (payment.method as string) === 'bank_transfer'
        ? 'transfer'
        : 'cash';
      addExpected({ ...payment, method } as Payment);
    });

    if (transaction.changePayments?.length) {
      transaction.changePayments.forEach(change => {
        const method = (change.method as string) === 'transfer' || (change.method as string) === 'bank_transfer'
          ? 'transfer'
          : 'cash';
        addExpected({ ...change, method } as Payment, -Number(change.amount || 0));
      });
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
          currencyByCode.get(movement.currencyCode as Currency['code'])?.rateToBase || 1,
        method: 'cash',
      },
      movement.type === 'income' ? movement.amount : -movement.amount,
    );
  });

  return Array.from(expectedMap.values()).filter(payment => payment.amount !== 0);
}
