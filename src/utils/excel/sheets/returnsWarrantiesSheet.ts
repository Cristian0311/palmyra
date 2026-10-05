import type { ExcelExportData } from "../types";

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
