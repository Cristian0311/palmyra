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

/** Carpeta donde el shell del APK escribe las exportaciones (MediaStore). */
const NATIVE_DOWNLOAD_FOLDER = "Descargas";

/** Motivos que devuelve `PALMYRA_NATIVE.saveFile` en su envelope de error. */
const NATIVE_ERROR_REASONS: Record<string, string> = {
  permission_denied:
    "Android denegó el permiso de almacenamiento. Actívalo en Ajustes › Aplicaciones › PALMYRA › Permisos y vuelve a intentarlo.",
  too_large:
    "El archivo supera el tamaño que admite el puente de descarga del APK. Filtra el rango de fechas e inténtalo de nuevo.",
  empty_data: "El archivo quedó vacío: no hay datos suficientes para generarlo.",
  invalid_name: "El nombre del archivo no es válido para el almacenamiento de Android.",
  invalid_base64: "El contenido llegó corrupto al sistema de archivos de Android.",
  invalid_argument: "Faltan datos para escribir el archivo en Android.",
  checksum_mismatch: "La verificación del archivo falló antes de guardarlo.",
  invalid_checksum: "La verificación del archivo no pudo calcularse.",
  write_failed:
    "Android no pudo escribir en la carpeta Descargas. Revisa el espacio disponible e inténtalo de nuevo.",
  unavailable: "La carpeta Descargas de Android no está disponible en este momento.",
};

export type NativeSaveFileBridge = {
  saveFile(fileName: string, dataBase64: string, mimeType: string): string | Promise<string>;
};

/**
 * Resultado discriminado de una descarga iniciada desde el renderer.
 *
 * `saved` significa que el archivo quedó escrito (APK) o que Chromium aceptó
 * la descarga (web/PWA/Electron); `failed` trae el motivo real; `unavailable`
 * indica que el entorno no puede iniciar ninguna descarga.
 */
export type GeneratedFileOutcome =
  | { status: "saved"; via: "native" | "browser"; fileName: string; location?: string }
  | { status: "failed"; reason: string; fileName?: string }
  | { status: "unavailable"; fileName?: string };

/** Traducción al español del motivo técnico de un fallo de guardado. */
export function describeNativeFailureReason(reason: string): string {
  const key = String(reason || "").trim();
  return NATIVE_ERROR_REASONS[key] || EXPORT_FAILED_MESSAGE;
}

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

export type NativeSaveFileResult = {
  status: NativeExportResult;
  fileName?: string;
  location?: string;
  reason?: string;
};

/**
 * Guarda bytes con el puente nativo del APK cuando existe. Devuelve `status:
 * null` sin puente (el llamador usa el enlace blob:), `saved` si el shell
 * confirmó la escritura —con la ruta que devolvió— y `failed` con el motivo
 * técnico que informó el envelope (`error`) o `native_rejected`.
 */
export function saveExportViaNativeBridgeDetailed(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  bridge: NativeSaveFileBridge | null | undefined = getNativeSaveFileBridge()
): NativeSaveFileResult {
  if (!bridge) return { status: null };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { status: "failed", reason: "empty_data" };
  }
  if (bytes.length > NATIVE_EXPORT_MAX_BYTES) {
    return { status: "failed", reason: "too_large" };
  }
  const safeName = String(fileName || "");
  let raw: unknown;
  try {
    raw = bridge.saveFile(
      safeName,
      bytesToBase64(bytes),
      String(mimeType || "application/octet-stream")
    );
  } catch {
    return { status: "failed", reason: "write_failed" };
  }
  // El puente del APK responde síncrono; un thenable no es esperable aquí.
  if (raw && typeof raw === "object" && typeof (raw as PromiseLike<unknown>).then === "function") {
    return { status: "failed", reason: "async_bridge" };
  }
  if (typeof raw !== "string") return { status: "failed", reason: "malformed_response" };
  let envelope: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") envelope = parsed as Record<string, unknown>;
  } catch {
    envelope = null;
  }
  if (!envelope) return { status: "failed", reason: "malformed_response" };
  if (envelope.ok !== true) {
    const reason = typeof envelope.error === "string" ? envelope.error : "";
    return { status: "failed", reason: reason || "native_rejected" };
  }
  const reportedLocation = typeof envelope.location === "string" ? envelope.location : "";
  // La ruta se muestra siempre en español; la que informa el shell queda como
  // detalle técnico en el aviso de éxito.
  const label = safeName || "archivo";
  const location = reportedLocation
    ? `${NATIVE_DOWNLOAD_FOLDER} · ${reportedLocation}`
    : NATIVE_DOWNLOAD_FOLDER;
  return { status: "saved", fileName: safeName, location };
}

/**
 * Versión corta del contrato anterior: solo estado, sin ruta ni motivo. Se
 * conserva porque las pruebas del shell Android la consumen tal cual.
 */
export function saveExportViaNativeBridge(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  bridge: NativeSaveFileBridge | null | undefined = getNativeSaveFileBridge()
): NativeExportResult {
  return saveExportViaNativeBridgeDetailed(bytes, fileName, mimeType, bridge).status;
}

/**
 * Descarga bytes como archivo y dice la verdad de lo que pasó. En el APK usa el
 * puente nativo; en el resto, el enlace `blob:` tradicional. Nunca lanza: los
 * llamadores deciden el aviso a partir del resultado discriminado, de modo que
 * solo se anuncia éxito cuando el archivo quedó realmente guardado.
 */
export function downloadGeneratedFile(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string
): GeneratedFileOutcome {
  const safeName = String(fileName || "");
  const native = saveExportViaNativeBridgeDetailed(bytes, safeName, mimeType);
  if (native.status === "saved") {
    return {
      status: "saved",
      via: "native",
      fileName: safeName,
      location: native.location || `${safeName} · ${NATIVE_DOWNLOAD_FOLDER}`,
    };
  }
  if (native.status === "failed") {
    return { status: "failed", reason: native.reason || "native_rejected", fileName: safeName };
  }
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof Blob === "undefined"
  ) {
    return { status: "unavailable", fileName: safeName };
  }
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Revocar de inmediato cancela la descarga en algunos navegadores.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { status: "saved", via: "browser", fileName: safeName };
  } catch {
    return { status: "failed", reason: "browser_download_rejected", fileName: safeName };
  }
}

/** Aviso listo para `addNotification(message, type, details)`. */
export type ExportNotification = {
  message: string;
  tone: "success" | "error";
  details?: string;
};

/**
 * Traduce un resultado de descarga al aviso que verá el dueño, en español y con
 * el nombre del archivo. Es pura para poder probarla sin React: así Reportes e
 * Inventario anuncian exactamente lo mismo y ningún fallo pinta de éxito.
 */
export function describeExportOutcome(
  outcome: GeneratedFileOutcome,
  fallbackFileName?: string
): ExportNotification {
  if (outcome.status === "saved") {
    const name = outcome.fileName || fallbackFileName || "archivo";
    if (outcome.via === "native") {
      return {
        message: "Archivo descargado ✓",
        tone: "success",
        details: `${name} · ${outcome.location || `${name} · ${NATIVE_DOWNLOAD_FOLDER}`}`,
      };
    }
    return {
      message: "Archivo descargado ✓",
      tone: "success",
      details: `${name} · carpeta Descargas`,
    };
  }
  if (outcome.status === "failed") {
    const name = outcome.fileName || fallbackFileName;
    return {
      message: "No se pudo descargar el archivo.",
      tone: "error",
      details: [describeNativeFailureReason(outcome.reason), name ? `Archivo: ${name}` : ""]
        .filter(Boolean)
        .join(" · "),
    };
  }
  return {
    message: "Este dispositivo no pudo iniciar la descarga.",
    tone: "error",
    details: [
      "Actualiza PALMYRA o abre el programa en otra ventana e inténtalo de nuevo.",
      outcome.fileName || fallbackFileName ? `Archivo: ${outcome.fileName || fallbackFileName}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * Compatibilidad con los llamadores que comprueban éxito/fracaso fuera del
 * sistema de avisos (p. ej. el informe de diagnóstico de instalación).
 */
export function exportOutcomeFailed(outcome: GeneratedFileOutcome): boolean {
  return outcome.status !== "saved";
}

/** Error con el motivo en español del fallo: lo lanza `downloadWorkbookBuffer`. */
export class ExportDownloadError extends Error {
  readonly outcome: GeneratedFileOutcome;

  constructor(outcome: GeneratedFileOutcome) {
    super(describeExportOutcome(outcome).details || EXPORT_FAILED_MESSAGE);
    this.name = "ExportDownloadError";
    this.outcome = outcome;
  }
}

/** El error de guardado se reconoce también por su carga útil (cross-module safe). */
export function isExportDownloadError(error: unknown): error is ExportDownloadError {
  if (error instanceof ExportDownloadError) return true;
  const outcome = (error as { outcome?: { status?: unknown } } | null)?.outcome;
  return Boolean(outcome && typeof outcome.status === "string");
}

/** Motivo en español de cualquier fallo de exportación (guardado o generación). */
export function describeExportErrorDetails(error: unknown, fileName?: string): string {
  if (isExportDownloadError(error)) {
    return describeExportOutcome(error.outcome, fileName).details || EXPORT_FAILED_MESSAGE;
  }
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "";
  return [detail || EXPORT_FAILED_MESSAGE, fileName ? `Archivo: ${fileName}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Variante que lanza en lugar de devolver el resultado, para funciones cuyo
 * contrato es `Promise<void>` y dejan el aviso en manos del llamador.
 */
export function downloadGeneratedFileOrThrow(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string
): GeneratedFileOutcome {
  const outcome = downloadGeneratedFile(bytes, fileName, mimeType);
  if (outcome.status !== "saved") throw new ExportDownloadError(outcome);
  return outcome;
}

/**
 * Aviso de éxito de una descarga ya confirmada, con nombre del archivo y la
 * carpeta donde quedó. Compartido por Reportes e Inventario para que el dueño vea
 * siempre el mismo texto perceptible.
 */
export function buildExportSuccessNotification(
  fileName: string,
  location = "carpeta Descargas"
): ExportNotification {
  return {
    message: "Excel descargado ✓",
    tone: "success",
    details: `${fileName} · ${location}`,
  };
}
