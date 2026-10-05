import type { AIDiagnosticReport, ExcelExportData } from "../types";
import type { Currency } from "../../../types";

export function generateAIDiagnosticSheet(diagnostic: AIDiagnosticReport, baseCurrency: Currency): any[][] {
  const rows: any[][] = [
    ['DIAGNÓSTICO ESTRATÉGICO Y AUDITORÍA INTELIGENTE CON IA (GEMINI)'],
    [`Generado el: ${new Date().toLocaleString('es-CU')} | Puntuación de Salud Financiera: ${diagnostic?.healthScore || 85}/100`],
    [],
    ['=== RESUMEN EJECUTIVO Y ANÁLISIS DE SITUACIÓN ==='],
    [diagnostic?.executiveSummary || 'Auditoría completada.'],
    [],
    ['=== ALERTAS CRÍTICAS DE CAJA Y ARQUEOS ==='],
    ...(diagnostic?.cashAlerts || []).map(alert => [`• ${alert}`]),
    [],
    ['=== INSIGHTS COMERCIALES Y DE FACTURACIÓN ==='],
    ...(diagnostic?.topInsights || []).map(insight => [`• ${insight}`]),
    [],
    ['=== RECOMENDACIONES DE INVENTARIO Y ROTACIÓN ==='],
    ...(diagnostic?.inventoryAdvice || []).map(advice => [`• ${advice}`]),
    [],
    ['=== ACCIONES ESTRATÉGICAS PRIORITARIAS ==='],
    ...(diagnostic?.strategicActions || []).map(action => [`• ${action}`]),
    [],
    ['=== MATRIZ DE AUDITORÍA Y CONTROL OPERATIVO ==='],
    ['Área', 'Métrica / Indicador', 'Estado Actual', 'Diagnóstico Operativo', 'Acción Recomendada', 'Nivel de Prioridad'],
    ...(diagnostic?.structuredAuditRows || [])
  ];

  return rows;
}

// MAIN EXPORT FUNCTION: EXPORT FULL REPORT WITH ALL STRUCTURED SHEETS
