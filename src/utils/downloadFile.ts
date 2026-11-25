/**
 * Descarga de archivos generados por la web (Excel, CSV, TXT, diagnósticos).
 *
 * En el APK el DownloadListener nativo no puede leer URLs `blob:`, así que el
 * contenido viaja como Base64 por `PALMYRA_NATIVE.saveFile` y el shell lo
 * escribe en Descargas públicas. En navegador, PWA y escritorio Electron se
 * usa el enlace `blob:` de siempre: Chromium lo entrega a su gestor de
 * descargas.
 */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Mismo techo que aplica el shell (AndroidBackup) al guardar el archivo. */
export const NATIVE_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const EXPORT_FAILED_MESSAGE =
  "No se pudo descargar el archivo. Revisa el espacio disponible e inténtalo de nuevo.";

export type NativeSaveFileBridge = {
  saveFile(fileName: string, dataBase64: string, mimeType: string): string | Promise<string>;
};

/** Base64 estándar sin depender de `btoa` ni de `Buffer`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    chunk +=
      B64_ALPHABET[a >> 2] +
      B64_ALPHABET[((a & 0x03) << 4) | (b >> 4)] +
      (index + 1 < bytes.length ? B64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : "=") +
      (index + 2 < bytes.length ? B64_ALPHABET[c & 0x3f] : "=");
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (chunk) parts.push(chunk);
  return parts.join("");
}

function getNativeSaveFileBridge(): NativeSaveFileBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window.PALMYRA_NATIVE;
  if (candidate && typeof candidate.saveFile === "function") {
    return candidate as unknown as NativeSaveFileBridge;
  }
  return null;
}

export type NativeExportResult = "saved" | "failed" | null;

/**
 * Guarda bytes con el puente nativo del APK cuando existe. Devuelve null sin
 * puente (el llamador usa el enlace blob:), "saved" si el shell confirmó la
 * escritura y "failed" si la rechazó o el archivo excede el techo.
 */
export function saveExportViaNativeBridge(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  bridge: NativeSaveFileBridge | null | undefined = getNativeSaveFileBridge()
): NativeExportResult {
  if (!bridge) return null;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return "failed";
  if (bytes.length > NATIVE_EXPORT_MAX_BYTES) return "failed";
  let raw: unknown;
  try {
    raw = bridge.saveFile(
      String(fileName || ""),
      bytesToBase64(bytes),
      String(mimeType || "application/octet-stream")
    );
  } catch {
    return "failed";
  }
  // El puente del APK responde síncrono; un thenable no es esperable aquí.
  if (raw && typeof raw === "object" && typeof (raw as PromiseLike<unknown>).then === "function") {
    return "failed";
  }
  if (typeof raw !== "string") return "failed";
  try {
    const envelope = JSON.parse(raw) as unknown;
    const ok = Boolean(
      envelope && typeof envelope === "object" && (envelope as Record<string, unknown>).ok === true
    );
    return ok ? "saved" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Descarga bytes como archivo. En el APK usa el puente nativo; en el resto,
 * el enlace `blob:` tradicional. Devuelve false solo cuando el entorno no
 * puede iniciar la descarga (sin `document` ni `Blob`); un fallo del puente
 * nativo lanza para que la interfaz muestre su notificación de error.
 */
export function downloadGeneratedFile(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string
): boolean {
  const native = saveExportViaNativeBridge(bytes, fileName, mimeType);
  if (native === "saved") return true;
  if (native === "failed") throw new Error(EXPORT_FAILED_MESSAGE);
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof Blob === "undefined"
  ) {
    return false;
  }
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Revocar de inmediato cancela la descarga en algunos navegadores.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    throw new Error(EXPORT_FAILED_MESSAGE);
  }
}
