import test from "node:test";
import assert from "node:assert/strict";
import type { LocalTable } from "../../src/services/localDb/contract";
import { LOCAL_DB_TABLES } from "../../src/services/localDb/schema";
import {
  LOCAL_ONLY_TABLES,
  MATERIALIZE_MAP,
  MATERIALIZABLE_LOCAL_TABLES,
  NON_MATERIALIZABLE_LOCAL_TABLES,
  UNSUPPORTED_LOCAL_TABLES,
  buildUpsertPayload,
  cloudTableFor,
  columnsFor,
  isMaterializable,
  isTombstoneEnvelope,
  rowFromInboxPayload,
  tombstoneFor,
  unsupportedReason,
  type ColumnKind,
  type TableMapping
} from "../../src/services/cloudSync/materializeMapping";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AT = "2026-01-01T00:00:00.000Z";

const mappings = Object.entries(MATERIALIZE_MAP) as Array<[LocalTable, TableMapping]>;

function sampleValue(kind: ColumnKind): unknown {
  switch (kind) {
    case "number":
      return 3;
    case "boolean":
      return true;
    case "uuid":
      return UUID;
    case "timestamp":
      return AT;
    case "json":
      return { source: "test" };
    default:
      return "demo";
  }
}

function sampleRow(spec: TableMapping): Record<string, unknown> {
  const row: Record<string, unknown> = { company_id: COMPANY };
  for (const column of spec.columns) {
    if (column.column === "company_id") continue;
    row[column.from[0]] = sampleValue(column.kind);
  }
  return row;
}

test("toda tabla materializable existe en el esquema local v1", () => {
  for (const local of Object.keys(MATERIALIZE_MAP)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(LOCAL_DB_TABLES, local),
      `la tabla local ${local} no existe en LOCAL_DB_TABLES`
    );
  }
  assert.equal(MATERIALIZABLE_LOCAL_TABLES.length, mappings.length);
});

test("cada destino cloud declara columnas explícitas, sin duplicados", () => {
  for (const [local, spec] of mappings) {
    assert.ok(spec.table.trim().length > 0, `${local} sin tabla destino`);
    assert.ok(spec.columns.length > 0, `${local} sin columnas`);
    const seen = new Set<string>();
    for (const column of spec.columns) {
      assert.match(column.column, /^[a-z][a-z0-9_]*$/, `${local}.${column.column}`);
      assert.ok(column.from.length > 0, `${local}.${column.column} sin alias local`);
      for (const alias of column.from) {
        assert.ok(alias.trim().length > 0, `${local}.${column.column} alias vacío`);
      }
      assert.ok(!seen.has(column.column), `${local} repite la columna ${column.column}`);
      seen.add(column.column);
    }
    assert.deepEqual(columnsFor(local), spec.columns.map((column) => column.column));
    assert.equal(cloudTableFor(local), spec.table);
    assert.equal(isMaterializable(local), true);
  }
});

test("id y company_id son obligatorios donde corresponde", () => {
  for (const [local, spec] of mappings) {
    const required = spec.columns.filter((column) => column.required);
    assert.ok(required.some((column) => column.column === "id"), `${local} sin id obligatorio`);
    if (spec.parent) {
      assert.ok(
        required.some((column) => column.column === spec.parent?.column),
        `${local} no exige la clave de su padre (${spec.parent.column})`
      );
    } else {
      assert.ok(
        required.some((column) => column.column === "company_id"),
        `${local} sin company_id obligatorio`
      );
    }
  }
});

test("el payload de una tabla hija incluye la clave de su padre", () => {
  for (const [local, spec] of mappings) {
    if (!spec.parent) continue;
    const payload = buildUpsertPayload(local, sampleRow(spec));
    assert.ok(payload, `${local}: el payload no debería ser null`);
    const value = payload?.[spec.parent.column];
    assert.equal(typeof value, "string", `${local} sin ${spec.parent.column}`);
    assert.ok(String(value).trim().length > 0, `${local}: clave padre vacía`);
  }
});

test("una fila completa nunca se descarta", () => {
  for (const [local, spec] of mappings) {
    const payload = buildUpsertPayload(local, sampleRow(spec));
    assert.ok(payload, `${local}: una fila completa no debe devolver null`);
    assert.equal(payload?.id, UUID.toLowerCase(), `${local}: id inesperado`);
  }
});

test("falta una columna requerida: no se materializa", () => {
  const sales = MATERIALIZE_MAP.sales as TableMapping;
  const row = sampleRow(sales);
  delete row.warehouse_id;
  assert.equal(buildUpsertPayload("sales", row), null);

  const items = MATERIALIZE_MAP.sale_items as TableMapping;
  const itemRow = sampleRow(items);
  delete itemRow.product_id;
  assert.equal(buildUpsertPayload("sale_items", itemRow), null);
});

test("coerción de tipos del payload", () => {
  const payload = buildUpsertPayload("sale_items", {
    id: UUID,
    company_id: COMPANY,
    sale_id: UUID,
    product_id: UUID,
    quantity: "2",
    unit_price: "10.5",
    line_total: "21",
    discount: "nope"
  });
  assert.ok(payload);
  assert.equal(payload?.quantity, 2);
  assert.equal(payload?.unit_price, 10.5);
  assert.equal(payload?.line_total, 21);
  assert.equal(payload?.discount, undefined, "un número inválido no se escribe");

  const warehouse = buildUpsertPayload("warehouses", {
    id: UUID,
    company_id: COMPANY,
    name: "Centro",
    active: "false"
  });
  assert.equal(warehouse?.active, false);
});

test("tablas desconocidas no se materializan", () => {
  for (const unknown of ["", "inventario_x", "Sales", "__proto__"]) {
    assert.equal(cloudTableFor(unknown), null);
    assert.equal(isMaterializable(unknown), false);
    assert.deepEqual([...columnsFor(unknown)], []);
    assert.equal(buildUpsertPayload(unknown, { id: UUID, company_id: COMPANY }), null);
    assert.equal(tombstoneFor(unknown), null);
    assert.match(String(unsupportedReason(unknown)), /unknown_local_table|no existe/);
  }
});

test("sale_voids es solo local: excluida del mapa con justificación", () => {
  assert.ok(Object.prototype.hasOwnProperty.call(LOCAL_ONLY_TABLES, "sale_voids"));
  assert.match(LOCAL_ONLY_TABLES.sale_voids, /local_only_table/);
  assert.match(LOCAL_ONLY_TABLES.sale_voids, /sales\.status='voided'/);
  assert.equal(
    Object.prototype.hasOwnProperty.call(MATERIALIZE_MAP, "sale_voids"),
    false,
    "sale_voids no tiene tabla en la nube y no debe materializarse"
  );
  assert.equal(isMaterializable("sale_voids"), false);
  assert.equal(cloudTableFor("sale_voids"), null);
  assert.match(String(unsupportedReason("sale_voids")), /local_only_table/);
});

test("products no escribe price: el precio canónico vive en product_prices", () => {
  const columns = [...columnsFor("products")];
  assert.equal(columns.includes("price"), false);
  assert.equal(columns.includes("sale_price"), false);
});

test("las exclusiones documentadas existen y no se materializan", () => {
  for (const [local, reason] of Object.entries(UNSUPPORTED_LOCAL_TABLES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(LOCAL_DB_TABLES, local),
      `${local} no existe en el esquema local`
    );
    assert.equal(isMaterializable(local), false, `${local} no debe materializarse`);
    assert.ok(reason.trim().length > 0, `${local} sin motivo`);
    assert.equal(unsupportedReason(local), reason);
  }
});

test("NON_MATERIALIZABLE cubre exactamente el resto del esquema local", () => {
  const expected = Object.keys(LOCAL_DB_TABLES).filter((table) => !isMaterializable(table));
  assert.deepEqual([...NON_MATERIALIZABLE_LOCAL_TABLES].sort(), expected.sort());
  for (const local of NON_MATERIALIZABLE_LOCAL_TABLES) {
    assert.ok(unsupportedReason(local), `${local} sin motivo de exclusión`);
  }
});

test("los tombstones declaran modo y columna coherentes", () => {
  for (const [local, spec] of mappings) {
    const plan = tombstoneFor(local);
    assert.ok(plan, `${local} sin plan de tombstone`);
    assert.equal(plan?.table, spec.table);
    assert.ok(["soft", "deactivate", "purge"].includes(String(plan?.mode)));
    if (spec.tombstone === "deactivate") {
      assert.ok(spec.tombstoneColumn, `${local}: deactivate sin columna`);
      assert.ok(spec.tombstoneValue, `${local}: deactivate sin valor`);
      assert.equal(plan?.column, spec.tombstoneColumn);
      assert.equal(plan?.value, spec.tombstoneValue);
    } else {
      assert.equal(spec.tombstoneColumn, undefined, `${local}: columna sobrante`);
      assert.equal(spec.tombstoneValue, undefined, `${local}: valor sobrante`);
      assert.equal(plan?.column, undefined);
      assert.equal(plan?.value, undefined);
    }
  }
});

test("el sobre de la bandeja guarda la fila en `row`", () => {
  const envelope = {
    seq: 12,
    table: "sales",
    row_id: "venta-1",
    op: "upsert",
    row: { id: "venta-1", company_id: COMPANY, total: "15.00" },
    deleted_at: null
  };
  assert.deepEqual(rowFromInboxPayload(envelope), envelope.row);
  assert.equal(rowFromInboxPayload({ ...envelope, row: null }), null);
  assert.equal(rowFromInboxPayload(null), null);
  assert.equal(rowFromInboxPayload("texto"), null);
  assert.equal(isTombstoneEnvelope(envelope), false);
  assert.equal(isTombstoneEnvelope({ ...envelope, op: "delete", row: null }), true);
  assert.equal(
    isTombstoneEnvelope({ ...envelope, row: { ...envelope.row, deleted_at: AT } }),
    true
  );
});
