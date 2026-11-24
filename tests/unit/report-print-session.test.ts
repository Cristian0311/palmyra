import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = () => readFileSync(join(process.cwd(), "src/pages/ReportsPrintableSession.tsx"), "utf8");

test("el ticket imprimible no desestructura `String` de props (era undefined y reventaba al filtrar AJUSTE_)", () => {
  // `props` nunca trae la clave `String`; la variable local quedaba `undefined`
  // y `!String(t.notes || '').startsWith('AJUSTE_')` lanzaba TypeError con
  // cualquier transacción al imprimir el cierre de turno.
  assert.doesNotMatch(source(), /const \{[^}]*\bString\s*,/);
  assert.match(source(), /Nunca desestructurar `String`/);
});

test("el filtro AJUSTE_ sigue operando con el constructor global", () => {
  assert.match(source(), /!String\(t\.notes \|\| ''\)\.startsWith\('AJUSTE_'\)/);
});
