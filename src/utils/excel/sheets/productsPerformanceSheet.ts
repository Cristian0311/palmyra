import type { ExcelExportData } from "../types";
import { reportLineTotal } from "../../../modules/reports/utils/reportSalesSummary";

export function generateProductsPerformanceSheet(data: ExcelExportData): any[][] {
  const { products = [], categories = [], transactions = [], inventory = [], baseCurrency } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const categoryById = new Map(categories.map(category => [category.id, category]));

  const salesMap = new Map<string, { qty: number; totalRevenue: number }>();
  for (const transaction of transactions) {
    if (transaction?.status !== 'completed' || transaction.deletedAt || String(transaction.notes || '').startsWith('AJUSTE_')) continue;
    for (const item of transaction.items || []) {
      const productId = typeof item.product === 'string' ? item.product : item.product?.id;
      if (!productId) continue;
      const current = salesMap.get(productId) || { qty: 0, totalRevenue: 0 };
      current.qty += Number(item.quantity) || 0;
      current.totalRevenue += reportLineTotal(item);
      salesMap.set(productId, current);
    }
  }

  // Stock por producto en una sola pasada: antes se filtraba el inventario
  // completo por cada producto (O(n²) con catálogos grandes).
  const stockByProduct = new Map<string, number>();
  for (const level of inventory || []) {
    stockByProduct.set(level.productId, (stockByProduct.get(level.productId) || 0) + (Number(level.quantity) || 0));
  }

  const rows: any[][] = [
    [
      'SKU',
      'Código de Barras',
      'Nombre del Producto',
      'Categoría',
      `Precio Venta (${baseCode})`,
      `Costo Compra (${baseCode})`,
      `Margen Unitario (${baseCode})`,
      '% Margen Comercial',
      'Stock Físico Actual',
      `Valor Stock a Costo (${baseCode})`,
      `Valor Stock a Venta (${baseCode})`,
      `Ganancia Potencial en Stock (${baseCode})`,
      'Unidades Vendidas Históricas',
      `Ingresos Totales Generados (${baseCode})`,
      `Beneficio Bruto Generado (${baseCode})`,
      'Días de Garantía',
      'Estado',
    ],
  ];

  const sortedProducts = [...products].sort((a, b) => {
    const revenueA = salesMap.get(a.id)?.totalRevenue || 0;
    const revenueB = salesMap.get(b.id)?.totalRevenue || 0;
    return revenueB - revenueA || String(a.name || '').localeCompare(String(b.name || ''));
  });

  for (const product of sortedProducts) {
    const categoryName = categoryById.get(product.categoryId)?.name || 'General';
    const sold = salesMap.get(product.id) || { qty: 0, totalRevenue: 0 };
    const unitCost = Number(product.costPrice) || 0;
    const unitPrice = Number(product.price) || 0;
    const unitMargin = unitPrice - unitCost;
    const marginPct = unitPrice > 0 ? (unitMargin / unitPrice) * 100 : 0;
    const totalGrossProfit = sold.totalRevenue - unitCost * sold.qty;

    const totalStock = stockByProduct.get(product.id) || 0;
    const stockValueCost = totalStock * unitCost;
    const stockValuePrice = totalStock * unitPrice;
    const potentialProfit = stockValuePrice - stockValueCost;

    rows.push([
      product.sku || 'S/SKU',
      product.barcode || 'S/C',
      product.name || 'Producto',
      categoryName,
      Number(unitPrice.toFixed(2)),
      Number(unitCost.toFixed(2)),
      Number(unitMargin.toFixed(2)),
      Number(marginPct.toFixed(1)),
      totalStock,
      Number(stockValueCost.toFixed(2)),
      Number(stockValuePrice.toFixed(2)),
      Number(potentialProfit.toFixed(2)),
      sold.qty,
      Number(sold.totalRevenue.toFixed(2)),
      Number(totalGrossProfit.toFixed(2)),
      product.warrantyDays ? `${product.warrantyDays} días` : 'Sin garantía',
      product.status === 'active' ? 'Activo' : product.status === 'draft' ? 'Borrador' : 'Descontinuado',
    ]);
  }

  return rows;
}
