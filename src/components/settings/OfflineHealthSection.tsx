import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  RefreshCw,
  RotateCcw,
  Trash2,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { useStore } from "../../store/useStore";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import {
  getOfflineQueue,
  getOfflineQueueHealth,
  removeFromOfflineQueue,
  requeueOfflineQueueItem
} from "../../services/offlineQueue";
import { evaluateOfflineFreshness, type OfflineQueueHealth } from "../../services/offline/syncContract";
import { getLastSyncMoment, SYNC_LEDGER_EVENT } from "../../services/offline/syncLedger";
import {
  formatStorageBytes,
  inspectPwaStorageHealth,
  type PwaStorageHealth
} from "../../services/pwaStorageHealth";
import type { OfflineQueueItem } from "../../services/offlineQueueTypes";

export default function OfflineHealthSection() {
  const storeLastSync = useStore(state => state.lastSyncTime);
  // El registro con alcance usuario+empresa sobrevive recargas; el estado de
  // Zustand sirve como respaldo si todavía no existe un registro local.
  const [ledgerLastSync, setLedgerLastSync] = useState<string | null>(() => getLastSyncMoment());
  const [health, setHealth] = useState<OfflineQueueHealth>(() => getOfflineQueueHealth());
  const [conflicts, setConflicts] = useState<OfflineQueueItem[]>(() =>
    getOfflineQueue().filter(item => item.status === "conflict")
  );
  const [storage, setStorage] = useState<PwaStorageHealth | null>(null);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setHealth(getOfflineQueueHealth());
    setConflicts(getOfflineQueue().filter(item => item.status === "conflict"));
    setLedgerLastSync(getLastSyncMoment());
    try {
      setStorage(await inspectPwaStorageHealth());
    } catch {
      setStorage(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handleQueueUpdate = () => { void refresh(); };
    const handleLedgerUpdate = () => { setLedgerLastSync(getLastSyncMoment()); };
    const handleOnline = () => { setIsOnline(true); void refresh(); };
    const handleOffline = () => { setIsOnline(false); void refresh(); };
    window.addEventListener("offline_queue_updated", handleQueueUpdate);
    window.addEventListener(SYNC_LEDGER_EVENT, handleLedgerUpdate);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("offline_queue_updated", handleQueueUpdate);
      window.removeEventListener(SYNC_LEDGER_EVENT, handleLedgerUpdate);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refresh]);

  const retryItem = async (item: OfflineQueueItem) => {
    if (!isOnline) {
      setMessage("Sin conexión: la operación seguirá guardada y se enviará al reconectar.");
      return;
    }
    setBusyAction(item.id);
    setMessage("");
    try {
      await requeueOfflineQueueItem(item.id);
      const { processOfflineQueue } = await import("../../services/offlineSync");
      const result = await processOfflineQueue();
      setMessage(result.remaining || result.conflicts
        ? `Reintento terminado: ${result.processed} confirmadas, ${result.remaining} pendientes y ${result.conflicts} en conflicto.`
        : "Operación confirmada por la nube.");
    } catch (error: any) {
      setMessage(error?.message || "No se pudo reintentar la operación.");
    } finally {
      setBusyAction(null);
      await refresh();
    }
  };

  const discardItem = async (item: OfflineQueueItem) => {
    setBusyAction(item.id);
    setMessage("");
    try {
      await removeFromOfflineQueue(item.id);
      setMessage("Operación descartada de este dispositivo. No se enviará a la nube.");
    } catch (error: any) {
      setMessage(error?.message || "No se pudo descartar la operación.");
    } finally {
      setConfirmDiscardId(null);
      setBusyAction(null);
      await refresh();
    }
  };

  // Nunca mostrar una fecha más vieja que la que ya conoce el estado de la
  // sesión (por ejemplo, si el navegador rechazó escribir el registro local).
  const lastSyncAt = ledgerLastSync && storeLastSync
    ? (ledgerLastSync > storeLastSync ? ledgerLastSync : storeLastSync)
    : (ledgerLastSync || storeLastSync);
  const freshness = evaluateOfflineFreshness(lastSyncAt);
  const storagePercent = storage && storage.quotaBytes > 0
    ? Math.min(100, Math.round(storage.usageRatio * 100))
    : null;

  return (
    <section className="rounded-2xl border border-base bg-secondary p-3 sm:p-5 shadow-sm space-y-4 min-w-0">
      <SettingsSectionHeader
        icon={Database}
        title="Salud local"
        subtitle="Cola durable, conflictos y datos guardados en este dispositivo."
        action={
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold ${
            isOnline
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          }`}>
            {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
            {isOnline ? "En línea" : "Sin conexión"}
          </span>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div className="rounded-xl border border-base bg-primary p-3 min-w-0">
          <p className="text-sm font-medium text-muted">Pendientes</p>
          <p className="text-lg font-bold tabular-nums text-primary">{health.pending}</p>
          <p className="text-sm font-medium leading-snug text-muted">Se envían al reconectar</p>
        </div>
        <div className={`rounded-xl border p-3 min-w-0 ${health.conflicts > 0 ? "border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20" : "border-base bg-primary"}`}>
          <p className="text-sm font-medium text-muted">Conflictos</p>
          <p className={`text-lg font-bold tabular-nums ${health.conflicts > 0 ? "text-amber-700 dark:text-amber-300" : "text-primary"}`}>{health.conflicts}</p>
          <p className="text-sm font-medium leading-snug text-muted">Requieren revisión</p>
        </div>
        <div className="rounded-xl border border-base bg-primary p-3 min-w-0">
          <p className="text-sm font-medium text-muted">Último sync</p>
          <p className="text-lg font-bold leading-tight text-primary tabular-nums break-words">
            {freshness.lastSyncAt
              ? new Date(freshness.lastSyncAt).toLocaleString()
              : "Sin registro"}
          </p>
          <p className={`text-sm font-medium leading-snug ${
            freshness.state === "stale"
              ? "text-rose-600 dark:text-rose-400"
              : freshness.state === "warning"
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted"
          }`}>
            {freshness.daysSinceSync === null
              ? "Aún no sincronizado"
              : `Hace ${freshness.daysSinceSync} día(s)`}
          </p>
        </div>
        <div className="rounded-xl border border-base bg-primary p-3 min-w-0">
          <p className="text-sm font-medium text-muted">Almacenamiento</p>
          <p className="text-lg font-bold leading-tight text-primary tabular-nums break-words">
            {storage ? `${formatStorageBytes(storage.usageBytes)}${storage.quotaBytes ? ` / ${formatStorageBytes(storage.quotaBytes)}` : ""}` : "No disponible"}
          </p>
          <p className={`text-sm font-medium leading-snug ${storage?.warning || (storage && !storage.persisted) ? "text-rose-600 dark:text-rose-400" : "text-muted"}`}>
            {storage?.persisted
              ? "Persistente"
              : storage?.warning
                ? "Espacio bajo"
                : storage
                  ? "Sin protección del navegador"
                  : "No disponible"}
            {storagePercent !== null ? ` · ${storagePercent}%` : ""}
          </p>
        </div>
      </div>

      {storage && !storage.persisted && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm font-medium leading-6 text-amber-800 dark:text-amber-200">
            El navegador todavía no marcó estos datos como persistentes y podría liberar espacio si el teléfono se queda sin almacenamiento.
            Instala PALMYRA en la pantalla de inicio y exporta una copia de seguridad con frecuencia.
          </p>
        </div>
      )}

      {freshness.state !== "fresh" && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm font-medium leading-6 text-amber-800 dark:text-amber-200">
            {freshness.state === "unknown"
              ? "Este dispositivo todavía no ha sincronizado una vez. Puedes seguir trabajando offline; los datos se enviarán cuando haya conexión."
              : "Han pasado varios días sin sincronizar. Los datos locales siguen intactos, pero conviene conectar el equipo para respaldarlos y actualizar catálogo, precios y stock."}
          </p>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-amber-700 dark:text-amber-300">Revisión de conflictos</p>
            <span className="text-sm font-medium text-muted">No se reenvían solos</span>
          </div>
          {conflicts.slice(0, 5).map(item => (
            <div key={item.id} className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-900/40 dark:bg-amber-950/10">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-primary break-words">
                    {item.type} · {item.actionId}
                  </p>
                  <p className="mt-0.5 text-sm font-medium leading-6 text-amber-800 dark:text-amber-200 break-words">
                    {item.lastError || "El servidor rechazó esta operación y requiere revisión."}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void retryItem(item)}
                    disabled={busyAction !== null || !isOnline}
                    title="Reintentar operación"
                    aria-label="Reintentar operación"
                    className="h-11 w-11 rounded-xl border border-emerald-200 bg-primary text-emerald-700 flex items-center justify-center hover:bg-emerald-50 disabled:opacity-40 dark:border-emerald-900/50 dark:text-emerald-300"
                  >
                    {busyAction === item.id ? <RefreshCw size={15} className="animate-spin" /> : <RotateCcw size={15} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDiscardId(confirmDiscardId === item.id ? null : item.id)}
                    disabled={busyAction !== null}
                    title="Descartar operación"
                    aria-label="Descartar operación"
                    className="h-11 w-11 rounded-xl border border-rose-200 bg-primary text-rose-600 flex items-center justify-center hover:bg-rose-50 disabled:opacity-40 dark:border-rose-900/50 dark:text-rose-300"
                  >
                    {confirmDiscardId === item.id ? <X size={15} /> : <Trash2 size={15} />}
                  </button>
                </div>
              </div>
              {confirmDiscardId === item.id && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-primary px-3 py-2 dark:border-rose-900/50">
                  <p className="text-sm font-medium leading-6 text-rose-700 dark:text-rose-300">
                    ¿Descartar? Esta operación no se enviará a la nube.
                  </p>
                  <button
                    type="button"
                    onClick={() => void discardItem(item)}
                    disabled={busyAction !== null}
                    className="shrink-0 h-11 px-3 rounded-xl bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 disabled:opacity-50"
                  >
                    Descartar
                  </button>
                </div>
              )}
            </div>
          ))}
          {conflicts.length > 5 && (
            <p className="text-sm font-medium text-muted">
              Hay {conflicts.length - 5} conflicto(s) más. Se muestran los primeros 5.
            </p>
          )}
        </div>
      )}

      {conflicts.length === 0 && health.pending === 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/10">
          <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
            Todo sincronizado. Este dispositivo puede seguir vendiendo sin conexión.
          </p>
        </div>
      )}

      {message && (
        <p className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-sm font-medium leading-6 text-violet-800 dark:border-violet-900/40 dark:bg-violet-950/10 dark:text-violet-200">
          {message}
        </p>
      )}

      <div className="border-t border-base pt-3">
        <p className="text-sm font-medium leading-6 text-muted">
          La cola guarda cada operación en IndexedDB y la envía sola cuando detecta conexión. Usa «Sincronizar con la nube» para forzar el envío.
        </p>
      </div>
    </section>
  );
}
