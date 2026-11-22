import type { ExcelExportData } from "../types";

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completado',
  cancelled: 'Cancelado',
  pending: 'Pendiente',
  in_transit: 'En tránsito',
};

export function generateTransfersSheet(data: ExcelExportData): any[][] {
  const { transfers = [], users = [], branches = [] } = data;
  const userById = new Map(users.map(user => [user.id, user]));
  const branchById = new Map(branches.map(branch => [branch.id, branch]));

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
      'Estado',
    ],
  ];

  for (const transfer of transfers) {
    const user = userById.get(transfer.userId);
    const fromWarehouse = transfer.fromWarehouseId || transfer.fromBranchId;
    const toWarehouse = transfer.toWarehouseId || transfer.toBranchId;
    const fromBranch = branchById.get(fromWarehouse)?.name || transfer.fromBranchName || fromWarehouse || 'Origen';
    const toBranch = branchById.get(toWarehouse)?.name || transfer.toBranchName || toWarehouse || 'Destino';
    const date = transfer.date ? new Date(transfer.date) : null;
    const status = STATUS_LABELS[transfer.status] || transfer.status || 'Completado';

    // Los traslados agrupados guardan el detalle en `variants`. Se exporta una
    // fila por variante para no perder cantidades.
    const variants = Array.isArray(transfer.variants) && transfer.variants.length > 0 ? transfer.variants : null;
    if (variants) {
      for (const variant of variants) {
        rows.push([
          transfer.id,
          date && !Number.isNaN(date.getTime()) ? date : null,
          transfer.productName || 'Producto',
          variant.variantLabel || 'Estándar',
          Number(variant.quantity) || 0,
          fromBranch,
          toBranch,
          user?.name || transfer.userId || 'Sistema',
          status,
        ]);
      }
    } else {
      rows.push([
        transfer.id,
        date && !Number.isNaN(date.getTime()) ? date : null,
        transfer.productName || 'Producto',
        transfer.variantLabel || 'Estándar',
        Number(transfer.quantity) || 0,
        fromBranch,
        toBranch,
        user?.name || transfer.userId || 'Sistema',
        status,
      ]);
    }
  }

  return rows;
}
