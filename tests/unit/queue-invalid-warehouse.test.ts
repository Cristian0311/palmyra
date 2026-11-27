import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PERMANENT_SYNC_ERROR_CODES,
  buildSyncFailure,
  describeOfflineQueueType,
  describeQueueItemFailure,
  describeSyncFailure,
  extractSyncErrorCode,
  isPermanentSyncRejection,
  withPersistedSyncFailure
} from "../../src/services/offline/syncContract";

/**
 * Regresión del síntoma real del dueño:
 *   "inventory_reconcile · invrec:05c7577a-…: invalid_warehouse"
 *   "Resultado de esta sincronización: 0 procesadas, 2 fallidas, 2 restantes."
 *   "…sigue pendiente, pero no tiene una causa registrada."
 *
 * Reglas que estas pruebas protegen:
 *  - Un rechazo del servidor con código permanente conocido (`invalid_warehouse`,
 *    `invalid_product`, `location_access_denied`, `invalid_cash_session`,
 *    `warehouse_not_assigned`, …) es terminal: sale de "restantes".
 *  - Red / 5xx / `insufficient_stock` siguen siendo reintentables.
 *  - El operador nunca ve el código crudo: siempre español accionable.
 *  - TODO intento fallido persiste causa + código + marca temporal en el ítem.
 */

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function stuckReconcile(overrides: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    actionId: "invrec:05c7577a-4a79-4c71-89b6-eca08d6dca47",
    type: "inventory_reconcile",
    data: { productId: "p-1", branchId: "w-deleted", expectedQuantity: 10, newQuantity: 8 },
    timestamp: "2026-11-20T10:00:00.000Z",
    queuedAt: "2026-11-20T10:00:00.000Z",
    retryCount: 4,
    status: "failed" as const,
    lastError: "invalid_warehouse [P0001] HTTP 400",
    ...overrides
  };
}

/* ------------------------- clasificación terminal ------------------------- */

test("los rechazos por almacén/producto/turno caídos son terminales, no reintentos infinitos", () => {
  const permanentCases = [
    { code: "invalid_warehouse", message: "invalid_warehouse" },
    { code: "warehouse_not_assigned", message: "warehouse_not_assigned" },
    { code: "location_access_denied", message: "location_access_denied" },
    { code: "invalid_product", message: "raise_exception: invalid_product" },
    { code: "invalid_cash_session", message: "invalid_cash_session" },
    { code: "sale_not_found", message: "sale_not_found" },
    { code: "company_access_denied", message: "company_access_denied" },
    { code: "23503", message: 'insert or update on table violates foreign key constraint' }
  ];
  for (const testCase of permanentCases) {
    assert.equal(
      isPermanentSyncRejection({ ...testCase, type: "inventory_reconcile" }),
      true,
      `${testCase.code} debe ser un rechazo definitivo`
    );
  }
});

test("un mensaje P0001 sin código reconocido sigue siendo reintentable", () => {
  assert.equal(isPermanentSyncRejection({ code: "P0001", message: "some other raise", type: "inventory_reconcile" }), false);
  assert.equal(extractSyncErrorCode("P0001", "some other raise"), "p0001");
});

test("red, 5xx y stock insuficiente nunca descartan la operación", () => {
  const transientCases = [
    { message: "Failed to fetch", type: "inventory_reconcile" },
    { code: "P0001", message: "invalid_warehouse-ish network blip", status: 503, type: "inventory_reconcile" },
    { code: "429", message: "too many requests", status: 429, type: "inventory_reconcile" },
    { code: "P0001", message: "insufficient_stock", type: "inventory_adjustment" },
    { code: "P0001", message: "insufficient_component_stock", type: "inventory" },
    { message: "", type: "inventory_reconcile" }
  ];
  for (const testCase of transientCases) {
    assert.equal(isPermanentSyncRejection(testCase), false, JSON.stringify(testCase));
  }
});

test("los códigos inválidos solo son terminales para operaciones de inventario/traslado", () => {
  assert.equal(isPermanentSyncRejection({ code: "invalid_operation_id", message: "", type: "inventory_reconcile" }), true);
  assert.equal(isPermanentSyncRejection({ code: "invalid_transfer", message: "", type: "transfer_receive" }), true);
  assert.equal(isPermanentSyncRejection({ code: "invalid_operation_id", message: "", type: "transaction" }), false);
});

/* ------------------------------ traducción ------------------------------- */

test("describeSyncFailure devuelve español accionable y jamás el código crudo", () => {
  const warehouse = describeSyncFailure("invalid_warehouse", "inventory_reconcile");
  assert.match(warehouse, /^Conciliación de inventario:/);
  assert.match(warehouse, /ya no está disponible \(se dio de baja\)/);
  assert.match(warehouse, /repítela en el almacén correcto/);
  assert.doesNotMatch(warehouse, /\binvalid_warehouse\b/);

  for (const code of ["invalid_product", "location_access_denied", "invalid_cash_session", "warehouse_not_assigned"]) {
    const text = describeSyncFailure(code, "inventory_adjustment");
    assert.ok(text.length > 20, code);
    assert.doesNotMatch(text, new RegExp(`\\b${code}\\b`), `el usuario no debe ver ${code} en crudo`);
    assert.match(text, /^Ajuste de inventario:/);
  }
  // Cobertura mínima del mapa: los códigos exigidos por las RPC están todos.
  for (const code of ["invalid_warehouse", "invalid_product", "location_access_denied", "invalid_cash_session", "warehouse_not_assigned"]) {
    assert.ok(PERMANENT_SYNC_ERROR_CODES.includes(code), `${code} debe estar en el mapa`);
  }
});

test("describeSyncFailure tolera el envoltorio de Postgres y los errores sin código", () => {
  assert.match(describeSyncFailure('raise_exception: invalid_warehouse', "inventory"), /ya no está disponible/);
  assert.match(describeSyncFailure("Failed to fetch", "inventory_reconcile"), /no hay conexión estable/);
  assert.match(describeSyncFailure("", "inventory_reconcile"), /sin devolver un motivo/);
  // Mensaje útil desconocido: se conserva normalizado, no se inventa nada.
  assert.match(describeSyncFailure("El proveedor rechazó la orden", "supplier_order"), /El proveedor rechazó la orden/);
});

/* --------------------------- causa persistida ---------------------------- */

test("buildSyncFailure persiste causa legible, código y marca temporal", () => {
  const item = stuckReconcile();
  const failure = buildSyncFailure(item, Object.assign(new Error("invalid_warehouse"), { code: "P0001" }), {
    permanent: true,
    now: Date.parse("2026-11-26T09:30:00.000Z")
  });
  assert.equal(failure.failureCode, "invalid_warehouse");
  assert.equal(failure.failureKind, "permanent");
  assert.equal(failure.failureAt, "2026-11-26T09:30:00.000Z");
  assert.match(failure.failureReason, /ya no está disponible \(se dio de baja\)/);
  assert.doesNotMatch(failure.failureReason, /invalid_warehouse/);
  // Cuántos reintentos hay: retryCount 4 + este intento = 5.
  assert.match(failure.lastError, /· intento 5$/);
  assert.match(failure.lastError, /\[invalid_warehouse\]/);
});

test("withPersistedSyncFailure no borra ni muta la operación, solo anota la causa", () => {
  const item = stuckReconcile({ status: "pending", lastError: undefined, retryCount: 0 });
  const annotated = withPersistedSyncFailure(item, new Error("invalid_warehouse"), { permanent: true });
  assert.equal(annotated.id, item.id);
  assert.deepEqual(annotated.data, item.data);
  assert.equal(annotated.status, "pending");
  assert.equal(annotated.retryCount, 0);
  assert.ok(annotated.failureReason && annotated.failureAt && annotated.failureKind === "permanent");
});

test("un fallo transitorio deja causa legible y dice que se seguirá reintentando", () => {
  const item = stuckReconcile({ retryCount: 1 });
  const failure = buildSyncFailure(item, Object.assign(new Error("fetch failed"), { status: undefined }), {
    permanent: false,
    now: Date.parse("2026-11-26T10:00:00.000Z")
  });
  assert.equal(failure.failureKind, "transient");
  assert.match(failure.failureReason, /no hay conexión estable/);
  const text = describeQueueItemFailure({ ...item, ...failure }, { now: Date.parse("2026-11-26T10:20:00.000Z") });
  assert.match(text, /^Conciliación de inventario #05c7577a:/);
  assert.match(text, /Sigue guardada y se reintentará automáticamente/);
  assert.match(text, /Lleva 1 reintento/);
  assert.match(text, /hace 20 min/);
});

test("describeQueueItemFailure elimina el callejón sin salida del ítem pendiente", () => {
  // Caso heredado: pendiente SIN causa persistida pero con lastError crudo.
  const legacy = stuckReconcile({ status: "pending" });
  const legacyText = describeQueueItemFailure(legacy, { now: Date.parse("2026-11-26T10:00:00.000Z") });
  assert.match(legacyText, /^Conciliación de inventario #05c7577a:/);
  assert.match(legacyText, /ya no está disponible \(se dio de baja\)/);
  assert.match(legacyText, /Lleva 4 reintentos/);
  assert.doesNotMatch(legacyText, /\binvalid_warehouse\b/);
  assert.doesNotMatch(legacyText, /no tiene una causa registrada/);

  // Peor caso heredado: pendiente sin ninguna información.
  const blind = stuckReconcile({ status: "pending", lastError: undefined, retryCount: 0 });
  const blindText = describeQueueItemFailure(blind);
  assert.match(blindText, /^Conciliación de inventario #05c7577a: sigue pendiente sin causa registrada/);
  assert.match(blindText, /Monitor de Logs/);

  // Conflicto definitivo: dice que no se reintenta y qué hacer.
  const conflict = stuckReconcile({
    status: "conflict",
    failureReason: "Conciliación de inventario: El almacén de esta operación ya no está disponible (se dio de baja).",
    failureCode: "invalid_warehouse",
    failureAt: "2026-11-26T09:00:00.000Z",
    failureKind: "permanent"
  });
  const conflictText = describeQueueItemFailure(conflict, { now: Date.parse("2026-11-26T12:00:00.000Z") });
  assert.match(conflictText, /No se volverá a reintentar/);
  assert.match(conflictText, /Código: invalid_warehouse/);
  // La etiqueta de la operación no se duplica.
  assert.equal((conflictText.match(/Conciliación de inventario/g) || []).length, 1);
});

/* ------------------------ cableado en el código -------------------------- */

test("el replay trata los rechazos permanentes de inventario como conflictos definitivos", () => {
  const processor = source("src/services/offline/processQueueItem.ts");
  assert.match(processor, /import \{ describeSyncFailure, isPermanentSyncRejection \} from '\.\/syncContract'/);
  assert.match(processor, /async function terminalInventoryRejection\(/);
  // Terminal = PermanentSyncError (el motor lo convierte en status 'conflict').
  assert.match(processor, /throw new PermanentSyncError\(message\)/);
  for (const type of ["inventory", "inventory_adjustment", "inventory_reconcile"]) {
    const block = processor.match(new RegExp(`case '${type}': \\{([\\s\\S]*?)\\n    \\}`));
    assert.ok(block, `debe existir el case '${type}'`);
    assert.match(block[1], /isPermanentSyncRejection\(/, `${type} debe clasificar rechazos permanentes`);
    assert.match(block[1], /terminalInventoryRejection\(/, `${type} debe terminar con causa traducida`);
  }
  // El rastro de reintentos también se traduce: nunca código crudo al operador.
  const trace = processor.match(/function withRetryTrace\([\s\S]*?\n}/);
  assert.ok(trace);
  assert.match(trace[0], /describeSyncFailure\(/);
  assert.match(trace[0], /el servidor rechazó esta operación de forma definitiva/);
  // No se introduce ningún borrado agresivo de la cola.
  assert.doesNotMatch(processor, /removeFromOfflineQueue\(item\.id\)/);
});

test("el motor persiste la causa en cada intento fallido y el panel la muestra", () => {
  const engine = source("src/services/offlineSync.ts");
  assert.match(engine, /withPersistedSyncFailure, describeQueueItemFailure|withPersistedSyncFailure/);
  const catchBlock = engine.match(/\} catch \(err:any\) \{[\s\S]*?addSyncLog\(\{ level:'error', source:'offline_queue'/);
  assert.ok(catchBlock, "debe existir el bloque de fallo del replay");
  assert.match(catchBlock[0], /item\.failureReason = annotated\.failureReason/);
  assert.match(catchBlock[0], /item\.failureCode = annotated\.failureCode/);
  assert.match(catchBlock[0], /item\.failureAt = annotated\.failureAt/);
  assert.match(catchBlock[0], /item\.failureKind = annotated\.failureKind/);
  assert.match(catchBlock[0], /item\.lastError = String\(annotated\.lastError/);
  // Un bloqueo por dependencia permanente también queda con causa registrada.
  assert.match(engine, /const conflictItem = withPersistedSyncFailure\(/);

  const layout = source("src/components/Layout.tsx");
  assert.match(layout, /describeQueueItemFailure/);
  assert.doesNotMatch(layout, /no tiene una causa registrada\. Reintenta la sincronización/);
  assert.match(layout, /rechazadas de forma definitiva/);

  const types = source("src/services/offlineQueueTypes.ts");
  assert.match(types, /failureReason\?: string/);
  assert.match(types, /failureCode\?: string/);
  assert.match(types, /failureAt\?: string/);
  assert.match(types, /failureKind\?: 'permanent' \| 'transient'/);
});
