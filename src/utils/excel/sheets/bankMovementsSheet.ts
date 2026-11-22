import type { ExcelExportData } from "../types";

const TYPE_LABELS: Record<string, string> = {
  payment_received: 'Cobro de Venta / Transferencia',
  deposit: 'Depósito / Entrada',
  supplier_payment: 'Pago a Proveedor',
  withdrawal: 'Retiro de Fondos',
};

export function generateBankMovementsSheet(data: ExcelExportData): any[][] {
  const { bankTransactions = [], bankCards = [], currencies = [], baseCurrency } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const cardById = new Map(bankCards.map(card => [card.id, card]));
  const rateByCode = new Map<string, number>(currencies.map(currency => [currency.code, Number(currency.rateToBase) || 1]));

  const rows: any[][] = [
    [
      'ID Operación',
      'Fecha',
      'Banco',
      'Titular de la Cuenta',
      'Número de Tarjeta / Cuenta',
      'Teléfono Confirmación',
      'Moneda Cuenta',
      'Tipo de Operación',
      `Monto Original`,
      'Tasa de Cambio',
      `Equivalente en Base (${baseCode})`,
      'Descripción / Referencia',
      'Venta Asociada',
      'Dirección del Flujo',
    ],
  ];

  const sorted = [...bankTransactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  for (const transaction of sorted) {
    const card = cardById.get(transaction.cardId);
    const currencyCode = card?.currency || baseCode;
    const rate = rateByCode.get(currencyCode) || 1;
    const amount = Number(transaction.amount) || 0;
    const amountInBase = amount * rate;
    const type = transaction.type || 'deposit';
    const inflow = type === 'payment_received' || type === 'deposit';
    const date = new Date(transaction.date);

    rows.push([
      transaction.id,
      Number.isNaN(date.getTime()) ? null : date,
      card?.bank || card?.bankName || 'Banco',
      card?.name || card?.cardHolder || 'Titular',
      card?.accountNumber || (card?.lastFour ? `****${card.lastFour}` : card?.lastFourDigits ? `****${card.lastFourDigits}` : 'N/A'),
      card?.phone || 'N/A',
      currencyCode,
      TYPE_LABELS[type] || 'Otra operación',
      Number(amount.toFixed(2)),
      Number(rate.toFixed(4)),
      Number(amountInBase.toFixed(2)),
      transaction.description || 'Sin notas adicionales',
      transaction.transactionId || 'N/A',
      inflow ? 'ENTRADA' : 'SALIDA',
    ]);
  }

  return rows;
}
