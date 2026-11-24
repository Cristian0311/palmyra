/**
 * Pruebas del simulacro de restauración (F7-C).
 *
 * Todo corre en memoria con conjuntos pequeños para ser rápido; el simulacro
 * real de 5 000 ventas se lanza con `npm run drill:restore`. Aquí se cubre la
 * integridad del conjunto, la ida y vuelta del respaldo, el informe, la
 * detección de diferencias, el umbral de 15 minutos con reloj inyectado y las
 * guardas puras de confirmación y de instantánea de seguridad.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DRILL_PASSPHRASE,
  DEFAULT_SALES_ROWS,
  DEFAULT_STOCK_ROWS,
  MIN_DRILL_TABLES,
  RESTORE_CONFIRMATION_WORD,
  RESTORE_DRILL_LIMIT_MS,
  buildDrillDataset,
  compareDrillExpectation,
  drillContentHash,
  evaluateHubRestorePreflight,
  formatRestoreDrillReport,
  isRestoreConfirmationValid,
  runRestoreDrill,
  type DrillDataset
} from "../../scripts/restore-drill";
import { LOCAL_DB_TABLE_NAMES } from "../../src/services/localDb/schema";

const SMALL = { salesCount: 60, stockCount: 30 } as const;

function sumField(dataset: DrillDataset, table: string, field: string): number {
  return (dataset.tables[table] ?? []).reduce((sum, row) => {
    const value = Number(row[field]);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

test("el conjunto sintético cubre el mínimo de tablas y los volúmenes del plan", () => {
  const dataset = buildDrillDataset();

  assert.ok(dataset.tableCount >= MIN_DRILL_TABLES, `tablas con datos: ${dataset.tableCount}`);
  assert.equal(dataset.salesCount, DEFAULT_SALES_ROWS);
  assert.equal(dataset.tables.stock_balances.length, DEFAULT_STOCK_ROWS);
  assert.ok(dataset.cashMovements > 0, "debe haber movimientos de caja");
  assert.ok(dataset.transfers > 0, "debe haber transferencias");

  // Conteos y total derivados del propio contenido, no declarados a mano.
  let rows = 0;
  let tablesWithRows = 0;
  for (const table of LOCAL_DB_TABLE_NAMES) {
    const length = dataset.tables[table].length;
    assert.equal(dataset.counts[table], length, `conteo de ${table}`);
    rows += length;
    if (length > 0) tablesWithRows += 1;
  }
  assert.equal(dataset.totalRows, rows);
  assert.equal(dataset.tableCount, tablesWithRows);
  assert.equal(dataset.salesTotal, sumField(dataset, "sales", "total"));
  assert.equal(dataset.stockQuantity, sumField(dataset, "stock_balances", "quantity"));
});

test("todas las filas son válidas para el contrato y de la misma empresa", () => {
  const dataset = buildDrillDataset({ salesCount: 20, stockCount: 10 });
  for (const table of LOCAL_DB_TABLE_NAMES) {
    for (const row of dataset.tables[table]) {
      assert.equal(typeof row.id, "string", `${table}: id`);
      assert.ok(row.id.length > 0, `${table}: id vacío`);
      assert.equal(row.company_id, dataset.companyId, `${table}: empresa`);
      assert.equal(typeof row.version, "number", `${table}: version`);
      assert.equal(typeof row.updated_at, "string", `${table}: updated_at`);
      assert.equal(typeof row.origin_device, "string", `${table}: origin_device`);
    }
  }
});

test("el conjunto es determinista: dos generaciones producen el mismo hash", async () => {
  const first = buildDrillDataset({ salesCount: 40, stockCount: 20 });
  const second = buildDrillDataset({ salesCount: 40, stockCount: 20 });
  assert.equal(await drillContentHash(first.tables), await drillContentHash(second.tables));

  const changed = buildDrillDataset({ salesCount: 40, stockCount: 20 });
  changed.tables.sales[0] = { ...changed.tables.sales[0], total: 999999 };
  assert.notEqual(await drillContentHash(changed.tables), await drillContentHash(first.tables));
});

test("respaldo, borrado y restauración devuelven exactamente el mismo almacén", async () => {
  const result = await runRestoreDrill(SMALL);

  assert.equal(result.ok, true, result.mismatches.join("; "));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.hashMatches, true);
  assert.equal(result.staleRowsRemoved, true);
  assert.equal(result.withinLimit, true);
  assert.equal(result.dataset.totalRows, result.restored.totalRows);
  assert.equal(result.dataset.salesTotal, result.restored.salesTotal);
  assert.equal(result.dataset.stockQuantity, result.restored.stockQuantity);
  assert.equal(result.restore.written, result.dataset.totalRows);
  assert.equal(result.restore.removed, 2);
  assert.equal(result.backup.hash, result.restored.hash);
  assert.equal(result.restore.hash, result.backup.envelopeHash);
});

test("el informe contiene las secciones del simulacro y nunca la frase del respaldo", async () => {
  const result = await runRestoreDrill(SMALL);
  const report = formatRestoreDrillReport(result);

  for (const expected of [
    "SIMULACRO DE RESTAURACIÓN",
    "Conjunto sintético",
    "Respaldo cifrado",
    "Restauración:",
    "Tiempo:",
    "Hash idéntico",
    "Dentro del objetivo",
    "VEREDICTO: CORRECTO"
  ]) {
    assert.ok(report.includes(expected), `falta "${expected}"`);
  }
  assert.ok(report.includes(result.backup.hash));
  assert.ok(report.includes(`${result.elapsedMs.toFixed(1)} ms`));
  assert.ok(!report.includes(DRILL_PASSPHRASE), "el informe no debe exponer la frase");
  assert.equal(result.backup.totalRows, result.dataset.totalRows);
  assert.ok(result.backup.sizeBytes > 0);
});

test("la comparación detecta diferencias de conteos, ventas y stock", async () => {
  const dataset = buildDrillDataset(SMALL);
  const result = await runRestoreDrill(SMALL);

  const salesMismatch = compareDrillExpectation(dataset, {
    ...result.restored,
    salesTotal: result.restored.salesTotal + 1
  });
  assert.equal(salesMismatch.ok, false);
  assert.ok(salesMismatch.mismatches.some(line => line.includes("total de ventas")));

  const stockMismatch = compareDrillExpectation(dataset, {
    ...result.restored,
    stockQuantity: result.restored.stockQuantity - 1
  });
  assert.ok(stockMismatch.mismatches.some(line => line.includes("cantidad en stock")));

  const countsMismatch = compareDrillExpectation(dataset, {
    ...result.restored,
    counts: { ...result.restored.counts, sales: (result.restored.counts.sales ?? 0) + 1 }
  });
  assert.ok(countsMismatch.mismatches.some(line => line.includes("tabla sales")));

  const hashMismatch = compareDrillExpectation(dataset, { ...result.restored, hash: "" });
  assert.ok(hashMismatch.mismatches.some(line => line.includes("hash")));
});

test("superar los 15 minutos con reloj inyectado marca el simulacro como fallo", async () => {
  let tick = 0;
  const clock = () => (tick++ === 0 ? 0 : RESTORE_DRILL_LIMIT_MS + 1);

  const result = await runRestoreDrill({ ...SMALL, clock });

  assert.equal(result.elapsedMs, RESTORE_DRILL_LIMIT_MS + 1);
  assert.equal(result.limitMs, RESTORE_DRILL_LIMIT_MS);
  assert.equal(result.withinLimit, false);
  assert.equal(result.ok, false, "el tiempo excedido debe invalidar el simulacro");
  assert.equal(result.exitCode, 1);
  assert.ok(result.mismatches.some(line => line.includes("15 min")));
  // Aunque falle el tiempo, los datos siguen siendo correctos.
  assert.equal(result.hashMatches, true);
  assert.ok(!result.mismatches.some(line => line.startsWith("tabla ")));
});

test("la restauración exige palabra, aviso y diálogo nativo", () => {
  assert.equal(
    isRestoreConfirmationValid({ typed: RESTORE_CONFIRMATION_WORD, acknowledged: true, dialogConfirmed: true }),
    true
  );
  assert.equal(
    isRestoreConfirmationValid({ typed: " restaurar ", acknowledged: true, dialogConfirmed: true }),
    false,
    "la palabra se exige en mayúsculas exactas"
  );
  assert.equal(
    isRestoreConfirmationValid({ typed: RESTORE_CONFIRMATION_WORD, acknowledged: true, dialogConfirmed: false }),
    false,
    "sin diálogo nativo no se restaura"
  );
  assert.equal(
    isRestoreConfirmationValid({ typed: RESTORE_CONFIRMATION_WORD, acknowledged: false, dialogConfirmed: true }),
    false,
    "sin aceptar el aviso no se restaura"
  );
  assert.equal(
    isRestoreConfirmationValid({ typed: "", acknowledged: true, dialogConfirmed: true }),
    false
  );
});

test("la preflight del hub no avanza sin instantánea de seguridad correcta", () => {
  assert.equal(
    evaluateHubRestorePreflight({
      confirmed: true,
      companyId: "empresa-1",
      safetySnapshot: { ok: true, fileName: "safety-20261120-080000.pbak" }
    }).ok,
    true
  );

  const withoutConfirmation = evaluateHubRestorePreflight({
    confirmed: false,
    companyId: "empresa-1",
    safetySnapshot: { ok: true, fileName: "safety.pbak" }
  });
  assert.equal(withoutConfirmation.ok, false);
  assert.match(withoutConfirmation.error ?? "", /confirmación/i);

  const failedSnapshot = evaluateHubRestorePreflight({
    confirmed: true,
    companyId: "empresa-1",
    safetySnapshot: { ok: false }
  });
  assert.equal(failedSnapshot.ok, false);
  assert.match(failedSnapshot.error ?? "", /instantánea de seguridad/i);

  const missingSnapshot = evaluateHubRestorePreflight({ confirmed: true, companyId: "empresa-1" });
  assert.equal(missingSnapshot.ok, false);

  const noCompany = evaluateHubRestorePreflight({
    confirmed: true,
    companyId: "",
    safetySnapshot: { ok: true }
  });
  assert.equal(noCompany.ok, false);

  const inFlight = evaluateHubRestorePreflight({
    confirmed: true,
    inFlight: true,
    companyId: "empresa-1",
    safetySnapshot: { ok: true }
  });
  assert.equal(inFlight.ok, false);
  assert.match(inFlight.error ?? "", /curso/i);
});
