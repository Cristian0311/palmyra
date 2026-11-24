/**
 * Presupuesto local de solicitudes a la nube.
 *
 * F6 exige <100 solicitudes/día para un negocio de 1 equipo y <500/día para 5.
 * Este registro es solo contabilidad: nunca bloquea por sí mismo, para que una
 * operación de negocio no se detenga por telemetría. Los llamadores consultan
 * `classifyRequestBudget` antes de programar sondeos.
 */

const STORAGE_KEY = "palmyra:request-budget:v1";
const KEEP_DAYS = 7;
const MAX_ROUTES = 32;

export const DEVICE_DAILY_BUDGET = 100;
export const BUSINESS_DAILY_BUDGET = 500;

export interface RequestBudgetDay {
  day: string;
  total: number;
  errors: number;
  latencyMs: number;
  samples: number;
  lastAt: number | null;
  byRoute: Record<string, number>;
}

export interface RequestBudgetSnapshot {
  day: string;
  total: number;
  errors: number;
  averageLatencyMs: number | null;
  lastAt: number | null;
  byRoute: Record<string, number>;
  days: RequestBudgetDay[];
}

export type RequestBudgetLevel = "ok" | "warn" | "over";

interface BudgetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): BudgetStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function emptyDay(day: string): RequestBudgetDay {
  return { day, total: 0, errors: 0, latencyMs: 0, samples: 0, lastAt: null, byRoute: {} };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeDay(value: unknown, fallbackDay: string): RequestBudgetDay {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const day = typeof raw.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) ? raw.day : fallbackDay;
  const byRoute: Record<string, number> = {};
  if (raw.byRoute && typeof raw.byRoute === "object") {
    for (const [route, count] of Object.entries(raw.byRoute as Record<string, unknown>)) {
      if (isFiniteNumber(count) && count > 0) byRoute[String(route).slice(0, 120)] = Math.trunc(count);
    }
  }
  return {
    day,
    total: isFiniteNumber(raw.total) ? Math.max(0, Math.trunc(raw.total)) : 0,
    errors: isFiniteNumber(raw.errors) ? Math.max(0, Math.trunc(raw.errors)) : 0,
    latencyMs: isFiniteNumber(raw.latencyMs) ? Math.max(0, raw.latencyMs) : 0,
    samples: isFiniteNumber(raw.samples) ? Math.max(0, Math.trunc(raw.samples)) : 0,
    lastAt: isFiniteNumber(raw.lastAt) ? raw.lastAt : null,
    byRoute
  };
}

function loadDays(storage: BudgetStorage | null): RequestBudgetDay[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { days?: unknown };
    if (!Array.isArray(parsed?.days)) return [];
    return parsed.days.map((item) => normalizeDay(item, "")).filter((item) => Boolean(item.day));
  } catch {
    return [];
  }
}

function saveDays(storage: BudgetStorage | null, days: RequestBudgetDay[]): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ days: days.slice(-KEEP_DAYS) }));
  } catch {
    return;
  }
}

export function recordRequest(
  route: string,
  outcome: { ms?: number; ok?: boolean } = {},
  now: Date = new Date(),
  storage: BudgetStorage | null = defaultStorage()
): void {
  const key = dayKey(now);
  const days = loadDays(storage);
  const today = days.find((entry) => entry.day === key) ?? emptyDay(key);
  today.total += 1;
  if (outcome.ok === false) today.errors += 1;
  if (isFiniteNumber(outcome.ms) && outcome.ms >= 0) {
    today.latencyMs += outcome.ms;
    today.samples += 1;
  }
  today.lastAt = now.getTime();
  const routeKey = String(route || "sin-ruta").slice(0, 120);
  today.byRoute[routeKey] = (today.byRoute[routeKey] ?? 0) + 1;
  const routeEntries = Object.entries(today.byRoute)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ROUTES);
  today.byRoute = Object.fromEntries(routeEntries);
  const next = days.filter((entry) => entry.day !== key);
  next.push(today);
  next.sort((a, b) => (a.day < b.day ? -1 : 1));
  const horizon = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  saveDays(storage, next.filter((entry) => entry.day >= horizon));
}

export function readRequestBudget(
  now: Date = new Date(),
  storage: BudgetStorage | null = defaultStorage()
): RequestBudgetSnapshot {
  const key = dayKey(now);
  const days = loadDays(storage).sort((a, b) => (a.day < b.day ? -1 : 1));
  const today = days.find((entry) => entry.day === key) ?? emptyDay(key);
  return {
    day: key,
    total: today.total,
    errors: today.errors,
    averageLatencyMs: today.samples > 0 ? Math.round(today.latencyMs / today.samples) : null,
    lastAt: today.lastAt,
    byRoute: { ...today.byRoute },
    days
  };
}

export function classifyRequestBudget(
  total: number,
  devices = 1
): { level: RequestBudgetLevel; limit: number } {
  const count = Math.max(1, Math.trunc(devices));
  const limit = count === 1 ? DEVICE_DAILY_BUDGET : BUSINESS_DAILY_BUDGET;
  if (total > limit) return { level: "over", limit };
  if (total >= Math.floor(limit * 0.8)) return { level: "warn", limit };
  return { level: "ok", limit };
}

export function formatRequestBudget(snapshot: RequestBudgetSnapshot, devices = 1): string {
  const { level, limit } = classifyRequestBudget(snapshot.total, devices);
  const parts = [`${snapshot.total}/${limit} solicitudes hoy`];
  if (snapshot.errors > 0) parts.push(`${snapshot.errors} con error`);
  if (snapshot.averageLatencyMs !== null) parts.push(`latencia media ${snapshot.averageLatencyMs} ms`);
  if (level === "warn") parts.push("cerca del presupuesto");
  if (level === "over") parts.push("presupuesto excedido");
  return parts.join(" · ");
}

export const REQUEST_BUDGET_STORAGE_KEY = STORAGE_KEY;
