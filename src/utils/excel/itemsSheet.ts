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
      'Código de Garantía'
    ]
  ];

  transactions.forEach(t => {
    const branchName = branches.find(b => b.id === t.branchId)?.name || 'Sucursal Principal';
    const seller = users.find(u => u.id === t.userId)?.name || 'Cajero';
    const customer = customers.find(c => c.id === t.customerId)?.name || 'Consumidor Final';
    const tDate = new Date(t.date);
    const dateStr = tDate.toLocaleDateString('es-CU');
    const timeStr = tDate.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    t.items.forEach(item => {
      const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
      const catalogProd = products.find(p => p.id === prodId);
      const prodName = typeof item.product === 'object' ? item.product.name : (catalogProd?.name || 'Producto');
      const sku = catalogProd?.sku || 'S/SKU';
      const barcode = catalogProd?.barcode || 'S/C';
      const categoryName = categories.find(c => c.id === catalogProd?.categoryId)?.name || 'General';

      const unitPrice = typeof item.product === 'object' ? (item.product.price || 0) : (catalogProd?.price || 0);
      const unitCost = catalogProd?.costPrice || 0;
      const qty = item.quantity || 0;

      const lineTotal = unitPrice * qty;
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
        item.warrantyCode || 'Sin garantía'
      ]);
    });
  });

  return rows;
}