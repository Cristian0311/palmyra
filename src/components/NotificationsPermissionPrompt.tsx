import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { cn } from "../lib/utils";
import { queryNativePermissionStatus, requestNativeHardwarePermissions } from "../lib/nativeApp";

/**
 * Aviso de entrada: PALMYRA pide el permiso de notificaciones del sistema.
 *
 * El permiso sirve para dos cosas y la copia lo dice sin tecnicismos: los avisos
 * push del navegador (PC/PWA) y las notificaciones locales del centro de
 * avisos dentro de la app. En el APK no hay Web Push, pero el permiso sí se
 * necesita (POST_NOTIFICATIONS desde Android 13) para que el sistema muestre
 * los avisos del centro in-app.
 *
 * Reglas de producto:
 * - Nunca bloquea la app: es una tarjeta flotante descartable.
 * - Se ofrece desde el primer arranque: sin permiso no hay avisos del sistema,
 *   y el dueño necesita activarlos al entrar.
 * - No aparece si el permiso ya está concedido o denegado (el navegador solo
 *   da una oportunidad y repetir sería ruido).
 * - Si el usuario lo descarta, se recuerda en localStorage y no se vuelve a
 *   ofrecer hasta que cambie el estado del permiso.
 */

/** Clave de localStorage del descarte (versionada: cambiarla reabre el aviso). */
export const NOTIFICATIONS_PROMPT_DISMISS_KEY = "palmyra.notificationsPrompt.v1";
/** Marca de que ya se pidió el permiso desde este aviso. */
export const NOTIFICATIONS_PROMPT_ASKED_KEY = "palmyra.notificationsPrompt.asked.v1";
/** Primer arranque registrado en este equipo; manda el propio aviso al leerlo. */
export const NOTIFICATIONS_PROMPT_FIRST_RUN_KEY = "palmyra:first-run-ms";
/** Cuántos días sigue ofreciéndose tras el primer arranque sin permiso. */
export const NOTIFICATIONS_PROMPT_OFFER_DAYS = 30;
/** Ruta del centro de notificaciones (coincide con App.tsx / Layout.tsx). */
export const NOTIFICATIONS_CENTER_PATH = "/settings?section=notifications";

const DAY_MS = 24 * 60 * 60 * 1000;

export type NotificationsPromptFacts = {
  /** `Notification.permission`; undefined si el entorno no tiene la API. */
  permission: NotificationPermission | undefined;
  dismissed: boolean;
  alreadyAsked: boolean;
  installedMsAgo: number;
  /** Superficie Android (APK): aquí no hay push, pero el permiso sí cuenta. */
  isAndroidApp: boolean;
  /**
   * POST_NOTIFICATIONS concedido según el shell. `undefined` = el APK no lo
   * reporta (shell anterior) y hay que ofrecer el aviso igualmente.
   */
  nativeNotificationsGranted?: boolean;
};

export type NotificationsPromptDecision = { show: boolean; reason: string };

/**
 * Decide si debe mostrarse el aviso. Puro y determinista para poder probarlo:
 * recibe los hechos ya leídos del entorno y devuelve la decisión.
 */
export function shouldShowNotificationsPrompt(facts: NotificationsPromptFacts): NotificationsPromptDecision {
  if (facts.isAndroidApp) {
    // En el APK manda el permiso del sistema (POST_NOTIFICATIONS). La API Web de
    // notificaciones de la WebView devuelve "denied" siempre, así que no puede
    // decidir: si el shell ya confirmó el permiso, el aviso sobra.
    if (facts.dismissed) return { show: false, reason: "dismissed" };
    if (facts.nativeNotificationsGranted === true) return { show: false, reason: "native-granted" };
    return { show: true, reason: "android-native" };
  }
  if (facts.permission === undefined) return { show: false, reason: "no-notification-api" };
  if (facts.permission === "granted") return { show: false, reason: "already-granted" };
  if (facts.permission === "denied") return { show: false, reason: "already-denied" };
  if (facts.dismissed) return { show: false, reason: "dismissed" };
  // El umbral de días solo frena a quien ya fue preguntado: un equipo nuevo sin
  // permiso debe recibir el aviso en cuanto entra.
  if (facts.installedMsAgo > NOTIFICATIONS_PROMPT_OFFER_DAYS * DAY_MS && facts.alreadyAsked) {
    return { show: false, reason: "asked-too-often" };
  }
  return { show: true, reason: "default-permission" };
}

function readFlag(key: string): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage?.setItem(key, "1");
  } catch {
    // Modo privado sin cuota: el aviso simplemente podrá repetirse.
  }
}

/**
 * Antigüedad del equipo en milisegundos. El sello se escribe aquí la primera vez:
 * si nadie lo guarda, `installedMsAgo` queda desconocido y el aviso nunca se
 * ofrece. Un equipo sin sello es recién instalado, así que cuenta como 0.
 */
function readInstallAgeMs(): number {
  try {
    const raw = localStorage?.getItem(NOTIFICATIONS_PROMPT_FIRST_RUN_KEY);
    const value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) {
      localStorage?.setItem(NOTIFICATIONS_PROMPT_FIRST_RUN_KEY, String(Date.now()));
      return 0;
    }
    return Math.max(0, Date.now() - value);
  } catch {
    // Sin almacenamiento (modo privado sin cuota): no se puede medir la
    // antigüedad, pero el aviso sigue siendo útil.
    return 0;
  }
}

function currentPermission(): NotificationPermission | undefined {
  if (typeof window === "undefined" || typeof Notification === "undefined") return undefined;
  return Notification.permission;
}

export interface NotificationsPermissionPromptProps {
  /** Devuelve true si el permiso quedó concedido (para cerrar la tarjeta). */
  onResult?: (granted: boolean) => void;
}

export default function NotificationsPermissionPrompt({ onResult }: NotificationsPermissionPromptProps) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [androidApp, setAndroidApp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Se difiere: el arranque ya abre el selector de instalación y la hidratación;
    // el permiso de notificaciones va después del primer paint.
    const timer = setTimeout(async () => {
      if (cancelled) return;
      const isAndroid = Boolean(window.PALMYRA_NATIVE) || /PALMYRAApp\//i.test(navigator.userAgent || "");
      // El shell puede decir si POST_NOTIFICATIONS ya está concedido; cuando no
      // responde (shell viejo) se ofrece el aviso normal.
      const status = isAndroid ? await queryNativePermissionStatus() : null;
      if (cancelled) return;
      setAndroidApp(isAndroid);
      setVisible(
        shouldShowNotificationsPrompt({
          permission: currentPermission(),
          dismissed: readFlag(NOTIFICATIONS_PROMPT_DISMISS_KEY),
          alreadyAsked: readFlag(NOTIFICATIONS_PROMPT_ASKED_KEY),
          installedMsAgo: readInstallAgeMs(),
          isAndroidApp: isAndroid,
          nativeNotificationsGranted: status?.notifications
        }).show
      );
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    writeFlag(NOTIFICATIONS_PROMPT_DISMISS_KEY);
    setVisible(false);
  };

  const ask = async () => {
    if (busy) return;
    setBusy(true);
    writeFlag(NOTIFICATIONS_PROMPT_ASKED_KEY);
    if (androidApp) {
      // Dentro del APK no hay Web Push: lo que decide si el centro de avisos
      // funciona es el permiso del sistema, que además trae Bluetooth/USB para la
      // impresora. Un solo diálogo cubre las tres cosas.
      const outcome = await requestNativeHardwarePermissions();
      onResult?.(outcome.ok);
      if (!outcome.ok) writeFlag(NOTIFICATIONS_PROMPT_DISMISS_KEY);
      setVisible(false);
      setBusy(false);
      return;
    }
    if (typeof Notification === "undefined") {
      setBusy(false);
      return;
    }
    try {
      const result = await Notification.requestPermission();
      const granted = result === "granted";
      onResult?.(granted);
      if (!granted) writeFlag(NOTIFICATIONS_PROMPT_DISMISS_KEY);
      setVisible(false);
    } catch {
      // El navegador puede rechazar la petición fuera de un gesto de usuario:
      // no se rompe nada, el botón queda disponible en Notificaciones.
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[var(--z-tooltip)]",
        "rounded-2xl border border-violet-200 bg-white/95 px-3.5 py-3 shadow-lg backdrop-blur-sm",
        "sm:inset-x-auto sm:right-4 sm:w-[min(92vw,24rem)]"
      )}
    >
      <div className="flex items-start gap-2.5">
        <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-800">
            Avisos de PALMYRA
          </p>
          <p className="mt-1 text-[11px] font-bold leading-4 text-slate-700">
            Activa los avisos para enterarte de stock bajo, cambios de tasa y cierres de turno aunque
            tengas la app cerrada.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <button
              type="button"
              onClick={() => void ask()}
              disabled={busy}
              className="inline-flex items-center rounded bg-violet-600 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider text-white hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 disabled:opacity-60"
            >
              {busy ? "Pidiendo…" : "Activar avisos"}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex items-center rounded text-[10px] font-black uppercase tracking-wider text-slate-500 underline underline-offset-2 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              Ahora no
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Cerrar el aviso de notificaciones"
          className="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-subtle flex items-center justify-center"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
