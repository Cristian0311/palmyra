import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, CalendarClock, Clock, Download } from "lucide-react";
import { useLicenseRuntime } from "../../hooks/useLicenseRuntime";
import type { LicenseSnapshot } from "../../services/license/runtime";

/**
 * Aviso discreto del estado de la licencia dentro del shell autenticado.
 *
 * Se muestra cuando la licencia todavía permite escribir pero está a punto de
 * cambiar (ventana de gracia, menos de 7 días de `paidThrough`/`offlineUntil`) o
 * cuando el reloj del equipo quedó atrasado respecto de la hora verificada. El
 * aviso de solo lectura ya lo publica `LicenseReadOnlyBanner` dentro de Layout,
 * así que aquí solo se repite —con fecha límite y exportación— si esa tarjeta
 * fue descartada en la sesión: nunca se duplican los dos avisos a la vez.
 *
 * Nunca oculta datos ni bloquea la navegación: la exportación y el respaldo
 * siguen disponibles en solo lectura (el bloqueo es solo de escritura).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Antelación con la que se avisa del vencimiento del plan. */
const WARN_WINDOW_DAYS = 7;
const RENEW_PATH = "/subscription";
/** Respaldo y exportación de datos: sección existente, permitida en solo lectura. */
const EXPORT_PATH = "/settings?section=advanced";
/** Clave de sesión del aviso de solo lectura de Layout (solo para no duplicarlo). */
const LEGACY_READ_ONLY_DISMISS_KEY = "palmyra_license_readonly_dismissed_v1";

interface LicenseNotice {
  tone: "warning" | "danger";
  title: string;
  message: string;
  /** Fecha límite relevante (offlineUntil o paidThrough), ya formateada. */
  deadline?: string;
  showRenew: boolean;
}

function parseMs(value?: string | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Días completos que faltan (puede ser negativo si ya pasó). */
function daysUntil(value: string | undefined | null, nowMs: number): number | null {
  const ms = parseMs(value);
  if (ms === null) return null;
  return Math.ceil((ms - nowMs) / DAY_MS);
}

function formatDeadline(value: string | undefined | null): string | undefined {
  const ms = parseMs(value);
  if (ms === null) return undefined;
  try {
    return new Date(ms).toLocaleDateString("es-ES", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  } catch {
    return undefined;
  }
}

function legacyReadOnlyNoticeDismissed(): boolean {
  try {
    return (
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem(LEGACY_READ_ONLY_DISMISS_KEY) === "1"
    );
  } catch {
    return false;
  }
}

/** Decide el aviso; devuelve null cuando no hay nada que contar. */
export function resolveLicenseNotice(
  snapshot: LicenseSnapshot,
  nowMs: number
): LicenseNotice | null {
  if (!snapshot || snapshot.mode === "loading") return null;

  if (snapshot.readOnly) {
    // La tarjeta de solo lectura de Layout ya muestra estado y renovación.
    if (!legacyReadOnlyNoticeDismissed()) return null;
    return {
      tone: "danger",
      title: "Licencia en solo lectura",
      message:
        snapshot.message ||
        "La app está en solo lectura: puedes consultar y exportar todo tu historial. Tus datos no se borran.",
      deadline: formatDeadline(snapshot.offlineUntil),
      showRenew: true
    };
  }

  // Reloj atrasado: la ventana quedó congelada y no se recuperan días.
  if (snapshot.clockWarning) {
    return {
      tone: "warning",
      title: "Fecha del equipo atrasada",
      message:
        "El reloj del equipo va por detrás de la hora verificada. Ajusta la fecha y reconecta; mientras tanto consultar y exportar siguen disponibles.",
      showRenew: false
    };
  }

  const offlineDays = daysUntil(snapshot.offlineUntil, nowMs);
  const paidDays = daysUntil(snapshot.paidThrough, nowMs);
  const soonOffline = offlineDays !== null && offlineDays < WARN_WINDOW_DAYS;
  const soonPaid = paidDays !== null && paidDays < WARN_WINDOW_DAYS;
  if (!soonOffline && !soonPaid) return null;

  const offlineDate = formatDeadline(snapshot.offlineUntil);
  const paidDate = formatDeadline(snapshot.paidThrough);

  if (snapshot.mode === "grace") {
    return {
      tone: "warning",
      title: "Ventana de gracia",
      message: paidDate
        ? `Tu plan venció el ${paidDate}. Puedes seguir vendiendo sin internet hasta el ${offlineDate ?? "límite firmado"}; después la app pasa a solo lectura y tus datos se conservan.`
        : `Tu plan venció y estás en la ventana de gracia: al terminar, la app pasa a solo lectura y tus datos se conservan.`,
      deadline: offlineDate,
      showRenew: true
    };
  }

  const days = offlineDays ?? paidDays ?? 0;
  return {
    tone: "warning",
    title: days > 0 ? "Tu plan vence pronto" : "Tu plan está por vencer",
    message:
      days > 0
        ? `Te quedan ${days} ${days === 1 ? "día" : "días"} de operación sin internet (hasta el ${offlineDate ?? paidDate ?? "límite firmado"}). Renueva para no pasar a solo lectura.`
        : `El periodo pagado terminó: renueva para no pasar a solo lectura. Consultar y exportar siguen disponibles.`,
    deadline: offlineDate ?? paidDate,
    showRenew: true
  };
}

export function LicenseBanner() {
  const { snapshot } = useLicenseRuntime();
  const notice = resolveLicenseNotice(snapshot, Date.now());
  if (!notice) return null;

  const danger = notice.tone === "danger";
  const Icon = danger ? AlertTriangle : snapshot.clockWarning ? Clock : CalendarClock;

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        danger
          ? "fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[272] rounded-2xl border border-rose-300 bg-rose-50/95 px-3.5 py-3 shadow-lg backdrop-blur-sm dark:border-rose-900/60 dark:bg-rose-950/90 sm:inset-x-auto sm:right-4 sm:w-[min(92vw,24rem)] motion-safe:transition-colors"
          : "fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[272] rounded-2xl border border-amber-300 bg-amber-50/95 px-3.5 py-3 shadow-lg backdrop-blur-sm dark:border-amber-900/60 dark:bg-amber-950/90 sm:inset-x-auto sm:right-4 sm:w-[min(92vw,24rem)] motion-safe:transition-colors"
      }
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={
            danger
              ? "mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400"
              : "mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          }
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p
            className={
              danger
                ? "text-[9px] font-black uppercase tracking-[0.14em] text-rose-800 dark:text-rose-300"
                : "text-[9px] font-black uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300"
            }
          >
            {notice.title}
          </p>
          <p
            className={
              danger
                ? "mt-1 text-[11px] font-bold leading-4 text-rose-900 dark:text-rose-100"
                : "mt-1 text-[11px] font-bold leading-4 text-amber-900 dark:text-amber-100"
            }
          >
            {notice.message}
          </p>
          {notice.deadline ? (
            <p
              className={
                danger
                  ? "mt-1 text-[10px] font-semibold leading-4 text-rose-700 dark:text-rose-300"
                  : "mt-1 text-[10px] font-semibold leading-4 text-amber-700 dark:text-amber-300"
              }
            >
              Fecha límite: {notice.deadline}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {notice.showRenew ? (
              <Link
                to={RENEW_PATH}
                className={
                  danger
                    ? "inline-flex items-center gap-1 rounded text-[10px] font-black uppercase tracking-wider text-rose-900 underline decoration-rose-400 underline-offset-2 hover:text-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 dark:text-rose-200"
                    : "inline-flex items-center gap-1 rounded text-[10px] font-black uppercase tracking-wider text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:text-amber-200"
                }
              >
                Renovar plan <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            ) : null}
            <Link
              to={EXPORT_PATH}
              className={
                danger
                  ? "inline-flex items-center gap-1 rounded text-[10px] font-black uppercase tracking-wider text-rose-900 underline decoration-rose-400 underline-offset-2 hover:text-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 dark:text-rose-200"
                  : "inline-flex items-center gap-1 rounded text-[10px] font-black uppercase tracking-wider text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:text-amber-200"
              }
            >
              Exportar datos <Download className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LicenseBanner;
