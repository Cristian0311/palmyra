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

export type PalmyraNativeBridge = {
  getInfo(): string;
  confirmBoot(): void;
  startUpdate(version: string, url: string, sha256: string, bytes: number): void;
  /** OTA del APK: el shell verifica firma, versión y SHA-256 antes de instalar. */
  startApkUpdate?(version: string, url: string, sha256: string, bytes: number): void;
  /** Instala un APK elegido con el selector del sistema (USB/SD). */
  importApk?(): void;
  /** Instala un paquete web .zip elegido con el selector del sistema (USB/SD). */
  importBundle?(): void;
};

/**
 * Cifrado del Keystore de Android (`PALMYRA_KEYSTORE`).
 *
 * Solo cruzan texto Base64: el Keystore nunca devuelve la clave AES, solo el
 * sobre cifrado (`sealSecret`) o el texto descifrado (`openSecret`). Ambas
 * respuestas son un envelope JSON con `ok:false` si algo falla.
 */
export type NativeKeystoreBridge = {
  sealSecret(plainBase64: string): string | Promise<string>;
  openSecret(envelopeBase64: string): string | Promise<string>;
};

/**
 * Respaldo del dispositivo (`PALMYRA_BACKUP`).
 *
 * Escribe el sobre cifrado en Descargas públicas y restaura desde un archivo
 * elegido con el selector del sistema. Todas las respuestas son envelopes JSON
 * (`ok:false` con un código corto si falla) y el archivo importado se lee por
 * trozos con `readPending` para no cruzar decenas de MB en una sola llamada.
 * `openPicker` no devuelve envelope: el resultado llega como evento
 * `palmyra-backup-imported`.
 */
export type AndroidBackupBridge = {
  save(fileName: string, dataBase64: string, sha256Expected: string): string | Promise<string>;
  list(): string | Promise<string>;
  remove(name: string): string | Promise<string>;
  openPicker(): void | Promise<void>;
  pendingInfo(): string | Promise<string>;
  readPending(offset: number, length: number): string | Promise<string>;
  clearPending(): string | Promise<string>;
};

/** Evento que el shell dispara al terminar (o cancelar) el selector nativo. */
export const ANDROID_BACKUP_IMPORTED_EVENT = "palmyra-backup-imported";

export type AndroidBackupImportedDetail = {
  ok: boolean;
  name?: string;
  error?: string;
};

declare global {
  interface Window {
    PALMYRA_NATIVE?: PalmyraNativeBridge;
    PALMYRA_KEYSTORE?: NativeKeystoreBridge;
    PALMYRA_BACKUP?: AndroidBackupBridge;
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

/** True solo si el shell expone la OTA del APK (versión con instalador). */
export function hasAndroidOtaBridge(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.PALMYRA_NATIVE;
  return Boolean(bridge && typeof bridge.startApkUpdate === "function");
}

/* ------------------------------------------------------------------ */
/* Keystore de Android (secretos del dispositivo)                      */
/* ------------------------------------------------------------------ */

/** Techo de texto que cruza el puente; el Keystore aplica el mismo límite. */
export const NATIVE_SECRET_MAX_BYTES = 32 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Puente del Keystore del APK; null en escritorio, navegador y PWA. */
export function getNativeKeystoreBridge(): NativeKeystoreBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window.PALMYRA_KEYSTORE;
  if (
    candidate &&
    typeof candidate.sealSecret === "function" &&
    typeof candidate.openSecret === "function"
  ) {
    return candidate;
  }
  return null;
}

/**
 * Puente de respaldo del APK; null en escritorio, navegador y PWA. Se exige la
 * superficie completa: un puente a medias dejaría el panel roto a mitad de un
 * respaldo.
 */
export function getAndroidBackupBridge(): AndroidBackupBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window.PALMYRA_BACKUP;
  if (
    candidate &&
    typeof candidate.save === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.remove === "function" &&
    typeof candidate.openPicker === "function" &&
    typeof candidate.pendingInfo === "function" &&
    typeof candidate.readPending === "function" &&
    typeof candidate.clearPending === "function"
  ) {
    return candidate;
  }
  return null;
}

function parseEnvelope(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > NATIVE_SECRET_MAX_BYTES * 2) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Cifra un texto con la clave AES del Android Keystore y devuelve el sobre en
 * Base64. Nunca lanza: un Keystore roto devuelve null y el llamador degrada.
 */
export async function sealNativeSecret(text: string): Promise<string | null> {
  const bridge = getNativeKeystoreBridge();
  if (!bridge || typeof text !== "string") return null;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0 || bytes.length > NATIVE_SECRET_MAX_BYTES) return null;
  try {
    const envelope = parseEnvelope(await bridge.sealSecret(bytesToBase64(bytes)));
    if (!envelope || envelope.ok !== true) return null;
    const sealed = envelope.envelope;
    if (typeof sealed !== "string" || sealed.length === 0 || sealed.length > NATIVE_SECRET_MAX_BYTES * 2) {
      return null;
    }
    return sealed;
  } catch {
    return null;
  }
}

/** Descifra un sobre del Keystore. Devuelve null si no es descifrable. */
export async function openNativeSecret(envelope: string): Promise<string | null> {
  const bridge = getNativeKeystoreBridge();
  if (!bridge || typeof envelope !== "string" || envelope.length === 0) return null;
  if (envelope.length > NATIVE_SECRET_MAX_BYTES * 2) return null;
  try {
    const result = parseEnvelope(await bridge.openSecret(envelope));
    if (!result || result.ok !== true || typeof result.value !== "string") return null;
    const bytes = base64ToBytes(result.value);
    if (!bytes || bytes.length === 0 || bytes.length > NATIVE_SECRET_MAX_BYTES) return null;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
