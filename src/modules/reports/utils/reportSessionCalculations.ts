import type { Branch, CashRegisterSession, Currency, Transaction, User } from '../../../types';

type TurnSorter = (a: CashRegisterSession, b: CashRegisterSession) => number;

export type DetailedMovement = {
  id: string;
  sessionId: string;
  turnLabel: string;
  branchId: string;
  branchName: string;
  workerName: string;
  type: 'income' | 'expense';
  amount: number;
  currencyCode: string;
  description: string;
  date: string;
  session: CashRegisterSession;
};

export function buildDetailedMovements(
  cashSessions: CashRegisterSession[],
  sessionTurnMap: Map<string, string>,
  branches: Branch[],
  users: User[],
  sortSessionsByTurn: TurnSorter,
): DetailedMovement[] {
  const branchById = new Map(branches.map(b => [b.id, b.name]));
  const userById = new Map(users.map(u => [u.id, u.name]));
  const list: DetailedMovement[] = [];

  cashSessions.forEach(session => {
    const turnLabel = sessionTurnMap.get(session.id) || session.id;
    const branchName = branchById.get(session.branchId) || 'Sucursal';
    const workerName = session.workerName || userById.get(session.userId) || 'Cajero';

    (session.movements || []).forEach(m => {
      list.push({
        id: m.id,
        sessionId: session.id,
        turnLabel,
        branchId: m.branchId || session.branchId,
        branchName,
        workerName: m.workerName || workerName,
        type: m.type,
        amount: m.amount,
        currencyCode: m.currencyCode,
        description: m.description,
        date: m.date,
        session,
      });
    });
  });

  return list.sort((a, b) => {
    const turnOrder = sortSessionsByTurn(a.session, b.session);
    return turnOrder !== 0 ? turnOrder : new Date(a.date).getTime() - new Date(b.date).getTime();
  });
}

export function calculatePerfectSessionBalances(
  session: CashRegisterSession,
  deps: { baseCurrencyCode: string; currencies: Currency[]; transactions: Transaction[] },
) {
  const { baseCurrencyCode, currencies, transactions } = deps;
  const expected: { currencyCode: string; method: 'cash' | 'transfer'; amount: number }[] = [
    { currencyCode: baseCurrencyCode, method: 'cash', amount: session.openingBalance || 0 },
  ];

  const sessionTxs = transactions.filter(t =>
    t.sessionId
      ? t.sessionId === session.id
      : (
          t.branchId === session.branchId &&
          new Date(t.date).getTime() >= new Date(session.openedAt).getTime() &&
          (!session.closedAt || new Date(t.date).getTime() <= new Date(session.closedAt).getTime())
        )
  );

  sessionTxs.forEach(tx => {
    (tx.payments || []).forEach(p => {
      const ex = expected.find(item => item.currencyCode === p.currencyCode && item.method === p.method);
      if (ex) ex.amount += p.amount;
      else expected.push({ currencyCode: p.currencyCode, method: p.method as 'cash' | 'transfer', amount: p.amount });
    });

    if (tx.changePayments && tx.changePayments.length > 0) {
      tx.changePayments.forEach(cp => {
        const ex = expected.find(item => item.currencyCode === cp.currencyCode && item.method === cp.method);
        if (ex) ex.amount -= cp.amount;
        else expected.push({ currencyCode: cp.currencyCode, method: cp.method as 'cash' | 'transfer', amount: -cp.amount });
      });
    } else if (tx.changeGiven && tx.changeGiven > 0) {
      const ex = expected.find(item => item.currencyCode === baseCurrencyCode && item.method === 'cash');
      if (ex) ex.amount -= tx.changeGiven;
      else expected.push({ currencyCode: baseCurrencyCode, method: 'cash', amount: -tx.changeGiven });
    }
  });

  (session.movements || []).forEach(m => {
    const amount = m.type === 'income' ? m.amount : -m.amount;
    const ex = expected.find(item => item.currencyCode === m.currencyCode && item.method === 'cash');
    if (ex) ex.amount += amount;
    else expected.push({ currencyCode: m.currencyCode, method: 'cash', amount });
  });

  return expected.map(e => ({
    currencyCode: e.currencyCode as any,
    amount: e.amount,
    method: e.method,
    exchangeRate: currencies.find(c => c.code === e.currencyCode)?.rateToBase || 1,
  }));
}
