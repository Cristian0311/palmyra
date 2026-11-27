import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TEAM_ROSTER_CHIP_LIMIT,
  formatTeamWarehouseNames,
  planTeamWarehouses,
} from "../../src/lib/teamWarehouses";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const many = Array.from({ length: 5 }, (_, index) => ({
  id: `w${index + 1}`,
  name: `Almacén ${index + 1}`,
}));

/* ------------------------------------------------------------------ */
/* Plan de almacenes: inline vs colapsado                              */
/* ------------------------------------------------------------------ */

test("tres almacenes o menos se muestran todos inline y sin botón", () => {
  const plan = planTeamWarehouses(many.slice(0, 3));
  assert.equal(plan.showToggle, false);
  assert.equal(plan.hiddenCount, 0);
  assert.deepEqual(plan.visible.map(w => w.id), ["w1", "w2", "w3"]);
  assert.equal(plan.summaryLabel, "");
});

test("con más de tres, tres chips quedan inline y el resto en «+N»", () => {
  const plan = planTeamWarehouses(many);
  assert.equal(plan.showToggle, true);
  assert.deepEqual(plan.visible.map(w => w.id), ["w1", "w2", "w3"]);
  assert.deepEqual(plan.hidden.map(w => w.id), ["w4", "w5"]);
  assert.equal(plan.hiddenCount, 2);
  assert.equal(plan.summaryLabel, "+2 más");
});

test("el almacén principal nunca se colapsa", () => {
  const reordered = [many[2], many[0], many[1], many[3]];
  const plan = planTeamWarehouses(reordered);
  assert.equal(plan.visible[0].id, "w3");
  assert.equal(plan.visible[0].isMain, true);
  assert.ok(!plan.hidden.some(w => w.isMain));
});

test("visible + hidden reconstruyen la lista completa, en orden", () => {
  const plan = planTeamWarehouses(many);
  assert.deepEqual(
    plan.visible.concat(plan.hidden).map(w => w.id),
    many.map(w => w.id)
  );
});

test("un límite mayor muestra todo y no genera resumen", () => {
  const plan = planTeamWarehouses(many, { inlineLimit: TEAM_ROSTER_CHIP_LIMIT });
  assert.equal(plan.showToggle, true);
  const wide = planTeamWarehouses(many, { inlineLimit: 10 });
  assert.equal(wide.showToggle, false);
  assert.equal(wide.visible.length, many.length);
});

test("sin almacenes no hay chips ni botón", () => {
  for (const input of [[], null, undefined]) {
    const plan = planTeamWarehouses(input as never);
    assert.deepEqual(plan.visible, []);
    assert.equal(plan.showToggle, false);
    assert.equal(plan.hiddenCount, 0);
  }
});

test("los almacenes retirados o sin nombre se etiquetan, no se ocultan", () => {
  const plan = planTeamWarehouses([{ id: "a" }, { id: "b", name: "   " }, { id: "", name: null }], { inlineLimit: 2 });
  assert.equal(plan.visible.length, 2);
  assert.equal(plan.visible[0].name, "Almacén retirado");
  // El tercero (id vacío) es el único que se colapsa: sigue accesible.
  assert.equal(plan.hidden.length, 1);
  assert.equal(plan.hidden[0].name, "Almacén retirado");
  assert.equal(plan.summaryLabel, "+1 más");
  // Por defecto caben tres etiquetas inline.
  assert.equal(planTeamWarehouses([{ id: "a" }, { id: "b" }, { id: "c" }]).hiddenCount, 0);
  // Un id vacío o repetido no puede romper las keys de React.
  const keys = plan.visible.concat(plan.hidden).map(w => w.key);
  assert.equal(new Set(keys).size, keys.length);
  const duplicated = planTeamWarehouses([{ id: "x" }, { id: "x" }, { id: "x" }]);
  const dupKeys = duplicated.visible.concat(duplicated.hidden).map(w => w.key);
  assert.equal(new Set(dupKeys).size, dupKeys.length);
});

test("el chip compacto del listado permite más de tres almacenes", () => {
  assert.equal(TEAM_ROSTER_CHIP_LIMIT, 3);
  const plan = planTeamWarehouses(many, { inlineLimit: TEAM_ROSTER_CHIP_LIMIT });
  assert.equal(plan.visible.length, TEAM_ROSTER_CHIP_LIMIT);
  assert.equal(plan.hiddenCount, many.length - TEAM_ROSTER_CHIP_LIMIT);
});

test("formatTeamWarehouseNames resume la lista accesible", () => {
  assert.equal(formatTeamWarehouseNames(["Centro", " Sur "]), "Centro, Sur");
  assert.equal(formatTeamWarehouseNames([]), "Sin almacén");
  assert.equal(formatTeamWarehouseNames(null), "Sin almacén");
});

/* ------------------------------------------------------------------ */
/* Invariantes de maquetación (patrón readFileSync del repo)           */
/* ------------------------------------------------------------------ */

test("Team.tsx usa el plan de almacenes en vez de renderizar la lista entera", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /from "\.\.\/lib\/teamWarehouses"/);
  assert.match(team, /planTeamWarehouses\(warehouseNames/);
  // El editor lista todos los almacenes de la empresa, sin colapsar.
  assert.match(team, /warehouseSelection\.selectable\.map/);
  assert.doesNotMatch(team, /formWarehousePlan/);
  assert.match(team, /className="team-emp-warehouse-grid"/);
  assert.match(team, /palmyra-popover team-employee-warehouse-bubble/);
  // La rejilla vieja (grid sm:grid-cols-2 sobre los N almacenes activos) no vuelve.
  assert.doesNotMatch(team, /\.filter\(warehouse => warehouse\.active\)\.map/);
});

test("team.css acota la rejilla de almacenes con scroll propio", () => {
  const css = source("src/pages/team.css");
  const rule = css.match(/\.team-emp-warehouse-grid\{([^}]*)\}/);
  assert.ok(rule, "falta la regla .team-emp-warehouse-grid");
  assert.match(rule[1], /overflow-y:\s*auto/);
  // El tope descuenta el pie/cabecera del modal para que el scroll sea real.
  assert.match(rule[1], /max-height:\s*min\(40dvh,\s*calc\(100dvh - 13rem\)\)/);
  assert.match(rule[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  // La segunda columna sólo a partir de 640 px.
  assert.match(css, /@media\(min-width:640px\)\{\s*\.team-emp-warehouse-grid\{[^}]*repeat\(2,/);
});

test("el modal de trabajador queda acotado al overlay y no solo a dvh", () => {
  const css = source("src/pages/team.css");
  const rule = css.match(/\.team-emp-modal\{([^}]*)\}/);
  assert.ok(rule, "falta la regla .team-emp-modal");
  assert.match(rule[1], /max-height:\s*min\(calc\(100dvh - 1\.5rem\),\s*calc\(100% - 1\.5rem\)\)/);
});

test("la burbuja de almacenes queda acotada al viewport", () => {
  const css = source("src/pages/team.css");
  const rule = css.match(/\.team-employee-warehouse-bubble\{([^}]*)\}/);
  assert.ok(rule, "falta la regla .team-employee-warehouse-bubble");
  assert.match(rule[1], /width:\s*min\([^)]*vw[^)]*\)/);
  assert.match(css, /\.team-employee-warehouse\{[^}]*max-width:\s*min\(/);
});
