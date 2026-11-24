import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, Loader2, Lock, X } from "lucide-react";
import { renewLicenseRuntime, useLicenseRuntime } from "../hooks/useLicenseRuntime";
import type { LicenseSnapshot } from "../services/license/runtime";

const DISMISS_KEY = "palmyra_license_readonly_dismissed_v1";
const WARN_DISMISS_KEY = "palmyra_license_unverified_dismissed_v1";

const EXPIRED_TEXT =
  "Tu suscripción venció: la app está en solo lectura. Renueva para seguir vendiendo. Tus datos no se borran.";
const UNVERIFIED_TEXT =
  "No pudimos verificar la licencia de este equipo: la app está en solo lectura. Renueva o revisa la licencia para seguir vendiendo. Tus datos no se borran.";

function readFlag(key: string): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // Sin sessionStorage el aviso simplemente no se puede descartar.
  }
}

/** Avisos no bloqueantes: el runtime nunca pone readOnly por estas causas. */
function unverifiedMessage(snapshot: LicenseSnapshot): string | null {
  if (!snapshot.keyConfigured || snapshot.readOnly) return null;
  // Verificado con el lease guardado dentro de la ventana firmada: aunque no
  // haya red, la licencia está verificada y no hay nada que avisar.
  if (snapshot.offlineVerified) return null;
  if (snapshot.mode === "invalid") {
    if (snapshot.reason === "device-key-rotated") {
      return "La identidad de este equipo cambió y la licencia emitida ya no le corresponde. Conéctate a internet y pulsa Renovar para activarla de nuevo; mientras tanto puedes seguir operando. Tus datos no se borran.";
    }
    return "No pudimos verificar la licencia de este equipo. Puedes seguir operando; renueva para evitar bloqueos. Tus datos no se borran.";
  }
  if (snapshot.mode === "unmanaged" && snapshot.reason === "lease-missing") {
    // Solo es «sin verificar» cuando la evaluación terminó y el intento de
    // activación ya concluyó sin lease. Mientras el intento esté en vuelo
    // (activationSettled false) se muestra el estado neutro «verificando»,
    // nunca este aviso: el orden correcto es cargar primero y avisar después.
    if (!snapshot.pendingActivation || !snapshot.activationSettled) return null;
    return "Licencia sin verificar: este equipo todavía no tiene una licencia emitida. Conéctate a internet y pulsa Renovar; mientras tanto puedes seguir operando.";
  }
  return null;
}

/**
 * Aviso global de solo lectura. Se descarta por sesión, pero el modo sigue
 * visible como franja fina: ocultar el aviso no puede ocultar el bloqueo.
 *
 * Orden garantizado: mientras la licencia se evalúa (o una activación
 * pendiente tiene su intento de red en vuelo) solo se muestra el estado neutro
 * «Verificando licencia…»; el aviso de «Licencia sin verificar» aparece
 * únicamente cuando la evaluación concluyó sin lease. El botón Renovar
 * re-evalúa de verdad (fuerza `issue-lease`) y el estado se actualiza solo.
 */
export function LicenseReadOnlyBanner() {
  const { snapshot } = useLicenseRuntime();
  const [dismissed, setDismissed] = useState<boolean>(() => readFlag(DISMISS_KEY));
  const [warningDismissed, setWarningDismissed] = useState<boolean>(() => readFlag(WARN_DISMISS_KEY));
  const [renewing, setRenewing] = useState(false);

  /** Reintenta la evaluación de verdad y fuerza la renovación: el runtime
   *  republica el estado, así que el aviso se cierra solo si la licencia llega. */
  const renew = () => {
    if (renewing) return;
    setRenewing(true);
    void renewLicenseRuntime().finally(() => setRenewing(false));
  };

  // Evaluación en curso: estado neutro, sin iconos de error y sin bloquear.
  // Cubre el arranque (mode loading) y la activación pendiente mientras su
  // intento de red sigue en vuelo (pendingActivation sin activationSettled).
  // El aviso alarmante solo puede salir cuando la evaluación termina.
  const verifying =
    snapshot.mode === "loading" || (snapshot.pendingActivation && !snapshot.activationSettled);
  if (verifying) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[var(--z-tooltip)] flex justify-center"
      >
        <div className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/85 px-3 py-1 shadow-sm backdrop-blur-sm dark:border-slate-700 dark:bg-slate-900/85">
          <Loader2
            className="h-3 w-3 animate-spin text-slate-400 dark:text-slate-500"
            aria-hidden="true"
          />
          <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
            Verificando licencia…
          </span>
        </div>
      </div>
    );
  }

  if (!snapshot.readOnly) {
    const warning = unverifiedMessage(snapshot);
    if (!warning || warningDismissed) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[var(--z-tooltip)] rounded-2xl border border-amber-200 bg-amber-50/95 px-3 py-2.5 shadow-lg backdrop-blur-sm dark:border-amber-900/50 dark:bg-amber-950/85 sm:inset-x-auto sm:left-1/2 sm:w-[min(92vw,32rem)] sm:-translate-x-1/2 motion-safe:transition-colors"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-black uppercase tracking-[0.12em] text-amber-800 dark:text-amber-300">
              Licencia sin verificar
            </p>
            <p className="mt-0.5 text-[10px] font-bold leading-4 text-amber-900 dark:text-amber-100">{warning}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={renew}
                disabled={renewing}
                className="inline-flex items-center gap-1 rounded text-[9px] font-black uppercase tracking-wider text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 disabled:cursor-wait disabled:opacity-60 dark:text-amber-200"
              >
                {renewing ? "Verificando…" : "Renovar"}
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </button>
              <Link
                to="/subscription"
                className="rounded text-[9px] font-black uppercase tracking-wider text-amber-800/80 underline decoration-amber-300 underline-offset-2 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:text-amber-200/80"
              >
                Ver planes
              </Link>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              writeFlag(WARN_DISMISS_KEY);
              setWarningDismissed(true);
            }}
            className="shrink-0 rounded-lg p-1 text-amber-700 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/50"
            aria-label="Ocultar el aviso de licencia sin verificar"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  const dismiss = () => {
    writeFlag(DISMISS_KEY);
    setDismissed(true);
  };

  if (dismissed) {
    return (
      <div
        role="status"
        className="fixed inset-x-0 top-0 z-[var(--z-tooltip)] flex items-center justify-center gap-2 bg-amber-500 px-3 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-amber-950 shadow-sm motion-safe:transition-colors"
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
        <span>Solo lectura</span>
        <Link
          to="/subscription"
          className="rounded underline decoration-amber-800 underline-offset-2 hover:text-amber-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-900"
        >
          Renovar
        </Link>
      </div>
    );
  }

  const message = snapshot.mode === "expired" ? EXPIRED_TEXT : UNVERIFIED_TEXT;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[var(--z-tooltip)] rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-3 shadow-xl dark:border-amber-900/60 dark:bg-amber-950/90 sm:inset-x-auto sm:left-1/2 sm:w-[min(92vw,34rem)] sm:-translate-x-1/2 motion-safe:transition-colors motion-safe:duration-200"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
            Licencia en solo lectura
          </p>
          <p className="mt-1 text-[11px] font-bold leading-4 text-amber-900 dark:text-amber-100">
            {message}
          </p>
          {snapshot.clockWarning && (
            <p className="mt-1 text-[10px] font-semibold leading-4 text-amber-700 dark:text-amber-300">
              La fecha del equipo está atrasada. Ajusta el reloj para que la licencia se evalúe bien.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={renew}
              disabled={renewing}
              className="inline-flex items-center gap-1 rounded text-[10px] font-black uppercase tracking-wider text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 disabled:cursor-wait disabled:opacity-60 dark:text-amber-200 dark:hover:text-amber-100"
            >
              {renewing ? "Verificando…" : "Renovar"}
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </button>
            <Link
              to="/subscription"
              className="rounded text-[10px] font-black uppercase tracking-wider text-amber-800/80 underline decoration-amber-300 underline-offset-2 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:text-amber-200/80"
            >
              Ver planes
            </Link>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-lg p-1 text-amber-700 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/50"
          aria-label="Ocultar el aviso de solo lectura"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
