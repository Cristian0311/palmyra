import type { Currency } from '../../types';
import type { ExcelExportData } from './types';

export interface CurrencyBreakdown {
  code: string;
  symbol: string;
  rate: number;
  cash: number;
  transfer: number;
  totalOriginal: number;
  totalBase: number;
}

function resolveBaseCurrency(data: ExcelExportData): Currency {
  return data.baseCurrency || data.currencies?.find(currency => currency.isBase) || ({
    code: 'CUP',
    name: 'Peso Cubano',
    symbol: '$',
    rateToBase: 1,
    isBase: true,
  } as Currency);
}

export function completedSales(data: ExcelExportData) {
  return (data.transactions || []).filter(
    transaction =>
      transaction?.status === 'completed' &&
      !transaction.deletedAt &&
      !String(transaction.notes || '').startsWith('AJUSTE_'),
  );
}

/**
 * Desglose de cobros por moneda. Usa la tasa guardada en cada pago (la venta
 * histórica no cambia cuando se edita la tasa de hoy) y descuenta el vuelto en
 * la moneda en que realmente se entregó.
 */
export function buildCurrencyBreakdown(data: ExcelExportData): CurrencyBreakdown[] {
  const baseCurrency = resolveBaseCurrency(data);
  const currencies = (data.currencies || []).length > 0 ? data.currencies : [baseCurrency];
  const sales = completedSales(data);

  return currencies
    .map(currency => {
      const rateToBase = Number(currency.rateToBase) || 1;
      const changeInCurrency = (transaction: (typeof sales)[number], method: 'cash' | 'transfer') => {
        if (transaction.changePayments && transaction.changePayments.length > 0) {
          return transaction.changePayments
            .filter(change => change.currencyCode === currency.code && change.method === method)
            .reduce((sum, change) => sum + (Number(change.amount) || 0), 0);
        }
        // El campo legado changeGiven está en moneda base y era efectivo.
        return method === 'cash' && currency.code === baseCurrency.code
          ? Math.max(0, Number(transaction.changeGiven) || 0)
          : 0;
      };

      const cashTotal = sales.reduce((sum, transaction) => {
        const received = (transaction.payments || [])
          .filter(payment => payment.currencyCode === currency.code && payment.method === 'cash')
          .reduce((subtotal, payment) => subtotal + (Number(payment.amount) || 0), 0);
        return sum + received - changeInCurrency(transaction, 'cash');
      }, 0);

      const transferTotal = sales.reduce((sum, transaction) => {
        const received = (transaction.payments || [])
          .filter(payment => payment.currencyCode === currency.code && payment.method === 'transfer')
          .reduce((subtotal, payment) => subtotal + (Number(payment.amount) || 0), 0);
        return sum + received - changeInCurrency(transaction, 'transfer');
      }, 0);

      const totalBase = sales.reduce((sum, transaction) => {
        const receivedBase = (transaction.payments || [])
          .filter(payment => payment.currencyCode === currency.code)
          .reduce((subtotal, payment) => {
            const recordedRate = Number(payment.exchangeRate);
            const rate = recordedRate > 0 ? recordedRate : rateToBase;
            return subtotal + (Number(payment.amount) || 0) * rate;
          }, 0);
        const changeBase = transaction.changePayments && transaction.changePayments.length > 0
          ? transaction.changePayments
              .filter(change => change.currencyCode === currency.code)
              .reduce((subtotal, change) => {
                const recordedRate = Number(change.exchangeRate);
                const rate = recordedRate > 0 ? recordedRate : rateToBase;
                return subtotal + (Number(change.amount) || 0) * rate;
              }, 0)
          : (currency.code === baseCurrency.code ? Math.max(0, Number(transaction.changeGiven) || 0) : 0);
        return sum + receivedBase - changeBase;
      }, 0);

      return {
        code: currency.code,
        symbol: currency.symbol,
        rate: currency.isBase ? 1 : Number(rateToBase.toFixed(4)),
        cash: Number(cashTotal.toFixed(2)),
        transfer: Number(transferTotal.toFixed(2)),
        totalOriginal: Number((cashTotal + transferTotal).toFixed(2)),
        totalBase: Number(totalBase.toFixed(2)),
      };
    })
    .filter(row => row.totalOriginal !== 0 || row.totalBase !== 0);
}

export function generateSummarySheet(data: ExcelExportData): any[][] {
  const baseCurrency = resolveBaseCurrency(data);
  const {
    businessName = 'PALMYRA POS',
    cashSessions = [],
    currencies = [],
    dateFilterLabel = 'Todo el historial',
    bankTransactions = [],
    bankCards = [],
  } = data;
  const rateByCode = new Map<string, number>(currencies.map(currency => [currency.code, Number(currency.rateToBase) || 1]));
  const cardById = new Map(bankCards.map(card => [card.id, card]));

  const validSalesTransactions = completedSales(data);
  const totalSales = validSalesTransactions.reduce((sum, transaction) => sum + Math.max(0, Number(transaction.total) || 0), 0);
  const totalItemsSold = validSalesTransactions.reduce(
    (sum, transaction) =>
      sum + (transaction.items || []).reduce((itemSum, item) => itemSum + (Number(item.quantity) || 0), 0),
    0,
  );

  const allMovements = cashSessions.flatMap(session => session.movements || []);
  const totalCashIncomes = allMovements
    .filter(movement => movement.type === 'income')
    .reduce((sum, movement) => sum + (Number(movement.amount) || 0) * (rateByCode.get(movement.currencyCode) || 1), 0);
  const totalCashExpenses = allMovements
    .filter(movement => movement.type === 'expense')
    .reduce((sum, movement) => sum + (Number(movement.amount) || 0) * (rateByCode.get(movement.currencyCode) || 1), 0);

  const bankTotals = { payment_received: 0, deposit: 0, supplier_payment: 0, withdrawal: 0 };
  for (const transaction of bankTransactions) {
    const card = cardById.get(transaction.cardId);
    const rate = rateByCode.get(card?.currency || '') || 1;
    const amount = Math.abs(Number(transaction.amount) || 0) * rate;
    if (transaction.type in bankTotals) {
      bankTotals[transaction.type as keyof typeof bankTotals] += amount;
    }
  }

  const totalBankIncomes = bankTotals.payment_received + bankTotals.deposit;
  const totalBankExpenses = bankTotals.supplier_payment + bankTotals.withdrawal;
  // Los cobros con tarjeta (`payment_received`) ya están dentro de las ventas;
  // sumarlos otra vez inflaba el flujo neto del Excel frente al mismo KPI de la
  // aplicación. Solo los depósitos sin venta son entradas adicionales.
  const netFlow = totalSales + totalCashIncomes + bankTotals.deposit - totalCashExpenses - totalBankExpenses;
  const avgTicket = validSalesTransactions.length > 0 ? totalSales / validSalesTransactions.length : 0;

  const rows: any[][] = [
    [`REPORTE FINANCIERO Y EJECUTIVO - ${String(businessName).toUpperCase()}`],
    [`Generado el: ${new Date().toLocaleString('es-CU')} | Periodo: ${dateFilterLabel}`],
    [`Moneda Base de Conversión: ${baseCurrency.code} (${baseCurrency.symbol})`],
    [],
    ['=== INDICADORES CLAVE DE RENDIMIENTO (KPIs) ==='],
    ['Categoría', 'Indicador Financiero', `Monto en Moneda Base (${baseCurrency.code})`, 'Detalle Operativo'],
    ['Ventas', 'Total Facturado en Ventas', Number(totalSales.toFixed(2)), `${validSalesTransactions.length} ventas completadas registradas`],
    ['Ventas', 'Ticket Promedio por Venta', Number(avgTicket.toFixed(2)), 'Promedio por comprobante'],
    ['Ventas', 'Volumen de Artículos Vendidos', totalItemsSold, 'Unidades físicas despachadas'],
    ['Caja', 'Entradas Extraordinarias de Caja', Number(totalCashIncomes.toFixed(2)), 'Fondos directos aportados a caja'],
    ['Caja', 'Gastos Operativos Retirados de Caja', Number(totalCashExpenses.toFixed(2)), 'Gastos pagados en efectivo'],
    ['Bancos', 'Cobros y Depósitos Bancarios', Number(totalBankIncomes.toFixed(2)), 'Entradas a cuentas Transfermóvil/EnZona'],
    ['Bancos', 'Pagos a Proveedores y Retiros', Number(totalBankExpenses.toFixed(2)), 'Salidas de cuentas bancarias'],
    ['Balance', 'Flujo Neto Operativo Estimado', Number(netFlow.toFixed(2)), 'Balance consolidado del periodo'],
    [],
    ['=== DESGLOSE DE COBROS POR MONEDA Y MÉTODO DE PAGO ==='],
    [
      'Moneda',
      'Símbolo',
      'Tasa de Referencia Actual',
      'Efectivo Recibido',
      'Transferencias Recibidas',
      'Total Moneda Original',
      `Total Equivalente Base (${baseCurrency.code})`,
    ],
  ];

  buildCurrencyBreakdown(data).forEach(row => {
    rows.push([row.code, row.symbol, row.rate, row.cash, row.transfer, row.totalOriginal, row.totalBase]);
  });

  return rows;
}
