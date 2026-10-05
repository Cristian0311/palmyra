import type {
  CashRegisterSession,
  Currency,
  Product,
  SalarySettlement,
  Transaction,
} from '../../../types';

export type SessionDiscrepancyDetail = {
  currencyCode: string;
  method: 'cash' | 'transfer';
  expected: number;
  actual: number;
  difference: number;
};

export type SessionDiscrepancyInfo = {
  hasDiscrepancy: true;
  isForcedClose: boolean;
  details: SessionDiscrepancyDetail[];
  totalShortageBase: number;
  totalOverageBase: number;
  netDifferenceBase: number;
  deducted: boolean;
  deductionAmount: number;
  aiDiagnostic?: CashRegisterSession['aiDiagnostic'];
  matchingProducts: NonNullable<CashRegisterSession['matchingProductsAnalysis']>;
  auditStatus: NonNullable<CashRegisterSession['auditStatus']>;
  auditNotes: string;
};

type SessionDiscrepancyDependencies = {
  currencies: Currency[];
  salarySettlements: SalarySettlement[];
  baseCurrency: Currency;
  transactions: Transaction[];
  products: Product[];
};

const emptyInfo = (session: CashRegisterSession, isForcedClose = false): SessionDiscrepancyInfo => ({
  hasDiscrepancy: true,
  isForcedClose: Boolean(session.isForcedClose) || isForcedClose,
  details: [],
  totalShortageBase: 0,
  totalOverageBase: 0,
  netDifferenceBase: 0,
  deducted: false,
  deductionAmount: 0,
  aiDiagnostic: session.aiDiagnostic,
  matchingProducts: session.matchingProductsAnalysis || [],
  auditStatus: session.auditStatus || 'pending_review',
  auditNotes: session.auditNotes || '',
});

export function getSessionDiscrepancyInfo(
  session: CashRegisterSession,
  deps: SessionDiscrepancyDependencies,
): SessionDiscrepancyInfo | null {
  const { currencies, salarySettlements, baseCurrency, transactions, products } = deps;

  if (session.discrepancyDetails && session.discrepancyDetails.length > 0) {
    let totalShortageBase = 0;
    let totalOverageBase = 0;
    session.discrepancyDetails.forEach(dd => {
      const rate = currencies.find(c => c.code === dd.currencyCode)?.rateToBase || 1;
      if (dd.difference < 0) totalShortageBase += Math.abs(dd.difference) * rate;
      else if (dd.difference > 0) totalOverageBase += dd.difference * rate;
    });

    const settlement = salarySettlements.find(st => st.sessionId === session.id);
    const deductionAmount = session.discrepancyDeductionApplied ?? settlement?.discrepancyDeduction ?? 0;

    return {
      hasDiscrepancy: true,
      isForcedClose: Boolean(session.isForcedClose),
      details: session.discrepancyDetails,
      totalShortageBase,
      totalOverageBase,
      netDifferenceBase: totalOverageBase - totalShortageBase,
      deducted: session.deductedFromSalary || deductionAmount > 0,
      deductionAmount,
      aiDiagnostic: session.aiDiagnostic,
      matchingProducts: session.matchingProductsAnalysis || [],
      auditStatus: session.auditStatus || 'pending_review',
      auditNotes: session.auditNotes || ''
    };
  }

  if (!session.closingBalances || session.closingBalances.length === 0) {
    if (session.isForcedClose || session.hasDiscrepancy) return emptyInfo(session, true);
    return null;
  }

  const expected: { currencyCode: string; method: 'cash' | 'transfer'; amount: number }[] = [
    { currencyCode: baseCurrency.code, method: 'cash', amount: session.openingBalance || 0 }
  ];

  const sessionTxs = transactions.filter(t =>
    t.sessionId
      ? t.sessionId === session.id
      : (t.branchId === session.branchId &&
         new Date(t.date).getTime() >= new Date(session.openedAt).getTime() &&
         (!session.closedAt || new Date(t.date).getTime() <= new Date(session.closedAt).getTime()))
  );

  sessionTxs.forEach(tx => {
    (tx.payments || []).forEach(p => {
      const ex = expected.find(e => e.currencyCode === p.currencyCode && e.method === p.method);
      if (ex) ex.amount += p.amount;
      else expected.push({ currencyCode: p.currencyCode, method: p.method as any, amount: p.amount });
    });
    if (tx.changePayments && tx.changePayments.length > 0) {
      tx.changePayments.forEach(cp => {
        const ex = expected.find(e => e.currencyCode === cp.currencyCode && e.method === cp.method);
        if (ex) ex.amount -= cp.amount;
        else expected.push({ currencyCode: cp.currencyCode, method: cp.method as any, amount: -cp.amount });
      });
    } else if (tx.changeGiven && tx.changeGiven > 0) {
      const ex = expected.find(e => e.currencyCode === baseCurrency.code && e.method === 'cash');
      if (ex) ex.amount -= tx.changeGiven;
      else expected.push({ currencyCode: baseCurrency.code, method: 'cash', amount: -tx.changeGiven });
    }
  });

  (session.movements || []).forEach(m => {
    const ex = expected.find(e => e.currencyCode === m.currencyCode && e.method === 'cash');
    const amount = m.type === 'income' ? m.amount : -m.amount;
    if (ex) ex.amount += amount;
    else expected.push({ currencyCode: m.currencyCode, method: 'cash', amount });
  });

  const details: SessionDiscrepancyDetail[] = [];
  expected.forEach(eb => {
    const act = session.closingBalances?.find(cb => cb.currencyCode === eb.currencyCode && cb.method === eb.method)?.amount || 0;
    const diff = act - eb.amount;
    if (Math.abs(diff) > 0.01) details.push({
      currencyCode: eb.currencyCode,
      method: eb.method,
      expected: eb.amount,
      actual: act,
      difference: diff
    });
  });

  session.closingBalances?.forEach(cb => {
    if (!expected.some(eb => eb.currencyCode === cb.currencyCode && eb.method === cb.method) && cb.amount > 0.01) {
      details.push({
        currencyCode: cb.currencyCode,
        method: cb.method as any,
        expected: 0,
        actual: cb.amount,
        difference: cb.amount
      });
    }
  });

  if (details.length === 0 && !session.isForcedClose && !session.hasDiscrepancy) return null;

  let totalShortageBase = 0;
  let totalOverageBase = 0;
  details.forEach(dd => {
    const rate = currencies.find(c => c.code === dd.currencyCode)?.rateToBase || 1;
    if (dd.difference < 0) totalShortageBase += Math.abs(dd.difference) * rate;
    else if (dd.difference > 0) totalOverageBase += dd.difference * rate;
  });

  const matchingProducts = details.map(dd => ({
    currencyCode: dd.currencyCode,
    difference: dd.difference,
    matchedProducts: products
      .filter(p => Math.abs(p.price - Math.abs(dd.difference)) < 1)
      .slice(0, 3)
      .map(p => ({ id: p.id, name: p.name, price: p.price }))
  })).filter(m => m.matchedProducts.length > 0);

  const settlement = salarySettlements.find(st => st.sessionId === session.id);
  const deductionAmount = session.discrepancyDeductionApplied ?? settlement?.discrepancyDeduction ?? 0;

  return {
    hasDiscrepancy: true,
    isForcedClose: Boolean(session.isForcedClose),
    details,
    totalShortageBase,
    totalOverageBase,
    netDifferenceBase: totalOverageBase - totalShortageBase,
    deducted: deductionAmount > 0,
    deductionAmount,
    aiDiagnostic: session.aiDiagnostic,
    matchingProducts,
    auditStatus: session.auditStatus || 'pending_review',
    auditNotes: session.auditNotes || ''
  };
}
