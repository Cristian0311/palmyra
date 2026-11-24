import type {
  CashRegisterSession,
  Currency,
  Product,
  SalarySettlement,
  Transaction,
} from '../../../types';
import {
  buildDiscrepancyDetails,
  calculateExpectedBalances,
  resolveCloseRate,
  round6,
  type ExpectedDiscrepancyDetail,
} from '../../../services/cash/expectedCash';

export type SessionDiscrepancyDetail = ExpectedDiscrepancyDetail;

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
  // Es la MISMA tasa que aplicó la deducción salarial en el POS al cerrar.
  const rateAtClose = (currencyCode: string): number =>
    resolveCloseRate(currencyCode, session.closingBalances, currencies);

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
      totalShortageBase: round6(totalShortageBase),
      totalOverageBase: round6(totalOverageBase),
      netDifferenceBase: round6(totalOverageBase - totalShortageBase),
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
  const details = buildDiscrepancyDetails(expected, session.closingBalances);

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
    totalShortageBase: round6(totalShortageBase),
    totalOverageBase: round6(totalOverageBase),
    netDifferenceBase: round6(totalOverageBase - totalShortageBase),
    deducted: deductionAmount > 0,
    deductionAmount,
    aiDiagnostic: session.aiDiagnostic,
    matchingProducts,
    auditStatus: session.auditStatus || 'pending_review',
    auditNotes: session.auditNotes || ''
  };
}
