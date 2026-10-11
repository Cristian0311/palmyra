import type { ExcelExportData } from './types';

export function generateItemsSoldDetailSheet(data: ExcelExportData): any[][] {
  const { transactions, products, categories, branches, users, customers, baseCurrency } = data;

  const rows: any[][] = [
    [
      'ID Ticket',
      'Fecha',
      'Hora',
      'Sucursal',
      'Cajero / Vendedor',
      'Cliente',
      'SKU Producto',
      'Código de Barras',
      'Nombre del Producto',
      'Categoría',
      'Variante / Talla',
      'Cantidad',
      'Precio Unitario Venta (' + baseCurrency.code + ')',
      'Costo Unitario Compra (' + baseCurrency.code + ')',
      'Subtotal Línea Venta (' + baseCurrency.code + ')',
      'Costo Total Línea (' + baseCurrency.code + ')',
      'Margen Bruto Ganancia (' + baseCurrency.code + ')',
      '% Margen Ganancia',
      'Número de Serie',
      'Código de Garantía',
      'Total Factura (' + baseCurrency.code + ')',
      'Diferencia Factura - Detalle (' + baseCurrency.code + ')'
    ]
  ];

  transactions.forEach(t => {
    // This sheet measures completed sales, not refunds, deleted tickets or audit adjustments.
    if (t?.status !== 'completed' || t.deletedAt || String(t.notes || '').startsWith('AJUSTE_')) return;
    const branchName = branches.find(b => b.id === t.branchId)?.name || 'Sucursal Principal';
    const seller = users.find(u => u.id === t.userId)?.name || 'Cajero';
    const customer = customers.find(c => c.id === t.customerId)?.name || 'Consumidor Final';
    const tDate = new Date(t.date);
    const dateStr = tDate.toLocaleDateString('es-CU');
    const timeStr = tDate.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const ticketDetailTotal = (t.items || []).reduce((sum, line) => {
      const lineProductId = typeof line.product === 'string' ? line.product : line.product?.id;
      const lineCatalogProduct = products.find(p => p.id === lineProductId);
      const linePrice = Number(line.price ?? (typeof line.product === 'object' ? line.product.price : lineCatalogProduct?.price) ?? 0) || 0;
      const storedTotal = line.total;
      const actualLineTotal = typeof storedTotal === 'number' && Number.isFinite(storedTotal)
        ? storedTotal
        : linePrice * (Number(line.quantity) || 0);
      return sum + actualLineTotal;
    }, 0);
    const invoiceTotal = Number(t.total) || 0;
    const invoiceDetailDifference = invoiceTotal - ticketDetailTotal;

    t.items.forEach(item => {
      const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
      const catalogProd = products.find(p => p.id === prodId);
      const prodName = typeof item.product === 'object' ? item.product.name : (catalogProd?.name || 'Producto');
      const sku = catalogProd?.sku || 'S/SKU';
      const barcode = catalogProd?.barcode || 'S/C';
      const categoryName = categories.find(c => c.id === catalogProd?.categoryId)?.name || 'General';

      const rawUnitPrice = item.price ?? (typeof item.product === 'object' ? item.product.price : catalogProd?.price) ?? 0;
      const unitPrice = Number(rawUnitPrice) || 0;
      const unitCost = catalogProd?.costPrice || 0;
      const qty = item.quantity || 0;
      const lineTotal = typeof item.total === 'number' && Number.isFinite(item.total)
        ? item.total
        : unitPrice * qty;
      const lineCost = unitCost * qty;
      const grossMargin = lineTotal - lineCost;
      const marginPct = lineTotal > 0 ? (grossMargin / lineTotal) : 0;

      rows.push([
        t.id,
        dateStr,
        timeStr,
        branchName,
        seller,
        customer,
        sku,
        barcode,
        prodName,
        categoryName,
        item.variantLabel || 'Estándar',
        qty,
        Number(unitPrice.toFixed(2)),
        Number(unitCost.toFixed(2)),
        Number(lineTotal.toFixed(2)),
        Number(lineCost.toFixed(2)),
        Number(grossMargin.toFixed(2)),
        Number((marginPct * 100).toFixed(1)),
        item.serialNumber || 'N/A',
        item.warrantyCode || 'Sin garantía',
        Number(invoiceTotal.toFixed(2)),
        Number(invoiceDetailDifference.toFixed(2))
      ]);
    });
  });

  return rows;
}