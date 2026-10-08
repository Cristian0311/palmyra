import { useMemo } from 'react';
import type {
  CashRegisterSession,
  Product,
  SalarySettlement,
  Transaction,
  User,
} from '../../types';

type PayrollRow = {
  settlementId?: string;
  sessionId: string;
  turnLabel: string;
  date: string;
  workerName: string;
  userId: string;
  branchId: string;
  baseSalary: number;
  commissions: number;
  totalSalary: number;
  totalSales: number;
  totalItems: number;
  status: 'pending' | 'paid';
  sessionTx: Transaction[];
};

type AggregatedPayrollRow = {
  userId: string;
  workerName: string;
  shiftsCount: number;
  totalSales: number;
  totalBaseSalary: number;
  totalCommissions: number;
  totalSalary: number;
  pendingSalary: number;
  paidSalary: number;
};

export function useReportsPayroll(params: {
  closedSessions: CashRegisterSession[];
  salarySettlements: SalarySettlement[];
  transactionsBySession: Map<string, Transaction[]>;
  userById: Map<string, User>;
  userByName: Map<string, User>;
  productById: Map<string, Product>;
  sessionTurnMap: Map<string, string>;
  selectedBranchFilter: string;
  selectedFilterDate: string;
  sessionFilter: 'all' | 'today' | 'yesterday' | 'custom';
  companyCompensation?: { mode: 'fixed_product' | 'sales_percent'; percentRate: number };
}) {
  const {
    closedSessions,
    salarySettlements,
    transactionsBySession,
    userById,
    userByName,
    productById,
    sessionTurnMap,
    selectedBranchFilter,
    selectedFilterDate,
    sessionFilter,
    companyCompensation = { mode: 'fixed_product', percentRate: 0 },
  } = params;

  const payrollList = useMemo<PayrollRow[]>(() => {
    const settlementMap = new Map<string, SalarySettlement>();
    salarySettlements.forEach(settlement => settlementMap.set(settlement.sessionId, settlement));

    return closedSessions.map(session => {
      const turnLabel = sessionTurnMap.get(session.id) || session.id;
      const sessionTx = transactionsBySession.get(session.id) || [];
      const totalSales = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);
      const totalItems = sessionTx.reduce(
        (sum, tx) => sum + (tx.items || []).reduce((itemsSum, item) => itemsSum + (item.quantity || 0), 0),
        0
      );

      const existing = settlementMap.get(session.id);
      const emp =
        userById.get(session.userId) ||
        (session.workerName ? userByName.get(session.workerName.trim().toLowerCase()) : undefined);
      const workerName = session.workerName || existing?.userName || emp?.name || 'Vendedor';

      let commissions = existing?.commissions || 0;
      if (!existing) {
        const sellerIds = new Set<string>();
        sessionTx.forEach(tx => (tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId]).forEach(id => sellerIds.add(id)));
        commissions = Array.from(sellerIds).reduce((sum, sellerId) => {
          return sum + sessionTx.reduce((sellerSum, tx) => {
            const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
            if (!sellers.includes(sellerId)) return sellerSum;
            const splitFactor = Math.max(1, sellers.length);
            if (companyCompensation.mode === 'sales_percent') {
              return sellerSum + (Math.max(0, Number(tx.total) || 0) * companyCompensation.percentRate / 100) / splitFactor;
            }
            const products = Array.from(productById.values());
            return sellerSum + (tx.items || []).reduce((itemSum, item) => {
              const productId = typeof item.product === 'string' ? item.product : item.product?.id;
              const product = products.find(p => p.id === productId);
              return itemSum + (Math.max(0, Number(product?.commissionValue) || 0) * Math.max(0, Number(item.quantity) || 0)) / splitFactor;
            }, 0);
          }, 0);
        }, 0);
      }

      const baseSalary = existing?.baseSalary ?? (companyCompensation.mode === 'sales_percent' ? 0 : Math.max(0, Number(emp?.baseSalary) || 0));
      const totalSalary = existing?.total ?? (baseSalary + commissions);
      const status = existing?.status === 'paid' ? 'paid' : 'pending';
      const date = existing?.date || session.closingDate || session.closedAt || session.openedAt;

      return {
        settlementId: existing?.id,
        sessionId: session.id,
        turnLabel,
        date,
        workerName,
        userId: session.userId,
        branchId: session.branchId,
        baseSalary,
        commissions,
        totalSalary,
        totalSales,
        totalItems,
        status,
        sessionTx,
      };
    });
  }, [
    closedSessions,
    salarySettlements,
    transactionsBySession,
    userById,
    userByName,
    productById,
    sessionTurnMap,
    companyCompensation,
  ]);

  const filteredPayrollList = useMemo(
    () =>
      payrollList.filter(item => {
        if (selectedBranchFilter !== 'all' && item.branchId !== selectedBranchFilter) return false;

        const dateObj = new Date(item.date);
        if (selectedFilterDate) {
          return dateObj.toISOString().split('T')[0] === selectedFilterDate;
        }
        if (sessionFilter === 'today') {
          return dateObj.toLocaleDateString() === new Date().toLocaleDateString();
        }
        return true;
      }),
    [payrollList, selectedBranchFilter, selectedFilterDate, sessionFilter]
  );

  const aggregatedPayrollByWorker = useMemo<AggregatedPayrollRow[]>(() => {
    const map = new Map<string, AggregatedPayrollRow>();

    filteredPayrollList.forEach(item => {
      const key = item.workerName;
      if (!map.has(key)) {
        map.set(key, {
          userId: item.userId,
          workerName: item.workerName,
          shiftsCount: 0,
          totalSales: 0,
          totalBaseSalary: 0,
          totalCommissions: 0,
          totalSalary: 0,
          pendingSalary: 0,
          paidSalary: 0,
        });
      }

      const aggregate = map.get(key)!;
      aggregate.shiftsCount += 1;
      aggregate.totalSales += item.totalSales;
      aggregate.totalBaseSalary += item.baseSalary;
      aggregate.totalCommissions += item.commissions;
      aggregate.totalSalary += item.totalSalary;
      if (item.status === 'paid') aggregate.paidSalary += item.totalSalary;
      else aggregate.pendingSalary += item.totalSalary;
    });

    return Array.from(map.values());
  }, [filteredPayrollList]);

  return { payrollList, filteredPayrollList, aggregatedPayrollByWorker };
}
