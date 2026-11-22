import type { ExcelExportData } from './types';
import { reportLineTotal, resolveUnitCost } from '../../modules/reports/utils/reportSalesSummary';

export function generateItemsSoldDetailSheet(data: ExcelExportData): any[][] {
  const {
    products = [],
    categories = [],
    branches = [],
    users = [],
    customers = [],
    baseCurrency,
  } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const productById = new Map(products.map(product => [product.id, product]));
  const categoryById = new Map(categories.map(category => [category.id, category]));
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const userById = new Map(users.map(user => [user.id, user]));
  const customerById = new Map(customers.map(customer => [customer.id, customer]));

  const rows: any[][] = [
    [
      'Ticket',
      'Fecha',
      'Hora',
      'Sucursal / Almacén',
      'Cajero / Vendedor',
      'Cliente',
      'SKU Producto',
      'Código de Barras',
      'Nombre del Producto',
      'Categoría',
      'Variante / Talla',
      'Cantidad',
      `Precio Unitario Venta (${baseCode})`,
      `Costo Unitario Compra (${baseCode})`,
      `Subtotal Línea Venta (${baseCode})`,
      `Costo Total Línea (${baseCode})`,
      `Margen Bruto Ganancia (${baseCode})`,
      '% Margen Ganancia',
      'Número de Serie',
      'Código de Garantía',
      `Total Factura (${baseCode})`,
      `Diferencia Factura - Detalle (${baseCode})`,
      'Costo Verificado',
    ],
  ];

  const sales = (data.transactions || [])
    .filter(transaction => transaction?.status === 'completed' && !transaction.deletedAt && !String(transaction.notes || '').startsWith('AJUSTE_'))
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  for (const transaction of sales) {
    const branchName = branchById.get(transaction.branchId)?.name || 'Sucursal Principal';
    const seller = userById.get(transaction.userId)?.name || transaction.cashierName || 'Cajero';
    const customer = transaction.customerId ? customerById.get(transaction.customerId) : undefined;
    const date = new Date(transaction.date);
    const safeDate = Number.isNaN(date.getTime()) ? null : date;
    const timeStr = Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });

    const items = transaction.items || [];
    // Un solo recorrido por ticket: antes cada línea recalculaba todas las
    // líneas y buscaba en el catálogo, lo que hacía O(n²) un reporte grande.
    const ticketDetailTotal = items.reduce((sum, line) => sum + reportLineTotal(line), 0);
    const invoiceTotal = Number(transaction.total) || 0;
    const invoiceDetailDifference = Number((invoiceTotal - ticketDetailTotal).toFixed(2));

    for (const item of items) {
      const productId = typeof item.product === 'string' ? item.product : item.product?.id;
      const catalogProduct = productId ? productById.get(productId) : undefined;
      const snapshot = typeof item.product === 'object' ? item.product : undefined;
      const productName = snapshot?.name || catalogProduct?.name || 'Producto';
      const categoryName = categoryById.get(catalogProduct?.categoryId || snapshot?.categoryId || '')?.name || 'General';
      const variant = item.variantLabel || item.selectedSize || item.selectedColor || 'Estándar';

      const rawUnitPrice = item.price ?? snapshot?.price ?? catalogProduct?.price ?? 0;
      const unitPrice = Number(rawUnitPrice) || 0;
      const quantity = Number(item.quantity) || 0;
      const lineTotal = reportLineTotal(item);
      const cost = resolveUnitCost(item, productById);
      const unitCost = cost.cost;
      const lineCost = unitCost * quantity;
      // Si no existe un costo confiable no se declara utilidad ficticia.
      const grossMargin = cost.missing ? 0 : lineTotal - lineCost;
      const marginPct = !cost.missing && lineTotal > 0 ? (grossMargin / lineTotal) * 100 : 0;

      rows.push([
        transaction.ticketNumber || transaction.id,
        safeDate,
        timeStr,
        branchName,
        seller,
        customer?.name || 'Consumidor Final',
        catalogProduct?.sku || snapshot?.sku || 'S/SKU',
        catalogProduct?.barcode || snapshot?.barcode || 'S/C',
        productName,
        categoryName,
        variant,
        quantity,
        Number(unitPrice.toFixed(2)),
        Number(unitCost.toFixed(2)),
        Number(lineTotal.toFixed(2)),
        Number(lineCost.toFixed(2)),
        Number(grossMargin.toFixed(2)),
        Number(marginPct.toFixed(1)),
        item.serialNumber || 'N/A',
        item.warrantyCode || 'Sin garantía',
        Number(invoiceTotal.toFixed(2)),
        invoiceDetailDifference,
        cost.missing ? 'Sin costo' : 'Sí',
      ]);
    }
  }

  return rows;
}
