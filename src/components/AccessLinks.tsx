import React from "react";
import { Check, Clock, Link2, RefreshCw, X } from "lucide-react";
import {
  ACCESS_INVITE_DAY_OPTIONS,
  accessLinkStatus,
  describeAccessLink,
  resolveAccessInviteExpiry,
  type AccessLinkStatus,
  type DeviceAccessLink
} from "../services/deviceAccess";

interface AccessLinksProps {
  /**
   * Enlaces vivos leídos del servidor. `null` significa que todavía no se pudieron
   * leer (sin red o migración pendiente): la UI no debe inventar que no hay.
   */
  links: DeviceAccessLink[] | null;
  loading?: boolean;
  revoking?: boolean;
  error?: string;
  onRevoke?: (ids: string[]) => void;
}

const STATUS_CLASS: Record<AccessLinkStatus, string> = {
  active: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-300",
  used: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300",
  expired: "border-base bg-subtle text-muted"
};

const STATUS_WORD: Record<AccessLinkStatus, string> = {
  active: "Activo",
  used: "Usado",
  expired: "Caducado"
};

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString("es-CU", {
    day: "2-digit", month: "short", year: "numeric"
  });
}

/**
 * Enlaces ACTIVOS de un trabajador, leídos de `list_device_access_links`. El
 * servidor ya no muestra los caducados: los elimina, así que aquí solo hay
 * enlaces que todavía sirven. Lo usan las dos superficies de Equipo (el diálogo
 * del menú de la fila y la pestaña «Acceso» del editor) para que ambas pinten la
 * misma lista.
 *
 * El token en claro no aparece aquí ni puede aparecer: se entrega una sola vez,
 * al crearlo.
 */
export default function AccessLinks({ links, loading, revoking, error, onRevoke }: AccessLinksProps) {
  const rows = links || [];
  const liveIds = rows.filter(link => accessLinkStatus(link) === 'active').map(link => link.id);

  return (
    <div className="rounded-2xl border border-base bg-subtle p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">
          <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Enlaces de este trabajador
        </p>
        <span className="text-[10px] font-black text-muted" aria-live="polite">
          {loading
            ? "Consultando…"
            : `${liveIds.length} ${liveIds.length === 1 ? "enlace activo" : "enlaces activos"}`}
        </span>
      </div>

      {loading ? (
        <p className="mt-2 inline-flex items-center gap-2 text-[11px] font-bold text-muted">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Consultando el servidor…
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-[11px] font-bold leading-5 text-muted">
          {links === null
            ? "No se pudo consultar el estado de los enlaces en el servidor."
            : "Este trabajador no tiene enlaces de acceso activos."}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map(link => {
            const status = accessLinkStatus(link);
            return (
              <li key={link.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black ${STATUS_CLASS[status]}`}>
                  {status === 'used' && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
                  {STATUS_WORD[status]}
                </span>
                <span className="min-w-0 flex-1 text-[11px] font-bold leading-5 text-primary">
                  {describeAccessLink(link)}
                  <span className="block text-[10px] font-bold text-muted">Creado {formatDate(link.createdAt)}</span>
                </span>
                {status === 'active' && onRevoke && (
                  <button
                    type="button"
                    onClick={() => onRevoke([link.id])}
                    disabled={revoking}
                    aria-label={`Revocar enlace de acceso creado el ${formatDate(link.createdAt)}`}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-xl border border-base bg-secondary px-2.5 text-[10px] font-black uppercase tracking-wider text-[var(--danger)] disabled:opacity-55"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" /> Revocar
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {liveIds.length > 0 && (
        <p className="mt-2 inline-flex items-start gap-1.5 text-[10px] font-bold leading-4 text-amber-700 dark:text-amber-300">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Solo puede haber un enlace activo. Para generar otro, revoca y elimina este primero.
        </p>
      )}

      {error && (
        <p className="mt-2 text-[11px] font-bold leading-5 text-[var(--danger)]">{error}</p>
      )}

      <p className="mt-2 text-[10px] font-bold leading-4 text-muted">
        Cada enlace funciona una sola vez y se elimina al caducar: al día siguiente el
        dispositivo que lo abra verá que el enlace caducó.
      </p>
    </div>
  );
}

interface AccessLinkDurationProps {
  /** Días preseleccionados: la preferencia sincronizada de la empresa. */
  days: number;
  busy?: boolean;
  onPick: (days: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Pregunta la duración ANTES de cuajar el token. El dueño elegía «1 día» en un
 * móvil y el otro generaba 7 porque la opción vivía en memoria del componente;
 * ahora el tiempo se elige en el momento de generar y se guarda como preferencia
 * de empresa, así que el selector arranca igual en todos los dispositivos.
 */
export function AccessLinkDuration({ days, busy, onPick, onConfirm, onCancel }: AccessLinkDurationProps) {
  return (
    <div className="rounded-2xl border border-base bg-secondary p-3" role="group" aria-label="Tiempo del enlace de acceso">
      <p className="text-[10px] font-black uppercase tracking-wider text-muted">¿Por cuánto tiempo?</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ACCESS_INVITE_DAY_OPTIONS.map(option => {
          const active = option === days;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              disabled={busy}
              onClick={() => onPick(option)}
              className={`h-8 rounded-full border px-3 text-[10px] font-black uppercase tracking-wider disabled:opacity-55 ${
                active
                  ? "border-violet-600 bg-violet-600 text-white"
                  : "border-base bg-subtle text-primary"
              }`}
            >
              {resolveAccessInviteExpiry(option).label}
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-9 rounded-xl border border-base bg-subtle px-3 text-[10px] font-black uppercase tracking-wider text-primary disabled:opacity-55"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-[10px] font-black uppercase tracking-wider text-white disabled:opacity-60"
        >
          {busy
            ? <><RefreshCw className="h-4 w-4 animate-spin" /> Generando…</>
            : <><Link2 className="h-4 w-4" /> Generar enlace</>}
        </button>
      </div>
    </div>
  );
}
