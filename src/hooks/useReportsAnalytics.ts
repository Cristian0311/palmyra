import { useMemo } from 'react';
import type { Transaction, Product, CashRegisterSession, User, Branch, Currency, InventoryTransfer, Category } from '../types';

type LocalDateYMD = (dStr: string | null | undefined) => string;

export function getLocalDateYMD(dStr: string | null | undefined): string {
  if (!dStr) return '';
  const d = new Date(dStr);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function useReportsAnalytics(params: {
  transactions: Transaction[];
  products: Product[];
  categories: Category[];
  branches: Branch[];
  users: User[];
  transfers: InventoryTransfer[];
  selectedBranchFilter: string;
  selectedFilterDate: string;
  sessionFilter: 'all' | 'today' | 'yesterday' | 'custom';
  selectedWorkerFilter: string;
  transferFromFilter: string;
  transferToFilter: string;
  transferSearch: string;
}) {
  const {
    transactions, products, categories, branches, users, transfers,
    selectedBranchFilter, selectedFilterDate, sessionFilter, selectedWorkerFilter,
    transferFromFilter, transferToFilter, transferSearch
  } = params;

  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const categoryById = useMemo(() => new Map(categories.map(category => [category.id, category])), [categories]);
  const branchById = useMemo(() => new Map(branches.map(branch => [branch.id, branch])), [branches]);
  const userById = useMemo(() => new Map(users.map(user => [user.id, user])), [users]);

  const validSalesTransactions = useMemo(
    () =>
      transactions.filter(
        tx =>
          tx.status === 'completed' &&
          !tx.deletedAt &&
          !String(tx.notes || '').startsWith('AJUSTE_')
      ),
    [transactions]
  );

  const categoryData = useMemo(() => {
    const data: Record<string, number> = {};
    validSalesTransactions.forEach(tx => {
      (tx.items || []).forEach(item => {
        const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
        const prod = prodId ? productById.get(prodId) : undefined;
        const categoryId = prod?.categoryId || (typeof item.product === 'object' ? item.product?.categoryId : '') || 'unclassified';
        const category = categoryById.get(categoryId);
        const categoryName = category?.name || 'Otros';
        data[categoryName] = (data[categoryName] || 0) + (item.total || (item.price * item.quantity) || 0);
      });
    });
    return Object.entries(data)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [validSalesTransactions, productById, categoryById]);

  const hourData = useMemo(() => {
    const data: Record<number, number> = {};
    for (let i = 0; i < 24; i++) data[i] = 0;
    validSalesTransactions.forEach(tx => {
      const hour = new Date(tx.date).getHours();
      data[hour] += tx.total;
    });
    return Object.entries(data).map(([hour, total]) => ({
      hour: `${hour}:00`,
      total: Math.round(total)
    }));
  }, [validSalesTransactions]);

  const branchData = useMemo(() => {
    const data: Record<string, number> = {};
    branches.forEach(b => data[b.name] = 0);
    validSalesTransactions.forEach(tx => {
      const branch = branchById.get(tx.branchId);
      if (branch) data[branch.name] += tx.total;
    });
    return Object.entries(data).map(([name, total]) => ({ name, total }));
  }, [validSalesTransactions, branches, branchById]);

  const filteredTransfers = useMemo(() => {
    const todayYMD = getLocalDateYMD(new Date().toISOString());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayYMD = getLocalDateYMD(yesterdayDate.toISOString());

    return transfers.filter(t => {
      if (transferFromFilter !== 'all' && t.fromBranchId !== transferFromFilter) return false;
      if (transferToFilter !== 'all' && t.toBranchId !== transferToFilter) return false;
      if (selectedBranchFilter !== 'all' && t.fromBranchId !== selectedBranchFilter && t.toBranchId !== selectedBranchFilter) return false;

      const tDateYMD = getLocalDateYMD(t.date);
      if (selectedFilterDate) {
        if (tDateYMD !== selectedFilterDate) return false;
      } else if (sessionFilter === 'today') {
        if (tDateYMD !== todayYMD) return false;
      } else if (sessionFilter === 'yesterday') {
        if (tDateYMD !== yesterdayYMD) return false;
      }

      if (transferSearch.trim()) {
        const q = transferSearch.toLowerCase();
        const pName = (t.productName || '').toLowerCase();
        const vLabel = (t.variantLabel || '').toLowerCase();
        const fromN = (branchById.get(t.fromBranchId)?.name || t.fromBranchName || '').toLowerCase();
        const toN = (branchById.get(t.toBranchId)?.name || t.toBranchName || '').toLowerCase();
        if (!pName.includes(q) && !vLabel.includes(q) && !fromN.includes(q) && !toN.includes(q) && !t.id.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [transfers, transferFromFilter, transferToFilter, selectedBranchFilter, selectedFilterDate, sessionFilter, transferSearch, branchById]);

  const transferStats = useMemo(() => {
    const totalCount = filteredTransfers.length;
    const totalUnits = filteredTransfers.reduce((sum, t) => sum + (t.quantity || 0), 0);

    const originCounts: Record<string, number> = {};
    filteredTransfers.forEach(t => {
      const name = branchById.get(t.fromBranchId)?.name || t.fromBranchName || 'Origen';
      originCounts[name] = (originCounts[name] || 0) + t.quantity;
    });
    const topOrigin = Object.entries(originCounts).sort((a, b) => b[1] - a[1])[0] || ['Ninguna', 0];

    const destCounts: Record<string, number> = {};
    filteredTransfers.forEach(t => {
      const name = branchById.get(t.toBranchId)?.name || t.toBranchName || 'Destino';
      destCounts[name] = (destCounts[name] || 0) + t.quantity;
    });
    const topDest = Object.entries(destCounts).sort((a, b) => b[1] - a[1])[0] || ['Ninguna', 0];

    return { totalCount, totalUnits, topOrigin, topDest };
  }, [filteredTransfers, branchById]);

  const filteredTransactions = useMemo(() => {
    const todayYMD = getLocalDateYMD(new Date().toISOString());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayYMD = getLocalDateYMD(yesterdayDate.toISOString());

    return transactions.filter(t => {
      if (t.deletedAt) return false;
      if (selectedBranchFilter !== 'all' && t.branchId !== selectedBranchFilter) return false;
      if (selectedWorkerFilter !== 'all') {
        const directUser = userById.get(t.userId);
        const emp = directUser || users.find(u => u.name && t.cashierName && u.name.toLowerCase() === t.cashierName.toLowerCase());
        if (emp?.id !== selectedWorkerFilter && t.userId !== selectedWorkerFilter && t.cashierName !== selectedWorkerFilter) return false;
      }
      const tYMD = getLocalDateYMD(t.date);
      if (selectedFilterDate) {
        if (tYMD !== selectedFilterDate) return false;
      } else if (sessionFilter === 'today') {
        if (tYMD !== todayYMD) return false;
      } else if (sessionFilter === 'yesterday') {
        if (tYMD !== yesterdayYMD) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [transactions, selectedBranchFilter, selectedWorkerFilter, selectedFilterDate, sessionFilter, userById, users]);

  return {
    categoryData, hourData, branchData,
    filteredTransfers, transferStats,
    filteredTransactions,
  };
}