/**
 * Contador local de solicitudes de soporte por día (UTC).
 * Sin red y sin lanzar: un almacén dañado degrada a no contar.
 */

export const SUPPORT_TICKETS_KEY = "palmyra:support-tickets:v1";

/** Retención del contador, en días. */
const HISTORY_DAYS = 90;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SupportTicketDay {
  day: string;
  count: number;
}

export interface TicketCounterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): TicketCounterStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readRaw(storage: TicketCounterStorage | null | undefined, key: string): string | null {
  const store = storage ?? defaultStorage();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage: TicketCounterStorage | null | undefined, key: string, value: string): void {
  const store = storage ?? defaultStorage();
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    // Cuota o modo privado: se conserva lo ya guardado y no se interrumpe nada.
  }
}

function dayKeyOf(ms: number): string {
  const safe = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safe).toISOString().slice(0, 10);
}

function parseMoment(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readDays(storage?: TicketCounterStorage | null): SupportTicketDay[] {
  const raw = readRaw(storage, SUPPORT_TICKETS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const days: SupportTicketDay[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.day !== "string" || !DAY_RE.test(record.day)) continue;
      const count = typeof record.count === "number" && Number.isFinite(record.count)
        ? Math.max(0, Math.trunc(record.count))
        : 0;
      if (count <= 0) continue;
      days.push({ day: record.day, count });
    }
    return days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  } catch {
    return [];
  }
}

export function recordSupportTicket(
  at: Date | string | number = new Date(),
  storage?: TicketCounterStorage | null
): void {
  try {
    const atMs = parseMoment(at) ?? Date.now();
    const day = dayKeyOf(atMs);
    const days = readDays(storage);
    const current = days.find((entry) => entry.day === day);
    if (current) current.count += 1;
    else days.push({ day, count: 1 });
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const horizon = dayKeyOf(Math.max(Date.now(), atMs) - (HISTORY_DAYS - 1) * DAY_MS);
    const kept = days.filter((entry) => entry.day >= horizon);
    writeRaw(storage, SUPPORT_TICKETS_KEY, JSON.stringify(kept));
  } catch {
    // Un contador caído no puede romper el envío de la solicitud.
  }
}
