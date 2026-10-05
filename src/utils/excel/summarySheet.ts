import type { ExcelExportData } from './types';

export function generateSummarySheet(data: ExcelExportData): any[][] {
  const { 
    businessName = 'PALMYRA POS', transactions, cashSessions, 
    currencies, baseCurrency, dateFilterLabel = 'Todo el historial',
    bankTransactions, bankCards 
  } = data;

  const totalSales = transactions.reduce((sum, t) => sum + (t.total || 0), 0);
  const totalItemsSold = transactions.reduce((sum, t) => 
    sum + t.items.reduce((isum, i) => isum + (i.quantity || 0), 0)
  , 0);

  const allMovements = cashSessions.flatMap(s => s.movements || []);
  const totalCashIncomes = allMovements.filter(m => m.type === 'income').reduce((s, m) => {
    const rate = currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1;
    return s + (m.amount * rate);
  }, 0);

  const totalCashExpenses = allMovements.filter(m => m.type === 'expense').reduce((s, m) => {
    const rate = currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1;
    return s + (m.amount * rate);
  }, 0);

  const bankPaymentsReceived = bankTransactions.filter(t => t.type === 'payment_received').reduce((sum, t) => {
    const card = bankCards.find(c => c.id === t.cardId);
    const rate = currencies.find(c => c.code === card?.currency)?.rateToBase || 1;
    return sum + (t.amount * rate);
  }, 0);

  const bankOtherDeposits = bankTransactions.filter(t => t.type === 'deposit').reduce((sum, t) => {
    const card = bankCards.find(c => c.id === t.cardId);
    const rate = currencies.find(c => c.code === card?.currency)?.rateToBase || 1;
    return sum + (t.amount * rate);
  }, 0);

  const bankSupplierPayments = bankTransactions.filter(t => t.type === 'supplier_payment').reduce((sum, t) => {
    const card = bankCards.find(c => c.id === t.cardId);
    const rate = currencies.find(c => c.code === card?.currency)?.rateToBase || 1;
    return sum + (t.amount * rate);
  }, 0);

  const bankOtherWithdrawals = bankTransactions.filter(t => t.type === 'withdrawal').reduce((sum, t) => {
    const card = bankCards.find(c => c.id === t.cardId);
    const rate = currencies.find(c => c.code === card?.currency)?.rateToBase || 1;
    return sum + (t.amount * rate);
  }, 0);

  const totalBankIncomes = bankPaymentsReceived + bankOtherDeposits;
  const totalBankExpenses = bankSupplierPayments + bankOtherWithdrawals;
  const netFlow = totalSales + totalCashIncomes + totalBankIncomes - totalCashExpenses - totalBankExpenses;
  const avgTicket = transactions.length > 0 ? totalSales / transactions.length : 0;

  const rows: any[][] = [
    [`REPORTE FINANCIERO Y EJECUTIVO - ${businessName.toUpperCase()}`],
    [`Generado el: ${new Date().toLocaleString('es-CU')} | Periodo: ${dateFilterLabel}`],
    [`Moneda Base de Conversión: ${baseCurrency.code} (${baseCurrency.symbol})`],
    [],
    ['=== INDICADORES CLAVE DE RENDIMIENTO (KPIs) ==='],
    ['Categoría', 'Indicador Financiero', 'Monto en Moneda Base (' + baseCurrency.code + ')', 'Detalle Operativo'],
    ['Ventas', 'Total Facturado en Ventas', Number(totalSales.toFixed(2)), `${transactions.length} transacciones registradas`],
    ['Ventas', 'Ticket Promedio por Venta', Number(avgTicket.toFixed(2)), 'Promedio por comprobante'],
    ['Ventas', 'Volumen de Artículos Vendidos', totalItemsSold, 'Unidades físicas despachadas'],
    ['Caja', 'Entradas Extraordinarias de Caja', Number(totalCashIncomes.toFixed(2)), 'Fondos directos aportados a caja'],
    ['Caja', 'Gastos Operativos Retirados de Caja', Number(totalCashExpenses.toFixed(2)), 'Gastos pagados en efectivo'],
    ['Bancos', 'Cobros y Depósitos Bancarios', Number(totalBankIncomes.toFixed(2)), 'Entradas a cuentas Transfermóvil/EnZona'],
    ['Bancos', 'Pagos a Proveedores y Retiros', Number(totalBankExpenses.toFixed(2)), 'Salidas de cuentas bancarias'],
    ['Balance', 'Flujo Neto Operativo Estimado', Number(netFlow.toFixed(2)), 'Balance consolidado del periodo'],
    [],
    ['=== DESGLOSE DE COBROS POR MONEDA Y MÉTODO DE PAGO ==='],
    ['Moneda', 'Símbolo', 'Tasa de Conversión', 'Efectivo Recibido', 'Transferencias Recibidas', 'Total Moneda Original', 'Total Equivalente Base (' + baseCurrency.code + ')']
  ];

  currencies.forEach(c => {
    const cashTotal = transactions.reduce((sum, tx) => {
      const payment = tx.payments.find(p => p.currencyCode === c.code && p.method === 'cash');
      const change = tx.changePayments?.find(cp => cp.currencyCode === c.code && cp.method === 'cash');
      return sum + (payment?.amount || 0) - (change?.amount || 0);
    }, 0);

    const transferTotal = transactions.reduce((sum, tx) => {
      const payment = tx.payments.find(p => p.currencyCode === c.code && p.method === 'transfer');
      const change = tx.changePayments?.find(cp => cp.currencyCode === c.code && cp.method === 'transfer');
      return sum + (payment?.amount || 0) - (change?.amount || 0);
    }, 0);

    const totalOriginal = cashTotal + transferTotal;
    const totalInBase = totalOriginal * (c.rateToBase || 1);

    if (totalOriginal !== 0 || c.isBase) {
      rows.push([
        c.code,
        c.symbol,
        c.isBase ? 1 : Number((c.rateToBase || 1).toFixed(4)),
        Number(cashTotal.toFixed(2)),
        Number(transferTotal.toFixed(2)),
        Number(totalOriginal.toFixed(2)),
        Number(totalInBase.toFixed(2))
      ]);
    }
  });

  return rows;
}