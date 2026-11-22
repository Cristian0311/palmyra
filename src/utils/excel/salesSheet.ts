import type { ExcelExportData } from './types';
import { completedSales } from './summarySheet';

function formatMoneyLabel(amount: number, currencyCode: string): string {
  return `${(Number(amount) || 0).toLocaleString('es-CU', { maximumFractionDigits: 2 })} ${currencyCode}`;
}

export function generateSalesSheet(data: ExcelExportData): any[][] {
  const { customers = [], users = [], branches = [], baseCurrency, currencies = [], cashSessions = [] } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const userById = new Map(users.map(user => [user.id, user]));
  const customerById = new Map(customers.map(customer => [customer.id, customer]));
  const sessionById = new Map(cashSessions.map(session => [session.id, session]));
  const rateByCode = new Map(currencies.map(currency => [currency.code, Number(currency.rateToBase) || 1]));

  const rows: any[][] = [
    [
      'Ticket',
      'Fecha y Hora',
      'Sucursal / Almacén',
      'Turno / Sesión',
      'Vendedor / Cajero',
      'Cliente',
      'Teléfono Cliente',
      'NCF',
      'Unidades',
      `Subtotal (${baseCode})`,
      `Impuestos (${baseCode})`,
      `Descuento (${baseCode})`,
      `Total Venta (${baseCode})`,
      `Cobrado Efectivo (${baseCode})`,
      `Cobrado Transferencia (${baseCode})`,
      `Vuelto Entregado (${baseCode})`,
      'Detalle de Pagos',
      'Estado',
      'Notas / Observaciones',
    ],
  ];

  // Solo ventas completadas vigentes: los ajustes de auditoría y los tickets
  // anulados viven en sus propias hojas para que los totales reconcilien.
  const sales = completedSales(data).slice().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  for (const transaction of sales) {
    const branchName = branchById.get(transaction.branchId)?.name || 'Sucursal Principal';
    const seller = userById.get(transaction.userId)?.name || transaction.cashierName || 'Cajero';
    const customer = transaction.customerId ? customerById.get(transaction.customerId) : undefined;
    const session = transaction.sessionId ? sessionById.get(transaction.sessionId) : undefined;
    const sessionLabel = session
      ? `Turno ${session.turnNumber ? `#${session.turnNumber}` : session.id}`
      : transaction.sessionId || 'Sin turno';

    const date = new Date(transaction.date);
    const safeDate = Number.isNaN(date.getTime()) ? null : date;

    let cashPaidInBase = 0;
    let transferPaidInBase = 0;
    for (const payment of transaction.payments || []) {
      const recordedRate = Number(payment.exchangeRate);
      const rate = recordedRate > 0 ? recordedRate : rateByCode.get(payment.currencyCode) || 1;
      const amountInBase = (Number(payment.amount) || 0) * rate;
      if (payment.method === 'cash') cashPaidInBase += amountInBase;
      else if (payment.method === 'transfer') transferPaidInBase += amountInBase;
    }

    let changeGivenInBase = Number(transaction.changeGiven) || 0;
    if (transaction.changePayments && transaction.changePayments.length > 0) {
      changeGivenInBase = transaction.changePayments.reduce((sum, change) => {
        const recordedRate = Number(change.exchangeRate);
        const rate = recordedRate > 0 ? recordedRate : rateByCode.get(change.currencyCode) || 1;
        return sum + (Number(change.amount) || 0) * rate;
      }, 0);
    }

    const paymentsSummary = (transaction.payments || [])
      .map(payment => `${payment.method === 'cash' ? 'Efectivo' : 'Transferencia'}: ${formatMoneyLabel(payment.amount, payment.currencyCode)}`)
      .join(' | ');

    const units = (transaction.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

    rows.push([
      transaction.ticketNumber || transaction.id,
      safeDate,
      branchName,
      sessionLabel,
      seller,
      customer?.name || 'Consumidor Final',
      customer?.phone || 'N/A',
      transaction.ncf || 'N/A',
      units,
      Number((Number(transaction.subtotal) || 0).toFixed(2)),
      Number((Number(transaction.tax) || 0).toFixed(2)),
      Number((Number(transaction.discount) || 0).toFixed(2)),
      Number((Number(transaction.total) || 0).toFixed(2)),
      Number(cashPaidInBase.toFixed(2)),
      Number(transferPaidInBase.toFixed(2)),
      Number(changeGivenInBase.toFixed(2)),
      paymentsSummary,
      transaction.status === 'completed' ? 'Completada' : transaction.status === 'refunded' ? 'Reembolsada' : 'Parcial',
      transaction.notes || '',
    ]);
  }

  return rows;
}
