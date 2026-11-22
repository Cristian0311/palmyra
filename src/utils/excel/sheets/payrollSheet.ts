import type { ExcelExportData } from '../types';
import type { Product, SalarySettlement, Transaction, User } from '../../../types';
import { findSessionEmployeeUser } from '../../../services/employeeCompensation';

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
  const compensation = data.companyCompensation || { mode: 'fixed_product' as const, percentRate: 0 };
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
  // Tickets heredados sin sessionId: se adjudican por sucursal y ventana del
  // turno, igual que hace la pestaña de Nómina. Antes se descartaban y el Excel
  // mostraba ventas y comisiones en cero para esos turnos.
  const unlinkedTransactions: Transaction[] = [];
  for (const transaction of transactions) {
    if (transaction?.status !== 'completed' || transaction.deletedAt || String(transaction.notes || '').startsWith('AJUSTE_')) continue;
    if (!transaction.sessionId) { unlinkedTransactions.push(transaction); continue; }
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

    const sessionTransactions = [
      ...(transactionsBySession.get(session.id) || []),
      ...unlinkedTransactions.filter(transaction => {
        if (transaction.branchId !== session.branchId) return false;
        const at = new Date(transaction.date).getTime();
        const openedAt = new Date(session.openedAt).getTime();
        const closedAt = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;
        return Number.isFinite(at) && at >= openedAt && at <= closedAt;
      }),
    ];
    const sessionTotalSales = sessionTransactions.reduce((sum, transaction) => sum + (Number(transaction.total) || 0), 0);
    // Solo comisionan los vendedores imputados al turno; el resto se liquida en
    // su propio turno y antes inflaba el total de esta fila.
    const eligibleSellerIds = new Set<string>(
      [session.userId, session.employeeId || '', ...(session.workingEmployeeIds || [])].filter(Boolean),
    );

    // Comisiones por empleado en una sola pasada (evita el O(n²) anterior) y con
    // el mismo criterio que la pestaña de Nómina: porcentaje global o comisión
    // por producto, repartida entre los vendedores del ticket.
    const commissionBuckets = new Map<string, CommissionBucket>();
    for (const transaction of sessionTransactions) {
      const sellerIds = transaction.sellerEmployeeIds?.length ? transaction.sellerEmployeeIds : [transaction.userId];
      const splitFactor = Math.max(1, sellerIds.length);
      for (const sellerId of sellerIds) {
        if (!eligibleSellerIds.has(sellerId)) continue;
        const employee = userById.get(sellerId) || userByEmployeeId.get(String(sellerId));
        const bucket = commissionBuckets.get(sellerId) || emptyBucket(employee?.name || sellerId);
        if (compensation.mode === 'sales_percent') {
          const amount = (Math.max(0, Number(transaction.total) || 0) * compensation.percentRate / 100) / splitFactor;
          const label = `% sobre ventas (${compensation.percentRate}%)`;
          bucket.total += amount;
          bucket.products.set(label, (bucket.products.get(label) || 0) + amount);
        } else {
          for (const item of transaction.items || []) {
            const snapshot = typeof item.product === 'object' ? item.product : undefined;
            const productId = typeof item.product === 'string' ? item.product : item.product?.id;
            const product: Product | undefined = productId ? productById.get(productId) : undefined;
            const name = product?.name || snapshot?.name || productId || 'Producto';
            const commissionValue = Math.max(0, Number(
              product?.commissionValue ??
              (snapshot as any)?.commissionValue ??
              (item as any).product_snapshot?.commissionValue ??
              (item as any).commissionValue ?? 0,
            ));
            const amount = commissionValue * Math.max(0, Number(item.quantity) || 0) / splitFactor;
            bucket.total += amount;
            bucket.products.set(name, (bucket.products.get(name) || 0) + amount);
          }
        }
        commissionBuckets.set(sellerId, bucket);
      }
    }

    const calculatedCommissions = [...commissionBuckets.values()].reduce((sum, bucket) => sum + bucket.total, 0);
    const primaryEmployee = findSessionEmployeeUser(session, users);
    // Sin liquidación guardada, la base sale del empleado (o 0 en modo
    // porcentaje) y se descuenta el faltante aplicado al turno, igual que en la
    // pestaña de Nómina. Antes el Excel mostraba base 0 y total 0.
    const baseSalary = settlement
      ? Number(settlement.baseSalary) || 0
      : compensation.mode === 'sales_percent'
        ? 0
        : Math.max(0, Number(primaryEmployee?.baseSalary) || 0);
    const commissions = settlement ? Number(settlement.commissions) || 0 : calculatedCommissions;
    const deduction = settlement ? 0 : Math.max(0, Number(session.discrepancyDeductionApplied) || 0);
    const totalToPay = settlement
      ? Number(settlement.total) || 0
      : Math.max(0, baseSalary + commissions - deduction);
    const status = settlement ? (settlement.status === 'paid' ? 'PAGADO' : settlement.status === 'cancelled' ? 'CANCELADO' : 'PENDIENTE') : 'PENDIENTE';

    // La meta debe compararse con las ventas del turno, pero sin meta no se
    // inventa un 100%: se deja 0 y se explica en la columna.
    const salesGoal = Number(settlement?.salesGoal) || 0;
    const goalPct = salesGoal > 0 ? (sessionTotalSales / salesGoal) * 100 : 0;

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
