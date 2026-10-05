import type { ExcelExportData } from './types';

export function generateSalesSheet(data: ExcelExportData): any[][] {
  const { transactions, customers, users, branches, baseCurrency, currencies } = data;

  const rows: any[][] = [
    [
      'ID Ticket',
      'Fecha',
      'Hora',
      'Sucursal',
      'Turno / Sesión',
      'Vendedor / Cajero',
      'Cliente',
      'Teléfono Cliente',
      'Cantidad Items',
      'Subtotal Venta',
      'Impuestos',
      'Total Venta (' + baseCurrency.code + ')',
      'Cobrado en Efectivo (' + baseCurrency.code + ')',
      'Cobrado en Transferencia (' + baseCurrency.code + ')',
      'Vuelto Entregado (' + baseCurrency.code + ')',
      'Detalle de Pagos Utilizados',
      'Estado',
      'Notas / Observaciones'
    ]
  ];

  transactions.forEach(t => {
    const branchName = branches.find(b => b.id === t.branchId)?.name || 'Sucursal Principal';
    const seller = users.find(u => u.id === t.userId)?.name || 'Cajero';
    const customer = customers.find(c => c.id === t.customerId);
    const customerName = customer?.name || 'Consumidor Final';
    const customerPhone = customer?.phone || 'N/A';

    const tDate = new Date(t.date);
    const dateStr = tDate.toLocaleDateString('es-CU');
    const timeStr = tDate.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Calculate cash and transfer received in base currency
    let cashPaidInBase = 0;
    let transferPaidInBase = 0;

    (t.payments || []).forEach(p => {
      const rate = currencies.find(c => c.code === p.currencyCode)?.rateToBase || 1;
      const amtBase = p.amount * rate;
      if (p.method === 'cash') cashPaidInBase += amtBase;
      else if (p.method === 'transfer') transferPaidInBase += amtBase;
    });

    let changeGivenInBase = t.changeGiven || 0;
    if (t.changePayments && t.changePayments.length > 0) {
      changeGivenInBase = t.changePayments.reduce((s, cp) => {
        const rate = currencies.find(c => c.code === cp.currencyCode)?.rateToBase || 1;
        return s + (cp.amount * rate);
      }, 0);
    }

    const paymentsSummary = (t.payments || []).map(p => 
      `${p.method === 'cash' ? 'Efectivo' : 'Transferencia'}: ${p.amount.toLocaleString('es-CU')} ${p.currencyCode}`
    ).join(' | ');

    const itemsCount = t.items.reduce((s, i) => s + (i.quantity || 0), 0);

    rows.push([
      t.id,
      dateStr,
      timeStr,
      branchName,
      t.sessionId || 'Sin Turno',
      seller,
      customerName,
      customerPhone,
      itemsCount,
      Number((t.subtotal || 0).toFixed(2)),
      Number((t.tax || 0).toFixed(2)),
      Number((t.total || 0).toFixed(2)),
      Number(cashPaidInBase.toFixed(2)),
      Number(transferPaidInBase.toFixed(2)),
      Number(changeGivenInBase.toFixed(2)),
      paymentsSummary,
      t.status === 'completed' ? 'Completada' : (t.status === 'refunded' ? 'Reembolsada' : 'Parcial'),
      (t as any).notes || (t as any).receiptNotes || ''
    ]);
  });

  return rows;
}