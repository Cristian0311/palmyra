/**
 * Conecta las señales de actualización del servidor con el aviso que ya existe.
 *
 * El servidor anota un build nuevo al arrancar y aquí se escucha ese INSERT una
 * sola vez por aplicación montada. Si la señal es de un build más nuevo que el
 * que corre, se recorre EXACTAMENTE el mismo camino que la detección actual
 * (main.tsx): se marca `palmyra:update-available`, se publica
 * `palmyra:update-available` y se lanza la comprobación de versión real, que es
 * la que confirma y fija el build. Nada de esta ruta descarga ni instala por su
 * cuenta.
 *
 * Reglas:
 *   - Sin sesión o con sesión: se suscribe igual (el shell público también
 *     avisa de actualizaciones).
 *   - Un aviso como máximo cada 60 s y nunca dos veces por el mismo build.
 *   - La suscripción se cierra al desmontar; el efecto depende solo de
 *     `enabled`, así que un re-render no crea canales duplicados.
 */

import { useEffect } from "react";
import { PRODUCT_VERSION } from "../lib/productVersion";
import {
  isNewerBuild,
  readLatestSignal,
  subscribeToUpdateSignals,
  type SystemUpdateSignal
} from "../services/updateSignals";

/** Avisos separados al menos por este margen, aunque lleguen varios INSERT. */
export const UPDATE_SIGNAL_THROTTLE_MS = 60_000;
/** Marcas y evento que consumen Layout y PublicUpdateBanner. */
export const UPDATE_AVAILABLE_STORAGE_KEY = "palmyra:update-available";
export const UPDATE_VERSION_STORAGE_KEY = "palmyra:update-version";
export const UPDATE_BUILD_STORAGE_KEY = "palmyra:build-id";
export const UPDATE_AVAILABLE_EVENT = "palmyra:update-available";
/**
 * Build ya avisado. Se persiste para que reiniciar la app (o abrir otra
 * pestaña) no vuelva a avisar del mismo build en cada heartbeat.
 */
export const UPDATE_NOTIFIED_BUILD_STORAGE_KEY = "palmyra:update-notified-build";

export interface UseUpdateSignalOptions {
  /** El shell nativo se actualiza con su propio paquete OTA: se desactiva. */
  enabled?: boolean;
}

let lastNotifiedAt = 0;
let lastNotifiedBuildId = "";

function readStoredBuildId(): string | null {
  try {
    const value = localStorage.getItem(UPDATE_BUILD_STORAGE_KEY);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    // Un navegador en modo privado estricto lanza al leer localStorage.
    return null;
  }
}

function readNotifiedBuildId(): string {
  try {
    const value = localStorage.getItem(UPDATE_NOTIFIED_BUILD_STORAGE_KEY);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function persistNotifiedBuildId(buildId: string): void {
  try {
    localStorage.setItem(UPDATE_NOTIFIED_BUILD_STORAGE_KEY, buildId);
  } catch {
    // Sin almacenamiento: el descarte en memoria sigue evitando duplicados.
  }
}

/** Marca persistente + evento global: los avisos existentes reaccionan solos. */
function markUpdateAvailable(version: string): void {
  try {
    localStorage.setItem(UPDATE_AVAILABLE_STORAGE_KEY, "1");
    if (version !== "") localStorage.setItem(UPDATE_VERSION_STORAGE_KEY, version);
    else localStorage.removeItem(UPDATE_VERSION_STORAGE_KEY);
  } catch {
    // Sin cuota o sin permisos: el evento sigue avisando en esta pestaña.
  }
  try {
    window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, { detail: { version } }));
  } catch {
    // Un CustomEvent no disponible no debe romper la comprobación.
  }
}

/**
 * Lanza la comprobación de versión que ya vive en main.tsx. Se referencia por
 * `window` para no duplicar aquí la lógica de /version.json; si aún no está
 * publicada, el aviso ya quedó marcado y el vigilante normal la recogerá.
 */
function triggerExistingCheck(): void {
  try {
    const check = (window as Window & {
      __palmyraCheckServerVersion?: () => Promise<unknown>;
    }).__palmyraCheckServerVersion;
    if (typeof check === "function") {
      void Promise.resolve(check()).catch(() => undefined);
    }
  } catch {
    // Nunca se propaga: el aviso visible ya está puesto.
  }
}

let deferredSignal: SystemUpdateSignal | null = null;
let deferredTimer: ReturnType<typeof setTimeout> | null = null;

/** Avisa al agotarse el margen. Un único temporizador, nunca un sondeo. */
function scheduleDeferredSignal(waitMs: number): void {
  if (deferredTimer !== null) return;
  const delay = Math.max(0, Math.min(waitMs, UPDATE_SIGNAL_THROTTLE_MS));
  deferredTimer = setTimeout(() => {
    deferredTimer = null;
    const signal = deferredSignal;
    deferredSignal = null;
    if (signal) applyUpdateSignal(signal, readStoredBuildId(), PRODUCT_VERSION, Date.now());
  }, delay);
  // En Node (pruebas) el temporizador no debe mantener vivo el proceso.
  const handle = deferredTimer as unknown as { unref?: () => void };
  if (handle && typeof handle.unref === "function") handle.unref();
}

/**
 * Aplica una señal: devuelve true solo si avisó. Se exporta para poder probar
 * el descarte por build y el límite de frecuencia sin montar React.
 */
export function applyUpdateSignal(
  signal: SystemUpdateSignal | null | undefined,
  currentBuildId: string | null = readStoredBuildId(),
  currentVersion: string = PRODUCT_VERSION,
  now: number = Date.now()
): boolean {
  if (!isNewerBuild(signal, currentBuildId, currentVersion)) return false;
  const buildId = typeof signal?.build_id === "string" ? signal.build_id.trim() : "";
  if (buildId === "") return false;
  const version = signal && typeof signal.version === "string" ? signal.version : "";

  // Un mismo build se avisa UNA sola vez: ni al reconectar, ni al remontar, ni
  // al reiniciar la app (la marca se persiste). Esto va antes del límite de
  // frecuencia para que un heartbeat no consuma el turno de un build nuevo.
  if (buildId === lastNotifiedBuildId || buildId === readNotifiedBuildId()) return false;
  if (now - lastNotifiedAt < UPDATE_SIGNAL_THROTTLE_MS) {
    // Dentro del margen: se aplaza, no se pierde. Un solo temporizador.
    deferredSignal = signal ?? null;
    scheduleDeferredSignal(UPDATE_SIGNAL_THROTTLE_MS - (now - lastNotifiedAt));
    return false;
  }

  lastNotifiedAt = now;
  lastNotifiedBuildId = buildId;
  persistNotifiedBuildId(buildId);
  markUpdateAvailable(version);
  triggerExistingCheck();
  return true;
}

/**
 * Suscribe la app a las señales mientras esté montada. Se monta UNA vez en la
 * raíz (main.tsx), nunca por pantalla.
 */
export function useUpdateSignal(options: UseUpdateSignalOptions = {}): void {
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let active = true;

    const handle = (signal: SystemUpdateSignal) => {
      if (!active) return;
      applyUpdateSignal(signal);
    };

    const unsubscribe = subscribeToUpdateSignals(handle);

    // Recuperación: un INSERT ocurrido mientras la app estaba suspendida o sin
    // red no llega por Realtime. Una lectura de una fila al montar y al volver
    // la conexión basta y no es un sondeo periódico.
    const catchUp = () => {
      void readLatestSignal()
        .then((signal) => {
          if (active && signal) handle(signal);
        })
        .catch(() => undefined);
    };
    catchUp();
    window.addEventListener("online", catchUp);

    return () => {
      active = false;
      window.removeEventListener("online", catchUp);
      unsubscribe();
    };
  }, [enabled]);
}
