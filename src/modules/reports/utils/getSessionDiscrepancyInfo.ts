import type {
  CashRegisterSession,
  Currency,
  Product,
  SalarySettlement,
  Transaction,
} from '../../../types';
import { calculateExpectedBalances } from '../../../services/cash/expectedCash';

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

  // Un faltante histórico se valora con la tasa registrada al cerrar la caja;
  // usar la tasa de hoy hacía que el reporte cambiara de un día para otro.
  const rateAtClose = (currencyCode: string): number => {
    const recorded = session.closingBalances?.find(
      balance => balance.currencyCode === currencyCode && Number(balance.exchangeRate) > 0,
    )?.exchangeRate;
    if (Number(recorded) > 0) return Number(recorded);
    return currencies.find(currency => currency.code === currencyCode)?.rateToBase || 1;
  };

  if (session.discrepancyDetails && session.discrepancyDetails.length > 0) {
    let totalShortageBase = 0;
    let totalOverageBase = 0;
    session.discrepancyDetails.forEach(dd => {
      const rate = rateAtClose(dd.currencyCode);
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

  const expected = calculateExpectedBalances(session, transactions, baseCurrency);

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
    const rate = rateAtClose(dd.currencyCode);
    if (dd.difference < 0) totalShortageBase += Math.abs(dd.difference) * rate;
    else if (dd.difference > 0) totalOverageBase += dd.difference * rate;
  });

  // Product prices are stored in the base currency, so compare the difference
  // converted to base instead of the raw amount of a USD/MLC mismatch.
  const matchingProducts = details.map(dd => {
    const rate = rateAtClose(dd.currencyCode);
    const differenceBase = Math.abs(dd.difference) * rate;
    return {
      currencyCode: dd.currencyCode,
      difference: dd.difference,
      matchedProducts: products
        .filter(p => Math.abs(Number(p.price) - differenceBase) < 1)
        .slice(0, 3)
        .map(p => ({ id: p.id, name: p.name, price: p.price }))
    };
  }).filter(m => m.matchedProducts.length > 0);

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
