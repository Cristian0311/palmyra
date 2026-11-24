/**
 * Migración guiada del JSON legado al almacén local normalizado.
 *
 * El corte no se hace a ciegas: el operador analiza el estado (solo lectura),
 * crea un respaldo cifrado y solo entonces puede migrar. El comprobante del
 * respaldo ({ at, bytes, sha256? }) caduca a los 30 minutos y queda ligado a la
 * empresa en el registro persistido; sin él la migración se rechaza antes de
 * escribir una sola fila.
 *
 * La escritura la hace `applyVerifiedImport`: una única transacción que relee
 * lo escrito y deshace todo si los conteos, la suma de ventas, el stock o la
 * huella canónica no coinciden. Este módulo solo añade el gate del respaldo, la
 * relectura posterior (útil en IndexedDB, que no revierte) y la memoria del
 * paso en el que quedó cada empresa.
 *
 * El JSON legado nunca se borra aquí: la retención de 30 días y el volver al
 * modo anterior son marcas independientes (rollback = marca de paridad).
 */
import { getPalmyraLocalScope, getPalmyraScopedStorageKey } from "../../localScope";
import type { LocalDbDriver, LocalRow, LocalTable } from "../contract";
import { importLegacyState, type ImportMeta } from "../importLegacy";
import {
  applyVerifiedImport,
  verifyImportedState,
  type ImportSource,
  type ImportVerificationReport
} from "../importVerify";
import { LOCAL_DB_TABLE_NAMES } from "../schema";
import {
  clearLocalDbRollback,
  isLocalDbRollbackRequested,
  requestLocalDbRollback,
  type LocalDbRollbackRecord
} from "../parity";

/** Clave base del progreso; cada empresa usa `prefijo:companyId`. */
const GUIDED_MIGRATION_STORAGE_PREFIX = "palmyra:migration-guided:v1";
/** Un respaldo deja de servir para migrar 30 minutos después de crearse. */
const GUIDED_MIGRATION_BACKUP_TTL_MS = 30 * 60 * 1000;
/** Margen de reloj entre el equipo y el sello del respaldo (2 minutos). */
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const ANALYZER_ORIGIN_DEVICE = "migracion-analisis";
const ANALYZER_COMPANY = "migracion-analisis";

/** Motivo legible que se guarda en la marca de rollback de paridad. */
export const GUIDED_ROLLBACK_REASON =
  "Volver al modo anterior: seguir con el JSON legado y recuperar desde el respaldo si hace falta";

/** Subconjunto de Storage suficiente para el progreso y la marca de rollback. */
export type GuidedMigrationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type GuidedMigrationStep = "idle" | "analyzed" | "backup" | "migrated" | "failed";

/** Comprobante del respaldo: instante, tamaño y (opcional) SHA-256. */
export interface BackupProof {
  at: string;
  bytes: number;
  sha256?: string;
}

/** Entrada del comprobante tal como la entrega el panel de respaldo. */
export interface BackupProofInput {
  at?: string;
  bytes: number;
  sha256?: string;
}

export type BackupProofCheck =
  | { ok: true; proof: BackupProof; ageMs: number }
  | { ok: false; reason: string };

/** Resumen persistible del último intento: sin datos de clientes. */
export interface GuidedMigrationResultSummary {
  ok: boolean;
  at: string;
  source: ImportSource;
  rows: number;
  expectedRows: number;
  salesTotal: number;
  stockQuantity: number;
  hash: string;
  mismatches: number;
  error: string | null;
}

export interface GuidedMigrationState {
  step: GuidedMigrationStep;
  analyzedAt: string | null;
  backupAt: string | null;
  lastReportAt: string | null;
  lastResult: GuidedMigrationResultSummary | null;
  rollbackRequested: boolean;
  /** Comprobante completo: permite reanudar tras recargar sin perder bytes. */
  backupProof?: BackupProof | null;
}

export interface GuidedMigrationAnalysis {
  counts: Record<string, number>;
  salesTotal: number;
  stockQuantity: number;
  cashSessions: number;
  estimatedRows: number;
  generatedAt: string;
  warnings: string[];
}

export interface RunGuidedMigrationOptions {
  /** JSON legado (texto de zustand/persist u objeto ya parseado). */
  legacy: unknown;
  driver: LocalDbDriver;
  /** Comprobante del respaldo creado por este flujo; sin él no hay migración. */
  backupProof?: BackupProof | BackupProofInput | null;
  companyId?: string;
  originDevice?: string;
  now?: string;
  source?: ImportSource;
  /** Relectura posterior a la escritura; por defecto activada. */
  verify?: boolean;
  storage?: GuidedMigrationStorage | null;
}

export interface GuidedMigrationResult {
  ok: boolean;
  report: ImportVerificationReport | null;
  counts: Record<string, number>;
  salesTotal: number;
  stockQuantity: number;
  error?: string;
  summary: GuidedMigrationResultSummary;
  state: GuidedMigrationState;
  analysis: GuidedMigrationAnalysis;
}

export interface GuidedStateOptions {
  companyId: string;
  storage?: GuidedMigrationStorage | null;
  now?: string;
}

export interface GuidedRollbackOptions {
  companyId?: string;
  storage?: GuidedMigrationStorage | null;
  now?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// almacenamiento y utilidades
// ---------------------------------------------------------------------------

function resolveStorage(storage?: GuidedMigrationStorage | null): GuidedMigrationStorage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function resolveCompanyId(explicit?: string): string {
  const given = typeof explicit === "string" ? explicit.trim() : "";
  if (given) return given;
  try {
    return getPalmyraLocalScope()?.companyId?.trim() || "";
  } catch {
    return "";
  }
}

/** Clave por empresa; si hay sesión se añade el alcance para no mezclar cuentas. */
export function guidedMigrationStorageKey(companyId: string): string {
  const base = `${GUIDED_MIGRATION_STORAGE_PREFIX}:${String(companyId ?? "").trim() || "sin-empresa"}`;
  try {
    return getPalmyraScopedStorageKey(base) ?? base;
  } catch {
    return base;
  }
}

export function createEmptyGuidedMigrationState(): GuidedMigrationState {
  return {
    step: "idle",
    analyzedAt: null,
    backupAt: null,
    lastReportAt: null,
    lastResult: null,
    rollbackRequested: false,
    backupProof: null
  };
}

function isStep(value: unknown): value is GuidedMigrationStep {
  return (
    value === "idle" ||
    value === "analyzed" ||
    value === "backup" ||
    value === "migrated" ||
    value === "failed"
  );
}

function firstIsoString(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeSummary(value: unknown): GuidedMigrationResultSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const at = firstIsoString(raw.at);
  if (!at) return null;
  const source: ImportSource = raw.source === "cloud_snapshot" ? "cloud_snapshot" : "legacy_json";
  const numberOrZero = (input: unknown): number =>
    typeof input === "number" && Number.isFinite(input) ? input : 0;
  return {
    ok: raw.ok === true,
    at,
    source,
    rows: numberOrZero(raw.rows),
    expectedRows: numberOrZero(raw.expectedRows),
    salesTotal: numberOrZero(raw.salesTotal),
    stockQuantity: numberOrZero(raw.stockQuantity),
    hash: typeof raw.hash === "string" ? raw.hash : "",
    mismatches: numberOrZero(raw.mismatches),
    error: typeof raw.error === "string" && raw.error ? raw.error : null
  };
}

export function readGuidedMigrationState(options: GuidedStateOptions): GuidedMigrationState {
  const state = createEmptyGuidedMigrationState();
  const storage = resolveStorage(options?.storage);
  const companyId = resolveCompanyId(options?.companyId);
  // La marca de paridad manda: si existe, el aviso de rollback debe verse.
  const marker = isLocalDbRollbackRequested({ storage });

  if (!storage || !companyId) {
    state.rollbackRequested = marker;
    return state;
  }

  try {
    const raw = storage.getItem(guidedMigrationStorageKey(companyId));
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (isStep(parsed.step)) state.step = parsed.step;
        state.analyzedAt = firstIsoString(parsed.analyzedAt);
        state.backupAt = firstIsoString(parsed.backupAt);
        state.lastReportAt = firstIsoString(parsed.lastReportAt);
        state.lastResult = normalizeSummary(parsed.lastResult);
        state.rollbackRequested = parsed.rollbackRequested === true;
        const proof = normalizeProof(parsed.backupProof);
        state.backupProof = proof;
        if (!state.backupAt && proof) state.backupAt = proof.at;
      }
    }
  } catch {
    // Un registro ilegible equivale a empezar de cero: nada de negocio se toca.
  }

  state.rollbackRequested = state.rollbackRequested || marker;
  return state;
}

function writeState(storage: GuidedMigrationStorage | null, companyId: string, state: GuidedMigrationState): boolean {
  if (!storage || !companyId) return false;
  try {
    storage.setItem(guidedMigrationStorageKey(companyId), JSON.stringify(state));
    return true;
  } catch {
    // Sin cuota el flujo sigue: el progreso es una ayuda, no un requisito.
    return false;
  }
}

export function saveGuidedMigrationState(
  state: GuidedMigrationState,
  options: GuidedStateOptions
): GuidedMigrationState {
  const storage = resolveStorage(options?.storage);
  const companyId = resolveCompanyId(options?.companyId);
  const marker = isLocalDbRollbackRequested({ storage });
  const normalized: GuidedMigrationState = {
    ...createEmptyGuidedMigrationState(),
    ...state,
    rollbackRequested: state?.rollbackRequested === true || marker
  };
  writeState(storage, companyId, normalized);
  return normalized;
}

export function clearGuidedMigrationState(options: GuidedStateOptions): void {
  const storage = resolveStorage(options?.storage);
  const companyId = resolveCompanyId(options?.companyId);
  if (!storage || !companyId) return;
  try {
    storage.removeItem(guidedMigrationStorageKey(companyId));
  } catch {
    // Sin almacenamiento no hay nada que borrar.
  }
}

// ---------------------------------------------------------------------------
// comprobante del respaldo
// ---------------------------------------------------------------------------

function normalizeProof(value: unknown): BackupProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const at = firstIsoString(raw.at);
  const bytes = typeof raw.bytes === "number" && Number.isFinite(raw.bytes) ? raw.bytes : 0;
  if (!at || bytes <= 0) return null;
  const sha256 = typeof raw.sha256 === "string" && raw.sha256.trim() ? raw.sha256.trim().toLowerCase() : undefined;
  return sha256 ? { at, bytes, sha256 } : { at, bytes };
}

/**
 * Convierte la salida del respaldo en un comprobante válido. Rechaza un
 * respaldo vacío, con fecha ilegible, futuro (más allá del margen de reloj) o
 * creado hace más de 30 minutos. No escribe nada.
 */
export function createBackupProof(
  input: BackupProofInput | null | undefined,
  options: { now?: string; ttlMs?: number } = {}
): BackupProofCheck {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "No hay comprobante de respaldo: crea el respaldo antes de migrar." };
  }
  const bytes = typeof input.bytes === "number" && Number.isFinite(input.bytes) ? input.bytes : 0;
  if (bytes <= 0) {
    return { ok: false, reason: "El respaldo está vacío: no sirve como red de seguridad." };
  }

  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  if (!Number.isFinite(nowMs)) {
    return { ok: false, reason: "No se pudo leer el reloj del equipo para validar el respaldo." };
  }
  const atMs = input.at ? new Date(input.at).getTime() : nowMs;
  if (!Number.isFinite(atMs)) {
    return { ok: false, reason: "El respaldo no tiene una fecha válida." };
  }
  if (atMs - nowMs > CLOCK_SKEW_MS) {
    return { ok: false, reason: "El respaldo tiene una fecha futura: revisa el reloj del equipo." };
  }

  const ttl = typeof options.ttlMs === "number" && options.ttlMs > 0 ? options.ttlMs : GUIDED_MIGRATION_BACKUP_TTL_MS;
  const ageMs = Math.max(0, nowMs - atMs);
  if (ageMs > ttl) {
    const minutes = Math.round(ttl / 60000);
    return {
      ok: false,
      reason: `El respaldo tiene más de ${minutes} minutos: crea uno nuevo antes de migrar.`
    };
  }

  const proof = normalizeProof({ at: new Date(atMs).toISOString(), bytes, sha256: input.sha256 });
  if (!proof) {
    return { ok: false, reason: "El comprobante del respaldo está incompleto." };
  }
  return { ok: true, proof, ageMs };
}

// ---------------------------------------------------------------------------
// análisis (solo lectura)
// ---------------------------------------------------------------------------

function parseLegacy(
  legacy: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (typeof legacy !== "string") return { ok: true, value: legacy };
  const text = legacy.trim();
  if (!text) return { ok: false, reason: "el JSON legado está vacío" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "el JSON legado no es válido" };
  }
}

function sumColumn(rows: LocalRow[] | undefined, fields: string[]): number {
  let total = 0;
  for (const row of rows ?? []) {
    for (const field of fields) {
      const value = row[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        total += value;
        break;
      }
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          total += parsed;
          break;
        }
      }
    }
  }
  return total;
}

/**
 * Cuenta lo que la migración escribiría, sin tocar el driver. Los conteos
 * salen del mismo importador que luego se aplica, así que el número que ve el
 * operador es exactamente el que valida `applyVerifiedImport`.
 */
export function analyzeLegacyMigration(
  legacy: unknown,
  options: { companyId?: string; now?: string } = {}
): GuidedMigrationAnalysis {
  const generatedAt = firstIsoString(options.now) ?? new Date().toISOString();
  const empty: GuidedMigrationAnalysis = {
    counts: {},
    salesTotal: 0,
    stockQuantity: 0,
    cashSessions: 0,
    estimatedRows: 0,
    generatedAt,
    warnings: []
  };

  const parsed = parseLegacy(legacy);
  if (parsed.ok === false) {
    return { ...empty, warnings: [(parsed as { ok: false; reason: string }).reason] };
  }

  try {
    const meta: ImportMeta = {
      companyId: resolveCompanyId(options.companyId) || ANALYZER_COMPANY,
      originDevice: ANALYZER_ORIGIN_DEVICE,
      now: generatedAt
    };
    const { batches, report } = importLegacyState(parsed.value, meta);
    const counts: Record<string, number> = {};
    let estimatedRows = 0;
    for (const table of LOCAL_DB_TABLE_NAMES) {
      const rows = batches[table] ?? [];
      if (rows.length === 0) continue;
      counts[table] = rows.length;
      estimatedRows += rows.length;
    }

    return {
      counts,
      salesTotal: sumColumn(batches.sales, ["total", "total_amount"]),
      stockQuantity: sumColumn(batches.stock_balances, ["quantity"]),
      cashSessions: (batches as Partial<Record<LocalTable, LocalRow[]>>).cash_sessions?.length ?? 0,
      estimatedRows,
      generatedAt,
      warnings: report.warnings
    };
  } catch (error) {
    return {
      ...empty,
      warnings: [error instanceof Error ? error.message : "no se pudo analizar el estado legado"]
    };
  }
}

// ---------------------------------------------------------------------------
// migración
// ---------------------------------------------------------------------------

function summarizeReport(
  report: ImportVerificationReport | null,
  at: string,
  error: string | null
): GuidedMigrationResultSummary {
  const tables = report ? Object.values(report.tables) : [];
  return {
    ok: Boolean(report?.ok) && !error,
    at,
    source: report?.source ?? "legacy_json",
    rows: tables.reduce((sum, entry) => sum + entry.actual, 0),
    expectedRows: tables.reduce((sum, entry) => sum + entry.expected, 0),
    salesTotal: report?.totals.actualSalesTotal ?? 0,
    stockQuantity: report?.totals.actualStock ?? 0,
    hash: report?.hash.actual ?? "",
    mismatches: report?.mismatches.length ?? 0,
    error
  };
}

function countsFromReport(report: ImportVerificationReport | null, analysis: GuidedMigrationAnalysis): Record<string, number> {
  if (!report) return { ...analysis.counts };
  const counts: Record<string, number> = {};
  for (const [table, entry] of Object.entries(report.tables)) {
    counts[table] = entry.actual;
  }
  return counts;
}

interface GateDecision {
  ok: boolean;
  reason?: string;
  proof?: BackupProof;
}

function evaluateBackupGate(
  proofInput: BackupProofInput | null | undefined,
  state: GuidedMigrationState,
  now: string
): GateDecision {
  const check = createBackupProof(proofInput ?? null, { now });
  if (check.ok === false) return { ok: false, reason: (check as { ok: false; reason: string }).reason };
  const proof = check.proof;
  // El comprobante debe ser el registrado en este flujo: uno distinto sugiere
  // un respaldo de otra sesión y dejaría el corte sin red de seguridad real.
  if (state.backupAt && state.backupAt !== proof.at) {
    return {
      ok: false,
      reason: "El comprobante no corresponde al respaldo de esta migración: crea el respaldo de nuevo."
    };
  }
  return { ok: true, proof };
}

/**
 * Ejecuta el corte guiado.
 *
 * Orden: validar el estado, exigir un respaldo vigente, escribir y verificar en
 * una transacción (applyVerifiedImport) y releer una vez más. Nunca escribe a
 * medias: si algo no cuadra, el driver deshace el intento y el resultado llega
 * como `ok:false` con el motivo. Repetir con el mismo estado es seguro: las
 * filas se upsertan con los mismos ids y no se duplican.
 */
export async function runGuidedMigration(
  options: RunGuidedMigrationOptions
): Promise<GuidedMigrationResult> {
  const now = firstIsoString(options?.now) ?? new Date().toISOString();
  const companyId = resolveCompanyId(options?.companyId);
  const storage = resolveStorage(options?.storage);
  const analysis = analyzeLegacyMigration(options?.legacy, { companyId, now });
  const previousState = readGuidedMigrationState({ companyId, storage, now });

  const fail = (error: string, report: ImportVerificationReport | null = null): GuidedMigrationResult => {
    const summary = summarizeReport(report, now, error);
    const state = saveGuidedMigrationState(
      {
        ...previousState,
        lastReportAt: now,
        lastResult: summary
      },
      { companyId, storage, now }
    );
    return {
      ok: false,
      report,
      counts: countsFromReport(report, analysis),
      salesTotal: report?.totals.actualSalesTotal ?? analysis.salesTotal,
      stockQuantity: report?.totals.actualStock ?? analysis.stockQuantity,
      error,
      summary,
      state,
      analysis
    };
  };

  if (!options?.driver) return fail("No hay almacén local disponible para migrar.");
  if (!companyId) return fail("No hay una empresa activa para registrar la migración.");

  const parsed = parseLegacy(options.legacy);
  if (parsed.ok === false) {
    return fail(`No se puede migrar: ${(parsed as { ok: false; reason: string }).reason}.`);
  }

  const gate = evaluateBackupGate(options.backupProof ?? previousState.backupProof ?? null, previousState, now);
  if (gate.ok === false) {
    return fail(`Migración bloqueada: ${(gate as { ok: false; reason: string }).reason}`);
  }

  const meta: ImportMeta = {
    companyId,
    originDevice: String(options.originDevice ?? "").trim() || ANALYZER_ORIGIN_DEVICE,
    now
  };
  const source: ImportSource = options.source === "cloud_snapshot" ? "cloud_snapshot" : "legacy_json";

  let report: ImportVerificationReport | null = null;
  try {
    const applied = await applyVerifiedImport(options.driver, parsed.value, meta, { source });
    report = applied.report;
  } catch (error) {
    // Diagnóstico: en drivers que no revierten (IndexedDB) la relectura muestra
    // exactamente qué quedó escrito; en memoria/SQLite el almacén sigue intacto.
    let diagnostic: ImportVerificationReport | null = null;
    try {
      diagnostic = await verifyImportedState(options.driver, parsed.value, meta, { source });
    } catch {
      diagnostic = null;
    }
    const message = error instanceof Error ? error.message : "la importación no se pudo verificar";
    return fail(message, diagnostic);
  }

  if (options.verify !== false) {
    try {
      const recheck = await verifyImportedState(options.driver, parsed.value, meta, { source });
      if (!recheck.ok) {
        return fail(`La relectura posterior no coincide: ${recheck.mismatches.join("; ")}`, recheck);
      }
      report = recheck;
    } catch (error) {
      const message = error instanceof Error ? error.message : "no se pudo releer el almacén tras migrar";
      return fail(message, report);
    }
  }

  const summary = summarizeReport(report, now, null);
  const state = saveGuidedMigrationState(
    {
      ...previousState,
      step: "migrated",
      analyzedAt: previousState.analyzedAt ?? analysis.generatedAt,
      backupAt: gate.proof?.at ?? previousState.backupAt,
      backupProof: gate.proof ?? previousState.backupProof ?? null,
      lastReportAt: now,
      lastResult: summary
    },
    { companyId, storage, now }
  );

  return {
    ok: summary.ok,
    report,
    counts: countsFromReport(report, analysis),
    salesTotal: report?.totals.actualSalesTotal ?? 0,
    stockQuantity: report?.totals.actualStock ?? 0,
    summary,
    state,
    analysis
  };
}

// ---------------------------------------------------------------------------
// rollback (modo anterior)
// ---------------------------------------------------------------------------

/**
 * Marca la empresa para volver al modo anterior. La marca real la lee el
 * arranque desde la paridad; aquí solo se envuelve y se refleja en el progreso.
 */
export function requestRollback(options: GuidedRollbackOptions = {}): LocalDbRollbackRecord {
  const storage = resolveStorage(options.storage);
  const record = requestLocalDbRollback(String(options.reason ?? "").trim() || GUIDED_ROLLBACK_REASON, {
    storage,
    now: options.now
  });
  const companyId = resolveCompanyId(options.companyId);
  if (companyId) {
    const state = readGuidedMigrationState({ companyId, storage, now: options.now });
    saveGuidedMigrationState({ ...state, rollbackRequested: true }, { companyId, storage, now: options.now });
  }
  return record;
}

export function isRollbackRequested(options: { companyId?: string; storage?: GuidedMigrationStorage | null } = {}): boolean {
  const storage = resolveStorage(options.storage);
  if (isLocalDbRollbackRequested({ storage })) return true;
  const companyId = resolveCompanyId(options.companyId);
  if (!companyId) return false;
  return readGuidedMigrationState({ companyId, storage }).rollbackRequested;
}

/** Descarta el aviso: solo debe llamarse tras confirmación explícita. */
export function clearRollback(options: { companyId?: string; storage?: GuidedMigrationStorage | null; now?: string } = {}): void {
  const storage = resolveStorage(options.storage);
  clearLocalDbRollback({ storage });
  const companyId = resolveCompanyId(options.companyId);
  if (!companyId) return;
  const state = readGuidedMigrationState({ companyId, storage, now: options.now });
  saveGuidedMigrationState({ ...state, rollbackRequested: false }, { companyId, storage, now: options.now });
}

// ---------------------------------------------------------------------------
// resumen para logs y aria-live
// ---------------------------------------------------------------------------

/** Una sola línea, sin datos de clientes: tablas, sumas, stock y huella. */
export function formatGuidedMigrationReport(result: GuidedMigrationResult): string {
  const tables = Object.keys(result.counts)
    .sort()
    .map((table) => `${table}:${result.counts[table]}`)
    .join(",");
  const parts = [
    `migracion_guiada ${result.ok ? "ok" : "fail"}`,
    `rows=${result.summary.rows}/${result.summary.expectedRows}`,
    `sales_total=${result.salesTotal}`,
    `stock=${result.stockQuantity}`,
    `hash=${result.summary.hash || "-"}`,
    `mismatches=${result.summary.mismatches}`
  ];
  if (result.error) parts.push(`error=${result.error}`);
  parts.push(`[${tables}]`);
  return parts.join(" ");
}
