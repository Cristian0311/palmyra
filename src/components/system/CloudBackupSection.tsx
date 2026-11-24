import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudDownload,
  CloudUpload,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import { cn } from "../../lib/utils";
import { BACKUP_MIN_PASSPHRASE_LENGTH } from "../../services/localDb/backup/index";
import { CLOUD_BACKUP_MAX_BYTES, CLOUD_BACKUP_RETENTION } from "../../services/localDb/backup/cloud";
import { useCloudBackup } from "../../hooks/useCloudBackup";

/**
 * Sección «Respaldo en la nube» del panel de respaldos.
 *
 * Sube el mismo sobre cifrado que se descarga a mano, una vez al día, cuando hay
 * internet y sesión. La frase vive solo en memoria: sin ella no hay subida
 * automática. Restaurar exige elegir el día, escribir RESTAURAR y la frase; la
 * verificación ocurre entera antes de tocar los datos locales.
 */
const CONFIRM_WORD = "RESTAURAR";
const MIN_PASSPHRASE = BACKUP_MIN_PASSPHRASE_LENGTH;

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMoment(value: string | null): string {
  if (!value) return "Nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function formatDay(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("es-ES", { dateStyle: "medium" });
}

export default function CloudBackupSection() {
  const [passphrase, setPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error" | "info"; text: string } | null>(null);
  const [restored, setRestored] = useState(false);

  // El ciclo diario vive en segundo plano; aquí solo se lanzan acciones manuales.
  const { status, days, busy, loadingDays, recoveryKey, backupNow, restore, refreshDays } = useCloudBackup({
    passphrase,
    auto: false
  });

  useEffect(() => {
    if (!selectedDay && days.length > 0) setSelectedDay(days[0].day);
  }, [days, selectedDay]);

  const selected = useMemo(() => days.find((item) => item.day === selectedDay) ?? null, [days, selectedDay]);
  const confirmed = confirmText.trim().toUpperCase() === CONFIRM_WORD;
  const restoreReady =
    !!selected && confirmed && restorePassphrase.length >= MIN_PASSPHRASE && !busy && status.online;
  const canBackup = (passphrase.length >= MIN_PASSPHRASE || recoveryKey.length >= MIN_PASSPHRASE) && !busy && status.online && status.enabled;

  const handleBackup = async () => {
    setNotice(null);
    const outcome = await backupNow(passphrase.length >= MIN_PASSPHRASE ? passphrase : recoveryKey);
    if (outcome.ok && outcome.skipped) {
      setNotice({ type: "info", text: "La nube ya tiene el respaldo de hoy con los mismos datos." });
      return;
    }
    if (outcome.ok) {
      setNotice({
        type: "ok",
        text: `Respaldo cifrado subido: ${formatSize(outcome.bytes ?? null)} del día ${outcome.day ?? ""}. La frase no salió de este equipo.`
      });
      return;
    }
    setNotice({
      type: outcome.reason === "offline" ? "info" : "error",
      text: outcome.error || "No se pudo respaldar en la nube."
    });
  };

  const handleRestore = async () => {
    if (!restoreReady || !selected) return;
    setNotice({ type: "info", text: "Descargando y verificando el respaldo antes de escribir nada…" });
    const outcome = await restore({
      day: selected.day,
      passphrase: restorePassphrase,
      confirm: true
    });
    if (!outcome.ok) {
      setNotice({ type: "error", text: outcome.error || "No se pudo restaurar el respaldo de la nube." });
      return;
    }
    setRestored(true);
    setConfirmText("");
    setRestorePassphrase("");
    setNotice({
      type: "ok",
      text: `Restauración aplicada desde la nube: ${outcome.applied?.written ?? 0} registros escritos y ${
        outcome.applied?.removed ?? 0
      } descartados. Reinicia PALMYRA para recargar la interfaz.`
    });
    void refreshDays();
  };

  return (
    <div className="mt-3 rounded-xl border border-base bg-primary p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <Cloud size={15} className="text-violet-600" /> Respaldo en la nube
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-muted">
            Una copia diaria del respaldo cifrado sale del equipo cuando hay internet. Se guardan{" "}
            {CLOUD_BACKUP_RETENTION.daily} diarios y {CLOUD_BACKUP_RETENTION.weekly} semanales; el archivo viaja
            cifrado y la frase nunca se envía. La caja sigue vendiendo aunque la nube falle.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshDays()}
          disabled={loadingDays || busy}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(loadingDays && "animate-spin")} /> Días en la nube
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-xl border border-base bg-secondary p-2.5">
          <dt className="font-semibold text-muted">Último respaldo</dt>
          <dd className="font-bold text-primary">{formatMoment(status.lastUploadAt)}</dd>
        </div>
        <div className="rounded-xl border border-base bg-secondary p-2.5">
          <dt className="font-semibold text-muted">Tamaño enviado</dt>
          <dd className="font-bold text-primary">{formatSize(status.lastBytes)}</dd>
        </div>
        <div className="rounded-xl border border-base bg-secondary p-2.5">
          <dt className="font-semibold text-muted">Estado</dt>
          <dd className="font-bold text-primary">
            {!status.enabled
              ? "Sin sesión o sin nube"
              : !status.online
                ? "Sin conexión"
                : status.autoPaused
                  ? "Automático en pausa (sin clave)"
                  : busy
                    ? "Trabajando…"
                    : "Activo"}
          </dd>
        </div>
      </dl>

      {!status.online && (
        <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-sm font-medium leading-6 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
          Sin internet: el respaldo en la nube esperará y se reintentará solo. Las ventas no se ven afectadas.
        </p>
      )}

      {status.lastError && (
        <p className="mt-2 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-sm font-medium leading-6 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200">
          Último aviso: {status.lastError}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Subir */}
        <div className="space-y-2 rounded-xl border border-base bg-secondary p-3">
          <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-2.5 text-sm font-medium leading-6 text-violet-950 dark:border-violet-900/40 dark:bg-violet-950/20 dark:text-violet-100">
            <p className="font-bold">Clave de respaldo de este equipo</p>
            <code className="mt-1 block break-all rounded-lg bg-white/70 px-2 py-1 text-[13px] font-semibold text-violet-900 dark:bg-black/30 dark:text-violet-200">
              {recoveryKey || "Se generará al iniciar sesión con empresa."}
            </code>
            <p className="mt-1">
              Cópiala y guárdala fuera del equipo. Sin esta clave no se puede restaurar la copia de la nube. El
              respaldo diario usa esta clave automáticamente.
            </p>
            {recoveryKey && (
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(recoveryKey)}
                className="mt-1 font-bold underline decoration-violet-400 underline-offset-2"
              >
                Copiar clave
              </button>
            )}
          </div>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-muted">
              Frase propia (opcional, mínimo {MIN_PASSPHRASE} caracteres, no se guarda)
            </span>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
              className="w-full rounded-xl border border-base bg-primary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>
          <p className="text-sm font-medium leading-6 text-muted">
            Si escribes una frase propia, esta subida manual la usa y la automática conserva la clave del equipo.
          </p>
          <button
            type="button"
            onClick={() => void handleBackup()}
            disabled={!canBackup}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
          >
            <CloudUpload size={15} />
            {busy ? "Subiendo…" : "Respaldar ahora"}
          </button>
          <p className="text-sm font-medium leading-6 text-muted">
            Límite por archivo: {Math.round(CLOUD_BACKUP_MAX_BYTES / (1024 * 1024))} MB. Si ya subiste hoy los mismos
            datos, no se envía nada de nuevo.
          </p>
        </div>

        {/* Restaurar */}
        <div className="space-y-2 rounded-xl border border-base bg-secondary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <CloudDownload size={15} className="text-violet-600" /> Restaurar desde la nube
          </p>
          {days.length === 0 ? (
            <p className="rounded-xl border border-base bg-primary p-2.5 text-sm font-medium text-muted">
              Todavía no hay días subidos desde este equipo.
            </p>
          ) : (
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-muted">Día del respaldo</span>
              <select
                value={selectedDay}
                onChange={(event) => {
                  setSelectedDay(event.target.value);
                  setConfirmText("");
                  setRestored(false);
                  setNotice(null);
                }}
                className="w-full rounded-xl border border-base bg-primary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
              >
                {days.map((item) => (
                  <option key={item.day} value={item.day}>
                    {formatDay(item.day)} · {formatSize(item.bytes)} · {item.totalRows} registros
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block space-y-1">
            <span className="flex items-center justify-between gap-2 text-sm font-semibold text-muted">
              Frase del respaldo
              {recoveryKey && (
                <button
                  type="button"
                  onClick={() => setRestorePassphrase(recoveryKey)}
                  className="font-bold text-violet-700 underline underline-offset-2 dark:text-violet-300"
                >
                  Usar la clave de este equipo
                </button>
              )}
            </span>
            <input
              type="password"
              value={restorePassphrase}
              onChange={(event) => setRestorePassphrase(event.target.value)}
              autoComplete="current-password"
              className="w-full rounded-xl border border-base bg-primary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-muted">
              Escribe <strong>{CONFIRM_WORD}</strong> para confirmar
            </span>
            <input
              type="text"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-xl border border-base bg-primary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-2.5 text-sm font-medium leading-6 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
            <span className="flex items-start gap-2">
              <ShieldCheck size={15} className="mt-0.5 shrink-0" />
              <span>
                Se descarga, se comprueba el tamaño, el SHA-256 y los conteos del manifiesto, y solo entonces se
                escribe. Los cambios posteriores a ese día se pierden en este equipo (la nube conserva su copia).
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleRestore()}
            disabled={!restoreReady}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-rose-600 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
          >
            <AlertTriangle size={15} />
            {busy ? "Restaurando…" : "Restaurar desde la nube"}
          </button>
          {restored && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 text-sm font-semibold text-emerald-800 transition-colors hover:bg-emerald-100 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200"
            >
              <CheckCircle2 size={15} /> Reiniciar PALMYRA ahora
            </button>
          )}
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {status.enabled
          ? `Último respaldo en la nube: ${formatMoment(status.lastUploadAt)}. ${days.length} días disponibles.`
          : "Respaldo en la nube no disponible sin sesión."}
      </p>

      {notice && (
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "mt-2 rounded-xl border p-2.5 text-sm font-medium leading-6",
            notice.type === "ok" &&
              "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200",
            notice.type === "error" &&
              "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200",
            notice.type === "info" &&
              "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900/40 dark:bg-violet-950/20 dark:text-violet-200"
          )}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
