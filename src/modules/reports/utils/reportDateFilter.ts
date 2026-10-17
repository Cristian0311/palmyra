import { getLocalDateYMD } from '../../../utils/dateUtils';

export type ReportDateFilter = 'all' | 'today' | 'yesterday' | 'custom';

function toReportDateYMD(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? getLocalDateYMD(value.toISOString()) : '';
  }
  // Date-input values are calendar dates, not UTC instants; preserve them
  // literally so they do not shift to the previous day in negative offsets.
  if (typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return value;
  return getLocalDateYMD(value);
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
