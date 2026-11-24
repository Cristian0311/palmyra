/**
 * Métricas del piloto F7 (3–5 días de negocio real).
 *
 * Todo se calcula con registros que ya viven en el equipo: presupuesto de
 * solicitudes (F6), ledger de sincronización, salud de la cola offline,
 * historial de actualizaciones y contador de tickets de soporte. Este módulo
 * no hace red ni toca la nube: abrir el panel no consume el presupuesto que
 * está midiendo.
 *
 * El "día" es siempre UTC (`YYYY-MM-DD`) para coincidir con `requestBudget`.
 * Ninguna función lanza: un almacén dañado degrada a listas vacías.
 */

import { getOfflineQueueHealth } from "../offlineQueue";
import { readSyncLedger, type SyncLedger } from "../offline/syncLedger";
import {
  classifyRequestBudget,
  readRequestBudget,
  type RequestBudgetLevel,
  type RequestBudgetSnapshot
} from "../requestBudget";

export const PILOT_UPDATE_HISTORY_KEY = "palmyra:update-history:v1";
export const PILOT_SUPPORT_TICKETS_KEY = "palmyra:support-tickets:v1";
export const PILOT_RISK_DAYS_KEY = "palmyra:pilot-risks:v1";
/** Mismo ajuste de equipos que usa el panel de presupuesto (F6). */
const PILOT_DEVICES_KEY = "palmyra:devices-count";

/** Retención de los registros del piloto. */
const PILOT_HISTORY_DAYS = 90;
const PILOT_UPDATE_HISTORY_MAX = 200;
/** Ventana de la tabla compacta del panel. */
const PILOT_TABLE_DAYS = 7;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VERSION_LENGTH = 40;

export type UpdateOutcomeStatus = "success" | "failure";
export type PilotRequestLevel = RequestBudgetLevel;

export interface PilotSyncMetrics {
  lastPushAt: string | null;
  lastPullAt: string | null;
  /** Diferencia entre la última subida y la última bajada (aproximación al ciclo). */
  lastCycleMs: number | null;
}

export interface PilotRequestMetrics {
  total: number;
  limit: number;
  level: PilotRequestLevel;
  errors: number;
  averageLatencyMs: number | null;
}

export interface PilotUpdateMetrics {
  success: number;
  failure: number;
  lastVersion: string | null;
  lastAt: string | null;
}

export interface PilotMetricsDay {
  day: string;
  riskSales: number;
  conflicts: number;
  requests: number;
  requestErrors: number;
  averageLatencyMs: number | null;
  updatesSuccess: number;
  updatesFailure: number;
  tickets: number;
}

export interface PilotMetricsSnapshot {
  day: string;
  generatedAt: string;
  riskSales: number;
  conflicts: number;
  sync: PilotSyncMetrics;
  requests: PilotRequestMetrics;
  updates: PilotUpdateMetrics;
  tickets: number;
  days: PilotMetricsDay[];
}

export interface UpdateHistoryEntry {
  day: string;
  /** Instante en ms desde época. */
  at: number;
  status: UpdateOutcomeStatus;
  version: string;
}

export interface SupportTicketDay {
  day: string;
  count: number;
}

/** Pico observado del día; se conserva para poder revisar el riesgo a posteriori. */
interface PilotRiskDay {
  day: string;
  riskSales: number;
  conflicts: number;
}

export interface PilotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Lecturas ya hechas (pruebas o pantallas que reutilizan el mismo ciclo). */
export interface PilotMetricOverrides {
  storage?: PilotStorage | null;
  requestBudget?: RequestBudgetSnapshot;
  syncLedger?: SyncLedger;
  queue?: { failed: number; conflicts: number };
  updateHistory?: UpdateHistoryEntry[];
  tickets?: SupportTicketDay[];
  devices?: number;
}

export interface PilotMetricsExport {
  filename: string;
  json: string;
}

/* ------------------------------------------------------------------ */
/* Almacén                                                             */
/* ------------------------------------------------------------------ */

function defaultStorage(): PilotStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readRaw(storage: PilotStorage | null | undefined, key: string): string | null {
  const store = storage ?? defaultStorage();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage: PilotStorage | null | undefined, key: string, value: string): void {
  const store = storage ?? defaultStorage();
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    // Cuota o modo privado: se conserva lo ya guardado y no se interrumpe nada.
  }
}

function readJsonArray(storage: PilotStorage | null | undefined, key: string): unknown[] {
  const raw = readRaw(storage, key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades de fecha y número                                        */
/* ------------------------------------------------------------------ */

function isValidDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value);
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

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function horizonDay(referenceMs: number): string {
  return dayKeyOf(referenceMs - (PILOT_HISTORY_DAYS - 1) * DAY_MS);
}

function cleanVersion(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? "desconocida" : text.slice(0, MAX_VERSION_LENGTH);
}

/* ------------------------------------------------------------------ */
/* Historial de actualizaciones                                        */
/* ------------------------------------------------------------------ */

function normalizeUpdateEntry(raw: unknown): UpdateHistoryEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const at = parseMoment(record.at);
  if (at === null) return null;
  if (record.status !== "success" && record.status !== "failure") return null;
  const version = cleanVersion(record.version);
  const day = isValidDay(record.day) ? record.day : dayKeyOf(at);
  return { day, at, status: record.status, version };
}

export function readUpdateHistory(storage?: PilotStorage | null): UpdateHistoryEntry[] {
  const entries: UpdateHistoryEntry[] = [];
  for (const raw of readJsonArray(storage, PILOT_UPDATE_HISTORY_KEY)) {
    const entry = normalizeUpdateEntry(raw);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.at - b.at);
}

/**
 * Anota el resultado de una actualización (una vez por transición).
 * Deduplica día + versión + resultado, conserva 90 días y como máximo 200
 * entradas. Nunca lanza.
 */
export function recordUpdateOutcome(
  input: { status: UpdateOutcomeStatus; version?: string | null; at?: Date | string | number },
  storage?: PilotStorage | null
): void {
  try {
    if (!input || (input.status !== "success" && input.status !== "failure")) return;
    const at = parseMoment(input.at) ?? Date.now();
    const day = dayKeyOf(at);
    const version = cleanVersion(input.version);
    const entries = readUpdateHistory(storage);
    const duplicated = entries.some(
      (entry) => entry.day === day && entry.version === version && entry.status === input.status
    );
    if (duplicated) return;
    entries.push({ day, at, status: input.status, version });
    entries.sort((a, b) => a.at - b.at);
    const newest = entries[entries.length - 1]?.at ?? at;
    const horizon = horizonDay(Math.max(Date.now(), newest));
    const kept = entries
      .filter((entry) => entry.day >= horizon)
      .slice(-PILOT_UPDATE_HISTORY_MAX);
    writeRaw(storage, PILOT_UPDATE_HISTORY_KEY, JSON.stringify(kept));
  } catch {
    // El registro es informativo: jamás interrumpe la UI de actualizaciones.
  }
}

/* ------------------------------------------------------------------ */
/* Tickets de soporte                                                  */
/* ------------------------------------------------------------------ */

function normalizeTicketDay(raw: unknown): SupportTicketDay | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isValidDay(record.day)) return null;
  const count = nonNegativeInt(record.count);
  if (count <= 0) return null;
  return { day: record.day, count };
}

export function readSupportTickets(storage?: PilotStorage | null): SupportTicketDay[] {
  const days: SupportTicketDay[] = [];
  for (const raw of readJsonArray(storage, PILOT_SUPPORT_TICKETS_KEY)) {
    const entry = normalizeTicketDay(raw);
    if (entry) days.push(entry);
  }
  return days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Suma un ticket al día indicado (contador local, sin datos del ticket). */
export function recordSupportTicket(
  at: Date | string | number = new Date(),
  storage?: PilotStorage | null
): void {
  try {
    const atMs = parseMoment(at) ?? Date.now();
    const day = dayKeyOf(atMs);
    const days = readSupportTickets(storage);
    const current = days.find((entry) => entry.day === day);
    if (current) current.count += 1;
    else days.push({ day, count: 1 });
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const horizon = horizonDay(Math.max(Date.now(), atMs));
    const kept = days.filter((entry) => entry.day >= horizon);
    writeRaw(storage, PILOT_SUPPORT_TICKETS_KEY, JSON.stringify(kept));
  } catch {
    // Un contador caído no puede romper el envío de la solicitud.
  }
}

/* ------------------------------------------------------------------ */
/* Pico de riesgo por día                                              */
/* ------------------------------------------------------------------ */

function normalizeRiskDay(raw: unknown): PilotRiskDay | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isValidDay(record.day)) return null;
  return {
    day: record.day,
    riskSales: nonNegativeInt(record.riskSales),
    conflicts: nonNegativeInt(record.conflicts)
  };
}

function readRiskDays(storage?: PilotStorage | null): PilotRiskDay[] {
  const days: PilotRiskDay[] = [];
  for (const raw of readJsonArray(storage, PILOT_RISK_DAYS_KEY)) {
    const entry = normalizeRiskDay(raw);
    if (entry) days.push(entry);
  }
  return days;
}

/** Guarda el peor valor observado del día; el riesgo puede bajar al resolverse. */
function recordRiskObservation(
  day: string,
  riskSales: number,
  conflicts: number,
  referenceMs: number,
  storage?: PilotStorage | null
): void {
  try {
    const days = readRiskDays(storage);
    const current = days.find((entry) => entry.day === day);
    if (current) {
      current.riskSales = Math.max(current.riskSales, riskSales);
      current.conflicts = Math.max(current.conflicts, conflicts);
    } else {
      days.push({ day, riskSales, conflicts });
    }
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const horizon = horizonDay(referenceMs);
    writeRaw(
      storage,
      PILOT_RISK_DAYS_KEY,
      JSON.stringify(days.filter((entry) => entry.day >= horizon))
    );
  } catch {
    // Solo es histórico: si falla, el día de hoy se sigue mostrando en vivo.
  }
}

/* ------------------------------------------------------------------ */
/* Lectura principal                                                   */
/* ------------------------------------------------------------------ */

function readDevices(): number {
  if (typeof localStorage === "undefined") return 1;
  try {
    return localStorage.getItem(PILOT_DEVICES_KEY) === "5" ? 5 : 1;
  } catch {
    return 1;
  }
}

/**
 * Misma regla que F6 (<100/día con 1 equipo, <500/día con 5) sin duplicarla:
 * se delega en `classifyRequestBudget`.
 */
export function classifyPilotRequestBudget(
  total: number,
  devices = 1
): { level: PilotRequestLevel; limit: number } {
  return classifyRequestBudget(total, devices);
}

export function readPilotMetrics(
  now: Date = new Date(),
  overrides: PilotMetricOverrides = {}
): PilotMetricsSnapshot {
  const nowMs = Number.isFinite(now?.getTime?.()) ? now.getTime() : Date.now();
  const day = dayKeyOf(nowMs);
  const storage = overrides.storage ?? defaultStorage();

  const budget = overrides.requestBudget ?? readRequestBudget(now);
  const ledger = overrides.syncLedger ?? readSyncLedger();
  const health = overrides.queue ?? getOfflineQueueHealth();
  const updates = overrides.updateHistory ?? readUpdateHistory(storage);
  const tickets = overrides.tickets ?? readSupportTickets(storage);
  const devices = overrides.devices ?? readDevices();

  const { level, limit } = classifyPilotRequestBudget(budget.total, devices);
  const conflicts = nonNegativeInt(health.conflicts);
  const failed = nonNegativeInt(health.failed);
  // ventas en riesgo = operaciones de venta que hoy están fallidas en la cola + conflictos sin resolver
  const riskSales = failed + conflicts;

  const pushMs = parseMoment(ledger.lastPushAt);
  const pullMs = parseMoment(ledger.lastPullAt);
  const lastCycleMs = pushMs !== null && pullMs !== null ? Math.abs(pushMs - pullMs) : null;

  recordRiskObservation(day, riskSales, conflicts, nowMs, storage);
  const riskDays = readRiskDays(storage);

  const todayUpdates = updates.filter((entry) => entry.day === day);
  const latestUpdate = updates.length > 0 ? updates[updates.length - 1] : null;
  const todayTickets = tickets.find((entry) => entry.day === day)?.count ?? 0;

  const budgetDays = Array.isArray(budget.days) ? budget.days : [];
  const days: PilotMetricsDay[] = [];
  for (let offset = PILOT_TABLE_DAYS - 1; offset >= 0; offset -= 1) {
    const key = dayKeyOf(nowMs - offset * DAY_MS);
    const budgetDay = budgetDays.find((entry) => entry.day === key);
    const riskDay = riskDays.find((entry) => entry.day === key);
    const isToday = key === day;
    const latency = budgetDay ? nonNegativeInt(budgetDay.latencyMs) : 0;
    const samples = budgetDay ? nonNegativeInt(budgetDay.samples) : 0;
    days.push({
      day: key,
      riskSales: isToday ? riskSales : riskDay?.riskSales ?? 0,
      conflicts: isToday ? conflicts : riskDay?.conflicts ?? 0,
      requests: budgetDay ? nonNegativeInt(budgetDay.total) : 0,
      requestErrors: budgetDay ? nonNegativeInt(budgetDay.errors) : 0,
      averageLatencyMs: samples > 0 ? Math.round(latency / samples) : null,
      updatesSuccess: updates.filter((entry) => entry.day === key && entry.status === "success").length,
      updatesFailure: updates.filter((entry) => entry.day === key && entry.status === "failure").length,
      tickets: tickets.find((entry) => entry.day === key)?.count ?? 0
    });
  }

  return {
    day,
    generatedAt: new Date(nowMs).toISOString(),
    riskSales,
    conflicts,
    sync: {
      lastPushAt: typeof ledger.lastPushAt === "string" ? ledger.lastPushAt : null,
      lastPullAt: typeof ledger.lastPullAt === "string" ? ledger.lastPullAt : null,
      lastCycleMs
    },
    requests: {
      total: nonNegativeInt(budget.total),
      limit,
      level,
      errors: nonNegativeInt(budget.errors),
      averageLatencyMs:
        typeof budget.averageLatencyMs === "number" && Number.isFinite(budget.averageLatencyMs)
          ? Math.max(0, Math.round(budget.averageLatencyMs))
          : null
    },
    updates: {
      success: todayUpdates.filter((entry) => entry.status === "success").length,
      failure: todayUpdates.filter((entry) => entry.status === "failure").length,
      lastVersion: latestUpdate ? latestUpdate.version : null,
      lastAt: latestUpdate ? new Date(latestUpdate.at).toISOString() : null
    },
    tickets: todayTickets,
    days
  };
}

/* ------------------------------------------------------------------ */
/* Texto y exportación                                                 */
/* ------------------------------------------------------------------ */

const LEVEL_LABEL: Record<PilotRequestLevel, string> = {
  ok: "dentro del presupuesto",
  warn: "cerca del presupuesto",
  over: "presupuesto excedido"
};

function formatStamp(value: string | null): string {
  const ms = parseMoment(value);
  if (ms === null) return "sin registros";
  try {
    return new Date(ms).toLocaleString("es-CU", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "sin datos";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Informe en texto plano, listo para pegar en el registro del piloto. */
export function formatPilotMetricsText(snapshot: PilotMetricsSnapshot): string {
  try {
    const lines = [
      `Métricas del piloto PALMYRA · ${snapshot.day}`,
      `Generado: ${formatStamp(snapshot.generatedAt)}`,
      `Ventas en riesgo (cola fallida + conflictos): ${snapshot.riskSales}`,
      `Conflictos sin resolver: ${snapshot.conflicts}`,
      `Última subida: ${formatStamp(snapshot.sync.lastPushAt)} · última bajada: ${formatStamp(snapshot.sync.lastPullAt)}`,
      `Duración del último ciclo (aprox.): ${formatDuration(snapshot.sync.lastCycleMs)}`,
      `Solicitudes: ${snapshot.requests.total}/${snapshot.requests.limit} (${LEVEL_LABEL[snapshot.requests.level]}) · errores ${snapshot.requests.errors} · latencia media ${snapshot.requests.averageLatencyMs === null ? "sin datos" : `${snapshot.requests.averageLatencyMs} ms`}`,
      `Actualizaciones: ${snapshot.updates.success} ok / ${snapshot.updates.failure} fallidas · última ${snapshot.updates.lastVersion ?? "sin registros"} (${formatStamp(snapshot.updates.lastAt)})`,
      `Tickets de soporte: ${snapshot.tickets}`,
      "",
      `Últimos ${snapshot.days.length} días:`
    ];
    for (const day of snapshot.days) {
      lines.push(
        `- ${day.day}: riesgo ${day.riskSales} · conflictos ${day.conflicts} · solicitudes ${day.requests} (${day.requestErrors} con error) · actualizaciones ${day.updatesSuccess} ok/${day.updatesFailure} fallos · tickets ${day.tickets}`
      );
    }
    return lines.join("\n");
  } catch {
    return "Métricas del piloto: no se pudieron formatear.";
  }
}

/**
 * Exportación local del snapshot: nombre estable (año-mes-día del snapshot y
 * hora UTC) y JSON ya serializado. El panel solo descarga bytes; no hay red.
 */
export function exportPilotMetrics(snapshot: PilotMetricsSnapshot): PilotMetricsExport {
  const dayPart = (isValidDay(snapshot?.day) ? snapshot.day : dayKeyOf(Date.now())).replace(/-/g, "");
  const generatedMs = parseMoment(snapshot?.generatedAt) ?? Date.now();
  const iso = new Date(generatedMs).toISOString();
  const filename = `metricas-piloto-${dayPart}-${iso.slice(11, 13)}${iso.slice(14, 16)}.json`;
  try {
    const json = JSON.stringify(
      {
        kind: "pilot-metrics",
        schema: 1,
        app: "palmyra",
        generatedAt: snapshot?.generatedAt ?? new Date(generatedMs).toISOString(),
        snapshot
      },
      null,
      2
    );
    return { filename, json };
  } catch {
    return { filename, json: "{}" };
  }
}
