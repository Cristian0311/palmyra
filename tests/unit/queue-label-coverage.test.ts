import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUEUE_TYPE_LABELS, describeOfflineQueueType } from "../../src/services/offline/syncContract";

/**
 * Regresión del síntoma real del dueño: una acción pendiente que nunca se
 * sincronizaba y que en pantalla se llamaba «Actualizar configuración».
 *
 * Dos causas separadas:
 *  1. `storeConfig.manualOfflineSync` congelaba todos los disparos automáticos de
 *     la cola y ninguna pantalla exponía la bandera para quitarla.
 *  2. `store_config` no tenía etiqueta en español, así que el panel imprimía el
 *     snake case titulado en inglés y el dueño no podía saber qué era la operación.
 */

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/** Miembros de la unión declarada: se leen de la fuente para no duplicar la lista. */
function unionMembers(): string[] {
  const types = source("src/services/offlineQueueTypes.ts");
  const start = types.indexOf("export type OfflineActionType");
  const end = types.indexOf("export interface OfflineQueueItem");
  if (start < 0 || end < 0 || end < start) {
    throw new Error("No se encontró el final de la unión OfflineActionType.");
  }
  return Array.from(types.slice(start, end).matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
}

test("every queued action type has a Spanish label", () => {
  const members = unionMembers();
  assert.ok(members.length > 40, "la unión debe leerse completa");
  const missing = members.filter((type) => !QUEUE_TYPE_LABELS[type as keyof typeof QUEUE_TYPE_LABELS]);
  assert.deepEqual(missing, [], `tipos de cola sin etiqueta en español: ${missing.join(", ")}`);
});

test("labels never leak the internal snake_case or English vocabulary", () => {
  for (const [type, label] of Object.entries(QUEUE_TYPE_LABELS)) {
    assert.ok(label.trim().length > 2, `${type} tiene una etiqueta vacía`);
    assert.ok(!label.includes("_"), `${type} imprime snake_case: ${label}`);
    assert.ok(
      !/\b(config|transaction|delete|branch|audit|update|void|rate|movement|session)\b/i.test(label),
      `${type} imprime inglés: ${label}`,
    );
  }
});

test("the configuration actions the owner saw are named in Spanish", () => {
  assert.equal(describeOfflineQueueType("store_config"), "Configuración de la empresa");
  assert.equal(describeOfflineQueueType("receipt_config"), "Configuración del ticket");
  assert.equal(describeOfflineQueueType("catalog_config"), "Configuración del catálogo");
  assert.equal(describeOfflineQueueType("currency_rate"), "Tasa de cambio");
  assert.equal(describeOfflineQueueType("device_access_revoke"), "Revocar enlace de acceso");
  assert.equal(describeOfflineQueueType("invitation_revoke"), "Revocar invitación");
  assert.equal(describeOfflineQueueType("branch_delete"), "Borrado de sucursal");
  assert.equal(describeOfflineQueueType("bank_card_delete"), "Borrado de cuenta o tarjeta");
});

test("an unknown type from an older bundle still gets a readable label", () => {
  assert.equal(describeOfflineQueueType("unknown_type"), "Unknown type");
  assert.equal(describeOfflineQueueType(""), "Operación");
});

test("no invisible flag can freeze the automatic sync of the queue", () => {
  for (const path of [
    "src/services/offlineSync.ts",
    "src/services/supabaseSync/pull.ts",
    "src/types.ts",
    "src/store/useStore.ts",
    "src/store/actions/authActions.ts",
  ]) {
    assert.ok(!source(path).includes("manualOfflineSync"), `${path} sigue leyendo la bandera que congela la cola`);
  }
});

test("the online drain triggers do not gate on any manual-sync flag", () => {
  const engine = source("src/services/offlineSync.ts");
  assert.ok(/const handleOnline = async \(\)/.test(engine), "debe existir el disparador al volver la conexión");
  assert.ok(!/isManualOfflineSyncEnabled/.test(engine), "el motor no puede volver a bloquearse solo");
});
