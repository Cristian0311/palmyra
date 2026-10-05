import type { ExcelExportData } from "../types";

export function generateSessionsSheet(data: ExcelExportData): any[][] {
  const { cashSessions, branches, transactions, baseCurrency, currencies } = data;

  const rows: any[][] = [
    [
      'ID Turno',
      'Sucursal',
      'Cajero Responsable',
      'Fecha y Hora Apertura',
      'Fecha y Hora Cierre',
      'Fondo Inicial (' + baseCurrency.code + ')',
      'Ventas en Turno (' + baseCurrency.code + ')',
      'Efectivo Físico Declarado (' + baseCurrency.code + ')',
      'Saldo Teórico Esperado (' + baseCurrency.code + ')',
      'Diferencia / Descuadre (' + baseCurrency.code + ')',
      'Estado del Arqueo',
      'Estado del Turno',
      'Desglose por Moneda',
      'Movimientos de Caja (Ingresos/Gastos)'
    ]
  ];

  cashSessions.forEach(s => {
    const branchName = branches.find(b => b.id === s.branchId)?.name || 'Sucursal';
    const worker = s.workerName || 'Vendedor';
    const openDate = new Date(s.openedAt).toLocaleString('es-CU');
    const closeDate = s.closedAt ? new Date(s.closingDate || s.closedAt).toLocaleString('es-CU') : 'En curso (Abierta)';

    const sessionTx = transactions.filter(t => 
      t.branchId === s.branchId &&
      t.sessionId === s.id
    );
    const sessionSales = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);

    const declaredBreakdown = (s.closingBalances || []).map(b => 
      `${b.amount.toLocaleString('es-CU')} ${b.currencyCode}`
    ).join(' | ') || 'Sin declarar';

    const declaredTotalBase = (s.closingBalances || []).reduce((sum, b) => {
      const rate = currencies.find(c => c.code === b.currencyCode)?.rateToBase || 1;
      return sum + (b.amount * rate);
    }, 0);

    const movementsText = (s.movements || []).map(m => 
      `${m.type === 'income' ? '+Ingreso' : '-Egreso'}: ${m.amount} ${m.currencyCode} (${m.description || 'Sin nota'})`
    ).join('; ') || 'Ninguno';

    let diff = 0;
    let diffStatus = 'Normal';

    if (s.expectedBalance !== undefined && s.status === 'closed') {
      diff = declaredTotalBase - s.expectedBalance;
      if (Math.abs(diff) < 0.05) diffStatus = 'Cuadrado Perfecto';
      else if (diff > 0) diffStatus = `Sobrante (+${diff.toFixed(2)})`;
      else diffStatus = `Faltante (${diff.toFixed(2)})`;
    }

    rows.push([
      s.id,
      branchName,
      worker,
      openDate,
      closeDate,
      Number((s.openingBalance || 0).toFixed(2)),
      Number(sessionSales.toFixed(2)),
      s.status === 'closed' ? Number(declaredTotalBase.toFixed(2)) : 0,
      s.expectedBalance !== undefined ? Number(s.expectedBalance.toFixed(2)) : 0,
      Number(diff.toFixed(2)),
      diffStatus,
      s.status === 'cancelled' ? 'CANCELADA' : (s.status === 'closed' ? 'CERRADA' : 'ABIERTA'),
      declaredBreakdown,
      movementsText
    ]);
  });

  return rows;
}

// 5. SHEET: NÓMINA Y LIQUIDACIÓN SALARIAL
