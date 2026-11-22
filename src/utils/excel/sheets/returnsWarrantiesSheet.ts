import type { ExcelExportData } from "../types";
import type { Warranty } from "../../../types";

const RETURN_STATUS_LABELS: Record<string, string> = {
  pending: 'PENDIENTE',
  approved: 'APROBADA',
  rejected: 'RECHAZADA',
  completed: 'COMPLETADA',
};

const REASON_LABELS: Record<string, string> = {
  defective: 'Producto defectuoso',
  wrong_size: 'Talla o medida incorrecta',
  changed_mind: 'Cambio de opinión',
  damaged: 'Producto dañado',
  warranty: 'Reclamo de garantía',
  other: 'Otro motivo',
};

const WARRANTY_STATUS_LABELS: Record<string, string> = {
  active: 'VIGENTE',
  expired: 'VENCIDA',
  claimed: 'RECLAMADA',
  refunded: 'REEMBOLSADA',
  exchanged: 'CAMBIADA',
};

function daysBetween(from: Date | null, to: Date | null): number {
  if (!from || !to) return 0;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

export function generateReturnsAndWarrantiesSheet(data: ExcelExportData): any[][] {
  const {
    returns = [],
    warranties = [],
    products = [],
    customers = [],
    users = [],
    branches = [],
    transactions = [],
    currencies = [],
    baseCurrency,
  } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const productById = new Map(products.map(product => [product.id, product]));
  const customerById = new Map(customers.map(customer => [customer.id, customer]));
  const userById = new Map(users.map(user => [user.id, user]));
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const transactionById = new Map(transactions.map(transaction => [transaction.id, transaction]));
  const rateByCode = new Map(currencies.map(currency => [currency.code, Number(currency.rateToBase) || 1]));

  const rows: any[][] = [
    [
      'Tipo de Registro',
      'Código / ID',
      'Ticket Venta',
      'Fecha de Registro',
      'Sucursal / Almacén',
      'Cajero / Autorizado Por',
      'Cliente',
      'Producto',
      'Variante',
      'Cantidad',
      'Moneda Reembolso',
      `Monto Reembolsado Original`,
      `Monto Reembolsado Base (${baseCode})`,
      'Número de Serie',
      'Vencimiento Garantía',
      'Días Cobertura',
      'Estado',
      'Motivo / Diagnóstico',
    ],
  ];

  for (const item of returns as any[]) {
    const product = productById.get(item.productId);
    const transaction = transactionById.get(item.transactionId);
    const branchId = item.branchId || transaction?.branchId;
    const customer = customerById.get(item.customerId);
    const seller = userById.get(item.userId);
    const registeredRaw = item.receivedAt || item.date || item.createdAt;
    const registered = registeredRaw ? new Date(registeredRaw) : null;
    const refundCurrency = item.refundCurrencyCode || baseCurrency?.code || baseCode;
    const refundOriginal = Number(item.refundAmount) || 0;
    const refundBase = refundOriginal * (rateByCode.get(refundCurrency) || 1);

    rows.push([
      'DEVOLUCIÓN',
      item.id,
      item.transactionId || 'N/A',
      registered && !Number.isNaN(registered.getTime()) ? registered : null,
      branchById.get(branchId || '')?.name || 'Sucursal Principal',
      seller?.name || 'Cajero',
      customer?.name || 'Cliente',
      product?.name || item.productName || 'Producto',
      item.variantLabel || 'Estándar',
      Number(item.quantity) || 1,
      refundCurrency,
      Number(refundOriginal.toFixed(2)),
      Number(refundBase.toFixed(2)),
      'N/A',
      null,
      0,
      RETURN_STATUS_LABELS[item.status] || String(item.status || 'PENDIENTE').toUpperCase(),
      REASON_LABELS[item.reason] || item.notes || item.reason || 'Devolución estándar',
    ]);
  }

  for (const warranty of warranties as (Warranty & Record<string, any>)[]) {
    const product = productById.get(warranty.productId);
    const transaction = transactionById.get(warranty.transactionId);
    const customer = customerById.get(warranty.customerId || '');
    const startRaw = warranty.startDate || warranty.purchaseDate;
    const endRaw = warranty.expiresAt || warranty.expiryDate;
    const start = startRaw ? new Date(startRaw) : null;
    const end = endRaw ? new Date(endRaw) : null;
    const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
    const validEnd = end && !Number.isNaN(end.getTime()) ? end : null;
    const expired = validEnd ? validEnd.getTime() < Date.now() : false;
    const statusLabel = warranty.status && warranty.status !== 'active'
      ? WARRANTY_STATUS_LABELS[warranty.status] || String(warranty.status).toUpperCase()
      : expired
        ? 'VENCIDA'
        : 'VIGENTE';

    rows.push([
      'GARANTÍA EMITIDA',
      warranty.code || warranty.id,
      warranty.transactionId || 'N/A',
      validStart,
      branchById.get(transaction?.branchId || '')?.name || 'Sucursal Principal',
      'Sistema',
      warranty.customerName || customer?.name || 'Cliente',
      warranty.productName || product?.name || 'Producto',
      warranty.variantLabel || 'Estándar',
      1,
      baseCode,
      0,
      0,
      warranty.serialNumber || 'N/A',
      validEnd,
      Number(warranty.durationDays) || daysBetween(validStart, validEnd),
      statusLabel,
      'Garantía técnica del equipo',
    ]);
  }

  return rows;
}
