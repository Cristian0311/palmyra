import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Database,
  Download,
  HardDrive,
  HelpCircle,
  RefreshCw,
  ShieldCheck,
  XCircle
} from "lucide-react";
import { cn } from "../../lib/utils";
import { getNativeAppInfo } from "../../lib/nativeApp";
import { isAndroidBackupAvailable } from "../../services/localDb/backup/android";
import { androidSqliteBridgeAvailable } from "../../services/localDb/sqlite/androidAdapter";
import { formatStorageBytes } from "../../services/pwaStorageHealth";
import {
  androidDiagnosticsFileName,
  androidDiagnosticsJson,
  collectAndroidDiagnostics,
  type AndroidBridgeCheck,
  type AndroidDiagnosticsReport
} from "../../services/diagnostics/android";

/**
 * Diagnóstico in situ del APK Android.
 *
 * Solo se muestra dentro del APK (mismos puentes que usa el respaldo): en
 * navegador, PWA o escritorio no hay nada que diagnosticar. El informe nunca
 * incluye tokens, claves ni contenido de la base; solo estados y tamaños.
 */

type CheckTone = "ok" | "warn" | "fail";

interface CheckRow {
  id: string;
  label: string;
  detail: string;
  tone: CheckTone;
}

const TONE_LABELS: Record<CheckTone, string> = {
  ok: "Correcto",
  warn: "Aviso",
  fail: "Fallo"
};

function isAndroidRuntime(): boolean {
  try {
    if (isAndroidBackupAvailable()) return true;
    if (getNativeAppInfo()) return true;
    return androidSqliteBridgeAvailable();
  } catch {
    return false;
  }
}

function formatMoment(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function bridgeById(
  bridges: AndroidBridgeCheck[],
  id: AndroidBridgeCheck["id"]
): AndroidBridgeCheck | null {
  return bridges.find((bridge) => bridge.id === id) ?? null;
}

function bridgeRow(
  id: string,
  label: string,
  bridge: AndroidBridgeCheck | null
): CheckRow {
  const present = Boolean(bridge?.present);
  return {
    id,
    label,
    tone: present ? "ok" : "fail",
    detail: present
      ? bridge?.detail || "Presente."
      : "No disponible en este dispositivo."
  };
}

function buildChecks(report: AndroidDiagnosticsReport): CheckRow[] {
  const rows: CheckRow[] = [];

  const integrity = report.database.integrity;
  rows.push({
    id: "integrity",
    label: "Integridad de la base SQLite",
    tone: integrity === "ok" ? "ok" : integrity === "failed" ? "fail" : "warn",
    detail:
      integrity === "ok"
        ? "integrity_check: ok"
        : integrity === "failed"
          ? report.database.integrityDetail || "La base reportó errores de integridad."
          : "No se pudo comprobar: el puente no expone integrity()."
  });

  const hasCounts = report.database.sales !== null && report.database.products !== null;
  rows.push({
    id: "counts",
    label: "Contenido del almacén local",
    tone: hasCounts ? "ok" : "warn",
    detail: hasCounts
      ? `${report.database.sales} ventas · ${report.database.products} productos`
      : "Sin conteo: no hay accessor utilizable en este contexto."
  });

  rows.push(bridgeRow("db", "Base SQLite nativa (PALMYRA_DB)", bridgeById(report.bridges, "PALMYRA_DB")));
  rows.push(
    bridgeRow("keystore", "Cifrado del dispositivo (PALMYRA_KEYSTORE)", bridgeById(report.bridges, "PALMYRA_KEYSTORE"))
  );
  rows.push(
    bridgeRow("backup", "Respaldo en Descargas (PALMYRA_BACKUP)", bridgeById(report.bridges, "PALMYRA_BACKUP"))
  );
  rows.push(
    bridgeRow("native", "Shell de Android (PALMYRA_NATIVE)", bridgeById(report.bridges, "PALMYRA_NATIVE"))
  );

  const { usageBytes, quotaBytes, estimateSupported } = report.storage;
  const ratio = quotaBytes && usageBytes !== null ? usageBytes / quotaBytes : 0;
  rows.push({
    id: "storage",
    label: "Almacenamiento del dispositivo",
    tone: !estimateSupported ? "warn" : ratio >= 0.85 ? "warn" : "ok",
    detail: !estimateSupported
      ? "El sistema no informa el espacio usado (storage.estimate)."
      : `${formatStorageBytes(usageBytes ?? 0)} usados de ${formatStorageBytes(quotaBytes ?? 0)}${
          ratio > 0 ? ` (${Math.round(ratio * 100)} %)` : ""
        } · localStorage: ${report.storage.localStorageKeys} entradas (${formatStorageBytes(
          report.storage.localStorageBytes
        )})`
  });

  const backup = report.backup;
  rows.push({
    id: "backup",
    label: "Último respaldo",
    tone: backup.status === "ok" ? "ok" : backup.status === "missing" ? "warn" : "fail",
    detail:
      backup.status === "ok"
        ? `${formatMoment(backup.lastBackupAt)}${backup.location ? ` · ${backup.location}` : ""}`
        : backup.status === "error"
          ? backup.error || "El último intento terminó con error."
          : backup.status === "corrupt"
            ? "El estado guardado está corrupto; se reescribirá en el próximo intento."
            : "Sin respaldo registrado todavía."
  });

  rows.push({
    id: "versions",
    label: "Versiones",
    tone: report.versions.shell && report.versions.web ? "ok" : "warn",
    detail: `App ${report.versions.app} · Shell ${report.versions.shell || "—"} · Web ${
      report.versions.web || "—"
    } · OTA ${report.versions.ota ? "sí" : "no"}`
  });

  return rows;
}

function toneIcon(tone: CheckTone) {
  if (tone === "ok") return CheckCircle2;
  if (tone === "fail") return XCircle;
  return AlertTriangle;
}

function toneClasses(tone: CheckTone): { icon: string; badge: string } {
  switch (tone) {
    case "ok":
      return {
        icon: "text-emerald-600 dark:text-emerald-400",
        badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      };
    case "fail":
      return {
        icon: "text-rose-600 dark:text-rose-400",
        badge: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
      };
    default:
      return {
        icon: "text-amber-600 dark:text-amber-400",
        badge: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
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

export default function AndroidDiagnostics() {
  const [available] = useState(isAndroidRuntime);
  const [report, setReport] = useState<AndroidDiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualJson, setManualJson] = useState("");

  const refresh = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    setError(null);
    setManualJson("");
    try {
      setReport(await collectAndroidDiagnostics());
    } catch {
      // collectAndroidDiagnostics no lanza; esto cubre fallos inesperados del
      // entorno (memoria, permisos) sin dejar la tarjeta en blanco.
      setError("No se pudo generar el diagnóstico. Inténtalo de nuevo.");
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    if (available) void refresh();
  }, [available, refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const checks = useMemo(() => (report ? buildChecks(report) : []), [report]);
  const overall: CheckTone = useMemo(() => {
    if (!report) return "warn";
    if (checks.some((check) => check.tone === "fail")) return "fail";
    if (checks.some((check) => check.tone === "warn")) return "warn";
    return "ok";
  }, [checks, report]);

  const handleCopy = async () => {
    if (!report) return;
    const text = androidDiagnosticsJson(report);
    const copied = await copyToClipboard(text);
    if (copied) {
      setNotice("JSON copiado al portapapeles.");
      setManualJson("");
      return;
    }
    setManualJson(text);
    setNotice("El portapapeles no está disponible. Copia el texto de abajo.");
  };

  const handleDownload = () => {
    if (!report) return;
    try {
      const fileName = androidDiagnosticsFileName(report.generatedAt);
      const blob = new Blob([androidDiagnosticsJson(report)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Descargado ${fileName}.`);
      setError(null);
    } catch {
      setError("No se pudo descargar el archivo. Revisa el permiso de almacenamiento.");
    }
  };

  if (!available) return null;

  const overallClasses = toneClasses(overall);
  const overallLabel =
    overall === "ok" ? "Todo correcto" : overall === "fail" ? "Con fallos" : "Revisar avisos";

  return (
    <section
      aria-labelledby="android-diagnostics-title"
      className="rounded-xl border border-base bg-primary p-3 space-y-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="android-diagnostics-title"
            className="flex items-center gap-2 text-sm font-bold text-primary"
          >
            <Activity size={15} className="text-violet-600" aria-hidden="true" />
            Diagnóstico de Android
          </h3>
          <p className="text-sm font-medium text-muted">
            Puentes, base local y respaldo de esta tablet, sin PC.
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
                : overall === "fail"
                  ? "bg-rose-500"
                  : "bg-amber-500"
            )}
          />
          {loading ? "Comprobando…" : overallLabel}
        </span>
      </div>

      {report && (
        <p className="text-sm font-medium text-muted">
          Generado {formatMoment(report.generatedAt)} · {report.platform.name}
        </p>
      )}

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
          Leyendo puentes, base local y respaldo…
        </p>
      )}

      {checks.length > 0 && (
        <ul className="space-y-1.5" aria-label="Comprobaciones del diagnóstico">
          {checks.map((check) => {
            const Icon = toneIcon(check.tone);
            const classes = toneClasses(check.tone);
            return (
              <li
                key={check.id}
                className="flex items-start gap-2 rounded-lg border border-base bg-secondary p-2"
              >
                <Icon size={15} className={cn("mt-0.5 shrink-0", classes.icon)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-primary">{check.label}</p>
                  <p className="break-words text-sm font-medium leading-5 text-muted">{check.detail}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-sm font-semibold",
                    classes.badge
                  )}
                >
                  {TONE_LABELS[check.tone]}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {report && report.notes.length > 0 && (
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

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-busy={loading}
          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(loading && "animate-spin")} aria-hidden="true" />
          {loading ? "Actualizando…" : "Actualizar diagnóstico"}
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!report || loading}
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
        >
          <Copy size={15} aria-hidden="true" /> Copiar JSON
        </button>
        <button
          type="button"
          onClick={handleDownload}
          disabled={!report || loading}
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
        >
          <Download size={15} aria-hidden="true" /> Descargar JSON
        </button>
      </div>

      <p role="status" aria-live="polite" className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
        {notice ?? ""}
      </p>

      {manualJson && (
        <div className="rounded-xl border border-base bg-secondary p-2">
          <p className="text-sm font-medium leading-5 text-muted">
            Selecciona el texto y cópialo a mano (el portapapeles no está disponible).
          </p>
          <textarea
            readOnly
            value={manualJson}
            rows={12}
            aria-label="Diagnóstico de Android en JSON"
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full resize-y rounded-lg border border-base bg-primary p-2 font-mono text-[11px] leading-5 text-primary outline-none focus:ring-1 focus:ring-violet-500"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm font-medium text-muted">
        <span className="inline-flex items-center gap-1">
          <Database size={13} aria-hidden="true" /> Base local en este dispositivo
        </span>
        <span className="inline-flex items-center gap-1">
          <HardDrive size={13} aria-hidden="true" /> Espacio del sistema
        </span>
        <span className="inline-flex items-center gap-1">
          <ShieldCheck size={13} aria-hidden="true" /> Sin tokens ni claves en el informe
        </span>
      </div>
    </section>
  );
}
