import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSearch,
  HardDrive,
  PlayCircle,
  RotateCcw,
  ShieldCheck,
  XCircle
} from "lucide-react";
import { cn } from "../../lib/utils";
import { getPalmyraLocalScope } from "../../services/localScope";
import { getDeviceId } from "../../services/lanPresence";
import { readLocalStateStorage } from "../../services/localStateStorage";
import { getRuntimeDriver } from "../../services/localDb/runtimeDriver";
import type { LocalDbDriver } from "../../services/localDb/contract";
import {
  GUIDED_ROLLBACK_REASON,
  analyzeLegacyMigration,
  clearRollback,
  createBackupProof,
  createEmptyGuidedMigrationState,
  isRollbackRequested,
  readGuidedMigrationState,
  requestRollback,
  runGuidedMigration,
  saveGuidedMigrationState,
  type BackupProofInput,
  type GuidedMigrationAnalysis,
  type GuidedMigrationResult,
  type GuidedMigrationState,
  type GuidedMigrationStorage
} from "../../services/localDb/migration";

/**
 * Migración guiada del JSON legado al almacén local normalizado.
 *
 * Cuatro pasos, ninguno automático: analizar (solo lectura), respaldar (el
 * respaldo es obligatorio y caduca a los 30 minutos), migrar y revisar el
 * reporte. El JSON legado nunca se borra aquí: sigue disponible 30 días y el
 * botón de vuelta al modo anterior deja la marca que lee el arranque.
 */
export interface GuidedMigrationPanelProps {
  /** Estado legado ya parseado o el texto de zustand/persist. Sin él se lee del equipo. */
  legacy?: unknown;
  companyId?: string;
  originDevice?: string;
  /** Driver inyectable para pruebas; por defecto el runtime de la app. */
  driver?: LocalDbDriver;
  /** localStorage inyectable; `null` simula un equipo sin almacenamiento. */
  storage?: GuidedMigrationStorage | null;
  /** Reloj inyectable, para pruebas deterministas. */
  now?: () => string;
  /**
   * Crea el respaldo. Debe devolver al menos el tamaño del archivo cifrado;
   * si no se pasa, el panel explica cómo respaldar desde «Respaldo».
   */
  onCreateBackup?: () => Promise<BackupProofInput | null> | BackupProofInput | null;
  onMigrated?: (result: GuidedMigrationResult) => void;
}

type Busy = "analyze" | "backup" | "migrate" | null;

interface Notice {
  type: "ok" | "error" | "info";
  text: string;
}

function formatMoment(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("es-ES", { maximumFractionDigits: 2 });
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "No se pudo completar la operación.";
}

const STEPS = [
  { id: "analyze", title: "1. Analizar", hint: "Cuenta filas, ventas, stock y turnos sin escribir nada." },
  { id: "backup", title: "2. Respaldo obligatorio", hint: "Sin un respaldo reciente no se migra." },
  { id: "migrate", title: "3. Migrar", hint: "Escribe y verifica en una sola transacción." },
  { id: "report", title: "4. Reporte", hint: "Conteos, sumas, stock y huella del resultado." }
] as const;

export default function GuidedMigrationPanel(props: GuidedMigrationPanelProps) {
  const clock = props.now ?? (() => new Date().toISOString());
  const [companyId] = useState(() => {
    const given = typeof props.companyId === "string" ? props.companyId.trim() : "";
    if (given) return given;
    try {
      return getPalmyraLocalScope()?.companyId?.trim() ?? "";
    } catch {
      return "";
    }
  });
  const [originDevice] = useState(() => {
    const given = typeof props.originDevice === "string" ? props.originDevice.trim() : "";
    if (given) return given;
    try {
      return getDeviceId();
    } catch {
      return "migracion-guiada";
    }
  });

  const [legacy, setLegacy] = useState<unknown>(props.legacy ?? null);
  const [legacyLoaded, setLegacyLoaded] = useState(props.legacy !== undefined && props.legacy !== null);
  const [state, setState] = useState<GuidedMigrationState>(() =>
    props.companyId
      ? readGuidedMigrationState({ companyId: props.companyId, storage: props.storage })
      : createEmptyGuidedMigrationState()
  );
  const [analysis, setAnalysis] = useState<GuidedMigrationAnalysis | null>(null);
  const [result, setResult] = useState<GuidedMigrationResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [rollback, setRollback] = useState(false);

  // Progreso persistido y marca de rollback: se leen una vez al montar.
  useEffect(() => {
    if (!companyId) return;
    setState(readGuidedMigrationState({ companyId, storage: props.storage }));
    setRollback(isRollbackRequested({ companyId, storage: props.storage }));
  }, [companyId, props.storage]);

  // Estado legado vivo del equipo cuando no lo inyecta el contenedor.
  useEffect(() => {
    if (legacyLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await readLocalStateStorage();
        if (cancelled) return;
        setLegacy(raw);
        setLegacyLoaded(Boolean(raw));
        if (!raw) {
          setNotice({
            type: "info",
            text: "No hay estado legado guardado en este equipo: no hay nada que migrar."
          });
        }
      } catch {
        if (!cancelled) {
          setNotice({ type: "error", text: "No se pudo leer el estado legado de este equipo." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [legacyLoaded]);

  const persist = useCallback(
    (next: GuidedMigrationState): GuidedMigrationState => {
      if (!companyId) return next;
      const saved = saveGuidedMigrationState(next, { companyId, storage: props.storage, now: clock() });
      setState(saved);
      return saved;
    },
    [companyId, props.storage, clock]
  );

  const proofNow = clock();
  const proofCheck = useMemo(
    () => createBackupProof(state.backupProof ?? null, { now: proofNow }),
    [state.backupProof, proofNow]
  );
  const backupReady = proofCheck.ok === true;

  const handleAnalyze = () => {
    if (!legacyLoaded) {
      setNotice({ type: "error", text: "Todavía no hay estado legado disponible para analizar." });
      return;
    }
    setBusy("analyze");
    setNotice(null);
    try {
      const nextAnalysis = analyzeLegacyMigration(legacy, { companyId, now: clock() });
      if (nextAnalysis.warnings.some((entry) => entry.includes("no es válido") || entry.includes("vacío"))) {
        setNotice({ type: "error", text: `El estado legado no se pudo leer: ${nextAnalysis.warnings[0]}.` });
        return;
      }
      setAnalysis(nextAnalysis);
      persist({
        ...state,
        step: state.step === "migrated" ? "migrated" : "analyzed",
        analyzedAt: nextAnalysis.generatedAt
      });
      setNotice({
        type: "ok",
        text: `Análisis listo: ${formatNumber(nextAnalysis.estimatedRows)} filas en ${
          Object.keys(nextAnalysis.counts).length
        } tablas. Nada se ha escrito.`
      });
    } catch (error) {
      setNotice({ type: "error", text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleBackup = async () => {
    if (!props.onCreateBackup) {
      setNotice({
        type: "info",
        text: "Este equipo no tiene el botón de respaldo conectado. Crea el respaldo cifrado en Configuración → Respaldo y vuelve a este paso."
      });
      return;
    }
    setBusy("backup");
    setNotice(null);
    try {
      const outcome = await props.onCreateBackup();
      if (!outcome) {
        setNotice({
          type: "info",
          text: "El respaldo no devolvió un comprobante. Créalo de nuevo desde Configuración → Respaldo antes de migrar."
        });
        return;
      }
      const check = createBackupProof(outcome, { now: clock() });
      if (check.ok === false) {
        setNotice({ type: "error", text: (check as { ok: false; reason: string }).reason });
        return;
      }
      persist({
        ...state,
        step: "backup",
        backupAt: check.proof.at,
        backupProof: check.proof
      });
      setNotice({
        type: "ok",
        text: `Respaldo registrado (${formatNumber(check.proof.bytes)} bytes). Válido para migrar durante 30 minutos.`
      });
    } catch (error) {
      setNotice({ type: "error", text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleMigrate = async () => {
    if (!companyId) {
      setNotice({ type: "error", text: "No hay una empresa activa para migrar." });
      return;
    }
    if (!backupReady) {
      setNotice({ type: "error", text: "La migración está bloqueada: falta un respaldo vigente." });
      return;
    }
    if (!legacyLoaded) {
      setNotice({ type: "error", text: "No hay estado legado disponible para migrar." });
      return;
    }
    setBusy("migrate");
    setNotice(null);
    try {
      const driver = props.driver ?? (await getRuntimeDriver());
      const outcome = await runGuidedMigration({
        legacy,
        driver,
        backupProof: state.backupProof ?? null,
        companyId,
        originDevice,
        now: clock(),
        storage: props.storage
      });
      setResult(outcome);
      setAnalysis(outcome.analysis);
      setState(outcome.state);
      if (outcome.ok) {
        setNotice({
          type: "ok",
          text: `Migración verificada. ${formatNumber(outcome.summary.rows)} filas escritas; ventas ${formatNumber(
            outcome.salesTotal
          )}; stock ${formatNumber(outcome.stockQuantity)}.`
        });
        props.onMigrated?.(outcome);
      } else {
        setNotice({
          type: "error",
          text: outcome.error ?? "La migración no se pudo verificar. No se escribió nada."
        });
      }
    } catch (error) {
      setNotice({ type: "error", text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const announce = (text: string): boolean => {
    try {
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        return window.confirm(text);
      }
    } catch {
      return false;
    }
    return true;
  };

  const handleRollback = () => {
    if (
      !announce(
        "¿Volver al modo anterior? Se dejará de usar el almacén normalizado y la caja seguirá con el JSON legado. El respaldo y el JSON se conservan."
      )
    ) {
      return;
    }
    requestRollback({ companyId, storage: props.storage, now: clock(), reason: GUIDED_ROLLBACK_REASON });
    setRollback(true);
    setState((current) => ({ ...current, rollbackRequested: true }));
    setNotice({
      type: "info",
      text: "Marcado el modo anterior. La app seguirá con el JSON legado y podrás restaurar desde el respaldo."
    });
  };

  const handleDismissRollback = () => {
    if (
      !announce(
        "¿Descartar el aviso? Se mantendrá el modo actual. Hazlo solo si ya revisaste los datos y no necesitas volver atrás."
      )
    ) {
      return;
    }
    clearRollback({ companyId, storage: props.storage, now: clock() });
    setRollback(false);
    setState((current) => ({ ...current, rollbackRequested: false }));
    setNotice({ type: "ok", text: "Aviso descartado. La app sigue en el modo actual." });
  };

  const step = state.step;
  const analyzedDone = Boolean(analysis) || step !== "idle";
  const backupDone = backupReady && (step === "backup" || step === "migrated" || step === "failed");
  const migratedDone = step === "migrated" || Boolean(result?.ok);
  const activeStep = migratedDone ? "report" : backupDone ? "migrate" : analyzedDone ? "backup" : "analyze";
  const report = result?.report ?? null;
  const reportTables = report ? Object.entries(report.tables).sort(([left], [right]) => left.localeCompare(right)) : [];

  return (
    <section
      aria-labelledby="guided-migration-title"
      className="rounded-2xl border border-base bg-secondary p-3 shadow-sm sm:p-4"
    >
      <div className="min-w-0">
        <h3 id="guided-migration-title" className="flex items-center gap-2 text-base font-bold text-primary">
          <ClipboardList size={18} className="text-violet-600" />
          Migración guiada al almacén local
        </h3>
        <p className="mt-1 text-sm font-medium leading-6 text-muted">
          Pasa los datos del modo anterior al almacén normalizado con respaldo obligatorio y verificación de
          conteos, ventas, stock y huella. Nada se ejecuta solo: cada paso lo confirmas tú. El JSON legado se
          conserva 30 días.
        </p>
      </div>

      {rollback && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <p>
              <strong>Vuelta al modo anterior solicitada.</strong> La caja seguirá con el JSON legado hasta que
              confirmes lo contrario. El respaldo cifrado y el JSON se conservan.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleRollback}
                className="flex min-h-11 items-center gap-2 rounded-xl bg-amber-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-amber-700"
              >
                <RotateCcw size={15} /> Volver al modo anterior
              </button>
              <button
                type="button"
                onClick={handleDismissRollback}
                className="flex min-h-11 items-center gap-2 rounded-xl border border-amber-400 bg-transparent px-3 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-900/50 dark:text-amber-200 dark:hover:bg-amber-950/40"
              >
                <XCircle size={15} /> Descartar aviso
              </button>
            </div>
          </div>
        </div>
      )}

      <ol className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Pasos de la migración">
        {STEPS.map((entry) => {
          const active = entry.id === activeStep;
          return (
            <li
              key={entry.id}
              aria-current={active ? "step" : undefined}
              className={cn(
                "rounded-xl border p-2.5 text-sm font-semibold",
                active
                  ? "border-violet-400 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-200"
                  : "border-base bg-primary text-secondary"
              )}
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold",
                    active ? "bg-violet-600 text-white" : "bg-subtle text-muted"
                  )}
                >
                  {entry.id === "report" && migratedDone ? "✓" : STEPS.findIndex((item) => item.id === entry.id) + 1}
                </span>
                {entry.title}
              </span>
              <span className="mt-1 block text-xs font-medium leading-5 text-muted">{entry.hint}</span>
            </li>
          );
        })}
      </ol>

      {!companyId && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium leading-6 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200"
        >
          No hay una empresa activa: inicia sesión para registrar el avance de la migración.
        </p>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {notice?.text ?? ""}
      </p>

      {notice && (
        <p
          aria-hidden="true"
          className={cn(
            "mt-3 rounded-xl border p-3 text-sm font-medium leading-6",
            notice.type === "ok" &&
              "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200",
            notice.type === "error" &&
              "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200",
            notice.type === "info" &&
              "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900/40 dark:bg-violet-950/20 dark:text-violet-200"
          )}
        >
          {notice.text}
        </p>
      )}

      <div className="mt-3 space-y-3">
        {/* Paso 1: analizar */}
        <div className="rounded-xl border border-base bg-primary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <FileSearch size={15} className="text-violet-600" /> 1. Analizar el estado actual
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-muted">
            Solo lectura: cuenta lo que se escribiría. Analizado por última vez: {formatMoment(state.analyzedAt)}.
          </p>
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={busy !== null || !legacyLoaded}
            className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-base bg-secondary text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50 sm:w-auto sm:px-4"
          >
            <ClipboardList size={15} />
            {busy === "analyze" ? "Analizando…" : analysis ? "Analizar de nuevo" : "Analizar estado legado"}
          </button>
          {analysis && (
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm font-medium text-secondary sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Filas estimadas</dt>
                <dd className="font-bold text-primary">{formatNumber(analysis.estimatedRows)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Ventas (total)</dt>
                <dd className="font-bold text-primary">{formatNumber(analysis.salesTotal)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Stock (cantidad)</dt>
                <dd className="font-bold text-primary">{formatNumber(analysis.stockQuantity)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Turnos de caja</dt>
                <dd className="font-bold text-primary">{formatNumber(analysis.cashSessions)}</dd>
              </div>
            </dl>
          )}
        </div>

        {/* Paso 2: respaldo obligatorio */}
        <div className="rounded-xl border border-base bg-primary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <ShieldCheck size={15} className="text-violet-600" /> 2. Respaldo obligatorio
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-muted">
            {backupReady
              ? `Respaldo registrado el ${formatMoment(state.backupAt)} y listo para migrar.`
              : "Crea un respaldo cifrado ahora. Sin comprobante reciente (máximo 30 minutos) la migración queda bloqueada."}
          </p>
          <button
            type="button"
            onClick={() => void handleBackup()}
            disabled={busy !== null}
            className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50 sm:w-auto"
          >
            <HardDrive size={15} />
            {busy === "backup" ? "Creando respaldo…" : backupReady ? "Crear un respaldo nuevo" : "Crear respaldo ahora"}
          </button>
          {!props.onCreateBackup && (
            <p className="mt-2 text-sm font-medium leading-6 text-muted">
              Este panel no tiene conectado el botón de respaldo. Ve a Configuración → Respaldo cifrado, crea el
              archivo y vuelve aquí para registrar el comprobante.
            </p>
          )}
          {!backupReady && state.backupProof && (
            <p className="mt-2 text-sm font-medium leading-6 text-amber-700 dark:text-amber-300">
              El comprobante guardado ya no es válido: {proofCheck.ok === false ? proofCheck.reason : ""}
            </p>
          )}
        </div>

        {/* Paso 3: migrar */}
        <div className="rounded-xl border border-base bg-primary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <Database size={15} className="text-violet-600" /> 3. Migrar y verificar
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-muted">
            Escribe todos los datos en una única transacción y relee para comparar conteos, ventas, stock y
            huella. Si algo no cuadra, no queda nada escrito.
          </p>
          <button
            type="button"
            onClick={() => void handleMigrate()}
            disabled={busy !== null || !backupReady || !legacyLoaded || !companyId}
            className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-40 sm:w-auto"
          >
            <PlayCircle size={15} />
            {busy === "migrate" ? "Migrando y verificando…" : "Migrar ahora"}
          </button>
          {!backupReady && (
            <p className="mt-2 text-sm font-medium leading-6 text-muted">
              Botón desactivado: primero completa el respaldo obligatorio del paso 2.
            </p>
          )}
        </div>

        {/* Paso 4: reporte */}
        <div className="rounded-xl border border-base bg-primary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            {result?.ok ? (
              <CheckCircle2 size={15} className="text-emerald-600" />
            ) : result ? (
              <XCircle size={15} className="text-rose-600" />
            ) : (
              <ClipboardList size={15} className="text-violet-600" />
            )}
            4. Reporte de la migración
          </p>
          {!result && (
            <p className="mt-1 text-sm font-medium leading-6 text-muted">
              Aún no hay reporte en esta sesión. Último reporte guardado: {formatMoment(state.lastReportAt)}
              {state.lastResult
                ? ` (${state.lastResult.ok ? "correcto" : "con fallos"}, ${formatNumber(
                    state.lastResult.rows
                  )} filas).`
                : "."}
            </p>
          )}
          {result && (
            <div className="mt-2 space-y-2">
              <p
                className={cn(
                  "rounded-xl border p-2.5 text-sm font-semibold",
                  result.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200"
                    : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200"
                )}
              >
                {result.ok
                  ? "Verificación correcta: los datos escritos coinciden con el estado legado."
                  : `Verificación fallida: ${result.error ?? "los datos no coinciden."}`}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-sm font-medium text-secondary sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted">Ventas (total)</dt>
                  <dd className="font-bold text-primary">{formatNumber(result.salesTotal)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Stock (cantidad)</dt>
                  <dd className="font-bold text-primary">{formatNumber(result.stockQuantity)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Filas escritas</dt>
                  <dd className="font-bold text-primary">{formatNumber(result.summary.rows)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Discordancias</dt>
                  <dd className="font-bold text-primary">{formatNumber(result.summary.mismatches)}</dd>
                </div>
              </dl>
              <p className="break-all font-mono text-xs text-muted">
                Huella: {result.summary.hash || "—"}
                {report ? ` (esperada ${report.hash.expected})` : ""}
              </p>
              <p className="text-sm font-medium leading-6 text-muted">
                El JSON legado se conserva 30 días. Si algo no cuadra, usa «Volver al modo anterior» o restaura el
                respaldo.
              </p>
              {reportTables.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-base">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Conteos esperados y reales por tabla</caption>
                    <thead className="bg-subtle text-xs uppercase text-muted">
                      <tr>
                        <th scope="col" className="p-2 font-semibold">Tabla</th>
                        <th scope="col" className="p-2 font-semibold">Esperado</th>
                        <th scope="col" className="p-2 font-semibold">Real</th>
                        <th scope="col" className="p-2 font-semibold">Estado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-base">
                      {reportTables.map(([table, entry]) => {
                        const ok = entry.expected === entry.actual;
                        return (
                          <tr key={table}>
                            <td className="p-2 font-semibold text-primary">{table}</td>
                            <td className="p-2 text-secondary">{formatNumber(entry.expected)}</td>
                            <td className="p-2 text-secondary">{formatNumber(entry.actual)}</td>
                            <td className="p-2 font-semibold">
                              <span className={ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>
                                {ok ? "OK" : "Diferencia"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {report && report.mismatches.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm font-medium leading-6 text-rose-700 dark:text-rose-300">
                  {report.mismatches.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
