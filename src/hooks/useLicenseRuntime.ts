import { useEffect, useState } from "react";
import { getSupabase } from "../lib/supabase";
import { getCachedSaaSContext } from "../services/offlineAuthContext";
import {
  getPalmyraLocalScope,
  PALMYRA_LOCAL_SCOPE_EVENT
} from "../services/localScope";
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
 * Activación pendiente (sin lease o identidad reparada): se reintenta en
 * segundo plano mientras haya red, sin bloquear la interfaz al arrancar.
 */
const ACTIVATION_RETRY_MS = 60 * 1000;
const ACTIVATION_MAX_RETRIES = 5;
/**
 * El alcance local (la empresa) se escribe durante el login, que puede terminar
 * justo después de montar la interfaz. Se sondea unos segundos en lugar de
 * dejar el aviso «Verificando licencia…» colgado hasta el refresco de 12 h.
 */
const STARTUP_PROBE_MS = 4000;
const STARTUP_PROBE_MAX = 30;

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

/**
 * Renovación manual desde la UI (botón Renovar de los avisos): re-evalúa y
 * fuerza el intento de `issue-lease` aunque el runtime lo tenga en espera
 * (RENEW_RETRY_MS) o el lease guardado no esté por vencer. El estado publicado
 * se actualiza solo: no es un cierre cosmético del aviso.
 */
export function renewLicenseRuntime(companyId?: string | null): Promise<LicenseSnapshot> {
  const current = getRuntime();
  const target = companyId || startedCompanyId || resolveLicenseCompanyId();
  if (!target) return Promise.resolve(current.getSnapshot());
  startedCompanyId = target;
  return current.refresh({ companyId: target, forceRenew: true });
}

export function useLicenseRuntime(companyId?: string | null) {
  const current = getRuntime();
  const [snapshot, setSnapshot] = useState<LicenseSnapshot>(() => current.getSnapshot());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    const targetCompany = () => companyId || resolveLicenseCompanyId();

    // Un snapshot con aviso de reloj es la señal de F3: se intenta enviar la
    // telemetría pendiente una vez (el runtime la encoló al detectarla).
    const flushIfTampered = (next: LicenseSnapshot) => {
      if (!next.clockWarning && next.reason !== "clock-tampered") return;
      const target = targetCompany();
      if (target) scheduleClockTelemetryFlush(target);
    };

    // Primer arranque: el runtime evalúa el lease guardado antes de tocar la
    // red, así que el estado útil aparece sin esperar a la nube.
    let lastRunAt = 0;
    let startupTimer: number | null = null;
    let startupTries = 0;
    let activationRetries = 0;
    let retryTimer: number | null = null;

    function scheduleStartupProbe(): void {
      if (!alive || startupTimer !== null || startupTries >= STARTUP_PROBE_MAX) return;
      startupTries += 1;
      startupTimer = window.setTimeout(() => {
        startupTimer = null;
        runThrottled(false);
      }, STARTUP_PROBE_MS);
    }

    function runThrottled(showSpinner: boolean, minGapMs = 0, forceRenew = false): void {
      const target = targetCompany();
      // Sin empresa todavía no hay nada que evaluar: se sondea un rato en lugar
      // de abandonar hasta el siguiente evento de red o el refresco de 12 h.
      if (!target) {
        scheduleStartupProbe();
        return;
      }
      const now = Date.now();
      if (!forceRenew && minGapMs > 0 && lastRunAt > 0 && now - lastRunAt < minGapMs) return;
      lastRunAt = now;
      if (showSpinner) setRefreshing(true);
      const pending = forceRenew ? renewLicenseRuntime(target) : startLicenseRuntime(target);
      void pending.finally(() => {
        if (alive && showSpinner) setRefreshing(false);
      });
    }

    // Activación pendiente o identidad reparada: reintento acotado en segundo
    // plano (solo con red, sin bloquear la interfaz ni marcar error).
    function scheduleActivationRetry(next: LicenseSnapshot): void {
      if (!alive || retryTimer !== null) return;
      if (!next.pendingActivation && next.mode !== "invalid") return;
      if (activationRetries >= ACTIVATION_MAX_RETRIES) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      activationRetries += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        runThrottled(false);
      }, ACTIVATION_RETRY_MS);
    }

    const unsubscribe = current.subscribe((next) => {
      if (alive) setSnapshot(next);
      flushIfTampered(next);
      scheduleActivationRetry(next);
    });

    runThrottled(true);
    flushIfTampered(current.getSnapshot());

    // Cambió el alcance local (login, cambio de empresa): se evalúa de inmediato.
    const handleScopeChange = () => runThrottled(false);
    // Volvió la red con una activación pendiente: es el momento de intentar el
    // lease, no dentro de 30 min.
    const handleOnline = () => {
      const pending = current.getSnapshot().pendingActivation;
      if (pending) activationRetries = 0;
      runThrottled(false, pending ? 0 : MIN_RETRY_GAP_MS);
      // Al volver la red se vacía el buzón sin esperar al siguiente refresco.
      const target = targetCompany();
      if (target) scheduleClockTelemetryFlush(target);
    };
    // Un alt-tab no debe multiplicar las llamadas de licencia (F6).
    const handleVisibility = () => {
      if (document.visibilityState === "visible") runThrottled(false, MIN_RETRY_GAP_MS);
    };
    /**
     * Una sesión nueva es la única vía para emitir el lease: sin este disparador,
     * un equipo que arrancó antes de iniciar sesión se quedaba con el aviso
     * «licencia sin verificar» hasta el refresco de 12 h, aunque ya estuviera
     * dentro de su cuenta. Solo fuerza cuando falta el lease.
     */
    const authSubscription = getSupabase()?.auth?.onAuthStateChange((_event, session) => {
      if (!session?.access_token) return;
      if (!current.getSnapshot().pendingActivation) return;
      activationRetries = 0;
      runThrottled(false, 0, true);
    })?.data?.subscription;

    const timer = window.setInterval(() => runThrottled(false), REFRESH_INTERVAL_MS);
    window.addEventListener("online", handleOnline);
    window.addEventListener(PALMYRA_LOCAL_SCOPE_EVENT, handleScopeChange);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      alive = false;
      unsubscribe();
      try {
        authSubscription?.unsubscribe?.();
      } catch {
        // El cliente puede no tener oyentes registrados; nada que limpiar.
      }
      window.clearInterval(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (startupTimer !== null) window.clearTimeout(startupTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener(PALMYRA_LOCAL_SCOPE_EVENT, handleScopeChange);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [companyId]);

  return { snapshot, refreshing };
}
