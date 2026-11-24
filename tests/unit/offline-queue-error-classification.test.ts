import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Clasificación de errores del replay offline (processQueueItem).
 *
 * Reglas que estas pruebas protegen:
 *  - `P0001` (raise_exception) ya no es permanente por sí mismo: solo mensajes
 *    irreversibles concretos se descartan; el resto se reintenta y queda visible.
 *  - Red/5xx nunca se clasifican como descarte definitivo.
 *  - `warehouse_out_of_scope` no se descarta si el usuario puede gestionar
 *    empleados (`employees.manage`), porque puede corregir su alcance.
 *  - Ningún ítem se elimina por agotar reintentos: el error persistido explica
 *    que la operación sigue en la cola.
 */

const processor = readFileSync(
  join(process.cwd(), "src/services/offline/processQueueItem.ts"),
  "utf8"
);

test("P0001 no está en la lista de códigos permanentes", () => {
  const block = processor.match(/const PERMANENT_SYNC_SQL_CODES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "debe existir la lista de códigos permanentes");
  assert.doesNotMatch(block[1], /'P0001'/);
  // Los códigos realmente estructurales siguen descartándose.
  for (const code of ["23503", "23505", "42501", "42883", "IDEMPOTENCY_CONFLICT"]) {
    assert.match(block[1], new RegExp(`'${code}'`));
  }
});

test("solo mensajes P0001 irreversibles se descartan y los transitorios se reintentan", () => {
  assert.match(processor, /const IRREVERSIBLE_BUSINESS_ERRORS\s*=[\s\S]*?sale_not_found[\s\S]*?return_not_found/);
  const classifier = processor.match(/function isPermanentSyncFailure\([\s\S]*?\n}/);
  assert.ok(classifier, "debe existir isPermanentSyncFailure");
  assert.match(classifier[0], /if \(token === 'P0001'\)/);
  assert.match(classifier[0], /return false;/);
  // Un 5xx/red no tiene código permanente: el clasificador cae en `false`.
  assert.doesNotMatch(classifier[0], /'5\d\d'/);
});

test("warehouse_out_of_scope conserva el ítem cuando el usuario tiene employees.manage", () => {
  assert.match(processor, /function can\(permission: string\)/);
  assert.match(processor, /useStore\.getState\(\)\?\.currentUser/);
  const normalizer = processor.match(/function normalizeEmployeeSyncError\([\s\S]*?\n}/);
  assert.ok(normalizer, "debe existir normalizeEmployeeSyncError");
  assert.match(normalizer[0], /warehouse_out_of_scope/i);
  assert.match(normalizer[0], /can\('employees\.manage'\)/);
  // Con permiso: error reintentable (sin `permanent`) con mensaje claro.
  assert.match(normalizer[0], /se conserva en la cola/);
  // Sin permiso: conflicto visible, nunca pérdida silenciosa.
  assert.match(normalizer[0], /PermanentSyncError/);
  // El RPC de trabajadores pasa por el normalizador en alta y edición.
  assert.equal((processor.match(/normalizeEmployeeSyncError\(/g) || []).length >= 4, true);
});

test("agotar reintentos deja rastro visible y nunca elimina el ítem", () => {
  assert.match(processor, /const OFFLINE_RETRY_VISIBILITY_THRESHOLD = 5;/);
  const trace = processor.match(/function withRetryTrace\([\s\S]*?\n}/);
  assert.ok(trace, "debe existir withRetryTrace");
  assert.match(trace[0], /la operación se conserva en la cola/);
  assert.match(trace[0], /permanent: source\?\.permanent === true/);
  // El wrapper solo anota el error: no hay ningún borrado por contador.
  assert.match(processor, /async function processQueueItem[\s\S]*?replayQueueItem/);
  assert.doesNotMatch(processor, /retryCount\s*(>=|>)\s*\d+\s*\)?\s*removeFromOfflineQueue/);
  assert.doesNotMatch(processor, /removeFromOfflineQueue\(item\.id\)/);
});
