import type { LicenseSnapshot } from "./runtime";

/**
 * Derivaciones de presentación compartidas por el aviso flotante y
 * Configuración › Sistema. El estado de la licencia del EQUIPO se calcula una
 * sola vez y las dos superficies lo muestran igual: antes la tarjeta de
 * Configuración pintaba el plan de la nube como si fuera la licencia del
 * equipo y la burbuja decía «sin verificar», y la contradicción se leía como
 * un fallo. La nube es contexto, no la licencia del dispositivo.
 */

export type LicenseDisplayTone = "ok" | "warn" | "bad" | "idle";

export interface LicenseDisplayState {
  tone: LicenseDisplayTone;
  /** Palabra corta del estado del equipo (insignia). */
  label: string;
  /** Explicación en una línea, veraz sobre el dispositivo. */
  detail: string;
  /** La evaluación o la activación siguen en vuelo: no avisar de nada aún. */
  verifying: boolean;
  /** Hay una verificación buena recordada en este equipo (sello persistido). */
  remembered: boolean;
  /** «Verificada el 26 nov 2026, 14:32 · Growth» o null. */
  verifiedLabel: string | null;
}

/** Nombres comerciales del catálogo SaaS: el equipo nombra el plan igual que la nube. */
const PLAN_LABELS: Record<string, string> = {
  free: "Gratis",
  starter: "Oasis",
  growth: "Caravana",
  pro: "Ciudadela"
};

export function formatLicenseMoment(iso?: string | null, withYear = true): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString("es-CU", {
      day: "2-digit",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      hour: "2-digit",
      minute: "2-digit"
    });
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

function planLabel(planCode?: string): string | null {
  if (!planCode) return null;
  return PLAN_LABELS[planCode] || planCode.toUpperCase();
}

/** ¿La licencia del equipo está verificada ahora mismo (o lo estuvo)? */
export function isLicenseRemembered(snapshot: LicenseSnapshot): boolean {
  return Boolean(snapshot.lastVerifiedAt);
}

/**
 * Sello legible de la última verificación buena. Mientras el lease actual sea
 * válido se muestra su propia evaluación; si no, se conserva la última que sí
 * terminó bien, para que la fecha y hora no se pierdan entre arranques.
 */
export function licenseVerifiedLabel(snapshot: LicenseSnapshot): string | null {
  const moment = formatLicenseMoment(snapshot.lastVerifiedAt);
  if (!moment) return null;
  const plan = planLabel(snapshot.lastVerifiedPlan);
  return plan ? `Verificada el ${moment} · ${plan}` : `Verificada el ${moment}`;
}

/**
 * Estado del dispositivo según la evaluación real del runtime. Con lectura
 * limitada manda el bloqueo; una activación pendiente en vuelo es neutra
 * («Verificando…») y solo se nombra cuando el intento concluyó.
 */
export function deriveLicenseDisplay(
  snapshot: LicenseSnapshot,
  nowMs = Date.now()
): LicenseDisplayState {
  const verifying =
    snapshot.mode === "loading" ||
    (snapshot.pendingActivation && snapshot.activationSettled !== true);
  const remembered = isLicenseRemembered(snapshot);
  const verifiedLabel = licenseVerifiedLabel(snapshot);

  if (!snapshot.keyConfigured && snapshot.mode === "unmanaged") {
    return {
      tone: "idle",
      label: "Sin verificar",
      detail:
        "Este equipo no tiene la clave de verificación de licencias. La app sigue operando; la licencia se comprobará cuando la clave esté disponible.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.mode === "revoked") {
    return {
      tone: "bad",
      label: "Licencia retirada",
      detail:
        "Tu licencia fue revocada: la app está en solo lectura. Contacta al proveedor; tus datos no se borran.",
      verifying: false,
      remembered: false,
      verifiedLabel
    };
  }
  if (snapshot.mode === "expired") {
    return {
      tone: "bad",
      label: "Vencida",
      detail:
        "La suscripción venció: la app está en solo lectura. Renueva el plan para volver a operar; tus datos no se borran.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.readOnly) {
    return {
      tone: "bad",
      label: "Solo lectura",
      detail:
        "Ahora mismo solo puedes consultar y exportar. Renueva el plan para volver a operar con normalidad; tus datos no se borran.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (verifying) {
    return {
      tone: "idle",
      label: "Verificando…",
      detail:
        "Comprobando la licencia de este equipo. Mientras tanto la app opera con normalidad.",
      verifying: true,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.mode === "invalid") {
    return {
      tone: "warn",
      label: "Por revisar",
      detail:
        snapshot.reason === "device-key-rotated"
          ? "La identidad de este equipo cambió y el lease emitido ya no le corresponde. Conéctate y pulsa Renovar para reactivarla; mientras tanto sigues operando."
          : "La licencia guardada no se pudo verificar. Se repara sola en cuanto haya conexión; mientras tanto sigues operando con normalidad.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.pendingActivation) {
    const needsSignIn =
      String(snapshot.activationError ?? "").startsWith("no-session") ||
      String(snapshot.activationError ?? "").startsWith("server-rejected:401");
    return {
      tone: "warn",
      label: remembered ? "Verificada antes" : "Sin licencia",
      detail: remembered
        ? `Este arranque no pudo confirmar la licencia, pero el equipo quedó verificado ${verifiedLabel ? `el ${formatLicenseMoment(snapshot.lastVerifiedAt, false) ?? ""}` : "antes"}. Sigue operando y se confirmará sola al tener conexión.`
        : needsSignIn
          ? "Este equipo no tiene una licencia emitida. Entra con tu usuario o enlace de acceso una vez para activar la licencia comprada; mientras tanto sigues operando con normalidad."
          : "Este equipo todavía no tiene licencia emitida; la activación se reintenta sola en cuanto haya conexión. Mientras tanto sigues operando con normalidad.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.mode === "free") {
    return {
      tone: "ok",
      label: "Activa",
      detail:
        "Plan Gratis: no requiere pago y no tiene vencimiento. Funciona sin internet de forma indefinida.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.mode === "unmanaged") {
    return {
      tone: "ok",
      label: "Activa",
      detail:
        "Este equipo aún no tiene un plan asignado. Puedes seguir operando; la licencia se comprueba sola en segundo plano.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.clockWarning) {
    return {
      tone: "warn",
      label: "Reloj atrasado",
      detail:
        "La fecha del equipo está atrasada. Ajusta el reloj para que la licencia se evalúe bien; tus datos no se borran.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  if (snapshot.mode === "grace") {
    return {
      tone: "warn",
      label: "Periodo de gracia",
      detail:
        "El plan está en periodo de gracia. Renueva para evitar el modo solo lectura; tus datos no se borran.",
      verifying: false,
      remembered,
      verifiedLabel
    };
  }
  const offlineDays = daysUntil(snapshot.offlineUntil, nowMs);
  const paidDays = daysUntil(snapshot.paidThrough, nowMs);
  const soon =
    (offlineDays !== null && offlineDays <= 7) || (paidDays !== null && paidDays <= 7);
  return {
    tone: soon ? "warn" : "ok",
    label: soon ? "Por vencer" : "Activa",
    detail: soon
      ? "La licencia está por vencer. Renueva para evitar el modo solo lectura; tus datos no se borran."
      : "La licencia se comprueba sola en segundo plano; si vence, la app pasa a solo lectura y tus datos se conservan.",
    verifying: false,
    remembered,
    verifiedLabel
  };
}
