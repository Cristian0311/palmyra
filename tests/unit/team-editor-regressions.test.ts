import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TEAM_ROSTER_CHIP_LIMIT,
  pickAssignableWarehouseIds,
  planTeamWarehouses,
  resolveTeamWarehouseSelection,
} from "../../src/lib/teamWarehouses";
import { describePosPasswordField } from "../../src/lib/teamEmployeeForm";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const company = [
  { id: 'w-centro', name: 'Centro', active: true },
  { id: 'w-sur', name: 'Sur', active: true },
  { id: 'w-viejo', name: 'Depósito viejo', active: false },
];

/* ------------------------------------------------------------------ */
/* Bug: «uno de los almacenes no está disponible» en el editor         */
/* ------------------------------------------------------------------ */

test("todo almacén registrado es asignable, aunque figure inactivo en datos viejos", () => {
  const selection = resolveTeamWarehouseSelection(company, ['w-centro', 'w-viejo']);
  assert.deepEqual(selection.selectable.map(w => w.id), ['w-centro', 'w-viejo', 'w-sur']);
  assert.equal(selection.selectable[1].assigned, true);
  assert.equal(selection.retired.length, 0);
});

test("todos los almacenes de la empresa se listan, con los asignados primero", () => {
  const selection = resolveTeamWarehouseSelection(company, ['w-sur', 'w-centro']);
  assert.deepEqual(selection.selectable.map(w => w.id), ['w-sur', 'w-centro', 'w-viejo']);
  assert.equal(selection.retired.length, 0);
  // Los asignados van primero y conservan el orden elegido (el primero es el principal).
  assert.equal(selection.selectable[0].assigned, true);
  assert.equal(selection.selectable[2].assigned, false);
});

test("un almacén asignado que ya no existe se separa como retirado", () => {
  const selection = resolveTeamWarehouseSelection(company, ['w-borrado', 'w-centro']);
  assert.deepEqual(selection.retired.map(w => w.id), ['w-borrado']);
  assert.equal(selection.retired[0].name, 'Almacén retirado');
  assert.deepEqual(selection.selectable.map(w => w.id), ['w-centro', 'w-sur', 'w-viejo']);
});

test("todos los almacenes registrados se envían al guardar y respetan el orden", () => {
  const selection = resolveTeamWarehouseSelection(company, ['w-viejo', 'w-sur']);
  assert.deepEqual(pickAssignableWarehouseIds(selection, ['w-viejo', 'w-sur']), ['w-viejo', 'w-sur']);
  assert.deepEqual(pickAssignableWarehouseIds(selection, []), []);
  // Un almacén no asignado también es guardable si el administrador lo marca.
  assert.deepEqual(pickAssignableWarehouseIds(selection, ['w-centro', 'w-sur']), ['w-centro', 'w-sur']);
});

test("una empresa con un solo almacén puede asignarlo", () => {
  const selection = resolveTeamWarehouseSelection([{ id: 'w-viejo', name: 'Depósito viejo', active: false }], ['w-viejo']);
  assert.equal(selection.selectable.length, 1);
  assert.deepEqual(pickAssignableWarehouseIds(selection, ['w-viejo']), ['w-viejo']);
});

test("la fila del equipo no etiqueta almacenes como inactivos", () => {
  const team = source("src/pages/Team.tsx");
  // El nombre del almacén se resuelve pero ya no se descarta si falta:
  // planTeamWarehouses lo rotula «Almacén retirado» en vez de ocultarlo.
  assert.doesNotMatch(team, /\.filter\(\(item\): item is \{ id: string; name: string \} => Boolean\(item\.name\)\)/);
  assert.match(team, /name: match\?\.name/);
  assert.doesNotMatch(team, /\(inactivo\)/);
});

test("la fila resume más de tres almacenes con el chip «+N»", () => {
  assert.equal(TEAM_ROSTER_CHIP_LIMIT, 3);
  const plan = planTeamWarehouses([
    { id: 'a', name: 'Almacén 1' },
    { id: 'b', name: 'Almacén 2' },
    { id: 'c', name: 'Almacén 3' },
    { id: 'd', name: 'Almacén 4' },
    { id: 'e', name: 'Almacén 5' },
  ], { inlineLimit: TEAM_ROSTER_CHIP_LIMIT });
  assert.equal(plan.visible.length, 3);
  assert.equal(plan.hiddenCount, 2);
  assert.equal(plan.summaryLabel, '+2 más');
});

test("Team.tsx envía solo almacenes existentes y explica los borrados", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /pickAssignableWarehouseIds\(warehouseSelection, form\.warehouseIds\)/);
  assert.match(team, /resolveTeamWarehouseSelection\(snapshot\?\.warehouses, form\.warehouseIds\)/);
  // Guardado: nunca se reenvían ids de almacenes borrados (causa de `invalid_warehouse`).
  assert.doesNotMatch(team, /warehouseIds: form\.warehouseIds/);
  assert.match(team, /warehouseIds: warehouseIdsToSave/);
  assert.match(team, /warehouseIds: \[\.\.\.warehouseIdsToSave\]/);
  assert.match(team, /warehouseIdsToSave = assignableWarehouseIds/);
  // Todos los almacenes se listan sin colapsar y el aviso sólo habla de borrados.
  assert.match(team, /warehouseSelection\.selectable\.map/);
  assert.doesNotMatch(team, /formWarehousePlan/);
  assert.match(team, /Asignados que ya no existen en la empresa/);
  assert.doesNotMatch(team, /No hay almacenes activos disponibles/);
});

/* ------------------------------------------------------------------ */
/* Bug: el campo «nueva contraseña» parecía un obligatorio vacío       */
/* ------------------------------------------------------------------ */

test("al editar, la contraseña POS existente se muestra como estado, no como vacío", () => {
  const copy = describePosPasswordField({ editing: true, typing: false });
  assert.equal(copy.required, false);
  assert.equal(copy.status, 'defined');
  assert.match(copy.statusLabel, /Contraseña actual: definida · deja vacío para conservarla/);
  assert.match(copy.placeholder, /Vacío = conservar/);
  assert.match(copy.helper, /hash seguro/);
  assert.match(copy.helper, /no se puede mostrar/);
});

test("al escribir una nueva contraseña el estado avisa del reemplazo", () => {
  const copy = describePosPasswordField({ editing: true, typing: true });
  assert.equal(copy.required, false);
  assert.equal(copy.status, 'typing');
  assert.match(copy.statusLabel, /lista para guardar/);
  assert.match(copy.helper, /reemplaza la contraseña actual/);
});

test("solo un alta (o un trabajador sin contraseña) exige el campo", () => {
  const create = describePosPasswordField({ editing: false });
  assert.equal(create.required, true);
  assert.equal(create.status, 'missing');
  assert.equal(create.placeholder, 'Mínimo 6 caracteres');

  const missing = describePosPasswordField({ editing: true, hasStoredPassword: false });
  assert.equal(missing.required, true);
  assert.equal(missing.status, 'missing');
  assert.match(missing.statusLabel, /sin definir/);
});

test("Team.tsx no vuelve a deducir la obligatoriedad de user_id/pending_invitation", () => {
  const team = source("src/pages/Team.tsx");
  assert.doesNotMatch(team, /editing\.user_id \|\| editing\.pending_invitation/);
  assert.match(team, /describePosPasswordField\(\{/);
  assert.match(team, /hasStoredPassword: editing\?\.pending_invitation \? false : undefined/);
  // El chip de estado debe existir en el DOM, no solo en el texto de ayuda.
  assert.match(team, /id="team-emp-pos-password-state"/);
  assert.match(team, /team-emp-pos-state/);
  const css = source("src/pages/team.css");
  assert.match(css, /\.team-emp-pos-state\{/);
  assert.match(css, /\.team-emp-pos-state\.is-defined\{/);
});
