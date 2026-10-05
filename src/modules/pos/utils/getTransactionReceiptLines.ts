import type { Currency, Product, ReceiptConfig, Transaction, User, Customer } from '../../../types';

type ReceiptLineDependencies = {
  receiptConfig: ReceiptConfig;
  currentSessionWorkerName?: string;
  users: User[];
  customers: Customer[];
  products: Product[];
  currencies: Currency[];
  baseCurrency: Currency;
  formatMoney: (amount: number, symbol: string) => string;
};

export function getTransactionReceiptLines(tx: Transaction, deps: ReceiptLineDependencies): string[] {
    const { receiptConfig, currentSessionWorkerName, users, customers, products, currencies, baseCurrency, formatMoney } = deps;
    const lines: string[] = [];
    
    if (receiptConfig.showLogo !== false && receiptConfig.businessName) {
      lines.push(`CENTER|BOLD|${receiptConfig.businessName}`);
    }
    if (receiptConfig.showAddress && receiptConfig.businessAddress) lines.push(`CENTER|${receiptConfig.businessAddress}`);
    if (receiptConfig.showPhone && receiptConfig.businessPhone) lines.push(`CENTER|${receiptConfig.businessPhone}`);
    
    lines.push("---");
    lines.push(`Ticket ID: ${tx.id}`);
    lines.push(`Fecha: ${new Date(tx.date).toLocaleDateString()} ${new Date(tx.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    const sellerDisplay = tx.cashierName || (currentSession?.workerName) || users.find(u => u.id === tx.userId)?.name || 'Empleado';
    lines.push(`Empleado: ${sellerDisplay.toUpperCase()}`);
    const customer = useStore.getState().customers.find(c => c.id === tx.customerId);
    lines.push(`Cliente: ${(customer?.name || 'Consumidor Final').slice(0, 22)}`);
    lines.push("---");
    
    tx.items.forEach(item => {
      const prodName = typeof (item.product as any) === 'object' ? ((item.product as any)?.name || 'Producto') : (products.find(p => p.id === (item.product as any))?.name || (item.product as any) || 'Producto');
      const prodPrice = typeof (item.product as any) === 'object' ? ((item.product as any)?.price || 0) : (products.find(p => p.id === (item.product as any))?.price || item.price || 0);
      const prodWarranty = typeof (item.product as any) === 'object' ? ((item.product as any)?.warrantyDays || 0) : (products.find(p => p.id === (item.product as any))?.warrantyDays || 0);
      const itemName = `${item.quantity}x ${prodName}`;
      const itemPrice = formatMoney(prodPrice * item.quantity, baseCurrency.symbol);
      const dots = Math.max(1, 32 - itemName.length - itemPrice.length);
      lines.push(`${itemName}${" ".repeat(dots)}${itemPrice}`);
      if (item.serialNumber) {
        lines.push(`  S/N: ${item.serialNumber}`);
      }
      if (item.warrantyCode) {
        lines.push(`  Gda: ${item.warrantyCode} (${prodWarranty}d)`);
      }
    });
    
    lines.push("---");
    const totLabel = "TOTAL:";
    const totVal = formatMoney(tx.total, baseCurrency.symbol);
    const totDots = Math.max(1, 32 - totLabel.length - totVal.length);
    lines.push(`BOLD|${totLabel}${" ".repeat(totDots)}${totVal}`);
    lines.push("---");
    
    lines.push("BOLD|Pagos recibidos:");
    (tx.payments || []).forEach(p => {
      const symbol = currencies.find(c => c.code === p.currencyCode)?.symbol || '';
      const method = p.method === 'cash' ? 'Efectivo' : 'Transf';
      const label = `  ${method} (${p.currencyCode}):`;
      const val = formatMoney(p.amount, symbol);
      const sp = Math.max(1, 32 - label.length - val.length);
      lines.push(`${label}${" ".repeat(sp)}${val}`);
    });
    
    if (tx.changePayments && tx.changePayments.length > 0) {
      lines.push("BOLD|Vuelto entregado:");
      tx.changePayments.forEach(cp => {
        const symbol = currencies.find(c => c.code === cp.currencyCode)?.symbol || '';
        const label = `  Efectivo (${cp.currencyCode}):`;
        const val = formatMoney(cp.amount, symbol);
        const sp = Math.max(1, 32 - label.length - val.length);
        lines.push(`${label}${" ".repeat(sp)}${val}`);
      });
    } else if (tx.changeGiven && tx.changeGiven > 0) {
      const label = "Vuelto:";
      const val = formatMoney(tx.changeGiven, baseCurrency.symbol);
      const sp = Math.max(1, 32 - label.length - val.length);
      lines.push(`${label}${" ".repeat(sp)}${val}`);
    }
    
    if (receiptConfig.showFooter && receiptConfig.footerText) {
      lines.push("---");
      lines.push(`CENTER|${receiptConfig.footerText}`);
    }

    return lines;
}

export type { ReceiptLineDependencies };
