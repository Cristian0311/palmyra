import { useMemo } from 'react';
import type { CashSession } from '../../../types';

type ReportsDiscrepancyArgs = {
  cashSessions: CashSession[];
  transactions: any[];
  users: any[];
  branches: any[];
  returns: any[];
  transfers: any[];
  bankTransactions: any[];
  filters: any;
};

export function useReportsDiscrepancies({
  cashSessions,
  transactions,
  users,
  branches,
  returns,
  transfers,
  bankTransactions,
  filters,
}: ReportsDiscrepancyArgs) {
const getSessionDiscrepancyInfo = (session: typeof cashSessions[0]) => {
    // 1. If it already has persisted discrepancy details
    if (session.discrepancyDetails && session.discrepancyDetails.length > 0) {
      let totalShortageBase = 0;
      let totalOverageBase = 0;
      session.discrepancyDetails.forEach(dd => {
        const rate = currencies.find(c => c.code === dd.currencyCode)?.rateToBase || 1;
        if (dd.difference < 0) {
          totalShortageBase += Math.abs(dd.difference) * rate;
        } else if (dd.difference > 0) {
          totalOverageBase += dd.difference * rate;
        }
      });

      const settlement = salarySettlements.find(st => st.sessionId === session.id);
      const deductionAmount = session.discrepancyDeductionApplied ?? settlement?.discrepancyDeduction ?? 0;

      return {
        hasDiscrepancy: true,
        isForcedClose: Boolean(session.isForcedClose),
        details: session.discrepancyDetails,
        totalShortageBase,
        totalOverageBase,
        netDifferenceBase: totalOverageBase - totalShortageBase,
        deducted: session.deductedFromSalary || deductionAmount > 0,
        deductionAmount,
        aiDiagnostic: session.aiDiagnostic,
        matchingProducts: session.matchingProductsAnalysis || [],
        auditStatus: session.auditStatus || 'pending_review',
        auditNotes: session.auditNotes || ''
      };
    }

    // 2. Dynamic check for any session with closingBalances
    if (!session.closingBalances || session.closingBalances.length === 0) {
      if (session.isForcedClose || session.hasDiscrepancy) {
        return {
          hasDiscrepancy: true,
          isForcedClose: true,
          details: [],
          totalShortageBase: 0,
          totalOverageBase: 0,
          netDifferenceBase: 0,
          deducted: false,
          deductionAmount: 0,
          aiDiagnostic: session.aiDiagnostic,
          matchingProducts: session.matchingProductsAnalysis || [],
          auditStatus: session.auditStatus || 'pending_review',
          auditNotes: session.auditNotes || ''
        };
      }
      return null;
    }

    const expected: { currencyCode: string; method: 'cash' | 'transfer'; amount: number }[] = [
      { currencyCode: baseCurrency.code, method: 'cash', amount: session.openingBalance || 0 }
    ];

    const sessionTxs = transactions.filter(t => 
      t.sessionId 
        ? t.sessionId === session.id
        : (t.branchId === session.branchId && 
           new Date(t.date).getTime() >= new Date(session.openedAt).getTime() && 
           (!session.closedAt || new Date(t.date).getTime() <= new Date(session.closedAt).getTime()))
    );

    sessionTxs.forEach(tx => {
      (tx.payments || []).forEach(p => {
        const ex = expected.find(e => e.currencyCode === p.currencyCode && e.method === p.method);
        if (ex) ex.amount += p.amount;
        else expected.push({ currencyCode: p.currencyCode, method: p.method as any, amount: p.amount });
      });
      if (tx.changePayments && tx.changePayments.length > 0) {
        tx.changePayments.forEach(cp => {
          const ex = expected.find(e => e.currencyCode === cp.currencyCode && e.method === cp.method);
          if (ex) ex.amount -= cp.amount;
          else expected.push({ currencyCode: cp.currencyCode, method: cp.method as any, amount: -cp.amount });
        });
      } else if (tx.changeGiven && tx.changeGiven > 0) {
        const ex = expected.find(e => e.currencyCode === baseCurrency.code && e.method === 'cash');
        if (ex) ex.amount -= tx.changeGiven;
        else expected.push({ currencyCode: baseCurrency.code, method: 'cash', amount: -tx.changeGiven });
      }
    });

    (session.movements || []).forEach(m => {
      const ex = expected.find(e => e.currencyCode === m.currencyCode && e.method === 'cash');
      if (ex) ex.amount += (m.type === 'income' ? m.amount : -m.amount);
      else expected.push({ currencyCode: m.currencyCode, method: 'cash', amount: m.type === 'income' ? m.amount : -m.amount });
    });

    const details: {
      currencyCode: string;
      method: 'cash' | 'transfer';
      expected: number;
      actual: number;
      difference: number;
    }[] = [];

    expected.forEach(eb => {
      const act = session.closingBalances?.find(cb => cb.currencyCode === eb.currencyCode && cb.method === eb.method)?.amount || 0;
      const diff = act - eb.amount;
      if (Math.abs(diff) > 0.01) {
        details.push({
          currencyCode: eb.currencyCode,
          method: eb.method,
          expected: eb.amount,
          actual: act,
          difference: diff
        });
      }
    });

    session.closingBalances?.forEach(cb => {
      if (!expected.some(eb => eb.currencyCode === cb.currencyCode && eb.method === cb.method)) {
        if (cb.amount > 0.01) {
          details.push({
            currencyCode: cb.currencyCode,
            method: cb.method as any,
            expected: 0,
            actual: cb.amount,
            difference: cb.amount
          });
        }
      }
    });

    if (details.length === 0 && !session.isForcedClose && !session.hasDiscrepancy) {
      return null;
    }

    let totalShortageBase = 0;
    let totalOverageBase = 0;
    details.forEach(dd => {
      const rate = currencies.find(c => c.code === dd.currencyCode)?.rateToBase || 1;
      if (dd.difference < 0) totalShortageBase += Math.abs(dd.difference) * rate;
      else if (dd.difference > 0) totalOverageBase += dd.difference * rate;
    });

    const matchingProducts = details.map(dd => {
      const matchedProducts = products
        .filter(p => Math.abs(p.price - Math.abs(dd.difference)) < 1)
        .slice(0, 3)
        .map(p => ({ id: p.id, name: p.name, price: p.price }));
      return {
        currencyCode: dd.currencyCode,
        difference: dd.difference,
        matchedProducts
      };
    }).filter(m => m.matchedProducts.length > 0);

    const settlement = salarySettlements.find(st => st.sessionId === session.id);
    const deductionAmount = session.discrepancyDeductionApplied ?? settlement?.discrepancyDeduction ?? 0;

    return {
      hasDiscrepancy: true,
      isForcedClose: Boolean(session.isForcedClose),
      details,
      totalShortageBase,
      totalOverageBase,
      netDifferenceBase: totalOverageBase - totalShortageBase,
      deducted: deductionAmount > 0,
      deductionAmount,
      aiDiagnostic: session.aiDiagnostic,
      matchingProducts,
      auditStatus: session.auditStatus || 'pending_review',
      auditNotes: session.auditNotes || ''
    };
  };

  const allDiscrepancySessions = useMemo(() => {
    const list: {
      session: typeof cashSessions[0];
      info: NonNullable<ReturnType<typeof getSessionDiscrepancyInfo>>;
    }[] = [];

    cashSessions.forEach(s => {
      const info = getSessionDiscrepancyInfo(s);
      if (info && info.hasDiscrepancy) {
        list.push({ session: s, info });
      }
    });

    return list.sort((a, b) => sortSessionsByTurn(a.session, b.session));
  }, [cashSessions, transactions, baseCurrency, currencies, salarySettlements, products, sortSessionsByTurn]);

  const filteredDiscrepancySessions = useMemo(() => {
    return allDiscrepancySessions.filter(({ session, info }) => {
      if (selectedBranchFilter !== 'all' && session.branchId !== selectedBranchFilter) {
        return false;
      }
      const dateObj = new Date(session.closingDate || session.closedAt || session.openedAt);
      if (selectedFilterDate) {
        if (dateObj.toISOString().split('T')[0] !== selectedFilterDate) return false;
      } else if (sessionFilter === 'today') {
        if (dateObj.toLocaleDateString() !== new Date().toLocaleDateString()) return false;
      }

      if (discrepancyTypeFilter === 'shortage') {
        return info.totalShortageBase > 0;
      }
      if (discrepancyTypeFilter === 'overage') {
        return info.totalOverageBase > 0;
      }
      if (discrepancyTypeFilter === 'deducted') {
        return info.deducted;
      }
      if (discrepancyTypeFilter === 'pending') {
        return info.auditStatus === 'pending_review';
      }
      return true;
    });
  }, [allDiscrepancySessions, selectedBranchFilter, selectedFilterDate, sessionFilter, discrepancyTypeFilter]);

  const allDetailedMovements = useMemo(() => {
    const list: {
      id: string;
      sessionId: string;
      turnLabel: string;
      branchId: string;
      branchName: string;
      workerName: string;
      type: 'income' | 'expense';
      amount: number;
      currencyCode: string;
      description: string;
      date: string;
      session: typeof cashSessions[0];
    }[] = [];

    cashSessions.forEach(session => {
      const turnLabel = sessionTurnMap.get(session.id) || session.id;
      const branchName = branches.find(b => b.id === session.branchId)?.name || 'Sucursal';
      const workerName = session.workerName || users.find(u => u.id === session.userId)?.name || 'Cajero';

      (session.movements || []).forEach(m => {
        list.push({
          id: m.id,
          sessionId: session.id,
          turnLabel,
          branchId: m.branchId || session.branchId,
          branchName,
          workerName: m.workerName || workerName,
          type: m.type,
          amount: m.amount,
          currencyCode: m.currencyCode,
          description: m.description,
          date: m.date,
          session
        });
      });
    });

    return list.sort((a, b) => {
      const turnOrder = sortSessionsByTurn(a.session, b.session);
      if (turnOrder !== 0) return turnOrder;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });
  }, [cashSessions, sessionTurnMap, branches, users, sortSessionsByTurn]);

  const filteredDetailedMovements = useMemo(() => {
    return allDetailedMovements.filter(m => {
      if (selectedBranchFilter !== 'all' && m.branchId !== selectedBranchFilter) {
        return false;
      }
      const dateObj = new Date(m.date);
      if (selectedFilterDate) {
        if (dateObj.toISOString().split('T')[0] !== selectedFilterDate) return false;
      } else if (sessionFilter === 'today') {
        if (dateObj.toLocaleDateString() !== new Date().toLocaleDateString()) return false;
      }

      if (movementTypeFilter !== 'all' && m.type !== movementTypeFilter) {
        return false;
      }
      if (movementCurrencyFilter !== 'all' && m.currencyCode !== movementCurrencyFilter) {
        return false;
      }
      return true;
    });
  }, [allDetailedMovements, selectedBranchFilter, selectedFilterDate, sessionFilter, movementTypeFilter, movementCurrencyFilter]);

  const handlePrintDiscrepancyTicket = async (session: typeof cashSessions[0]) => {
    const info = getSessionDiscrepancyInfo(session);
    if (!info) return;

    try {
      const { printThermalReceipt, format58mmLine } = await import('../lib/escpos');
      const branch = branches.find(b => b.id === session.branchId);
      const sequentialTurn = sessionTurnMap.get(session.id) || session.id;
      const workerName = session.workerName || users.find(u => u.id === session.userId)?.name || 'Cajero';

      const lines: string[] = [];
      lines.push("CENTER|BOLD|MARÉ");
      lines.push(`CENTER|${(branch?.name || 'Sucursal Principal').toUpperCase()}`);
      lines.push("CENTER|BOLD|AUDITORIA DE DESCUADRE");
      lines.push("CENTER|CIERRE FORZADO DE CAJA");
      lines.push("---");
      lines.push(format58mmLine("FECHA:", new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleDateString(), 32));
      lines.push(format58mmLine("HORA:", new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 32));
      lines.push(format58mmLine("TURNO:", sequentialTurn, 32));
      lines.push(format58mmLine("CAJERO:", workerName.slice(0, 18), 32));
      lines.push("---");
      lines.push("BOLD|DETALLE DE DIFERENCIAS:");
      info.details.forEach(d => {
        const methodLabel = d.method === 'cash' ? 'EFEC' : 'TRANSF';
        const typeLabel = d.difference > 0 ? '+SOBRANTE' : '-FALTANTE';
        lines.push(format58mmLine(`${d.currencyCode} (${methodLabel})`, `${d.actual.toFixed(2)} / ${d.expected.toFixed(2)}`, 32));
        lines.push(format58mmLine(`DIFERENCIA:`, `${typeLabel} ${Math.abs(d.difference).toFixed(2)}`, 32));
      });
      lines.push("---");
      if (info.totalShortageBase > 0) {
        lines.push(format58mmLine("TOTAL FALTANTE:", `-${formatMoney(info.totalShortageBase)}`, 32));
      }
      if (info.totalOverageBase > 0) {
        lines.push(format58mmLine("TOTAL SOBRANTE:", `+${formatMoney(info.totalOverageBase)}`, 32));
      }
      if (info.deducted) {
        lines.push(format58mmLine("DESC. SALARIO:", `-${formatMoney(info.deductionAmount)}`, 32));
      }
      if (session.auditNotes) {
        lines.push("---");
        lines.push(`NOTA: ${session.auditNotes.slice(0, 30)}`);
      }
      lines.push("---");
      lines.push("CENTER|Firma Cajero: ____________");
      lines.push("CENTER|Firma Auditor: ___________");
      lines.push("CENTER|MARÉ SISTEMA POS");

      await printThermalReceipt({
        lines,
        openDrawer: false,
        width: '58mm'
      });
      if (addNotification) addNotification("Comprobante de auditoría enviado a impresión", "success");
    } catch (e) {
      console.error("Error printing discrepancy ticket:", e);
    }
  };

  const handlePrintCashMovementTicket = async (movement: {
    id: string;
    turnLabel: string;
    branchName: string;
    workerName: string;
    type: 'income' | 'expense';
    amount: number;
    currencyCode: string;
    description: string;
    date: string;
  }) => {
    try {
      const { printThermalReceipt, format58mmLine } = await import('../lib/escpos');
      const lines: string[] = [];
      lines.push("CENTER|BOLD|MARÉ POS");
      lines.push(`CENTER|${movement.branchName.toUpperCase()}`);
      lines.push(`CENTER|BOLD|VALE DE ${movement.type === 'income' ? 'INGRESO (ENTRADA)' : 'EGRESO (GASTO)'}`);
      lines.push("---");
      lines.push(format58mmLine("FECHA:", new Date(movement.date).toLocaleDateString(), 32));
      lines.push(format58mmLine("HORA:", new Date(movement.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 32));
      lines.push(format58mmLine("TURNO:", movement.turnLabel, 32));
      lines.push(format58mmLine("CAJERO:", movement.workerName.slice(0, 18), 32));
      lines.push("---");
      lines.push(format58mmLine("CONCEPTO:", movement.description.slice(0, 20), 32));
      lines.push(format58mmLine("TIPO:", movement.type === 'income' ? 'ENTRADA DE CAJA' : 'GASTO / SALIDA', 32));
      lines.push(format58mmLine("MONEDA:", movement.currencyCode, 32));
      lines.push(format58mmLine("IMPORTE:", formatMoney(movement.amount, movement.currencyCode), 32));
      lines.push("---");
      lines.push("CENTER|Firma Entrega: ___________");
      lines.push("CENTER|Firma Recibe:  ___________");
      lines.push("CENTER|COMPROBANTE DE CAJA");

      await printThermalReceipt({
        lines,
        openDrawer: false,
        width: '58mm'
      });
      if (addNotification) addNotification("Vale de movimiento enviado a impresión", "success");
    } catch (e) {
      console.error("Error printing cash movement voucher:", e);
    }
  };

  const handlePrintTransferTicket = async (transfer: import('../types').InventoryTransfer) => {
    try {
      const user = users.find(u => u.id === transfer.userId);
      const fromB = branches.find(b => b.id === transfer.fromBranchId)?.name || transfer.fromBranchName || 'Origen';
      const toB = branches.find(b => b.id === transfer.toBranchId)?.name || transfer.toBranchName || 'Destino';
      const dateStr = new Date(transfer.date).toLocaleDateString('es-CU');
      const timeStr = new Date(transfer.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const width = (receiptConfig?.printerWidth || '58mm') as '58mm' | '80mm';
      const cols = width === '58mm' ? 32 : 48;

      const lines: string[] = [
        "CENTER|BOLD|" + (receiptConfig?.businessName || "MARÉ POS"),
        "CENTER|VALE DE TRANSFERENCIA STOCK",
        "---",
        format58mmLine("FECHA:", dateStr, cols),
        format58mmLine("HORA:", timeStr, cols),
        format58mmLine("ORIGEN:", fromB, cols),
        format58mmLine("DESTINO:", toB, cols),
        format58mmLine("RESPONSABLE:", user?.name || transfer.userId || 'Sistema', cols),
        "---",
        "PRODUCTO | VAR | CANT",
        `${transfer.productName} | ${transfer.variantLabel || 'Base'} | ${transfer.quantity} uds`,
        "---",
        format58mmLine("TOTAL UDS:", `${transfer.quantity} UDS`, cols),
        "---",
        "CENTER|EMITIDO Y REGISTRADO"
      ];

      await printThermalReceipt({
        lines,
        width
      });
      addNotification("Comprobante de transferencia enviado a impresión", "success");
    } catch (e: any) {
      console.error("Error printing transfer ticket:", e);
      addNotification(e?.message || "No se pudo imprimir el comprobante de transferencia.", "error");
    }
  };

  // State for Excel Export Menu
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getExportData = (): ExcelExportData => {
    let dateFilterLabel = 'Todo el historial';
    if (selectedFilterDate) {
      dateFilterLabel = `Fecha específica: ${selectedFilterDate}`;
    } else if (sessionFilter === 'today') {
      dateFilterLabel = `Hoy: ${new Date().toLocaleDateString('es-CU')}`;
    }

    return {
      businessName: receiptConfig?.businessName || 'MARÉ POS',
      transactions,
      cashSessions,
      salarySettlements,
      products,
      categories,
      currencies,
      branches,
      users,
      customers,
      bankTransactions,
      bankCards,
      inventory,
      transfers,
      returns,
      warranties,
      baseCurrency,
      dateFilterLabel
    };
  };

  const handleExportFullExcel = async () => {
    const { exportFullReportsToExcel } = await import("../utils/excelExport");
    const data = getExportData();
    exportFullReportsToExcel(data);
    setShowExportMenu(false);
    setExportSuccess(true);
    setTimeout(() => setExportSuccess(false), 2500);
  };

  const handleExportSectionExcel = async (sec: 'summary' | 'sales' | 'items' | 'sessions' | 'payroll' | 'products' | 'returns' | 'banks' | 'discrepancies' | 'movements' | 'transfers') => {
    const { exportSingleSectionToExcel } = await import("../utils/excelExport");
    const data = getExportData();
    exportSingleSectionToExcel(sec, data);
    setShowExportMenu(false);
    setExportSuccess(true);
    setTimeout(() => setExportSuccess(false), 2500);
  };

  // Find printable shift data
  return {
    getSessionDiscrepancyInfo,
    allDiscrepancySessions,
    filteredDiscrepancySessions,
    allDetailedMovements,
    filteredDetailedMovements,
  };
}
