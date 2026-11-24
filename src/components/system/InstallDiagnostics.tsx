import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Globe,
  HardDrive,
  HelpCircle,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Wrench,
  XCircle
} from "lucide-react";
import { cn } from "../../lib/utils";
import { formatStorageBytes } from "../../services/pwaStorageHealth";
import {
  INSTALL_ERROR_KEY,
  collectInstallDiagnostics,
  downloadInstallDiagnostics,
  formatInstallDiagnostics,
  installSurfaceLabel,
  recordInstallError,
  type InstallCheckState,
  type InstallDiagnosticsReport
} from "../../services/diagnostics/install";
import {
  collectLastBackupState,
  collectLocalDbState
} from "../../services/diagnostics/localState";

/**
 * Diagnóstico de instalación para Administración avanzada.
 *
 * Sirve a las tres superficies (web, APK Android y escritorio Windows): muestra
 * qué está instalado, de dónde se actualiza, el estado del service worker, las
 * cachés, el servidor local y el último error. El informe solo lleva estados,
 * versiones y tamaños; nunca tokens, claves ni valores de almacenamiento.
 *
 * «Reparar instalación» es destructivo para el shell web: borra cachés, anula
 * los service workers y recarga. No toca la base local. Si algo falla, se
 * muestra el error y no se afirma que la reparación fue correcta.
 */

const STATE_LABELS: Record<InstallCheckState, string> = {
  ok: "Correcto",
  warn: "Aviso",
  error: "Fallo",
  unknown: "Sin datos"
};

const SURFACE_ICONS = {
  web: Globe,
  android: Smartphone,
  windows: Monitor,
  unknown: HelpCircle
} as const;

function formatMoment(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function stateIcon(state: InstallCheckState) {
  if (state === "ok") return CheckCircle2;
  if (state === "error") return XCircle;
  if (state === "warn") return AlertTriangle;
  return HelpCircle;
}

function stateClasses(state: InstallCheckState): { icon: string; badge: string } {
  switch (state) {
    case "ok":
      return {
        icon: "text-emerald-600 dark:text-emerald-400",
        badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      };
    case "error":
      return {
        icon: "text-rose-600 dark:text-rose-400",
        badge: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
      };
    case "warn":
      return {
        icon: "text-amber-600 dark:text-amber-400",
        badge: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      };
    default:
      return {
        icon: "text-slate-500 dark:text-slate-400",
        badge: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
      };
  }
}

/** Copia con la API moderna y, si no existe o falla, con el fallback clásico. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Se intenta el fallback sin interrumpir al usuario.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function SummaryRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-base bg-secondary p-2">
      <dt className="shrink-0 text-sm font-semibold text-muted">{term}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-semibold text-primary">{children}</dd>
    </div>
  );
}

export default function InstallDiagnostics() {
  const [report, setReport] = useState<InstallDiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setManualText("");
    try {
      // Base local y último respaldo son estados ya existentes en la app: se
      // miden aparte y se inyectan para que el informe exportado los lleve.
      const [localDb, lastBackup] = await Promise.all([
        collectLocalDbState(),
        collectLastBackupState()
      ]);
      setReport(await collectInstallDiagnostics({ localDb, lastBackup }));
    } catch {
      // collectInstallDiagnostics no lanza; esto cubre fallos inesperados del
      // entorno sin dejar la tarjeta en blanco.
      setError("No se pudo generar el diagnóstico de instalación. Inténtalo de nuevo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const checks = report?.checks ?? [];
  const overall: InstallCheckState = useMemo(() => {
    if (!report) return "unknown";
    if (checks.some((check) => check.state === "error")) return "error";
    if (checks.some((check) => check.state === "warn")) return "warn";
    if (checks.some((check) => check.state === "unknown")) return "unknown";
    return "ok";
  }, [checks, report]);

  const overallLabel =
    overall === "ok"
      ? "Todo correcto"
      : overall === "error"
        ? "Con fallos"
        : overall === "warn"
          ? "Revisar avisos"
          : "Sin datos";

  const handleCopy = async () => {
    if (!report) return;
    const text = formatInstallDiagnostics(report);
    const copied = await copyToClipboard(text);
    if (copied) {
      setNotice("Informe copiado al portapapeles.");
      setManualText("");
      return;
    }
    setManualText(text);
    setNotice("El portapapeles no está disponible. Copia el texto de abajo.");
  };

  const handleDownload = () => {
    if (!report) return;
    const result = downloadInstallDiagnostics(report);
    if (result.ok) {
      setNotice(`Descargado ${result.fileName}.`);
      setError(null);
      return;
    }
    // Sin descarga (almacenamiento bloqueado, entorno sin ventana) el informe
    // sigue disponible como texto para copiarlo a mano.
    setError("No se pudo descargar el archivo. Revisa el permiso de almacenamiento.");
    setManualText(formatInstallDiagnostics(report));
  };

  /**
   * Reparación: cachés, service workers y último error. La base local no se
   * toca. Cada paso se intenta por separado para informar exactamente qué
   * falló; sin pasos fallidos se recarga la app.
   */
  const handleRepair = async () => {
    if (repairing) return;
    const confirmed =
      typeof window !== "undefined" &&
      window.confirm(
        "¿Reparar la instalación? Se borrarán los cachés y el service worker, y la aplicación se recargará. Los datos locales (ventas, inventario y configuración) no se tocan."
      );
    if (!confirmed) return;

    setRepairing(true);
    setRepairError(null);
    setNotice("Reparando instalación…");
    const failures: string[] = [];
    let deletedCaches = 0;

    if (typeof caches !== "undefined" && typeof caches.delete === "function") {
      try {
        const names = await caches.keys();
        for (const name of names) {
          if (await caches.delete(name)) deletedCaches += 1;
        }
      } catch {
        failures.push("No se pudieron borrar los cachés de la aplicación.");
      }
    }

    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      try {
        const container = navigator.serviceWorker;
        const registrations = container.getRegistrations
          ? await container.getRegistrations()
          : [await container.getRegistration()].filter(
              (registration): registration is ServiceWorkerRegistration => Boolean(registration)
            );
        for (const registration of registrations) {
          const removed = await registration.unregister();
          if (!removed) failures.push("Un service worker no pudo anularse.");
        }
      } catch {
        failures.push("No se pudieron anular los service workers.");
      }
    }

    try {
      localStorage.removeItem(INSTALL_ERROR_KEY);
    } catch {
      failures.push(`No se pudo borrar la entrada ${INSTALL_ERROR_KEY}.`);
    }

    setRepairing(false);

    if (failures.length > 0) {
      // El fallo queda como último error para que el próximo informe lo muestre.
      recordInstallError(`Reparación incompleta: ${failures.join(" ")}`);
      setRepairError(failures.join(" "));
      setNotice("La reparación quedó incompleta: revisa los mensajes.");
      void refresh();
      return;
    }

    setNotice(
      `${deletedCaches > 0 ? `${deletedCaches} caché(s) eliminados. ` : ""}Instalación reparada. Recargando…`
    );
    window.setTimeout(() => {
      try {
        window.location.reload();
      } catch {
        setError("No se pudo recargar la aplicación. Ciérrala y vuelve a abrirla.");
      }
    }, 400);
  };

  const SurfaceIcon = SURFACE_ICONS[report?.surface ?? "unknown"];
  const overallClasses = stateClasses(overall);

  return (
    <section
      aria-labelledby="install-diagnostics-title"
      className="rounded-xl border border-base bg-primary p-3 space-y-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="install-diagnostics-title"
            className="flex items-center gap-2 text-sm font-bold text-primary"
          >
            <Activity size={15} className="text-violet-600" aria-hidden="true" />
            Diagnóstico de instalación
          </h3>
          <p className="text-sm font-medium text-muted">
            Versión, origen de la actualización, base local, último respaldo, cachés y servidor
            local. El archivo se guarda como texto plano.
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sm font-semibold",
            overallClasses.badge
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              overall === "ok"
                ? "bg-emerald-500"
                : overall === "error"
                  ? "bg-rose-500"
                  : overall === "warn"
                    ? "bg-amber-500"
                    : "bg-slate-400"
            )}
          />
          {loading ? "Comprobando…" : overallLabel}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium leading-6 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200"
        >
          <p className="flex min-w-0 flex-1 items-start gap-2">
            <AlertTriangle size={15} className="mt-1 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="h-11 rounded-lg border border-rose-300 px-3 text-sm font-semibold text-rose-800 transition-colors hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900/50 dark:text-rose-200 dark:hover:bg-rose-950/40"
          >
            Reintentar
          </button>
        </div>
      )}

      {loading && !report && (
        <p role="status" aria-live="polite" className="text-sm font-medium text-muted">
          Leyendo superficie, cachés y servidor local…
        </p>
      )}

      {report && (
        <>
          <dl className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
            <SummaryRow term="Superficie">
              <span className="inline-flex items-center justify-end gap-1.5">
                <SurfaceIcon size={14} aria-hidden="true" />
                {installSurfaceLabel(report.surface)}
              </span>
            </SummaryRow>
            <SummaryRow term="Versión">{report.version}</SummaryRow>
            <SummaryRow term="Origen de actualización">
              <span className="break-all">{report.updateOrigin}</span>
            </SummaryRow>
            <SummaryRow term="Service worker">
              {report.serviceWorker.registered
                ? `Registrado${report.serviceWorker.state ? ` · ${report.serviceWorker.state}` : ""}`
                : "No registrado"}
            </SummaryRow>
            <SummaryRow term="Cachés">
              {report.caches.length > 0
                ? `${report.caches.length} ${report.caches.length === 1 ? "caché" : "cachés"}`
                : "Ninguna"}
            </SummaryRow>
            <SummaryRow term="Servidor local">
              {report.localServer.state === "ready"
                ? "Listo"
                : report.localServer.state === "error"
                  ? "Con error"
                  : "Sin datos"}
            </SummaryRow>
            <SummaryRow term="Último error">
              {report.lastError
                ? `${report.lastError.message} (${formatMoment(report.lastError.at)})`
                : "Sin errores registrados"}
            </SummaryRow>
            <SummaryRow term="Almacenamiento">
              {report.storage
                ? `${formatStorageBytes(report.storage.usage ?? 0)} de ${formatStorageBytes(
                    report.storage.quota ?? 0
                  )}`
                : "No disponible"}
            </SummaryRow>
            <SummaryRow term="Base local">
              {report.localDb
                ? [
                    report.localDb.state === "ready" ? "Lista" : "Con fallo",
                    report.localDb.driver,
                    report.localDb.schemaVersion ? `esquema v${report.localDb.schemaVersion}` : "",
                    report.localDb.sizeBytes ? formatStorageBytes(report.localDb.sizeBytes) : ""
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "No incluida"}
            </SummaryRow>
            <SummaryRow term="Último respaldo">
              {report.lastBackup && report.lastBackup.at
                ? `${formatMoment(report.lastBackup.at)} · ${
                    report.lastBackup.status === "ok" ? "correcto" : "con fallo"
                  }`
                : "Sin respaldos registrados"}
            </SummaryRow>
            <SummaryRow term="Generado">{formatMoment(report.generatedAt)}</SummaryRow>
          </dl>

          {checks.length > 0 && (
            <ul className="space-y-1.5" aria-label="Comprobaciones de la instalación">
              {checks.map((check) => {
                const Icon = stateIcon(check.state);
                const classes = stateClasses(check.state);
                return (
                  <li
                    key={check.id}
                    className="flex items-start gap-2 rounded-lg border border-base bg-secondary p-2"
                  >
                    <Icon
                      size={15}
                      className={cn("mt-0.5 shrink-0", classes.icon)}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-primary">{check.label}</p>
                      <p className="break-words text-sm font-medium leading-5 text-muted">
                        {check.detail}
                      </p>
                    </div>
                    <span
                      className={cn("shrink-0 rounded-full px-2 py-0.5 text-sm font-semibold", classes.badge)}
                    >
                      {STATE_LABELS[check.state]}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {report.notes.length > 0 && (
            <div className="rounded-lg border border-base bg-secondary p-2">
              <h4 className="flex items-center gap-1.5 text-sm font-bold text-primary">
                <HelpCircle size={14} aria-hidden="true" /> Notas
              </h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm font-medium leading-5 text-muted">
                {report.notes.map((note) => (
                  <li key={note} className="break-words">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || repairing}
          aria-busy={loading}
          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(loading && "animate-spin")} aria-hidden="true" />
          {loading ? "Actualizando…" : "Actualizar diagnóstico"}
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!report || loading || repairing}
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
        >
          <Copy size={15} aria-hidden="true" /> Copiar informe
        </button>
        <button
          type="button"
          onClick={handleDownload}
          disabled={!report || loading || repairing}
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
        >
          <Download size={15} aria-hidden="true" /> Descargar informe
        </button>
        <button
          type="button"
          onClick={() => void handleRepair()}
          disabled={repairing || loading}
          aria-busy={repairing}
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-300 dark:hover:bg-rose-950/40"
        >
          <Wrench size={15} aria-hidden="true" />
          {repairing ? "Reparando…" : "Reparar instalación"}
        </button>
      </div>

      {repairError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium leading-6 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200"
        >
          <AlertTriangle size={15} className="mt-1 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{repairError}</span>
        </div>
      )}

      <p role="status" aria-live="polite" className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
        {notice ?? ""}
      </p>

      {manualText && (
        <div className="rounded-xl border border-base bg-secondary p-2">
          <p className="text-sm font-medium leading-5 text-muted">
            Selecciona el texto y cópialo a mano (el portapapeles no está disponible).
          </p>
          <textarea
            readOnly
            value={manualText}
            rows={12}
            aria-label="Diagnóstico de instalación en texto"
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full resize-y rounded-lg border border-base bg-primary p-2 font-mono text-[11px] leading-5 text-primary outline-none focus:ring-1 focus:ring-violet-500"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm font-medium text-muted">
        <span className="inline-flex items-center gap-1">
          <HardDrive size={13} aria-hidden="true" /> Cachés y espacio del sistema
        </span>
        <span className="inline-flex items-center gap-1">
          <ShieldCheck size={13} aria-hidden="true" /> Sin tokens, claves ni valores guardados
        </span>
      </div>
    </section>
  );
}
