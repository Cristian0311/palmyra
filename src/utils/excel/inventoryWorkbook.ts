import type { Workbook } from 'exceljs';

import type { ExportRows, KpiDefinition } from './analytics';
import type { ChartSpec } from './chartRenderer';
import { addCoverSheet, addDataSheet, createWorkbook, downloadWorkbookBuffer, writeWorkbookBuffer, type ChartRenderer, type DataSheetDefinition } from './workbook';
import { buildFileName, reportStamp } from './theme';
import { isLowStockQuantity } from '../../modules/inventory/utils/lowStock';

export interface InventoryExportRow {
  id?: string;
  name: string;
  sku: string;
  barcode?: string;
  categoryId?: string;
  categoryName?: string;
  unit?: string;
  price: number;
  costPrice: number;
  /** Días de garantía del producto (0 = sin garantía). */
  warrantyDays?: number;
  totalStock: number;
  minQuantity?: number;
  /** Umbral efectivo de alerta (producto → nivel → 5 por defecto). */
  lowStockThreshold?: number;
  status?: string;
}

export interface InventoryExportOptions {
  businessName?: string;
  currencyCode?: string;
  generatedAt?: Date;
  chartRenderer?: ChartRenderer;
  subtitle?: string;
}

interface CategoryAggregate {
  name: string;
  products: number;
  units: number;
  valueCost: number;
  valueSale: number;
}

function statusFor(row: InventoryExportRow): string {
  const stock = Number(row.totalStock) || 0;
  if (stock <= 0) return 'Agotado';
  if (isLowStockQuantity(stock, undefined, row.lowStockThreshold ?? row.minQuantity)) return 'Bajo mínimo';
  return 'Disponible';
}

function aggregateCategories(rows: InventoryExportRow[]): CategoryAggregate[] {
  const map = new Map<string, CategoryAggregate>();
  for (const row of rows) {
    const name = row.categoryName || 'Sin categoría';
    const stock = Number(row.totalStock) || 0;
    const cost = Number(row.costPrice) || 0;
    const price = Number(row.price) || 0;
    const current = map.get(name) || { name, products: 0, units: 0, valueCost: 0, valueSale: 0 };
    current.products += 1;
    current.units += stock;
    current.valueCost += cost * stock;
    current.valueSale += price * stock;
    map.set(name, current);
  }
  return [...map.values()].sort((a, b) => b.valueCost - a.valueCost || a.name.localeCompare(b.name));
}

function inventoryDataRows(rows: InventoryExportRow[]): ExportRows {
  return rows.map(row => {
    const warrantyDays = Number.isFinite(Number(row.warrantyDays))
      ? Math.max(0, Math.floor(Number(row.warrantyDays)))
      : 0;
    return [
      row.sku || 'S/SKU',
      row.name || 'Producto',
      row.barcode || 'S/C',
      row.categoryName || 'Sin categoría',
      row.unit || 'uds',
      warrantyDays,
      Number(row.price) || 0,
      Number(row.costPrice) || 0,
      (Number(row.price) || 0) - (Number(row.costPrice) || 0),
      Number(row.totalStock) || 0,
      Number(row.minQuantity) || 0,
      (Number(row.costPrice) || 0) * (Number(row.totalStock) || 0),
      (Number(row.price) || 0) * (Number(row.totalStock) || 0),
      statusFor(row),
    ];
  });
}

function categoryDataRows(categories: CategoryAggregate[]): ExportRows {
  const totalCost = categories.reduce((sum, category) => sum + category.valueCost, 0);
  return categories.map(category => [
    category.name,
    category.products,
    category.units,
    category.valueCost,
    category.valueSale,
    category.valueSale - category.valueCost,
    totalCost > 0 ? (category.valueCost / totalCost) * 100 : 0,
  ]);
}

export async function buildInventoryWorkbook(
  rows: InventoryExportRow[],
  options: InventoryExportOptions = {},
): Promise<Workbook> {
  const generatedAt = options.generatedAt || new Date();
  const currency = options.currencyCode || 'CUP';
  const company = options.businessName || 'PALMYRA';
  const workbook = createWorkbook(company, generatedAt);
  const categories = aggregateCategories(rows);

  const unitCount = rows.reduce((sum, row) => sum + (Number(row.totalStock) || 0), 0);
  const valueCost = rows.reduce((sum, row) => sum + (Number(row.costPrice) || 0) * (Number(row.totalStock) || 0), 0);
  const valueSale = rows.reduce((sum, row) => sum + (Number(row.price) || 0) * (Number(row.totalStock) || 0), 0);
  const lowStock = rows.filter(row => {
    const stock = Number(row.totalStock) || 0;
    return stock > 0 && isLowStockQuantity(stock, undefined, row.lowStockThreshold ?? row.minQuantity);
  }).length;
  const outOfStock = rows.filter(row => (Number(row.totalStock) || 0) <= 0).length;

  const kpis: KpiDefinition[] = [
    { label: 'Productos', value: rows.length, format: 'integer', hint: 'Referencias en el catálogo', tone: 'info' },
    { label: 'Unidades en stock', value: unitCount, format: 'integer', hint: 'Existencias valorizadas', tone: 'violet' },
    { label: 'Valor a costo', value: valueCost, format: 'currency', hint: 'Capital invertido en inventario', tone: 'warning' },
    { label: 'Valor a venta', value: valueSale, format: 'currency', hint: 'Precio de venta del stock', tone: 'success' },
    { label: 'Margen potencial', value: valueSale - valueCost, format: 'currency', hint: 'Ganancia si se vende el stock', tone: 'success' },
    { label: 'Bajo mínimo', value: lowStock, format: 'integer', hint: 'Requieren reposición', tone: lowStock > 0 ? 'warning' : 'success' },
    { label: 'Agotados', value: outOfStock, format: 'integer', hint: 'Sin existencias', tone: outOfStock > 0 ? 'danger' : 'success' },
    { label: 'Categorías', value: categories.length, format: 'integer', hint: 'Departamentos con producto', tone: 'violet' },
  ];

  const stockChart: ChartSpec | null = categories.length > 0
    ? {
        kind: 'bar',
        title: 'Stock por categoría',
        subtitle: 'Unidades disponibles por departamento',
        labels: categories.slice(0, 8).map(category => category.name),
        series: [{ name: 'Unidades', values: categories.slice(0, 8).map(category => category.units) }],
        valueFormat: 'integer',
      }
    : null;
  const valueChart: ChartSpec | null = categories.length > 0
    ? {
        kind: 'bar',
        title: 'Valor de inventario por categoría',
        subtitle: 'Valorizado a costo',
        labels: categories.slice(0, 8).map(category => category.name),
        series: [{ name: 'Valor a costo', values: categories.slice(0, 8).map(category => category.valueCost) }],
        valueFormat: 'currency',
      }
    : null;

  const subtitle = options.subtitle || `Valorización de inventario · ${currency} · Generado: ${reportStamp(generatedAt)}`;
  await addCoverSheet(
    workbook,
    {
      company,
      title: 'Inventario y valorización de existencias',
      subtitle,
      period: 'Existencias actuales',
      currencyCode: currency,
      generatedAt,
      kpis,
      charts: [stockChart, valueChart].filter((chart): chart is ChartSpec => Boolean(chart)),
      sections: [
        { name: 'Inventario', records: rows.length, detail: 'Detalle por producto' },
        { name: 'Valorización por Categoría', records: categories.length, detail: 'Consolidado por departamento' },
      ],
      note: `Los valores de inventario se calculan con el costo y el precio actuales del catálogo en ${currency}.`,
    },
    options.chartRenderer,
  );

  const inventorySheet: DataSheetDefinition = {
    name: 'Inventario',
    title: 'Inventario valorizado',
    subtitle,
    columns: [
      { header: 'Código / SKU', kind: 'mono', width: 14 },
      { header: 'Nombre del Producto', kind: 'text', width: 30 },
      { header: 'Código de Barras', kind: 'mono', width: 14 },
      { header: 'Categoría', kind: 'text', width: 18 },
      { header: 'Unidad', kind: 'text', width: 9 },
      { header: 'Garantía (días)', kind: 'integer', width: 11 },
      { header: `Precio Venta (${currency})`, kind: 'currency', width: 13 },
      { header: `Costo (${currency})`, kind: 'currency', width: 13 },
      { header: `Margen Unitario (${currency})`, kind: 'currency', width: 13 },
      { header: 'Stock Actual', kind: 'integer', width: 10, total: true },
      { header: 'Stock Mínimo', kind: 'integer', width: 10 },
      { header: `Valor a Costo (${currency})`, kind: 'currency', width: 15, total: true },
      { header: `Valor a Venta (${currency})`, kind: 'currency', width: 15, total: true },
      { header: 'Estado', kind: 'text', width: 12 },
    ],
    rows: inventoryDataRows(rows),
    emptyMessage: 'No hay productos que coincidan con los filtros de inventario.',
    totalsLabel: 'TOTALES',
  };
  addDataSheet(workbook, inventorySheet);

  const categorySheet: DataSheetDefinition = {
    name: 'Valorización por Categoría',
    title: 'Valorización por categoría',
    subtitle,
    columns: [
      { header: 'Categoría', kind: 'text', width: 24 },
      { header: 'Productos', kind: 'integer', width: 10, total: true },
      { header: 'Unidades', kind: 'integer', width: 10, total: true },
      { header: `Valor a Costo (${currency})`, kind: 'currency', width: 16, total: true },
      { header: `Valor a Venta (${currency})`, kind: 'currency', width: 16, total: true },
      { header: `Margen Potencial (${currency})`, kind: 'currency', width: 16, total: true },
      { header: '% Participación', kind: 'percent', width: 13 },
    ],
    rows: categoryDataRows(categories),
    emptyMessage: 'No hay categorías con inventario.',
    totalsLabel: 'TOTALES',
  };
  addDataSheet(workbook, categorySheet);

  return workbook;
}

export async function exportInventoryToExcel(rows: InventoryExportRow[], options: InventoryExportOptions = {}): Promise<void> {
  const workbook = await buildInventoryWorkbook(rows, options);
  const buffer = await writeWorkbookBuffer(workbook);
  downloadWorkbookBuffer(buffer, buildFileName('Inventario', 'xlsx', options.generatedAt || new Date()));
}
