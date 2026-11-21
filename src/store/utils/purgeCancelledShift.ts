import type { CashRegisterSession, SalarySettlement, Transaction } from '../../types';

type PurgeState = {
  transactions?: Transaction[];
  cashSessions?: CashRegisterSession[];
  salarySettlements?: SalarySettlement[];
};

/**
 * Cancelling a shift must leave no trace: the session, its tickets and its
 * payroll settlement are removed from the local snapshot instead of being
 * flagged as cancelled and shown again in history or reports.
 */
export function purgeCancelledShift(
  state: PurgeState,
  sessionId: string,
  saleIds: Iterable<string>,
): { transactions: Transaction[]; cashSessions: CashRegisterSession[]; salarySettlements: SalarySettlement[] } {
  const cancelledSales = new Set(saleIds);
  return {
    transactions: (state.transactions || []).filter(tx => tx.sessionId !== sessionId && !cancelledSales.has(tx.id)),
    cashSessions: (state.cashSessions || []).filter(session => session.id !== sessionId),
    salarySettlements: (state.salarySettlements || []).filter(settlement => settlement.sessionId !== sessionId),
  };
}
