/**
 * Entradas públicas de exportación de Reportes.
 * El libro se construye con ExcelJS bajo demanda (dynamic import desde la UI),
 * por lo que la librería nunca entra al bundle inicial.
 */

import { buildFileName } from './excel/theme';
import { downloadWorkbookBuffer, writeWorkbookBuffer } from './excel/workbook';
import { buildFullReportWorkbook, buildSectionWorkbook, type WorkbookBuildOptions } from './excel/reportWorkbook';
import { SECTION_DEFINITIONS, type SectionKey } from './excel/sectionDefinitions';
import type { AIDiagnosticReport, ExcelExportData } from './excel/types';

export type { AIDiagnosticReport, ExcelExportData } from './excel/types';
export type { SectionKey } from './excel/sectionDefinitions';
export type { InventoryExportRow, InventoryExportOptions } from './excel/inventoryWorkbook';
export { buildInventoryWorkbook, exportInventoryToExcel } from './excel/inventoryWorkbook';
export { buildFullReportWorkbook, buildSectionWorkbook } from './excel/reportWorkbook';
export { buildFileName };

// Compatibilidad: los generadores de filas siguen disponibles y probados.
export { generateSummarySheet } from './excel/summarySheet';
export { generateSalesSheet } from './excel/salesSheet';
export { generateItemsSoldDetailSheet } from './excel/itemsSheet';
export {
  generateSessionsSheet,
  generatePayrollSheet,
  generateProductsPerformanceSheet,
  generateBankMovementsSheet,
  generateReturnsAndWarrantiesSheet,
  generateAIDiagnosticSheet,
  generateDiscrepanciesSheet,
  generateCashMovementsSheet,
  generateTransfersSheet,
} from './excel/sheets';

export async function exportFullReportsToExcel(data: ExcelExportData, options: WorkbookBuildOptions = {}): Promise<void> {
  const workbook = await buildFullReportWorkbook(data, options);
  const buffer = await writeWorkbookBuffer(workbook);
  downloadWorkbookBuffer(buffer, buildFileName('Reporte_Completo', 'xlsx', options.now || new Date()));
}

export async function exportSingleSectionToExcel(section: SectionKey, data: ExcelExportData, options: WorkbookBuildOptions = {}): Promise<void> {
  const workbook = await buildSectionWorkbook(section, data, options);
  const buffer = await writeWorkbookBuffer(workbook);
  const label = SECTION_DEFINITIONS[section]?.fileLabel || 'Reporte';
  downloadWorkbookBuffer(buffer, buildFileName(label, 'xlsx', options.now || new Date()));
}
