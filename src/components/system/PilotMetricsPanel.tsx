import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Gauge,
  RefreshCw,
  ShieldAlert,
  Ticket
} from "lucide-react";
import { cn } from "../../lib/utils";
import { SYNC_LEDGER_EVENT } from "../../services/offline/syncLedger";
import {
  exportPilotMetrics,
  formatPilotMetricsText,
  readPilotMetrics,
  type PilotMetricsSnapshot,
  type PilotRequestLevel
} from "../../services/pilot/metrics";

/**
 * Métricas del piloto (F7-B).
 *
 * Solo lee registros locales ya existentes (cola offline, presupuesto F6,
 * ledger de sync, historial de actualizaciones y contador de tickets). No hace
 * ninguna petición de red ni escribe en la nube: abrir o refrescar el panel no
 * consume el presupuesto que está midiendo. "Exportar" descarga un JSON local.
 */

const LEVEL_LABEL: Record<PilotRequestLevel, string> = {
  ok: "Dentro del presupuesto",
  warn: "Cerca del presupuesto",
  over: "Presupuesto excedido"
};

const LEVEL_BADGES: Record<PilotRequestLevel, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  over: "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
};

function formatClock(value: string | null): string {
  if (!value) return "sin registros";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "sin registros";
  try {
    return new Intl.DateTimeFormat("es-CU", { dateStyle: "short", timeStyle: "short" }).format(
      new Date(ms)
    );
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatCycle(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "sin datos";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function formatDayLabel(day: string): string {
  try {
    return new Intl.DateTimeFormat("es-CU", { day: "2-digit", month: "2-digit" }).format(
      new Date(day + "T12:00:00")
    );
  } catch {
    return day.slice(5);
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Se intenta el respaldo sin interrumpir al usuario.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
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

/** Descarga local (Blob + enlace temporal). No hay red ni subida de datos. */
function downloadJson(filename: string, json: string): boolean {
  try {
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = "neutral"
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: "neutral" | "danger" | "ok";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-base bg-secondary p-2">
      <dt className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted">
        <span
          aria-hidden="true"
          className={cn(
            tone === "danger" ? "text-rose-500" : tone === "ok" ? "text-emerald-500" : "text-violet-500"
          )}
        >
          {icon}
        </span>
        {label}
      </dt>
      <dd className="mt-0.5 min-w-0 break-words text-sm font-black text-primary">{value}</dd>
      {hint ? <dd className="min-w-0 break-words text-[10px] font-semibold text-muted">{hint}</dd> : null}
    </div>
  );
}

export default function PilotMetricsPanel({ className }: { className?: string }) {
  const [snapshot, setSnapshot] = useState<PilotMetricsSnapshot>(() => readPilotMetrics());
  const [notice, setNotice] = useState("");
  const [manualText, setManualText] = useState("");

  const refresh = useCallback(() => {
    setSnapshot(readPilotMetrics());
    setNotice("");
    setManualText("");
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key || !event.key.startsWith("palmyra")) refresh();
    };
    // La cola y el ledger cambian el riesgo y la hora de sync sin recargar.
    window.addEventListener("storage", onStorage);
    window.addEventListener("offline_queue_updated", refresh);
    window.addEventListener(SYNC_LEDGER_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("offline_queue_updated", refresh);
      window.removeEventListener(SYNC_LEDGER_EVENT, refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const level = snapshot.requests.level;
  const percent = useMemo(
    () =>
      snapshot.requests.limit > 0
        ? Math.min(100, Math.round((snapshot.requests.total / snapshot.requests.limit) * 100))
        : 0,
    [snapshot.requests.total, snapshot.requests.limit]
  );
  const riskTone = snapshot.riskSales > 0 ? "danger" : "ok";
  const conflictTone = snapshot.conflicts > 0 ? "danger" : "ok";

  const handleCopy = async () => {
    const text = formatPilotMetricsText(snapshot);
    const copied = await copyToClipboard(text);
    if (copied) {
      setManualText("");
      setNotice("Informe del piloto copiado al portapapeles.");
      return;
    }
    setManualText(text);
    setNotice("El portapapeles no está disponible. Copia el texto de abajo.");
  };

  const handleDownload = () => {
    const { filename, json } = exportPilotMetrics(snapshot);
    if (downloadJson(filename, json)) {
      setNotice(`Archivo descargado: ${filename}`);
      return;
    }
    setManualText(json);
    setNotice("No se pudo descargar el archivo. Copia el JSON de abajo.");
  };

  return (
    <section
      className={cn("min-w-0 space-y-4 rounded-xl border border-base bg-primary p-3 sm:p-4", className)}
      aria-labelledby="pilot-metrics-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="pilot-metrics-title" className="flex items-center gap-2 text-sm font-black text-primary">
            <Gauge size={16} className="text-violet-600" aria-hidden="true" />
            Métricas del piloto
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Ventas en riesgo, conflictos, sincronización, solicitudes, actualizaciones y tickets de
            los últimos días. Solo lectura local: este panel no hace peticiones a la nube.
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black",
            LEVEL_BADGES[level]
          )}
        >
          {level === "ok" ? <CheckCircle2 size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
          {LEVEL_LABEL[level]}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <MetricCard
          label="Ventas en riesgo"
          value={String(snapshot.riskSales)}
          hint="Operaciones fallidas en cola + conflictos sin resolver"
          icon={<ShieldAlert size={13} />}
          tone={riskTone}
        />
        <MetricCard
          label="Conflictos"
          value={String(snapshot.conflicts)}
          hint="Operaciones que esperan revisión del operador"
          icon={<AlertTriangle size={13} />}
          tone={conflictTone}
        />
        <MetricCard
          label="Última sincronización"
          value={formatClock(snapshot.sync.lastPushAt)}
          hint={`Bajada ${formatClock(snapshot.sync.lastPullAt)} · ciclo ${formatCycle(snapshot.sync.lastCycleMs)}`}
          icon={<Clock size={13} />}
        />
        <div className="min-w-0 rounded-lg border border-base bg-secondary p-2">
          <dt className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted">
            <span aria-hidden="true" className="text-violet-500">
              <Gauge size={13} />
            </span>
            Solicitudes hoy
          </dt>
          <dd className="mt-0.5 text-sm font-black text-primary">
            {snapshot.requests.total}
            <span className="ml-1 text-[10px] font-bold text-muted">/ {snapshot.requests.limit}</span>
          </dd>
          <dd className="text-[10px] font-semibold text-muted">
            {snapshot.requests.errors} con error ·{" "}
            {snapshot.requests.averageLatencyMs === null
              ? "sin latencia"
              : `${snapshot.requests.averageLatencyMs} ms`}
          </dd>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle" role="presentation">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                level === "ok" ? "bg-emerald-500" : level === "warn" ? "bg-amber-500" : "bg-rose-500"
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
        <MetricCard
          label="Actualizaciones hoy"
          value={`${snapshot.updates.success} ok / ${snapshot.updates.failure} fallos`}
          hint={`Última ${snapshot.updates.lastVersion ?? "sin registros"} · ${formatClock(snapshot.updates.lastAt)}`}
          icon={<CheckCircle2 size={13} />}
          tone={snapshot.updates.failure > 0 ? "danger" : "neutral"}
        />
        <MetricCard
          label="Tickets de soporte"
          value={String(snapshot.tickets)}
          hint="Solicitudes creadas hoy desde la app"
          icon={<Ticket size={13} />}
        />
      </dl>

      <div>
        <h4 className="text-[11px] font-black uppercase tracking-wide text-muted">
          Últimos {snapshot.days.length} días
        </h4>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[11px]">
            <caption className="sr-only">Métricas del piloto por día</caption>
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                <th scope="col" className="py-1 pr-2 font-bold">Día</th>
                <th scope="col" className="py-1 pr-2 font-bold">Riesgo</th>
                <th scope="col" className="py-1 pr-2 font-bold">Conflictos</th>
                <th scope="col" className="py-1 pr-2 font-bold">Solicitudes</th>
                <th scope="col" className="py-1 pr-2 font-bold">Errores</th>
                <th scope="col" className="py-1 pr-2 font-bold">Act. ok</th>
                <th scope="col" className="py-1 pr-2 font-bold">Fallos</th>
                <th scope="col" className="py-1 font-bold">Tickets</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.days.map((day) => (
                <tr key={day.day} className="border-t border-base">
                  <th scope="row" className="py-1 pr-2 text-left font-bold text-primary">
                    {formatDayLabel(day.day)}
                  </th>
                  <td className={cn("py-1 pr-2 font-bold", day.riskSales > 0 ? "text-rose-600 dark:text-rose-300" : "text-muted")}>
                    {day.riskSales}
                  </td>
                  <td className={cn("py-1 pr-2 font-bold", day.conflicts > 0 ? "text-rose-600 dark:text-rose-300" : "text-muted")}>
                    {day.conflicts}
                  </td>
                  <td className="py-1 pr-2 font-bold text-primary">{day.requests}</td>
                  <td className={cn("py-1 pr-2 font-bold", day.requestErrors > 0 ? "text-amber-600 dark:text-amber-300" : "text-muted")}>
                    {day.requestErrors}
                  </td>
                  <td className="py-1 pr-2 font-bold text-emerald-700 dark:text-emerald-300">
                    {day.updatesSuccess}
                  </td>
                  <td className={cn("py-1 pr-2 font-bold", day.updatesFailure > 0 ? "text-rose-600 dark:text-rose-300" : "text-muted")}>
                    {day.updatesFailure}
                  </td>
                  <td className="py-1 font-bold text-primary">{day.tickets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] font-semibold text-muted">
          El riesgo se guarda como el peor momento observado del día; 0 significa que el panel no
          llegó a abrirse ese día.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={refresh}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-[11px] font-black text-primary hover:bg-subtle"
        >
          <RefreshCw size={14} aria-hidden="true" />Actualizar
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-[11px] font-black text-primary hover:bg-subtle"
        >
          <Copy size={14} aria-hidden="true" />Copiar
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="flex h-10 items-center gap-1.5 rounded-xl bg-violet-600 px-3 text-[11px] font-black text-white hover:bg-violet-700"
        >
          <Download size={14} aria-hidden="true" />Descargar JSON
        </button>
      </div>

      <p
        role="status"
        aria-live="polite"
        className="min-h-4 text-[11px] font-bold text-emerald-700 dark:text-emerald-300"
      >
        {notice}
      </p>
      {manualText ? (
        <textarea
          readOnly
          value={manualText}
          rows={8}
          aria-label="Métricas del piloto en texto"
          className="w-full resize-y rounded-xl border border-base bg-secondary p-2 text-[11px] font-mono text-primary"
        />
      ) : null}
    </section>
  );
}
