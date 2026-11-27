/**
 * Avisos de exportación compartidos entre Reportes e Inventario.
 *
 * El contrato honesto de descarga vive en `downloadFile.ts`; este módulo lo
 * reexporta para que las pantallas y los generadores de libros importen una sola
 * cosa, y añade el aviso de error genérico. Así las tres superficies —web,
 * Electron y APK— muestran el mismo texto en español y jamás un éxito cuando el
 * archivo no quedó guardado.
 */
import {
  describeExportErrorDetails,
  isExportDownloadError,
  type ExportNotification
} from "./downloadFile";

export {
  buildExportSuccessNotification,
  describeExportErrorDetails,
  describeExportOutcome,
  downloadGeneratedFileOrThrow,
  ExportDownloadError,
  isExportDownloadError,
} from "./downloadFile";
export type { ExportNotification, GeneratedFileOutcome } from "./downloadFile";

const FALLBACK_EXPORT_MESSAGE = "No se pudo descargar el archivo.";

/**
 * Aviso de burbuja global para un fallo de exportación, sea del puente de
 * descarga o de la propia generación del libro. En ningún caso produce tono de
 * éxito: el detalle siempre trae el motivo en español y el nombre del archivo.
 */
export function describeExportFailure(error: unknown, fileName?: string): ExportNotification {
  const downloadFailure = isExportDownloadError(error);
  return {
    message: downloadFailure
      ? "No se pudo descargar el archivo."
      : "No se pudo generar el archivo Excel.",
    tone: "error",
    details: describeExportErrorDetails(error, fileName) || FALLBACK_EXPORT_MESSAGE,
  };
}
