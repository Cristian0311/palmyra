import type {
  Branch,
  CashRegisterSession,
  Currency,
  Product,
  ReceiptConfig,
  SalarySettlement,
  Transaction,
  User,
} from '../../../types';

export type ClosureReceiptDependencies = {
  receiptConfig: ReceiptConfig;
  transactions: Transaction[];
  products: Product[];
  currencies: Currency[];
  branches: Branch[];
  users: User[];
  currentUser: User | null;
  salarySettlements: SalarySettlement[];
  baseCurrency: Currency;
  formatMoney: (amount: number, symbol: string) => string;
  formatSalaryCUP: (value: number) => string;
  companyCompensation?: { mode: 'fixed_product' | 'sales_percent'; percentRate: number };
};

export function getClosureReceiptLines(session: CashRegisterSession, deps: ClosureReceiptDependencies): string[] {
  const { receiptConfig, transactions, products, currencies, branches, users, currentUser, salarySettlements, baseCurrency, formatMoney, formatSalaryCUP } = deps;
  const companyCompensation = deps.companyCompensation || { mode: 'fixed_product' as const, percentRate: 0 };
  const sessionTx = transactions.filter(t => t.sessionId === session.id && !t.deletedAt);
  const soldMap: { [name: string]: { name: string; qty: number; total: number } } = {};

  sessionTx.forEach(tx => {
    tx.items.forEach(item => {
      const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
      const catalogProduct = prodId ? products.find(p => p.id === prodId) : undefined;
      const name = typeof item.product === 'object'
        ? (item.product?.name || catalogProduct?.name || 'Producto')
        : (catalogProduct?.name || item.product || 'Producto');
      if (!soldMap[name]) soldMap[name] = { name, qty: 0, total: 0 };
      const price = typeof item.product === 'object'
        ? Number(item.product?.price ?? item.price ?? catalogProduct?.price ?? 0)
        : Number(item.price ?? catalogProduct?.price ?? 0);
      soldMap[name].qty += Number(item.quantity || 0);
      soldMap[name].total += price * Number(item.quantity || 0);
    });
  });

  const soldList = Object.values(soldMap);
  const totalSales = sessionTx.reduce((sum, tx) => sum + tx.total, 0);
  const employee =
    users.find(u => u.id === session.userId || u.name === session.workerName)
    || users.find(u => u.name?.toLowerCase() === session.workerName?.toLowerCase())
    || users.find(u => u.role === 'employee')
    || currentUser;

  const commissions = companyCompensation.mode === 'sales_percent'
    ? sessionTx.reduce((sum, tx) => {
        const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
        const splitFactor = Math.max(1, sellers.length);
        const sessionSellers = sellers.filter(sellerId => sellerId === session.userId || (session.workingEmployeeIds || []).includes(sellerId));
        return sessionSellers.length > 0
          ? sum + (Math.max(0, Number(tx.total) || 0) * Math.max(0, Math.min(100, Number(companyCompensation.percentRate) || 0)) / 100) * (sessionSellers.length / splitFactor)
          : sum;
      }, 0)
    : sessionTx.reduce((sum, tx) => {
        const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
        const splitFactor = Math.max(1, sellers.length);
        const sessionSellers = sellers.filter(sellerId => sellerId === session.userId || (session.workingEmployeeIds || []).includes(sellerId));
        if (!sessionSellers.length) return sum;
        return sum + (tx.items || []).reduce((itemSum, item) => {
          const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
          const prod = products.find(p => p.id === prodId);
          return itemSum + (Math.max(0, Number(prod?.commissionValue) || 0) * Math.max(0, Number(item.quantity) || 0)) * (sessionSellers.length / splitFactor);
        }, 0);
      }, 0);

  // Keep the existing dormant independent-settlement calculation for compatibility.
  const totalShopCost = sessionTx.reduce((sum, tx) => sum + tx.items.reduce((s, item) => {
    const prodId = typeof item.product === 'string' ? item.product : item.product.id;
    const prod = products.find(p => p.id === prodId);
    const cost = typeof item.product === 'object' ? (item.product?.costPrice || 0) : (prod?.costPrice || 0);
    return s + (cost * item.quantity);
  }, 0), 0);

  const settlement = salarySettlements.find(s => s.sessionId === session.id);
  const baseSalary = settlement?.baseSalary ?? (companyCompensation.mode === 'sales_percent' ? 0 : Math.max(0, Number(employee?.baseSalary) || 0));
  const settledCommissions = settlement?.commissions ?? commissions;
  const totalSalary = settlement?.total ?? (baseSalary + settledCommissions);
  const lines: string[] = [];
  lines.push(`CENTER|BOLD|${receiptConfig.businessName || 'PALMYRA POS'}`);
  if (receiptConfig.showAddress && receiptConfig.businessAddress) lines.push(`CENTER|${receiptConfig.businessAddress}`);
  if (receiptConfig.showPhone && receiptConfig.businessPhone) lines.push(`CENTER|${receiptConfig.businessPhone}`);
  lines.push("---");
  lines.push("CENTER|BOLD|CIERRE DE CAJA / TURNO");
  lines.push(`TURNO: ${session.id}`);
  lines.push(`FECHA: ${new Date(session.closingDate || session.closedAt || new Date()).toLocaleDateString()}`);
  lines.push(`HORA: ${new Date(session.closingDate || session.closedAt || new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  lines.push(`EMPLEADO: ${(session.workerName || 'EMPLEADO').toUpperCase()}`);
  lines.push(`SUCURSAL: ${(branches.find(b => b.id === session.branchId)?.name || 'Central').slice(0, 18)}`);
  lines.push("---");
  lines.push("BOLD|PRODUCTOS VENDIDOS:");
  if (soldList.length === 0) {
    lines.push("Sin ventas registradas");
  } else {
    soldList.forEach(p => {
      const label = `${p.qty}x ${p.name.slice(0, 16)}`;
      const val = formatMoney(p.total, baseCurrency.symbol);
      lines.push(`${label}${" ".repeat(Math.max(1, 32 - label.length - val.length))}${val}`);
    });
  }
  lines.push("---");
  const totSLabel = "TOTAL VENTAS:";
  const totSVal = formatMoney(totalSales, baseCurrency.symbol);
  lines.push(`BOLD|${totSLabel}${" ".repeat(Math.max(1, 32 - totSLabel.length - totSVal.length))}${totSVal}`);
  lines.push(`ITEMS TOTALES: ${soldList.reduce((s, i) => s + i.qty, 0)}`);
  lines.push("---");
  if (false) {
    lines.push("BOLD|LIQUIDACION INDEPENDIENTE:");
    const shopLabel = "Costo Fijo Tienda:";
    const shopVal = formatMoney(totalShopCost, baseCurrency.symbol);
    lines.push(`${shopLabel}${" ".repeat(Math.max(1, 32 - shopLabel.length - shopVal.length))}${shopVal}`);
  } else {
    lines.push("BOLD|NOMINA / COMISIONES:");
    const salLabel = "Salario Base:";
    const salVal = formatMoney(baseSalary, baseCurrency.symbol);
    lines.push(`${salLabel}${" ".repeat(Math.max(1, 32 - salLabel.length - salVal.length))}${salVal}`);
    const comLabel = "Comisiones:";
    const comVal = formatSalaryCUP(settledCommissions);
    lines.push(`${comLabel}${" ".repeat(Math.max(1, 32 - comLabel.length - comVal.length))}${comVal}`);
    const netLabel = "Total a Pagar:";
    const netVal = formatSalaryCUP(totalSalary);
    lines.push(`BOLD|${netLabel}${" ".repeat(Math.max(1, 32 - netLabel.length - netVal.length))}${netVal}`);
    const settlement = salarySettlements.find(s => s.sessionId === session.id);
    if (settlement && settlement.discrepancyDeduction && settlement.discrepancyDeduction > 0) {
      const dedLabel = "Descuento:";
      const dedVal = formatMoney(settlement.discrepancyDeduction, baseCurrency.symbol);
      lines.push(`${dedLabel}${" ".repeat(Math.max(1, 32 - dedLabel.length - dedVal.length))}${dedVal}`);
      const finalLabel = "NETO RECIBIR:";
      const finalVal = formatMoney(settlement.total, baseCurrency.symbol);
      lines.push(`BOLD|${finalLabel}${" ".repeat(Math.max(1, 32 - finalLabel.length - finalVal.length))}${finalVal}`);
    }
  }
  lines.push("---");
  lines.push("BOLD|COBROS POR METODO/MONEDA:");
  const paymentTotals: { [key: string]: { code: string; method: string; amount: number } } = {};
  sessionTx.forEach(tx => {
    (tx.payments || []).forEach(p => {
      const key = `${p.currencyCode}-${p.method}`;
      if (!paymentTotals[key]) paymentTotals[key] = { code: p.currencyCode, method: p.method, amount: 0 };
      paymentTotals[key].amount += p.amount;
    });
  });
  const paymentKeys = Object.keys(paymentTotals);
  if (paymentKeys.length === 0) {
    lines.push("Sin cobros registrados");
  } else {
    paymentKeys.forEach(k => {
      const pt = paymentTotals[k];
      const methodLabel = pt.method === 'transfer' ? 'Transf' : 'Efec';
      const sym = currencies.find(c => c.code === pt.code)?.symbol || '';
      const label = `${methodLabel} (${pt.code}):`;
      const val = formatMoney(pt.amount, sym);
      lines.push(`${label}${" ".repeat(Math.max(1, 32 - label.length - val.length))}${val}`);
    });
  }
  // Movimientos de caja del turno: también deben aparecer en el ticket de cierre
  // para explicar cualquier diferencia entre efectivo esperado y arqueo físico.
  const movements = Array.isArray(session.movements) ? session.movements : [];
  lines.push("---");
  lines.push("BOLD|INGRESOS / EGRESOS:");
  if (movements.length === 0) {
    lines.push("Sin movimientos de caja");
  } else {
    movements.forEach(m => {
      const typeLabel = m.type === 'income' ? 'INGRESO' : 'EGRESO';
      const sign = m.type === 'income' ? '+' : '-';
      const amount = formatMoney(Math.abs(Number(m.amount || 0)), currencies.find(c => c.code === m.currencyCode)?.symbol || '');
      const reason = String(m.description || 'Sin motivo').slice(0, 22);
      const label = `${typeLabel}: ${reason}`;
      lines.push(`${label}${" ".repeat(Math.max(1, 32 - label.length - amount.length - 1))}${sign}${amount}`);
    });
  }
  lines.push("---");
  lines.push("BOLD|ARQUEO DE FONDOS:");
  const fondoLabel = "Fondo Inicial:";
  const fondoVal = formatMoney(session.openingBalance, baseCurrency.symbol);
  lines.push(fondoLabel + " ".repeat(Math.max(1, 32 - fondoLabel.length - fondoVal.length)) + fondoVal);
  const physicalBalances = Array.isArray(session.closingBalances) ? session.closingBalances : [];
  lines.push("BOLD|ARQUEO FISICO:");
  if (physicalBalances.length === 0) {
    lines.push("Arqueo físico: no registrado");
  } else {
    physicalBalances.forEach(p => {
      const symbol = currencies.find(c => c.code === p.currencyCode)?.symbol || "";
      const methodLabel = p.method === "transfer" ? "Transf" : "Efec";
      const label = methodLabel + " (" + p.currencyCode + "):";
      const val = formatMoney(Number(p.amount || 0), symbol);
      lines.push(label + " ".repeat(Math.max(1, 32 - label.length - val.length)) + val);
    });
  }
  if (session.expectedBalance !== undefined) {
    const expectedLabel = "Total esperado:";
    const expectedVal = formatMoney(Number(session.expectedBalance || 0), baseCurrency.symbol);
    lines.push(expectedLabel + " ".repeat(Math.max(1, 32 - expectedLabel.length - expectedVal.length)) + expectedVal);
  }
  if (session.hasDiscrepancy && Array.isArray(session.discrepancyDetails) && session.discrepancyDetails.length > 0) {
    lines.push("BOLD|DESCUADRE:");
    session.discrepancyDetails.forEach(d => {
      const label = d.currencyCode + " " + (d.method === "transfer" ? "Transf" : "Efec") + ":";
      const val = formatMoney(Number(d.difference || 0), currencies.find(c => c.code === d.currencyCode)?.symbol || "");
      lines.push(label + " ".repeat(Math.max(1, 32 - label.length - val.length)) + val);
    });
  }
  lines.push("---");
  lines.push("BOLD|LIQUIDACION SALARIO:");
  const baseLabel = "Salario Base:";
  const baseVal = formatMoney(baseSalary, baseCurrency.symbol);
  lines.push(`${baseLabel}${" ".repeat(Math.max(1, 32 - baseLabel.length - baseVal.length))}${baseVal}`);
  const comLabel = "Comisiones:";
  const comVal = formatSalaryCUP(settledCommissions);
  lines.push(comLabel + " ".repeat(Math.max(1, 32 - comLabel.length - comVal.length)) + comVal);
  const totSalLabel = "TOTAL SALARIO:";
  const totSalVal = formatSalaryCUP(totalSalary);
  lines.push(`BOLD|${totSalLabel}${" ".repeat(Math.max(1, 32 - totSalLabel.length - totSalVal.length))}${totSalVal}`);
  lines.push("---");
  lines.push("CENTER|Firma: _________________");
  lines.push("CENTER|PALMYRA POS");
  return lines;
}
