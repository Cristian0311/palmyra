import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { applySessionBusinessDate } = await import('../../src/store/utils/syncMerges');
const { keepLocalBusinessDate, replaceRemoteRecords } = await import(
  '../../src/store/utils/replaceRemoteRecords'
);

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

test('una venta hereda la fecha de negocio de su turno al fusionar el pull', () => {
  const ventas = [
    { id: 't1', sessionId: 's1' },
    { id: 't2', sessionId: 's1', businessDate: '2026-11-01' },
    { id: 't3', sessionId: 's2' },
    { id: 't4' },
  ];
  const turnos = [
    { id: 's1', businessDate: '2026-11-15' },
    { id: 's2', businessDate: 'no-es-fecha' },
  ];
  const resultado = applySessionBusinessDate(ventas, turnos);
  assert.equal(resultado.find(tx => tx.id === 't1')?.businessDate, '2026-11-15');
  assert.equal(resultado.find(tx => tx.id === 't2')?.businessDate, '2026-11-15', 'el turno manda sobre una metadata vieja');
  assert.equal(resultado.find(tx => tx.id === 't3')?.businessDate, undefined, 'una fecha inválida no se propaga');
  assert.equal(resultado.find(tx => tx.id === 't4')?.businessDate, undefined, 'sin turno no se inventa fecha');
  assert.equal(ventas[0].businessDate, undefined, 'no muta la entrada');
});

test('el pull no pisa la fecha de negocio local aunque el remoto no la tenga', () => {
  const remoto = [
    { id: 't1', total: 10 },
    { id: 't2', total: 20, businessDate: '2026-11-10' },
  ];
  const local = [
    { id: 't1', total: 10, businessDate: '2026-11-15' },
    { id: 't2', total: 20, businessDate: '2026-11-15' },
    { id: 't3', total: 30, businessDate: '2026-11-15' },
  ];
  const fusionado = replaceRemoteRecords(remoto, local, new Set(['t3']));
  const porId = new Map(fusionado.map(tx => [tx.id, tx]));
  assert.equal(porId.get('t1')?.businessDate, '2026-11-15', 'el remoto sin fecha conserva la elegida');
  assert.equal(porId.get('t2')?.businessDate, '2026-11-10', 'el remoto con fecha es autoridad');
  assert.equal(porId.get('t3')?.businessDate, '2026-11-15', 'una venta encolada ausente en el remoto sobrevive');
  assert.deepEqual(keepLocalBusinessDate({ id: 'x' }, undefined), { id: 'x' });
});

test('el día de negocio viaja a la nube en la metadata del turno y de la venta', () => {
  const cashMutations = source('src/services/supabaseSync/cashMutations.ts');
  assert.match(
    cashMutations,
    /businessDate:normalizeBusinessDateYMD\(session\.businessDate\)\|\|null/,
    'el cierre y la corrección de fecha publican el día de negocio del turno',
  );

  const rpc = source('src/services/supabaseSync/rpc.ts');
  assert.match(
    rpc,
    /businessDate: normalizeBusinessDateYMD\(tx\.businessDate\) \|\| null/,
    'la venta registrada lleva su día de negocio en metadata',
  );

  const pull = source('src/services/supabaseSync/pull.ts');
  const sessionBusinessDate = pull.match(/businessDate:\s*typeof s\.metadata\?\.businessDate/g) || [];
  assert.equal(sessionBusinessDate.length, 2, 'pull rehidrata la fecha en ventas y turnos');
});

test('el merge del pull hereda la fecha del turno de forma centralizada', () => {
  const build = source('src/store/utils/buildSupabaseSyncState.ts');
  assert.match(build, /applySessionBusinessDate\(mergedTransactionsRaw, mergedCashSessions\)/);
});
