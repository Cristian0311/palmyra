import {
  emptyHubStatus,
  getDesktopHubBridge,
  type DesktopHubResult,
  type DesktopHubStatus
} from "../../lib/desktopRuntime";

/**
 * Arranque del hub LAN desde la app cuando este equipo es el principal.
 *
 * Todo pasa por el puente del preload: aquí no se abre ningún puerto. Las
 * funciones son idempotentes y no se ejecutan solas; la UI o el módulo de
 * integración decide cuándo llamarlas.
 */

const UNAVAILABLE_MESSAGE = "El hub LAN solo está disponible en la app de escritorio";

export interface HubRuntimeState {
  /** false en navegador, PWA o APK: el puente no existe. */
  available: boolean;
  status: DesktopHubStatus;
}

let current: DesktopHubStatus | null = null;
let starting: Promise<HubRuntimeState> | null = null;

function unavailable(): HubRuntimeState {
  return { available: false, status: emptyHubStatus(UNAVAILABLE_MESSAGE) };
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = typeof error === "string" ? error.trim() : "";
  return text || fallback;
}

async function call(
  action: () => Promise<DesktopHubResult>,
  fallback: string
): Promise<HubRuntimeState> {
  try {
    const result = await action();
    if (result && result.ok === true && result.status) {
      current = result.status;
      return { available: true, status: result.status };
    }
    const message =
      result && result.ok === false && typeof result.error === "string" && result.error.trim()
        ? result.error.trim()
        : fallback;
    current = emptyHubStatus(message);
    return { available: true, status: current };
  } catch (error) {
    current = emptyHubStatus(errorText(error, fallback));
    return { available: true, status: current };
  }
}

/**
 * Arranca el hub si aún no corre. Si ya está en marcha no repite `start` y,
 * como el hub sirve a una sola empresa, tampoco lo reinicia con otra.
 */
export function ensureHubStarted(companyId: string): Promise<HubRuntimeState> {
  const bridge = getDesktopHubBridge();
  if (!bridge) return Promise.resolve(unavailable());
  if (current?.running) return Promise.resolve({ available: true, status: current });

  const id = typeof companyId === "string" ? companyId.trim() : "";
  if (!id) {
    current = emptyHubStatus("Falta la empresa para iniciar el hub LAN");
    return Promise.resolve({ available: true, status: current });
  }
  if (starting) return starting;

  starting = (async () => {
    try {
      const snapshot = await bridge.status();
      if (snapshot && snapshot.ok === true && snapshot.status?.running) {
        current = snapshot.status;
        return { available: true, status: current };
      }
      const started = await call(() => bridge.start(id), "No se pudo iniciar el hub LAN");
      return started;
    } catch (error) {
      current = emptyHubStatus(errorText(error, "No se pudo iniciar el hub LAN"));
      return { available: true, status: current };
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Estado actual del hub; `null` cuando no hay puente de escritorio. */
export async function getHubStatus(): Promise<DesktopHubStatus | null> {
  const bridge = getDesktopHubBridge();
  if (!bridge) return null;
  return (await call(() => bridge.status(), "No se pudo leer el estado del hub LAN")).status;
}

/** Igual que `getHubStatus`, con nombre pensado para refrescos desde la UI. */
export async function refreshHubStatus(): Promise<DesktopHubStatus | null> {
  return getHubStatus();
}

export async function stopHub(): Promise<HubRuntimeState> {
  const bridge = getDesktopHubBridge();
  if (!bridge) return unavailable();
  const state = await call(() => bridge.stop(), "No se pudo detener el hub LAN");
  if (!state.status.running) starting = null;
  return state;
}

export async function newPairingCode(): Promise<HubRuntimeState> {
  const bridge = getDesktopHubBridge();
  if (!bridge) return unavailable();
  return call(() => bridge.newPairingCode(), "No se pudo generar un código de emparejamiento");
}
