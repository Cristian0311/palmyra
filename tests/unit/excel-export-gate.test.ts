/**
 * Puerta de las descargas en Excel (Inventario y Reportes).
 *
 * El reporte del dueño era «el botón aparece desactivado» antes de pulsarlo, en
 * el APK y en el programa de escritorio. La causa no era la descarga: era el
 * `planCode`. Ambas páginas lo pedían con una sola llamada a `loadSaaSContext()`
 * y, si esa llamada lanzaba o respondía sin suscripción, lo fijaban a `null`
 * para siempre. Como `canUsePlanFeature(null, 'excel_exports')` es `false`, el
 * botón quedaba pintado como bloqueado —«Excel · Ciudadela»— aunque la empresa
 * tuviera Ciudadela pagado.
 *
 * Estas pruebas cubren la lógica pura que sustituye ese patrón: resolución del
 * plan con respaldo, el tri-estado concedido/desconocido/no incluido y la
 * ligadura del plan a la empresa y al usuario. Sin DOM ni navegador.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  canUsePlanFeature,
  decidePlanFeature,
  normalizePlanCode,
  planScopeKey,
  planSnapshotMatchesScope,
  planSnapshotStorageKey,
  resolvePlanCode,
} from "../../src/services/planAccess";

const EXCEL = 'excel_exports' as const;

/** Lo que hacen las páginas: la descarga se cierra solo si el plan lo niega. */
function excelExportEnabled(resolution: { planCode: string | null; source: string }) {
  const decision = decidePlanFeature(
    { planCode: resolution.planCode, source: resolution.source as any },
    EXCEL
  );
  return decision;
}

// ---------------------------------------------------------------------------
// Plan presente
// ---------------------------------------------------------------------------

test("con Ciudadela contratado el Excel queda concedido", () => {
  const resolved = resolvePlanCode({ context: 'pro' });
  assert.deepEqual(resolved, { planCode: 'pro', source: 'context' });
  assert.deepEqual(excelExportEnabled(resolved), {
    pending: false,
    locked: false,
    granted: true,
  });
  assert.equal(canUsePlanFeature(resolved.planCode, EXCEL), true);
});

test("el plan se normaliza: mayúsculas y espacios no abren ni cierran la puerta", () => {
  assert.deepEqual(resolvePlanCode({ context: '  PRO ' }), { planCode: 'pro', source: 'context' });
  assert.equal(normalizePlanCode('Pro'), 'pro');
  assert.equal(normalizePlanCode('FREE'), 'free');
  assert.equal(normalizePlanCode(''), null);
  assert.equal(normalizePlanCode('  '), null);
  assert.equal(normalizePlanCode(undefined), null);
  assert.equal(normalizePlanCode({ code: 'pro' }), null);
});

// ---------------------------------------------------------------------------
// Plan conocido que no incluye la función (la puerta de pago es legítima)
// ---------------------------------------------------------------------------

test("un plan inferior conocido cierra el Excel en lugar de mostrarlo roto", () => {
  for (const plan of ['growth', 'starter', 'trial', 'free']) {
    const resolved = resolvePlanCode({ context: plan });
    assert.equal(resolved.planCode, plan);
    assert.equal(resolved.source, 'context');
    assert.deepEqual(excelExportEnabled(resolved), {
      pending: false,
      locked: true,
      granted: false,
    }, plan);
  }
});

test("un downgrade real no queda enmascarado por una copia antigua de plan superior", () => {
  const resolved = resolvePlanCode({ context: 'growth', cached: 'pro', device: 'pro' });
  assert.deepEqual(resolved, { planCode: 'growth', source: 'context' });
  assert.equal(excelExportEnabled(resolved).locked, true);
});

// ---------------------------------------------------------------------------
// Plan desconocido: la regla que causó el bug
// ---------------------------------------------------------------------------

test("sin ninguna fuente el plan esta 'pendiente' y el Excel NO se deshabilita", () => {
  const resolved = resolvePlanCode({});
  assert.deepEqual(resolved, { planCode: null, source: 'none' });
  const decision = excelExportEnabled(resolved);
  assert.equal(decision.pending, true);
  assert.equal(decision.locked, false, "un plan desconocido no puede pintar la puerta de pago");
  assert.equal(decision.granted, false, "pero tampoco se declara concedido");
});

test("mientras el contexto carga (sin respuesta todavia) la descarga sigue disponible", () => {
  // Estado real del montaje: loadSaaSContext aún no respondió, sin copias.
  const loading = excelExportEnabled({ planCode: null, source: 'none' });
  assert.equal(loading.locked, false);
  assert.equal(loading.pending || loading.granted, true, "el boton debe poder pulsarse");
});

test("valores basura cuentan como desconocidos y no como plan denegado", () => {
  for (const value of [null, undefined, '', '   ', 'null', 'undefined', 'unknown-plan', 42, {}]) {
    const resolved = resolvePlanCode({ context: value, cached: value, device: value });
    assert.deepEqual(resolved, { planCode: null, source: 'none' }, String(value));
    assert.equal(excelExportEnabled(resolved).locked, false, String(value));
    // Nunca concede: la comprobación directa sigue siendo false.
    assert.equal(canUsePlanFeature(value as any, EXCEL), false, String(value));
  }
});

// ---------------------------------------------------------------------------
// Respaldo cuando el contexto falla (sesión caducada, backend sin suscripción)
// ---------------------------------------------------------------------------

test("regresion: sin contexto pero con copia local, el Excel sigue habilitado", () => {
  // Estado del APK/escritorio cuando loadSaaSContext lanza: la empresa pagó y
  // la única información disponible es la copia del dispositivo.
  const fromDevice = resolvePlanCode({ device: 'pro' });
  assert.deepEqual(fromDevice, { planCode: 'pro', source: 'device' });
  assert.equal(excelExportEnabled(fromDevice).granted, true);

  const fromCache = resolvePlanCode({ cached: 'pro' });
  assert.deepEqual(fromCache, { planCode: 'pro', source: 'cache' });
  assert.equal(excelExportEnabled(fromCache).granted, true);
});

test("el orden de autoridad es contexto, snapshot de acceso y copia del dispositivo", () => {
  assert.deepEqual(resolvePlanCode({ context: 'pro', cached: 'growth', device: 'free' }).source, 'context');
  assert.deepEqual(resolvePlanCode({ cached: 'pro', device: 'growth' }).source, 'cache');
  assert.deepEqual(resolvePlanCode({ device: 'pro' }).source, 'device');
  assert.deepEqual(resolvePlanCode({ context: null, cached: null, device: 'free' }), {
    planCode: 'free',
    source: 'device',
  });
});

// ---------------------------------------------------------------------------
// Alcance: la copia de otra empresa o de otro usuario no puede decidir
// ---------------------------------------------------------------------------

const companyA = { userId: 'user-1', companyId: 'company-A' };
const companyB = { userId: 'user-1', companyId: 'company-B' };

test("cambiar de empresa invalida la copia del plan anterior", () => {
  assert.notEqual(planScopeKey(companyA), planScopeKey(companyB));
  assert.notEqual(
    planSnapshotStorageKey('palmyra-plan-code-v1', companyA),
    planSnapshotStorageKey('palmyra-plan-code-v1', companyB)
  );
  // El snapshot verificado de la empresa A no vale para la B.
  assert.equal(planSnapshotMatchesScope(companyA, companyB), false);
  assert.equal(planSnapshotMatchesScope(companyA, companyA), true);
});

test("cambiar de usuario invalida la copia aunque la empresa coincida", () => {
  const otherUser = { userId: 'user-2', companyId: 'company-A' };
  assert.equal(planSnapshotMatchesScope(companyA, otherUser), false);
  assert.notEqual(planScopeKey(companyA), planScopeKey(otherUser));
});

test("sin empresa o sin usuario no hay clave: el plan no se guarda ni se hereda", () => {
  assert.equal(planScopeKey(null), null);
  assert.equal(planScopeKey({ userId: 'user-1' }), null);
  assert.equal(planScopeKey({ companyId: 'company-A' }), null);
  assert.equal(planScopeKey({ userId: '  ', companyId: 'company-A' }), null);
  assert.equal(planSnapshotStorageKey('palmyra-plan-code-v1', null), null);
  assert.equal(planSnapshotMatchesScope(null, companyA), false);
  assert.equal(planSnapshotMatchesScope(companyA, null), false);
  // Un snapshot sin empresa no puede autorizar el alcance activo.
  assert.equal(planSnapshotMatchesScope({ userId: 'user-1', companyId: null }, companyA), false);
});

// ---------------------------------------------------------------------------
// Mismo predicado para el resto de funciones de la sección de inventario
// ---------------------------------------------------------------------------

test("etiquetas y ABC siguen exigiendo un plan conocido que las incluya", () => {
  const pending = resolvePlanCode({});
  assert.equal(decidePlanFeature(pending, 'labels').granted, false);
  assert.equal(decidePlanFeature(pending, 'abc_analysis').granted, false);
  assert.equal(decidePlanFeature(resolvePlanCode({ context: 'pro' }), 'labels').granted, true);
  assert.equal(decidePlanFeature(resolvePlanCode({ context: 'growth' }), 'labels').locked, true);
});
