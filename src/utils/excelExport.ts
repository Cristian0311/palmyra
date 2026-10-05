import * as XLSX from 'xlsx';
import { formatWorksheet } from './excel/worksheet';
import { generateSummarySheet } from './excel/summarySheet';
import { generateSalesSheet } from './excel/salesSheet';
import { generateItemsSoldDetailSheet } from './excel/itemsSheet';
import type { AIDiagnosticReport, ExcelExportData } from './excel/types';

export type { AIDiagnosticReport, ExcelExportData } from './excel/types';

import { 
  Transaction, CashRegisterSession, Product, Category, 
  Currency, Branch, User, Customer, BankTransaction, BankCard, SalarySettlement,
  InventoryLevel, InventoryTransfer
} from '../types';

// 1. SHEET: RESUMEN FINANCIERO Y EJECUTIVO


// 2. SHEET: REGISTRO DE VENTAS Y TICKETS (Comprobante por fila)


// 3. SHEET: DETALLE DE ARTÍCULOS VENDIDOS (Línea por línea de venta)


// 4. SHEET: CIERRES DE CAJA Y ARQUEOS DE TURNO
export function generateSessionsSheet(data: ExcelExportData): any[][] {
  const { cashSessions, branches, transactions, baseCurrency, currencies } = data;

  const rows: any[][] = [
    [
      'ID Turno',
      'Sucursal',
      'Cajero Responsable',
      'Fecha y Hora Apertura',
      'Fecha y Hora Cierre',
      'Fondo Inicial (' + baseCurrency.code + ')',
      'Ventas en Turno (' + baseCurrency.code + ')',
      'Efectivo Físico Declarado (' + baseCurrency.code + ')',
      'Saldo Teórico Esperado (' + baseCurrency.code + ')',
      'Diferencia / Descuadre (' + baseCurrency.code + ')',
      'Estado del Arqueo',
      'Estado del Turno',
      'Desglose por Moneda',
      'Movimientos de Caja (Ingresos/Gastos)'
    ]
  ];

  cashSessions.forEach(s => {
    const branchName = branches.find(b => b.id === s.branchId)?.name || 'Sucursal';
    const worker = s.workerName || 'Vendedor';
    const openDate = new Date(s.openedAt).toLocaleString('es-CU');
    const closeDate = s.closedAt ? new Date(s.closingDate || s.closedAt).toLocaleString('es-CU') : 'En curso (Abierta)';

    const sessionTx = transactions.filter(t => 
      t.branchId === s.branchId &&
      t.sessionId === s.id
    );
    const sessionSales = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);

    const declaredBreakdown = (s.closingBalances || []).map(b => 
      `${b.amount.toLocaleString('es-CU')} ${b.currencyCode}`
    ).join(' | ') || 'Sin declarar';

    const declaredTotalBase = (s.closingBalances || []).reduce((sum, b) => {
      const rate = currencies.find(c => c.code === b.currencyCode)?.rateToBase || 1;
      return sum + (b.amount * rate);
    }, 0);

    const movementsText = (s.movements || []).map(m => 
      `${m.type === 'income' ? '+Ingreso' : '-Egreso'}: ${m.amount} ${m.currencyCode} (${m.description || 'Sin nota'})`
    ).join('; ') || 'Ninguno';

    let diff = 0;
    let diffStatus = 'Normal';

    if (s.expectedBalance !== undefined && s.status === 'closed') {
      diff = declaredTotalBase - s.expectedBalance;
      if (Math.abs(diff) < 0.05) diffStatus = 'Cuadrado Perfecto';
      else if (diff > 0) diffStatus = `Sobrante (+${diff.toFixed(2)})`;
      else diffStatus = `Faltante (${diff.toFixed(2)})`;
    }

    rows.push([
      s.id,
      branchName,
      worker,
      openDate,
      closeDate,
      Number((s.openingBalance || 0).toFixed(2)),
      Number(sessionSales.toFixed(2)),
      s.status === 'closed' ? Number(declaredTotalBase.toFixed(2)) : 0,
      s.expectedBalance !== undefined ? Number(s.expectedBalance.toFixed(2)) : 0,
      Number(diff.toFixed(2)),
      diffStatus,
      s.status === 'cancelled' ? 'CANCELADA' : (s.status === 'closed' ? 'CERRADA' : 'ABIERTA'),
      declaredBreakdown,
      movementsText
    ]);
  });

  return rows;
}

// 5. SHEET: NÓMINA Y LIQUIDACIÓN SALARIAL
export function generatePayrollSheet(data: ExcelExportData): any[][] {
  const { salarySettlements, cashSessions, transactions, products, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Liquidación / Turno',
      'Fecha',
      'Empleado / Vendedor',
      'Salario Base (' + baseCurrency.code + ')',
      'Meta de Ventas (' + baseCurrency.code + ')',
      'Venta Total Lograda (' + baseCurrency.code + ')',
      '% Cumplimiento de Meta',
      'Comisiones Generadas (' + baseCurrency.code + ')',
      'TOTAL A PAGAR (' + baseCurrency.code + ')',
      'Estado de Pago',
      'Detalle de Comisiones por Producto'
    ]
  ];

  const settlementMap = new Map<string, SalarySettlement>();
  salarySettlements.forEach(st => settlementMap.set(st.sessionId, st));

  cashSessions.filter(s => s.status === 'closed').forEach(session => {
    const st = settlementMap.get(session.id);
    const sessionTx = transactions.filter(t => 
      t.branchId === session.branchId &&
      t.sessionId === session.id
    );
    const sessionTotalSales = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);

    const commissionDetail: string[] = [];
    let calculatedCommissions = 0;

    sessionTx.forEach(tx => {
      tx.items.forEach(item => {
        const prodId = typeof item.product === 'string' ? item.product : item.product.id;
        const prod = products.find(p => p.id === prodId);
        if (prod && (prod.commissionValue || 0) > 0) {
          const comm = prod.commissionType === 'percentage'
            ? (prod.price * (prod.commissionValue || 0) / 100) * item.quantity
            : (prod.commissionValue || 0) * item.quantity;
          calculatedCommissions += comm;
          commissionDetail.push(`${item.quantity}x ${prod.name}: +${comm.toFixed(2)}`);
        }
      });
    });

    const baseSalary = st ? st.baseSalary : 0;
    const commissions = st ? st.commissions : calculatedCommissions;
    const totalToPay = st ? st.total : (baseSalary + commissions);
    const status = st ? (st.status === 'paid' ? 'PAGADO' : 'PENDIENTE') : 'PENDIENTE';
    const salesGoal = st?.salesGoal || 0;
    const goalPct = salesGoal > 0 ? (sessionTotalSales / salesGoal) * 100 : 100;
    const dateStr = new Date(session.closingDate || session.closedAt || session.openedAt).toLocaleDateString('es-CU');

    rows.push([
      st?.id || session.id,
      dateStr,
      session.workerName || 'Vendedor',
      Number(baseSalary.toFixed(2)),
      Number(salesGoal.toFixed(2)),
      Number(sessionTotalSales.toFixed(2)),
      Number(goalPct.toFixed(1)),
      Number(commissions.toFixed(2)),
      Number(totalToPay.toFixed(2)),
      status,
      commissionDetail.slice(0, 6).join('; ') || 'Sin comisiones especiales'
    ]);
  });

  return rows;
}

// 6. SHEET: CATÁLOGO, INVENTARIO Y RENDIMIENTO DE PRODUCTOS
export function generateProductsPerformanceSheet(data: ExcelExportData): any[][] {
  const { products, categories, transactions, inventory, baseCurrency } = data;

  const salesMap = new Map<string, { qty: number, totalRevenue: number }>();

  transactions.forEach(tx => {
    tx.items.forEach(item => {
      const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
      if (!prodId) return;
      const current = salesMap.get(prodId) || { qty: 0, totalRevenue: 0 };
      const price = typeof item.product === 'object' ? (item.product.price || 0) : 0;
      current.qty += (item.quantity || 0);
      current.totalRevenue += (price * (item.quantity || 0));
      salesMap.set(prodId, current);
    });
  });

  const rows: any[][] = [
    [
      'SKU',
      'Código de Barras',
      'Nombre del Producto',
      'Categoría',
      'Precio Venta (' + baseCurrency.code + ')',
      'Costo Compra (' + baseCurrency.code + ')',
      'Margen Unitario (' + baseCurrency.code + ')',
      '% Margen Comercial',
      'Stock Físico Actual',
      'Valor Stock a Costo (' + baseCurrency.code + ')',
      'Valor Stock a Venta (' + baseCurrency.code + ')',
      'Ganancia Potencial en Stock (' + baseCurrency.code + ')',
      'Unidades Vendidas Históricas',
      'Ingresos Totales Generados (' + baseCurrency.code + ')',
      'Beneficio Bruto Generado (' + baseCurrency.code + ')',
      'Días de Garantía',
      'Estado'
    ]
  ];

  const sortedProducts = [...products].sort((a, b) => {
    const revA = salesMap.get(a.id)?.totalRevenue || 0;
    const revB = salesMap.get(b.id)?.totalRevenue || 0;
    return revB - revA;
  });

  sortedProducts.forEach(p => {
    const catName = categories.find(c => c.id === p.categoryId)?.name || 'General';
    const s = salesMap.get(p.id) || { qty: 0, totalRevenue: 0 };
    const unitCost = p.costPrice || 0;
    const unitPrice = p.price || 0;
    const unitMargin = unitPrice - unitCost;
    const marginPct = unitPrice > 0 ? (unitMargin / unitPrice) * 100 : 0;
    const totalGrossProfit = unitMargin * s.qty;

    const totalStock = (inventory || []).filter(inv => inv.productId === p.id).reduce((sum, inv) => sum + (inv.quantity || 0), 0);
    const stockValCost = totalStock * unitCost;
    const stockValPrice = totalStock * unitPrice;
    const potentialProfit = stockValPrice - stockValCost;

    rows.push([
      p.sku || 'S/SKU',
      p.barcode || 'S/C',
      p.name,
      catName,
      Number(unitPrice.toFixed(2)),
      Number(unitCost.toFixed(2)),
      Number(unitMargin.toFixed(2)),
      Number(marginPct.toFixed(1)),
      totalStock,
      Number(stockValCost.toFixed(2)),
      Number(stockValPrice.toFixed(2)),
      Number(potentialProfit.toFixed(2)),
      s.qty,
      Number(s.totalRevenue.toFixed(2)),
      Number(totalGrossProfit.toFixed(2)),
      p.warrantyDays ? `${p.warrantyDays} días` : 'Sin garantía',
      p.status === 'active' ? 'Activo' : (p.status === 'draft' ? 'Borrador' : 'Descontinuado')
    ]);
  });

  return rows;
}

// 7. SHEET: MOVIMIENTOS BANCARIOS Y CUENTAS
export function generateBankMovementsSheet(data: ExcelExportData): any[][] {
  const { bankTransactions, bankCards, currencies, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Operación',
      'Fecha',
      'Hora',
      'Banco Receptor',
      'Titular de la Cuenta',
      'Número de Tarjeta / Cuenta',
      'Teléfono SMS Confirmación',
      'Moneda Cuenta',
      'Tipo de Operación',
      'Monto Original',
      'Tasa de Conversión',
      'Equivalente en Base (' + baseCurrency.code + ')',
      'Descripción / Referencia',
      'ID Venta Asociada'
    ]
  ];

  if (bankTransactions.length === 0) {
    rows.push(['Sin movimientos bancarios registrados']);
  } else {
    bankTransactions.forEach(t => {
      const card = bankCards.find(c => c.id === t.cardId);
      const curr = currencies.find(c => c.code === card?.currency) || baseCurrency;
      const rate = curr.rateToBase || 1;
      const amountInBase = t.amount * rate;

      let typeLabel = 'Otro';
      if (t.type === 'payment_received') typeLabel = 'Cobro Venta / Transferencia';
      else if (t.type === 'deposit') typeLabel = 'Depósito / Entrada';
      else if (t.type === 'supplier_payment') typeLabel = 'Pago a Proveedor';
      else if (t.type === 'withdrawal') typeLabel = 'Retiro de Fondos';

      const tDate = new Date(t.date);
      const dateStr = tDate.toLocaleDateString('es-CU');
      const timeStr = tDate.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });

      rows.push([
        t.id,
        dateStr,
        timeStr,
        card?.bank || 'Banco',
        card?.name || 'Titular',
        card?.accountNumber || 'N/A',
        card?.phone || 'N/A',
        card?.currency || baseCurrency.code,
        typeLabel,
        Number((t.amount || 0).toFixed(2)),
        Number(rate.toFixed(4)),
        Number(amountInBase.toFixed(2)),
        t.description || 'Sin notas adicionales',
        t.transactionId || 'N/A'
      ]);
    });
  }

  return rows;
}

// 8. SHEET: DEVOLUCIONES Y GARANTÍAS
export function generateReturnsAndWarrantiesSheet(data: ExcelExportData): any[][] {
  const { returns = [], warranties = [], products, customers, users, branches, baseCurrency } = data;

  const rows: any[][] = [
    [
      'Tipo de Registro',
      'Código / ID',
      'ID Ticket Venta',
      'Fecha de Registro',
      'Sucursal',
      'Cajero / Autorizado Por',
      'Cliente',
      'Producto',
      'Cantidad',
      'Monto Reembolsado (' + baseCurrency.code + ')',
      'Número de Serie',
      'Fecha Vencimiento Garantía',
      'Días Cobertura',
      'Estado',
      'Motivo / Diagnóstico'
    ]
  ];

  returns.forEach(r => {
    const prod = products.find(p => p.id === r.productId);
    const cust = customers.find(c => c.id === r.customerId);
    const seller = users.find(u => u.id === r.userId);
    const branch = branches.find(b => b.id === r.branchId);

    rows.push([
      'DEVOLUCIÓN',
      r.id,
      r.transactionId || 'N/A',
      new Date(r.createdAt || r.date || new Date()).toLocaleString('es-CU'),
      branch?.name || 'Sucursal Principal',
      seller?.name || 'Cajero',
      cust?.name || 'Cliente',
      prod?.name || r.productName || 'Producto',
      r.quantity || 1,
      Number((r.refundAmount || 0).toFixed(2)),
      'N/A',
      'N/A',
      0,
      'REEMBOLSADO',
      r.reason || 'Devolución estándar'
    ]);
  });

  warranties.forEach(w => {
    const prod = products.find(p => p.id === w.productId);
    const cust = customers.find(c => c.id === w.customerId);
    const isExpired = new Date(w.expiresAt).getTime() < Date.now();

    rows.push([
      'GARANTÍA EMITIDA',
      w.code || w.id,
      w.transactionId || 'N/A',
      new Date(w.startDate).toLocaleDateString('es-CU'),
      'Sucursal',
      'Sistema',
      cust?.name || 'Cliente',
      prod?.name || 'Producto',
      1,
      0,
      w.serialNumber || 'N/A',
      new Date(w.expiresAt).toLocaleDateString('es-CU'),
      w.durationDays || 0,
      isExpired ? 'VENCIDA' : 'VIGENTE',
      'Garantía técnica del equipo'
    ]);
  });

  return rows;
}

// 9. SHEET: DIAGNÓSTICO INTELIGENTE IA
export function generateAIDiagnosticSheet(diagnostic: AIDiagnosticReport, baseCurrency: Currency): any[][] {
  const rows: any[][] = [
    ['DIAGNÓSTICO ESTRATÉGICO Y AUDITORÍA INTELIGENTE CON IA (GEMINI)'],
    [`Generado el: ${new Date().toLocaleString('es-CU')} | Puntuación de Salud Financiera: ${diagnostic?.healthScore || 85}/100`],
    [],
    ['=== RESUMEN EJECUTIVO Y ANÁLISIS DE SITUACIÓN ==='],
    [diagnostic?.executiveSummary || 'Auditoría completada.'],
    [],
    ['=== ALERTAS CRÍTICAS DE CAJA Y ARQUEOS ==='],
    ...(diagnostic?.cashAlerts || []).map(alert => [`• ${alert}`]),
    [],
    ['=== INSIGHTS COMERCIALES Y DE FACTURACIÓN ==='],
    ...(diagnostic?.topInsights || []).map(insight => [`• ${insight}`]),
    [],
    ['=== RECOMENDACIONES DE INVENTARIO Y ROTACIÓN ==='],
    ...(diagnostic?.inventoryAdvice || []).map(advice => [`• ${advice}`]),
    [],
    ['=== ACCIONES ESTRATÉGICAS PRIORITARIAS ==='],
    ...(diagnostic?.strategicActions || []).map(action => [`• ${action}`]),
    [],
    ['=== MATRIZ DE AUDITORÍA Y CONTROL OPERATIVO ==='],
    ['Área', 'Métrica / Indicador', 'Estado Actual', 'Diagnóstico Operativo', 'Acción Recomendada', 'Nivel de Prioridad'],
    ...(diagnostic?.structuredAuditRows || [])
  ];

  return rows;
}

// MAIN EXPORT FUNCTION: EXPORT FULL REPORT WITH ALL STRUCTURED SHEETS
export function exportFullReportsToExcel(data: ExcelExportData) {
  const wb = XLSX.utils.book_new();

  // 1. Resumen Ejecutivo
  const summaryAoa = generateSummarySheet(data);
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);
  formatWorksheet(summaryWs, summaryAoa, 5, false);
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Resumen Financiero');

  // 2. Ventas y Comprobantes
  const salesAoa = generateSalesSheet(data);
  const salesWs = XLSX.utils.aoa_to_sheet(salesAoa);
  formatWorksheet(salesWs, salesAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, salesWs, 'Ventas y Facturas');

  // 3. Detalle de Artículos Vendidos (Línea por línea)
  const itemsAoa = generateItemsSoldDetailSheet(data);
  const itemsWs = XLSX.utils.aoa_to_sheet(itemsAoa);
  formatWorksheet(itemsWs, itemsAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, itemsWs, 'Detalle Artículos');

  // 4. Cierres y Arqueos de Caja
  const sessionsAoa = generateSessionsSheet(data);
  const sessionsWs = XLSX.utils.aoa_to_sheet(sessionsAoa);
  formatWorksheet(sessionsWs, sessionsAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, sessionsWs, 'Cierres y Arqueos');

  // 5. Nómina y Liquidaciones
  const payrollAoa = generatePayrollSheet(data);
  const payrollWs = XLSX.utils.aoa_to_sheet(payrollAoa);
  formatWorksheet(payrollWs, payrollAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, payrollWs, 'Nómina Salarios');

  // 6. Catálogo e Inventario
  const productsAoa = generateProductsPerformanceSheet(data);
  const productsWs = XLSX.utils.aoa_to_sheet(productsAoa);
  formatWorksheet(productsWs, productsAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, productsWs, 'Catálogo e Inventario');

  // 7. Cuentas y Bancos (Transferencias)
  const bankAoa = generateBankMovementsSheet(data);
  const bankWs = XLSX.utils.aoa_to_sheet(bankAoa);
  formatWorksheet(bankWs, bankAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, bankWs, 'Cuentas Bancarias');

  // 8. Devoluciones y Garantías
  const retAoa = generateReturnsAndWarrantiesSheet(data);
  const retWs = XLSX.utils.aoa_to_sheet(retAoa);
  formatWorksheet(retWs, retAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, retWs, 'Garantías y Devoluciones');


  // 10. Auditoría de Descuadres y Cierres Forzados
  const discAoa = generateDiscrepanciesSheet(data);
  const discWs = XLSX.utils.aoa_to_sheet(discAoa);
  formatWorksheet(discWs, discAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, discWs, 'Descuadres y Cierres');

  // 11. Movimientos de Caja POS (Egresos e Ingresos)
  const movAoa = generateCashMovementsSheet(data);
  const movWs = XLSX.utils.aoa_to_sheet(movAoa);
  formatWorksheet(movWs, movAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, movWs, 'Movimientos POS');

  // 12. Transferencias de Inventario entre Sucursales
  if (data.transfers && data.transfers.length > 0) {
    const tfAoa = generateTransfersSheet(data);
    const tfWs = XLSX.utils.aoa_to_sheet(tfAoa);
    formatWorksheet(tfWs, tfAoa, 0, true);
    XLSX.utils.book_append_sheet(wb, tfWs, 'Transferencias Stock');
  }

  // 13. Diagnóstico Inteligente IA (si está disponible o generado)
  if (data.aiDiagnostic) {
    const aiAoa = generateAIDiagnosticSheet(data.aiDiagnostic, data.baseCurrency);
    const aiWs = XLSX.utils.aoa_to_sheet(aiAoa);
    formatWorksheet(aiWs, aiAoa, 15, false);
    XLSX.utils.book_append_sheet(wb, aiWs, 'Diagnóstico IA');
  }

  const fileName = `Reporte_General_${data.businessName ? data.businessName.replace(/\s+/g, '_') : 'PALMYRA'}_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

// SHEET: DESCUADRES Y CIERRES FORZADOS
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
export function generateCashMovementsSheet(data: ExcelExportData): any[][] {
  const { cashSessions, branches, currencies, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Movimiento',
      'Fecha y Hora',
      'ID Turno',
      'Sucursal',
      'Cajero Responsable',
      'Tipo de Operación',
      'Concepto / Descripción',
      'Importe Moneda Original',
      'Moneda',
      'Equivalente Moneda Base (' + baseCurrency.code + ')',
      'Estado del Turno'
    ]
  ];

  cashSessions.forEach(session => {
    const branchName = branches.find(b => b.id === session.branchId)?.name || 'Sucursal';
    const workerName = session.workerName || 'Cajero';

    (session.movements || []).forEach(m => {
      const dateStr = new Date(m.date).toLocaleString('es-CU');
      const rate = currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1;
      const cupEquiv = m.amount * rate;

      rows.push([
        m.id,
        dateStr,
        session.id,
        branchName,
        m.workerName || workerName,
        m.type === 'income' ? 'INGRESO (ENTRADA)' : 'EGRESO (GASTO)',
        m.description,
        Number(m.amount.toFixed(2)),
        m.currencyCode,
        Number(cupEquiv.toFixed(2)),
        session.status === 'cancelled' ? 'Turno Cancelado' : (session.status === 'closed' ? 'Turno Cerrado' : 'Turno Abierto')
      ]);
    });
  });

  return rows;
}

// SHEET: TRANSFERENCIAS DE INVENTARIO ENTRE SUCURSALES
export function generateTransfersSheet(data: ExcelExportData): any[][] {
  const { transfers = [], users, branches } = data;

  const rows: any[][] = [
    [
      'ID Transferencia',
      'Fecha y Hora',
      'Producto',
      'Variante / Detalle',
      'Cantidad',
      'Sucursal Origen',
      'Sucursal Destino',
      'Usuario / Responsable',
      'Estado'
    ]
  ];

  transfers.forEach(t => {
    const user = users.find(u => u.id === t.userId);
    const fromB = branches.find(b => b.id === t.fromBranchId)?.name || t.fromBranchName || t.fromBranchId;
    const toB = branches.find(b => b.id === t.toBranchId)?.name || t.toBranchName || t.toBranchId;
    const dateStr = new Date(t.date).toLocaleString('es-CU');

    rows.push([
      t.id,
      dateStr,
      t.productName || 'Producto',
      t.variantLabel || 'Estándar',
      t.quantity,
      fromB,
      toB,
      user?.name || t.userId || 'Sistema',
      t.status === 'completed' ? 'Completado' : (t.status || 'Completado')
    ]);
  });

  return rows;
}

// EXPORT SINGLE SECTION
export function exportSingleSectionToExcel(
  section: 'summary' | 'sales' | 'items' | 'sessions' | 'payroll' | 'products' | 'returns' | 'banks' | 'discrepancies' | 'movements' | 'transfers',
  data: ExcelExportData
) {
  const wb = XLSX.utils.book_new();
  let aoa: any[][] = [];
  let sheetName = 'Reporte';
  let isTabular = true;
  let headerRow = 0;

  if (section === 'summary') {
    aoa = generateSummarySheet(data);
    sheetName = 'Resumen Financiero';
    isTabular = false;
    headerRow = 5;
  } else if (section === 'sales') {
    aoa = generateSalesSheet(data);
    sheetName = 'Ventas y Facturas';
  } else if (section === 'items') {
    aoa = generateItemsSoldDetailSheet(data);
    sheetName = 'Detalle de Artículos';
  } else if (section === 'sessions') {
    aoa = generateSessionsSheet(data);
    sheetName = 'Cierres de Caja';
  } else if (section === 'payroll') {
    aoa = generatePayrollSheet(data);
    sheetName = 'Nómina y Salarios';
  } else if (section === 'products') {
    aoa = generateProductsPerformanceSheet(data);
    sheetName = 'Catálogo e Inventario';
  } else if (section === 'returns') {
    aoa = generateReturnsAndWarrantiesSheet(data);
    sheetName = 'Devoluciones y Garantías';
  } else if (section === 'banks') {
    aoa = generateBankMovementsSheet(data);
    sheetName = 'Movimientos Bancarios';
  }  else if (section === 'discrepancies') {
    aoa = generateDiscrepanciesSheet(data);
    sheetName = 'Descuadres y Cierres';
  } else if (section === 'movements') {
    aoa = generateCashMovementsSheet(data);
    sheetName = 'Movimientos POS';
  } else if (section === 'transfers') {
    aoa = generateTransfersSheet(data);
    sheetName = 'Transferencias de Inventario';
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  formatWorksheet(ws, aoa, headerRow, isTabular);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const fileName = `Reporte_${sheetName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
}
