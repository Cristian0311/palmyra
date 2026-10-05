import type { CashRegisterSession, Product, Transaction, InventoryTransfer } from '../../../types';
import type { SessionDiscrepancyInfo } from './getSessionDiscrepancyInfo';

type MoneyFormatter = (amount: number, currencyCode?: string) => string;
type LineFormatter = (label: string, value: string | number, width?: number) => string;

type ShiftPayrollItem = {
  baseSalary: number;
  commissions: number;
  totalSalary: number;
  status: string;
};

export function buildShiftReceiptLines(
  session: CashRegisterSession,
  deps: {
    branchName: string;
    sequentialTurn: string | number;
    workerName: string;
    transactions: Transaction[];
    products: Product[];
    payrollItem?: ShiftPayrollItem;
    getProductName: (product: unknown) => string;
    formatMoney: MoneyFormatter;
    format58mmLine: LineFormatter;
  },
): string[] {
  const { branchName, sequentialTurn, workerName, transactions, products, payrollItem, getProductName, formatMoney, format58mmLine } = deps;
  const totalSales = transactions.reduce((sum, tx) => sum + (tx.total || 0), 0);
  const totalItems = transactions.reduce((sum, tx) => sum + (tx.items || []).reduce((s, i) => s + (i.quantity || 0), 0), 0);
  const grouped: {[key: string]: {name: string; quantity: number; total: number}} = {};

  transactions.forEach(tx => {
    (tx.items || []).forEach(item => {
      const prodObj = typeof item.product === 'object' ? item.product : products.find(p => p.id === (item.product as unknown as string));
      const name = prodObj?.name || getProductName(item.product);
      if (!grouped[name]) grouped[name] = { name, quantity: 0, total: 0 };
      grouped[name].quantity += item.quantity || 0;
      grouped[name].total += (prodObj?.price || 0) * (item.quantity || 0);
    });
  });

  const lines: string[] = [
    "CENTER|BOLD|MARÉ",
    `CENTER|${(branchName || 'Sucursal Principal').toUpperCase()}`,
    "CENTER|BOLD|CIERRE DE TURNO",
    "---",
    format58mmLine("FECHA:", new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleDateString(), 32),
    format58mmLine("HORA:", new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 32),
    format58mmLine("TURNO:", sequentialTurn, 32),
    format58mmLine("TRABAJADOR:", workerName.slice(0, 18), 32),
    "---",
    "BOLD|DETALLE PRODUCTOS:",
  ];
  const itemsList = Object.values(grouped);
  if (itemsList.length === 0) lines.push("Sin productos vendidos");
  else itemsList.forEach(item => lines.push(format58mmLine(`${item.quantity}x ${item.name.slice(0, 16)}`, formatMoney(item.total), 32)));
  lines.push("---", format58mmLine("TOTAL VENTAS:", formatMoney(totalSales), 32), format58mmLine("ITEMS VENDIDOS:", `${totalItems}`, 32));

  if (payrollItem) {
    lines.push(
      "---",
      "BOLD|LIQUIDACION SALARIO:",
      format58mmLine("Salario Base:", formatMoney(payrollItem.baseSalary), 32),
      format58mmLine("Comisiones:", `+${formatMoney(payrollItem.commissions)}`, 32),
      format58mmLine("TOTAL SALARIO:", formatMoney(payrollItem.totalSalary), 32),
      format58mmLine("Estado:", payrollItem.status === 'paid' ? 'PAGADO' : 'PENDIENTE', 32),
    );
  }
  lines.push("---","CENTER|Firma Trabajador: ___________","CENTER|Firma Supervisor: ___________","CENTER|MARÉ SISTEMA POS");
  return lines;
}

export function buildDiscrepancyReceiptLines(
  session: CashRegisterSession,
  info: SessionDiscrepancyInfo,
  deps: { branchName: string; sequentialTurn: string | number; workerName: string; formatMoney: MoneyFormatter; format58mmLine: LineFormatter },
): string[] {
  const { branchName, sequentialTurn, workerName, formatMoney, format58mmLine } = deps;
  const lines: string[] = [
    "CENTER|BOLD|MARÉ",
    `CENTER|${(branchName || 'Sucursal Principal').toUpperCase()}`,
    "CENTER|BOLD|AUDITORIA DE DESCUADRE",
    "CENTER|CIERRE FORZADO DE CAJA",
    "---",
    format58mmLine("FECHA:", new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleDateString(), 32),
    format58mmLine("HORA:", new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 32),
    format58mmLine("TURNO:", sequentialTurn, 32),
    format58mmLine("CAJERO:", workerName.slice(0, 18), 32),
    "---",
    "BOLD|DETALLE DE DIFERENCIAS:",
  ];
  info.details.forEach(d => {
    const methodLabel = d.method === 'cash' ? 'EFEC' : 'TRANSF';
    const typeLabel = d.difference > 0 ? '+SOBRANTE' : '-FALTANTE';
    lines.push(
      format58mmLine(`${d.currencyCode} (${methodLabel})`, `${d.actual.toFixed(2)} / ${d.expected.toFixed(2)}`, 32),
      format58mmLine(`DIFERENCIA:`, `${typeLabel} ${Math.abs(d.difference).toFixed(2)}`, 32),
    );
  });
  lines.push("---");
  if (info.totalShortageBase > 0) lines.push(format58mmLine("TOTAL FALTANTE:", `-${formatMoney(info.totalShortageBase)}`, 32));
  if (info.totalOverageBase > 0) lines.push(format58mmLine("TOTAL SOBRANTE:", `+${formatMoney(info.totalOverageBase)}`, 32));
  if (info.deducted) lines.push(format58mmLine("DESC. SALARIO:", `-${formatMoney(info.deductionAmount)}`, 32));
  if (session.auditNotes) {
    lines.push("---");
    lines.push(`NOTA: ${session.auditNotes.slice(0, 30)}`);
  }
  lines.push("---","CENTER|Firma Cajero: ____________","CENTER|Firma Auditor: ___________","CENTER|MARÉ SISTEMA POS");
  return lines;
}

export function buildCashMovementReceiptLines(
  movement: {\n    turnLabel: string;\n    branchName: string;\n    workerName: string;\n    type: 'income' | 'expense';\n    amount: number;\n    currencyCode: string;\n    description: string;\n    date: string;\n  },
  deps: { formatMoney: MoneyFormatter; format58mmLine: LineFormatter },
): string[] {
  const { formatMoney, format58mmLine } = deps;
  return [
    "CENTER|BOLD|MARÉ POS",
    `CENTER|${movement.branchName.toUpperCase()}`,
    `CENTER|BOLD|VALE DE ${movement.type === 'income' ? 'INGRESO (ENTRADA)' : 'EGRESO (GASTO)'}`,
    "---",
    format58mmLine("FECHA:", new Date(movement.date).toLocaleDateString(), 32),
    format58mmLine("HORA:", new Date(movement.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 32),
    format58mmLine("TURNO:", movement.turnLabel, 32),
    format58mmLine("CAJERO:", movement.workerName.slice(0, 18), 32),
    "---",
    format58mmLine("CONCEPTO:", movement.description.slice(0, 20), 32),
    format58mmLine("TIPO:", movement.type === 'income' ? 'ENTRADA DE CAJA' : 'GASTO / SALIDA', 32),
    format58mmLine("MONEDA:", movement.currencyCode, 32),
    format58mmLine("IMPORTE:", formatMoney(movement.amount, movement.currencyCode), 32),
    "---",
    "CENTER|Firma Entrega: ___________",
    "CENTER|Firma Recibe:  ___________",
    "CENTER|COMPROBANTE DE CAJA",
  ];
}

export function buildTransferReceiptLines(
  transfer: InventoryTransfer,
  deps: {
    businessName: string;
    userName: string;
    fromBranchName: string;
    toBranchName: string;
    width: '58mm' | '80mm';
    formatMoney: MoneyFormatter;
    format58mmLine: LineFormatter;
  },
): string[] {
  const { businessName, userName, fromBranchName, toBranchName, width, format58mmLine } = deps;
  const dateStr = new Date(transfer.date).toLocaleDateString('es-CU');
  const timeStr = new Date(transfer.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const cols = width === '58mm' ? 32 : 48;
  return [
    "CENTER|BOLD|" + businessName,
    "CENTER|VALE DE TRANSFERENCIA STOCK",
    "---",
    format58mmLine("FECHA:", dateStr, cols),
    format58mmLine("HORA:", timeStr, cols),
    format58mmLine("ORIGEN:", fromBranchName, cols),
    format58mmLine("DESTINO:", toBranchName, cols),
    format58mmLine("RESPONSABLE:", userName, cols),
    "---",
    "PRODUCTO | VAR | CANT",
    `${transfer.productName} | ${transfer.variantLabel || 'Base'} | ${transfer.quantity} uds`,
    "---",
    format58mmLine("TOTAL UDS:", `${transfer.quantity} UDS`, cols),
    "---",
    "CENTER|EMITIDO Y REGISTRADO",
  ];
}
