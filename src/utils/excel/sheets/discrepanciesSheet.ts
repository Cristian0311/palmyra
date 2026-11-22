import type { ExcelExportData } from "../types";

interface DiscrepancyDetail {
  currencyCode: string;
  method: 'cash' | 'transfer';
  expected: number;
  actual: number;
  difference: number;
}

export function generateDiscrepanciesSheet(data: ExcelExportData): any[][] {
  const { cashSessions = [], transactions = [], branches = [], baseCurrency, currencies = [] } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const rateByCode = new Map<string, number>(currencies.map(currency => [currency.code, Number(currency.rateToBase) || 1]));
  const rateFor = (code: string): number => (code === baseCode ? 1 : rateByCode.get(code) || 1);

  const transactionsBySession = new Map<string, typeof transactions>();
  // Tickets heredados sin sessionId: se imputan al turno por sucursal y ventana,
  // igual que el cálculo de la app. Antes se ignoraban y el Excel mostraba un
  // esperado distinto al de la auditoría en pantalla.
  const unlinkedTransactions: typeof transactions = [];
  for (const transaction of transactions) {
    if (transaction?.status !== 'completed' || transaction.deletedAt || String(transaction.notes || '').startsWith('AJUSTE_')) continue;
    if (!transaction.sessionId) { unlinkedTransactions.push(transaction); continue; }
    const bucket = transactionsBySession.get(transaction.sessionId);
    if (bucket) bucket.push(transaction);
    else transactionsBySession.set(transaction.sessionId, [transaction]);
  }

  const rows: any[][] = [
    [
      'Turno',
      'Sucursal / Almacén',
      'Cajero / Responsable',
      'Fecha de Cierre',
      'Tipo de Cierre',
      'Estado Auditoría',
      'Moneda',
      'Método de Pago',
      'Monto Teórico Esperado',
      'Monto Físico Declarado',
      'Diferencia / Descuadre',
      `Diferencia Equivalente Base (${baseCode})`,
      'Tipo Descuadre',
      `Deducción Salarial (${baseCode})`,
      'Productos Coincidentes Detectados',
      'Diagnóstico / Notas Operativas',
    ],
  ];

  for (const session of cashSessions) {
    const isForced = Boolean(session.isForcedClose);
    const details: DiscrepancyDetail[] = [...(session.discrepancyDetails || [])];

    if (details.length === 0 && session.status === 'closed' && session.closingBalances && session.closingBalances.length > 0) {
      const openedAt = new Date(session.openedAt).getTime();
      const closedAt = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;
      const sessionTransactions = [
        ...(transactionsBySession.get(session.id) || []),
        ...unlinkedTransactions.filter(transaction => {
          const at = new Date(transaction.date).getTime();
          return transaction.branchId === session.branchId && Number.isFinite(at) && at >= openedAt && at <= closedAt;
        }),
      ];
      const normalizeMethod = (method: string): 'cash' | 'transfer' =>
        method === 'transfer' || method === 'bank_transfer' ? 'transfer' : 'cash';
      const expected: { currencyCode: string; method: 'cash' | 'transfer'; amount: number }[] = [
        { currencyCode: baseCode, method: 'cash', amount: Number(session.openingBalance) || 0 },
      ];

      for (const transaction of sessionTransactions) {
        for (const payment of transaction.payments || []) {
          const method = normalizeMethod(String(payment.method));
          const entry = expected.find(item => item.currencyCode === payment.currencyCode && item.method === method);
          if (entry) entry.amount += Number(payment.amount) || 0;
          else expected.push({ currencyCode: payment.currencyCode, method, amount: Number(payment.amount) || 0 });
        }
        if (transaction.changePayments && transaction.changePayments.length > 0) {
          for (const change of transaction.changePayments) {
            const method = normalizeMethod(String(change.method));
            const entry = expected.find(item => item.currencyCode === change.currencyCode && item.method === method);
            if (entry) entry.amount -= Number(change.amount) || 0;
            else expected.push({ currencyCode: change.currencyCode, method, amount: -(Number(change.amount) || 0) });
          }
        } else if (transaction.changeGiven && transaction.changeGiven > 0) {
          const entry = expected.find(item => item.currencyCode === baseCode && item.method === 'cash');
          if (entry) entry.amount -= transaction.changeGiven;
          else expected.push({ currencyCode: baseCode, method: 'cash', amount: -transaction.changeGiven });
        }
      }

      for (const movement of session.movements || []) {
        const signed = movement.type === 'income' ? Number(movement.amount) || 0 : -(Number(movement.amount) || 0);
        const entry = expected.find(item => item.currencyCode === movement.currencyCode && item.method === 'cash');
        if (entry) entry.amount += signed;
        else expected.push({ currencyCode: movement.currencyCode, method: 'cash', amount: signed });
      }

      for (const entry of expected) {
        const actual = Number(
          session.closingBalances.find(balance => balance.currencyCode === entry.currencyCode && balance.method === entry.method)?.amount || 0,
        );
        const difference = actual - entry.amount;
        if (Math.abs(difference) > 0.01) {
          details.push({ currencyCode: entry.currencyCode, method: entry.method, expected: entry.amount, actual, difference });
        }
      }

      for (const balance of session.closingBalances) {
        if (expected.some(entry => entry.currencyCode === balance.currencyCode && entry.method === balance.method)) continue;
        if ((Number(balance.amount) || 0) > 0.01) {
          details.push({
            currencyCode: balance.currencyCode,
            method: balance.method,
            expected: 0,
            actual: Number(balance.amount) || 0,
            difference: Number(balance.amount) || 0,
          });
        }
      }
    }

    const hasDiscrepancy = Boolean(session.hasDiscrepancy) || details.length > 0;
    if (!isForced && !hasDiscrepancy) continue;

    const branchName = branchById.get(session.branchId)?.name || 'Sucursal';
    const workerName = session.workerName || 'Cajero';
    const closeDateRaw = session.closingDate || session.closedAt || session.openedAt;
    const closeDate = closeDateRaw ? new Date(closeDateRaw) : null;
    const auditStatus = session.auditStatus === 'resolved' ? 'Resuelto' : session.auditStatus === 'reviewed' ? 'Auditado' : 'Pendiente de Revisión';
    const deduction = Number(session.discrepancyDeductionApplied) || 0;
    const turnLabel = session.turnNumber ? `#${session.turnNumber}` : session.id;

    if (details.length > 0) {
      details.forEach((detail, detailIndex) => {
        const matchingForCurrency = session.matchingProductsAnalysis?.find(match => match.currencyCode === detail.currencyCode);
        const matchText = matchingForCurrency?.matchedProducts
          ?.map(product => `${product.name} (${baseCode} ${Number(product.price).toFixed(2)})`)
          .join('; ') || 'Ninguno';
        const aiNote =
          session.aiDiagnostic?.analysis ||
          session.auditNotes ||
          session.notes ||
          (isForced ? `Cierre forzado: ${session.forcedCloseReason || 'Diferencia registrada'}` : 'Cierre con descuadre registrado');

        const difference = Number(detail.difference) || 0;
        // Se usa la tasa registrada al cerrar la caja; la tasa de hoy no debe
        // revalorizar un faltante histórico.
        const closingRate = session.closingBalances?.find(
          balance => balance.currencyCode === detail.currencyCode && Number(balance.exchangeRate) > 0,
        )?.exchangeRate;
        const differenceRate = Number(closingRate) > 0 ? Number(closingRate) : rateFor(detail.currencyCode);
        const baseDifference = Number((difference * differenceRate).toFixed(2));

        rows.push([
          turnLabel,
          branchName,
          workerName,
          closeDate && !Number.isNaN(closeDate.getTime()) ? closeDate : null,
          isForced ? 'Cierre Forzado' : 'Cierre Normal',
          auditStatus,
          detail.currencyCode,
          detail.method === 'cash' ? 'Efectivo' : 'Transferencia',
          Number((Number(detail.expected) || 0).toFixed(2)),
          Number((Number(detail.actual) || 0).toFixed(2)),
          Number(difference.toFixed(2)),
          baseDifference,
          detail.difference < 0 ? 'FALTANTE' : detail.difference > 0 ? 'SOBRANTE' : 'CUADRADO',
          // La deducción pertenece al turno, no a cada moneda: se declara una
          // sola vez para que la fila de totales no la multiplique.
          detailIndex === 0 ? Number(deduction.toFixed(2)) : 0,
          matchText,
          aiNote,
        ]);
      });
    } else {
      rows.push([
        turnLabel,
        branchName,
        workerName,
        closeDate && !Number.isNaN(closeDate.getTime()) ? closeDate : null,
        isForced ? 'Cierre Forzado' : 'Cierre Normal',
        auditStatus,
        baseCode,
        'General',
        0,
        0,
        0,
        0,
        'DESCUADRE REPORTADO',
        Number(deduction.toFixed(2)),
        'N/A',
        session.forcedCloseReason || session.auditNotes || session.notes || 'Cierre forzado registrado sin detalle granular',
      ]);
    }
  }

  return rows;
}
