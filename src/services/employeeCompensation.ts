import type { Product, Transaction, User, CashRegisterSession } from '../types';

export type CompensationType = 'fixed_product' | 'sales_percentage';

export function getCompensationType(employee?: User | null): CompensationType {
  return employee?.compensationType === 'sales_percentage' ? 'sales_percentage' : 'fixed_product';
}

export function getSalesPercentage(employee?: User | null): number {
  return Math.max(0, Math.min(100, Number(employee?.salesPercentage ?? employee?.commissionRate) || 0));
}

export function getFixedProductCommission(product?: Product | null): number {
  return Math.max(0, Number(product?.commissionValue) || 0);
}

export function calculateEmployeeSaleCommission(employee: User | undefined, transaction: Transaction, products: Product[], sellerCount = 1): number {
  if (!employee) return 0;
  const split = Math.max(1, sellerCount);
  if (getCompensationType(employee) === 'sales_percentage') {
    return (Math.max(0, Number(transaction.total) || 0) * getSalesPercentage(employee) / 100) / split;
  }
  return (transaction.items || []).reduce((sum, item) => {
    const productId = typeof item.product === 'string' ? item.product : item.product?.id;
    const product = products.find(p => p.id === productId);
    return sum + getFixedProductCommission(product) * Math.max(0, Number(item.quantity) || 0) / split;
  }, 0);
}

export function calculateSessionEmployeeCommission(transactions: Transaction[], employeeId: string, users: User[], products: Product[]): number {
  const employee = users.find(u => u.id === employeeId);
  if (!employee) return 0;
  return transactions.filter(tx => tx.status === 'completed' && !tx.deletedAt).reduce((sum, tx) => {
    const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
    return sellers.includes(employeeId)
      ? sum + calculateEmployeeSaleCommission(employee, tx, products, sellers.length)
      : sum;
  }, 0);
}

export function calculateSessionCommission(session: CashRegisterSession, transactions: Transaction[], users: User[], products: Product[]): number {
  const sessionTransactions = transactions.filter(tx => tx.status === 'completed' && !tx.deletedAt && tx.sessionId === session.id);
  const sellerIds = new Set<string>();
  sessionTransactions.forEach(tx => {
    (tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId]).forEach(id => sellerIds.add(id));
  });
  return Array.from(sellerIds).reduce((sum, id) => sum + calculateSessionEmployeeCommission(sessionTransactions, id, users, products), 0);
}

export function getCompensationLabel(employee?: User | null): string {
  return getCompensationType(employee) === 'sales_percentage'
    ? `Porcentaje sobre el total de la venta · ${getSalesPercentage(employee)}%`
    : 'CUP fijo por producto vendido';
}

export function getSalaryBase(employee?: User | null): number {
  if (getCompensationType(employee) === 'sales_percentage') return 0;
  return Math.max(0, Number(employee?.baseSalary) || 0);
}

export function isPercentageCompensation(employee?: User | null) {
  return getCompensationType(employee) === 'sales_percentage';
}
