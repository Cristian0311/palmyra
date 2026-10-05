import { useCallback, useEffect, useState } from "react";
import {
  getOfflineConflictCount,
  getOfflineQueueCount,
} from "../../../services/offlineQueue";

type NotificationType = "info" | "success" | "warning" | "error";

type AddNotification = (
  message: string,
  type?: NotificationType,
  details?: string
) => void;

export function usePOSOfflineStatus(addNotification: AddNotification) {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [pendingOfflineCount, setPendingOfflineCount] = useState(
    getOfflineQueueCount()
  );
  const [offlineConflictCount, setOfflineConflictCount] = useState(
    getOfflineConflictCount()
  );
  const [isSyncingOffline, setIsSyncingOffline] = useState(false);

  const refreshOfflineCounts = useCallback(() => {
    setPendingOfflineCount(getOfflineQueueCount());
    setOfflineConflictCount(getOfflineConflictCount());
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      refreshOfflineCounts();
    };

    const handleOffline = () => {
      setIsOnline(false);
      refreshOfflineCounts();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("offline_queue_updated", refreshOfflineCounts);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("offline_queue_updated", refreshOfflineCounts);
    };
  }, [refreshOfflineCounts]);

  const handleManualSync = useCallback(async () => {
    if (!isOnline) {
      addNotification("No hay conexión a internet actualmente.", "warning");
      return;
    }

    setIsSyncingOffline(true);
    try {
      const { processOfflineQueue } = await import("../../../services/offlineSync");
      const result = await processOfflineQueue();
      setPendingOfflineCount(result.remaining);
      setOfflineConflictCount(getOfflineConflictCount());

      if (result.remaining > 0 || getOfflineConflictCount() > 0) {
        addNotification(
          `Sincronización incompleta: ${result.processed} operaciones procesadas y ${result.remaining} siguen pendientes.`,
          "warning"
        );
      } else if (result.processed > 0) {
        addNotification(
          `Sincronización manual completada: ${result.processed} operaciones confirmadas.`,
          "success"
        );
      } else if (getOfflineConflictCount() > 0) {
        addNotification(
          "La cola tiene " + getOfflineConflictCount() + " conflicto(s) que requieren revisión.",
          "warning"
        );
      } else {
        addNotification(
          "Todo está al día y sincronizado con Supabase.",
          "info"
        );
      }
    } finally {
      setIsSyncingOffline(false);
    }
  }, [addNotification, isOnline]);

  return {
    isOnline,
    pendingOfflineCount,
    offlineConflictCount,
    isSyncingOffline,
    handleManualSync,
    refreshOfflineCounts,
  };
}
