import type { ExcelExportData } from '../types';

export function generateSessionsSheet(data: ExcelExportData): any[][] {
  const { cashSessions = [], branches = [], transactions = [], baseCurrency, currencies = [] } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const rateByCode = new Map(currencies.map(currency => [currency.code, Number(currency.rateToBase) || 1]));

  const salesBySession = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction?.status !== 'completed' || transaction.deletedAt || String(transaction.notes || '').startsWith('AJUSTE_')) continue;
    if (!transaction.sessionId) continue;
    salesBySession.set(transaction.sessionId, (salesBySession.get(transaction.sessionId) || 0) + (Number(transaction.total) || 0));
  }

  const rows: any[][] = [
    [
      'Turno',
      'Sucursal / Almacén',
      'Cajero Responsable',
      'Apertura',
      'Cierre',
      `Fondo Inicial (${baseCode})`,
      `Ventas del Turno (${baseCode})`,
      `Efectivo Físico Declarado (${baseCode})`,
      `Saldo Teórico Esperado (${baseCode})`,
      `Diferencia / Descuadre (${baseCode})`,
      'Estado del Arqueo',
      'Estado del Turno',
      'Desglose por Moneda',
      'Movimientos de Caja',
    ],
  ];

  for (const session of cashSessions) {
    const branchName = branchById.get(session.branchId)?.name || 'Sucursal';
    const worker = session.workerName || 'Vendedor';
    const opened = new Date(session.openedAt);
    const openedDate = Number.isNaN(opened.getTime()) ? null : opened;
    const closedRaw = session.closingDate || session.closedAt;
    const closed = closedRaw ? new Date(closedRaw) : null;
    const closedDate = closed && !Number.isNaN(closed.getTime()) ? closed : null;

    const sessionSales = salesBySession.get(session.id) || 0;

    const declaredBreakdown = (session.closingBalances || [])
      .map(balance => `${(Number(balance.amount) || 0).toLocaleString('es-CU')} ${balance.currencyCode}`)
      .join(' | ') || 'Sin declarar';

    const declaredTotalBase = (session.closingBalances || []).reduce((sum, balance) => {
      const recordedRate = Number(balance.exchangeRate);
      const rate = recordedRate > 0 ? recordedRate : rateByCode.get(balance.currencyCode) || 1;
      return sum + (Number(balance.amount) || 0) * rate;
    }, 0);

    const movementsText = (session.movements || [])
      .map(movement => `${movement.type === 'income' ? '+Ingreso' : '-Egreso'}: ${movement.amount} ${movement.currencyCode} (${movement.description || 'Sin nota'})`)
      .join('; ') || 'Ninguno';

    let difference = 0;
    let differenceStatus = 'Normal';
    if (session.expectedBalance !== undefined && session.status === 'closed') {
      difference = declaredTotalBase - session.expectedBalance;
      if (Math.abs(difference) < 0.05) differenceStatus = 'Cuadrado Perfecto';
      else if (difference > 0) differenceStatus = `Sobrante (+${difference.toFixed(2)})`;
      else differenceStatus = `Faltante (${difference.toFixed(2)})`;
    }

    rows.push([
      session.turnNumber ? `#${session.turnNumber}` : session.id,
      branchName,
      worker,
      openedDate,
      closedDate,
      Number((Number(session.openingBalance) || 0).toFixed(2)),
      Number(sessionSales.toFixed(2)),
      session.status === 'closed' ? Number(declaredTotalBase.toFixed(2)) : 0,
      session.expectedBalance !== undefined ? Number((Number(session.expectedBalance) || 0).toFixed(2)) : 0,
      Number(difference.toFixed(2)),
      differenceStatus,
      session.status === 'cancelled' ? 'CANCELADA' : session.status === 'closed' ? 'CERRADA' : 'ABIERTA',
      declaredBreakdown,
      movementsText,
    ]);
  }

  return rows;
}
