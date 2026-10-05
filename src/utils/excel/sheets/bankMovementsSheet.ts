import type { ExcelExportData } from "../../../types";

export function generateBankMovementsSheet(data: ExcelExportData): any[][] {
  const { bankTransactions, bankCards, currencies, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Operación',
      'Fecha',
      'Hora',
      'Banco Receptor',
      'Titular de la Cuenta',
      'Número de Tarjeta / Cuenta',
      'Teléfono SMS Confirmación',
      'Moneda Cuenta',
      'Tipo de Operación',
      'Monto Original',
      'Tasa de Conversión',
      'Equivalente en Base (' + baseCurrency.code + ')',
      'Descripción / Referencia',
      'ID Venta Asociada'
    ]
  ];

  if (bankTransactions.length === 0) {
    rows.push(['Sin movimientos bancarios registrados']);
  } else {
    bankTransactions.forEach(t => {
      const card = bankCards.find(c => c.id === t.cardId);
      const curr = currencies.find(c => c.code === card?.currency) || baseCurrency;
      const rate = curr.rateToBase || 1;
      const amountInBase = t.amount * rate;

      let typeLabel = 'Otro';
      if (t.type === 'payment_received') typeLabel = 'Cobro Venta / Transferencia';
      else if (t.type === 'deposit') typeLabel = 'Depósito / Entrada';
      else if (t.type === 'supplier_payment') typeLabel = 'Pago a Proveedor';
      else if (t.type === 'withdrawal') typeLabel = 'Retiro de Fondos';

      const tDate = new Date(t.date);
      const dateStr = tDate.toLocaleDateString('es-CU');
      const timeStr = tDate.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });

      rows.push([
        t.id,
        dateStr,
        timeStr,
        card?.bank || 'Banco',
        card?.name || 'Titular',
        card?.accountNumber || 'N/A',
        card?.phone || 'N/A',
        card?.currency || baseCurrency.code,
        typeLabel,
        Number((t.amount || 0).toFixed(2)),
        Number(rate.toFixed(4)),
        Number(amountInBase.toFixed(2)),
        t.description || 'Sin notas adicionales',
        t.transactionId || 'N/A'
      ]);
    });
  }

  return rows;
}

// 8. SHEET: DEVOLUCIONES Y GARANTÍAS
