import test from 'node:test';
import assert from 'node:assert/strict';
import {
  companyCreatedAlertLines,
  planCancelledAlertLines,
  planRequestAlertLines,
  supportAlertLines,
} from '../../src/lib/ownerAlertMessages';

test('supportAlertLines incluye empresa, asunto, detalle y solicitud', () => {
  const lines = supportAlertLines({
    companyName: 'Bodega Central',
    requestType: 'Error detectado',
    subject: 'La caja no abre',
    message: 'Al pulsar abrir turno no responde.',
    requestId: 'abc-123',
  });
  assert.ok(lines.includes('Empresa: Bodega Central'));
  assert.ok(lines.includes('Tipo: Error detectado'));
  assert.ok(lines.includes('Asunto: La caja no abre'));
  assert.ok(lines.includes('Detalle: Al pulsar abrir turno no responde.'));
  assert.ok(lines.includes('Solicitud: abc-123'));
  assert.ok(lines.every((line) => typeof line === 'string' && line.length > 0));
});

test('supportAlertLines omite teléfono y diagnóstico vacíos', () => {
  const lines = supportAlertLines({
    companyName: 'Mi Empresa',
    requestType: 'Mejora',
    subject: 'Sugerencia',
    message: 'Agregar exportación a PDF.',
    contactPhone: '   ',
  });
  assert.ok(!lines.some((line) => line.startsWith('Teléfono:')));
  assert.ok(!lines.some((line) => line.startsWith('Versión:')));
});

test('planRequestAlertLines describe plan, duración, pago e importe', () => {
  const lines = planRequestAlertLines({
    companyName: 'Mi Tienda',
    planName: 'Starter',
    months: 3,
    paymentMethodLabel: 'Efectivo CUP',
    amountLabel: '1.500,00 CUP',
    requestId: 'req-9',
  });
  assert.ok(lines.includes('Plan solicitado: Starter'));
  assert.ok(lines.includes('Duración: 3 mes(es)'));
  assert.ok(lines.includes('Método de pago: Efectivo CUP'));
  assert.ok(lines.includes('Importe de referencia: 1.500,00 CUP'));
  assert.ok(lines.includes('Solicitud: req-9'));
  assert.ok(lines.some((line) => line.includes('no cambia hasta que se confirme el pago')));
});

test('planCancelledAlertLines deja claro que el cliente canceló', () => {
  const lines = planCancelledAlertLines({ companyName: 'Mi Tienda', requestId: 'req-9' });
  assert.ok(lines.includes('Empresa: Mi Tienda'));
  assert.ok(lines.includes('Solicitud: req-9'));
  assert.ok(lines.some((line) => line.includes('canceló su solicitud')));
});

test('companyCreatedAlertLines informa alta y plan inicial', () => {
  const lines = companyCreatedAlertLines({
    companyName: 'Nueva Bodega',
    planName: 'Gratis',
    paymentMethodLabel: 'Sin pago (plan Gratis)',
    months: 1,
    ownerEmail: 'dueno@example.com',
  });
  assert.ok(lines.includes('Empresa: Nueva Bodega'));
  assert.ok(lines.includes('Plan inicial: Gratis'));
  assert.ok(lines.includes('Correo: dueno@example.com'));
});
