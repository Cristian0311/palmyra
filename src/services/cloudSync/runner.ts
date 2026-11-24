/**
 * Planificador del motor de sincronización.
 *
 * El motor (`syncOnce`) ya decide con su presupuesto si de verdad hay subida;
 * este runner solo lo despierta al arrancar, cada intervalo y al recuperar la
 * conexión. Un solo tick en vuelo evita ráfagas cuando coinciden el intervalo,
 * el evento `online` y una llamada manual.
 *
 * Un tick hace como mucho una subida y una descarga: la descarga corre después
 * de una subida correcta y su propio motor impone la cadencia de 30 minutos.
 * El tráfico programado se salta cuando el presupuesto del día llegó al umbral;
 * `syncNow()` (manual) siempre pasa.
 */
import { readRequestBudget } from "../requestBudget";
import { DEFAULT_MIN_INTERVAL_MS } from "./contract";
import { SCHEDULED_REQUEST_CEILING, type PullOutcome, type PullStatus } from "./pullEngine";
import type { CloudSync, SyncOutcome, SyncStatus } from "./sync";

export interface CloudSyncPullSummary {
  status: PullStatus;
  applied: number;
  conflicts: number;
  cursor: string | null;
  error?: string;
}

export interface CloudSyncRunnerStatus {
  /** Instante (ms) en que se reportó el resultado. */
  at: number;
  status: SyncStatus;
  pushed: number;
  cursor: number;
  error?: string;
  /** Presente solo cuando el tick intentó una descarga. */
  pull?: CloudSyncPullSummary;
}

/** Resultado de un tick manual: subida, descarga y estado reportado. */
export interface CloudSyncTickResult {
  at: number;
  push: SyncOutcome | null;
  pull: PullOutcome | null;
  status: CloudSyncRunnerStatus;
}

export interface RunnerTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RunnerPull {
  pullOnce(options?: { manual?: boolean; full?: boolean }): Promise<PullOutcome>;
}

export interface CloudSyncRunnerOptions {
  /** Basta con `syncOnce`; el runner no conoce driver ni transporte. */
  sync: Pick<CloudSync, "syncOnce">;
  /** Descarga incremental; si falta, el runner solo sube. */
  pull?: RunnerPull | null;
  intervalMs?: number;
  isOnline?: () => boolean;
  now?: () => number;
  onStatus?: (status: CloudSyncRunnerStatus) => void;
  /** Inyectable en pruebas; `null` desactiva el intervalo por completo. */
  timers?: RunnerTimers | null;
  /** Solicitudes consumidas hoy (por defecto el presupuesto compartido). */
  budgetTotal?: () => number;
  /** Umbral que corta el tráfico programado; 90 por defecto. */
  budgetCeiling?: number;
}

export interface CloudSyncRunner {
  start(): Promise<SyncOutcome | null>;
  stop(): void;
  tick(options?: { manual?: boolean }): Promise<SyncOutcome | null>;
  /** Tick manual: ignora el presupuesto y fuerza una descarga si hay motor. */
  syncNow(options?: { full?: boolean }): Promise<CloudSyncTickResult>;
  readonly running: boolean;
  readonly lastStatus: CloudSyncRunnerStatus | null;
}

const STATUSES: readonly SyncStatus[] = ["synced", "idle", "throttled", "offline", "failed"];
const MAX_STATUS_ERROR = 300;

type OnlineWindow = {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

export function createCloudSyncRunner(options: CloudSyncRunnerOptions): CloudSyncRunner {
  const sync = options.sync;
  const pull = options.pull ?? null;
  const intervalMs = positiveInt(options.intervalMs, DEFAULT_MIN_INTERVAL_MS);
  const isOnline = options.isOnline ?? defaultIsOnline;
  const clock = options.now ?? (() => Date.now());
  const onStatus = options.onStatus;
  const timers = resolveTimers(options.timers);
  const budgetTotal = options.budgetTotal ?? (() => readRequestBudget().total);
  const budgetCeiling = positiveInt(options.budgetCeiling, SCHEDULED_REQUEST_CEILING);

  let running = false;
  let timer: unknown = null;
  let inflight: Promise<CloudSyncTickResult> | null = null;
  let onlineWindow: OnlineWindow | null = null;
  let lastStatus: CloudSyncRunnerStatus | null = null;

  const onlineListener = (): void => {
    // Sin `running` el listener ya debería estar desmontado; se comprueba igual.
    if (running) void tick();
  };

  function time(): number {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  function report(entry: CloudSyncRunnerStatus): void {
    lastStatus = entry;
    if (!onStatus) return;
    try {
      onStatus(entry);
    } catch {
      // Un consumidor de estado no debe tumbar el planificador.
    }
  }

  function buildStatus(outcome: unknown, at: number, pullSummary?: CloudSyncPullSummary): CloudSyncRunnerStatus {
    if (!outcome || typeof outcome !== "object") {
      const invalid: CloudSyncRunnerStatus = {
        at,
        status: "failed",
        pushed: 0,
        cursor: 0,
        error: "Respuesta de sincronización inválida."
      };
      if (pullSummary) invalid.pull = pullSummary;
      return invalid;
    }
    const value = outcome as Partial<SyncOutcome>;
    const status = STATUSES.includes(value.status as SyncStatus)
      ? (value.status as SyncStatus)
      : "failed";
    const error = sanitizeError(value.error);
    const entry: CloudSyncRunnerStatus = {
      at,
      status,
      pushed: count(value.pushed),
      cursor: count(value.cursor)
    };
    if (error) entry.error = error;
    if (pullSummary) entry.pull = pullSummary;
    return entry;
  }

  function spent(): number {
    try {
      const value = budgetTotal();
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    } catch {
      return 0;
    }
  }

  function pullSummaryOf(outcome: PullOutcome | null): CloudSyncPullSummary | undefined {
    if (!outcome || typeof outcome !== "object") return undefined;
    const summary: CloudSyncPullSummary = {
      status: outcome.status,
      applied: count(outcome.applied),
      conflicts: count(outcome.conflicts),
      cursor: typeof outcome.cursor === "string" ? outcome.cursor : null
    };
    const error = sanitizeError(outcome.error);
    if (error) summary.error = error;
    return summary;
  }

  /**
   * Una subida y, si corresponde, una descarga. La descarga corre tras una
   * subida sin fallo; su motor decide la cadencia de 30 minutos.
   */
  async function runTick(manual: boolean, full = false): Promise<CloudSyncTickResult> {
    const at = time();
    let online = false;
    try {
      online = isOnline();
    } catch {
      online = false;
    }
    if (!online) {
      const entry: CloudSyncRunnerStatus = { at, status: "offline", pushed: 0, cursor: 0 };
      report(entry);
      return { at, push: null, pull: null, status: entry };
    }

    if (!manual && spent() >= budgetCeiling) {
      // Presupuesto del día agotado: nada programado hasta mañana o manual.
      const entry: CloudSyncRunnerStatus = { at, status: "throttled", pushed: 0, cursor: 0 };
      report(entry);
      return { at, push: null, pull: null, status: entry };
    }

    let outcome: SyncOutcome | null = null;
    try {
      const value = await sync.syncOnce();
      outcome = value && typeof value === "object" ? value : null;
    } catch (error) {
      const entry = buildStatus(null, at);
      entry.error = sanitizeError(describeError(error));
      report(entry);
      return { at, push: null, pull: null, status: entry };
    }

    let pullOutcome: PullOutcome | null = null;
    const pushStatus = outcome?.status;
    // `full` solo lo pide la autocuración del arranque: completa e ignora cursores.
    const canPull = Boolean(pull) && (full || pushStatus === "synced" || pushStatus === "idle" || pushStatus === "throttled");
    if (canPull && pull) {
      try {
        pullOutcome = await pull.pullOnce({ manual, full });
      } catch (error) {
        // La descarga nunca invalida el resultado de la subida.
        pullOutcome = {
          status: "failed",
          applied: 0,
          skipped: 0,
          conflicts: 0,
          cursor: null,
          hasMore: false,
          error: describeError(error)
        };
      }
    }

    const entry = buildStatus(outcome, at, pullSummaryOf(pullOutcome));
    report(entry);
    return { at, push: outcome, pull: pullOutcome, status: entry };
  }

  function tick(options?: { manual?: boolean }): Promise<SyncOutcome | null> {
    return execute(options?.manual === true).then((result) => result.push);
  }

  /**
   * Manual: ignora el presupuesto y el intervalo de subida, y fuerza que la
   * descarga se intente en este tick. Con `full` la descarga es completa (sin
   * cursor incremental), que es lo que usa la autocuración del arranque.
   * Si ya hay un tick en vuelo se reutiliza.
   */
  function syncNow(options?: { full?: boolean }): Promise<CloudSyncTickResult> {
    return execute(true, options?.full === true);
  }

  function execute(manual: boolean, full = false): Promise<CloudSyncTickResult> {
    if (inflight) return inflight;
    const task = runTick(manual, full);
    inflight = task;
    // Se libera en ambos caminos; los llamadores conservan su resultado.
    const release = (): void => {
      if (inflight === task) inflight = null;
    };
    void task.then(release, release);
    return task;
  }

  function schedule(): void {
    if (timer !== null || !timers || intervalMs <= 0) return;
    try {
      timer = timers.setInterval(() => {
        if (running) void tick();
      }, intervalMs);
    } catch {
      timer = null;
    }
  }

  function listenOnline(): void {
    if (onlineWindow) return;
    const candidate = (globalThis as { window?: OnlineWindow }).window;
    if (!candidate || typeof candidate.addEventListener !== "function") return;
    try {
      candidate.addEventListener("online", onlineListener);
      onlineWindow = candidate;
    } catch {
      onlineWindow = null;
    }
  }

  function unlistenOnline(): void {
    if (!onlineWindow) return;
    try {
      onlineWindow.removeEventListener?.("online", onlineListener);
    } catch {
      // Nada que limpiar si el entorno ya retiró la ventana.
    }
    onlineWindow = null;
  }

  async function start(): Promise<SyncOutcome | null> {
    if (running) return null;
    running = true;
    listenOnline();
    schedule();
    return tick();
  }

  function stop(): void {
    running = false;
    if (timer !== null) {
      try {
        timers?.clearInterval(timer);
      } catch {
        // Un timer ya vencido no debe impedir el cierre.
      }
      timer = null;
    }
    unlistenOnline();
  }

  return {
    start,
    stop,
    tick,
    syncNow,
    get running(): boolean {
      return running;
    },
    get lastStatus(): CloudSyncRunnerStatus | null {
      return lastStatus;
    }
  };
}

function resolveTimers(timers: RunnerTimers | null | undefined): RunnerTimers | null {
  if (timers !== undefined) return timers;
  const global = globalThis as {
    setInterval?: (handler: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
  };
  if (typeof global.setInterval !== "function" || typeof global.clearInterval !== "function") {
    return null;
  }
  return {
    setInterval: (handler, ms) => global.setInterval!(handler, ms),
    clearInterval: (handle) => global.clearInterval!(handle)
  };
}

function defaultIsOnline(): boolean {
  const navigatorLike = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return navigatorLike?.onLine !== false;
}

function positiveInt(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(typeof value === "number" ? value : Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function sanitizeError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, MAX_STATUS_ERROR) : undefined;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.trim() || "No se pudo sincronizar con la nube.";
}
