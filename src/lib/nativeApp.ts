export type NativeAppInfo = {
  platform: string;
  shellVersion: string;
  webVersion: string;
  ota: boolean;
};

export type NativeUpdateRequest = {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
};

export type NativeOtaProgress = {
  phase?: "downloading" | "verifying" | "applying" | "reloading" | string;
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
};

type PalmyraNativeBridge = {
  getInfo(): string;
  confirmBoot(): void;
  startUpdate(version: string, url: string, sha256: string, bytes: number): void;
};

declare global {
  interface Window {
    PALMYRA_NATIVE?: PalmyraNativeBridge;
    __palmyraOtaProgress?: (detail: NativeOtaProgress) => void;
    __palmyraOtaInstalled?: (version?: string) => void;
    __palmyraOtaError?: (message?: string) => void;
  }
}

let cachedInfo: NativeAppInfo | null | undefined;

export function getNativeAppInfo(): NativeAppInfo | null {
  if (cachedInfo !== undefined) return cachedInfo;
  const bridge = typeof window !== "undefined" ? window.PALMYRA_NATIVE : undefined;
  if (!bridge) {
    cachedInfo = null;
    return cachedInfo;
  }
  try {
    const parsed = JSON.parse(bridge.getInfo()) as Partial<NativeAppInfo>;
    cachedInfo = {
      platform: String(parsed.platform || "android"),
      shellVersion: String(parsed.shellVersion || ""),
      webVersion: String(parsed.webVersion || ""),
      ota: parsed.ota === true,
    };
  } catch {
    cachedInfo = null;
  }
  return cachedInfo;
}

/**
 * Conecta los callbacks nativos con eventos de la web. Se instala antes de
 * renderizar para que ninguna actualización pierda progreso o errores.
 */
export function installNativeUpdateHooks(): void {
  if (!getNativeAppInfo()) return;
  const size = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  window.__palmyraOtaProgress = (detail) => {
    // El progreso nativo siempre debe llevar bytes para mostrar MB reales.
    const payload: NativeOtaProgress = {
      phase: detail?.phase,
      percent: size(detail?.percent),
      receivedBytes: size(detail?.receivedBytes),
      totalBytes: size(detail?.totalBytes),
    };
    window.dispatchEvent(new CustomEvent<NativeOtaProgress>("palmyra:ota-progress", { detail: payload }));
  };
  window.__palmyraOtaInstalled = (version) => {
    window.dispatchEvent(new CustomEvent("palmyra:ota-installed", { detail: { version } }));
  };
  window.__palmyraOtaError = (message) => {
    window.dispatchEvent(new CustomEvent("palmyra:ota-error", { detail: { message } }));
  };
}

/** La app quedó operativa: el shell puede dar por buena esta versión. */
export function confirmNativeBoot(): void {
  try {
    if (getNativeAppInfo()) window.PALMYRA_NATIVE?.confirmBoot();
  } catch {
    // El puente es opcional; en navegador/PWA no existe.
  }
}

export function startNativeUpdate(update: NativeUpdateRequest): boolean {
  const bridge = typeof window !== "undefined" ? window.PALMYRA_NATIVE : undefined;
  if (!bridge) return false;
  try {
    const version = String(update.version || "").trim();
    const url = String(update.url || "").trim();
    const sha256 = String(update.sha256 || "").trim();
    const parsedBytes = Number(update.bytes);
    // El shell exige versión, HTTPS y SHA-256: se valida aquí para no dejar la
    // UI en "Descargando" cuando el puente rechazaría la petición.
    if (!version || !/^https:\/\//i.test(url) || !/^[a-f0-9]{64}$/i.test(sha256)) return false;
    bridge.startUpdate(version, url, sha256, Number.isFinite(parsedBytes) && parsedBytes > 0 ? Math.floor(parsedBytes) : 0);
    return true;
  } catch {
    return false;
  }
}
