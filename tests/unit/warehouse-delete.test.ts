import test from "node:test";
import assert from "node:assert/strict";

import {
  RETIRED_LABEL,
  buildWarehouseNameMap,
  collectRetiredWarehouseIds,
  evaluateWarehouseDeletion,
  isBranchRecordRetired,
  isWarehouseRowRetired,
  resolveHistoricalWarehouseName,
  selectOperationalWarehouseRows
} from "../../src/lib/teamWarehouses";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import { removeWarehouseFromLocalDb } from "../../src/services/localDb/warehouseDelete";
import type { LocalRow } from "../../src/services/localDb/contract";

const COMPANY = "company-1";

function warehouseRow(overrides: Partial<LocalRow> & { id: string }): LocalRow {
  return {
    id: overrides.id,
    company_id: overrides.company_id ?? COMPANY,
    version: overrides.version ?? 3,
    updated_at: overrides.updated_at ?? "2026-11-20T10:00:00.000Z",
    origin_device: overrides.origin_device ?? "device-a",
    deleted_at: overrides.deleted_at ?? null,
    data: overrides.data ?? { name: `Almacén ${overrides.id}`, isActive: true }
  };
}

/** Espejo del filtro que aplica `pull.ts` antes de proyectar a la store. */
function operationalBranchesFromPull(rows: Array<{ id: string; name: string; active: boolean }>) {
  return selectOperationalWarehouseRows(rows).map(row => ({
    id: row.id,
    name: row.name,
    isActive: row.active !== false
  }));
}

test("el payload de almacenes separa la lista operativa de los dados de baja", () => {
  const rows = [
    { id: "w-1", name: "Central", active: true },
    { id: "w-2", name: "Deposito Viejo", active: false },
    { id: "w-3", name: "Local", active: true }
  ];

  assert.deepEqual(collectRetiredWarehouseIds(rows), ["w-2"]);
  assert.equal(isWarehouseRowRetired({ id: "w-2", name: "Deposito Viejo", active: false }), true);
  // `active` ausente o nulo NO es una baja: solo `false` retira el almacen.
  assert.equal(isWarehouseRowRetired({ id: "w-4", name: "Nuevo" }), false);
  assert.equal(isWarehouseRowRetired({ id: "w-5", name: "Raro", active: null }), false);

  const branches = operationalBranchesFromPull(rows);
  assert.deepEqual(branches.map(b => b.id), ["w-1", "w-3"]);
  assert.equal(branches.some(b => b.id === "w-2"), false);
  assert.equal(isBranchRecordRetired({ id: "w-2", name: "Deposito Viejo", isActive: false }), true);
});

test("un almacen dado de baja no resucita al rehidratar desde el almacen local", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  await driver.put("warehouses", [
    warehouseRow({ id: "w-1" }),
    warehouseRow({ id: "w-2", data: { name: "Deposito Viejo", isActive: true } })
  ]);

  const result = await removeWarehouseFromLocalDb("w-2", { companyId: COMPANY, driver });
  assert.equal(result.localDb, true, result.detail);
  assert.equal(result.persistedJson, true, "sin JSON persistido no hay nada que limpiar");
  assert.equal(result.detail, undefined);

  // Lo que lee la hidratacion (`liveRows`): filas sin lapida.
  const live = (await driver.query<LocalRow>({ table: "warehouses" })).filter(r => !r.deleted_at);
  assert.deepEqual(live.map(r => r.id).sort(), ["w-1"]);

  // La lapida queda registrada para que el journal la suba al hub.
  const tombstoned = await driver.get<LocalRow>("warehouses", "w-2");
  assert.ok(tombstoned?.deleted_at, "la fila debe quedar enterrada, no borrada a ciegas");
  assert.equal((tombstoned as any).data.name, "Deposito Viejo", "la lapida conserva el nombre historico");
  assert.ok((tombstoned!.version ?? 0) > 3, "la version debe avanzar para que el cambio se propague");

  // Idempotencia: repetir la baja no reaviva ni duplica la fila.
  const again = await removeWarehouseFromLocalDb("w-2", { companyId: COMPANY, driver });
  assert.equal(again.localDb, true);
  const stillLive = (await driver.query<LocalRow>({ table: "warehouses" })).filter(r => !r.deleted_at);
  assert.deepEqual(stillLive.map(r => r.id), ["w-1"]);
});

test("el aislamiento por empresa impide enterrar el almacen de otra compania", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  await driver.put("warehouses", [warehouseRow({ id: "w-9", company_id: "other-company" })]);

  const result = await removeWarehouseFromLocalDb("w-9", { companyId: COMPANY, driver });
  assert.equal(result.localDb, true);
  const row = await driver.get<LocalRow>("warehouses", "w-9");
  assert.equal(row?.deleted_at, null, "una fila ajena nunca se toca");
});

test("el nombre historico de un almacen dado de baja sigue resolviendo", () => {
  const rawRows = [
    { id: "w-1", name: "Central", active: true },
    { id: "w-2", name: "Deposito Viejo", active: false }
  ];
  // El mapa historico se construye con TODAS las filas: si filtrara las bajas,
  // un reporte viejo mostraria la etiqueta generica en lugar del nombre real.
  const names = buildWarehouseNameMap(rawRows);
  assert.equal(resolveHistoricalWarehouseName(names, "w-2"), "Deposito Viejo");
  assert.equal(resolveHistoricalWarehouseName(names, "w-1"), "Central");
  assert.equal(resolveHistoricalWarehouseName(names, "w-desaparecido"), RETIRED_LABEL);
  assert.equal(resolveHistoricalWarehouseName(names, ""), RETIRED_LABEL);
  assert.equal(resolveHistoricalWarehouseName(null, "w-2"), RETIRED_LABEL);

  // Fila sin nombre: conserva la etiqueta visible, no un hueco en el reporte.
  const withBlank = buildWarehouseNameMap([...rawRows, { id: "w-7", name: "  ", active: false }]);
  assert.equal(withBlank.get("w-7"), RETIRED_LABEL);
  // Una proyeccion posterior SIN nombre no borra el nombre ya resuelto.
  buildWarehouseNameMap([...rawRows, { id: "w-2", active: false }]);
  assert.equal(withBlank.get("w-2"), "Deposito Viejo");
});

test("deleteBranch se bloquea si el almacen tiene unidades en stock", () => {
  const decision = evaluateWarehouseDeletion({
    warehouseId: "w-1",
    inventory: [
      { branchId: "w-1", productId: "p-1", variantLabel: "Rojo", quantity: 4 },
      { branchId: "w-1", productId: "p-1", variantLabel: "Azul", quantity: 8 },
      { branchId: "w-1", productId: "p-2", quantity: 0 },
      { branchId: "w-2", productId: "p-3", quantity: 99 }
    ],
    transactions: [{ branchId: "w-1" }],
    cashSessions: [{ branchId: "w-1" }]
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "inventory");
  // El inventario manda sobre ventas y turnos: es lo irreparable.
  assert.equal(decision.counts.stock.units, 12, "las unidades se suman por variante");
  assert.equal(decision.counts.stock.products, 1, "los productos se agrupan, no las variantes");
  assert.match(decision.detail, /12 unidades/);
  assert.match(decision.detail, /1 producto/);
  assert.match(decision.detail, /No se borra ni se reasigna/);
});

test("deleteBranch informa unidades y productos sueltos sin identificador", () => {
  const decision = evaluateWarehouseDeletion({
    warehouseId: "w-1",
    inventory: [
      { warehouseId: "w-1", quantity: 1 },
      { warehouseId: "w-1", quantity: 2, productId: "p-9" }
    ]
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "inventory");
  assert.equal(decision.counts.stock.units, 3);
  assert.equal(decision.counts.stock.products, 2);
  assert.match(decision.detail, /3 unidades en 2 productos/);
});

test("deleteBranch se bloquea por ventas y por turnos cuando no hay stock", () => {
  const bySales = evaluateWarehouseDeletion({
    warehouseId: "w-1",
    inventory: [{ branchId: "w-1", productId: "p-1", quantity: 0 }],
    transactions: [{ branchId: "w-1" }, { warehouseId: "w-1" }, { branchId: "w-2" }]
  });
  assert.equal(bySales.ok, false);
  assert.equal(bySales.reason, "sales");
  assert.equal(bySales.counts.sales, 2);
  assert.equal(bySales.counts.stock.units, 0);
  assert.match(bySales.detail, /2 ventas registradas/);

  const bySessions = evaluateWarehouseDeletion({
    warehouseId: "w-1",
    transactions: [{ branchId: "w-2" }],
    cashSessions: [{ branchId: "w-1", status: "closed" }]
  });
  assert.equal(bySessions.ok, false);
  assert.equal(bySessions.reason, "sessions");
  assert.equal(bySessions.counts.sessions, 1);
  assert.match(bySessions.detail, /1 turno de caja/);
});

test("deleteBranch permite la baja de un almacen vacio y sin historial", () => {
  const decision = evaluateWarehouseDeletion({
    warehouseId: "w-1",
    inventory: [{ branchId: "w-1", productId: "p-1", quantity: 0 }],
    transactions: [{ branchId: "w-2" }],
    cashSessions: [{ branchId: "w-2", status: "closed" }]
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.reason, undefined);
  assert.deepEqual(decision.counts, { stock: { units: 0, products: 0 }, sales: 0, sessions: 0 });
  assert.match(decision.detail, /se puede dar de baja/);
});
