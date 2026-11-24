/**
 * OTA de Android desde el manifiesto firmado.
 *
 * Este módulo es la única puerta entre el manifiesto (bundle web o APK) y el
 * puente nativo `window.PALMYRA_NATIVE`. Antes de llamar al shell se repiten en
 * la web las mismas garantías que aplica MainActivity (HTTPS sin loopback,
 * SHA-256, versión estrictamente creciente y tamaño acotado) para que la UI no
 * quede en "Descargando" cuando el shell rechazaría la petición.
 *
 * El progreso y el resultado llegan por eventos nativos
 * ("palmyra:ota-progress", "palmyra:ota-installed", "palmyra:ota-error"),
 * instalados por `installNativeUpdateHooks`; aquí solo se inicia la descarga.
 * Ninguna función lanza: el peor caso es `{ ok: false, error }` en español.
 */

import { compareVersions } from "./manifest";
import { getNativeAppInfo, type PalmyraNativeBridge } from "../../lib/nativeApp";
import { PRODUCT_VERSION } from "../../lib/productVersion";

export type AndroidUpdateKind = "bundle" | "apk";

export interface AndroidUpdateArtifact {
  kind: AndroidUpdateKind;
  version: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface AndroidUpdateApplyResult {
  ok: boolean;
  error?: string;
}

/** Evento que dispara el shell cuando la actualización quedó aplicada. */
export const ANDROID_UPDATE_EVENT = "palmyra:ota-installed";
/** Evento que dispara el shell cuando la actualización falla. */
export const ANDROID_UPDATE_ERROR_EVENT = "palmyra:ota-error";

/** Techo compartido con el manifiesto: ningún paquete lógico supera 512 MB. */
export const ANDROID_UPDATE_MAX_BYTES = 512 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/i;
const MAX_URL_LENGTH = 2048;

export type AndroidUpdateValidationCode =
  | "invalid_url"
  | "invalid_hash"
  | "invalid_version"
  | "not_newer"
  | "too_large"
  | "unavailable";

/** Mensajes cortos y mostrables; la UI los enseña tal cual. */
const CODE_MESSAGES: Record<AndroidUpdateValidationCode, string> = {
  invalid_url: "El enlace de actualización no es seguro.",
  invalid_hash: "La firma de la actualización no es válida.",
  invalid_version: "La versión de la actualización no es válida.",
  not_newer: "Solo se aplican versiones más nuevas que la instalada.",
  too_large: "El paquete de actualización tiene un tamaño no permitido.",
  unavailable: "Las actualizaciones no están disponibles en este equipo."
};

const BRIDGE_ERROR = "No se pudo iniciar la actualización.";
const APK_UNSUPPORTED = "El instalador no admite APK.";
const INVALID_ARTIFACT = "La actualización recibida no es válida.";

/**
 * Forma estricta del artefacto Android: tipo conocido, texto no vacío y bytes
 * numéricos. No decide si es aplicable (eso es validateAndroidUpdate), solo si
 * el valor puede tratarse como AndroidUpdateArtifact sin romper nada.
 */
export function isAndroidUpdateArtifact(value: unknown): value is AndroidUpdateArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== "bundle" && record.kind !== "apk") return false;
  if (typeof record.version !== "string" || record.version.trim() === "") return false;
  if (typeof record.url !== "string" || record.url.trim() === "") return false;
  if (typeof record.sha256 !== "string" || record.sha256.trim() === "") return false;
  if (typeof record.bytes !== "number" || !Number.isFinite(record.bytes)) return false;
  return true;
}

/** HTTPS sin credenciales embebidas y sin destinos loopback (127/::1). */
function isSecureUpdateUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "") return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "::1" || host === "[::1]" || host === "0.0.0.0") return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const first = Number(ipv4[1]);
    if (first === 0 || first === 127) return false;
  }
  return true;
}

/**
 * Verifica que el artefacto pueda aplicarse sobre `currentVersion`: URL y hash
 * válidos, semver comparable y estrictamente más nuevo, y tamaño entero entre
 * 1 byte y 512 MB. Nunca lanza; `code` es estable y no depende del texto.
 */
export function validateAndroidUpdate(
  artifact: AndroidUpdateArtifact,
  currentVersion: string
): { ok: true } | { ok: false; code: AndroidUpdateValidationCode } {
  try {
    const url = typeof artifact?.url === "string" ? artifact.url.trim() : "";
    if (!isSecureUpdateUrl(url)) return { ok: false, code: "invalid_url" };

    const sha256 = typeof artifact?.sha256 === "string" ? artifact.sha256 : "";
    if (!SHA256_RE.test(sha256)) return { ok: false, code: "invalid_hash" };

    const version = typeof artifact?.version === "string" ? artifact.version : "";
    try {
      // Comparar consigo misma fuerza el semver estricto del manifiesto.
      compareVersions(version, version);
    } catch {
      return { ok: false, code: "invalid_version" };
    }

    const installed = typeof currentVersion === "string" ? currentVersion.trim() : "";
    if (installed === "") return { ok: false, code: "invalid_version" };
    try {
      compareVersions(installed, installed);
    } catch {
      // Sin una versión instalada comparable no se puede probar el avance.
      return { ok: false, code: "invalid_version" };
    }
    if (compareVersions(version, installed) !== 1) return { ok: false, code: "not_newer" };

    const bytes = artifact?.bytes;
    if (
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > ANDROID_UPDATE_MAX_BYTES
    ) {
      return { ok: false, code: "too_large" };
    }

    return { ok: true };
  } catch {
    return { ok: false, code: "invalid_version" };
  }
}

function readWindowBridge(): PalmyraNativeBridge | null {
  if (typeof window === "undefined") return null;
  return window.PALMYRA_NATIVE ?? null;
}

/**
 * Inicia la actualización con el método nativo que corresponde: `startUpdate`
 * para el bundle web y `startApkUpdate` para el APK (este último verifica
 * firma de desarrollador y versionCode antes de abrir el instalador).
 */
export function applyAndroidUpdate(
  artifact: AndroidUpdateArtifact,
  options: { currentVersion?: string; bridge?: PalmyraNativeBridge | null } = {}
): AndroidUpdateApplyResult {
  try {
    if (!isAndroidUpdateArtifact(artifact)) {
      return { ok: false, error: INVALID_ARTIFACT };
    }
    const currentVersion =
      options.currentVersion ?? (getNativeAppInfo()?.webVersion || PRODUCT_VERSION);
    const verdict = validateAndroidUpdate(artifact, currentVersion);
    if (verdict.ok === false) {
      return { ok: false, error: CODE_MESSAGES[verdict.code] };
    }

    const bridge = options.bridge === undefined ? readWindowBridge() : options.bridge;
    if (!bridge) {
      return { ok: false, error: CODE_MESSAGES.unavailable };
    }

    const version = artifact.version.trim();
    const url = artifact.url.trim();
    const sha256 = artifact.sha256.trim();

    if (artifact.kind === "apk") {
      if (typeof bridge.startApkUpdate !== "function") {
        return { ok: false, error: APK_UNSUPPORTED };
      }
      bridge.startApkUpdate(version, url, sha256, artifact.bytes);
    } else {
      if (typeof bridge.startUpdate !== "function") {
        return { ok: false, error: CODE_MESSAGES.unavailable };
      }
      bridge.startUpdate(version, url, sha256, artifact.bytes);
    }
    return { ok: true };
  } catch {
    // El shell lanza si el hilo nativo no está disponible: nunca se propaga.
    return { ok: false, error: BRIDGE_ERROR };
  }
}
