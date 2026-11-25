/**
 * Constructor único de libros PALMYRA.
 *
 * Todas las secciones comparten la misma portada, banda de título, tarjetas de
 * KPI, tablas con filas alternas, fila de totales, configuración de impresión y
 * gráficas incrustadas como PNG. Así el resultado se ve como un libro
 * corporativo y no como un volcado de datos.
 */

import * as ExcelJSImport from 'exceljs';
import type { Alignment, Borders, CellValue, Image, Workbook, Worksheet } from 'exceljs';

// El paquete publica CommonJS en Node y un UMD en el navegador; ambos casos
// exponen la API en `default` al importarse como ESM.
const ExcelJS: typeof ExcelJSImport = ((ExcelJSImport as unknown as { default?: typeof ExcelJSImport }).default ||
  ExcelJSImport) as typeof ExcelJSImport;

import { renderChartSvg, type ChartSpec } from './chartRenderer';
import { renderChartPng, type RenderedChart } from './chartPng';
import { downloadGeneratedFile, XLSX_MIME } from '../downloadFile';
import { FONT_FAMILY, NUM_FMT, PALETTE, SHEET_LAYOUT, reportStamp, safeText, toFiniteNumber } from './theme';
import type { KpiDefinition } from './analytics';
import type { ExportCell } from './analytics';

export type ColumnKind = 'text' | 'mono' | 'integer' | 'currency' | 'percent' | 'date' | 'datetime' | 'time' | 'rate';

export interface SheetColumn {
  header: string;
  kind: ColumnKind;
  width: number;
  /** Sumar esta columna en la fila de totales. */
  total?: boolean;
  /** Permitir salto de línea (notas, descripciones). */
  wrap?: boolean;
}

export interface DataSheetDefinition {
  name: string;
  title: string;
  subtitle?: string;
  columns: SheetColumn[];
  rows: ExportCell[][];
  totalsLabel?: string;
  emptyMessage?: string;
  tabColor?: string;
}

export interface CoverSectionRow {
  name: string;
  records: number;
  detail?: string;
}

export interface CoverDefinition {
  company: string;
  title: string;
  subtitle?: string;
  period: string;
  currencyCode: string;
  generatedAt?: Date;
  kpis: KpiDefinition[];
  charts: ChartSpec[];
  sections?: CoverSectionRow[];
  note?: string;
}

export type ChartRenderer = (spec: ChartSpec) => Promise<RenderedChart | null>;

export const browserChartRenderer: ChartRenderer = spec => renderChartPng(spec);

const TITLE_COLUMNS = 13; // B..M (A queda como margen)
const KPI_COLUMNS = 4;
const KPI_CARD_COLUMNS = 3;

const TONE_COLORS: Record<NonNullable<KpiDefinition['tone']>, string> = {
  violet: PALETTE.violet,
  success: PALETTE.success,
  warning: PALETTE.warning,
  danger: PALETTE.danger,
  info: PALETTE.info,
};

const thinBorder: Partial<Borders> = {
  top: { style: 'thin', color: { argb: PALETTE.line } },
  left: { style: 'thin', color: { argb: PALETTE.line } },
  bottom: { style: 'thin', color: { argb: PALETTE.line } },
  right: { style: 'thin', color: { argb: PALETTE.line } },
};

export function createWorkbook(company: string, now = new Date()): Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PALMYRA POS';
  workbook.lastModifiedBy = 'PALMYRA POS';
  workbook.company = safeText(company, 'PALMYRA');
  workbook.created = now;
  workbook.modified = now;
  workbook.title = 'Reporte empresarial PALMYRA';
  workbook.subject = 'Reporte generado por PALMYRA POS';
  workbook.keywords = 'PALMYRA, reporte, ventas, inventario';
  workbook.calcProperties.fullCalcOnLoad = false;
  return workbook;
}

export function sanitizeSheetName(name: string): string {
  const clean = safeText(name, 'Reporte').replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 31) || 'Reporte';
}

function formatKpiValue(definition: KpiDefinition, currencyCode: string): { value: number; numFmt: string } {
  if (definition.format === 'currency') {
    return { value: definition.value, numFmt: currencyCode ? `#,##0.00" ${currencyCode}"` : NUM_FMT.currency };
  }
  if (definition.format === 'percent') return { value: definition.value, numFmt: NUM_FMT.percent };
  return { value: definition.value, numFmt: NUM_FMT.integer };
}

function mergeRow(worksheet: Worksheet, row: number, fromColumn: number, toColumn: number): void {
  if (toColumn > fromColumn) {
    worksheet.mergeCells(row, fromColumn, row, toColumn);
  }
}

function fillRange(
  worksheet: Worksheet,
  top: number,
  left: number,
  bottom: number,
  right: number,
  argb: string,
): void {
  for (let row = top; row <= bottom; row += 1) {
    for (let column = left; column <= right; column += 1) {
      worksheet.getCell(row, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    }
  }
}

function writeCoverMetadata(
  worksheet: Worksheet,
  cover: CoverDefinition,
  generatedAt: Date,
): void {
  worksheet.getCell(5, 2).value = safeText(cover.company, 'PALMYRA');
  worksheet.getCell(5, 2).font = { name: FONT_FAMILY, size: 16, bold: true, color: { argb: PALETTE.ink } };

  worksheet.getCell(5, 8).value = `PERIODO  ·  ${safeText(cover.period, 'Todo el historial')}`;
  worksheet.getCell(5, 8).font = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: PALETTE.muted } };
  worksheet.getCell(5, 8).alignment = { horizontal: 'right', vertical: 'middle' };
  mergeRow(worksheet, 5, 8, TITLE_COLUMNS);

  worksheet.getCell(6, 2).value = `Moneda base: ${safeText(cover.currencyCode, 'CUP')}  ·  Documento empresarial de uso interno`;
  worksheet.getCell(6, 2).font = { name: FONT_FAMILY, size: 9, color: { argb: PALETTE.muted } };
  mergeRow(worksheet, 6, 2, 7);

  worksheet.getCell(6, 8).value = `Generado: ${reportStamp(generatedAt)}`;
  worksheet.getCell(6, 8).font = { name: FONT_FAMILY, size: 9, color: { argb: PALETTE.muted } };
  worksheet.getCell(6, 8).alignment = { horizontal: 'right', vertical: 'middle' };
  mergeRow(worksheet, 6, 8, TITLE_COLUMNS);
}

function writeKpiCard(
  worksheet: Worksheet,
  topRow: number,
  leftColumn: number,
  definition: KpiDefinition,
  currencyCode: string,
): void {
  const rightColumn = leftColumn + KPI_CARD_COLUMNS - 1;
  fillRange(worksheet, topRow, leftColumn, topRow + 2, rightColumn, PALETTE.violetSoft);
  for (let row = topRow; row <= topRow + 2; row += 1) {
    for (let column = leftColumn; column <= rightColumn; column += 1) {
      worksheet.getCell(row, column).border = {
        top: { style: 'thin', color: { argb: PALETTE.violetBorder } },
        bottom: { style: row === topRow + 2 ? 'medium' : 'thin', color: { argb: PALETTE.violetBorder } },
        left: { style: column === leftColumn ? 'medium' : 'thin', color: { argb: column === leftColumn ? PALETTE.violet : PALETTE.violetBorder } },
        right: { style: 'thin', color: { argb: PALETTE.violetBorder } },
      };
    }
  }
  mergeRow(worksheet, topRow, leftColumn, rightColumn);
  mergeRow(worksheet, topRow + 1, leftColumn, rightColumn);
  mergeRow(worksheet, topRow + 2, leftColumn, rightColumn);

  const label = worksheet.getCell(topRow, leftColumn);
  label.value = definition.label.toUpperCase();
  label.font = { name: FONT_FAMILY, size: 8, bold: true, color: { argb: PALETTE.muted } };
  label.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  const formatted = formatKpiValue(definition, currencyCode);
  const value = worksheet.getCell(topRow + 1, leftColumn);
  value.value = formatted.value;
  value.numFmt = formatted.numFmt;
  value.font = {
    name: FONT_FAMILY,
    size: 16,
    bold: true,
    color: { argb: TONE_COLORS[definition.tone || 'violet'] },
  };
  value.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  const hint = worksheet.getCell(topRow + 2, leftColumn);
  hint.value = definition.hint || ' ';
  hint.font = { name: FONT_FAMILY, size: 8, color: { argb: PALETTE.muted } };
  hint.alignment = { horizontal: 'left', vertical: 'top', indent: 1 };
}

function writeContentTable(
  worksheet: Worksheet,
  startRow: number,
  sections: CoverSectionRow[],
): number {
  worksheet.getCell(startRow, 2).value = 'CONTENIDO DEL LIBRO';
  worksheet.getCell(startRow, 2).font = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: PALETTE.violetDark } };
  mergeRow(worksheet, startRow, 2, TITLE_COLUMNS);
  worksheet.getCell(startRow, 2).border = { bottom: { style: 'thin', color: { argb: PALETTE.violetBorder } } };

  const headerRow = startRow + 1;
  ['Hoja', 'Registros', 'Detalle'].forEach((header, index) => {
    const cell = worksheet.getCell(headerRow, [2, 7, 9][index]);
    cell.value = header;
    cell.font = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: PALETTE.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.violet } };
    cell.alignment = { horizontal: index === 0 ? 'left' : 'center', vertical: 'middle' };
  });
  mergeRow(worksheet, headerRow, 2, 6);
  mergeRow(worksheet, headerRow, 7, 8);
  mergeRow(worksheet, headerRow, 9, TITLE_COLUMNS);

  sections.forEach((section, index) => {
    const row = headerRow + 1 + index;
    const zebra = index % 2 === 1 ? PALETTE.zebra : PALETTE.white;
    const nameCell = worksheet.getCell(row, 2);
    nameCell.value = section.name;
    nameCell.font = { name: FONT_FAMILY, size: 9, color: { argb: PALETTE.ink } };
    nameCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
    mergeRow(worksheet, row, 2, 6);

    const countCell = worksheet.getCell(row, 7);
    countCell.value = section.records;
    countCell.numFmt = NUM_FMT.integer;
    countCell.font = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: PALETTE.violet } };
    countCell.alignment = { horizontal: 'center' };
    countCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
    mergeRow(worksheet, row, 7, 8);

    const detailCell = worksheet.getCell(row, 9);
    detailCell.value = section.detail || '';
    detailCell.font = { name: FONT_FAMILY, size: 9, color: { argb: PALETTE.muted } };
    detailCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
    mergeRow(worksheet, row, 9, TITLE_COLUMNS);
  });

  return headerRow + sections.length + 1;
}

async function embedCharts(
  workbook: Workbook,
  worksheet: Worksheet,
  charts: ChartSpec[],
  startRow: number,
  renderer: ChartRenderer,
): Promise<void> {
  let row = startRow;
  for (const chart of charts) {
    let rendered: RenderedChart | null = null;
    try {
      rendered = await renderer(chart);
    } catch {
      rendered = null;
    }
    if (!rendered) continue;
    const imageId = workbook.addImage({
      base64: rendered.base64,
      buffer: rendered.buffer as any,
      extension: 'png',
    } as Image);
    worksheet.addImage(imageId, {
      tl: { col: 1.1, row },
      ext: { width: 700, height: 320 },
      editAs: 'oneCell',
    });
    // 320 px de alto + un margen visual entre gráficas.
    row += 18;
  }
}

export async function addCoverSheet(
  workbook: Workbook,
  cover: CoverDefinition,
  renderer: ChartRenderer = browserChartRenderer,
): Promise<Worksheet> {
  const worksheet = workbook.addWorksheet(sanitizeSheetName('Portada y Resumen'), {
    properties: { tabColor: { argb: PALETTE.violetDark }, defaultRowHeight: 15 },
    views: [{ showGridLines: false }],
  });
  worksheet.columns = [
    { width: 2.2 },
    ...Array.from({ length: 12 }, () => ({ width: 11.5 })),
  ];

  const generatedAt = cover.generatedAt || new Date();

  worksheet.mergeCells(1, 2, 3, TITLE_COLUMNS);
  const banner = worksheet.getCell(1, 2);
  banner.value = `PALMYRA   ·   ${safeText(cover.company, 'GESTIÓN EMPRESARIAL').toUpperCase()}`;
  banner.font = { name: FONT_FAMILY, size: 18, bold: true, color: { argb: PALETTE.white } };
  banner.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  fillRange(worksheet, 1, 2, 3, TITLE_COLUMNS, PALETTE.violet);
  worksheet.getRow(1).height = 16;
  worksheet.getRow(2).height = 16;
  worksheet.getRow(3).height = 16;

  worksheet.mergeCells(4, 2, 4, TITLE_COLUMNS);
  const title = worksheet.getCell(4, 2);
  title.value = safeText(cover.title, 'Reporte general');
  title.font = { name: FONT_FAMILY, size: 13, bold: true, color: { argb: PALETTE.violetDark } };
  title.alignment = { vertical: 'middle', indent: 1 };
  worksheet.getRow(4).height = 24;

  writeCoverMetadata(worksheet, cover, generatedAt);
  worksheet.getRow(5).height = 22;
  worksheet.getRow(6).height = 16;

  if (cover.subtitle) {
    worksheet.getCell(7, 2).value = cover.subtitle;
    worksheet.getCell(7, 2).font = { name: FONT_FAMILY, size: 9, italic: true, color: { argb: PALETTE.muted } };
    mergeRow(worksheet, 7, 2, TITLE_COLUMNS);
  }

  const kpiTitleRow = 8;
  worksheet.getCell(kpiTitleRow, 2).value = 'INDICADORES CLAVE DEL PERIODO';
  worksheet.getCell(kpiTitleRow, 2).font = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: PALETTE.violetDark } };
  worksheet.getCell(kpiTitleRow, 2).border = { bottom: { style: 'thin', color: { argb: PALETTE.violetBorder } } };
  mergeRow(worksheet, kpiTitleRow, 2, TITLE_COLUMNS);

  const kpis = cover.kpis.slice(0, 8);
  kpis.forEach((definition, index) => {
    const cardRow = kpiTitleRow + 1 + Math.floor(index / KPI_COLUMNS) * 5;
    const leftColumn = 2 + (index % KPI_COLUMNS) * KPI_CARD_COLUMNS;
    writeKpiCard(worksheet, cardRow, leftColumn, definition, cover.currencyCode);
  });
  const kpiBlockRows = Math.max(1, Math.ceil(kpis.length / KPI_COLUMNS));
  let cursor = kpiTitleRow + 1 + (kpiBlockRows - 1) * 5 + 4;

  if (cover.charts.length > 0) {
    worksheet.getCell(cursor, 2).value = 'ANÁLISIS VISUAL';
    worksheet.getCell(cursor, 2).font = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: PALETTE.violetDark } };
    mergeRow(worksheet, cursor, 2, TITLE_COLUMNS);
    cursor += 2;
    await embedCharts(workbook, worksheet, cover.charts, cursor, renderer);
    cursor += Math.max(1, cover.charts.length) * 18 + 1;
  }

  if (cover.sections && cover.sections.length > 0) {
    cursor = writeContentTable(worksheet, cursor, cover.sections) + 1;
  }

  if (cover.note) {
    worksheet.getCell(cursor, 2).value = cover.note;
    worksheet.getCell(cursor, 2).font = { name: FONT_FAMILY, size: 8, italic: true, color: { argb: PALETTE.muted } };
    mergeRow(worksheet, cursor, 2, TITLE_COLUMNS);
    cursor += 2;
  }

  worksheet.getCell(cursor, 2).value = `PALMYRA POS · Documento generado automáticamente el ${reportStamp(generatedAt)} · ${safeText(cover.currencyCode, 'CUP')}`;
  worksheet.getCell(cursor, 2).font = { name: FONT_FAMILY, size: 8, color: { argb: PALETTE.muted } };
  mergeRow(worksheet, cursor, 2, TITLE_COLUMNS);

  worksheet.pageSetup = {
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    horizontalCentered: true,
  };

  return worksheet;
}

function alignmentFor(kind: ColumnKind): Partial<Alignment> {
  switch (kind) {
    case 'currency':
    case 'integer':
    case 'percent':
    case 'rate':
      return { horizontal: 'right', vertical: 'middle' };
    case 'date':
    case 'datetime':
    case 'time':
      return { horizontal: 'center', vertical: 'middle' };
    case 'mono':
      return { horizontal: 'left', vertical: 'middle' };
    default:
      return { horizontal: 'left', vertical: 'middle' };
  }
}

function numFmtFor(kind: ColumnKind): string | undefined {
  switch (kind) {
    case 'currency':
      return NUM_FMT.currency;
    case 'integer':
      return NUM_FMT.integer;
    case 'percent':
      return NUM_FMT.percent;
    case 'rate':
      return NUM_FMT.rate;
    case 'date':
      return NUM_FMT.date;
    case 'datetime':
      return NUM_FMT.datetime;
    case 'time':
      return NUM_FMT.time;
    default:
      return undefined;
  }
}

function normalizeCell(value: ExportCell, kind: ColumnKind): ExportCell {
  if (value === null || value === undefined) return null;
  if (kind === 'date' || kind === 'datetime' || kind === 'time') {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }
  if (kind === 'currency' || kind === 'integer' || kind === 'percent' || kind === 'rate') {
    return toFiniteNumber(value, 0);
  }
  return typeof value === 'string' ? value : String(value);
}

export function addDataSheet(
  workbook: Workbook,
  definition: DataSheetDefinition,
): Worksheet {
  const columns = definition.columns;
  const lastColumn = Math.max(1, columns.length);
  const worksheet = workbook.addWorksheet(sanitizeSheetName(definition.name), {
    properties: { tabColor: { argb: definition.tabColor || PALETTE.violet }, defaultRowHeight: 15 },
    views: [{ state: 'frozen', ySplit: SHEET_LAYOUT.headerRow, showGridLines: false }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      horizontalCentered: true,
      printTitlesRow: `${SHEET_LAYOUT.headerRow}:${SHEET_LAYOUT.headerRow}`,
    },
    headerFooter: {
      oddFooter: '&L&8PALMYRA POS&C&8Página &P de &N&R&8&D',
      evenFooter: '&L&8PALMYRA POS&C&8Página &P de &N&R&8&D',
    },
  });

  worksheet.columns = columns.map(column => ({ width: column.width }));

  worksheet.mergeCells(1, 1, 1, lastColumn);
  const band = worksheet.getCell(1, 1);
  band.value = `PALMYRA  ·  ${safeText(definition.title, definition.name).toUpperCase()}`;
  band.font = { name: FONT_FAMILY, size: 14, bold: true, color: { argb: PALETTE.white } };
  band.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  fillRange(worksheet, 1, 1, 1, lastColumn, PALETTE.violet);
  worksheet.getRow(1).height = SHEET_LAYOUT.titleRowHeight;

  worksheet.mergeCells(2, 1, 2, lastColumn);
  const subtitle = worksheet.getCell(2, 1);
  subtitle.value = definition.subtitle || '';
  subtitle.font = { name: FONT_FAMILY, size: 9, italic: true, color: { argb: PALETTE.muted } };
  subtitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  fillRange(worksheet, 2, 1, 2, lastColumn, PALETTE.violetSofter);
  worksheet.getRow(2).height = 18;
  worksheet.getRow(3).height = 6;

  const headerRow = SHEET_LAYOUT.headerRow;
  columns.forEach((column, index) => {
    const cell = worksheet.getCell(headerRow, index + 1);
    cell.value = column.header;
    cell.font = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: PALETTE.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.violet } };
    cell.alignment = { horizontal: column.kind === 'text' || column.kind === 'mono' ? 'left' : 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: PALETTE.violet } },
      bottom: { style: 'medium', color: { argb: PALETTE.violetDark } },
      left: { style: 'thin', color: { argb: PALETTE.violet } },
      right: { style: 'thin', color: { argb: PALETTE.violet } },
    };
  });
  worksheet.getRow(headerRow).height = SHEET_LAYOUT.headerRowHeight;

  const rows = Array.isArray(definition.rows) ? definition.rows : [];
  const firstDataRow = headerRow + 1;

  if (rows.length === 0) {
    worksheet.mergeCells(firstDataRow, 1, firstDataRow, lastColumn);
    const empty = worksheet.getCell(firstDataRow, 1);
    empty.value = definition.emptyMessage || 'Sin registros para el periodo seleccionado.';
    empty.font = { name: FONT_FAMILY, size: 10, italic: true, color: { argb: PALETTE.muted } };
    empty.alignment = { horizontal: 'center', vertical: 'middle' };
    fillRange(worksheet, firstDataRow, 1, firstDataRow, lastColumn, PALETTE.violetSofter);
    worksheet.getRow(firstDataRow).height = 26;
    worksheet.autoFilter = undefined;
    return worksheet;
  }

  rows.forEach((row, rowIndex) => {
    const excelRow = firstDataRow + rowIndex;
    const zebra = rowIndex % 2 === 1;
    worksheet.getRow(excelRow).height = SHEET_LAYOUT.dataRowHeight;
    columns.forEach((column, columnIndex) => {
      const cell = worksheet.getCell(excelRow, columnIndex + 1);
      const normalized = normalizeCell(row[columnIndex], column.kind);
      cell.value = normalized as CellValue;
      const numFmt = numFmtFor(column.kind);
      if (numFmt) cell.numFmt = numFmt;
      cell.font = { name: FONT_FAMILY, size: 9, color: { argb: PALETTE.ink } };
      cell.alignment = {
        ...alignmentFor(column.kind),
        wrapText: Boolean(column.wrap),
      };
      cell.border = {
        bottom: { style: 'hair', color: { argb: PALETTE.line } },
        left: { style: 'hair', color: { argb: PALETTE.line } },
        right: { style: 'hair', color: { argb: PALETTE.line } },
      };
      if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.zebra } };
    });
  });

  const lastDataRow = firstDataRow + rows.length - 1;
  worksheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: lastDataRow, column: lastColumn },
  };

  const totalColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(entry => entry.column.total && ['currency', 'integer'].includes(entry.column.kind));
  if (totalColumns.length > 0) {
    const totalRow = lastDataRow + 1;
    worksheet.getRow(totalRow).height = 22;
    columns.forEach((_, columnIndex) => {
      const cell = worksheet.getCell(totalRow, columnIndex + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.violetSoft } };
      cell.font = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: PALETTE.violetDark } };
      cell.border = { top: { style: 'double', color: { argb: PALETTE.violet } } };
    });
    worksheet.getCell(totalRow, 1).value = definition.totalsLabel || 'TOTALES';
    worksheet.getCell(totalRow, 1).alignment = { horizontal: 'left', vertical: 'middle' };
    totalColumns.forEach(({ column, index }) => {
      const cell = worksheet.getCell(totalRow, index + 1);
      cell.value = rows.reduce((sum, row) => sum + toFiniteNumber(row[index], 0), 0);
      cell.numFmt = column.kind === 'currency' ? NUM_FMT.currency : NUM_FMT.integer;
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });
  }

  const printLastRow = totalColumns.length > 0 ? lastDataRow + 1 : lastDataRow;
  worksheet.pageSetup.printArea = `A1:${worksheet.getColumn(lastColumn).letter}${printLastRow}`;

  return worksheet;
}

export async function writeWorkbookBuffer(workbook: Workbook): Promise<Uint8Array> {
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

export function downloadWorkbookBuffer(buffer: Uint8Array, fileName: string): void {
  // En el APK el contenido viaja por el puente nativo (el DownloadListener no
  // puede leer blob:); en navegador, PWA y escritorio queda el enlace blob:.
  downloadGeneratedFile(buffer, fileName, XLSX_MIME);
}

/** Utilidad para pruebas/servidor: no depende de document. */
export function chartSvg(spec: ChartSpec): string | null {
  return renderChartSvg(spec);
}
