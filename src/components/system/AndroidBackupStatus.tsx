import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "../../lib/utils";
import { SCHEDULED_BACKUP_INTERVAL_MS } from "../../services/localDb/backup/schedule";
import {
  getAndroidBackupRecoveryKey,
  useAndroidBackup
} from "../../hooks/useAndroidBackup";

/**
 * Estado del respaldo automático en la tablet.
 *
 * Solo existe en el APK Android: en navegador, PWA o escritorio no hay puente
 * de Descargas y la tarjeta no se renderiza.
 */

function relativePast(iso: string | null): string {
  if (!iso) return "sin respaldos todavía";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "sin respaldos todavía";
  const diff = Date.now() - ms;
  if (diff < 0) return "hace un momento";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "hace menos de un minuto";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "ayer" : `hace ${days} días`;
}

function relativeNext(lastBackupAt: string | null): string {
  if (!lastBackupAt) return "en la próxima comprobación";
  const ms = Date.parse(lastBackupAt);
  if (!Number.isFinite(ms)) return "en la próxima comprobación";
  const remaining = ms + SCHEDULED_BACKUP_INTERVAL_MS - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "en la próxima comprobación";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `en ${minutes} min`;
  return `en ${Math.round(minutes / 60)} h`;
}

export default function AndroidBackupStatus() {
  const { available, status, running, backupNow } = useAndroidBackup();
  const [, setTick] = useState(0);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // Las fechas relativas envejecen solas: se refresca el texto cada minuto.
  useEffect(() => {
    if (!available) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [available]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const recoveryKey = useMemo(() => (showKey ? getAndroidBackupRecoveryKey() : null), [showKey]);

  if (!available) return null;

  const copyKey = async () => {
    const value = recoveryKey || getAndroidBackupRecoveryKey();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const stateLabel = running
    ? "Respaldando…"
    : status.error
      ? "Con error"
      : status.lastBackupAt
        ? "Al día"
        : "Pendiente";
  const okState = !running && !status.error && Boolean(status.lastBackupAt);

  return (
    <section
      aria-labelledby="android-backup-title"
      className="rounded-xl border border-base bg-primary p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="android-backup-title"
            className="flex items-center gap-2 text-sm font-bold text-primary"
          >
            <ShieldCheck size={15} className="text-violet-600" aria-hidden="true" />
            Respaldo automático
          </h3>
          <p className="text-sm font-medium text-muted">
            Cada 24 h, en este dispositivo y sin PC.
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sm font-semibold",
            okState
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : status.error
                ? "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              okState
                ? "bg-emerald-500"
                : status.error
                  ? "bg-rose-500"
                  : "bg-amber-500"
            )}
          />
          {stateLabel}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="font-semibold text-muted">Último respaldo</dt>
          <dd className="truncate font-bold text-primary" title={status.lastBackupAt ?? undefined}>
            {relativePast(status.lastBackupAt)}
          </dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="font-semibold text-muted">Ubicación</dt>
          <dd className="truncate font-bold text-primary" title={status.location ?? undefined}>
            {status.location || "Descargas del dispositivo"}
          </dd>
        </div>
        <div className="rounded-lg border border-base bg-secondary p-2">
          <dt className="flex items-center gap-1 font-semibold text-muted">
            <Clock3 size={13} aria-hidden="true" /> Próximo intento
          </dt>
          <dd className="truncate font-bold text-primary">{relativeNext(status.lastBackupAt)}</dd>
        </div>
      </dl>

      {status.fileName && (
        <p
          className="mt-2 truncate text-sm font-medium text-muted"
          title={status.fileName}
        >
          Archivo: {status.fileName}
        </p>
      )}

      {status.error && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-start justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium leading-6 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200"
        >
          <p className="flex min-w-0 flex-1 items-start gap-2">
            <AlertTriangle size={15} className="mt-1 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{status.error}</span>
          </p>
          <button
            type="button"
            onClick={() => void backupNow()}
            disabled={running}
            className="h-11 rounded-lg border border-rose-300 px-3 text-sm font-semibold text-rose-800 transition-colors hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900/50 dark:text-rose-200 dark:hover:bg-rose-950/40"
          >
            Reintentar
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void backupNow()}
          disabled={running}
          aria-busy={running}
          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(running && "animate-spin")} aria-hidden="true" />
          {running ? "Respaldando…" : "Respaldar ahora"}
        </button>
        <button
          type="button"
          onClick={() => setShowKey((value) => !value)}
          aria-expanded={showKey}
          className="h-11 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle"
        >
          Clave de recuperación
        </button>
      </div>

      {showKey && (
        <div className="mt-2 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
          <p>
            Los respaldos automáticos se cifran con esta clave. Anótala fuera de la tablet:
            sin ella no se pueden abrir en otro equipo.
          </p>
          <code className="block select-all break-all rounded-lg border border-amber-300 bg-white/70 p-2 font-mono text-sm dark:border-amber-900/50 dark:bg-black/20">
            {recoveryKey || "Todavía no se generó: aparecerá con el primer respaldo."}
          </code>
          <button
            type="button"
            onClick={() => void copyKey()}
            disabled={!recoveryKey}
            className="h-11 rounded-lg border border-amber-300 px-3 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-900/50 dark:text-amber-200 dark:hover:bg-amber-950/40"
          >
            {copied ? "Copiada" : "Copiar clave"}
          </button>
        </div>
      )}

      {okState && (
        <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={14} aria-hidden="true" />
          Se conservan los 7 respaldos más recientes en Descargas.
        </p>
      )}
    </section>
  );
}
