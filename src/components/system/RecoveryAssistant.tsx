import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, LifeBuoy, RotateCcw, Upload } from "lucide-react";
import { useDesktopRuntimeStatus } from "../../hooks/useDesktopRuntimeStatus";
import {
  collectInstallDiagnostics,
  downloadInstallDiagnostics,
  formatInstallDiagnostics
} from "../../services/diagnostics/install";
import {
  collectLastBackupState,
  collectLocalDbState
} from "../../services/diagnostics/localState";
import { getLastLocalDbSourceDiagnostics } from "../../services/localDb/bootHydration";
import { getRuntimeDriver } from "../../services/localDb/runtimeDriver";

/**
 * Recuperación guiada para fallos de base local o de respaldo.
 *
 * Solo aparece cuando existe un estado de error real: la base de escritorio no
 * está lista, el arranque del almacén local falló o una importación de respaldo
 * fue rechazada. Los pasos son los mismos que aplica soporte y no inventan
 * telemetría: reutiliza los colectores del diagnóstico, el respaldo existente y
 * la importación de Configuración.
 */

export interface RecoveryAssistantProps {
  /** Motivo visible del rechazo de una importación de respaldo. */
  importError?: string | null;
  /** Abre el selector del respaldo .json existente en Configuración. */
  onPickBackup?: () => void;
  /** Descarta el aviso de importación fallida. */
  onDismissImportError?: () => void;
}

/** Motivo del arranque del almacén local que merece recuperación (no el modo sombra). */
function readBootIssue(): string | null {
  const diagnostics = getLastLocalDbSourceDiagnostics();
  if (!diagnostics || diagnostics.mode !== "local" || diagnostics.applied) return null;
  const reason = String(diagnostics.reason ?? "");
  return /ilegible|error inesperado|fallida/i.test(reason) ? reason : null;
}

function StepNumber({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-600 text-xs font-bold text-white"
    >
      {value}
    </span>
  );
}

export default function RecoveryAssistant({
  importError,
  onPickBackup,
  onDismissImportError
}: RecoveryAssistantProps) {
  const desktop = useDesktopRuntimeStatus();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [manualText, setManualText] = useState("");
  const [hidden, setHidden] = useState(false);

  const bootIssue = readBootIssue();
  // Antes de la primera lectura del puente el estado está vacío: sin ruta, sin
  // error y con driver «unavailable». Eso no es un fallo, así que no se avisa.
  const desktopDbPending =
    desktop.db.driver === "unavailable" && !desktop.db.lastError && !desktop.db.filePath;
  const desktopDbIssue = desktop.available && !desktopDbPending && !desktop.db.ready;
  const kind: "import" | "db" | null = importError
    ? "import"
    : desktopDbIssue || bootIssue
      ? "db"
      : null;

  useEffect(() => {
    if (importError) {
      setHidden(false);
      setNotice("");
      setManualText("");
    }
  }, [importError]);

  const handleRetry = useCallback(async () => {
    if (busy) return;
    if (kind === "import") {
      setNotice("Elige de nuevo el archivo del respaldo.");
      onPickBackup?.();
      return;
    }
    setBusy(true);
    setNotice("Comprobando la base local…");
    try {
      const driver = await getRuntimeDriver();
      await driver.ready();
      setNotice("La base local respondió. Reinicia PALMYRA para aplicar los datos guardados.");
      if (desktop.available) void desktop.refresh();
    } catch {
      setNotice(
        "La base local sigue sin responder. Descarga el diagnóstico y envíalo a soporte; no restablezcas datos."
      );
    } finally {
      setBusy(false);
    }
  }, [busy, desktop, kind, onPickBackup]);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setNotice("");
    try {
      const [localDb, lastBackup] = await Promise.all([
        collectLocalDbState(),
        collectLastBackupState()
      ]);
      const report = await collectInstallDiagnostics({ localDb, lastBackup });
      const result = downloadInstallDiagnostics(report);
      if (result.ok) {
        setNotice(`Diagnóstico descargado: ${result.fileName}. Adjúntalo al mensaje para soporte.`);
        setManualText("");
        return;
      }
      setManualText(formatInstallDiagnostics(report));
      setNotice("No se pudo descargar el archivo. Copia el texto de abajo y envíalo a soporte.");
    } catch {
      setNotice("No se pudo generar el diagnóstico. Inténtalo de nuevo.");
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  if (!kind || hidden) return null;

  const isImport = kind === "import";
  const detail = isImport ? importError : desktop.db.lastError || bootIssue;
  const title = isImport ? "El respaldo no se pudo aplicar" : "PALMYRA no pudo abrir su base local";

  return (
    <section
      aria-labelledby="recovery-assistant-title"
      className="rounded-2xl border border-rose-200 bg-rose-50/70 p-3 shadow-sm dark:border-rose-900/40 dark:bg-rose-950/20 sm:p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="recovery-assistant-title"
            className="flex items-center gap-2 text-base font-bold text-rose-800 dark:text-rose-200"
          >
            <LifeBuoy size={18} className="shrink-0" aria-hidden="true" />
            Recuperación guiada
          </h3>
          <p className="mt-1 text-sm font-semibold text-rose-800 dark:text-rose-200">{title}</p>
          <p className="mt-1 text-sm font-medium leading-6 text-rose-800/90 dark:text-rose-200/90">
            {isImport
              ? "No se cambió ningún dato. Sigue estos pasos en orden: primero se conserva la información y después se intenta recuperar."
              : "Los datos siguen guardados en este equipo. Sigue estos pasos en orden antes de tomar cualquier otra medida."}
          </p>
          {detail && (
            <p className="mt-1 break-words text-sm font-medium leading-5 text-rose-700 dark:text-rose-300">
              Detalle: {detail}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setHidden(true);
            onDismissImportError?.();
          }}
          className="h-11 rounded-xl border border-rose-300 px-3 text-sm font-semibold text-rose-800 transition-colors hover:bg-rose-100 dark:border-rose-900/50 dark:text-rose-200 dark:hover:bg-rose-950/40"
        >
          Ocultar
        </button>
      </div>

      <ol className="mt-3 space-y-2">
        <li className="flex items-start gap-2 rounded-xl border border-rose-200 bg-white/70 p-3 dark:border-rose-900/40 dark:bg-slate-950/30">
          <StepNumber value={1} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-primary">
              {isImport ? "Volver a intentar la importación" : "Volver a intentar la apertura"}
            </p>
            <p className="text-sm font-medium leading-5 text-muted">
              {isImport
                ? "Elige de nuevo el mismo archivo (o una copia) y espera a que se revise completo."
                : "Cierra otras ventanas de PALMYRA, espera unos segundos y vuelve a intentarlo."}
            </p>
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={busy || exporting}
              className="mt-2 flex h-11 items-center justify-center gap-2 rounded-xl bg-rose-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
            >
              <RotateCcw size={15} className={busy ? "animate-spin" : ""} aria-hidden="true" />
              {busy ? "Comprobando…" : isImport ? "Elegir archivo de nuevo" : "Reintentar ahora"}
            </button>
          </div>
        </li>

        <li className="flex items-start gap-2 rounded-xl border border-rose-200 bg-white/70 p-3 dark:border-rose-900/40 dark:bg-slate-950/30">
          <StepNumber value={2} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-primary">Guardar el diagnóstico</p>
            <p className="text-sm font-medium leading-5 text-muted">
              Un solo clic: informe con el estado de la base local y del último respaldo, sin datos
              de clientes ni contraseñas. Es lo primero que pide soporte.
            </p>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exporting || busy}
              className="mt-2 flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
            >
              <Download size={15} aria-hidden="true" />
              {exporting ? "Generando…" : "Descargar diagnóstico"}
            </button>
          </div>
        </li>

        {onPickBackup && (
          <li className="flex items-start gap-2 rounded-xl border border-rose-200 bg-white/70 p-3 dark:border-rose-900/40 dark:bg-slate-950/30">
            <StepNumber value={3} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-primary">Recuperar desde un respaldo</p>
              <p className="text-sm font-medium leading-5 text-muted">
                Si tienes el respaldo .json de este negocio, impórtalo: se revisa antes de aplicar
                nada y, si el formato no es válido, no se toca el trabajo actual.
              </p>
              <button
                type="button"
                onClick={() => {
                  setNotice("Elige el archivo del respaldo.");
                  onPickBackup();
                }}
                disabled={busy || exporting}
                className="mt-2 flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
              >
                <Upload size={15} aria-hidden="true" />
                Elegir respaldo (.json)
              </button>
            </div>
          </li>
        )}

        <li className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
          <StepNumber value={onPickBackup ? 4 : 3} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
              Qué conservar y qué no hacer
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm font-medium leading-5 text-amber-900 dark:text-amber-200">
              <li>No borres el caché, no restablezcas datos y no reinstales antes de guardar el diagnóstico.</li>
              <li>Conserva el respaldo cifrado del panel superior junto con su frase: sin la frase no se puede abrir.</li>
              <li>No cierres PALMYRA mientras se restaura un respaldo.</li>
              <li>Si la copia en la nube está activa, conserva otra versión de tus datos: no la borres.</li>
            </ul>
          </div>
        </li>
      </ol>

      <p
        role="status"
        aria-live="polite"
        className="mt-2 flex min-h-6 items-start gap-1.5 break-words text-sm font-semibold text-emerald-700 dark:text-emerald-300"
      >
        {notice.startsWith("La base local respondió") && (
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        )}
        {notice.startsWith("La base local sigue") && (
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0">{notice}</span>
      </p>

      {manualText && (
        <div className="rounded-xl border border-base bg-secondary p-2">
          <p className="text-sm font-medium leading-5 text-muted">
            Selecciona el texto y cópialo a mano para enviarlo a soporte.
          </p>
          <textarea
            readOnly
            value={manualText}
            rows={12}
            aria-label="Diagnóstico en texto"
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full resize-y rounded-lg border border-base bg-primary p-2 font-mono text-[11px] leading-5 text-primary outline-none focus:ring-1 focus:ring-violet-500"
          />
        </div>
      )}
    </section>
  );
}
