import { getLocalDateYMD, normalizeBusinessDateYMD } from '../../../utils/dateUtils';

export type ReportDateFilter = 'all' | 'today' | 'yesterday' | 'custom';

/** Cualquier registro vendible: la fecha de negocio manda, `date` es auditoría. */
export type BusinessDated = { businessDate?: string; date?: string | null };

function toReportDateYMD(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? getLocalDateYMD(value.toISOString()) : '';
  }
  // Date-input values are calendar dates, not UTC instants; preserve them
  // literally so they do not shift to the previous day in negative offsets.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return getLocalDateYMD(value);
}

/**
 * Día con el que se agrupa y filtra una venta en Reportes.
 *
 * La fecha de negocio elegida por el cajero (`businessDate`, `YYYY-MM-DD`) es
 * la única fuente de verdad y se usa tal cual, sin pasar por `Date`, de modo
 * que un `2026-11-25` se reporta el 25 en cualquier zona horaria. Las ventas
 * antiguas sin fecha explícita siguen agrupándose por su instante de creación.
 */
export function saleBusinessDateYMD(sale: BusinessDated | null | undefined): string {
  const explicit = normalizeBusinessDateYMD(sale?.businessDate);
  if (explicit) return explicit;
  return toReportDateYMD(sale?.date);
}

/**
 * Applies the shared Reports date semantics to a timestamp or date value.
 * An explicitly selected date takes precedence over the quick filters.
 * Calendar-day comparisons use the same local-date helper as session reports.
 */
export function matchesReportDateFilter(
  value: string | Date | null | undefined,
  selectedFilterDate: string,
  sessionFilter: ReportDateFilter,
  now: Date = new Date(),
): boolean {
  const reportDate = toReportDateYMD(value);

  if (selectedFilterDate) return reportDate === selectedFilterDate;

  if (sessionFilter === 'today') {
    return reportDate !== '' && reportDate === toReportDateYMD(now);
  }

  if (sessionFilter === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return reportDate !== '' && reportDate === toReportDateYMD(yesterday);
  }

  return true;
}

/** Igual que `matchesReportDateFilter`, pero resolviendo primero la fecha de negocio. */
export function matchesReportSaleDateFilter(
  sale: BusinessDated | null | undefined,
  selectedFilterDate: string,
  sessionFilter: ReportDateFilter,
  now: Date = new Date(),
): boolean {
  return matchesReportDateFilter(saleBusinessDateYMD(sale), selectedFilterDate, sessionFilter, now);
}
