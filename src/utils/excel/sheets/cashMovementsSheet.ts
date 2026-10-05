import type { ExcelExportData } from "../../../types";

export function generateCashMovementsSheet(data: ExcelExportData): any[][] {
  const { cashSessions, branches, currencies, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Movimiento',
      'Fecha y Hora',
      'ID Turno',
      'Sucursal',
      'Cajero Responsable',
      'Tipo de Operación',
      'Concepto / Descripción',
      'Importe Moneda Original',
      'Moneda',
      'Equivalente Moneda Base (' + baseCurrency.code + ')',
      'Estado del Turno'
    ]
  ];

  cashSessions.forEach(session => {
    const branchName = branches.find(b => b.id === session.branchId)?.name || 'Sucursal';
    const workerName = session.workerName || 'Cajero';

    (session.movements || []).forEach(m => {
      const dateStr = new Date(m.date).toLocaleString('es-CU');
      const rate = currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1;
      const cupEquiv = m.amount * rate;

      rows.push([
        m.id,
        dateStr,
        session.id,
        branchName,
        m.workerName || workerName,
        m.type === 'income' ? 'INGRESO (ENTRADA)' : 'EGRESO (GASTO)',
        m.description,
        Number(m.amount.toFixed(2)),
        m.currencyCode,
        Number(cupEquiv.toFixed(2)),
        session.status === 'cancelled' ? 'Turno Cancelado' : (session.status === 'closed' ? 'Turno Cerrado' : 'Turno Abierto')
      ]);
    });
  });

  return rows;
}

// SHEET: TRANSFERENCIAS DE INVENTARIO ENTRE SUCURSALES
