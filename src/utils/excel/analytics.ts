/**
 * Agregaciones compartidas por portadas, KPIs y gráficas.
 *
 * Todas las funciones son puras, tolerantes a datos vacíos o corruptos y
 * trabajan sobre las filas ya calculadas de una hoja (encabezado en la fila 0),
 * de modo que la gráfica siempre coincide con la tabla exportada.
 */

import type { ChartKind, ChartSpec, ChartValueFormat } from './chartRenderer';

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export type ExportCell = string | number | Date | null | undefined;
export type ExportRows = ExportCell[][];

export interface AggregatedEntry {
  label: string;
  value: number;
}

export interface BarChartOptions {
  title: string;
  subtitle?: string;
  labelIndex: number;
  valueIndex: number;
  kind?: ChartKind;
  format?: ChartValueFormat;
  top?: number;
  includeOther?: boolean;
  /** Texto usado cuando una fila no tiene etiqueta. */
  emptyLabel?: string;
  sort?: 'desc' | 'asc';
}

export function dataRows(rows: ExportRows | null | undefined): ExportRows {
  if (!Array.isArray(rows) || rows.length <= 1) return [];
  return rows.slice(1).filter(row => Array.isArray(row) && !isMessageRow(row));
}

function isMessageRow(row: ExportCell[]): boolean {
  // Las hojas vacías escriben un único texto en la primera columna.
  return row.length <= 1 || row.slice(1).every(cell => cell === null || cell === undefined || cell === '');
}

export function cellNumber(cell: ExportCell): number {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : 0;
  if (typeof cell === 'string') {
    const parsed = Number(cell.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function sumColumn(rows: ExportRows, index: number): number {
  return dataRows(rows).reduce((sum, row) => sum + cellNumber(row[index]), 0);
}

export function countRows(rows: ExportRows): number {
  return dataRows(rows).length;
}

function cellLabel(cell: ExportCell, emptyLabel: string): string {
  if (cell instanceof Date) {
    return `${String(cell.getDate()).padStart(2, '0')}/${String(cell.getMonth() + 1).padStart(2, '0')}/${cell.getFullYear()}`;
  }
  const text = String(cell ?? '').trim();
  return text.length ? text : emptyLabel;
}

export function aggregateByLabel(
  rows: ExportRows,
  labelIndex: number,
  valueIndex: number,
  options: { top?: number; includeOther?: boolean; emptyLabel?: string; sort?: 'desc' | 'asc' } = {},
): AggregatedEntry[] {
  const { top = 8, includeOther = false, emptyLabel = 'Sin categoría', sort = 'desc' } = options;
  const map = new Map<string, number>();
  for (const row of dataRows(rows)) {
    const label = cellLabel(row[labelIndex], emptyLabel);
    const value = cellNumber(row[valueIndex]);
    map.set(label, (map.get(label) || 0) + value);
  }
  const entries = [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter(entry => Number.isFinite(entry.value))
    .sort((a, b) => (sort === 'desc' ? b.value - a.value : a.value - b.value));

  if (entries.length <= top) return entries;
  const head = entries.slice(0, includeOther ? top - 1 : top);
  if (!includeOther) return head;
  const rest = entries.slice(top - 1).reduce((sum, entry) => sum + entry.value, 0);
  return [...head, { label: 'Otros', value: rest }];
}

export function countByLabel(rows: ExportRows, labelIndex: number, emptyLabel = 'Sin estado'): AggregatedEntry[] {
  const map = new Map<string, number>();
  for (const row of dataRows(rows)) {
    const label = cellLabel(row[labelIndex], emptyLabel);
    map.set(label, (map.get(label) || 0) + 1);
  }
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export function buildCategoryChart(rows: ExportRows, options: BarChartOptions): ChartSpec | null {
  const entries = aggregateByLabel(rows, options.labelIndex, options.valueIndex, {
    top: options.top ?? 8,
    includeOther: options.includeOther ?? true,
    emptyLabel: options.emptyLabel,
    sort: options.sort,
  }).filter(entry => Number.isFinite(entry.value));
  if (entries.length === 0) return null;
  return {
    kind: options.kind ?? 'bar',
    title: options.title,
    subtitle: options.subtitle,
    labels: entries.map(entry => entry.label),
    series: [{ name: options.title, values: entries.map(entry => entry.value) }],
    valueFormat: options.format ?? 'currency',
  };
}

export function buildStatusDonut(rows: ExportRows, labelIndex: number, options: {
  title: string;
  subtitle?: string;
  emptyLabel?: string;
  format?: ChartValueFormat;
}): ChartSpec | null {
  const entries = countByLabel(rows, labelIndex, options.emptyLabel).slice(0, 8);
  if (entries.length === 0) return null;
  return {
    kind: 'donut',
    title: options.title,
    subtitle: options.subtitle,
    labels: entries.map(entry => entry.label),
    series: [{ name: options.title, values: entries.map(entry => entry.value) }],
    valueFormat: options.format ?? 'integer',
    centerLabel: 'REGISTROS',
  };
}

function parseCellDate(cell: ExportCell): Date | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell;
  if (typeof cell === 'string' && cell.trim()) {
    const parsed = new Date(cell);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export interface TrendPoint {
  key: string;
  label: string;
  date: Date;
}

export interface TrendSeriesInput {
  name: string;
  columnIndex: number;
  color?: string;
}

/**
 * Serie temporal continua para la portada. Si el rango supera ~62 días se
 * agrupa por mes para que la imagen siga siendo legible.
 */
export function buildTrendSeries(
  rows: ExportRows,
  dateIndex: number,
  series: TrendSeriesInput[],
): { points: TrendPoint[]; series: { name: string; values: number[]; color?: string }[]; monthly: boolean } {
  const parsed: { date: Date; values: number[] }[] = [];
  for (const row of dataRows(rows)) {
    const date = parseCellDate(row[dateIndex]);
    if (!date) continue;
    parsed.push({
      date,
      values: series.map(definition => cellNumber(row[definition.columnIndex])),
    });
  }
  if (parsed.length === 0) return { points: [], series: [], monthly: false };

  parsed.sort((a, b) => a.date.getTime() - b.date.getTime());
  const first = parsed[0].date;
  const last = parsed[parsed.length - 1].date;
  const daySpan = Math.max(1, Math.round((last.getTime() - first.getTime()) / 86_400_000));
  const monthly = daySpan > 62;

  const buckets = new Map<string, { point: TrendPoint; values: number[] }>();
  if (monthly) {
    for (const entry of parsed) {
      const key = `${entry.date.getFullYear()}-${String(entry.date.getMonth() + 1).padStart(2, '0')}`;
      const point = buckets.get(key)?.point || {
        key,
        label: `${MONTHS_ES[entry.date.getMonth()]} ${String(entry.date.getFullYear()).slice(2)}`,
        date: new Date(entry.date.getFullYear(), entry.date.getMonth(), 1),
      };
      const current = buckets.get(key)?.values || series.map(() => 0);
      buckets.set(key, {
        point,
        values: current.map((value, index) => value + entry.values[index]),
      });
    }
    // Rellena meses intermedios sin ventas para que la línea no mienta.
    const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
    const end = new Date(last.getFullYear(), last.getMonth(), 1);
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          point: { key, label: `${MONTHS_ES[cursor.getMonth()]} ${String(cursor.getFullYear()).slice(2)}`, date: new Date(cursor) },
          values: series.map(() => 0),
        });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    for (const entry of parsed) {
      const key = `${entry.date.getFullYear()}-${String(entry.date.getMonth() + 1).padStart(2, '0')}-${String(entry.date.getDate()).padStart(2, '0')}`;
      const point = buckets.get(key)?.point || {
        key,
        label: `${String(entry.date.getDate()).padStart(2, '0')}/${String(entry.date.getMonth() + 1).padStart(2, '0')}`,
        date: new Date(entry.date.getFullYear(), entry.date.getMonth(), entry.date.getDate()),
      };
      const current = buckets.get(key)?.values || series.map(() => 0);
      buckets.set(key, {
        point,
        values: current.map((value, index) => value + entry.values[index]),
      });
    }
    const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate());
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          point: {
            key,
            label: `${String(cursor.getDate()).padStart(2, '0')}/${String(cursor.getMonth() + 1).padStart(2, '0')}`,
            date: new Date(cursor),
          },
          values: series.map(() => 0),
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const points = [...buckets.values()].sort((a, b) => a.point.date.getTime() - b.point.date.getTime());
  return {
    points: points.map(entry => entry.point),
    series: series.map((definition, index) => ({
      name: definition.name,
      values: points.map(entry => entry.values[index]),
      color: definition.color,
    })),
    monthly,
  };
}

export function buildTrendChart(
  rows: ExportRows,
  dateIndex: number,
  series: TrendSeriesInput[],
  options: { title: string; subtitle?: string; format?: ChartValueFormat },
): ChartSpec | null {
  const trend = buildTrendSeries(rows, dateIndex, series);
  if (trend.points.length === 0) return null;
  const labels = trend.points.map(point => point.label);
  const step = Math.max(1, Math.ceil(labels.length / 14));
  return {
    kind: 'line',
    title: options.title,
    subtitle: options.subtitle,
    labels: labels.filter((_, index) => index % step === 0 || index === labels.length - 1),
    series: trend.series.map(definition => ({
      ...definition,
      values: definition.values.filter((_, index) => index % step === 0 || index === labels.length - 1),
    })),
    valueFormat: options.format ?? 'currency',
  };
}

export function sumRows(rows: ExportRows): number {
  return dataRows(rows).length;
}

/** KPIs genéricos a partir de filas y columnas conocidas. */
export interface KpiDefinition {
  label: string;
  value: number;
  format: 'currency' | 'integer' | 'percent';
  hint?: string;
  tone?: 'violet' | 'success' | 'warning' | 'danger' | 'info';
}
