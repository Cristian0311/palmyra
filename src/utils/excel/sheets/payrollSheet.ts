import type { ExcelExportData } from "../types";
import type { SalarySettlement } from "../../../types";

export function generatePayrollSheet(data: ExcelExportData): any[][] {
  const { salarySettlements, cashSessions, transactions, products, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Liquidación / Turno',
      'Fecha',
      'Empleado / Vendedor',
      'Salario Base (' + baseCurrency.code + ')',
      'Meta de Ventas (' + baseCurrency.code + ')',
      'Venta Total Lograda (' + baseCurrency.code + ')',
      '% Cumplimiento de Meta',
      'Comisiones Generadas (' + baseCurrency.code + ')',
      'TOTAL A PAGAR (' + baseCurrency.code + ')',
      'Estado de Pago',
      'Detalle de Comisiones por Producto'
    ]
  ];

  const settlementMap = new Map<string, SalarySettlement>();
  salarySettlements.forEach(st => settlementMap.set(st.sessionId, st));

  cashSessions.filter(s => s.status === 'closed').forEach(session => {
    const st = settlementMap.get(session.id);
    const sessionTx = transactions.filter(t => 
      t.branchId === session.branchId &&
      t.sessionId === session.id
    );
    const sessionTotalSales = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);

    const commissionDetail: string[] = [];
    let calculatedCommissions = 0;

    sessionTx.forEach(tx => {
      tx.items.forEach(item => {
        const prodId = typeof item.product === 'string' ? item.product : item.product.id;
        const prod = products.find(p => p.id === prodId);
        if (prod && (prod.commissionValue || 0) > 0) {
          const comm = prod.commissionType === 'percentage'
            ? (prod.price * (prod.commissionValue || 0) / 100) * item.quantity
            : (prod.commissionValue || 0) * item.quantity;
          calculatedCommissions += comm;
          commissionDetail.push(`${item.quantity}x ${prod.name}: +${comm.toFixed(2)}`);
        }
      });
    });

    const baseSalary = st ? st.baseSalary : 0;
    const commissions = st ? st.commissions : calculatedCommissions;
    const totalToPay = st ? st.total : (baseSalary + commissions);
    const status = st ? (st.status === 'paid' ? 'PAGADO' : 'PENDIENTE') : 'PENDIENTE';
    const salesGoal = st?.salesGoal || 0;
    const goalPct = salesGoal > 0 ? (sessionTotalSales / salesGoal) * 100 : 100;
    const dateStr = new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleDateString('es-CU');

    rows.push([
      st?.id || session.id,
      dateStr,
      session.workerName || 'Vendedor',
      Number(baseSalary.toFixed(2)),
      Number(salesGoal.toFixed(2)),
      Number(sessionTotalSales.toFixed(2)),
      Number(goalPct.toFixed(1)),
      Number(commissions.toFixed(2)),
      Number(totalToPay.toFixed(2)),
      status,
      commissionDetail.slice(0, 6).join('; ') || 'Sin comisiones especiales'
    ]);
  });

  return rows;
}

// 6. SHEET: CATÁLOGO, INVENTARIO Y RENDIMIENTO DE PRODUCTOS
