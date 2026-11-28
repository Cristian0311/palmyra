import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Regresión del bug «al pulsar Detalles de un reporte no abre».
 *
 * El modal de detalle de turno se abría guardando solo el id y resolviéndolo
 * después contra `cashSessions` (el arreglo crudo del store). Ese arreglo lo
 * reemplaza la sincronización en segundo plano (buildSupabaseSyncState lo
 * reduce a lo que devuelve la nube) y además nunca contiene los turnos
 * «recuperados» que Reportes sí pinta a partir de sus ventas. Resultado: el
 * listado mostraba el turno, el clic guardaba el id y el render no encontraba
 * nada, así que el detalle no aparecía.
 *
 * Las piezas implicadas son JSX con estado de React, así que se fija el
 * contrato de origen: el detalle se resuelve contra la misma lista conciliada
 * que pinta los reportes, conserva una instantánea del turno elegido y avisa
 * cuando el turno ya no existe en lugar de dejar el modal vacío.
 */

const reportsSource = readFileSync(
  fileURLToPath(new URL('../../src/pages/Reports.tsx', import.meta.url)),
  'utf8',
);

function extract(startMarker: string, endMarker: string): string {
  const start = reportsSource.indexOf(startMarker);
  assert.notEqual(start, -1, `No se encontró «${startMarker}» en src/pages/Reports.tsx`);
  const end = reportsSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `No se encontró «${endMarker}» después de «${startMarker}»`);
  return reportsSource.slice(start, end + endMarker.length);
}

test('el detalle del turno no se resuelve contra el arreglo volátil del store', () => {
  const block = extract('const expandedSessionRecord = expandedSession', ';');
  assert.doesNotMatch(block, /cashSessions\.find/, 'el detalle no debe buscarse en cashSessions: la sincronización puede reemplazarlo');
  assert.match(block, /sessionById\.get\(expandedSession\.id\)/, 'el detalle debe refrescarse desde el turno conciliado');
  assert.match(block, /expandedSession\.snapshot/, 'si el turno desaparece de la lista, se conserva la instantánea del clic');
  assert.equal(
    reportsSource.includes('cashSessions.find(s => s.id === expandedSession)'),
    false,
    'quedó el patrón antiguo que dejaba el modal en blanco',
  );
});

test('la fuente del detalle es la misma lista conciliada que pinta los reportes', () => {
  assert.match(
    reportsSource,
    /reconciledSessions,?\s*\} = useReportsSessions\(/,
    'Reports debe recibir reconciledSessions de useReportsSessions',
  );
  assert.match(
    reportsSource,
    /const sessionById = useMemo\(\s*\(\) => new Map\(reconciledSessions\.map\(session => \[session\.id, session\]\)\),\s*\[reconciledSessions\],\s*\)/,
    'el índice del detalle debe construirse desde reconciledSessions (store + turnos recuperados de sus ventas)',
  );
  assert.match(reportsSource, /const filteredCashSessions = filteredSessions;/, 'el listado se pinta desde filteredSessions');
});

test('abrir el detalle guarda el turno elegido y avisa si ya no existe', () => {
  const block = extract('const openSessionDetail =', '};');
  assert.match(block, /setExpandedSession\(\{ id: sessionId, snapshot \}\)/, 'el estado abierto debe llevar la instantánea del turno');
  assert.match(block, /addNotification\(/, 'un turno inexistente debe avisar al usuario');
  assert.match(block, /turno ya no está disponible/, 'el aviso debe ser explícito en español');
  assert.match(block, /return;/, 'sin turno no se abre un modal vacío');
});

test('el estado del detalle guarda id más instantánea, no solo un id', () => {
  assert.match(
    reportsSource,
    /const \[expandedSession, setExpandedSession\] = useState<\{ id: string; snapshot: CashRegisterSession \} \| null>\(null\)/,
  );
  assert.match(
    reportsSource,
    /current\?\.id === shiftVoidTarget\.id \? null : current/,
    'cerrar por eliminación de turno debe comparar el id del registro seleccionado',
  );
});

test('los modales de detalle diferidos muestran su carga en lugar de un hueco', () => {
  for (const modal of ['ReportsSelectedTransferModal', 'ReportsDiscrepancyDetailModal', 'ReportsMovementDetailModal']) {
    const index = reportsSource.indexOf(`<${modal}`);
    assert.notEqual(index, -1, `no se encontró el modal ${modal}`);
    const before = reportsSource.slice(Math.max(0, index - 300), index);
    assert.match(
      before,
      /<Suspense fallback=\{detailModalFallback\}>/,
      `${modal} debe mostrar la carga del fragmento, no fallback={null}`,
    );
  }
  assert.match(reportsSource, /Cargando detalle…/);
});
