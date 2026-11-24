/**
 * Motor de subida a la nube por cursores.
 *
 * Reglas que este módulo garantiza:
 *  - El cursor persistido solo avanza hasta lo que el servidor confirmó
 *    (`acceptedThrough`) y nunca retrocede, aunque el servidor acuse menos.
 *  - Una sola ventana (`driver.changes(cursor, batchSize)`) por llamada: no
 *    hay bucles infinitos ni historial completo en cada arranque.
 *  - Presupuesto de solicitudes: intervalo mínimo y cupo diario, ambos con
 *    reloj inyectable para que las pruebas y el escritorio usen el mismo reloj.
 *  - Sin conexión no se toca la red ni se consume presupuesto.
 *  - Un fallo se reporta como `failed` con backoff exponencial en memoria;
 *    `syncOnce` nunca lanza.
 */
import type { ChangeRecord, LocalDbDriver, LocalRow, LocalTable } from "../localDb/contract";
import { recordRequest } from "../requestBudget";
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_REQUESTS_PER_DAY,
  DEFAULT_MIN_INTERVAL_MS,
  MAX_BACKOFF_MS,
  type BudgetSnapshot,
  type BudgetStore,
  type CloudChange,
  type CloudChangeBatch,
  type CloudPushResult,
  type CloudTransport,
  type CursorStore
} from "./contract";

/** Tablas del dispositivo/hub que nunca se publican en la nube. */
export const CLOUD_EXCLUDED_TABLES: readonly LocalTable[] = ["hub_devices", "hub_receipts", "outbox"];

const excludedTables = new Set<string>(CLOUD_EXCLUDED_TABLES);

export type SyncStatus = "synced" | "idle" | "throttled" | "offline" | "failed";

export interface SyncOutcome {
  status: SyncStatus;
  /** Cambios enviados en este lote (0 si no hubo solicitud). */
  pushed: number;
  /** Cursor local después de la llamada; nunca menor que el inicial. */
  cursor: number;
  /** Momento (ms) a partir del cual conviene reintentar. */
  nextRetryAt?: number;
  error?: string;
}

export interface CloudSyncOptions {
  driver: LocalDbDriver;
  transport: CloudTransport;
  cursors: CursorStore;
  /** Si falta, el presupuesto vive en memoria (útil para pruebas). */
  budget?: BudgetStore;
  now?: () => number;
  batchSize?: number;
  minIntervalMs?: number;
  maxRequestsPerDay?: number;
  isOnline?: () => boolean;
  /**
   * Empresa dueña de estos datos. Si no se indica se resuelve con la tabla
   * `companies` del almacén local (el alcance local es por empresa).
   */
  companyId?: string;
  /**
   * Medición de solicitudes (por defecto `recordRequest` de
   * `services/requestBudget`). Se inyecta para pruebas y se llama una vez por
   * subida, con latencia y éxito.
   */
  report?: RequestReporter;
}

/** Registro de una solicitud a la nube: ruta, latencia y resultado. */
export type RequestReporter = (route: string, outcome: { ms?: number; ok?: boolean }) => void;

export interface CloudSync {
  syncOnce(): Promise<SyncOutcome>;
}

/**
 * Backoff exponencial con tope. `attempts` es el número de fallos consecutivos
 * (1 = primer fallo). Es puro: mismas entradas, mismo resultado.
 */
export function computeBackoff(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts <= 0) return 0;
  // Limitar el exponente evita Infinity y desbordes con muchos fallos.
  const exponent = Math.min(30, Math.floor(attempts) - 1);
  return Math.min(MAX_BACKOFF_MS, DEFAULT_BACKOFF_MS * 2 ** exponent);
}

/** Clave de presupuesto diario en UTC: `YYYY-MM-DD`. */
export function dayKeyFor(ms: number): string {
  const time = Number.isFinite(ms) ? ms : 0;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Cursor que se debe persistir tras un acuse.
 *
 * - Si el servidor acusa menos de lo ya guardado, no se retrocede.
 * - Nunca avanza más allá del último `seq` del lote enviado.
 */
export function planNextCursor(current: number, acceptedThrough: number, lastSeq: number): number {
  const base = normalizeCursor(current);
  const ack = Number.isFinite(acceptedThrough) ? Math.floor(acceptedThrough) : base;
  const top = Math.max(base, Number.isFinite(lastSeq) ? Math.floor(lastSeq) : base);
  return Math.max(base, Math.min(ack, top));
}

/**
 * Convierte registros del journal en cambios enviables.
 *
 * Los upserts se resuelven con la fila vigente (`driver.get`): si la fila ya no
 * existe se omiten, y si tiene `deleted_at` viajan como `delete` para que la
 * nube borre también el documento.
 */
export async function loadRows(driver: LocalDbDriver, records: ChangeRecord[]): Promise<CloudChange[]> {
  const changes: CloudChange[] = [];
  for (const record of records) {
    if (excludedTables.has(record.table)) continue;
    if (record.op === "delete") {
      changes.push({
        seq: record.seq,
        table: record.table,
        rowId: record.row_id,
        op: "delete",
        deletedAt: record.updated_at
      });
      continue;
    }
    const row = await driver.get<LocalRow>(record.table, record.row_id);
    if (!row) continue;
    if (row.deleted_at) {
      changes.push({
        seq: record.seq,
        table: record.table,
        rowId: row.id,
        op: "delete",
        deletedAt: row.deleted_at
      });
      continue;
    }
    changes.push({ seq: record.seq, table: record.table, rowId: row.id, op: "upsert", row });
  }
  return changes;
}

export function createCloudSync(options: CloudSyncOptions): CloudSync {
  const driver = options.driver;
  const transport = options.transport;
  const cursors = options.cursors;
  const budget = options.budget ?? createMemoryBudgetStore();
  const clock = options.now ?? (() => Date.now());
  const batchSize = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
  const minIntervalMs = nonNegativeInt(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const maxRequestsPerDay = Math.max(1, positiveInt(options.maxRequestsPerDay, DEFAULT_MAX_REQUESTS_PER_DAY));
  const isOnline = options.isOnline ?? defaultIsOnline;
  const report: RequestReporter = options.report ?? recordRequest;

  let attempts = 0;
  let retryAt = 0;
  let lastError: string | undefined;
  let resolvedCompanyId = options.companyId ? options.companyId.trim() : "";

  function time(): number {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  async function resolveCompanyId(): Promise<string> {
    if (resolvedCompanyId) return resolvedCompanyId;
    // El alcance local es por empresa: la primera fila de `companies` lo define.
    const companies = await driver.query<LocalRow>({
      table: "companies",
      orderBy: { field: "id", direction: "asc" },
      limit: 1
    });
    const found = companies[0]?.id;
    if (found) {
      resolvedCompanyId = found;
      return found;
    }
    const first = (await driver.changes(0, 1))[0];
    if (first?.company_id) {
      resolvedCompanyId = first.company_id;
      return resolvedCompanyId;
    }
    return "";
  }

  async function syncOnce(): Promise<SyncOutcome> {
    let cursor = 0;
    let nowMs = time();
    try {
      const companyId = await resolveCompanyId();
      cursor = normalizeCursor(await cursors.load(companyId));

      // Una sola ventana por llamada: el siguiente lote espera al próximo ciclo.
      const window = await driver.changes(cursor, batchSize);
      if (window.length === 0) return { status: "idle", pushed: 0, cursor };

      // Sin conexión no se toca la red ni el presupuesto.
      if (!isOnline()) return { status: "offline", pushed: 0, cursor };

      if (retryAt > nowMs) {
        return { status: "failed", pushed: 0, cursor, nextRetryAt: retryAt, error: lastError };
      }

      nowMs = time();
      const dayKey = dayKeyFor(nowMs);
      const spent = normalizeBudget(await budget.load(dayKey));
      const nextDayAt = startOfNextUtcDay(nowMs);
      if (spent.requests >= maxRequestsPerDay) {
        return { status: "throttled", pushed: 0, cursor, nextRetryAt: nextDayAt };
      }
      const intervalEnd = spent.lastRequestAt + minIntervalMs;
      if (spent.lastRequestAt > 0 && nowMs < intervalEnd) {
        return { status: "throttled", pushed: 0, cursor, nextRetryAt: intervalEnd };
      }

      const windowEnd = window[window.length - 1].seq;
      const changes = await loadRows(driver, window);
      if (changes.length === 0) {
        // Solo cambios internos (hub/outbox): avanzar el cursor no cuesta solicitud.
        const local = planNextCursor(cursor, windowEnd, windowEnd);
        await cursors.save(companyId, local);
        return { status: "synced", pushed: 0, cursor: local };
      }

      const batch: CloudChangeBatch = { companyId, cursor: windowEnd, changes };
      let acceptedThrough: number;
      const startedAt = nowMs;
      try {
        const result: CloudPushResult = await transport.push(batch);
        acceptedThrough = normalizeAck(result?.acceptedThrough, cursor);
        measure(report, time() - startedAt, true);
      } catch (error) {
        // Rechazo del transporte: cuenta para el backoff y conserva el cursor.
        measure(report, time() - startedAt, false);
        attempts += 1;
        retryAt = nowMs + computeBackoff(attempts);
        lastError = describeError(error);
        return { status: "failed", pushed: 0, cursor, nextRetryAt: retryAt, error: lastError };
      }

      const next = planNextCursor(cursor, acceptedThrough, windowEnd);
      await cursors.save(companyId, next);
      await budget.save(dayKey, { requests: spent.requests + 1, lastRequestAt: nowMs });

      attempts = 0;
      retryAt = 0;
      lastError = undefined;
      return { status: "synced", pushed: changes.length, cursor: next };
    } catch (error) {
      // Nunca lanzar: la pantalla decide con el resultado, no con excepciones.
      attempts += 1;
      retryAt = nowMs + computeBackoff(attempts);
      lastError = describeError(error);
      return { status: "failed", pushed: 0, cursor, nextRetryAt: retryAt, error: lastError };
    }
  }

  return { syncOnce };
}

function normalizeCursor(value: unknown): number {
  const parsed = Math.floor(toFinite(value, 0));
  return parsed > 0 ? parsed : 0;
}

/** La medición nunca debe romper una subida ya aceptada. */
function measure(report: RequestReporter, ms: number, ok: boolean): void {
  try {
    report("cloud/push", { ms: Math.max(0, Math.round(ms)), ok });
  } catch {
    // Un registrador roto no cambia el resultado de la sincronización.
  }
}

function normalizeAck(value: unknown, fallback: number): number {
  const parsed = toFinite(value, fallback);
  return Math.floor(parsed);
}

function normalizeBudget(value: BudgetSnapshot | null | undefined): BudgetSnapshot {
  const requests = Math.max(0, Math.floor(toFinite(value?.requests, 0)));
  const lastRequestAt = Math.max(0, Math.floor(toFinite(value?.lastRequestAt, 0)));
  return { requests, lastRequestAt };
}

function toFinite(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(toFinite(value, fallback));
  return parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(toFinite(value, fallback));
  return parsed >= 0 ? parsed : fallback;
}

function startOfNextUtcDay(ms: number): number {
  const date = new Date(Number.isFinite(ms) ? ms : 0);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function defaultIsOnline(): boolean {
  const navigatorLike = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return navigatorLike?.onLine !== false;
}

function describeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const clean = message.trim() || "No se pudo sincronizar con la nube.";
  return clean.slice(0, 500);
}

function createMemoryBudgetStore(): BudgetStore {
  const days = new Map<string, BudgetSnapshot>();
  return {
    async load(dayKey: string): Promise<BudgetSnapshot> {
      const stored = days.get(dayKey);
      return stored ? { ...stored } : { requests: 0, lastRequestAt: 0 };
    },
    async save(dayKey: string, value: BudgetSnapshot): Promise<void> {
      days.set(dayKey, { requests: value.requests, lastRequestAt: value.lastRequestAt });
    }
  };
}
