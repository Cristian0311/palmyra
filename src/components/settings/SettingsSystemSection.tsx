import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  HardDrive,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
  TriangleAlert
} from "lucide-react";
import { useStore } from "../../store/useStore";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import { PRODUCT_DISPLAY_VERSION, PRODUCT_VERSION } from "../../lib/productVersion";
import { isPalmyraApp } from "../../lib/install";
import { cn } from "../../lib/utils";
import { useAppUpdateRuntime } from "../../hooks/useAppUpdateRuntime";
import { useDesktopUpdate } from "../../hooks/useDesktopUpdate";
import { useLicenseRuntime } from "../../hooks/useLicenseRuntime";
import { applyAndroidUpdate } from "../../services/updates/android";
import { androidUpdateKindForArtifact, type AppUpdatePhase } from "../../services/updates/runtime";
import type { LicensePublicMode } from "../../services/license/runtime";
import {
  formatStorageBytes,
  inspectPwaStorageHealth,
  type PwaStorageHealth
} from "../../services/pwaStorageHealth";

/**
 * Sección «Sistema» de Configuración.
 *
 * Reúne lo que describe a ESTE equipo y a la instalación: versión visible y
 * build, comprobación de actualizaciones (mismo runtime que los avisos
 * automáticos), estado de la licencia en lenguaje llano y almacenamiento
 * local. No muestra UUID, tokens ni mensajes técnicos.
 */

/** Superficie real, detectada igual que el aviso público de actualizaciones. */
const ANDROID_SHELL = isPalmyraApp();
const DESKTOP_SHELL =
  !ANDROID_SHELL && typeof navigator !== "undefined" && /\bElectron\//i.test(navigator.userAgent);
const SURFACE_LABEL = ANDROID_SHELL ? "Android" : DESKTOP_SHELL ? "Windows (escritorio)" : "Web";

const APPLY_WATCHDOG_MS = 3 * 60_000;

type Tone = "ok" | "warn" | "bad" | "idle";

const TONES: Record<Tone, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  bad: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  idle: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
};

const PHASE_COPY: Record<AppUpdatePhase, { label: string; tone: Tone }> = {
  unconfigured: { label: "Sin canal de actualizaciones en esta instalación", tone: "idle" },
  idle: { label: "Sin comprobar todavía", tone: "idle" },
  checking: { label: "Comprobando…", tone: "idle" },
  available: { label: "Hay una versión nueva", tone: "warn" },
  "up-to-date": { label: "Ya tienes la última versión", tone: "ok" },
  blocked: { label: "La comprobación no está disponible ahora", tone: "bad" },
  unverified: { label: "No se pudo verificar la actualización publicada", tone: "warn" },
  error: { label: "No se pudo comprobar; inténtalo más tarde", tone: "bad" }
};

function desktopCopy(status: string, percent: number): { label: string; tone: Tone } {
  switch (status) {
    case "checking": return { label: "Comprobando…", tone: "idle" };
    case "available": return { label: "Preparando la descarga…", tone: "warn" };
    case "downloading": return { label: `Descargando actualización ${percent}%…`, tone: "warn" };
    case "downloaded": return { label: "Actualización lista para instalar", tone: "warn" };
    case "not-available": return { label: "Ya tienes la última versión", tone: "ok" };
    case "blocked": return { label: "La descarga está bloqueada; vuelve a intentarlo", tone: "bad" };
    case "error": return { label: "No se pudo completar la actualización", tone: "bad" };
    case "unsupported": return { label: "Esta instalación no permite actualizar desde la app", tone: "idle" };
    default: return { label: "Sin comprobar todavía", tone: "idle" };
  }
}

function formatDay(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return date.toLocaleDateString("es-CU", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}

function formatMoment(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString("es-CU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
}

function daysUntil(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((date.getTime() - nowMs) / 86_400_000);
}

type LicenseState = { label: string; tone: Tone };

/** Estado de licencia en palabras: activa / por vencer / solo lectura. */
function licenseStateOf(
  mode: LicensePublicMode,
  readOnly: boolean,
  paidThrough: string | undefined,
  offlineUntil: string | undefined
): LicenseState {
  if (readOnly || mode === "expired" || mode === "revoked") {
    return { label: "Solo lectura", tone: "bad" };
  }
  // Lease ilegible/alterado: NO bloquea; se repara solo con conexión.
  if (mode === "invalid") return { label: "Por revisar", tone: "warn" };
  if (mode === "loading") return { label: "Comprobando…", tone: "idle" };
  if (mode === "free" || mode === "unmanaged") return { label: "Activa", tone: "ok" };
  const now = Date.now();
  const offlineDays = daysUntil(offlineUntil, now);
  const paidDays = daysUntil(paidThrough, now);
  const soon =
    mode === "grace" ||
    (offlineDays !== null && offlineDays <= 7) ||
    (paidDays !== null && paidDays <= 7);
  return soon ? { label: "Por vencer", tone: "warn" } : { label: "Activa", tone: "ok" };
}

function licenseModeLabel(mode: LicensePublicMode, pendingActivation: boolean): string {
  // Primer arranque del equipo: aún no llega el lease del plan; NO llamar "Gratis".
  if (pendingActivation) return "Activación pendiente";
  switch (mode) {
    case "free": return "Gratis";
    case "active": return "Pagado";
    case "grace": return "Pagado (periodo de gracia)";
    case "expired": return "Pagado, vencido";
    case "revoked": return "Licencia retirada";
    case "invalid": return "Licencia no válida";
    case "unmanaged": return "Gratis";
    default: return "Comprobando…";
  }
}

type BuildInfo = { buildId: string; builtAt: string; version: string } | null;

/** Metadatos del build publicado; si no responde, la sección sigue funcionando. */
async function fetchBuildInfo(): Promise<BuildInfo> {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    const text = (value: unknown, max: number) =>
      typeof value === "string" ? value.trim().slice(0, max) : "";
    return {
      buildId: text(data.buildId, 80),
      builtAt: text(data.builtAt, 40),
      version: text(data.version, 24)
    };
  } catch {
    return null;
  }
}

type UpdateProgress = { percent: number; message: string } | null;

export function SettingsSystemSection() {
  const lastSyncTime = useStore(state => state.lastSyncTime);
  const app = useAppUpdateRuntime();
  const desktop = useDesktopUpdate();
  const { snapshot: license } = useLicenseRuntime();

  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [buildLoading, setBuildLoading] = useState(true);
  const [storage, setStorage] = useState<PwaStorageHealth | null>(null);
  const [progress, setProgress] = useState<UpdateProgress>(null);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const watchdogRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchBuildInfo().then(info => {
      if (!alive) return;
      setBuild(info);
      setBuildLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void inspectPwaStorageHealth()
      .then(health => {
        if (alive) setStorage(health);
      })
      .catch(() => {
        // Sin Storage API simplemente no se pinta la estimación.
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ANDROID_SHELL) return;
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ percent?: number }>).detail;
      const percent = Math.min(100, Math.max(0, Math.round(Number(detail?.percent) || 0)));
      setApplying(true);
      setProgress({ percent, message: "Descargando la actualización…" });
    };
    const onInstalled = () => {
      if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      setApplying(false);
      setActionError("");
      setProgress({ percent: 100, message: "Actualización instalada. Reiniciando…" });
    };
    const onFailed = () => {
      if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      setApplying(false);
      setProgress(null);
      setActionError("No se pudo aplicar la actualización. Inténtalo de nuevo en unos minutos.");
    };
    window.addEventListener("palmyra:ota-progress", onProgress);
    window.addEventListener("palmyra:ota-installed", onInstalled);
    window.addEventListener("palmyra:ota-error", onFailed);
    return () => {
      window.removeEventListener("palmyra:ota-progress", onProgress);
      window.removeEventListener("palmyra:ota-installed", onInstalled);
      window.removeEventListener("palmyra:ota-error", onFailed);
      if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    };
  }, []);

  const desktopStatus = desktop.state?.status ?? (desktop.supported ? "idle" : "unsupported");
  const desktopPercent = Math.min(100, Math.max(0, Math.round(desktop.state?.percent ?? 0)));
  const desktopVersion = desktop.state?.version || "";
  const androidVersion = app.state.phase === "available" ? app.state.result?.version || "" : "";
  const androidArtifact = app.state.artifact;

  const status = ANDROID_SHELL
    ? PHASE_COPY[app.state.phase]
    : DESKTOP_SHELL
      ? desktopCopy(desktopStatus, desktopPercent)
      : PHASE_COPY[app.state.phase];
  const availableVersion = ANDROID_SHELL || !DESKTOP_SHELL ? androidVersion : desktopVersion;
  const busyChecking = app.state.phase === "checking" || desktopStatus === "checking";

  const checkNow = useCallback(() => {
    setActionError("");
    setNotice("");
    if (!ANDROID_SHELL && DESKTOP_SHELL) {
      void desktop.checkNow();
      return;
    }
    void app.checkNow();
  }, [app, desktop]);

  const applyAndroid = useCallback(() => {
    const version = androidVersion;
    if (!androidArtifact || version === "") {
      setActionError("Esta versión no publica un paquete para este equipo. Descarga la versión más reciente desde la web.");
      return;
    }
    setActionError("");
    setNotice("");
    setApplying(true);
    setProgress({ percent: 2, message: "Preparando la actualización…" });
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      setApplying(false);
      setProgress(null);
      setActionError("La actualización está tardando demasiado. Revisa tu conexión y vuelve a intentarlo.");
    }, APPLY_WATCHDOG_MS);
    // El shell repite en nativo todas las garantías (HTTPS, firma y versión).
    const result = applyAndroidUpdate(
      {
        kind: androidUpdateKindForArtifact(androidArtifact),
        version,
        url: androidArtifact.url,
        sha256: androidArtifact.sha256,
        bytes: androidArtifact.bytes
      },
      { currentVersion: PRODUCT_VERSION }
    );
    if (!result.ok) {
      if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      setApplying(false);
      setProgress(null);
      setActionError("No se pudo iniciar la actualización. Descarga la versión más reciente desde la web.");
    }
  }, [androidArtifact, androidVersion]);

  const applyDesktop = useCallback(() => {
    setActionError("");
    setNotice("");
    if (desktopStatus === "downloaded") {
      setApplying(true);
      void desktop
        .install()
        .then(result => {
          if (!result.ok) {
            setApplying(false);
            setActionError("No se pudo iniciar el instalador. Inténtalo de nuevo en unos minutos.");
            return;
          }
          setNotice("PALMYRA se reiniciará para aplicar la actualización.");
        })
        .catch(() => {
          setApplying(false);
          setActionError("No se pudo iniciar el instalador. Inténtalo de nuevo en unos minutos.");
        });
      return;
    }
    if (desktopStatus === "error" || desktopStatus === "blocked" || desktopStatus === "available") {
      void desktop.retry();
      return;
    }
    setActionError("Todavía no hay una descarga lista. Pulsa «Buscar actualización».");
  }, [desktop, desktopStatus]);

  const applyWeb = useCallback(() => {
    setActionError("");
    setNotice("");
    const bridge = (window as Window & {
      __palmyraApplyUpdate?: () => Promise<"reloaded" | "up-to-date">;
    }).__palmyraApplyUpdate;
    if (typeof bridge !== "function") {
      setActionError("Esta versión no se puede aplicar sin recargar. Vuelve a abrir PALMYRA en unos segundos.");
      return;
    }
    setApplying(true);
    void bridge()
      .then(outcome => {
        if (outcome === "up-to-date") {
          setApplying(false);
          setNotice("Ya tienes la última versión publicada.");
        }
      })
      .catch(() => {
        setApplying(false);
        setActionError("No se pudo aplicar la actualización. Vuelve a abrir PALMYRA en unos segundos.");
      });
  }, []);

  const licenseState = licenseStateOf(
    license.mode,
    license.readOnly,
    license.paidThrough,
    license.offlineUntil
  );
  const licenseTone = TONES[licenseState.tone];
  const lastSyncLabel = formatMoment(lastSyncTime);
  const usagePercent =
    storage && storage.quotaBytes > 0
      ? Math.min(100, Math.max(0, Math.round((storage.usageBytes / storage.quotaBytes) * 100)))
      : 0;
  const canApplyAndroid = ANDROID_SHELL && Boolean(androidArtifact) && androidVersion !== "";
  const canApplyDesktop = DESKTOP_SHELL && (desktopStatus === "downloaded" || desktopStatus === "error" || desktopStatus === "blocked" || desktopStatus === "available");
  const canApplyWeb = !ANDROID_SHELL && !DESKTOP_SHELL && app.state.phase === "available";
  const showApply = canApplyAndroid || canApplyDesktop || canApplyWeb;

  return (
    <section className="space-y-3 min-w-0">
      <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4 min-w-0">
        <SettingsSectionHeader
          icon={MonitorCog}
          title="Resumen del sistema"
          subtitle="Versión de PALMYRA, actualizaciones, licencia y almacenamiento de este equipo."
        />

        {/* Versión */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-base bg-primary p-3 min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Versión</p>
            <p className="mt-1 text-2xl font-black leading-none text-primary">{PRODUCT_DISPLAY_VERSION}</p>
            <p className="mt-1 break-words text-xs font-semibold text-muted">Versión técnica {PRODUCT_VERSION}</p>
          </div>
          <div className="rounded-xl border border-base bg-primary p-3 min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Build</p>
            <p className="mt-1 break-all text-sm font-bold text-primary">
              {buildLoading ? "Consultando…" : build?.buildId || "No disponible"}
            </p>
            <p className="mt-1 text-xs font-semibold text-muted">
              {build?.builtAt ? `Compilado el ${formatDay(build.builtAt)}` : "Sin fecha de compilación"}
            </p>
          </div>
        </div>

        {/* Actualización */}
        <div className="rounded-xl border border-base bg-primary p-3 space-y-3 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-primary">Actualización</p>
              <p role="status" aria-live="polite" className="mt-1 text-sm font-medium text-secondary">
                {status.label}
              </p>
              {availableVersion !== "" && (
                <p className="mt-1 text-sm font-bold text-violet-700 dark:text-violet-300">
                  Versión disponible: {PRODUCT_DISPLAY_VERSION}
                </p>
              )}
            </div>
            <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-bold", TONES[status.tone])}>
              {SURFACE_LABEL}
            </span>
          </div>

          {(progress || (DESKTOP_SHELL && (desktopStatus === "downloading" || desktopStatus === "available"))) && (
            <div className="space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-subtle">
                <div
                  className="h-full rounded-full bg-violet-600 transition-[width] duration-300"
                  style={{ width: `${progress ? progress.percent : desktopPercent}%` }}
                />
              </div>
              <p className="text-xs font-semibold text-muted">
                {progress ? progress.message : `Descargando ${desktopPercent}%…`}
              </p>
            </div>
          )}

          {actionError && (
            <p role="status" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-sm font-semibold text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {actionError}
            </p>
          )}
          {notice && !actionError && (
            <p role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-sm font-semibold text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {notice}
            </p>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={checkNow}
              disabled={busyChecking}
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
            >
              <RefreshCw size={15} className={busyChecking ? "animate-spin" : undefined} aria-hidden="true" />
              {busyChecking ? "Comprobando…" : "Buscar actualización"}
            </button>
            {showApply && (
              <button
                type="button"
                onClick={() => {
                  if (canApplyAndroid) applyAndroid();
                  else if (canApplyDesktop) applyDesktop();
                  else applyWeb();
                }}
                disabled={applying}
                className="flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                <Download size={15} aria-hidden="true" />
                {applying ? "Actualizando…" : desktopStatus === "downloaded" ? "Reiniciar y actualizar" : "Actualizar ahora"}
              </button>
            )}
          </div>

          <p className="text-xs font-medium leading-5 text-muted">
            Las actualizaciones se avisan solas. Este botón solo fuerza una comprobación inmediata.
          </p>
        </div>

        {/* Licencia */}
        <div className="rounded-xl border border-base bg-primary p-3 space-y-2.5 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-primary">Licencia</p>
            <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", licenseTone)}>
              {licenseState.label}
            </span>
          </div>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Modalidad</dt>
              <dd className="mt-0.5 break-words text-sm font-semibold text-primary">{licenseModeLabel(license.mode, license.pendingActivation)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Pagado hasta</dt>
              <dd className="mt-0.5 break-words text-sm font-semibold text-primary">{formatDay(license.paidThrough)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Sin internet hasta</dt>
              <dd className="mt-0.5 break-words text-sm font-semibold text-primary">{formatDay(license.offlineUntil)}</dd>
            </div>
          </dl>
          <p className="text-xs font-medium leading-5 text-muted">
            {license.readOnly
              ? "Ahora mismo solo puedes consultar y exportar. Renueva el plan para volver a operar con normalidad."
              : license.pendingActivation
                ? "Este equipo aún no tiene guardada la licencia del plan; la activación se reintenta sola en cuanto hay conexión."
                : "La licencia se comprueba sola en segundo plano; si vence, la app pasa a solo lectura y tus datos se conservan."}
          </p>
        </div>

        {/* Dispositivo y almacenamiento */}
        <div className="rounded-xl border border-base bg-primary p-3 space-y-2.5 min-w-0">
          <p className="text-sm font-bold text-primary">Dispositivo y almacenamiento</p>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Equipo</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-primary">
                <MonitorCog size={14} aria-hidden="true" /> {SURFACE_LABEL}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Almacenamiento local</dt>
              <dd className="mt-0.5 text-sm font-semibold text-primary">
                {storage && storage.quotaBytes > 0
                  ? `${formatStorageBytes(storage.usageBytes)} de ${formatStorageBytes(storage.quotaBytes)} (${usagePercent}%)`
                  : "No disponible en este equipo"}
              </dd>
              {storage && storage.quotaBytes > 0 && (
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-subtle">
                  <div
                    className={cn("h-full rounded-full", usagePercent >= 80 ? "bg-rose-500" : "bg-emerald-500")}
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Almacenamiento protegido</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-primary">
                <ShieldCheck size={14} aria-hidden="true" />
                {storage ? (storage.persisted ? "Concedido" : "No concedido") : "No disponible"}
              </dd>
            </div>
            {lastSyncLabel && (
              <div className="min-w-0">
                <dt className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Última sincronización</dt>
                <dd className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-primary">
                  <HardDrive size={14} aria-hidden="true" /> {lastSyncLabel}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </section>
  );
}

export default SettingsSystemSection;
