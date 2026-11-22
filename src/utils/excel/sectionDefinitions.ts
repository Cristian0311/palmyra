import type { SheetColumn } from './workbook';
import type { ExportRows } from './analytics';
import {
  cellNumber,
  countRows,
  dataRows,
  buildCategoryChart,
  buildStatusDonut,
  buildTrendChart,
  type KpiDefinition,
} from './analytics';
import type { ChartSpec } from './chartRenderer';
import { CHART_COLORS } from './theme';
import type { ExcelExportData } from './types';

import { generateSummarySheet } from './summarySheet';
import { generateSalesSheet } from './salesSheet';
import { generateItemsSoldDetailSheet } from './itemsSheet';
import { generateSessionsSheet } from './sheets/sessionsSheet';
import { generatePayrollSheet } from './sheets/payrollSheet';
import { generateProductsPerformanceSheet } from './sheets/productsPerformanceSheet';
import { generateBankMovementsSheet } from './sheets/bankMovementsSheet';
import { generateReturnsAndWarrantiesSheet } from './sheets/returnsWarrantiesSheet';
import { generateDiscrepanciesSheet } from './sheets/discrepanciesSheet';
import { generateCashMovementsSheet } from './sheets/cashMovementsSheet';
import { generateTransfersSheet } from './sheets/transfersSheet';

export type SectionKey = 'summary' | 'sales' | 'items' | 'sessions' | 'payroll' | 'products' | 'returns' | 'banks' | 'discrepancies' | 'movements' | 'transfers';

export interface SectionDefinition {
  key: SectionKey;
  label: string;
  fileLabel: string;
  sheetName: string;
  title: string;
  emptyMessage: string;
  columns: SheetColumn[];
  generate: (data: ExcelExportData) => ExportRows;
  buildKpis: (rows: ExportRows, data: ExcelExportData) => KpiDefinition[];
  buildCharts: (rows: ExportRows, data: ExcelExportData) => (ChartSpec | null)[];
}

const currency = (header: string, width = 14, total = true): SheetColumn => ({ header, kind: 'currency', width, total });
const integer = (header: string, width = 10, total = true): SheetColumn => ({ header, kind: 'integer', width, total });
const text = (header: string, width = 18, wrap = false): SheetColumn => ({ header, kind: 'text', width, wrap });
const mono = (header: string, width = 14): SheetColumn => ({ header, kind: 'mono', width });
const percent = (header: string, width = 10): SheetColumn => ({ header, kind: 'percent', width });

function uniqueCount(rows: ExportRows, columnIndex: number): number {
  return new Set(dataRows(rows).map(row => String(row[columnIndex] ?? '').trim()).filter(Boolean)).size;
}

function donut(title: string, labels: string[], values: number[], format: 'currency' | 'integer' = 'currency', centerLabel?: string): ChartSpec | null {
  const entries = labels
    .map((label, index) => ({ label, value: Number(values[index]) || 0 }))
    .filter(entry => entry.value > 0);
  if (entries.length === 0) return null;
  return {
    kind: 'donut',
    title,
    labels: entries.map(entry => entry.label),
    series: [{ name: title, values: entries.map(entry => entry.value) }],
    valueFormat: format,
    centerLabel,
  };
}

function sumBy(rows: ExportRows, columnIndex: number, predicate?: (row: ExportRows[number]) => boolean): number {
  return dataRows(rows).reduce((sum, row) => (predicate && !predicate(row) ? sum : sum + cellNumber(row[columnIndex])), 0);
}

export const SECTION_DEFINITIONS: Record<SectionKey, SectionDefinition> = {
  summary: {
    key: 'summary',
    label: 'Resumen financiero',
    fileLabel: 'Resumen',
    sheetName: 'Resumen por Moneda',
    title: 'Resumen de cobros por moneda',
    emptyMessage: 'No hay movimientos para el periodo seleccionado.',
    columns: [
      mono('Moneda', 10),
      text('Símbolo', 8),
      { header: 'Tasa de Referencia', kind: 'rate', width: 12 },
      currency('Efectivo Recibido', 14, false),
      currency('Transferencias Recibidas', 14, false),
      currency('Total Moneda Original', 16, false),
      currency('Total Equivalente Base'),
    ],
    generate: data => generateSummarySheet(data).slice(16) as ExportRows,
    buildKpis: () => [],
    buildCharts: () => [],
  },
  sales: {
    key: 'sales',
    label: 'Ventas',
    fileLabel: 'Ventas',
    sheetName: 'Ventas y Tickets',
    title: 'Registro de ventas y tickets',
    emptyMessage: 'No hay ventas completadas en el periodo seleccionado.',
    columns: [
      mono('Ticket', 14),
      { header: 'Fecha y Hora', kind: 'datetime', width: 17 },
      text('Sucursal / Almacén', 20),
      mono('Turno / Sesión', 14),
      text('Vendedor / Cajero', 20),
      text('Cliente', 22),
      text('Teléfono Cliente', 14),
      mono('NCF', 14),
      integer('Unidades', 9),
      currency('Subtotal'),
      currency('Impuestos', 12),
      currency('Descuento', 12),
      currency('Total Venta'),
      currency('Cobrado Efectivo'),
      currency('Cobrado Transferencia'),
      currency('Vuelto Entregado', 12),
      text('Detalle de Pagos', 38, true),
      text('Estado', 12),
      text('Notas / Observaciones', 28, true),
    ],
    generate: generateSalesSheet,
    buildKpis: (rows, data) => {
      const tickets = countRows(rows);
      const total = sumBy(rows, 12);
      const units = sumBy(rows, 8);
      const itemsRows = generateItemsSoldDetailSheet(data);
      const itemRows = dataRows(itemsRows);
      const revenue = sumBy(itemsRows, 14);
      const margin = sumBy(itemsRows, 16);
      const missingCost = itemRows.filter(row => String(row[22] || '') === 'Sin costo').length;
      const kpis: KpiDefinition[] = [
        { label: 'Ventas totales', value: total, format: 'currency', hint: `${tickets} tickets completados`, tone: 'violet' },
        { label: 'Tickets emitidos', value: tickets, format: 'integer', hint: 'Solo ventas completadas vigentes', tone: 'info' },
        { label: 'Ticket promedio', value: tickets ? total / tickets : 0, format: 'currency', hint: 'Promedio por comprobante', tone: 'violet' },
        { label: 'Unidades vendidas', value: units, format: 'integer', hint: 'Unidades físicas despachadas', tone: 'success' },
        { label: 'Cobrado en efectivo', value: sumBy(rows, 13), format: 'currency', hint: 'Equivalente en moneda base', tone: 'success' },
        { label: 'Cobrado por transferencia', value: sumBy(rows, 14), format: 'currency', hint: 'Equivalente en moneda base', tone: 'info' },
        { label: 'Vuelto entregado', value: sumBy(rows, 15), format: 'currency', hint: 'Cambio devuelto al cliente', tone: 'warning' },
      ];
      if (itemRows.length > 0 && revenue > 0 && missingCost === 0) {
        kpis.push({ label: 'Margen bruto', value: (margin / revenue) * 100, format: 'percent', hint: 'Ganancia sobre ventas netas', tone: 'success' });
      }
      return kpis;
    },
    buildCharts: rows => [
      buildTrendChart(rows, 1, [{ name: 'Ventas', columnIndex: 12, color: CHART_COLORS[0] }], {
        title: 'Tendencia de ventas',
        subtitle: 'Total facturado por día o mes',
        format: 'currency',
      }),
      donut(
        'Métodos de pago',
        ['Efectivo', 'Transferencia'],
        [sumBy(rows, 13), sumBy(rows, 14)],
        'currency',
        'COBRADO',
      ),
    ],
  },
  items: {
    key: 'items',
    label: 'Artículos vendidos',
    fileLabel: 'Articulos',
    sheetName: 'Detalle de Artículos',
    title: 'Detalle de artículos vendidos',
    emptyMessage: 'No hay líneas de venta en el periodo seleccionado.',
    columns: [
      mono('Ticket', 14),
      { header: 'Fecha', kind: 'date', width: 11 },
      { header: 'Hora', kind: 'text', width: 8 },
      text('Sucursal / Almacén', 18),
      text('Cajero / Vendedor', 18),
      text('Cliente', 20),
      mono('SKU', 13),
      mono('Código de Barras', 14),
      text('Producto', 28),
      text('Categoría', 16),
      text('Variante', 13),
      integer('Cantidad', 9),
      currency('Precio Unitario', 13, false),
      currency('Costo Unitario', 13, false),
      currency('Subtotal Línea'),
      currency('Costo Total'),
      currency('Margen Bruto'),
      percent('% Margen'),
      mono('Número de Serie', 14),
      text('Código de Garantía', 16),
      currency('Total Factura', 14, false),
      currency('Diferencia Factura', 14, false),
      text('Costo Verificado', 12),
    ],
    generate: generateItemsSoldDetailSheet,
    buildKpis: rows => {
      const units = sumBy(rows, 11);
      const revenue = sumBy(rows, 14);
      const cost = sumBy(rows, 15);
      const margin = sumBy(rows, 16);
      const missing = dataRows(rows).filter(row => String(row[22] || '') === 'Sin costo').length;
      return [
        { label: 'Líneas de venta', value: countRows(rows), format: 'integer', hint: 'Productos distintos por ticket', tone: 'info' },
        { label: 'Unidades vendidas', value: units, format: 'integer', hint: 'Total de unidades despachadas', tone: 'violet' },
        { label: 'Ingresos por líneas', value: revenue, format: 'currency', hint: 'Suma de subtotales de línea', tone: 'success' },
        { label: 'Costo de ventas', value: cost, format: 'currency', hint: 'Costo de adquisición de lo vendido', tone: 'warning' },
        { label: 'Margen bruto', value: margin, format: 'currency', hint: missing ? `${missing} líneas sin costo confiable` : 'Ingresos menos costo', tone: 'success' },
        { label: '% Margen bruto', value: revenue > 0 ? (margin / revenue) * 100 : 0, format: 'percent', hint: 'Sobre ingresos por líneas', tone: 'violet' },
        { label: 'Líneas sin costo', value: missing, format: 'integer', hint: 'No se les atribuye utilidad', tone: missing > 0 ? 'danger' : 'success' },
      ];
    },
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Top productos por ingreso',
        subtitle: 'Máximo 8 productos del periodo',
        labelIndex: 8,
        valueIndex: 14,
        top: 8,
        includeOther: false,
      }),
      buildCategoryChart(rows, {
        title: 'Ingresos por categoría',
        subtitle: 'Distribución del periodo',
        labelIndex: 9,
        valueIndex: 14,
        top: 7,
        includeOther: true,
      }),
    ],
  },
  sessions: {
    key: 'sessions',
    label: 'Cajas y arqueos',
    fileLabel: 'Cajas',
    sheetName: 'Cierres de Caja',
    title: 'Cierres y arqueos de caja',
    emptyMessage: 'No hay turnos de caja en el periodo seleccionado.',
    columns: [
      mono('Turno', 14),
      text('Sucursal / Almacén', 20),
      text('Cajero Responsable', 20),
      { header: 'Apertura', kind: 'datetime', width: 17 },
      { header: 'Cierre', kind: 'datetime', width: 17 },
      currency('Fondo Inicial'),
      currency('Ventas del Turno'),
      currency('Efectivo Declarado'),
      currency('Saldo Esperado'),
      currency('Diferencia'),
      text('Estado del Arqueo', 16),
      text('Estado del Turno', 12),
      text('Desglose por Moneda', 32, true),
      text('Movimientos de Caja', 40, true),
    ],
    generate: generateSessionsSheet,
    buildKpis: rows => {
      const difference = sumBy(rows, 9);
      return [
        { label: 'Turnos registrados', value: countRows(rows), format: 'integer', hint: 'Incluye abiertos y cerrados', tone: 'info' },
        { label: 'Ventas en turnos', value: sumBy(rows, 6), format: 'currency', hint: 'Tickets completados por turno', tone: 'violet' },
        { label: 'Efectivo declarado', value: sumBy(rows, 7), format: 'currency', hint: 'Arqueos cerrados', tone: 'success' },
        { label: 'Descuadre neto', value: difference, format: 'currency', hint: 'Declarado menos esperado', tone: difference < 0 ? 'danger' : 'success' },
        { label: 'Turnos con faltante', value: dataRows(rows).filter(row => cellNumber(row[9]) < -0.01).length, format: 'integer', hint: 'Requieren revisión', tone: 'danger' },
        { label: 'Turnos con sobrante', value: dataRows(rows).filter(row => cellNumber(row[9]) > 0.01).length, format: 'integer', hint: 'Diferencia a favor', tone: 'warning' },
      ];
    },
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Ventas por turno',
        subtitle: 'Turnos con mayor facturación',
        labelIndex: 0,
        valueIndex: 6,
        top: 8,
        includeOther: false,
      }),
      buildStatusDonut(rows, 11, { title: 'Estado de los turnos', emptyLabel: 'Sin estado' }),
    ],
  },
  payroll: {
    key: 'payroll',
    label: 'Nómina y salarios',
    fileLabel: 'Nomina',
    sheetName: 'Nómina y Salarios',
    title: 'Nómina y liquidaciones',
    emptyMessage: 'No hay turnos cerrados ni liquidaciones en el periodo seleccionado.',
    columns: [
      mono('Liquidación / Turno', 16),
      { header: 'Fecha', kind: 'date', width: 11 },
      text('Empleado / Vendedor', 22),
      currency('Salario Base'),
      currency('Meta de Ventas'),
      currency('Venta Lograda'),
      percent('% Cumplimiento'),
      currency('Comisiones'),
      currency('Total a Pagar'),
      text('Estado de Pago', 12),
      text('Detalle de Comisiones', 44, true),
    ],
    generate: generatePayrollSheet,
    buildKpis: rows => [
      { label: 'Liquidaciones', value: countRows(rows), format: 'integer', hint: 'Turnos y pagos procesados', tone: 'info' },
      { label: 'Empleados', value: uniqueCount(rows, 2), format: 'integer', hint: 'Personas con pago o turno', tone: 'violet' },
      { label: 'Salarios base', value: sumBy(rows, 3), format: 'currency', hint: 'Parte fija de la nómina', tone: 'warning' },
      { label: 'Comisiones', value: sumBy(rows, 7), format: 'currency', hint: 'Generadas por ventas', tone: 'success' },
      { label: 'Total a pagar', value: sumBy(rows, 8), format: 'currency', hint: 'Obligación total del periodo', tone: 'violet' },
      { label: 'Pagados', value: dataRows(rows).filter(row => String(row[9]) === 'PAGADO').length, format: 'integer', hint: 'Liquidaciones cerradas', tone: 'success' },
      { label: 'Pendientes', value: dataRows(rows).filter(row => String(row[9]) === 'PENDIENTE').length, format: 'integer', hint: 'Por pagar', tone: 'danger' },
    ],
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Pagos por empleado',
        subtitle: 'Total a pagar acumulado',
        labelIndex: 2,
        valueIndex: 8,
        top: 8,
        includeOther: false,
      }),
      buildStatusDonut(rows, 9, { title: 'Estado de los pagos', emptyLabel: 'Sin estado' }),
    ],
  },
  products: {
    key: 'products',
    label: 'Catálogo e inventario',
    fileLabel: 'Catalogo',
    sheetName: 'Catálogo e Inventario',
    title: 'Catálogo y rendimiento de productos',
    emptyMessage: 'No hay productos registrados.',
    columns: [
      mono('SKU', 13),
      mono('Código de Barras', 14),
      text('Producto', 28),
      text('Categoría', 16),
      currency('Precio Venta', 13, false),
      currency('Costo Compra', 13, false),
      currency('Margen Unitario', 13, false),
      percent('% Margen'),
      integer('Stock Físico', 9),
      currency('Valor Stock a Costo'),
      currency('Valor Stock a Venta'),
      currency('Ganancia Potencial'),
      integer('Unidades Vendidas'),
      currency('Ingresos Generados'),
      currency('Beneficio Bruto'),
      text('Garantía', 12),
      text('Estado', 12),
    ],
    generate: generateProductsPerformanceSheet,
    buildKpis: rows => [
      { label: 'Productos en catálogo', value: countRows(rows), format: 'integer', hint: 'Incluye activos y descontinuados', tone: 'info' },
      { label: 'Unidades en stock', value: sumBy(rows, 8), format: 'integer', hint: 'Suma de existencias', tone: 'violet' },
      { label: 'Valor a costo', value: sumBy(rows, 9), format: 'currency', hint: 'Capital invertido en stock', tone: 'warning' },
      { label: 'Valor a venta', value: sumBy(rows, 10), format: 'currency', hint: 'Precio de venta del stock', tone: 'success' },
      { label: 'Margen potencial', value: sumBy(rows, 11), format: 'currency', hint: 'Ganancia si se vende el stock', tone: 'success' },
      { label: 'Productos agotados', value: dataRows(rows).filter(row => cellNumber(row[8]) <= 0).length, format: 'integer', hint: 'Stock en cero', tone: 'danger' },
      { label: 'Ingresos históricos', value: sumBy(rows, 13), format: 'currency', hint: 'Ventas completadas del catálogo', tone: 'violet' },
      { label: 'Unidades vendidas', value: sumBy(rows, 12), format: 'integer', hint: 'Histórico de ventas', tone: 'info' },
    ],
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Top productos por ingreso',
        subtitle: 'Productos con mayor facturación histórica',
        labelIndex: 2,
        valueIndex: 13,
        top: 8,
        includeOther: false,
      }),
      buildCategoryChart(rows, {
        title: 'Valor de stock por categoría',
        subtitle: 'Valorizado a costo',
        labelIndex: 3,
        valueIndex: 9,
        top: 7,
        includeOther: true,
      }),
    ],
  },
  banks: {
    key: 'banks',
    label: 'Cuentas bancarias',
    fileLabel: 'Bancos',
    sheetName: 'Cuentas Bancarias',
    title: 'Movimientos bancarios y cuentas',
    emptyMessage: 'No hay movimientos bancarios en el periodo seleccionado.',
    columns: [
      mono('ID Operación', 14),
      { header: 'Fecha', kind: 'datetime', width: 17 },
      text('Banco', 20),
      text('Titular de la Cuenta', 22),
      mono('Tarjeta / Cuenta', 18),
      mono('Teléfono', 14),
      text('Moneda', 8),
      text('Tipo de Operación', 24),
      currency('Monto Original', 14, false),
      { header: 'Tasa de Cambio', kind: 'rate', width: 10 },
      currency('Equivalente Base'),
      text('Descripción / Referencia', 34, true),
      mono('Venta Asociada', 16),
      text('Entrada / Salida', 12),
    ],
    generate: generateBankMovementsSheet,
    buildKpis: rows => {
      const inflow = sumBy(rows, 10, row => String(row[13]) === 'ENTRADA');
      const outflow = sumBy(rows, 10, row => String(row[13]) === 'SALIDA');
      return [
        { label: 'Operaciones', value: countRows(rows), format: 'integer', hint: 'Movimientos bancarios registrados', tone: 'info' },
        { label: 'Entradas', value: inflow, format: 'currency', hint: 'Cobros y depósitos', tone: 'success' },
        { label: 'Salidas', value: outflow, format: 'currency', hint: 'Pagos y retiros', tone: 'danger' },
        { label: 'Flujo neto', value: inflow - outflow, format: 'currency', hint: 'Entradas menos salidas', tone: inflow - outflow >= 0 ? 'success' : 'danger' },
        { label: 'Bancos distintos', value: uniqueCount(rows, 2), format: 'integer', hint: 'Cuentas con movimiento', tone: 'violet' },
      ];
    },
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Flujo equivalente por banco',
        subtitle: 'Todos los movimientos convertidos a moneda base',
        labelIndex: 2,
        valueIndex: 10,
        top: 8,
        includeOther: true,
      }),
      buildStatusDonut(rows, 13, { title: 'Entradas y salidas', emptyLabel: 'Sin dirección' }),
    ],
  },
  returns: {
    key: 'returns',
    label: 'Devoluciones y garantías',
    fileLabel: 'Devoluciones',
    sheetName: 'Devoluciones y Garantías',
    title: 'Devoluciones y garantías',
    emptyMessage: 'No hay devoluciones ni garantías en el periodo seleccionado.',
    columns: [
      text('Tipo de Registro', 16),
      mono('Código / ID', 14),
      mono('Ticket Venta', 14),
      { header: 'Fecha de Registro', kind: 'datetime', width: 17 },
      text('Sucursal / Almacén', 20),
      text('Autorizado Por', 20),
      text('Cliente', 22),
      text('Producto', 26),
      text('Variante', 13),
      integer('Cantidad', 8),
      text('Moneda', 8),
      currency('Monto Original', 13, false),
      currency('Monto Base'),
      mono('Número de Serie', 14),
      { header: 'Vencimiento Garantía', kind: 'date', width: 13 },
      integer('Días Cobertura', 8, false),
      text('Estado', 12),
      text('Motivo / Diagnóstico', 28, true),
    ],
    generate: generateReturnsAndWarrantiesSheet,
    buildKpis: rows => [
      { label: 'Registros', value: countRows(rows), format: 'integer', hint: 'Devoluciones y garantías', tone: 'info' },
      { label: 'Devoluciones', value: dataRows(rows).filter(row => String(row[0]) === 'DEVOLUCIÓN').length, format: 'integer', hint: 'Productos devueltos', tone: 'warning' },
      { label: 'Garantías emitidas', value: dataRows(rows).filter(row => String(row[0]).startsWith('GARANTÍA')).length, format: 'integer', hint: 'Coberturas registradas', tone: 'violet' },
      { label: 'Reembolsado (base)', value: sumBy(rows, 12), format: 'currency', hint: 'Dinero devuelto al cliente', tone: 'danger' },
      { label: 'Garantías vigentes', value: dataRows(rows).filter(row => String(row[16]) === 'VIGENTE').length, format: 'integer', hint: 'Cobertura activa', tone: 'success' },
      { label: 'Garantías vencidas', value: dataRows(rows).filter(row => String(row[16]) === 'VENCIDA').length, format: 'integer', hint: 'Cobertura expirada', tone: 'danger' },
    ],
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Devoluciones por motivo',
        subtitle: 'Monto reembolsado en moneda base',
        labelIndex: 17,
        valueIndex: 12,
        top: 7,
        includeOther: true,
        format: 'currency',
      }),
      buildStatusDonut(rows, 16, { title: 'Estado de devoluciones y garantías', emptyLabel: 'Sin estado' }),
    ],
  },
  discrepancies: {
    key: 'discrepancies',
    label: 'Descuadres de caja',
    fileLabel: 'Descuadres',
    sheetName: 'Descuadres y Cierres',
    title: 'Descuadres y cierres forzados',
    emptyMessage: 'No se detectaron descuadres en el periodo seleccionado.',
    columns: [
      mono('Turno', 14),
      text('Sucursal / Almacén', 20),
      text('Cajero Responsable', 20),
      { header: 'Fecha de Cierre', kind: 'datetime', width: 17 },
      text('Tipo de Cierre', 14),
      text('Estado Auditoría', 16),
      text('Moneda', 8),
      text('Método de Pago', 12),
      currency('Esperado', 14, false),
      currency('Declarado', 14, false),
      currency('Diferencia', 14, false),
      currency('Diferencia Equivalente Base'),
      text('Tipo Descuadre', 12),
      currency('Deducción Salarial'),
      text('Productos Coincidentes', 32, true),
      text('Diagnóstico / Notas', 36, true),
    ],
    generate: generateDiscrepanciesSheet,
    buildKpis: rows => {
      const shortage = dataRows(rows).reduce((sum, row) => {
        const difference = cellNumber(row[11]);
        return difference < 0 ? sum + Math.abs(difference) : sum;
      }, 0);
      const surplus = dataRows(rows).reduce((sum, row) => {
        const difference = cellNumber(row[11]);
        return difference > 0 ? sum + difference : sum;
      }, 0);
      return [
        { label: 'Turnos con descuadre', value: uniqueCount(rows, 0), format: 'integer', hint: 'Casos detectados', tone: 'warning' },
        { label: 'Faltantes', value: shortage, format: 'currency', hint: 'Dinero no justificado', tone: 'danger' },
        { label: 'Sobrantes', value: surplus, format: 'currency', hint: 'Diferencias a favor', tone: 'success' },
        { label: 'Descuadre neto', value: surplus - shortage, format: 'currency', hint: 'Sobrantes menos faltantes', tone: 'violet' },
        { label: 'Deducciones aplicadas', value: sumBy(rows, 13), format: 'currency', hint: 'Descontado de nómina', tone: 'warning' },
        { label: 'Pendientes de revisión', value: dataRows(rows).filter(row => String(row[5]) === 'Pendiente de Revisión').length, format: 'integer', hint: 'Sin resolver', tone: 'danger' },
      ];
    },
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Diferencia por tipo de descuadre',
        subtitle: 'Faltantes y sobrantes del periodo (moneda base)',
        labelIndex: 12,
        valueIndex: 11,
        top: 6,
        includeOther: false,
        format: 'currency',
      }),
      buildStatusDonut(rows, 5, { title: 'Estado de auditoría', emptyLabel: 'Sin estado' }),
    ],
  },
  movements: {
    key: 'movements',
    label: 'Movimientos de caja',
    fileLabel: 'Movimientos',
    sheetName: 'Movimientos de Caja',
    title: 'Movimientos de caja POS',
    emptyMessage: 'No hay ingresos ni egresos de caja en el periodo seleccionado.',
    columns: [
      mono('ID Movimiento', 14),
      { header: 'Fecha y Hora', kind: 'datetime', width: 17 },
      mono('Turno', 14),
      text('Sucursal / Almacén', 20),
      text('Cajero Responsable', 20),
      text('Tipo de Operación', 18),
      text('Concepto / Descripción', 30, true),
      currency('Importe Original', 14, false),
      text('Moneda', 8),
      currency('Equivalente Base'),
      text('Estado del Turno', 12),
    ],
    generate: generateCashMovementsSheet,
    buildKpis: rows => {
      const income = sumBy(rows, 9, row => String(row[5]).startsWith('INGRESO'));
      const expense = sumBy(rows, 9, row => String(row[5]).startsWith('EGRESO'));
      return [
        { label: 'Movimientos', value: countRows(rows), format: 'integer', hint: 'Ingresos y egresos de caja', tone: 'info' },
        { label: 'Ingresos', value: income, format: 'currency', hint: 'Fondos aportados a caja', tone: 'success' },
        { label: 'Egresos', value: expense, format: 'currency', hint: 'Gastos pagados desde caja', tone: 'danger' },
        { label: 'Flujo neto', value: income - expense, format: 'currency', hint: 'Ingresos menos egresos', tone: income - expense >= 0 ? 'success' : 'danger' },
        { label: 'Turnos afectados', value: uniqueCount(rows, 2), format: 'integer', hint: 'Cajas con movimientos', tone: 'violet' },
      ];
    },
    buildCharts: rows => [
      buildCategoryChart(rows, {
        title: 'Movimientos por concepto',
        subtitle: 'Mayor impacto en moneda base',
        labelIndex: 6,
        valueIndex: 9,
        top: 8,
        includeOther: false,
        format: 'currency',
      }),
      buildStatusDonut(rows, 5, { title: 'Ingresos y egresos', emptyLabel: 'Sin tipo' }),
    ],
  },
  transfers: {
    key: 'transfers',
    label: 'Transferencias de stock',
    fileLabel: 'Transferencias',
    sheetName: 'Transferencias',
    title: 'Transferencias de inventario',
    emptyMessage: 'No hay transferencias de inventario en el periodo seleccionado.',
    columns: [
      mono('ID Transferencia', 14),
      { header: 'Fecha y Hora', kind: 'datetime', width: 17 },
      text('Producto', 26),
      text('Variante', 13),
      integer('Cantidad', 8),
      text('Sucursal Origen', 20),
      text('Sucursal Destino', 20),
      text('Usuario / Responsable', 20),
      text('Estado', 12),
    ],
    generate: generateTransfersSheet,
    buildKpis: rows => [
      { label: 'Transferencias', value: uniqueCount(rows, 0), format: 'integer', hint: 'Operaciones registradas', tone: 'info' },
      { label: 'Unidades trasladadas', value: sumBy(rows, 4), format: 'integer', hint: 'Total de existencias movidas', tone: 'violet' },
      { label: 'Completadas', value: dataRows(rows).filter(row => String(row[8]) === 'Completado').length, format: 'integer', hint: 'Movimientos finalizados', tone: 'success' },
      { label: 'En tránsito', value: dataRows(rows).filter(row => String(row[8]) === 'En tránsito').length, format: 'integer', hint: 'Pendientes de recepción', tone: 'warning' },
      { label: 'Canceladas', value: dataRows(rows).filter(row => String(row[8]) === 'Cancelado').length, format: 'integer', hint: 'Operaciones anuladas', tone: 'danger' },
      { label: 'Productos', value: uniqueCount(rows, 2), format: 'integer', hint: 'Referencias distintas', tone: 'info' },
    ],
    buildCharts: rows => [
      buildStatusDonut(rows, 8, { title: 'Estado de las transferencias', emptyLabel: 'Sin estado' }),
      buildCategoryChart(rows, {
        title: 'Productos más trasladados',
        subtitle: 'Unidades por producto',
        labelIndex: 2,
        valueIndex: 4,
        top: 8,
        includeOther: false,
        format: 'integer',
      }),
    ],
  },
};

// El generador de resumen devuelve un bloque de KPIs + tabla de monedas. Para
// la hoja de datos de la sección "Resumen" solo interesa la tabla final.

export function sectionEntries(data: ExcelExportData): { definition: SectionDefinition; rows: ExportRows }[] {
  return (Object.values(SECTION_DEFINITIONS) as SectionDefinition[])
    .filter(definition => definition.key !== 'summary')
    .map(definition => ({ definition, rows: definition.generate(data) }));
}
