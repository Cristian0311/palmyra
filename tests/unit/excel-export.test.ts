import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateByLabel,
  buildCategoryChart,
  buildStatusDonut,
  buildTrendChart,
  buildTrendSeries,
  cellNumber,
  countByLabel,
  countRows,
  dataRows,
} from '../../src/utils/excel/analytics';
import { formatChartAmount, renderChartSvg, type ChartSpec } from '../../src/utils/excel/chartRenderer';
import { buildFileName, todayStamp } from '../../src/utils/excel/theme';
import { generateSalesSheet } from '../../src/utils/excel/salesSheet';
import { generateProductsPerformanceSheet } from '../../src/utils/excel/sheets/productsPerformanceSheet';
import { generatePayrollSheet } from '../../src/utils/excel/sheets/payrollSheet';
import { generateTransfersSheet } from '../../src/utils/excel/sheets/transfersSheet';
import { generateDiscrepanciesSheet } from '../../src/utils/excel/sheets/discrepanciesSheet';
import { buildCurrencyBreakdown } from '../../src/utils/excel/summarySheet';
import { SECTION_DEFINITIONS } from '../../src/utils/excel/sectionDefinitions';
import { buildInventoryWorkbook } from '../../src/utils/excel/inventoryWorkbook';

const baseCurrency = { code: 'CUP', name: 'Peso', symbol: '$', rateToBase: 1, isBase: true } as any;
const currencies = [
  baseCurrency,
  { code: 'USD', name: 'Dólar', symbol: 'US$', rateToBase: 370, isBase: false },
] as any;

function sale(overrides: Record<string, any> = {}) {
  return {
    id: 'sale-1',
    ticketNumber: 'T-1',
    branchId: 'b1',
    userId: 'u1',
    date: '2026-11-20T14:30:00.000Z',
    status: 'completed',
    subtotal: 100,
    total: 100,
    items: [{
      id: 'l1',
      product: { id: 'p1', name: 'Producto A', price: 100, costPrice: 60, sku: 'A-1', categoryId: 'c1' },
      quantity: 1,
      price: 100,
      total: 100,
    }],
    payments: [{ currencyCode: 'CUP', method: 'cash', amount: 100, exchangeRate: 1 }],
    ...overrides,
  } as any;
}

function baseData(overrides: Record<string, any> = {}) {
  return {
    businessName: 'PALMYRA Test',
    transactions: [],
    cashSessions: [],
    salarySettlements: [],
    products: [],
    categories: [{ id: 'c1', name: 'General' }] as any,
    currencies,
    branches: [{ id: 'b1', name: 'Centro' }] as any,
    users: [{ id: 'u1', name: 'Ana' }] as any,
    customers: [],
    bankTransactions: [],
    bankCards: [],
    inventory: [],
    transfers: [],
    returns: [],
    warranties: [],
    baseCurrency,
    dateFilterLabel: 'Noviembre 2026',
    ...overrides,
  } as any;
}

test('dataRows descarta encabezado, filas vacías y mensajes de sección vacía', () => {
  const rows: any[][] = [
    ['SKU', 'Total'],
    ['A-1', 10],
    [],
    ['No hay registros para el periodo seleccionado.'],
    ['B-2', 20],
  ];
  assert.deepEqual(dataRows(rows), [['A-1', 10], ['B-2', 20]]);
  assert.equal(countRows(rows), 2);
  assert.equal(cellNumber('1.234,50'), 1234.5);
  assert.equal(cellNumber(Number.NaN), 0);
  assert.equal(cellNumber('no numérico'), 0);
  assert.deepEqual(dataRows([]), []);
});

test('agregaciones agrupan, ordenan y calculan "Otros" sin perder importes', () => {
  const rows: any[][] = [
    ['Producto', 'Importe'],
    ['A', 100],
    ['B', 50],
    ['A', 25],
    ['C', 10],
    ['D', 5],
  ];
  assert.deepEqual(aggregateByLabel(rows, 0, 1, { top: 2, includeOther: true }), [
    { label: 'A', value: 125 },
    { label: 'Otros', value: 65 },
  ]);
  assert.deepEqual(aggregateByLabel(rows, 0, 1, { top: 2, includeOther: false }), [
    { label: 'A', value: 125 },
    { label: 'B', value: 50 },
  ]);
  assert.deepEqual(countByLabel(rows, 0).slice(0, 2), [
    { label: 'A', value: 2 },
    { label: 'B', value: 1 },
  ]);
  assert.equal(buildCategoryChart([], { title: 'Vacía', labelIndex: 0, valueIndex: 1 }), null);
  assert.equal(buildStatusDonut([], 0, { title: 'Vacía' }), null);
});

test('la tendencia rellena días sin ventas y agrupa por mes en rangos largos', () => {
  const daily: any[][] = [
    ['Fecha', 'Ventas'],
    [new Date(2026, 10, 1), 100],
    [new Date(2026, 10, 3), 300],
  ];
  const trend = buildTrendSeries(daily, 0, [{ name: 'Ventas', columnIndex: 1 }]);
  assert.equal(trend.points.length, 3);
  assert.deepEqual(trend.series[0].values, [100, 0, 300]);

  const monthly: any[][] = [
    ['Fecha', 'Ventas'],
    [new Date(2026, 0, 15), 10],
    [new Date(2026, 3, 15), 20],
  ];
  const months = buildTrendSeries(monthly, 0, [{ name: 'Ventas', columnIndex: 1 }]);
  assert.equal(months.monthly, true);
  assert.equal(months.points.length, 4);
  assert.deepEqual(months.series[0].values, [10, 0, 0, 20]);
  assert.equal(buildTrendChart([], 0, [{ name: 'Ventas', columnIndex: 1 }], { title: 'Sin datos' }), null);
});

test('las gráficas SVG nunca contienen NaN y toleran series de un solo punto', () => {
  const specs: ChartSpec[] = [
    { kind: 'bar', title: 'Barras', labels: ['A', 'B'], series: [{ name: 'A', values: [1, 2] }] },
    { kind: 'bar', title: 'Negativos', labels: ['A', 'B'], series: [{ name: 'A', values: [-10, 20] }] },
    { kind: 'line', title: 'Un punto', labels: ['A'], series: [{ name: 'A', values: [5] }] },
    { kind: 'donut', title: 'Donut', labels: ['A', 'B'], series: [{ name: 'A', values: [3, 7] }], valueFormat: 'currency' },
  ];
  for (const spec of specs) {
    const svg = renderChartSvg(spec);
    assert.ok(svg, `render ${spec.title}`);
    assert.equal(svg.includes('NaN'), false, `NaN en ${spec.title}`);
    assert.match(svg, /^<svg[^>]+>/);
  }
  assert.equal(renderChartSvg({ kind: 'bar', title: 'Cero', labels: ['A'], series: [{ name: 'A', values: [0] }] }), null);
  assert.equal(renderChartSvg({ kind: 'donut', title: 'Cero', labels: ['A'], series: [{ name: 'A', values: [0] }] }), null);
  assert.equal(formatChartAmount(1234.5, 'currency'), '1.234,50');
  assert.equal(formatChartAmount(Number.NaN, 'integer'), '0');
});

test('los nombres de archivo son estables, ASCII y sin espacios', () => {
  const name = buildFileName('Devoluciones y Garantías', 'xlsx', new Date(2026, 10, 22));
  assert.equal(name, 'PALMYRA_Devoluciones_y_Garantias_2026-11-22.xlsx');
  assert.match(name, /^PALMYRA_[A-Za-z0-9_]+_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.equal(todayStamp(new Date(2026, 0, 2)), '2026-01-02');
});

test('Ventas excluye reembolsadas, eliminadas y ajustes, y no mezcla sus totales', () => {
  const rows = generateSalesSheet(baseData({
    transactions: [
      sale({ ticketNumber: 'T-1' }),
      sale({ id: 'sale-refunded', ticketNumber: 'T-2', status: 'refunded', total: 999 }),
      sale({ id: 'sale-deleted', ticketNumber: 'T-3', deletedAt: '2026-11-21T00:00:00.000Z', total: 999 }),
      sale({ id: 'sale-adjust', ticketNumber: 'T-4', notes: 'AJUSTE_STOCK', total: 999 }),
    ],
    users: [{ id: 'u1', name: 'Ana' }] as any,
  }));
  const data = dataRows(rows);
  assert.equal(data.length, 1);
  assert.equal(data[0][0], 'T-1');
  assert.equal(data[0][12], 100);
  assert.ok(data[0][1] instanceof Date);
});

test('Nómina incluye liquidaciones cuyo turno ya no está en la caché local', () => {
  const rows = generatePayrollSheet(baseData({
    salarySettlements: [{
      id: 'st-gone', userId: 'u1', userName: 'Ana', sessionId: 'session-missing',
      baseSalary: 2000, commissions: 300, total: 2300, date: '2026-11-20T20:00:00.000Z', status: 'paid',
    }] as any,
  }));
  const data = dataRows(rows);
  assert.equal(data.length, 1);
  assert.equal(data[0][0], 'st-gone');
  assert.equal(data[0][1] instanceof Date, true);
  assert.equal(data[0][8], 2300);
  assert.equal(data[0][9], 'PAGADO');
  assert.match(String(data[0][10]), /Sin turno asociado/);
});

test('Catálogo suma stock de todos los almacenes y variantes por producto', () => {
  const rows = generateProductsPerformanceSheet(baseData({
    products: [
      { id: 'p1', name: 'Producto A', sku: 'A-1', barcode: '1', price: 100, costPrice: 60, categoryId: 'c1', status: 'active' },
    ] as any,
    transactions: [sale()],
    inventory: [
      { productId: 'p1', branchId: 'b1', quantity: 3 },
      { productId: 'p1', branchId: 'b2', quantity: 2 },
      { productId: 'p1', branchId: 'b1', variantLabel: '220V', quantity: 4 },
    ] as any,
  }));
  const [row] = dataRows(rows);
  assert.equal(row[8], 9);
  assert.equal(row[9], 540);
  assert.equal(row[12], 1);
  assert.equal(row[13], 100);
});

test('Transferencias expande variantes y traduce el estado al español', () => {
  const rows = generateTransfersSheet(baseData({
    transfers: [{
      id: 't1', productName: 'Producto A', fromBranchId: 'b1', toBranchId: 'b2', userId: 'u1',
      status: 'in_transit', date: '2026-11-19T10:00:00.000Z',
      variants: [{ variantLabel: '220V', quantity: 2 }, { variantLabel: '110V', quantity: 1 }],
    }] as any,
  }));
  const data = dataRows(rows);
  assert.equal(data.length, 2);
  assert.equal(data[0][3], '220V');
  assert.equal(data[1][3], '110V');
  assert.equal(data[0][4], 2);
  assert.equal(data[1][4], 1);
  assert.equal(data[0][8], 'En tránsito');
});

test('Descuadres calculan diferencia base y no duplican la deducción salarial', () => {
  const rows = generateDiscrepanciesSheet(baseData({
    cashSessions: [{
      id: 's1', turnNumber: 7, branchId: 'b1', status: 'closed', workerName: 'Ana',
      openedAt: '2026-11-20T08:00:00.000Z', closedAt: '2026-11-20T20:00:00.000Z',
      discrepancyDetails: [
        { currencyCode: 'CUP', method: 'cash', expected: 55000, actual: 54000, difference: -1000 },
        { currencyCode: 'USD', method: 'cash', expected: 100, actual: 90, difference: -10 },
      ],
      discrepancyDeductionApplied: 500,
    }] as any,
  }));
  const data = dataRows(rows);
  assert.equal(data.length, 2);
  assert.equal(data[0][10], -1000);
  assert.equal(data[0][11], -1000);
  assert.equal(data[1][10], -10);
  assert.equal(data[1][11], -3700);
  assert.equal(data[0][13], 500);
  assert.equal(data[1][13], 0);
  assert.equal(rows[0][11], 'Diferencia Equivalente Base (CUP)');

  const kpis = SECTION_DEFINITIONS.discrepancies.buildKpis(rows as any, baseData() as any);
  assert.equal(kpis.find(kpi => kpi.label === 'Faltantes')?.value, 4700);
  assert.equal(kpis.find(kpi => kpi.label === 'Deducciones aplicadas')?.value, 500);
});

test('Resumen por moneda usa la tasa guardada en el pago, no la tasa actual', () => {
  const breakdown = buildCurrencyBreakdown(baseData({
    transactions: [sale({
      payments: [{ currencyCode: 'USD', method: 'cash', amount: 20, exchangeRate: 370 }],
    })],
    currencies: [
      baseCurrency,
      { code: 'USD', name: 'Dólar', symbol: 'US$', rateToBase: 400, isBase: false },
    ] as any,
  }));
  const usd = breakdown.find(row => row.code === 'USD');
  assert.ok(usd);
  assert.equal(usd.cash, 20);
  assert.equal(usd.totalBase, 7400);
  assert.equal(buildCurrencyBreakdown(baseData()).length, 0);
});

test('Inventario agrega valorización por categoría, estado y totales', async () => {
  const workbook = await buildInventoryWorkbook([
    { name: 'Producto A', sku: 'A-1', categoryName: 'Climatización', unit: 'uds', price: 100, costPrice: 60, totalStock: 2, minQuantity: 1 },
    { name: 'Producto B', sku: 'B-2', categoryName: 'Climatización', unit: 'uds', price: 50, costPrice: 20, totalStock: 1, minQuantity: 3 },
    { name: 'Producto C', sku: 'C-3', categoryName: 'Línea blanca', unit: 'uds', price: 200, costPrice: 100, totalStock: 0, minQuantity: 1 },
  ], { businessName: 'PALMYRA Test', currencyCode: 'CUP', generatedAt: new Date(2026, 10, 22) });

  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Portada y Resumen', 'Inventario', 'Valorización por Categoría']);
  const inventory = workbook.getWorksheet('Inventario')!;
  assert.equal(inventory.getCell(5, 11).value, 120);
  assert.equal(inventory.getCell(6, 13).value, 'Bajo mínimo');
  assert.equal(inventory.getCell(7, 13).value, 'Agotado');
  assert.equal(inventory.getCell(8, 11).value, 140);
  const categories = workbook.getWorksheet('Valorización por Categoría')!;
  assert.equal(categories.getCell(5, 1).value, 'Climatización');
  assert.equal(categories.getCell(5, 4).value, 140);
  assert.equal(categories.getCell(7, 4).value, 140);
});
