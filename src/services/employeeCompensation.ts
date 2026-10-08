import type { Product, Transaction, User } from '../types';

export function calculateEmployeeSaleCommission(
  employee: User | undefined,
  transaction: Transaction,
  products: Product[],
  sellerCount = 1,
): number {
  if (!employee) return 0;
  const split = Math.max(1, sellerCount);
  if (employee.compensationType === 'sales_percentage') {
    return Math.max(0, Number(transaction.total) || 0) * Math.max(0, Number(employee.salesPercentage ?? employee.commissionRate) || 0) / 100 / split;
  }
  return (transaction.items || []).reduce((sum, item) => {
    const productId = typeof item.product === 'string' ? item.product : item.product?.id;
    const product = products.find(p => p.id === productId);
    return sum + (Number(product?.commissionValue) || 0) * (Number(item.quantity) || 0) / split;
  }, 0);
}

export function isPercentageCompensation(employee?: User | null) {
  return employee?.compensationType === 'sales_percentage';
}
