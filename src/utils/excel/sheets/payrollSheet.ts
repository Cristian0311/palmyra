import type { ExcelExportData } from '../types';
import type { Product, SalarySettlement, Transaction, User } from '../../../types';
import { calculateEmployeeSaleCommission, findSessionEmployeeUser } from '../../../services/employeeCompensation';

interface CommissionBucket {
  name: string;
  total: number;
  products: Map<string, number>;
}

function emptyBucket(name: string): CommissionBucket {
  return { name, total: 0, products: new Map() };
}

export function generatePayrollSheet(data: ExcelExportData): any[][] {
  const { salarySettlements = [], cashSessions = [], transactions = [], products = [], baseCurrency, users = [] } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const userById = new Map(users.map(user => [user.id, user]));
  const userByEmployeeId = new Map(users.filter(user => user.employeeId).map(user => [String(user.employeeId), user]));
  const productById = new Map(products.map(product => [product.id, product]));

  const rows: any[][] = [
    [
      'Liquidación / Turno',
      'Fecha',
      'Empleado / Vendedor',
      `Salario Base (${baseCode})`,
      `Meta de Ventas (${baseCode})`,
      `Venta Total Lograda (${baseCode})`,
      '% Cumplimiento de Meta',
      `Comisiones Generadas (${baseCode})`,
      `TOTAL A PAGAR (${baseCode})`,
      'Estado de Pago',
      'Detalle de Comisiones por Producto',
    ],
  ];

  const transactionsBySession = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    if (transaction?.status !== 'completed' || transaction.deletedAt || String(transaction.notes || '').startsWith('AJUSTE_')) continue;
    if (!transaction.sessionId) continue;
    const bucket = transactionsBySession.get(transaction.sessionId);
    if (bucket) bucket.push(transaction);
    else transactionsBySession.set(transaction.sessionId, [transaction]);
  }

  const settlements = new Map<string, SalarySettlement>();
  for (const settlement of salarySettlements) {
    if (settlement?.sessionId) settlements.set(settlement.sessionId, settlement);
  }
  const usedSettlements = new Set<string>();

  const closedSessions = cashSessions.filter(session => session.status === 'closed');

  for (const session of closedSessions) {
    const settlement = settlements.get(session.id);
    if (settlement) usedSettlements.add(settlement.id);

    const sessionTransactions = transactionsBySession.get(session.id) || [];
    const sessionTotalSales = sessionTransactions.reduce((sum, transaction) => sum + (Number(transaction.total) || 0), 0);

    // Comisiones por empleado en una sola pasada (evita el O(n²) anterior).
    const commissionBuckets = new Map<string, CommissionBucket>();
    for (const transaction of sessionTransactions) {
      const sellerIds = transaction.sellerEmployeeIds?.length ? transaction.sellerEmployeeIds : [transaction.userId];
      for (const sellerId of sellerIds) {
        const employee = userById.get(sellerId) || userByEmployeeId.get(String(sellerId));
        const commission = calculateEmployeeSaleCommission(employee, transaction, products, sellerIds.length);
        const bucket = commissionBuckets.get(sellerId) || emptyBucket(employee?.name || sellerId);
        bucket.total += commission;
        for (const item of transaction.items || []) {
          const productId = typeof item.product === 'string' ? item.product : item.product?.id;
          const product: Product | undefined = productId ? productById.get(productId) : undefined;
          const snapshotName = typeof item.product === 'object' ? item.product?.name : undefined;
          const name = product?.name || snapshotName || productId || 'Producto';
          const fixedCommission = Math.max(0, Number(product?.commissionValue) || 0) * (Number(item.quantity) || 0) / Math.max(1, sellerIds.length);
          bucket.products.set(name, (bucket.products.get(name) || 0) + fixedCommission);
        }
        commissionBuckets.set(sellerId, bucket);
      }
    }

    const calculatedCommissions = [...commissionBuckets.values()].reduce((sum, bucket) => sum + bucket.total, 0);
    const baseSalary = Number(settlement?.baseSalary) || 0;
    const commissions = settlement ? Number(settlement.commissions) || 0 : calculatedCommissions;
    const totalToPay = settlement ? Number(settlement.total) || 0 : baseSalary + commissions;
    const status = settlement ? (settlement.status === 'paid' ? 'PAGADO' : settlement.status === 'cancelled' ? 'CANCELADO' : 'PENDIENTE') : 'PENDIENTE';

    // La meta debe compararse con las ventas del turno, pero sin meta no se
    // inventa un 100%: se deja 0 y se explica en la columna.
    const salesGoal = Number(settlement?.salesGoal) || 0;
    const goalPct = salesGoal > 0 ? (sessionTotalSales / salesGoal) * 100 : 0;

    const primaryEmployee = findSessionEmployeeUser(session, users);
    const primaryBucket = primaryEmployee
      ? commissionBuckets.get(primaryEmployee.id) || commissionBuckets.get(String(primaryEmployee.employeeId || ''))
      : undefined;
    const detailBucket = primaryBucket || [...commissionBuckets.values()].sort((a, b) => b.total - a.total)[0];
    const commissionDetail = detailBucket
      ? [...detailBucket.products.entries()]
          .filter(([, amount]) => amount > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([name, amount]) => `${name}: ${amount.toFixed(2)} ${baseCode}`)
          .join('; ')
      : '';

    const closingDate = session.closingDate || session.closedAt || session.openedAt;
    const date = closingDate ? new Date(closingDate) : null;

    rows.push([
      settlement?.id || (session.turnNumber ? `#${session.turnNumber}` : session.id),
      date && !Number.isNaN(date.getTime()) ? date : null,
      settlement?.userName || session.workerName || primaryEmployee?.name || 'Vendedor',
      Number(baseSalary.toFixed(2)),
      Number(salesGoal.toFixed(2)),
      Number(sessionTotalSales.toFixed(2)),
      Number(goalPct.toFixed(1)),
      Number(commissions.toFixed(2)),
      Number(totalToPay.toFixed(2)),
      status,
      commissionDetail || 'Sin comisiones especiales',
    ]);
  }

  // Liquidaciones cuyo turno ya no está en la caché local: antes desaparecían
  // del Excel aunque el pago existiera.
  for (const settlement of salarySettlements) {
    if (usedSettlements.has(settlement.id)) continue;
    const date = settlement.date ? new Date(settlement.date) : null;
    const salesGoal = Number(settlement.salesGoal) || 0;
    rows.push([
      settlement.id,
      date && !Number.isNaN(date.getTime()) ? date : null,
      settlement.userName || userById.get(settlement.userId)?.name || 'Empleado',
      Number((Number(settlement.baseSalary) || 0).toFixed(2)),
      Number(salesGoal.toFixed(2)),
      0,
      0,
      Number((Number(settlement.commissions) || 0).toFixed(2)),
      Number((Number(settlement.total) || 0).toFixed(2)),
      settlement.status === 'paid' ? 'PAGADO' : settlement.status === 'cancelled' ? 'CANCELADO' : 'PENDIENTE',
      'Sin turno asociado en la caché local',
    ]);
  }

  return rows;
}
