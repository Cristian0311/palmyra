import type { Workbook } from 'exceljs';

import type { ExcelExportData } from './types';
import type { AIDiagnosticReport } from './types';
import { SECTION_DEFINITIONS, sectionEntries, type SectionKey } from './sectionDefinitions';
import { addCoverSheet, addDataSheet, createWorkbook, sanitizeSheetName, type ChartRenderer, type CoverDefinition, type DataSheetDefinition } from './workbook';
import { cellNumber, countRows, dataRows, buildTrendChart, type ExportRows, type KpiDefinition } from './analytics';
import type { ChartSpec } from './chartRenderer';
import { FONT_FAMILY, PALETTE, reportStamp } from './theme';

export interface WorkbookBuildOptions {
  chartRenderer?: ChartRenderer;
  now?: Date;
}

function sum(rows: ExportRows, index: number): number {
  return dataRows(rows).reduce((total, row) => total + cellNumber(row[index]), 0);
}

function sheetSubtitle(data: ExcelExportData, generatedAt: Date): string {
  const period = data.dateFilterLabel || 'Todo el historial';
  const currency = data.baseCurrency?.code || 'CUP';
  return `Periodo: ${period} · Moneda: ${currency} · Generado: ${reportStamp(generatedAt)} · PALMYRA POS`;
}

function buildSectionsRows(data: ExcelExportData) {
  return sectionEntries(data).map(({ definition, rows }) => ({ definition, rows }));
}

function buildGlobalKpis(
  salesRows: ExportRows,
  itemsRows: ExportRows,
  movementsRows: ExportRows,
  bankRows: ExportRows,
  productRows: ExportRows,
): KpiDefinition[] {
  const tickets = countRows(salesRows);
  const total = sum(salesRows, 12);
  const itemsData = dataRows(itemsRows);
  const revenue = sum(itemsRows, 14);
  const margin = sum(itemsRows, 16);
  const missingCost = itemsData.filter(row => String(row[22] || '') === 'Sin costo').length;
  const cashIncome = dataRows(movementsRows)
    .filter(row => String(row[5]).startsWith('INGRESO'))
    .reduce((amount, row) => amount + cellNumber(row[9]), 0);
  const cashExpense = dataRows(movementsRows)
    .filter(row => String(row[5]).startsWith('EGRESO'))
    .reduce((amount, row) => amount + cellNumber(row[9]), 0);
  const bankIn = dataRows(bankRows)
    .filter(row => String(row[13]) === 'ENTRADA')
    .reduce((amount, row) => amount + cellNumber(row[10]), 0);
  const bankOut = dataRows(bankRows)
    .filter(row => String(row[13]) === 'SALIDA')
    .reduce((amount, row) => amount + cellNumber(row[10]), 0);

  return [
    { label: 'Ventas totales', value: total, format: 'currency', hint: `${tickets} tickets completados`, tone: 'violet' },
    { label: 'Tickets emitidos', value: tickets, format: 'integer', hint: 'Solo ventas vigentes', tone: 'info' },
    { label: 'Ticket promedio', value: tickets ? total / tickets : 0, format: 'currency', hint: 'Promedio por comprobante', tone: 'violet' },
    { label: 'Unidades vendidas', value: sum(salesRows, 8), format: 'integer', hint: 'Unidades despachadas', tone: 'success' },
    {
      label: 'Margen bruto',
      value: margin,
      format: 'currency',
      hint: missingCost > 0 ? `${missingCost} líneas sin costo confiable` : 'Ingresos menos costo',
      tone: 'success',
    },
    { label: 'Flujo neto de caja', value: cashIncome - cashExpense, format: 'currency', hint: 'Ingresos menos egresos de caja', tone: cashIncome - cashExpense >= 0 ? 'success' : 'danger' },
    { label: 'Flujo bancario neto', value: bankIn - bankOut, format: 'currency', hint: 'Entradas menos salidas bancarias', tone: bankIn - bankOut >= 0 ? 'success' : 'danger' },
    { label: 'Inventario a costo', value: sum(productRows, 9), format: 'currency', hint: 'Capital inmovilizado en stock', tone: 'warning' },
  ];
}

function buildGlobalCharts(salesRows: ExportRows): ChartSpec[] {
  const cash = sum(salesRows, 13);
  const transfer = sum(salesRows, 14);
  const charts: (ChartSpec | null)[] = [
    buildTrendChart(salesRows, 1, [{ name: 'Ventas', columnIndex: 12 }], {
      title: 'Tendencia de ventas del periodo',
      subtitle: 'Total facturado por día o mes',
      format: 'currency',
    }),
  ];
  if (cash + transfer > 0) {
    charts.push({
      kind: 'donut',
      title: 'Composición de los cobros',
      subtitle: 'Efectivo y transferencia en moneda base',
      labels: ['Efectivo', 'Transferencia'],
      series: [{ name: 'Cobros', values: [cash, transfer] }],
      valueFormat: 'currency',
      centerLabel: 'COBRADO',
    });
  }
  return charts.filter((chart): chart is ChartSpec => Boolean(chart));
}

function currencyCode(data: ExcelExportData): string {
  return data.baseCurrency?.code || 'CUP';
}

function genericCover(
  data: ExcelExportData,
  title: string,
  kpis: KpiDefinition[],
  charts: ChartSpec[],
  generatedAt: Date,
  sections?: CoverDefinition['sections'],
): CoverDefinition {
  return {
    company: data.businessName || 'PALMYRA',
    title,
    period: data.dateFilterLabel || 'Todo el historial',
    currencyCode: currencyCode(data),
    generatedAt,
    kpis,
    charts,
    sections,
    subtitle: sheetSubtitle(data, generatedAt),
    note: `Los importes monetarios se expresan en ${currencyCode(data)} salvo que la columna indique otra moneda.`,
  };
}

function dataSheetFor(key: SectionKey, data: ExcelExportData, rows: ExportRows, generatedAt: Date): DataSheetDefinition {
  const definition = SECTION_DEFINITIONS[key];
  return {
    name: definition.sheetName,
    title: definition.title,
    subtitle: sheetSubtitle(data, generatedAt),
    columns: definition.columns,
    rows,
    emptyMessage: definition.emptyMessage,
    totalsLabel: 'TOTALES',
  };
}

function addDiagnosticSheet(workbook: Workbook, diagnostic: AIDiagnosticReport, generatedAt: Date): void {
  const worksheet = workbook.addWorksheet(sanitizeSheetName('Diagnóstico IA'), {
    properties: { tabColor: { argb: PALETTE.violetDark }, defaultRowHeight: 16 },
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  worksheet.columns = [{ width: 52 }, { width: 28 }, { width: 24 }, { width: 34 }, { width: 34 }, { width: 16 }];

  worksheet.mergeCells(1, 1, 1, 6);
  const band = worksheet.getCell(1, 1);
  band.value = 'PALMYRA  ·  DIAGNÓSTICO ESTRATÉGICO CON IA';
  band.font = { name: FONT_FAMILY, size: 14, bold: true, color: { argb: PALETTE.white } };
  band.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.violet } };
  band.alignment = { vertical: 'middle', indent: 1 };
  worksheet.getRow(1).height = 30;

  worksheet.mergeCells(2, 1, 2, 6);
  const meta = worksheet.getCell(2, 1);
  meta.value = `Generado: ${reportStamp(generatedAt)} · Puntuación de salud financiera: ${Math.max(0, Math.min(100, Number(diagnostic.healthScore) || 0))}/100`;
  meta.font = { name: FONT_FAMILY, size: 9, italic: true, color: { argb: PALETTE.muted } };
  meta.alignment = { vertical: 'middle', indent: 1 };

  let row = 4;
  const writeHeading = (text: string) => {
    worksheet.mergeCells(row, 1, row, 6);
    const cell = worksheet.getCell(row, 1);
    cell.value = text.toUpperCase();
    cell.font = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: PALETTE.violetDark } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.violetSoft } };
    cell.alignment = { vertical: 'middle', indent: 1 };
    worksheet.getRow(row).height = 22;
    row += 1;
  };
  const writeParagraph = (text: string) => {
    worksheet.mergeCells(row, 1, row, 6);
    const cell = worksheet.getCell(row, 1);
    cell.value = text;
    cell.font = { name: FONT_FAMILY, size: 10, color: { argb: PALETTE.ink } };
    cell.alignment = { vertical: 'top', wrapText: true, indent: 1 };
    worksheet.getRow(row).height = 32;
    row += 1;
  };
  const writeList = (items: string[] | undefined) => {
    (items || []).forEach(item => {
      worksheet.mergeCells(row, 1, row, 6);
      const cell = worksheet.getCell(row, 1);
      cell.value = `•  ${item}`;
      cell.font = { name: FONT_FAMILY, size: 10, color: { argb: PALETTE.ink } };
      cell.alignment = { vertical: 'top', wrapText: true, indent: 1 };
      worksheet.getRow(row).height = 26;
      row += 1;
    });
    row += 1;
  };

  writeHeading('Resumen ejecutivo');
  writeParagraph(diagnostic.executiveSummary || 'Auditoría completada.');
  row += 1;
  writeHeading('Alertas críticas de caja');
  writeList(diagnostic.cashAlerts);
  writeHeading('Insights comerciales');
  writeList(diagnostic.topInsights);
  writeHeading('Recomendaciones de inventario');
  writeList(diagnostic.inventoryAdvice);
  writeHeading('Acciones estratégicas');
  writeList(diagnostic.strategicActions);

  writeHeading('Matriz de auditoría');
  const headers = ['Área', 'Métrica / Indicador', 'Estado Actual', 'Diagnóstico Operativo', 'Acción Recomendada', 'Prioridad'];
  headers.forEach((header, index) => {
    const cell = worksheet.getCell(row, index + 1);
    cell.value = header;
    cell.font = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: PALETTE.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.violet } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  worksheet.getRow(row).height = 28;
  row += 1;

  (diagnostic.structuredAuditRows || []).forEach((auditRow, index) => {
    auditRow.forEach((value, columnIndex) => {
      const cell = worksheet.getCell(row, columnIndex + 1);
      cell.value = value;
      cell.font = { name: FONT_FAMILY, size: 9, color: { argb: PALETTE.ink } };
      cell.alignment = { vertical: 'top', wrapText: true };
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.zebra } };
      cell.border = { bottom: { style: 'hair', color: { argb: PALETTE.line } } };
    });
    worksheet.getRow(row).height = 30;
    row += 1;
  });
}

export async function buildFullReportWorkbook(data: ExcelExportData, options: WorkbookBuildOptions = {}): Promise<Workbook> {
  const generatedAt = options.now || new Date();
  const workbook = createWorkbook(data.businessName || 'PALMYRA', generatedAt);
  const entries = buildSectionsRows(data);
  const byKey = new Map(entries.map(entry => [entry.definition.key, entry.rows]));
  const empty: ExportRows = [];

  const salesRows = byKey.get('sales') || empty;
  const itemsRows = byKey.get('items') || empty;
  const movementsRows = byKey.get('movements') || empty;
  const bankRows = byKey.get('banks') || empty;
  const productRows = byKey.get('products') || empty;

  const coverSections = entries.map(({ definition, rows }) => ({
    name: definition.sheetName,
    records: countRows(rows),
    detail: definition.label,
  }));
  const summaryRows = SECTION_DEFINITIONS.summary.generate(data) as ExportRows;
  byKey.set('summary', summaryRows);
  coverSections.push({
    name: SECTION_DEFINITIONS.summary.sheetName,
    records: countRows(summaryRows),
    detail: SECTION_DEFINITIONS.summary.label,
  });

  const cover = genericCover(
    data,
    'Reporte general de operaciones',
    buildGlobalKpis(salesRows, itemsRows, movementsRows, bankRows, productRows),
    buildGlobalCharts(salesRows),
    generatedAt,
    coverSections,
  );
  await addCoverSheet(workbook, cover, options.chartRenderer);

  // Orden estable de las hojas, independiente de las claves del objeto.
  const order: SectionKey[] = ['sales', 'items', 'sessions', 'payroll', 'products', 'banks', 'returns', 'discrepancies', 'movements', 'transfers', 'summary'];
  for (const key of order) {
    const rows = byKey.get(key) || [];
    // La fila 0 es el encabezado legado del generador; la hoja dibuja el suyo.
    addDataSheet(workbook, dataSheetFor(key, data, rows.slice(1), generatedAt));
  }

  if (data.aiDiagnostic) {
    addDiagnosticSheet(workbook, data.aiDiagnostic, generatedAt);
  }

  return workbook;
}

export async function buildSectionWorkbook(
  key: SectionKey,
  data: ExcelExportData,
  options: WorkbookBuildOptions = {},
): Promise<Workbook> {
  const generatedAt = options.now || new Date();
  const workbook = createWorkbook(data.businessName || 'PALMYRA', generatedAt);
  const definition = SECTION_DEFINITIONS[key];
  const rows = definition.generate(data) as ExportRows;

  let kpis: KpiDefinition[];
  let charts: ChartSpec[];
  if (key === 'summary') {
    const entries = buildSectionsRows(data);
    const byKey = new Map(entries.map(entry => [entry.definition.key, entry.rows]));
    const empty: ExportRows = [];
    kpis = buildGlobalKpis(
      byKey.get('sales') || empty,
      byKey.get('items') || empty,
      byKey.get('movements') || empty,
      byKey.get('banks') || empty,
      byKey.get('products') || empty,
    );
    charts = buildGlobalCharts(byKey.get('sales') || empty);
  } else {
    kpis = definition.buildKpis(rows, data);
    charts = definition.buildCharts(rows, data).filter((chart): chart is ChartSpec => Boolean(chart));
  }

  const cover = genericCover(data, definition.title, kpis, charts, generatedAt, [
    { name: definition.sheetName, records: countRows(rows), detail: definition.label },
  ]);
  await addCoverSheet(workbook, cover, options.chartRenderer);
  // Igual que en el reporte completo: se omite la cabecera legada.
  addDataSheet(workbook, dataSheetFor(key, data, rows.slice(1), generatedAt));
  return workbook;
}
