import type { Dispatch, SetStateAction } from 'react';
import type { CashRegisterSession, InventoryTransfer, Product, Transaction, User } from '../../../types';
import { printThermalReceipt, format58mmLine } from '../../../lib/escpos';
import type { SessionDiscrepancyInfo } from '../utils/getSessionDiscrepancyInfo';
import {
  buildCashMovementReceiptLines,
  buildDiscrepancyReceiptLines,
  buildShiftReceiptLines,
  buildTransferReceiptLines,
} from '../utils/reportReceiptLines';

type PayrollItem = {
  sessionId: string;
  baseSalary: number;
  commissions: number;
  totalSalary: number;
  status: string;
  workerName: string;
  userId?: string;
};

type DiscrepancyInfo = (session: CashRegisterSession) => SessionDiscrepancyInfo | null;

type PrintMovement = {
  id: string;
  turnLabel: string;
  branchName: string;
  workerName: string;
  type: 'income' | 'expense';
  amount: number;
  currencyCode: string;
  description: string;
  date: string;
};

export function useReportsPrinting(deps: {
  cashSessions: CashRegisterSession[];
  branches: { id: string; name: string }[];
  users: User[];
  transactions: Transaction[];
  products: Product[];
  payrollList: PayrollItem[];
  sessionTurnMap: Map<string, string>;
  receiptConfig?: { printerWidth?: '58mm' | '80mm'; businessName?: string } | null;
  getProductName: (product: unknown) => string;
  formatMoney: (amount: number, currencyCode?: string) => string;
  getSessionDiscrepancyInfo: DiscrepancyInfo;
  addNotification?: (message: string, type?: string, detail?: string | string[]) => void;
  setPrintSessionId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    cashSessions, branches, users, transactions, products, payrollList, sessionTurnMap,
    receiptConfig, getProductName, formatMoney, getSessionDiscrepancyInfo, addNotification, setPrintSessionId,
  } = deps;

  const handlePrintShiftTicket = async (sessionId: string) => {
    setPrintSessionId(sessionId);
    const session = cashSessions.find(s => s.id === sessionId);
    if (!session) {
      setTimeout(() => window.print(), 100);
      return;
    }

    try {
      const branch = branches.find(b => b.id === session.branchId);
      const payrollItem = payrollList.find(p => p.sessionId === session.id);
      const sequentialTurn = sessionTurnMap.get(session.id) || session.id;
      const workerName = session.workerName || users.find(u => u.id === session.userId)?.name || 'Vendedor';
      const sessionTx = transactions.filter(t => t.branchId === session.branchId && t.sessionId === session.id);
      const lines = buildShiftReceiptLines(session, {
        branchName: branch?.name || 'Sucursal Principal',
        sequentialTurn,
        workerName,
        transactions: sessionTx,
        products,
        payrollItem: payrollItem ? {
          baseSalary: payrollItem.baseSalary,
          commissions: payrollItem.commissions,
          totalSalary: payrollItem.totalSalary,
          status: payrollItem.status,
        } : undefined,
        getProductName,
        formatMoney,
        format58mmLine,
      });
      await printThermalReceipt({
        lines,
        openDrawer: false,
        width: (receiptConfig?.printerWidth || '58mm') as '58mm' | '80mm',
        onError: err => console.warn('Direct thermal print failed:', err),
      });
    } catch (e) {
      console.error('Error printing thermal shift ticket:', e);
    }
  };

  const handlePrintDiscrepancyTicket = async (session: CashRegisterSession) => {
    const info = getSessionDiscrepancyInfo(session);
    if (!info) return;

    try {
      const branch = branches.find(b => b.id === session.branchId);
      const sequentialTurn = sessionTurnMap.get(session.id) || session.id;
      const workerName = session.workerName || users.find(u => u.id === session.userId)?.name || 'Cajero';
      const lines = buildDiscrepancyReceiptLines(session, info, {
        branchName: branch?.name || 'Sucursal Principal',
        sequentialTurn,
        workerName,
        formatMoney,
        format58mmLine,
      });
      await printThermalReceipt({ lines, openDrawer: false, width: '58mm' });
      addNotification?.("Comprobante de auditoría enviado a impresión", "success");
    } catch (e) {
      console.error("Error printing discrepancy ticket:", e);
    }
  };

  const handlePrintCashMovementTicket = async (movement: PrintMovement) => {
    try {
      const lines = buildCashMovementReceiptLines(movement, { formatMoney, format58mmLine });
      await printThermalReceipt({ lines, openDrawer: false, width: '58mm' });
      addNotification?.("Vale de movimiento enviado a impresión", "success");
    } catch (e) {
      console.error("Error printing cash movement voucher:", e);
    }
  };

  const handlePrintTransferTicket = async (transfer: InventoryTransfer) => {
    try {
      const user = users.find(u => u.id === transfer.userId);
      const fromBranchName = branches.find(b => b.id === transfer.fromBranchId)?.name || transfer.fromBranchName || 'Origen';
      const toBranchName = branches.find(b => b.id === transfer.toBranchId)?.name || transfer.toBranchName || 'Destino';
      const width = (receiptConfig?.printerWidth || '58mm') as '58mm' | '80mm';
      const lines = buildTransferReceiptLines(transfer, {
        businessName: receiptConfig?.businessName || "MARÉ POS",
        userName: user?.name || transfer.userId || 'Sistema',
        fromBranchName,
        toBranchName,
        width,
        formatMoney,
        format58mmLine,
      });
      await printThermalReceipt({ lines, width });
      addNotification?.("Comprobante de transferencia enviado a impresión", "success");
    } catch (e) {
      const error = e as Error;
      console.error("Error printing transfer ticket:", e);
      addNotification?.(error?.message || "No se pudo imprimir el comprobante de transferencia.", "error");
    }
  };

  return {
    handlePrintShiftTicket,
    handlePrintDiscrepancyTicket,
    handlePrintCashMovementTicket,
    handlePrintTransferTicket,
  };
}
