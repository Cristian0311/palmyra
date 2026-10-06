import type { ExcelExportData } from "../types";

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
