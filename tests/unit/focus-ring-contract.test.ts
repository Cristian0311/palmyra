/**
 * Contrato de foco de los campos de formulario (test de contrato sobre fuentes).
 *
 * Reporte del dueño: al presionar un campo (Nuevo proveedor, Nuevo cliente,
 * producto, cierre de caja…) aparecía un cuadro con líneas POR FUERA del campo.
 * La causa era CSS propio: `OperationsSurface.module.css` dibujaba un `outline`
 * de 2 px con `outline-offset: 3px` (¡`!important`) sobre cada control y, además,
 * un cuadro completo alrededor del <label> que contenía el input enfocado.
 *
 * Estas pruebas leen el CSS fuente para que nadie reintroduzca ese patrón: el
 * foco debe verse SOBRE el campo (borde + halo pegados) y nunca como un outline
 * flotante con separación, y el indicador debe seguir siendo perceptible.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readCss = async (file: string) => (await fs.readFile(new URL(file, root))).toString();
/** Los comentarios explican el patrón retirado; solo importan las declaraciones. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const BASE_CSS = 'src/index.css';
const SURFACE_CSS = 'src/components/OperationsSurface.module.css';

/** Declaraciones de la regla base de campos (`input, textarea, select { … }`). */
function fieldBaseRule(css: string) {
  const start = css.indexOf('input, textarea, select {');
  assert.notEqual(start, -1, `${BASE_CSS}: falta la regla compartida input, textarea, select`);
  const end = css.indexOf('\n  }', start);
  assert.notEqual(end, -1, `${BASE_CSS}: regla de campos sin cerrar`);
  return css.slice(start, end);
}

test('el foco de los campos se dibuja sobre el campo, sin outline flotante', async () => {
  const base = fieldBaseRule(await readCss(BASE_CSS));
  // Un solo marcado, pegado al campo: borde violeta + anillo de 2 px.
  assert.match(base, /focus:border-violet-500/, 'falta el borde de foco del campo');
  assert.match(base, /focus:ring-2/, 'falta el anillo de foco del campo');
  // `outline:hidden` deja el outline solo para alto contraste (forced-colors).
  assert.match(base, /outline-hidden/, 'el outline debe reservarse para forced-colors');
  assert.doesNotMatch(base, /ring-offset|ring-offset-/, 'el anillo no debe separarse del campo');
});

test('el anillo de foco de los botones queda pegado al borde (sin hueco)', async () => {
  const css = await readCss(BASE_CSS);
  const start = css.indexOf('button:focus-visible {');
  assert.notEqual(start, -1, `${BASE_CSS}: falta button:focus-visible`);
  const rule = css.slice(start, css.indexOf('}', start));
  assert.match(rule, /ring-2/, 'el botón debe conservar un indicador de foco visible');
  assert.match(rule, /outline-hidden/, 'el outline del navegador debe quedar solo para forced-colors');
  assert.doesNotMatch(rule, /ring-offset-2|ring-offset-slate/, 'ring-offset abre un hueco que se lee como un cuadro aparte');
});

test('la superficie de operaciones no vuelve a dibujar cajas de foco por fuera', async () => {
  const css = stripComments(await readCss(SURFACE_CSS));
  // Regla culpable 1: outline con separación sobre el propio control.
  assert.doesNotMatch(css, /outline-offset:\s*3px/, 'no debe volver outline-offset: 3px');
  assert.doesNotMatch(css, /outline:\s*2px solid currentColor\s*!important/, 'no debe volver el outline !important sobre los campos');
  // Regla culpable 2: cuadro alrededor del <label> que envuelve al campo.
  assert.doesNotMatch(css, /label:has\(input:focus-visible\)/, 'el <label> no debe dibujar un cuadro al enfocar su campo');
  // Los campos se marcan desde index.css; el módulo no debe anular ese marcado.
  assert.doesNotMatch(css, /:focus-visible\s*\{\s*outline:\s*none/, 'no anular silenciosamente el foco de los campos');
  // Enlaces y summary conservan un indicador visible, dibujado dentro de su caja.
  assert.match(css, /:is\(summary, a\):focus-visible/, 'summary y enlaces necesitan un foco visible');
  assert.match(css, /outline-offset:\s*-3px/, 'el foco de summary/enlaces debe quedar dentro del control');
});
