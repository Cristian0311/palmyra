/**
 * Avisos del sistema operativo (bandeja de Windows / panel de Android).
 *
 * La campana de PALMYRA y el feed local siempre existen; esto es lo otro: que el
 * sistema lo muestre aunque la app esté minimizada o cerrada. Cada superficie lo
 * resuelve distinto y ninguna puede prometer lo que la otra tiene:
 *
 *  - APK: la WebView no implementa la API Web de notificaciones, así que se pide
 *    al shell (`PALMYRA_NATIVE.showNotification`) que use NotificationManager.
 *  - PC (Electron): no hay Service Worker a propósito, pero la API `Notification`
 *    sí funciona; en Windows necesita el AppUserModelID que fija main.electron.cjs.
 *  - PWA: se usa el registration del worker de push cuando existe (Android lo
 *    exige) y `new Notification` como respaldo.
 *
 * Reglas: nunca pide permisos (eso lo hace NotificationsPermissionPrompt al
 * entrar), nunca lanza excepciones y no duplica: la misma `tag` reemplaza el
 * aviso anterior en lugar de acumularse.
 */

import { hasNativeAlertBridge, showNativeNotification } from "./nativeApp";

export type OsAlertResult = "sent" | "denied" | "unsupported" | "failed";

export interface OsAlertInput {
  title: string;
  body?: string;
  /** Agrupa avisos: la misma tag reemplaza al anterior. */
  tag?: string;
  /** Ruta que abre el aviso al hacer clic (solo superficies con worker). */
  url?: string;
}

const ICON = "/pwa-192.png";
const DEFAULT_TAG = "palmyra-notice";

function trim(value: string | undefined, max: number): string {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Verdadero si esta superficie puede, en principio, publicar un aviso del sistema. */
export function osAlertSupported(): boolean {
  if (hasNativeAlertBridge()) return true;
  return typeof window !== "undefined" && typeof Notification !== "undefined";
}

/**
 * Publica el aviso. Devuelve el resultado para que el llamador pueda registrar
 * por qué no salió; nunca interrumpe lo que lo originó.
 */
export async function publishOsAlert(input: OsAlertInput): Promise<OsAlertResult> {
  const title = trim(input.title, 90) || "PALMYRA";
  const body = trim(input.body, 400);
  const tag = trim(input.tag, 60) || DEFAULT_TAG;

  if (hasNativeAlertBridge()) {
    return showNativeNotification(title, body, tag);
  }

  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "granted") return "denied";

  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      registration.showNotification(title, {
        body,
        icon: ICON,
        badge: ICON,
        tag,
        data: { url: input.url || "/notifications" },
      });
      return "sent";
    }
  } catch {
    // Sin worker accesible (permiso recién concedido o contexto sin worker):
    // se intenta la API directa antes de rendirse.
  }

  try {
    new Notification(title, { body, icon: ICON, tag });
    return "sent";
  } catch {
    return "failed";
  }
}

/**
 * Aviso de prueba: es lo que se dispara desde el centro de notificaciones para
 * comprobar en segundos si la superficie realmente publica.
 */
export function publishTestAlert(): Promise<OsAlertResult> {
  return publishOsAlert({
    title: "PALMYRA puede avisarte desde el sistema",
    body: "Si ves este aviso en la bandeja, los avisos de stock, tasas y turnos también llegarán ahí.",
    tag: "palmyra-test",
    url: "/notifications",
  });
}
