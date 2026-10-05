import type { ExcelExportData } from "../../types";

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
