import type { ExcelExportData } from "../types";

// Etiquetas alineadas con normalizeTransferStatus (repositories.ts): las
// transferencias en dos fases se muestran como En tránsito / Recibido.
const STATUS_LABELS: Record<string, string> = {
  posted: 'En tránsito',
  in_transit: 'En tránsito',
  received: 'Recibido',
  completed: 'Recibido',
  cancelled: 'Cancelado',
  pending: 'Pendiente',
};

export function generateTransfersSheet(data: ExcelExportData): any[][] {
  const { transfers = [], users = [], branches = [] } = data;
  const userById = new Map(users.map(user => [user.id, user]));
  const branchById = new Map(branches.map(branch => [branch.id, branch]));

  // Defensa contra ecos de hidratación: las filas legadas del almacén local usan
  // como id el id del traslado padre, mientras que las filas de la nube usan el
  // id del ítem y guardan el padre en operationId. Si conviven, el mismo traslado
  // se exportaría dos veces; se descartan las filas legadas cuando existe la fila
  // de la nube para el mismo traslado y se eliminan los ids repetidos.
  const operationIds = new Set<string>();
  for (const transfer of transfers) {
    if (transfer.operationId) operationIds.add(String(transfer.operationId));
  }
  const seenIds = new Set<string>();
  const dedupedTransfers = transfers.filter((transfer) => {
    const id = String(transfer.id ?? '');
    if (!transfer.operationId && id && operationIds.has(id)) return false;
    if (id && seenIds.has(id)) return false;
    if (id) seenIds.add(id);
    return true;
  });

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

  for (const transfer of dedupedTransfers) {
    const user = userById.get(transfer.userId);
    const fromWarehouse = transfer.fromWarehouseId || transfer.fromBranchId;
    const toWarehouse = transfer.toWarehouseId || transfer.toBranchId;
    const fromBranch = branchById.get(fromWarehouse)?.name || transfer.fromBranchName || fromWarehouse || 'Origen';
    const toBranch = branchById.get(toWarehouse)?.name || transfer.toBranchName || toWarehouse || 'Destino';
    const date = transfer.date ? new Date(transfer.date) : null;
    const status = STATUS_LABELS[(transfer.status || '').toLowerCase()] || 'En tránsito';
    // En la nube cada fila es un ítem del traslado; el id del traslado padre
    // vive en operationId, así que es la referencia correcta para esta columna.
    const operationRef = transfer.operationId || transfer.id || '';

    // Los traslados agrupados guardan el detalle en `variants`. Se exporta una
    // fila por variante para no perder cantidades.
    const variants = Array.isArray(transfer.variants) && transfer.variants.length > 0 ? transfer.variants : null;
    if (variants) {
      for (const variant of variants) {
        rows.push([
          operationRef,
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
        operationRef,
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
