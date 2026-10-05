import { useEffect, useRef, useState } from 'react';
import type { ExcelExportData } from '../../../utils/excelExport';

export function useReportsExport(getExportData: () => ExcelExportData) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
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

  const handleExportFullExcel = async () => {
    const { exportFullReportsToExcel } = await import('../../../utils/excelExport');
    exportFullReportsToExcel(getExportData());
    setShowExportMenu(false);
    setExportSuccess(true);
    setTimeout(() => setExportSuccess(false), 2500);
  };

  const handleExportSectionExcel = async (sec: 'summary' | 'sales' | 'items' | 'sessions' | 'payroll' | 'products' | 'returns' | 'banks' | 'discrepancies' | 'movements' | 'transfers') => {
    const { exportSingleSectionToExcel } = await import('../../../utils/excelExport');
    exportSingleSectionToExcel(sec, getExportData());
    setShowExportMenu(false);
    setExportSuccess(true);
    setTimeout(() => setExportSuccess(false), 2500);
  };

  return { exportMenuRef, showExportMenu, setShowExportMenu, exportSuccess, handleExportFullExcel, handleExportSectionExcel };
}
