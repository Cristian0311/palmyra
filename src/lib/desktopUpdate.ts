/**
 * Actualización automática de la app de escritorio (Electron + electron-updater).
 *
 * El proceso principal consulta GitHub Releases, descarga el Setup y avisa por
 * IPC. Aquí solo se consume el puente que expone el preload aislado con
 * contextBridge (`window.palmyraDesktopUpdate`): la interfaz nunca tiene acceso
 * a Node ni a ipcRenderer.
 *
 * En navegador, PWA y APK Android el puente no existe y todo queda inerte: la
 * actualización Android sigue usando su propio flujo OTA.
 */

export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "blocked"
  | "error"
  | "unsupported";

export type DesktopUpdateState = {
  status: DesktopUpdateStatus;
  currentVersion: string;
  version: string;
  percent: number;
  transferred: number;
  total: number;
  message: string;
  error: string;
  updatedAt: number;
};

export type DesktopUpdateInstallResult = { ok: boolean; error?: string };

export type DesktopUpdaterBridge = {
  getState(): Promise<DesktopUpdateState | null>;
  check(): Promise<DesktopUpdateState | null>;
  download(): Promise<DesktopUpdateState | null>;
  install(): Promise<DesktopUpdateInstallResult>;
  onState(callback: (state: DesktopUpdateState) => void): () => void;
};

declare global {
  interface Window {
    palmyraDesktopUpdate?: DesktopUpdaterBridge;
  }
}

const STATUSES: readonly DesktopUpdateStatus[] = [
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "not-available",
  "blocked",
  "error",
  "unsupported",
];

const asText = (value: unknown, max = 400) =>
  typeof value === "string" ? value.slice(0, max) : "";

const asCount = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
};

/** Nunca se confía en la forma del mensaje IPC: se valida campo a campo. */
export function normalizeDesktopUpdateState(raw: unknown): DesktopUpdateState | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const status = asText(source.status, 40) as DesktopUpdateStatus;
  if (!STATUSES.includes(status)) return null;
  return {
    status,
    currentVersion: asText(source.currentVersion, 40),
    version: asText(source.version, 40),
    percent: Math.min(100, asCount(source.percent)),
    transferred: asCount(source.transferred),
    total: asCount(source.total),
    message: asText(source.message),
    error: asText(source.error),
    updatedAt: asCount(source.updatedAt),
  };
}

/** Devuelve el puente solo si el preload lo expuso con todas sus funciones. */
export function getDesktopUpdater(): DesktopUpdaterBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.palmyraDesktopUpdate;
  if (!bridge || typeof bridge !== "object") return null;
  if (
    typeof bridge.getState !== "function" ||
    typeof bridge.check !== "function" ||
    typeof bridge.download !== "function" ||
    typeof bridge.install !== "function" ||
    typeof bridge.onState !== "function"
  ) {
    return null;
  }
  return bridge;
}

/** Etiqueta corta de cada estado, lista para mostrar en español. */
export const DESKTOP_UPDATE_STATUS_LABELS: Record<DesktopUpdateStatus, string> = {
  idle: "Sin comprobar",
  checking: "Buscando actualización",
  available: "Preparando descarga",
  downloading: "Descargando actualización",
  downloaded: "Lista para instalar",
  "not-available": "Todo al día",
  blocked: "Actualización bloqueada",
  error: "Actualización detenida",
  unsupported: "No disponible",
};
