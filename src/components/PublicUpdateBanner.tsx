import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { RefreshCw, X } from "lucide-react";
import { isPalmyraApp } from "../lib/install";
import { PRODUCT_VERSION } from "../lib/productVersion";
import { useAppUpdateRuntime } from "../hooks/useAppUpdateRuntime";
import { useDesktopUpdate } from "../hooks/useDesktopUpdate";
import { applyAndroidUpdate } from "../services/updates/android";
import { androidUpdateKindForArtifact } from "../services/updates/runtime";

/**
 * Aviso flotante de actualización para el shell PÚBLICO (landing, auth,
 * onboarding…), donde Layout no está montado.
 *
 * Cubre las tres superficies reales:
 *   - Web/PWA: reacciona al evento global `palmyra:update-available` y aplica
 *     la recarga del service worker (`__palmyraApplyUpdate`).
 *   - Android (APK): usa el manifiesto firmado (runtime compartido) y entrega
 *     el paquete al shell con `startUpdate`/`startApkUpdate` (OTA real, sin
 *     volver a bajar el APK a mano).
 *   - Windows (Electron): usa el puente de electron-updater y reinicia con el
 *     Setup ya descargado.
 *
 * Nunca se duplica con el diálogo de Layout: allí la ruta deja de ser pública
 * y este aviso se apaga.
 */

const PALMYRA_UPDATE_AVAILABLE_KEY = "palmyra:update-available";
const PALMYRA_UPDATE_VERSION_KEY = "palmyra:update-version";
const BANNER_DISMISSED_KEY = "palmyra:update-banner-dismissed";
const APPLY_WATCHDOG_MS = 3 * 60_000;
// Rutas que se renderizan fuera de Layout. En el resto (POS, reportes, etc.)
// el aviso lo muestra Layout y este banner debe callarse.
const PUBLIC_ROUTE_PATTERN = /^\/(?:landing|auth|auth\/confirm|platform-admin|invite|security|onboarding|account-status)(?:\/|$)/i;

const ANDROID_SHELL = isPalmyraApp();
const DESKTOP_SHELL =
  !ANDROID_SHELL && typeof navigator !== "undefined" && /\bElectron\//i.test(navigator.userAgent);

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
    case "verifying": return "Verificando el paquete descargado…";
    case "applying":
    case "installing": return "Instalando la actualización…";
    case "reloading": return "Actualización instalada. Reiniciando…";
    case "up-to-date": return "PALMYRA ya está actualizada.";
    default: return "Preparando la actualización…";
  }
}

function percentOf(detail: UpdateProgressDetail | null) {
  return Math.min(100, Math.max(0, Math.round(detail?.percent ?? 0)));
}

/**
 * Titular del aviso. Muestra la versión REAL disponible (la del manifiesto),
 * nunca la etiqueta de versión de esta instalación.
 */
export function updateBannerHeadline(version: string): string {
  return version
    ? `La versión ${version} de PALMYRA está lista.`
    : "Una nueva versión de PALMYRA está lista.";
}

/**
 * Etiqueta del botón principal del aviso de escritorio. Nunca dice
 * «Reiniciando…» mientras se descarga o se verifica: solo cuando el
 * instalador ya se lanzó de verdad.
 */
export function desktopBannerPrimaryLabel(input: {
  installing: boolean;
  status: string;
  percent: number;
}): string {
  const { installing, status, percent } = input;
  switch (status) {
    case "available": return `Verificando… ${percent}%`;
    case "downloading": return `Descargando… ${percent}%`;
    case "downloaded": return installing ? "Reiniciando…" : "Reiniciar y actualizar";
    case "error":
    case "blocked": return "Reintentar";
    default: return installing ? "Reiniciando…" : `Preparando… ${percent}%`;
  }
}

/**
 * Tarjeta compartida por las tres superficies. El botón principal solo se
 * habilita cuando la acción es posible; el resto del tiempo muestra progreso.
 */
function UpdateCard(props: {
  version: string;
  applying: boolean;
  percent: number;
  message: string;
  error: string;
  disabled: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[var(--z-tooltip)] flex justify-center px-3 pb-3 sm:px-4 sm:pb-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-violet-200/80 bg-white/95 shadow-[0_18px_50px_rgba(76,29,149,0.24)] backdrop-blur dark:border-violet-900/60 dark:bg-slate-900/95"
      >
        <div className="flex items-start gap-3 px-3.5 py-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
            <RefreshCw className={props.applying ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-600 dark:text-violet-300">
              Actualización disponible
            </p>
            <p className="mt-0.5 text-[11px] font-bold leading-4 text-slate-700 dark:text-slate-200">
              {updateBannerHeadline(props.version)}
            </p>

            {props.applying && (
              <div className="mt-2">
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900/50"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={props.percent}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(3, props.percent))}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] font-semibold leading-4 text-violet-700 dark:text-violet-300">
                  {props.message}
                </p>
              </div>
            )}

            {props.error && (
              <p className="mt-1.5 text-[10px] font-bold leading-4 text-red-600 dark:text-red-300" role="alert">
                {props.error}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={props.onDismiss}
            disabled={props.applying}
            aria-label="Ocultar aviso de actualización"
            className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
          <button
            type="button"
            onClick={props.onDismiss}
            disabled={props.applying}
            className="h-8 rounded-lg border border-slate-200 bg-slate-50 px-3 text-[9px] font-black uppercase tracking-[0.06em] text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            Ahora no
          </button>
          <button
            type="button"
            onClick={props.onPrimary}
            disabled={props.disabled || props.applying}
            className="h-8 rounded-lg bg-violet-600 px-3.5 text-[9px] font-black uppercase tracking-[0.06em] text-white shadow-md shadow-violet-600/20 transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-70"
          >
            {props.primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Descarte por sesión: un aviso de OTRA versión vuelve a mostrarse. */
function useBannerDismissal(current: string) {
  const [dismissed, setDismissed] = useState(readDismissedVersion);
  const key = current || "__unknown__";
  const dismiss = useCallback(() => {
    try { window.sessionStorage.setItem(BANNER_DISMISSED_KEY, key); } catch {}
    setDismissed(key);
  }, [key]);
  return { hidden: dismissed === key, dismiss };
}

// ─── Web / PWA (service worker) ─────────────────────────────────────────────

function WebUpdateBanner() {
  const [available, setAvailable] = useState(readAvailable);
  const [version, setVersion] = useState(readVersion);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressDetail | null>(null);
  const [error, setError] = useState("");
  const applyingRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);
  const { hidden, dismiss } = useBannerDismissal(version);

  useEffect(() => {
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

  if (!available || hidden) return null;
  const percent = percentOf(progress);
  return (
    <UpdateCard
      version={version}
      applying={applying}
      percent={percent}
      message={phaseLabel(progress)}
      error={error}
      disabled={false}
      primaryLabel={applying ? `Actualizando… ${percent}%` : error ? "Reintentar" : "Actualizar ahora"}
      onPrimary={() => void applyUpdate()}
      onDismiss={dismiss}
    />
  );
}

// ─── Android (OTA desde el manifiesto firmado) ──────────────────────────────

function AndroidUpdateBanner() {
  const { state } = useAppUpdateRuntime();
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressDetail | null>(null);
  const [error, setError] = useState("");
  const applyingRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);

  const version = state.phase === "available" ? state.result?.version || "" : "";
  const artifact = state.artifact;
  const { hidden, dismiss } = useBannerDismissal(version);

  useEffect(() => {
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<UpdateProgressDetail>).detail;
      if (!detail) return;
      // Un evento del shell confirma que la descarga arrancó de verdad.
      applyingRef.current = true;
      setApplying(true);
      setProgress(detail);
    };
    const onInstalled = () => {
      applyingRef.current = false;
      setApplying(false);
      setError("");
      if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      setProgress({ phase: "reloading", percent: 100, message: "Actualización instalada. Reiniciando…" });
    };
    const onFailed = (event: Event) => {
      applyingRef.current = false;
      setApplying(false);
      if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      setProgress(null);
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setError(message || "No se pudo aplicar la actualización. Reintenta en unos minutos.");
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

  const applyUpdate = useCallback(() => {
    if (applyingRef.current) return;
    if (!artifact || version === "") {
      setError("Esta versión no publica un paquete para Android. Descarga el APK más reciente.");
      return;
    }
    setError("");
    applyingRef.current = true;
    setApplying(true);
    setProgress({ phase: "preparing", percent: 4, message: "Preparando la actualización…" });
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = window.setTimeout(() => {
      applyingRef.current = false;
      setApplying(false);
      setProgress(null);
      setError('La actualización está tardando demasiado. Revisa tu conexión y pulsa "Actualizar ahora".');
    }, APPLY_WATCHDOG_MS);

    // El shell repite en nativo todas las garantías (HTTPS, SHA-256, versión
    // creciente y firma) antes de tocar el paquete.
    const result = applyAndroidUpdate(
      {
        kind: androidUpdateKindForArtifact(artifact),
        version,
        url: artifact.url,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      },
      { currentVersion: PRODUCT_VERSION }
    );
    if (!result.ok) {
      applyingRef.current = false;
      setApplying(false);
      setProgress(null);
      if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      setError(result.error || "Este instalador no permite actualizar desde la app. Descarga el APK más reciente.");
    }
  }, [artifact, version]);

  if (!version || !artifact || hidden) return null;
  const percent = percentOf(progress);
  return (
    <UpdateCard
      version={version}
      applying={applying}
      percent={percent}
      message={phaseLabel(progress)}
      error={error}
      disabled={false}
      primaryLabel={applying ? `Actualizando… ${percent}%` : error ? "Reintentar" : "Actualizar ahora"}
      onPrimary={applyUpdate}
      onDismiss={dismiss}
    />
  );
}

// ─── Windows (Electron + electron-updater) ─────────────────────────────────

function DesktopUpdateBanner() {
  const { state, install, retry } = useDesktopUpdate();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const applyingRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);
  const status = state?.status ?? "idle";
  const version = state?.version || state?.currentVersion || "";
  const percent = Math.min(100, Math.max(0, Math.round(state?.percent ?? 0)));
  const { hidden, dismiss } = useBannerDismissal(version);

  // Si la descarga termina en error o bloqueo, el botón se libera aunque el
  // instalador no haya respondido.
  useEffect(() => {
    if (status === "error" || status === "blocked") {
      applyingRef.current = false;
      setApplying(false);
      if (watchdogRef.current !== null) {
        window.clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    }
  }, [status]);

  useEffect(() => () => {
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
  }, []);

  const applyUpdate = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setError("");
    setApplying(true);
    // Si quitAndInstall no reinicia la app, el botón se libera solo.
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      applyingRef.current = false;
      setApplying(false);
      setError("El instalador no respondió. Reinicia PALMYRA manualmente o inténtalo de nuevo.");
    }, APPLY_WATCHDOG_MS);
    try {
      const result = await install();
      if (!result.ok) {
        applyingRef.current = false;
        setApplying(false);
        if (watchdogRef.current !== null) {
          window.clearTimeout(watchdogRef.current);
          watchdogRef.current = null;
        }
        setError(result.error || "No se pudo iniciar el instalador. Reintenta en unos minutos.");
      }
      // Éxito: la app se reinicia sola; el watchdog cubre el caso raro de que
      // quitAndInstall no arranque.
    } catch {
      applyingRef.current = false;
      setApplying(false);
      if (watchdogRef.current !== null) {
        window.clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      setError("No se pudo iniciar el instalador. Reintenta en unos minutos.");
    }
  }, [install]);

  if (status === "idle" || status === "checking" || status === "not-available" || status === "unsupported" || hidden) {
    return null;
  }
  // Un error sin versión conocida (p. ej. sin app-update.yml) no es un aviso
  // útil antes de entrar: el Centro de actualizaciones ya lo explica.
  if (status === "error" && !version && !state?.error) return null;
  const message =
    status === "available"
      ? "Verificando la firma de la actualización…"
      : status === "downloading"
        ? `Descargando actualización ${percent}%…`
        : status === "downloaded"
          ? "Actualización lista. Reinicia PALMYRA para aplicarla."
          : status === "error" || status === "blocked"
            ? state?.error || "La actualización se detuvo."
            : "Preparando la actualización…";
  return (
    <UpdateCard
      version={version}
      applying={applying || status === "available" || status === "downloading"}
      percent={percent}
      message={message}
      error={status === "error" || status === "blocked" ? "" : error}
      disabled={status !== "downloaded" && status !== "error" && status !== "blocked"}
      primaryLabel={desktopBannerPrimaryLabel({ installing: applying, status, percent })}
      onPrimary={() => {
        if (status === "error" || status === "blocked") {
          void retry();
          return;
        }
        void applyUpdate();
      }}
      onDismiss={dismiss}
    />
  );
}

export default function PublicUpdateBanner({ signedIn }: { signedIn: boolean }) {
  const location = useLocation();
  const isPublicArea = !signedIn || PUBLIC_ROUTE_PATTERN.test(location.pathname);
  if (!isPublicArea) return null;
  if (ANDROID_SHELL) return <AndroidUpdateBanner />;
  if (DESKTOP_SHELL) return <DesktopUpdateBanner />;
  return <WebUpdateBanner />;
}
