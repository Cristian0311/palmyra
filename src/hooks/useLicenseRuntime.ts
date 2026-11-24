import { useEffect, useState } from "react";
import { getSupabase } from "../lib/supabase";
import { getCachedSaaSContext } from "../services/offlineAuthContext";
import { getPalmyraLocalScope } from "../services/localScope";
import {
  createLicenseRuntime,
  type LicenseRuntime,
  type LicenseRuntimeClient,
  type LicenseSnapshot
} from "../services/license/runtime";
import {
  CLOCK_TELEMETRY_FLUSH_INTERVAL_MS,
  flushClockTamperReports,
  type ClockTamperTelemetryClient
} from "../services/license/telemetry";
import { createIndexedDbLicenseStore, type LicenseKeyValueStore } from "../services/license/storage";

/**
 * Un único runtime por sesión de pestaña: el guard de solo lectura es global,
 * así que dos instancias podrían pelearse por el mismo estado.
 */
let runtime: LicenseRuntime | null = null;
let startedCompanyId: string | null = null;

/**
 * F6: el lease se renueva cada 12 h (antes 5 min = 288 solicitudes/día). Un
 * refresco perdido nunca activa solo lectura: el runtime conserva el lease
 * guardado y su evaluación; solo se acorta cuando el lease está por vencer.
 */
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Foco/online no pueden provocar más de una comprobación cada 30 min. */
const MIN_RETRY_GAP_MS = 30 * 60 * 1000;

/**
 * Vaciado de la telemetría de reloj desde la interfaz. El encolado real lo hace
 * el runtime (la guarda registra el evento y su refresco lo pasa al buzón): aquí
 * solo se empuja el envío al detectar manipulación o al volver la conexión.
 * Nunca más de un intento cada 5 min y nunca dos en vuelo.
 */
let telemetryStore: LicenseKeyValueStore | null = null;
let lastTelemetryFlushAt = 0;
let telemetryFlushInFlight: Promise<void> | null = null;

function scheduleClockTelemetryFlush(companyId: string): void {
  if (!companyId || telemetryFlushInFlight) return;
  const now = Date.now();
  if (now - lastTelemetryFlushAt < CLOCK_TELEMETRY_FLUSH_INTERVAL_MS) return;
  const client = getSupabase();
  if (!client) return;
  lastTelemetryFlushAt = now;
  // El buzón comparte almacén con el runtime (misma base IndexedDB).
  telemetryStore = telemetryStore ?? createIndexedDbLicenseStore();
  telemetryFlushInFlight = flushClockTamperReports({
    store: telemetryStore,
    companyId,
    client: client as unknown as ClockTamperTelemetryClient
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      telemetryFlushInFlight = null;
    });
}

function getRuntime(): LicenseRuntime {
  if (!runtime) {
    runtime = createLicenseRuntime({
      getClient: () => getSupabase() as unknown as LicenseRuntimeClient | null
    });
  }
  return runtime;
}

/** Empresa activa según el alcance local ya guardado por la app. */
export function resolveLicenseCompanyId(): string | null {
  const scope = getPalmyraLocalScope();
  if (!scope) return null;
  if (scope.companyId) return scope.companyId;
  const context = getCachedSaaSContext(scope.userId);
  return context?.companyId || null;
}

/**
 * Arranca (o refresca) el runtime para la empresa indicada. Es seguro llamarlo
 * varias veces: el runtime deduplica la petición en vuelo.
 */
export function startLicenseRuntime(companyId?: string | null): Promise<LicenseSnapshot> {
  const current = getRuntime();
  const target = companyId || startedCompanyId;
  if (!target) return Promise.resolve(current.getSnapshot());
  startedCompanyId = target;
  return current.start({ companyId: target });
}

export function useLicenseRuntime(companyId?: string | null) {
  const current = getRuntime();
  const [snapshot, setSnapshot] = useState<LicenseSnapshot>(() => current.getSnapshot());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    // Un snapshot con aviso de reloj es la señal de F3: se intenta enviar la
    // telemetría pendiente una vez (el runtime la encoló al detectarla).
    const flushIfTampered = (next: LicenseSnapshot) => {
      if (!next.clockWarning && next.reason !== "clock-tampered") return;
      const target = companyId || resolveLicenseCompanyId();
      if (target) scheduleClockTelemetryFlush(target);
    };
    const unsubscribe = current.subscribe((next) => {
      if (alive) setSnapshot(next);
      flushIfTampered(next);
    });

    // No se bloquea el render mientras carga: el snapshot inicial es 'loading'.
    let lastRunAt = 0;
    const runThrottled = (showSpinner: boolean, minGapMs = 0) => {
      const target = companyId || resolveLicenseCompanyId();
      if (!target) return;
      const now = Date.now();
      if (minGapMs > 0 && lastRunAt > 0 && now - lastRunAt < minGapMs) return;
      lastRunAt = now;
      if (showSpinner) setRefreshing(true);
      void startLicenseRuntime(target).finally(() => {
        if (alive && showSpinner) setRefreshing(false);
      });
    };

    runThrottled(true);
    flushIfTampered(current.getSnapshot());
    const timer = window.setInterval(() => runThrottled(false), REFRESH_INTERVAL_MS);
    const handleOnline = () => {
      // Volvió la red: reintenta como mucho una vez cada 30 min.
      runThrottled(false, MIN_RETRY_GAP_MS);
      // Al volver la red se vacía el buzón sin esperar al siguiente refresco.
      const target = companyId || resolveLicenseCompanyId();
      if (target) scheduleClockTelemetryFlush(target);
    };
    // Un alt-tab no debe multiplicar las llamadas de licencia (F6).
    const handleVisibility = () => {
      if (document.visibilityState === "visible") runThrottled(false, MIN_RETRY_GAP_MS);
    };
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [companyId]);

  return { snapshot, refreshing };
}
