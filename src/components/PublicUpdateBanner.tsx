import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { RefreshCw, X } from "lucide-react";
import { isPalmyraApp } from "../lib/install";

/**
 * Aviso flotante de actualización para el shell PÚBLICO (landing, auth,
 * onboarding…), donde Layout no está montado. Reacciona al evento global
 * `palmyra:update-available` y a la marca persistente en localStorage, muestra
 * el progreso real de la descarga y nunca se duplica con el diálogo de Layout.
 */

const PALMYRA_UPDATE_AVAILABLE_KEY = "palmyra:update-available";
const PALMYRA_UPDATE_VERSION_KEY = "palmyra:update-version";
const BANNER_DISMISSED_KEY = "palmyra:update-banner-dismissed";
const APPLY_WATCHDOG_MS = 3 * 60_000;
// Rutas que se renderizan fuera de Layout. En el resto (POS, reportes, etc.)
// el aviso lo muestra Layout y este banner debe callarse.
const PUBLIC_ROUTE_PATTERN = /^\/(?:landing|auth|auth\/confirm|platform-admin|invite|security|onboarding|account-status)(?:\/|$)/i;

const NATIVE_SHELL =
  isPalmyraApp() || (typeof navigator !== "undefined" && /\bElectron\//i.test(navigator.userAgent));

type UpdateProgressDetail = {
  phase?: string;
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
};

type UpdateBridgeWindow = Window & {
  __palmyraApplyUpdate?: () => Promise<"reloaded" | "up-to-date">;
};

function readAvailable() {
  try { return window.localStorage.getItem(PALMYRA_UPDATE_AVAILABLE_KEY) === "1"; } catch { return false; }
}

function readVersion() {
  try { return window.localStorage.getItem(PALMYRA_UPDATE_VERSION_KEY) || ""; } catch { return ""; }
}

function readDismissedVersion() {
  try { return window.sessionStorage.getItem(BANNER_DISMISSED_KEY) || ""; } catch { return ""; }
}

function formatMb(bytes?: number) {
  if (!bytes || bytes <= 0) return "";
  return (bytes / (1024 * 1024)).toFixed(1);
}

function phaseLabel(detail: UpdateProgressDetail | null) {
  if (!detail) return "Preparando la actualización…";
  if (detail.message) return detail.message;
  const percent = Math.min(100, Math.max(0, Math.round(detail.percent ?? 0)));
  switch (detail.phase) {
    case "downloading": {
      const received = formatMb(detail.receivedBytes);
      const total = formatMb(detail.totalBytes);
      if (received && total) return `Descargando actualización ${received} MB de ${total} MB…`;
      return `Descargando actualización ${percent}%…`;
    }
    case "installing": return "Instalando la actualización…";
    case "reloading": return "Actualización instalada. Reiniciando…";
    case "up-to-date": return "PALMYRA ya está actualizada.";
    default: return "Preparando la actualización…";
  }
}

export default function PublicUpdateBanner({ signedIn }: { signedIn: boolean }) {
  const location = useLocation();
  const [available, setAvailable] = useState(readAvailable);
  const [version, setVersion] = useState(readVersion);
  const [dismissedVersion, setDismissedVersion] = useState(readDismissedVersion);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressDetail | null>(null);
  const [error, setError] = useState("");
  const applyingRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);

  useEffect(() => {
    if (NATIVE_SHELL) return;

    const sync = () => {
      setAvailable(readAvailable());
      setVersion(readVersion());
    };
    const onAvailable = (event: Event) => {
      const detail = (event as CustomEvent<{ version?: string }>).detail;
      const nextVersion = detail?.version || readVersion();
      setAvailable(true);
      setVersion(nextVersion);
      // Un aviso de OTRA versión vuelve a mostrarse aunque se hubiera ocultado.
      const snoozed = readDismissedVersion();
      if (snoozed && snoozed === (nextVersion || "__unknown__")) return;
      try { window.sessionStorage.removeItem(BANNER_DISMISSED_KEY); } catch {}
      setDismissedVersion("");
    };
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<UpdateProgressDetail>).detail;
      if (detail) setProgress(detail);
    };
    const onCleared = () => {
      setAvailable(false);
      setProgress(null);
    };

    // El chequeo inmediato de main.tsx puede resolver antes de montar este
    // banner: al aparecer se relee la marca persistente.
    sync();
    window.addEventListener("palmyra:update-available", onAvailable);
    window.addEventListener("palmyra:update-progress", onProgress);
    window.addEventListener("palmyra:update-cleared", onCleared);
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    document.addEventListener("visibilitychange", sync);

    return () => {
      window.removeEventListener("palmyra:update-available", onAvailable);
      window.removeEventListener("palmyra:update-progress", onProgress);
      window.removeEventListener("palmyra:update-cleared", onCleared);
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  useEffect(() => () => {
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
  }, []);

  const dismiss = useCallback(() => {
    if (applyingRef.current) return;
    const current = version || "__unknown__";
    try { window.sessionStorage.setItem(BANNER_DISMISSED_KEY, current); } catch {}
    setDismissedVersion(current);
  }, [version]);

  const runBridge = useCallback(async (): Promise<"reloaded" | "up-to-date"> => {
    const bridge = (window as UpdateBridgeWindow).__palmyraApplyUpdate;
    if (!bridge) {
      // Sin puente disponible: la recarga toma el shell nuevo. Los datos
      // locales (IndexedDB/localStorage) se conservan intactos.
      window.location.reload();
      return "reloaded";
    }
    return bridge();
  }, []);

  const applyUpdate = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setError("");
    setApplying(true);
    setProgress({ phase: "preparing", percent: 2, message: "Preparando la actualización…" });

    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = window.setTimeout(() => {
      applyingRef.current = false;
      setApplying(false);
      setProgress(null);
      setError('La actualización está tardando demasiado. Revisa tu conexión y pulsa "Actualizar ahora".');
    }, APPLY_WATCHDOG_MS);

    try {
      const result = await runBridge();
      if (result === "up-to-date") {
        setApplying(false);
        setProgress(null);
        setAvailable(false);
        return;
      }
      // "reloaded": el navegador recargará en breve; se muestra el mensaje final.
      setProgress({ phase: "reloading", percent: 100, message: "Actualización instalada. Reiniciando…" });
      return;
    } catch {
      // Reintento automático si hay red, sin congelar la interfaz.
      if (navigator.onLine) {
        setError("No se pudo descargar. Reintentando…");
        setProgress({ phase: "preparing", percent: 2, message: "No se pudo descargar. Reintentando…" });
        await new Promise((resolve) => window.setTimeout(resolve, 2_500));
        try {
          const retry = await runBridge();
          if (retry === "up-to-date") {
            setApplying(false);
            setProgress(null);
            setAvailable(false);
            return;
          }
          setProgress({ phase: "reloading", percent: 100, message: "Actualización instalada. Reiniciando…" });
          return;
        } catch (retryError) {
          setApplying(false);
          setProgress(null);
          const message = retryError instanceof Error ? retryError.message : "";
          setError(
            /conexión|network|servidor|disponible|confirmar|tardando/i.test(message)
              ? message
              : "No se pudo completar la actualización. Revisa la conexión e inténtalo de nuevo."
          );
          return;
        }
      }
      applyingRef.current = false;
      setApplying(false);
      setProgress(null);
      setError("Sin conexión. La actualización se aplicará cuando vuelvas a estar en línea.");
    } finally {
      if (watchdogRef.current !== null) {
        window.clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      // Si la aplicación no recargó (fallo), se libera el botón; si recargó,
      // la página ya no importa.
      applyingRef.current = false;
    }
  }, [runBridge]);

  const isPublicArea = !signedIn || PUBLIC_ROUTE_PATTERN.test(location.pathname);
  const dismissed = Boolean(dismissedVersion) && dismissedVersion === (version || "__unknown__");
  if (NATIVE_SHELL || !available || dismissed || !isPublicArea) return null;

  const percent = Math.min(100, Math.max(0, Math.round(progress?.percent ?? 0)));
  const message = phaseLabel(progress);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[260] flex justify-center px-3 pb-3 sm:px-4 sm:pb-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-violet-200/80 bg-white/95 shadow-[0_18px_50px_rgba(76,29,149,0.24)] backdrop-blur dark:border-violet-900/60 dark:bg-slate-900/95"
      >
        <div className="flex items-start gap-3 px-3.5 py-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
            <RefreshCw className={applying ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-600 dark:text-violet-300">
              Actualización disponible
            </p>
            <p className="mt-0.5 text-[11px] font-bold leading-4 text-slate-700 dark:text-slate-200">
              {version ? `La versión ${version} de PALMYRA está lista.` : "Una nueva versión de PALMYRA está lista."}
            </p>

            {applying && (
              <div className="mt-2">
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900/50"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(3, percent))}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] font-semibold leading-4 text-violet-700 dark:text-violet-300">
                  {message}
                </p>
              </div>
            )}

            {error && (
              <p className="mt-1.5 text-[10px] font-bold leading-4 text-red-600 dark:text-red-300" role="alert">
                {error}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={applying}
            aria-label="Ocultar aviso de actualización"
            className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
          <button
            type="button"
            onClick={dismiss}
            disabled={applying}
            className="h-8 rounded-lg border border-slate-200 bg-slate-50 px-3 text-[9px] font-black uppercase tracking-[0.06em] text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            Ahora no
          </button>
          <button
            type="button"
            onClick={() => void applyUpdate()}
            disabled={applying}
            className="h-8 rounded-lg bg-violet-600 px-3.5 text-[9px] font-black uppercase tracking-[0.06em] text-white shadow-md shadow-violet-600/20 transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-70"
          >
            {applying ? `Actualizando… ${percent}%` : error ? "Reintentar" : "Actualizar ahora"}
          </button>
        </div>
      </div>
    </div>
  );
}
