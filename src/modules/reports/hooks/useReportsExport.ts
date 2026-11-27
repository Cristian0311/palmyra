import { useEffect, useRef, useState } from 'react';
import type { ExcelExportData, SectionKey } from '../../../utils/excelExport';
import { SECTION_DEFINITIONS } from '../../../utils/excel/sectionDefinitions';
import { buildFileName } from '../../../utils/excel/theme';
import {
  buildExportSuccessNotification,
  describeExportErrorDetails,
  isExportDownloadError,
} from '../../../utils/exportOutcome';

type ExportNotifier = (message: string, type?: 'success' | 'error' | 'warning' | 'info' | 'loading', details?: string) => void;

/** Cuánto permanece el botón pintado como «descargado» (coherente con Inventario). */
const EXPORT_DONE_MS = 4000;

export function useReportsExport(getExportData: () => ExcelExportData, addNotification?: ExportNotifier) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // El aviso vive fuera del componente: el hook solo lo lanza y limpia el timer.
  useEffect(
    () => () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    []
  );

  const runExport = async (task: () => Promise<void>, fileName: string) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      await task();
      // Solo se anuncia éxito si `downloadWorkbookBuffer` no lanzó, es decir,
      // cuando el archivo quedó guardado (APK) o Chromium aceptó la descarga.
      setExportSuccess(true);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setExportSuccess(false), EXPORT_DONE_MS);
      const notice = buildExportSuccessNotification(fileName);
      addNotification?.(notice.message, notice.tone, notice.details);
    } catch (error) {
      console.error('[Reports] No se pudo generar el libro de Excel:', error);
      // Un fallo de generación/descarga no debe quedar silencioso: antes solo
      // se escribía en consola y el botón parecía no responder.
      addNotification?.(
        isExportDownloadError(error)
          ? 'No se pudo descargar el Excel.'
          : 'No se pudo generar el archivo Excel.',
        'error',
        describeExportErrorDetails(error, fileName)
      );
    } finally {
      setIsExporting(false);
      setShowExportMenu(false);
    }
  };

  const handleExportFullExcel = async () => {
    await runExport(async () => {
      const { exportFullReportsToExcel } = await import('../../../utils/excelExport');
      await exportFullReportsToExcel(getExportData());
    }, buildFileName('Reporte_Completo', 'xlsx'));
  };

  const handleExportSectionExcel = async (sec: SectionKey) => {
    await runExport(async () => {
      const { exportSingleSectionToExcel } = await import('../../../utils/excelExport');
      await exportSingleSectionToExcel(sec, getExportData());
    }, buildFileName(SECTION_DEFINITIONS[sec]?.fileLabel || 'Reporte', 'xlsx'));
  };

  return {
    exportMenuRef,
    showExportMenu,
    setShowExportMenu,
    exportSuccess,
    isExporting,
    handleExportFullExcel,
    handleExportSectionExcel,
  };
}
