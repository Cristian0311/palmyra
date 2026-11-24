/**
 * Pruebas de las piezas puras del arnés end-to-end local.
 *
 * El escenario completo (hub, respaldo, licencia, tasas) se ejecuta con
 *   npm run test:e2e:local
 * y escribe todo en memoria. Aquí solo se validan el resumen PASS/FAIL, el
 * código de salida, la comparación de conteos, el cotejo de acuses, los
 * nombres de los pasos y las fábricas del escenario.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  STEP_NAMES,
  buildLegacyFixture,
  checkOutcomes,
  compareRowCounts,
  makeNegativeStockRow,
  makeSaleRow,
  summarizeSteps,
  type StepResult
} from "../../scripts/local-e2e";
import type { HubOpOutcome } from "../../src/services/lanHub/opsClient";

function stepResult(n: number, ok: boolean, detail = ""): StepResult {
  return { n, name: STEP_NAMES[n - 1], ok, detail };
}

test("el escenario declara diecinueve pasos únicos y legibles", () => {
  assert.equal(STEP_NAMES.length, 19);
  assert.equal(new Set(STEP_NAMES).size, 19);
  assert.match(STEP_NAMES[0], /legado/i);
  assert.match(STEP_NAMES[3], /hub/i);
  assert.match(STEP_NAMES[6], /respaldo/i);
  assert.match(STEP_NAMES[7], /licencia/i);
  assert.match(STEP_NAMES[8], /tasas/i);
  assert.match(STEP_NAMES[9], /anulaci/i);
  assert.match(STEP_NAMES[10], /SSE/i);
  assert.match(STEP_NAMES[11], /tasas/i);
  assert.match(STEP_NAMES[12], /binario/i);
  assert.match(STEP_NAMES[13], /importaci/i);
  assert.match(STEP_NAMES[14], /POS/i);
  assert.match(STEP_NAMES[15], /push/i);
  assert.match(STEP_NAMES[16], /pull|equipo/i);
  assert.match(STEP_NAMES[17], /paridad/i);
  assert.match(STEP_NAMES[18], /resumen/i);
});

test("el resumen marca PASS/FAIL y devuelve código 0 solo si todo pasa", () => {
  const allOk = summarizeSteps([
    stepResult(1, true, "sombra lista"),
    stepResult(2, true, "hub en loopback"),
    stepResult(3, true, "emparejado")
  ]);
  assert.equal(allOk.passed, 3);
  assert.equal(allOk.failed, 0);
  assert.equal(allOk.exitCode, 0);
  assert.match(allOk.text, /PASS {2}01\. /);
  assert.match(allOk.text, /Resumen: 3\/3 pasos correctos/);
  assert.doesNotMatch(allOk.text, /FAIL/);

  const withFailure = summarizeSteps([
    stepResult(2, true),
    stepResult(1, false, "no importó"),
    stepResult(3, false, "sin token")
  ]);
  assert.equal(withFailure.passed, 1);
  assert.equal(withFailure.failed, 2);
  assert.equal(withFailure.exitCode, 1);
  assert.match(withFailure.text, /FAIL {2}01\. /);
  assert.match(withFailure.text, /no importó/);
  assert.match(withFailure.text, /Resumen: 1\/3 pasos correctos, 2 con fallo/);

  // El resumen ordena por número de paso aunque la entrada llegue desordenada.
  assert.ok(withFailure.text.indexOf("01.") < withFailure.text.indexOf("03."));
});

test("la comparación de conteos detecta faltantes y sobrantes", () => {
  assert.deepEqual(compareRowCounts({ products: 2, sales: 1 }, { products: 2, sales: 1 }), []);
  assert.deepEqual(compareRowCounts({}, {}), []);

  const issues = compareRowCounts(
    { products: 2, sales: 1, stock_balances: 2 },
    { products: 1, sales: 1, extra: 4 }
  );
  assert.ok(issues.some((issue) => issue.includes("products: esperado 2, real 1")));
  assert.ok(issues.some((issue) => issue.includes("stock_balances: esperado 2, real 0")));
  assert.ok(issues.some((issue) => issue.includes("extra: esperado 0, real 4")));
  assert.equal(issues.some((issue) => issue.includes("sales")), false);
});

test("el cotejo de acuses exige estado y código de error por operación", () => {
  const outcomes: HubOpOutcome[] = [
    { actionId: "venta", status: "accepted" },
    { actionId: "edicion", status: "rejected", error: "append_only" },
    { actionId: "stock", status: "rejected", error: "negative_stock" },
    { actionId: "vieja", status: "duplicate" }
  ];

  assert.deepEqual(
    checkOutcomes(outcomes, [
      { actionId: "venta", status: "accepted" },
      { actionId: "edicion", status: "rejected", error: "append_only" },
      { actionId: "stock", status: "rejected", error: "negative_stock" },
      { actionId: "vieja", status: "duplicate" }
    ]),
    []
  );

  const issues = checkOutcomes(outcomes, [
    { actionId: "venta", status: "rejected" },
    { actionId: "edicion", status: "rejected", error: "stale_version" },
    { actionId: "fantasma", status: "accepted" }
  ]);
  assert.ok(issues.some((issue) => issue.includes("venta: esperado rejected, recibido accepted")));
  assert.ok(issues.some((issue) => issue.includes("edicion: error esperado stale_version, recibido append_only")));
  assert.ok(issues.some((issue) => issue.includes("sin acuse para fantasma")));
});

test("las fábricas producen filas válidas y el fixture cubre la sombra", () => {
  const at = "2026-06-15T12:00:00.000Z";
  const sale = makeSaleRow("co-e2e", "dev-1", at);
  assert.equal(sale.company_id, "co-e2e");
  assert.equal(sale.origin_device, "dev-1");
  assert.equal(sale.updated_at, at);
  assert.equal(sale.version, 1);
  assert.equal(sale.deleted_at, null);
  assert.equal(sale.total, 250);

  const adjusted = makeSaleRow("co-e2e", "dev-1", at, { total: 999, version: 2 });
  assert.equal(adjusted.total, 999);
  assert.equal(adjusted.version, 2);
  assert.equal(adjusted.id, sale.id);

  const negative = makeNegativeStockRow("co-e2e", "dev-1", at);
  assert.equal(typeof negative.quantity, "number");
  assert.ok((negative.quantity as number) < 0);
  assert.equal(negative.table, undefined);

  const fixture = buildLegacyFixture() as {
    state: Record<string, unknown[]>;
    version: number;
  };
  assert.equal(fixture.version, 0);
  assert.equal((fixture.state.products as unknown[]).length, 2);
  assert.equal((fixture.state.transactions as unknown[]).length, 1);
  assert.equal((fixture.state.inventory as unknown[]).length, 2);
});
