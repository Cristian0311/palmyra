import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Re-auditoría B (gestión): regresiones de inventario y auditorías de conteo.
 *
 * Regresiones que cubre:
 *  - El despacho múltiple (transferProductsBulk) fuera de línea descuenta solo
 *    el origen: el destino se acredita al confirmar la recepción, igual que el
 *    traslado unitario. Acreditar el destino en el despacho inflaba el stock
 *    de la sucursal receptora antes de recibir el lote.
 *  - "Guardar y salir" en el conteo de auditoría persiste el progreso en el
 *    equipo y se restaura al reabrir: las líneas ya contadas no se pierden.
 */

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// ---------------------------------------------------------------------------
// 1) Despacho múltiple fuera de línea: origen sí, destino no
// ---------------------------------------------------------------------------

test("transferProductsBulk: el camino offline descuenta el origen y NO acredita el destino", () => {
  const actions = source("src/store/actions/inventoryActions.ts");
  const bulkStart = actions.indexOf("transferProductsBulk: async");
  const bulkEnd = actions.indexOf("receiveTransfer: async", bulkStart);
  assert.ok(bulkStart !== -1 && bulkEnd !== -1, "transferProductsBulk existe");
  const bulk = actions.slice(bulkStart, bulkEnd);

  const blockStart = bulk.indexOf("Un lote parcial nunca aplica");
  const blockEnd = bulk.indexOf("const batchRecords", blockStart);
  assert.ok(blockStart !== -1 && blockEnd !== -1, "bloque de deltas locales del lote existe");
  const localBlock = bulk.slice(blockStart, blockEnd);

  // El origen se descuenta localmente para reflejar la salida de mercancía.
  assert.match(
    localBlock,
    /Math\.max\(0, Number\(nextInventory\[idx\]\.quantity \|\| 0\) - item\.quantity\)/,
    "el origen se descuenta en el camino sin confirmación"
  );
  // El destino NO recibe crédito local: ni sobre filas existentes ni creando filas.
  assert.ok(
    !localBlock.includes("targetIdx"),
    "el bloque ya no busca una fila de destino para acreditarla"
  );
  assert.ok(
    !localBlock.includes("branchId: toBranchId"),
    "el bloque ya no crea filas de stock en el destino"
  );
  // El principio de dos fases queda documentado en el código.
  assert.match(
    localBlock,
    /solo se acredita al confirmar la recepción/,
    "el comentario del bloque explica que el destino se acredita al recibir"
  );
  // El camino unitario conserva su propia regla (sin crédito al destino).
  assert.match(
    actions,
    /Acreditar aquí duplicaría/,
    "el despacho unitario sigue sin acreditar el destino"
  );
});

// ---------------------------------------------------------------------------
// 2) Borrador del conteo: guardar y salir sin perder progreso
// ---------------------------------------------------------------------------

test("inventoryAudit: existen helpers de borrador local del conteo", () => {
  const page = source("src/pages/InventoryAudit.tsx");
  assert.match(page, /const saveAuditDraft = /);
  assert.match(page, /const loadAuditDraft = /);
  assert.match(page, /const applyAuditDraft = /);
  assert.match(page, /const clearAuditDraft = /);
  assert.match(page, /palmyra:audit-draft:/, "clave de localStorage con prefijo propio");
});

test("inventoryAudit: reabrir un conteo en curso restaura el borrador guardado", () => {
  const page = source("src/pages/InventoryAudit.tsx");
  const openIdx = page.indexOf("const openAudit = ");
  const openEnd = page.indexOf("const filteredDraft = ", openIdx);
  assert.ok(openIdx !== -1 && openEnd !== -1, "openAudit existe");
  const openAudit = page.slice(openIdx, openEnd);
  assert.match(openAudit, /const draft = loadAuditDraft\(audit\.id\)/);
  assert.match(openAudit, /setCountDraft\(draft \? applyAuditDraft\(audit\.items, draft\) : audit\.items\)/);
  assert.match(openAudit, /if \(draft\?\.notes\) setNotes\(draft\.notes\)/);
});

test("inventoryAudit: el progreso se persiste debounced mientras se cuenta", () => {
  const page = source("src/pages/InventoryAudit.tsx");
  assert.match(
    page,
    /setTimeout\(\(\) => \{\s*saveAuditDraft\(selectedAuditId, countDraft, notes\);\s*\}, 600\)/,
    "persistencia automática debounced durante el conteo"
  );
  assert.match(page, /if \(!showModal \|\| !selectedAuditId \|\| step !== "count"\) return;/);
});

test("inventoryAudit: «Guardar y salir» guarda el borrador antes de cerrar el modal", () => {
  const page = source("src/pages/InventoryAudit.tsx");
  const buttonIdx = page.lastIndexOf("Guardar y salir");
  assert.ok(buttonIdx !== -1, "el botón existe");
  // El saveAuditDraft del pie del modal es la última llamada antes del rótulo
  // del botón (el cierre con X, en la cabecera, ocurre antes en el archivo).
  const saveIdx = page.lastIndexOf("saveAuditDraft(selectedAuditId, countDraft, notes)", buttonIdx);
  assert.ok(saveIdx !== -1, "el onClick guarda el borrador");
  const closeIdx = page.lastIndexOf("setShowModal(false)", buttonIdx);
  assert.ok(closeIdx > saveIdx, "el guardado ocurre antes del cierre");
  const onClickBlock = page.slice(saveIdx, buttonIdx);
  assert.match(onClickBlock, /addNotification\("Progreso del conteo guardado en este equipo/, "aviso al usuario de que el progreso quedó guardado");
});

test("inventoryAudit: el borrador se limpia al enviar, aprobar o eliminar", () => {
  const page = source("src/pages/InventoryAudit.tsx");
  assert.match(
    page,
    /await completeInventoryAudit\(selectedAuditId[\s\S]*?clearAuditDraft\(selectedAuditId\)/,
    "enviar el conteo descarta el borrador"
  );
  assert.match(
    page,
    /await approveInventoryAudit\(selectedAuditId[\s\S]*?clearAuditDraft\(selectedAuditId\)/,
    "aprobar descarta el borrador"
  );
  assert.match(page, /clearAuditDraft\(pendingDelete\.id\)/, "eliminar descarta el borrador");
});

test("inventoryAudit: el cierre con la X también conserva el progreso", () => {
  const page = source("src/pages/InventoryAudit.tsx");
  assert.match(
    page,
    /if \(step === "count" && selectedAuditId\) saveAuditDraft\(selectedAuditId, countDraft, notes\);/,
    "el botón X del modal guarda el borrador en paso de conteo"
  );
});
