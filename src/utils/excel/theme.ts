/**
 * Identidad visual única de los libros PALMYRA.
 * Todo exportador (Reportes, Inventario, secciones) debe usar estas constantes
 * para que el documento se vea corporativo y consistente.
 */

export const PALETTE = {
  violet: 'FF6535C5',
  violetDark: 'FF32145F',
  violetSoft: 'FFF3EEFF',
  violetSofter: 'FFFAF8FF',
  violetBorder: 'FFD8CCF4',
  zebra: 'FFF8F6FE',
  white: 'FFFFFFFF',
  ink: 'FF1F1B2E',
  muted: 'FF6B7280',
  line: 'FFE5E7EB',
  success: 'FF16A34A',
  successSoft: 'FFE9F9EF',
  warning: 'FFD97706',
  warningSoft: 'FFFFF6E5',
  danger: 'FFDC2626',
  dangerSoft: 'FFFDECEC',
  info: 'FF2563EB',
} as const;

export const CHART_COLORS = ['#6535C5', '#22C55E', '#F59E0B', '#3B82F6', '#EF4444', '#14B8A6', '#A855F7', '#64748B'];

export const FONT_FAMILY = 'Segoe UI';

export const NUM_FMT = {
  currency: '#,##0.00',
  integer: '#,##0',
  percent: '#,##0.0"%"',
  rate: '#,##0.0000',
  date: 'dd/mm/yyyy',
  datetime: 'dd/mm/yyyy hh:mm',
  time: 'hh:mm',
  text: '@',
} as const;

export const SHEET_LAYOUT = {
  /** Fila donde se escriben los encabezados de las tablas de datos (1-based). */
  headerRow: 4,
  /** Primera fila de datos. */
  firstDataRow: 5,
  /** Alto de la banda de título. */
  titleRowHeight: 30,
  headerRowHeight: 34,
  dataRowHeight: 18,
} as const;

export function safeText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

export function toFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toSafeDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function todayStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function reportStamp(now = new Date()): string {
  return `${todayStamp(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** Nombre de archivo estable: PALMYRA_<Seccion>_<fecha>.xlsx (sin espacios ni acentos). */
export function buildFileName(label: string, extension: 'xlsx' | 'csv' = 'xlsx', now = new Date()): string {
  const clean = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `PALMYRA_${clean || 'Reporte'}_${todayStamp(now)}.${extension}`;
}
