import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Gauge,
  RefreshCw,
  ServerOff,
  XCircle
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  classifyRequestBudget,
  formatRequestBudget,
  readRequestBudget,
  type RequestBudgetLevel,
  type RequestBudgetSnapshot
} from "../../services/requestBudget";

/**
 * Presupuesto diario de solicitudes a la nube (F6).
 *
 * Solo lee el registro local que alimenta `recordRequest`: no hace ninguna
 * petición de red, así que abrir o refrescar esta tarjeta nunca consume el
 * presupuesto que está midiendo. El límite depende del número de equipos
 * (1 equipo < 100/día, varios equipos < 500/día).
 */

const DEVICES_STORAGE_KEY = "palmyra:devices-count";
const DEVICE_OPTIONS = [1, 5] as const;
const TOP_ROUTES = 8;
const WEEK_DAYS = 7;

type DeviceCount = (typeof DEVICE_OPTIONS)[number];

function readDeviceCount(): DeviceCount {
  try {
    if (typeof localStorage === "undefined") return 1;
    return localStorage.getItem(DEVICES_STORAGE_KEY) === "5" ? 5 : 1;
  } catch {
    return 1;
  }
}

function saveDeviceCount(count: DeviceCount): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(DEVICES_STORAGE_KEY, String(count));
  } catch {
    // Sin almacenamiento la selección solo dura la sesión.
  }
}

const LEVEL_LABEL: Record<RequestBudgetLevel, string> = {
  ok: "Dentro del presupuesto",
  warn: "Cerca del presupuesto",
  over: "Presupuesto excedido"
};

const LEVEL_CLASSES: Record<RequestBudgetLevel, { badge: string; bar: string; icon: typeof CheckCircle2 }> = {
  ok: { badge: "bg-emerald-100 text-emerald-800", bar: "bg-emerald-500", icon: CheckCircle2 },
  warn: { badge: "bg-amber-100 text-amber-800", bar: "bg-amber-500", icon: AlertTriangle },
  over: { badge: "bg-rose-100 text-rose-800", bar: "bg-rose-500", icon: XCircle }
};

function formatClock(at: number | null): string {
  if (!at || !Number.isFinite(at)) return "sin registros";
  try {
    return new Intl.DateTimeFormat("es-CU", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
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
    // Se intenta el fallback sin interrumpir al usuario.
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

function buildReport(snapshot: RequestBudgetSnapshot, devices: DeviceCount): string {
  const { level, limit } = classifyRequestBudget(snapshot.total, devices);
  const lines = [
    `Presupuesto de solicitudes a la nube · ${snapshot.day}`,
    formatRequestBudget(snapshot, devices),
    `Nivel: ${LEVEL_LABEL[level]} (límite ${limit}/día para ${devices} equipo(s))`,
    `Errores: ${snapshot.errors} · Límite: ${limit}`,
    ""
  ];
  const routes = Object.entries(snapshot.byRoute).slice(0, TOP_ROUTES);
  if (routes.length) {
    lines.push("Rutas (hoy):");
    for (const [route, count] of routes) lines.push(`- ${route}: ${count}`);
  } else {
    lines.push("Rutas (hoy): sin registros");
  }
  lines.push("", `Últimos ${WEEK_DAYS} días:`);
  for (const day of snapshot.days.slice(-WEEK_DAYS)) {
    lines.push(`- ${day.day}: ${day.total} solicitudes, ${day.errors} con error`);
  }
  return lines.join("\n");
}

export default function RequestBudgetPanel() {
  const [snapshot, setSnapshot] = useState<RequestBudgetSnapshot>(() => readRequestBudget());
  const [devices, setDevices] = useState<DeviceCount>(() => readDeviceCount());
  const [notice, setNotice] = useState("");
  const [manualText, setManualText] = useState("");

  const refresh = useCallback(() => {
    setSnapshot(readRequestBudget());
    setNotice("");
    setManualText("");
  }, []);

  useEffect(() => {
    // El registro vive en localStorage; otra pestaña puede actualizarlo.
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith("palmyra:request-budget")) setSnapshot(readRequestBudget());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const { level, limit } = useMemo(
    () => classifyRequestBudget(snapshot.total, devices),
    [snapshot.total, devices]
  );
  const styles = LEVEL_CLASSES[level];
  const LevelIcon = styles.icon;
  const percent = limit > 0 ? Math.min(100, Math.round((snapshot.total / limit) * 100)) : 0;
  const topRoutes = useMemo(
    () => Object.entries(snapshot.byRoute).sort((a, b) => b[1] - a[1]).slice(0, TOP_ROUTES),
    [snapshot.byRoute]
  );
  const history = useMemo(() => snapshot.days.slice(-WEEK_DAYS), [snapshot.days]);
  const historyPeak = useMemo(
    () => history.reduce((max, day) => Math.max(max, day.total), 1),
    [history]
  );

  const selectDevices = (count: DeviceCount) => {
    setDevices(count);
    saveDeviceCount(count);
  };

  const handleCopy = async () => {
    const text = buildReport(snapshot, devices);
    const copied = await copyToClipboard(text);
    if (copied) {
      setManualText("");
      setNotice("Informe copiado al portapapeles.");
      return;
    }
    setManualText(text);
    setNotice("El portapapeles no está disponible. Copia el texto de abajo.");
  };

  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-base bg-primary p-3 sm:p-4" aria-labelledby="request-budget-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="request-budget-title" className="flex items-center gap-2 text-sm font-black text-primary">
            <Gauge size={16} className="text-violet-600" />
            Presupuesto de solicitudes a la nube
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Cada llamada medida del día (licencia, nube, aprobación de planes). La operación de
            negocio va por el hub LAN y no se cuenta aquí. Solo lectura local: este panel no hace
            peticiones.
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black", styles.badge)}
        >
          <LevelIcon size={13} />
          {LEVEL_LABEL[level]}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold text-muted">Equipos del negocio</span>
        <div className="flex overflow-hidden rounded-xl border border-base" role="group" aria-label="Cantidad de equipos">
          {DEVICE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => selectDevices(option)}
              aria-pressed={devices === option}
              className={cn(
                "h-9 px-3 text-[11px] font-black transition",
                devices === option ? "bg-violet-600 text-white" : "bg-secondary text-muted hover:text-primary"
              )}
            >
              {option === 1 ? "1 equipo" : `${option} equipos`}
            </button>
          ))}
        </div>
        <span className="text-[11px] font-semibold text-muted">límite {limit}/día</span>
      </div>

      <div>
        <div className="flex items-end justify-between gap-2">
          <p className="text-2xl font-black leading-none text-primary">
            {snapshot.total}
            <span className="ml-1 text-xs font-bold text-muted">/ {limit} solicitudes hoy</span>
          </p>
          <span className="text-[11px] font-bold text-muted">{percent}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-subtle" role="presentation">
          <div className={cn("h-full rounded-full transition-all", styles.bar)} style={{ width: `${percent}%` }} />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-muted">Errores</dt>
          <dd className="mt-0.5 flex items-center gap-1 text-sm font-black text-primary">
            {snapshot.errors > 0 ? <ServerOff size={13} className="text-rose-500" /> : <Activity size={13} className="text-emerald-500" />}
            {snapshot.errors}
          </dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-muted">Latencia media</dt>
          <dd className="mt-0.5 text-sm font-black text-primary">
            {snapshot.averageLatencyMs === null ? "sin datos" : `${snapshot.averageLatencyMs} ms`}
          </dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-muted">Última solicitud</dt>
          <dd className="mt-0.5 text-sm font-black text-primary">{formatClock(snapshot.lastAt)}</dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-muted">Rutas medidas</dt>
          <dd className="mt-0.5 text-sm font-black text-primary">{Object.keys(snapshot.byRoute).length}</dd>
        </div>
      </dl>

      <div>
        <h4 className="text-[11px] font-black uppercase tracking-wide text-muted">Rutas con más solicitudes (hoy)</h4>
        {topRoutes.length === 0 ? (
          <p className="mt-1 text-xs font-semibold text-muted">Sin solicitudes registradas hoy.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {topRoutes.map(([route, count]) => {
              const share = snapshot.total > 0 ? Math.round((count / snapshot.total) * 100) : 0;
              return (
                <li key={route} className="flex min-w-0 items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-bold text-primary" title={route}>{route}</span>
                  <span className="w-20 shrink-0 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
                    <span className="block h-1.5 rounded-full bg-violet-500" style={{ width: `${Math.max(4, share)}%` }} />
                  </span>
                  <span className="w-14 shrink-0 text-right font-bold text-muted">{count} · {share}%</span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-[10px] font-semibold text-muted">
          Errores y latencia se miden por día, no por ruta; el detalle por ruta es el volumen.
        </p>
      </div>

      <div>
        <h4 className="text-[11px] font-black uppercase tracking-wide text-muted">Últimos {WEEK_DAYS} días</h4>
        {history.length === 0 ? (
          <p className="mt-1 text-xs font-semibold text-muted">Todavía no hay historial local.</p>
        ) : (
          <ul className="mt-2 flex items-end gap-1.5" aria-label="Solicitudes por día">
            {history.map((day) => {
              const barHeight = Math.max(4, Math.round((day.total / historyPeak) * 48));
              return (
                <li key={day.day} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  <span
                    className={cn("w-full rounded-t", day.errors > 0 ? "bg-rose-500/80" : "bg-violet-500/80")}
                    style={{ height: barHeight, width: "100%" }}
                    title={`${day.day}: ${day.total} solicitudes, ${day.errors} con error`}
                    aria-hidden="true"
                  />
                  <span className="text-[9px] font-bold text-muted">{day.total}</span>
                  <span className="text-[9px] font-semibold text-muted">{formatDayLabel(day.day)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={refresh}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-[11px] font-black text-primary hover:bg-subtle"
        >
          <RefreshCw size={14} />Actualizar
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-[11px] font-black text-primary hover:bg-subtle"
        >
          <Copy size={14} />Copiar informe
        </button>
      </div>

      <p role="status" aria-live="polite" className="min-h-4 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
        {notice}
      </p>
      {manualText ? (
        <textarea
          readOnly
          value={manualText}
          rows={8}
          aria-label="Informe del presupuesto de solicitudes"
          className="w-full resize-y rounded-xl border border-base bg-secondary p-2 text-[11px] font-mono text-primary"
        />
      ) : null}
    </section>
  );
}
