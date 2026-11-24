import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDbDriver, LocalRow, LocalTable } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  sameRow,
  validateOperation,
  type HubValidationCode,
  type HubValidationResult
} from "../../src/services/lanHub/validation";

const FIXED_ISO = "2026-05-01T12:00:00.000Z";
const COMPANY = "co-1";

function row(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: "dev-1",
    deleted_at: null,
    ...fields
  };
}

async function freshDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  return driver;
}

async function validate(
  driver: LocalDbDriver,
  table: string,
  rows: LocalRow[] = [],
  deletes: string[] = [],
  companyId = COMPANY
): Promise<HubValidationResult> {
  return validateOperation({ table, rows, deletes, driver, companyId });
}

function code(result: HubValidationResult): HubValidationCode | null {
  return result.ok ? null : result.code;
}

test("validation: tabla desconocida e interna no pasan nunca", async () => {
  const driver = await freshDriver();
  assert.equal(code(await validate(driver, "no_existe", [row("x1")])), "unknown_table");
  assert.equal(code(await validate(driver, "", [row("x1")])), "unknown_table");
  assert.equal(code(await validate(driver, "hub_devices", [row("d1")])), "forbidden_table");
  assert.equal(code(await validate(driver, "hub_receipts", [row("r1")])), "forbidden_table");
});

test("validation: ninguna fila ni borrado puede tocar otra empresa", async () => {
  const driver = await freshDriver();
  await driver.put("customers", [row("c-ajena", { company_id: "co-2" })]);

  assert.equal(
    code(await validate(driver, "products", [row("p1", { company_id: "co-2" })])),
    "company_mismatch"
  );
  assert.equal(
    code(await validate(driver, "customers", [], ["c-ajena"])),
    "company_mismatch"
  );
  // Un borrado de una fila que no existe es idempotente, no un error.
  assert.equal(code(await validate(driver, "customers", [], ["no-existe"])), null);
});

test("validation: append-only inserta pero rechaza actualizar y borrar", async () => {
  const driver = await freshDriver();
  const appendOnly = ["sales", "sale_items", "sale_payments", "cash_movements", "stock_movements"];

  for (const table of appendOnly) {
    const original = row(`${table}-1`, { total: 10 });
    assert.equal(code(await validate(driver, table, [original])), null, `insertar en ${table}`);

    await driver.put(table as LocalTable, [original]);
    const updated = { ...original, version: 2, total: 99 };
    assert.equal(code(await validate(driver, table, [updated])), "append_only", `actualizar ${table}`);
    assert.equal(code(await validate(driver, table, [], [original.id])), "append_only", `borrar ${table}`);
  }
});

test("validation: versiones stale, conflicto, duplicado y avance legítimo", async () => {
  const driver = await freshDriver();
  const stored = row("p1", { version: 3, name: "Viejo" });
  await driver.put("products", [stored]);

  assert.equal(
    code(await validate(driver, "products", [{ ...stored, version: 2, name: "Atrasado" }])),
    "stale_version"
  );
  assert.equal(
    code(await validate(driver, "products", [{ ...stored, name: "Distinto" }])),
    "version_conflict"
  );
  assert.equal(code(await validate(driver, "products", [{ ...stored }])), "duplicate");
  assert.equal(code(await validate(driver, "products", [{ ...stored, version: 4, name: "Nuevo" }])), null);
});

test("validation: un mismo id repetido en el lote no se escribe dos veces", async () => {
  const driver = await freshDriver();
  const p1 = row("p1", { name: "Uno" });

  assert.equal(code(await validate(driver, "products", [p1, { ...p1 }])), "duplicate");
  assert.equal(
    code(await validate(driver, "products", [p1, { ...p1, name: "Dos" }])),
    "version_conflict"
  );
});

test("validation: stock_balances no puede quedar negativo", async () => {
  const driver = await freshDriver();
  assert.equal(
    code(await validate(driver, "stock_balances", [row("b1", { product_id: "p1", quantity: -1 })])),
    "negative_stock"
  );
  assert.equal(
    code(await validate(driver, "stock_balances", [row("b1", { product_id: "p1", quantity: 0 })])),
    null
  );
  assert.equal(
    code(await validate(driver, "stock_balances", [row("b1", { product_id: "p1", quantity: 7 })])),
    null
  );
});

test("validation: movimientos de stock no pueden dejar existencias negativas", async () => {
  const driver = await freshDriver();
  await driver.put("stock_balances", [
    row("stock:p1:w1:base", { product_id: "p1", warehouse_id: "w1", quantity: 5 })
  ]);

  const outbound = (id: string, quantity: number) =>
    row(id, { product_id: "p1", warehouse_id: "w1", movement_type: "sale", quantity });

  assert.equal(code(await validate(driver, "stock_movements", [outbound("m1", -6)])), "negative_stock");
  assert.equal(code(await validate(driver, "stock_movements", [outbound("m2", -5)])), null);
  assert.equal(code(await validate(driver, "stock_movements", [outbound("m3", -4)])), null);
  assert.equal(code(await validate(driver, "stock_movements", [outbound("m4", 10)])), null);

  // Dos salidas del mismo lote se acumulan: 5 - 3 - 3 < 0.
  assert.equal(
    code(await validate(driver, "stock_movements", [outbound("m5", -3), outbound("m6", -3)])),
    "negative_stock"
  );
  // `quantity_delta` explícito también cuenta.
  assert.equal(
    code(
      await validate(driver, "stock_movements", [
        row("m7", { product_id: "p1", warehouse_id: "w1", quantity_delta: -6 })
      ])
    ),
    "negative_stock"
  );
  // Sin saldo almacenado no se puede probar el resultado: no se rechaza.
  assert.equal(
    code(
      await validate(driver, "stock_movements", [
        row("m8", { product_id: "p-sin-saldo", warehouse_id: "w1", quantity: -100 })
      ])
    ),
    null
  );
});

test("validation: un lote legítimo de catálogo no se rompe por reglas de stock", async () => {
  const driver = await freshDriver();
  const rows: Array<[string, LocalRow]> = [
    ["products", row("p1", { name: "Producto", stock: -5, quantity: -1 })],
    ["product_codes", row("pc1", { product_id: "p1", code: "A001" })],
    ["product_prices", row("pp1", { product_id: "p1", warehouse_id: "w1", price: 0 })],
    ["customers", row("c1", { name: "Cliente" })],
    ["suppliers", row("s1", { name: "Proveedor" })],
    ["purchases", row("po1", { supplier_id: "s1" })]
  ];
  for (const [table, candidate] of rows) {
    assert.equal(code(await validate(driver, table, [candidate])), null, table);
  }
});

test("validation: sameRow compara contenido completo sin importar el orden de claves", () => {
  const a: LocalRow = { id: "x", company_id: COMPANY, version: 1, updated_at: FIXED_ISO, meta: { b: 2, a: [1, 2] } } as LocalRow;
  const b: LocalRow = { meta: { a: [1, 2], b: 2 }, updated_at: FIXED_ISO, version: 1, company_id: COMPANY, id: "x" } as LocalRow;
  assert.equal(sameRow(a, b), true);
  assert.equal(sameRow(a, { ...b, version: 2 }), false);
});
