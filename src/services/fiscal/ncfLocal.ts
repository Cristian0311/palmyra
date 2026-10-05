import { getPalmyraScopedStorageKey } from '../../services/localScope';

const NCF_RANGE_STORAGE_KEY = 'palmyra-pos-ncf-ranges-v2';

export type LocalNcfRange = {
  rangeId: string;
  fiscalType: string;
  prefix: string;
  next: number;
  end: number;
};

let ncfRangesMemory: Record<string, LocalNcfRange> = {};

export function getNcfDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    const key = getPalmyraScopedStorageKey('palmyra-pos-device-id');
    if (!key) return 'anonymous-device';
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    if (!(ncfRangesMemory as any).__deviceId) (ncfRangesMemory as any).__deviceId = crypto.randomUUID();
    return (ncfRangesMemory as any).__deviceId as string;
  }
}

export function loadNcfRanges(): Record<string, LocalNcfRange> {
  const key = getPalmyraScopedStorageKey(NCF_RANGE_STORAGE_KEY);
  if (!key) {
    ncfRangesMemory = {};
    return ncfRangesMemory;
  }
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') ncfRangesMemory = parsed;
      else ncfRangesMemory = {};
    } else {
      ncfRangesMemory = {};
    }
  } catch {
    ncfRangesMemory = {};
  }
  return ncfRangesMemory;
}

export function saveNcfRanges(ranges: Record<string, LocalNcfRange>): void {
  ncfRangesMemory = ranges;
  const key = getPalmyraScopedStorageKey(NCF_RANGE_STORAGE_KEY);
  try {
    if (key && typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(ranges));
  } catch {}
}

export function invalidateNcfRange(fiscalType: string): void {
  const ranges = { ...loadNcfRanges() };
  delete ranges[fiscalType];
  saveNcfRanges(ranges);
}

export async function withNcfLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : null;
  if (locks?.request) return locks.request('palmyra-ncf-allocation', { mode: 'exclusive' }, fn);
  return fn();
}
