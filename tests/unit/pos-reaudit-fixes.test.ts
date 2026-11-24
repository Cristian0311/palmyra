/**
 * Contrato de las correcciones de la re-auditoría A (venta/caja/turnos).
 *
 * 1) Anular una venta desde "Ventas del Turno" exige motivo y espera el
 *    resultado antes de notificar éxito (antes: llamada sin await, sin motivo
 *    y aviso de éxito incondicional con el UUID crudo).
 * 2) El cierre forzado desde Reportes persiste el snapshot local también en
 *    el camino offline/plan Gratis (antes: el set() final no hacía flush).
 * 3) Los KPIs del Dashboard excluyen anuladas/devueltas/AJUSTE_* (mismo
 *    criterio del arqueo y los reportes) y agrupan el gráfico por fecha
 *    operativa Cuba, no por la porción UTC del string.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `no se encontró el marcador inicial: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `no se encontró el marcador final: ${end}`);
  return text.slice(from, to + end.length);
}

test('anular venta desde el modal de caja pide motivo y espera el resultado', () => {
  const modal = source('src/pages/POSCashManagementModal.tsx');
  const dialog = sliceBetween(modal, 'confirmAction.kind === \'sale\' && (', '</section>');

  // Motivo obligatorio (mínimo 3) antes de permitir confirmar.
  assert.match(dialog, /voidReason\.trim\(\)\.length < 3/);
  // La confirmación espera el resultado y solo avisa éxito si la baja se aplicó.
  assert.match(dialog, /await\s+useStore\.getState\(\)\.deleteTransaction\(confirmAction\.id,\s*voidReason\.trim\(\)\)/);
  assert.match(dialog, /if \(ok\) addNotification/);
  // El ticket se muestra con su etiqueta legible, no con el UUID crudo.
  assert.match(modal, /ticketLabel: ticketDisplay\(tx\.ticketNumber,\s*tx\.id\)/);
  assert.match(dialog, /confirmAction\.ticketLabel \|\| confirmAction\.id/);
  // El botón queda inhabilitado mientras la operación está en curso.
  assert.match(dialog, /disabled=\{confirming \|\| \(confirmAction\.kind === 'sale' && voidReason\.trim\(\)\.length < 3\)\}/);
});

test('el cierre forzado desde Reportes hace flush del estado local también offline', () => {
  const actions = source('src/store/actions/cashActions.ts');
  const forceClose = sliceBetween(actions, 'forceCloseSessionFromReports: async', 'return { success: true };\n  },\n  };\n}');

  // Dos flushes: el del camino con error online y el del cierre local/offline.
  const flushes = forceClose.match(/flushLocalStateStorage\(\)/g) || [];
  assert.equal(flushes.length, 2, 'ambos caminos (error online y offline) deben persistir el snapshot');
  // El cierre durable se encola antes de cualquier intento online.
  assert.match(forceClose, /enqueueOfflineItem\('cash_session', queueData, 'cash-close:' \+ sessionId\)/);
});

test('los KPIs del Dashboard excluyen anuladas, devueltas y AJUSTE_*', () => {
  const dashboard = source('src/pages/Dashboard.tsx');

  const filter = sliceBetween(dashboard, 'const effectiveTransactions = useMemo(', ');');
  assert.match(filter, /t\.status === 'completed'/);
  assert.match(filter, /!t\.deletedAt/);
  assert.match(filter, /startsWith\('AJUSTE_'\)/);

  // El desempeño por sucursal usa las ventas efectivas, no el histórico crudo.
  const performance = sliceBetween(dashboard, 'const branchPerformance = useMemo(', '}, [branches, effectiveTransactions]);');
  assert.match(performance, /effectiveTransactions\.reduce/);
  assert.match(performance, /for \(const tx of effectiveTransactions\)/);
});

test('el gráfico de 7 días y "hoy" comparten la fecha operativa de Cuba', () => {
  const dashboard = source('src/pages/Dashboard.tsx');

  // isToday y el gráfico usan la misma fecha operativa que los reportes.
  assert.match(dashboard, /getLocalDateYMD\(dateStr\) === getLocalDateYMD\(new Date\(\)\.toISOString\(\)\)/);
  assert.match(dashboard, /const dayKey = getLocalDateYMD\(tx\.date\)/);
  // Sin agrupar por la porción UTC del string (que movía ventas nocturnas de día).
  const chart = sliceBetween(dashboard, 'const last7DaysData = useMemo(', '}, [filteredTransactions]);');
  assert.doesNotMatch(chart, /tx\.date\.slice\(0,\s*10\)/);
  assert.doesNotMatch(chart, /toISOString\(\)\.split\('T'\)\[0\]/);
});

test('el cierre desde POS no conserva lookups muertos con aserción no nula', () => {
  const pos = source('src/pages/POS.tsx');
  const handleClose = sliceBetween(pos, 'const handleClose = async', 'const processClose = async');
  assert.doesNotMatch(handleClose, /currencies\.find\(c => c\.code === code\)!/);
});
