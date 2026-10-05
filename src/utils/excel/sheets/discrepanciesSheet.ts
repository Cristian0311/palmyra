import type { ExcelExportData } from "../../../types";

export function generateDiscrepanciesSheet(data: ExcelExportData): any[][] {
  const { cashSessions, transactions, branches, currencies, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Turno',
      'Sucursal',
      'Cajero / Responsable',
      'Fecha Cierre',
      'Tipo de Cierre',
      'Estado Auditoría',
      'Moneda',
      'Método Pago',
      'Monto Teórico Esperado',
      'Monto Físico Declarado',
      'Diferencia / Descuadre',
      'Tipo Descuadre',
      'Deducción Salarial Aplicada (' + baseCurrency.code + ')',
      'Productos Coincidentes Detectados',
      'Diagnóstico / Notas Operativas'
    ]
  ];

  cashSessions.forEach(session => {
    const isForced = Boolean(session.isForcedClose);
    let details: { currencyCode: string; method: 'cash' | 'transfer'; expected: number; actual: number; difference: number }[] = [...(session.discrepancyDetails || [])];

    // If details are empty but session is closed and has closingBalances, compute expected on the fly
    if (details.length === 0 && session.status === 'closed' && session.closingBalances && session.closingBalances.length > 0) {
      const openDate = new Date(session.openedAt).getTime();
      const closeDate = session.closedAt ? new Date(session.closedAt).getTime() : Date.now();
      const sessionTx = (transactions || []).filter(t => 
        t.branchId === session.branchId && 
        t.sessionId === session.id
      );

      const expected: { currencyCode: string; method: 'cash' | 'transfer'; amount: number }[] = [];
      const baseCode = baseCurrency?.code || 'CUP';
      expected.push({ currencyCode: baseCode, method: 'cash', amount: session.openingBalance || 0 });

      sessionTx.forEach(tx => {
        (tx.payments || []).forEach(p => {
          const ex = expected.find(e => e.currencyCode === p.currencyCode && e.method === p.method);
          if (ex) ex.amount += p.amount;
          else expected.push({ currencyCode: p.currencyCode, method: p.method, amount: p.amount });
        });
        (tx.changePayments || []).forEach(cp => {
          const ex = expected.find(e => e.currencyCode === cp.currencyCode && e.method === cp.method);
          if (ex) ex.amount -= cp.amount;
        });
      });

      (session.movements || []).forEach(m => {
        const ex = expected.find(e => e.currencyCode === m.currencyCode && e.method === 'cash');
        if (ex) ex.amount += (m.type === 'income' ? m.amount : -m.amount);
        else expected.push({ currencyCode: m.currencyCode, method: 'cash', amount: m.type === 'income' ? m.amount : -m.amount });
      });

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

      session.closingBalances.forEach(cb => {
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
    }

    const hasDiscrepancy = Boolean(session.hasDiscrepancy) || details.length > 0;
    if (!isForced && !hasDiscrepancy) return;

    const branchName = branches.find(b => b.id === session.branchId)?.name || 'Sucursal';
    const workerName = session.workerName || 'Cajero';
    const closeDate = session.closingDate || session.closedAt || session.openedAt;
    const dateStr = new Date(closeDate).toLocaleString('es-CU');
    const auditStatus = session.auditStatus === 'resolved' ? 'Resuelto' : session.auditStatus === 'reviewed' ? 'Auditado' : 'Pendiente Revisión';
    const deduction = session.discrepancyDeductionApplied || 0;

    if (details.length > 0) {
      details.forEach(d => {
        const matchingForCurrency = session.matchingProductsAnalysis?.find(m => m.currencyCode === d.currencyCode);
        const matchStr = matchingForCurrency?.matchedProducts?.map(p => `${p.name} ($${p.price})`).join('; ') || 'Ninguno';
        const aiNote = session.aiDiagnostic?.analysis || session.notes || session.auditNotes || (isForced ? `Cierre forzado: ${session.forcedCloseReason || 'Diferencia registrada'}` : 'Cierre con descuadre registrado');

        rows.push([
          session.id,
          branchName,
          workerName,
          dateStr,
          isForced ? 'Cierre Forzado' : 'Cierre Normal',
          auditStatus,
          d.currencyCode,
          d.method === 'cash' ? 'Efectivo' : 'Transferencia',
          Number(d.expected.toFixed(2)),
          Number(d.actual.toFixed(2)),
          Number(d.difference.toFixed(2)),
          d.difference < 0 ? 'FALTANTE' : 'SOBRANTE',
          Number(deduction.toFixed(2)),
          matchStr,
          aiNote
        ]);
      });
    } else {
      rows.push([
        session.id,
        branchName,
        workerName,
        dateStr,
        isForced ? 'Cierre Forzado' : 'Cierre Normal',
        auditStatus,
        baseCurrency.code,
        'General',
        0,
        0,
        0,
        'DESCUADRE REPORTADO',
        Number(deduction.toFixed(2)),
        'N/A',
        session.forcedCloseReason || session.notes || session.auditNotes || 'Cierre forzado registrado sin detalle granular'
      ]);
    }
  });

  return rows;
}

// SHEET: MOVIMIENTOS DE CAJA POS (EGRESOS E INGRESOS)
