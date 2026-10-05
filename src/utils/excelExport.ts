import * as XLSX from 'xlsx';
import { formatWorksheet } from './excel/worksheet';
import { generateSummarySheet } from './excel/summarySheet';
import { generateSalesSheet } from './excel/salesSheet';
import { generateItemsSoldDetailSheet } from './excel/itemsSheet';
import {
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
import type { AIDiagnosticReport, ExcelExportData } from './excel/types';

export type { AIDiagnosticReport, ExcelExportData } from './excel/types';
export {
  generateSummarySheet,
  generateSalesSheet,
  generateItemsSoldDetailSheet,
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

import * as XLSX from 'xlsx';
import { formatWorksheet } from './excel/worksheet';
import { generateSummarySheet } from './excel/summarySheet';
import { generateSalesSheet } from './excel/salesSheet';
import { generateItemsSoldDetailSheet } from './excel/itemsSheet';
import type { AIDiagnosticReport, ExcelExportData } from './excel/types';

export type { AIDiagnosticReport, ExcelExportData } from './excel/types';
export { generateSummarySheet } from './excel/summarySheet';
export { generateSalesSheet } from './excel/salesSheet';
export { generateItemsSoldDetailSheet } from './excel/itemsSheet';

import { 
  Transaction, CashRegisterSession, Product, Category, 
  Currency, Branch, User, Customer, BankTransaction, BankCard, SalarySettlement,
  InventoryLevel, InventoryTransfer
} from '../types';

// 1. SHEET: RESUMEN FINANCIERO Y EJECUTIVO


// 2. SHEET: REGISTRO DE VENTAS Y TICKETS (Comprobante por fila)


// 3. SHEET: DETALLE DE ARTÍCULOS VENDIDOS (Línea por línea de venta)


export function exportFullReportsToExcel(data: ExcelExportData) {
  const wb = XLSX.utils.book_new();

  // 1. Resumen Ejecutivo
  const summaryAoa = generateSummarySheet(data);
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);
  formatWorksheet(summaryWs, summaryAoa, 5, false);
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Resumen Financiero');

  // 2. Ventas y Comprobantes
  const salesAoa = generateSalesSheet(data);
  const salesWs = XLSX.utils.aoa_to_sheet(salesAoa);
  formatWorksheet(salesWs, salesAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, salesWs, 'Ventas y Facturas');

  // 3. Detalle de Artículos Vendidos (Línea por línea)
  const itemsAoa = generateItemsSoldDetailSheet(data);
  const itemsWs = XLSX.utils.aoa_to_sheet(itemsAoa);
  formatWorksheet(itemsWs, itemsAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, itemsWs, 'Detalle Artículos');

  // 4. Cierres y Arqueos de Caja
  const sessionsAoa = generateSessionsSheet(data);
  const sessionsWs = XLSX.utils.aoa_to_sheet(sessionsAoa);
  formatWorksheet(sessionsWs, sessionsAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, sessionsWs, 'Cierres y Arqueos');

  // 5. Nómina y Liquidaciones
  const payrollAoa = generatePayrollSheet(data);
  const payrollWs = XLSX.utils.aoa_to_sheet(payrollAoa);
  formatWorksheet(payrollWs, payrollAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, payrollWs, 'Nómina Salarios');

  // 6. Catálogo e Inventario
  const productsAoa = generateProductsPerformanceSheet(data);
  const productsWs = XLSX.utils.aoa_to_sheet(productsAoa);
  formatWorksheet(productsWs, productsAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, productsWs, 'Catálogo e Inventario');

  // 7. Cuentas y Bancos (Transferencias)
  const bankAoa = generateBankMovementsSheet(data);
  const bankWs = XLSX.utils.aoa_to_sheet(bankAoa);
  formatWorksheet(bankWs, bankAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, bankWs, 'Cuentas Bancarias');

  // 8. Devoluciones y Garantías
  const retAoa = generateReturnsAndWarrantiesSheet(data);
  const retWs = XLSX.utils.aoa_to_sheet(retAoa);
  formatWorksheet(retWs, retAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, retWs, 'Garantías y Devoluciones');


  // 10. Auditoría de Descuadres y Cierres Forzados
  const discAoa = generateDiscrepanciesSheet(data);
  const discWs = XLSX.utils.aoa_to_sheet(discAoa);
  formatWorksheet(discWs, discAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, discWs, 'Descuadres y Cierres');

  // 11. Movimientos de Caja POS (Egresos e Ingresos)
  const movAoa = generateCashMovementsSheet(data);
  const movWs = XLSX.utils.aoa_to_sheet(movAoa);
  formatWorksheet(movWs, movAoa, 0, true);
  XLSX.utils.book_append_sheet(wb, movWs, 'Movimientos POS');

  // 12. Transferencias de Inventario entre Sucursales
  if (data.transfers && data.transfers.length > 0) {
    const tfAoa = generateTransfersSheet(data);
    const tfWs = XLSX.utils.aoa_to_sheet(tfAoa);
    formatWorksheet(tfWs, tfAoa, 0, true);
    XLSX.utils.book_append_sheet(wb, tfWs, 'Transferencias Stock');
  }

  // 13. Diagnóstico Inteligente IA (si está disponible o generado)
  if (data.aiDiagnostic) {
    const aiAoa = generateAIDiagnosticSheet(data.aiDiagnostic, data.baseCurrency);
    const aiWs = XLSX.utils.aoa_to_sheet(aiAoa);
    formatWorksheet(aiWs, aiAoa, 15, false);
    XLSX.utils.book_append_sheet(wb, aiWs, 'Diagnóstico IA');
  }

  const fileName = `Reporte_General_${data.businessName ? data.businessName.replace(/\s+/g, '_') : 'PALMYRA'}_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

export function exportSingleSectionToExcel(
  section: 'summary' | 'sales' | 'items' | 'sessions' | 'payroll' | 'products' | 'returns' | 'banks' | 'discrepancies' | 'movements' | 'transfers',
  data: ExcelExportData
) {
  const wb = XLSX.utils.book_new();
  let aoa: any[][] = [];
  let sheetName = 'Reporte';
  let isTabular = true;
  let headerRow = 0;

  if (section === 'summary') {
    aoa = generateSummarySheet(data);
    sheetName = 'Resumen Financiero';
    isTabular = false;
    headerRow = 5;
  } else if (section === 'sales') {
    aoa = generateSalesSheet(data);
    sheetName = 'Ventas y Facturas';
  } else if (section === 'items') {
    aoa = generateItemsSoldDetailSheet(data);
    sheetName = 'Detalle de Artículos';
  } else if (section === 'sessions') {
    aoa = generateSessionsSheet(data);
    sheetName = 'Cierres de Caja';
  } else if (section === 'payroll') {
    aoa = generatePayrollSheet(data);
    sheetName = 'Nómina y Salarios';
  } else if (section === 'products') {
    aoa = generateProductsPerformanceSheet(data);
    sheetName = 'Catálogo e Inventario';
  } else if (section === 'returns') {
    aoa = generateReturnsAndWarrantiesSheet(data);
    sheetName = 'Devoluciones y Garantías';
  } else if (section === 'banks') {
    aoa = generateBankMovementsSheet(data);
    sheetName = 'Movimientos Bancarios';
  }  else if (section === 'discrepancies') {
    aoa = generateDiscrepanciesSheet(data);
    sheetName = 'Descuadres y Cierres';
  } else if (section === 'movements') {
    aoa = generateCashMovementsSheet(data);
    sheetName = 'Movimientos POS';
  } else if (section === 'transfers') {
    aoa = generateTransfersSheet(data);
    sheetName = 'Transferencias de Inventario';
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  formatWorksheet(ws, aoa, headerRow, isTabular);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const fileName = `Reporte_${sheetName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
}
