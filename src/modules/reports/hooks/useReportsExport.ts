import { useEffect, useRef, useState } from 'react';
import type { ExcelExportData, SectionKey } from '../../../utils/excelExport';

type ExportNotifier = (message: string, type?: 'success' | 'error' | 'warning' | 'info' | 'loading', details?: string) => void;

export function useReportsExport(getExportData: () => ExcelExportData, addNotification?: ExportNotifier) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const runExport = async (task: () => Promise<void>) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      await task();
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 2500);
    } catch (error) {
      console.error('[Reports] No se pudo generar el libro de Excel:', error);
      // Un fallo de generación/descarga no debe quedar silencioso: antes solo
      // se escribía en consola y el botón parecía no responder.
      const detail = error instanceof Error && error.message ? error.message : 'Revisa la conexión e inténtalo de nuevo.';
      addNotification?.('No se pudo generar el archivo Excel.', 'error', detail);
    } finally {
      setIsExporting(false);
      setShowExportMenu(false);
    }
  };

  const handleExportFullExcel = async () => {
    await runExport(async () => {
      const { exportFullReportsToExcel } = await import('../../../utils/excelExport');
      await exportFullReportsToExcel(getExportData());
    });
  };

  const handleExportSectionExcel = async (sec: SectionKey) => {
    await runExport(async () => {
      const { exportSingleSectionToExcel } = await import('../../../utils/excelExport');
      await exportSingleSectionToExcel(sec, getExportData());
    });
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
