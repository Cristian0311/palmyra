/**
 * Motor de descarga: trae la ventana remota y la aplica con el LWW de `pull.ts`.
 *
 * Reglas que este módulo garantiza:
 *  - El cursor persistido (`updated_at` del último cambio aplicado) solo avanza
 *    cuando el lote llegó completo, se validó y se aplicó; un error lo deja
 *    intacto para reintentar la misma ventana.
 *  - La cadencia es de 30 minutos como mínimo (`PULL_INTERVAL_MS`), medida con
 *    el `updatedAt` persistido: se respeta incluso después de reiniciar.
 *  - El tráfico programado se salta cuando el presupuesto del día ya llegó al
 *    umbral (90 por defecto). La sincronización manual lo ignora.
 *  - Sin empresa resuelta no se toca la red: una descarga sin empresa no puede
 *    validar el aislamiento multiempresa.
 *  - Toda solicitud se mide con `recordRequest("cloud/pull", {ms, ok})`.
 *  - La aplicación usa `planRemoteChanges`: no hay un segundo merge.
 */
import type { LocalDbDriver, LocalRow } from "../localDb/contract";
import { readRequestBudget, recordRequest } from "../requestBudget";
import type { PullCursorState, PullCursorStore } from "./contract";
import { planRemoteChanges, type RemotePullChange } from "./pull";
import {
  PULL_BATCH,
  PULL_INTERVAL_MS,
  type RemoteChange,
  type RemotePullResult,
  type RemotePullTransport
} from "./pullRemote";

export type PullStatus = "pulled" | "idle" | "throttled" | "offline" | "failed" | "unknown-company";

export interface PullOutcome {
  status: PullStatus;
  /** Filas escritas en el almacén local. */
  applied: number;
  /** Cambios descartados sin conflicto (duplicados, inválidos, ya borrados). */
  skipped: number;
  /** Filas locales que conservaron su versión. */
  conflicts: number;
  cursor: string | null;
  hasMore: boolean;
  /** Momento (ms) a partir del cual conviene reintentar. */
  nextPullAt?: number;
  error?: string;
}

export interface CloudPullOptions {
  driver: LocalDbDriver;
  transport: RemotePullTransport;
  cursors: PullCursorStore;
  /** Empresa dueña del almacén; si falta se resuelve localmente. */
  companyId?: string;
  now?: () => number;
  intervalMs?: number;
  batchSize?: number;
  isOnline?: () => boolean;
  /** Solicitudes consumidas hoy; por defecto `readRequestBudget().total`. */
  budgetTotal?: () => number;
  /** Umbral a partir del cual no se programa tráfico nuevo. */
  budgetCeiling?: number;
  /** Medición de solicitudes; inyectable para pruebas. */
  report?: (route: string, outcome: { ms?: number; ok?: boolean }) => void;
}

export interface CloudPull {
  pullOnce(options?: { manual?: boolean; full?: boolean }): Promise<PullOutcome>;
}

/** A partir de este total diario no se programa ni subida ni descarga. */
export const SCHEDULED_REQUEST_CEILING = 90;

/** Páginas máximas de una descarga completa (autocuración), no programada. */
export const FULL_PULL_MAX_PAGES = 40;

/**
 * Registro de motores vivos por empresa. Permite que el arranque (store)
 * solicite una descarga completa sin conocer driver, transporte ni cursores.
 */
const pullRegistry = new Map<string, CloudPull>();

export function registerCloudPull(companyId: string, pull: CloudPull): void {
  const key = typeof companyId === 'string' ? companyId.trim() : "";
  if (!key) return;
  pullRegistry.set(key, pull);
}

export function unregisterCloudPull(companyId: string, pull?: CloudPull): void {
  const key = typeof companyId === 'string' ? companyId.trim() : "";
  if (!key) return;
  if (pull && pullRegistry.get(key) !== pull) return;
  pullRegistry.delete(key);
}

export function registeredCloudPull(companyId: string): CloudPull | null {
  const key = typeof companyId === 'string' ? companyId.trim() : "";
  return key ? pullRegistry.get(key) ?? null : null;
}

/**
 * Pide una descarga completa (sin cursor) al motor de esa empresa. Devuelve
 * `null` si no hay motor activo: el arranque decide si reintentar más tarde.
 */
export async function requestFullCloudPull(
  companyId: string,
  reason = "manual"
): Promise<PullOutcome | null> {
  const pull = registeredCloudPull(companyId);
  if (!pull) return null;
  console.info(`[PALMYRA] Descarga completa solicitada (${reason}) para ${companyId.trim()}.`);
  const outcome = await pull.pullOnce({ manual: true, full: true });
  console.info(
    `[PALMYRA] Descarga completa (${reason}): estado ${outcome.status}, ${outcome.applied} filas aplicadas.`
  );
  return outcome;
}

export function createCloudPull(options: CloudPullOptions): CloudPull {
  const driver = options.driver;
  const transport = options.transport;
  const cursors = options.cursors;
  const clock = options.now ?? (() => Date.now());
  const intervalMs = nonNegativeInt(options.intervalMs, PULL_INTERVAL_MS);
  const batchSize = positiveInt(options.batchSize, PULL_BATCH);
  const isOnline = options.isOnline ?? defaultIsOnline;
  const budgetTotal = options.budgetTotal ?? (() => readRequestBudget().total);
  const budgetCeiling = positiveInt(options.budgetCeiling, SCHEDULED_REQUEST_CEILING);
  const report = options.report ?? recordRequest;

  let resolvedCompanyId = options.companyId ? options.companyId.trim() : "";
  let inflight: Promise<PullOutcome> | null = null;

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

  async function run(manual: boolean, full = false): Promise<PullOutcome> {
    let cursor: string | null = null;
    try {
      const companyId = await resolveCompanyId();
      if (!companyId) {
        // Sin empresa no hay forma de validar el aislamiento: no se pide nada.
        return { status: "unknown-company", applied: 0, skipped: 0, conflicts: 0, cursor, hasMore: false };
      }
      registerCloudPull(companyId, pullHandle);

      const state: PullCursorState = await cursors.load(companyId);
      // Una descarga completa ignora el cursor incremental a propósito.
      cursor = full ? null : normalizeCursorText(state?.cursor);
      const lastPullAt = normalizeStamp(state?.updatedAt);
      const nowMs = time();

      if (!full && !manual && lastPullAt !== null && nowMs - lastPullAt < intervalMs) {
        return {
          status: "throttled",
          applied: 0,
          skipped: 0,
          conflicts: 0,
          cursor,
          hasMore: false,
          nextPullAt: lastPullAt + intervalMs
        };
      }

      if (!online(isOnline)) {
        return { status: "offline", applied: 0, skipped: 0, conflicts: 0, cursor, hasMore: false };
      }

      if (!full && !manual && spent(budgetTotal) >= budgetCeiling) {
        // Presupuesto del día agotado: se espera al siguiente ciclo manual.
        return {
          status: "throttled",
          applied: 0,
          skipped: 0,
          conflicts: 0,
          cursor,
          hasMore: false,
          nextPullAt: nowMs + intervalMs
        };
      }

      // Una descarga completa pagina hasta agotar la ventana (con tope duro);
      // una normal aplica exactamente un lote.
      const maxPages = full ? FULL_PULL_MAX_PAGES : 1;
      let appliedTotal = 0;
      let skippedTotal = 0;
      let conflictsTotal = 0;
      let hasMore = false;
      let workingCursor = cursor;

      for (let page = 0; page < maxPages; page += 1) {
        const startedAt = time();
        const result: RemotePullResult = await transport.pull({
          companyId,
          cursor: workingCursor,
          limit: batchSize
        });
        const elapsed = Math.max(0, time() - startedAt);
        measure(report, elapsed, !result?.error);

        if (!result || result.error) {
          if (appliedTotal > 0) {
            // Lo ya aplicado es válido: se informa el corte sin tirar el lote.
            return {
              status: "pulled",
              applied: appliedTotal,
              skipped: skippedTotal,
              conflicts: conflictsTotal,
              cursor: workingCursor,
              hasMore: true,
              nextPullAt: time() + intervalMs,
              error: result?.error ?? "No se pudo descargar de la nube."
            };
          }
          return {
            status: "failed",
            applied: 0,
            skipped: 0,
            conflicts: 0,
            cursor: workingCursor,
            hasMore: false,
            nextPullAt: time() + intervalMs,
            error: result?.error ?? "No se pudo descargar de la nube."
          };
        }

        const changes = Array.isArray(result.changes) ? result.changes : [];
        const report_ = await planRemoteChanges({
          localDriver: driver,
          changes: changes.map(toLocalChange),
          companyId,
          maxRows: batchSize
        });

        appliedTotal += Object.values(report_.applied).reduce((total, count) => total + count, 0);
        skippedTotal += report_.skipped;
        conflictsTotal += report_.conflicts.length;
        const nextCursor = normalizeCursorText(result.nextCursor) ?? workingCursor;
        // Solo aquí avanza el cursor: el lote ya se aplicó en una transacción.
        await cursors.save(companyId, { cursor: nextCursor, updatedAt: time() });
        workingCursor = nextCursor;
        hasMore = result.hasMore === true || report_.deferred > 0;
        if (!hasMore) break;
      }

      return {
        status: appliedTotal > 0 ? "pulled" : "idle",
        applied: appliedTotal,
        skipped: skippedTotal,
        conflicts: conflictsTotal,
        cursor: workingCursor,
        hasMore
      };
    } catch (error) {
      // Nunca lanzar: la pantalla decide con el resultado.
      return {
        status: "failed",
        applied: 0,
        skipped: 0,
        conflicts: 0,
        cursor,
        hasMore: false,
        nextPullAt: time() + intervalMs,
        error: describeError(error)
      };
    }
  }

  function pullOnce(request: { manual?: boolean; full?: boolean } = {}): Promise<PullOutcome> {
    // Una sola descarga en vuelo: dos llamadas simultáneas comparten resultado.
    if (inflight) return inflight;
    const task = run(request.manual === true, request.full === true);
    inflight = task;
    const release = (): void => {
      if (inflight === task) inflight = null;
    };
    void task.then(release, release);
    return task;
  }

  const pullHandle: CloudPull = { pullOnce };
  if (resolvedCompanyId) registerCloudPull(resolvedCompanyId, pullHandle);

  return pullHandle;
}

/** Traduce el cambio del transporte al contrato del aplicador LWW. */
function toLocalChange(change: RemoteChange): RemotePullChange {
  const row = change.row ?? null;
  const version = row && Number.isFinite(row.version) ? row.version : undefined;
  if (change.op === "delete") {
    return {
      table: change.table,
      row_id: change.rowId,
      row,
      tombstone: true,
      deleted_at: (row?.deleted_at as string | null | undefined) ?? change.updatedAt,
      version,
      updated_at: change.updatedAt
    };
  }
  return {
    table: change.table,
    row_id: change.rowId,
    row,
    version,
    updated_at: change.updatedAt
  };
}

function measure(
  report: (route: string, outcome: { ms?: number; ok?: boolean }) => void,
  ms: number,
  ok: boolean
): void {
  try {
    report("cloud/pull", { ms: Math.max(0, Math.round(ms)), ok });
  } catch {
    // Un registrador roto no cambia el resultado de la descarga.
  }
}

function spent(budgetTotal: () => number): number {
  try {
    const value = budgetTotal();
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  } catch {
    return 0;
  }
}

function online(isOnline: () => boolean): boolean {
  try {
    return isOnline() !== false;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const clean = message.trim() || "No se pudo descargar de la nube.";
  return clean.slice(0, 500);
}

function normalizeCursorText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

function normalizeStamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function defaultIsOnline(): boolean {
  const navigatorLike = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return navigatorLike?.onLine !== false;
}
