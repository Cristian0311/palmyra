import type { Currency, Payment, Transaction } from '../../../types';

export type CheckoutPaymentLine = {
  code: string;
  amount: number;
  method: Payment['method'];
  bankCardId?: string;
};

export function finalizeCheckoutPayments(
  paymentLines: CheckoutPaymentLine[],
  currencies: Currency[],
  baseCurrency: Currency,
): Payment[] {
  return paymentLines
    .filter(payment => Number.isFinite(payment.amount) && payment.amount > 0)
    .map(payment => {
      const currency = currencies.find(item => item.code === payment.code);
      const isBase = payment.code === baseCurrency.code ||
        (payment.code === 'MN' && baseCurrency.code === 'CUP');
      const configuredRate = Number(currency?.rateToBase);
      const exchangeRate = isBase
        ? 1
        : (Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : null);

      if (exchangeRate === null) {
        throw new Error(
          `No existe una tasa de cambio válida para ${payment.code}. Actualiza las monedas antes de cobrar.`,
        );
      }

      let amount = payment.amount;
      if (payment.code === 'CUP') {
        amount = Math.round(amount);
      } else if (payment.code === 'USD' && payment.method === 'cash') {
        amount = Math.round(amount * 100) / 100;
      }

      return {
        currencyCode: payment.code as Payment['currencyCode'],
        amount,
        exchangeRate,
        method: payment.method,
        bankCardId: payment.bankCardId,
      };
    });
}

export function buildTransactionTicketId(transactions: Transaction[], randomUuid = crypto.randomUUID()): string {
  const maxTicketNum = transactions.reduce((max, transaction) => {
    const match = transaction.id?.match(/PALMYRA-TK(\d+)/i);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);

  const nextTicketNum = Math.max(transactions.length, maxTicketNum) + 1;
  const serial = randomUuid.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `PALMYRA-TK${nextTicketNum.toString().padStart(2, '0')}-${serial}`;
}

export function aggregateTransferPayments(payments: Payment[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const payment of payments) {
    if (payment.method !== 'transfer' || !payment.bankCardId) continue;
    totals.set(
      payment.bankCardId,
      (totals.get(payment.bankCardId) || 0) + payment.amount,
    );
  }
  return totals;
}
