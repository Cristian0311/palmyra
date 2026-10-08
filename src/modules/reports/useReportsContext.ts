import { useMemo } from 'react';
import type {
  BankCard,
  BankTransaction,
  CashRegisterSession,
  Category,
  Customer,
  Currency,
  InventoryLevel,
  Product,
  SalarySettlement,
  SupplierOrder,
  Transaction,
  User,
  Warranty,
  ReturnItem,
  InventoryTransfer,
} from '../../types';

type Params = {
  transactions: Transaction[];
  cashSessions: CashRegisterSession[];
  users: User[];
  branches: { id: string; name: string; [key: string]: any }[];
  currencies: Currency[];
  warranties: Warranty[];
  returns: ReturnItem[];
  supplierOrders: SupplierOrder[];
  products: Product[];
  inventory: InventoryLevel[];
  transfers: InventoryTransfer[];
  bankTransactions: BankTransaction[];
  bankCards: BankCard[];
  customers: Customer[];
  categories: Category[];
  salarySettlements: SalarySettlement[];
  getBaseCurrency?: () => Currency;
};

export function useReportsContext({
  transactions,
  cashSessions,
  users,
  branches,
  currencies,
  warranties,
  returns,
  supplierOrders,
  products,
  inventory,
  transfers,
  bankTransactions,
  bankCards,
  customers,
  categories,
  salarySettlements,
  getBaseCurrency,
}: Params) {
  const currencyByCode = useMemo(
    () => new Map<string, Currency>(currencies.map(currency => [currency.code, currency])),
    [currencies]
  );
  const userById = useMemo(() => new Map(users.map(user => [user.id, user])), [users]);
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const branchById = useMemo(() => new Map(branches.map(branch => [branch.id, branch])), [branches]);
  const bankCardById = useMemo(() => new Map(bankCards.map(card => [card.id, card])), [bankCards]);

  const userByName = useMemo(() => {
    const map = new Map<string, User>();
    users.forEach(user => {
      if (user.name) map.set(user.name.trim().toLowerCase(), user);
    });
    return map;
  }, [users]);

  const transactionsBySession = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of transactions) {
      if (!tx.sessionId) continue;
      const list = map.get(tx.sessionId);
      if (list) list.push(tx);
      else map.set(tx.sessionId, [tx]);
    }
    return map;
  }, [transactions]);

  const baseCurrency =
    getBaseCurrency?.() ||
    currencyByCode.get('CUP') ||
    currencies.find(c => c.isBase) ||
    currencies[0] ||
    { code: 'CUP', name: 'Peso Cubano', symbol: '$', rateToBase: 1, isBase: true };

  // Los KPIs comerciales solo deben contar ventas realmente completadas.
  // Los AJUSTE_* son regularizaciones de auditoría/inventario y nunca representan
  // una venta nueva; las operaciones anuladas o pendientes tampoco deben inflar
  // ingresos, flujo neto ni el contador de tickets.
  const validSalesTransactions = transactions.filter(
    t =>
      t?.status === 'completed' &&
      !t.deletedAt &&
      !String(t.notes || '').startsWith('AJUSTE_')
  );
  const totalSales = validSalesTransactions.reduce(
    (sum, t) => sum + Math.max(0, Number(t?.total) || 0),
    0
  );
  const allMovements = cashSessions.flatMap(s => s.movements || []);

  const totalCashIncomes = allMovements
    .filter(m => m.type === 'income')
    .reduce((sum, movement) => sum + movement.amount * (currencyByCode.get(movement.currencyCode)?.rateToBase || 1), 0);

  const totalCashExpenses = allMovements
    .filter(m => m.type === 'expense')
    .reduce((sum, movement) => sum + movement.amount * (currencyByCode.get(movement.currencyCode)?.rateToBase || 1), 0);

  const bankPaymentsReceived = bankTransactions
    .filter(t => t.type === 'payment_received')
    .reduce((sum, transaction) => {
      const card = bankCardById.get(transaction.cardId);
      const rate = currencyByCode.get(card?.currency || '')?.rateToBase || 1;
      return sum + transaction.amount * rate;
    }, 0);

  const bankOtherDeposits = bankTransactions
    .filter(t => t.type === 'deposit')
    .reduce((sum, transaction) => {
      const card = bankCards.find(c => c.id === transaction.cardId);
      const rate = currencies.find(c => c.code === card?.currency)?.rateToBase || 1;
      return sum + transaction.amount * rate;
    }, 0);

  const bankSupplierPayments = bankTransactions
    .filter(t => t.type === 'supplier_payment')
    .reduce((sum, transaction) => {
      const card = bankCards.find(c => c.id === transaction.cardId);
      const rate = currencies.find(c => c.code === card?.currency)?.rateToBase || 1;
      return sum + transaction.amount * rate;
    }, 0);

  const bankOtherWithdrawals = bankTransactions
    .filter(t => t.type === 'withdrawal')
    .reduce((sum, transaction) => {
      const card = bankCards.find(c => c.id === transaction.cardId);
      const rate = currencies.find(c => c.code === card?.currency)?.rateToBase || 1;
      return sum + transaction.amount * rate;
    }, 0);

  const totalBankDeposits = bankPaymentsReceived + bankOtherDeposits;
  const totalBankWithdrawals = bankSupplierPayments + bankOtherWithdrawals;
  const totalIncomes = totalCashIncomes + bankOtherDeposits;
  const totalExpenses = totalCashExpenses + totalBankWithdrawals;
  const netFlow = totalSales + totalIncomes - totalExpenses;
  const txCount = validSalesTransactions.length;

  const formatMoney = (amount: number, code: string = baseCurrency.code) => {
    const currency = currencyByCode.get(code) || baseCurrency;
    const hasDecimals = amount % 1 !== 0;
    const formatted = amount.toLocaleString('es-CU', {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2,
    });
    return `${currency.symbol}${formatted} ${currency.code}`;
  };

  const getProductName = (itemProduct: unknown) => {
    if (!itemProduct) return 'Desconocido';
    if (typeof itemProduct === 'string') {
      return productById.get(itemProduct)?.name || itemProduct;
    }
    const product = itemProduct as { name?: string };
    return product.name || 'Desconocido';
  };

  return {
    currencyByCode,
    userById,
    productById,
    branchById,
    bankCardById,
    userByName,
    transactionsBySession,
    baseCurrency,
    totalSales,
    allMovements,
    totalCashIncomes,
    totalCashExpenses,
    bankPaymentsReceived,
    bankOtherDeposits,
    bankSupplierPayments,
    bankOtherWithdrawals,
    totalBankDeposits,
    totalBankWithdrawals,
    totalIncomes,
    totalExpenses,
    netFlow,
    txCount,
    formatMoney,
    getProductName,
  };
}
