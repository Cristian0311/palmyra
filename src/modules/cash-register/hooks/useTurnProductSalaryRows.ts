import { useMemo } from 'react';
import type { Product, Transaction, User, CashRegisterSession } from '../../../types';

export function useTurnProductSalaryRows(session: CashRegisterSession | null, transactions: Transaction[], currentBranchId: string, products: Product[], users: User[]) {
  const turnProductSalaryRows = useMemo(() => {
    if (!session) return [];

    type SalaryRow = {
      key: string;
      employeeId: string;
      employeeName: string;
      productId: string;
      name: string;
      quantity: number;
      salaryPerUnit: number;
      salaryTotal: number;
    };

    const rows = new Map<string, SalaryRow>();
    const productCatalog = products || [];

    transactions
      .filter(tx =>
        tx.branchId === currentBranchId &&
        tx.status === 'completed' &&
        !tx.deletedAt &&
        new Date(tx.date) >= new Date(session.openedAt) &&
        (!tx.sessionId || tx.sessionId === session.id)
      )
      .forEach(tx => {
        const sellers = tx.sellerEmployeeIds && tx.sellerEmployeeIds.length > 0
          ? tx.sellerEmployeeIds
          : [tx.userId];
        const splitFactor = Math.max(1, sellers.length);

        tx.items.forEach(item => {
          const rawItem = item as any;
          const rawProduct = rawItem.product ?? rawItem.productId ?? rawItem.id;
          const product = typeof rawProduct === 'string'
            ? productCatalog.find(p => p.id === rawProduct)
            : rawProduct;

          const productId = product?.id || (typeof rawProduct === 'string' ? rawProduct : 'unknown');
          const name = product?.name || (typeof rawProduct === 'string' ? rawProduct : 'Producto vendido');
          const quantity = Number(rawItem.quantity || 0);
          if (!productId || quantity <= 0) return;

          // commissionValue es la comisión FIJA en CUP por unidad.
          // Nunca usar el precio final de venta para calcular el salario.
          const commissionValue = Number(
            product?.commissionValue ??
            rawItem.product_snapshot?.commissionValue ??
            rawItem.commissionValue ??
            0
          ) || 0;
          const unitCommission = commissionValue;
          const salaryPerUnitForSeller = unitCommission / splitFactor;

          sellers.forEach((sellerId: string) => {
            const employee = users.find(u => u.id === sellerId);
            const employeeName = employee?.name || tx.cashierName || sellerId || 'Empleado';
            const key = `${sellerId}-${productId}`;
            const current = rows.get(key);

            if (current) {
              current.quantity += quantity;
              current.salaryTotal += salaryPerUnitForSeller * quantity;
              current.salaryPerUnit = current.quantity > 0
                ? current.salaryTotal / current.quantity
                : 0;
            } else {
              rows.set(key, {
                key,
                employeeId: sellerId,
                employeeName,
                productId,
                name,
                quantity,
                salaryPerUnit: salaryPerUnitForSeller,
                salaryTotal: salaryPerUnitForSeller * quantity
              });
            }
          });
        });
      });

    return Array.from(rows.values()).sort((a, b) =>
      a.employeeName.localeCompare(b.employeeName) || b.quantity - a.quantity
    );
  }, [session, transactions, currentBranchId, products, users]);

  return turnProductSalaryRows;
}
