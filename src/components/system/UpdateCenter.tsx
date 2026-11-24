import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { cn } from "../../lib/utils";
import { getNativeAppInfo } from "../../lib/nativeApp";
import { PRODUCT_DISPLAY_VERSION, PRODUCT_VERSION } from "../../lib/productVersion";
import { useAppUpdateRuntime } from "../../hooks/useAppUpdateRuntime";
import { recordUpdateOutcome } from "../../services/pilot/metrics";
import {
  ANDROID_UPDATE_ERROR_EVENT,
  ANDROID_UPDATE_EVENT,
  applyAndroidUpdate
} from "../../services/updates/android";
import {
  androidUpdateKindForArtifact,
  type AppUpdatePhase
} from "../../services/updates/runtime";

/**
 * Centro de actualizaciones (manifiesto firmado).
 *
 * Muestra en qué canal está esta instalación, la última comprobación y, si hay
 * versión nueva, las notas y la acción de instalar según la superficie real:
 * APK (OTA nativo), escritorio Electron (puente del preload) o web (descarga
 * manual). Comparte el runtime del Layout: aquí solo se pinta y se dispara la
 * acción, nunca se descarga ni se verifica nada por cuenta propia.
 *
 * Ninguna acción lanza: cualquier fallo se muestra en español y los botones se
 * deshabilitan mientras hay trabajo en curso.
 */

type DesktopUpdaterLike = {
  check?: () => Promise<unknown>;
  download?: () => Promise<unknown>;
  install?: () => Promise<unknown>;
};

const PLATFORM_LABELS = {
  windows: "Windows (escritorio)",
  android: "Android",
  web: "Web (solo registro)"
} as const;

const PHASE_LABELS: Record<AppUpdatePhase, string> = {
  unconfigured: "Sin canal configurado",
  idle: "Sin comprobar",
  checking: "Comprobando…",
  available: "Actualización disponible",
  "up-to-date": "Al día",
  blocked: "Bloqueada",
  unverified: "Sin verificar",
  error: "Con error"
};

type Tone = "ok" | "warn" | "fail" | "idle";

const PHASE_TONES: Record<AppUpdatePhase, Tone> = {
  unconfigured: "idle",
  idle: "idle",
  checking: "idle",
  available: "warn",
  "up-to-date": "ok",
  blocked: "fail",
  unverified: "warn",
  error: "fail"
};

const TONE_BADGES: Record<Tone, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  warn: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  fail: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  idle: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
};

const TONE_DOTS: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-violet-500",
  fail: "bg-rose-500",
  idle: "bg-slate-400"
};

function readDesktopUpdater(): DesktopUpdaterLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { palmyraDesktopUpdate?: DesktopUpdaterLike })
    .palmyraDesktopUpdate;
  return candidate && typeof candidate === "object" ? candidate : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "La operación falló por un motivo desconocido.";
}

/** Traduce la respuesta del puente de escritorio a un error mostrable. */
function bridgeFailure(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object") return null;
  const record = outcome as { ok?: unknown; status?: unknown; error?: unknown };
  const failure =
    record.ok === false || record.status === "error" || record.status === "unsupported";
  if (!failure) return null;
  const text = typeof record.error === "string" ? record.error.trim() : "";
  return text !== "" ? text : "El actualizador de escritorio no pudo aplicar la actualización.";
}

function formatMoment(timestamp: number | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "Nunca";
  try {
    return new Date(timestamp).toLocaleString("es-ES", {
      dateStyle: "short",
      timeStyle: "short"
    });
  } catch {
    return "Nunca";
  }
}

function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UpdateCenter({ className }: { className?: string }) {
  const { state, checkNow, dismiss, isDismissed } = useAppUpdateRuntime();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [notesExpanded, setNotesExpanded] = useState(false);

  const availableVersion = state.phase === "available" ? state.result?.version || "" : "";
  const artifact = state.artifact;
  const dismissed = availableVersion !== "" && isDismissed(availableVersion);
  const notes = state.notes || "";
  const notesPreview = notes.length > 220 ? `${notes.slice(0, 220)}…` : notes;
  const tone = PHASE_TONES[state.phase];
  const checking = state.phase === "checking";
  const busyOrChecking = busy || checking;
  const native = getNativeAppInfo();
  const canInstallAndroid =
    state.platform === "android" && Boolean(native && native.ota === true);
  const canInstallDesktop = state.platform === "windows" && Boolean(readDesktopUpdater());
  const artifactMissing = availableVersion !== "" && !artifact;

  // Métricas del piloto (F7-B): se anota UNA vez por transición real. El ref
  // evita bucles de efectos y repeticiones cuando el runtime reemite el mismo
  // estado; el historial local deduplica además día + versión + resultado.
  const recordedRef = useRef("");
  const availableRef = useRef("");
  availableRef.current = availableVersion;
  const recordOnce = (key: string, status: "success" | "failure", version: string) => {
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    recordUpdateOutcome({ status, version, at: new Date() });
  };

  useEffect(() => {
    // Una comprobación que falla se cuenta como intento fallido de actualización.
    if (state.phase !== "error") return;
    const version = state.result?.version || PRODUCT_VERSION;
    recordOnce(`error:${version}`, "failure", version);
  }, [state.phase, state.result]);

  useEffect(() => {
    // El shell Android avisa cuando la instalación terminó de verdad (o falló).
    const onInstalled = (event: Event) => {
      const detail = (event as CustomEvent<{ version?: string }>).detail;
      const reported = typeof detail?.version === "string" ? detail.version.trim() : "";
      const version = reported !== "" ? reported : availableRef.current || PRODUCT_VERSION;
      recordOnce(`installed:${version}`, "success", version);
    };
    const onFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      const version = availableRef.current || PRODUCT_VERSION;
      recordOnce(`ota-error:${version}:${detail?.message ?? ""}`, "failure", version);
    };
    window.addEventListener(ANDROID_UPDATE_EVENT, onInstalled);
    window.addEventListener(ANDROID_UPDATE_ERROR_EVENT, onFailed);
    return () => {
      window.removeEventListener(ANDROID_UPDATE_EVENT, onInstalled);
      window.removeEventListener(ANDROID_UPDATE_ERROR_EVENT, onFailed);
    };
  }, []);

  const handleCheck = () => {
    if (busyOrChecking) return;
    setMessage("");
    setActionError("");
    void checkNow();
  };

  const handleInstall = async () => {
    if (busy || !artifact || availableVersion === "") return;
    setBusy(true);
    setMessage("");
    setActionError("");
    try {
      if (state.platform === "android") {
        if (!canInstallAndroid) {
          setActionError(
            "Este instalador no permite actualizar desde la app. Descarga el APK más reciente e instálalo encima."
          );
          return;
        }
        const result = applyAndroidUpdate(
          {
            kind: androidUpdateKindForArtifact(artifact),
            version: availableVersion,
            url: artifact.url,
            sha256: artifact.sha256,
            bytes: artifact.bytes
          },
          { currentVersion: PRODUCT_VERSION }
        );
        if (result.ok) {
          setMessage("Descargando e instalando…");
        } else {
          recordOnce(`android-send-error:${availableVersion}:${result.error ?? ""}`, "failure", availableVersion);
          setActionError(result.error || "No se pudo iniciar la actualización.");
        }
        return;
      }

      if (state.platform === "windows") {
        const bridge = readDesktopUpdater();
        if (!bridge) {
          setActionError("El actualizador de escritorio no está disponible en esta ventana.");
          return;
        }
        if (typeof bridge.check === "function") await bridge.check();
        if (typeof bridge.download === "function") await bridge.download();
        const outcome = typeof bridge.install === "function" ? await bridge.install() : null;
        const failure = bridgeFailure(outcome);
        if (failure) {
          recordOnce(`desktop-install-error:${availableVersion}:${failure}`, "failure", availableVersion);
          setActionError(failure);
          return;
        }
        // El reinicio aplica la versión: contamos la instalación iniciada como éxito.
        recordOnce(`desktop-install:${availableVersion}`, "success", availableVersion);
        setMessage(
          `Instalación iniciada. PALMYRA se reiniciará para aplicar la versión ${availableVersion}.`
        );
        return;
      }

      setActionError("Esta superficie no ejecuta la instalación; usa el enlace de descarga.");
    } catch (error) {
      const text = messageOf(error);
      recordOnce(`install-throw:${availableVersion}:${text}`, "failure", availableVersion);
      setActionError(text);
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (availableVersion === "") return;
    dismiss(availableVersion);
    setMessage("Esta versión quedó descartada; no se volverá a avisar.");
    setActionError("");
  };

  return (
    <section
      aria-labelledby="update-center-title"
      className={cn("rounded-xl border border-base bg-primary p-3 space-y-3", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="update-center-title"
            className="flex items-center gap-2 text-sm font-bold text-primary"
          >
            <Sparkles size={15} className="text-violet-600" aria-hidden="true" />
            Actualizaciones firmadas
          </h3>
          <p className="text-sm font-medium text-muted">
            Manifiesto verificado con clave pública; la cadencia automática es de 24 h.
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sm font-semibold",
            TONE_BADGES[tone]
          )}
        >
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", TONE_DOTS[tone])} />
          {PHASE_LABELS[state.phase]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Versión actual
          </dt>
          <dd className="text-sm font-bold text-primary">{PRODUCT_DISPLAY_VERSION}</dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Canal</dt>
          <dd className="text-sm font-bold text-primary">stable</dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Plataforma
          </dt>
          <dd className="text-sm font-bold text-primary">{PLATFORM_LABELS[state.platform]}</dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Último chequeo
          </dt>
          <dd className="text-sm font-bold text-primary">{formatMoment(state.lastCheckAt)}</dd>
        </div>
      </dl>

      {state.phase === "unconfigured" && (
        <p className="rounded-lg border border-base bg-secondary p-2 text-sm font-medium leading-5 text-muted">
          {state.error ||
            "Esta instalación no tiene configurado el canal firmado de actualizaciones. Descarga la versión más reciente desde la página oficial de PALMYRA."}
        </p>
      )}

      {state.phase === "error" && state.error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium leading-6 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200"
        >
          <AlertTriangle size={15} className="mt-1 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{state.error}</span>
        </div>
      )}

      {state.phase === "blocked" && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
          <ShieldCheck size={15} className="mt-1 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {state.error ||
              "El manifiesto no pasó la verificación o no aplica a este equipo; no se ofrece instalar nada."}
          </span>
        </div>
      )}

      {state.phase === "unverified" && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
          <AlertTriangle size={15} className="mt-1 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            Hay una versión publicada sin firma verificable. No se instala nada hasta que el
            manifiesto esté firmado.
          </span>
        </div>
      )}

      {availableVersion !== "" && (
        <div className="rounded-lg border border-base bg-secondary p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-primary">
              Versión disponible {availableVersion}
            </p>
            {artifact && (
              <span className="text-sm font-medium text-muted">
                {artifact.name}
                {formatBytes(artifact.bytes) ? ` · ${formatBytes(artifact.bytes)}` : ""}
              </span>
            )}
          </div>
          {notes !== "" && (
            <div className="mt-1">
              <p className="whitespace-pre-line break-words text-sm font-medium leading-5 text-muted">
                {notesExpanded ? notes : notesPreview}
              </p>
              {notes.length > 220 && (
                <button
                  type="button"
                  onClick={() => setNotesExpanded((value) => !value)}
                  className="mt-1 text-sm font-semibold text-violet-700 underline decoration-violet-300 underline-offset-2 dark:text-violet-300"
                >
                  {notesExpanded ? "Ver menos" : "Ver más"}
                </button>
              )}
            </div>
          )}
          {dismissed && (
            <p className="mt-1 flex items-center gap-1 text-sm font-semibold text-muted">
              <X size={13} aria-hidden="true" /> Esta versión está descartada en este equipo.
            </p>
          )}
          {artifactMissing && (
            <p className="mt-1 text-sm font-medium text-muted">
              El manifiesto no publica un paquete para {PLATFORM_LABELS[state.platform]}.
            </p>
          )}
        </div>
      )}

      {actionError !== "" && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium leading-6 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200"
        >
          <AlertTriangle size={15} className="mt-1 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{actionError}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleCheck}
          disabled={busyOrChecking}
          aria-busy={checking}
          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(checking && "animate-spin")} aria-hidden="true" />
          {checking ? "Comprobando…" : "Buscar actualización"}
        </button>

        {availableVersion !== "" && state.platform !== "web" && (
          <button
            type="button"
            onClick={() => void handleInstall()}
            disabled={busyOrChecking || !artifact || dismissed}
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
          >
            <Download size={15} aria-hidden="true" />
            {busy ? "Instalando…" : "Instalar actualización"}
          </button>
        )}

        {availableVersion !== "" && (
          <button
            type="button"
            onClick={handleDismiss}
            disabled={dismissed}
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
          >
            <X size={15} aria-hidden="true" /> Descartar esta versión
          </button>
        )}
      </div>

      {state.platform === "web" && availableVersion !== "" && artifact && (
        <div className="rounded-lg border border-base bg-secondary p-2">
          <p className="text-sm font-medium leading-5 text-muted">
            La versión web no ejecuta el POS: descarga el instalador para el equipo donde trabajas.
          </p>
          <a
            href={artifact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-700 underline decoration-violet-300 underline-offset-2 dark:text-violet-300"
          >
            <Download size={14} aria-hidden="true" /> Descargar {artifact.name}
          </a>
        </div>
      )}

      {state.platform === "android" && availableVersion !== "" && !canInstallAndroid && (
        <p className="text-sm font-medium leading-5 text-muted">
          Este instalador de Android no admite actualización interna. Descarga el APK más reciente
          e instálalo encima de la app.
        </p>
      )}

      {state.platform === "windows" && availableVersion !== "" && !canInstallDesktop && (
        <p className="text-sm font-medium leading-5 text-muted">
          Esta ventana no expone el actualizador de escritorio. Abre PALMYRA desde la aplicación
          instalada para recibir la versión nueva.
        </p>
      )}

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-1.5 text-sm font-semibold",
          message !== "" ? "text-emerald-700 dark:text-emerald-300" : "text-muted"
        )}
      >
        {message !== "" && <CheckCircle2 size={14} aria-hidden="true" />}
        {message}
      </p>
    </section>
  );
}
