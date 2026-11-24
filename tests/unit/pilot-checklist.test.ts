import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PILOT_CHECKLIST_ITEMS,
  PILOT_CHECKLIST_STORAGE_KEY,
  checklistPercent,
  pilotChecklistStorageKey,
  readPilotChecklist,
  resetPilotChecklist,
  sanitizePilotChecklist,
  togglePilotChecklistItem,
  writePilotChecklist,
  type PilotChecklistItemId,
  type PilotChecklistStorage
} from "../../src/components/system/PilotChecklist.tsx";

/**
 * Checklist del piloto F7-D: identificadores, progreso persistente, limpieza de
 * almacenamiento corrupto, reinicio y coherencia con el manual de campo.
 * Todo con un almacén en memoria: nunca toca el localStorage real.
 */

interface MemoryStorage extends PilotChecklistStorage {
  raw(key?: string): string | null;
  keys(): string[];
}

function createStorage(seed: Record<string, string> = {}): MemoryStorage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    raw(key: string = PILOT_CHECKLIST_STORAGE_KEY) {
      return map.get(key) ?? null;
    },
    keys() {
      return [...map.keys()];
    }
  };
}

const EXPECTED_IDS: PilotChecklistItemId[] = [
  "instalado",
  "emparejado",
  "respaldo-local",
  "respaldo-nube",
  "restauracion-prueba",
  "update-usb",
  "plan-fallo-hub"
];

test("la lista tiene exactamente los 7 pasos del piloto, sin ids repetidos", () => {
  assert.equal(PILOT_CHECKLIST_ITEMS.length, 7);
  const ids = PILOT_CHECKLIST_ITEMS.map((item) => item.id);
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of PILOT_CHECKLIST_ITEMS) {
    assert.ok(item.title.trim().length > 0, `${item.id} sin título`);
    assert.ok(item.detail.trim().length > 0, `${item.id} sin detalle`);
    assert.ok(item.manualSection.trim().length > 0, `${item.id} sin sección del manual`);
    assert.ok(/^[a-z0-9-]+$/.test(item.manualAnchor), `${item.id} con ancla inválida`);
  }
  // Dos pasos de respaldo comparten la misma sección del manual: el ancla se
  // repite a propósito, pero todas deben existir en el manual.
  const manualAnchors = new Set([
    "antes-de-empezar",
    "instalar-en-pc",
    "instalar-en-android",
    "emparejar-equipos-por-qr-y-manual",
    "vender-sin-internet",
    "respaldar",
    "restaurar",
    "actualizar",
    "si-el-hub-falla",
    "metricas-del-piloto-y-que-reportar",
    "contacto-y-canales-oficiales"
  ]);
  for (const item of PILOT_CHECKLIST_ITEMS) {
    assert.ok(manualAnchors.has(item.manualAnchor), `${item.id} apunta a un ancla inexistente`);
  }
});

test("la clave se guarda por usuario/empresa cuando hay ámbito y global cuando no lo hay", () => {
  assert.equal(pilotChecklistStorageKey(), PILOT_CHECKLIST_STORAGE_KEY);
  assert.equal(pilotChecklistStorageKey(null), PILOT_CHECKLIST_STORAGE_KEY);
  assert.equal(
    pilotChecklistStorageKey("user-1__company-1"),
    `${PILOT_CHECKLIST_STORAGE_KEY}__user-1__company-1`
  );
});

test("las marcas persisten y se leen en una sesión posterior", () => {
  const storage = createStorage();
  writePilotChecklist(["respaldo-local", "emparejado", "plan-fallo-hub"], storage);
  const raw = storage.raw();
  assert.ok(raw);
  const parsed = JSON.parse(raw as string);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.done, ["emparejado", "respaldo-local", "plan-fallo-hub"]);

  // El orden guardado es el canónico de la lista, no el de escritura.
  assert.deepEqual(readPilotChecklist(storage), ["emparejado", "respaldo-local", "plan-fallo-hub"]);

  // Otra instancia del almacén con el mismo contenido se comporta igual.
  const reopened = createStorage({ [PILOT_CHECKLIST_STORAGE_KEY]: raw as string });
  assert.deepEqual(readPilotChecklist(reopened), ["emparejado", "respaldo-local", "plan-fallo-hub"]);
});

test("cada ámbito guarda su propia lista y no contamina la global", () => {
  const storage = createStorage();
  const scopedKey = pilotChecklistStorageKey("user-1__company-1");
  writePilotChecklist(["instalado"], storage);
  writePilotChecklist(["respaldo-nube"], storage, scopedKey);
  assert.deepEqual(readPilotChecklist(storage), ["instalado"]);
  assert.deepEqual(readPilotChecklist(storage, scopedKey), ["respaldo-nube"]);
  assert.deepEqual(storage.keys().sort(), [PILOT_CHECKLIST_STORAGE_KEY, scopedKey].sort());
});

test("el almacenamiento corrupto o manipulado se sanea sin romper la lista", () => {
  assert.deepEqual(sanitizePilotChecklist(null), []);
  assert.deepEqual(sanitizePilotChecklist(""), []);
  assert.deepEqual(sanitizePilotChecklist("no es json"), []);
  assert.deepEqual(sanitizePilotChecklist("123"), []);
  assert.deepEqual(sanitizePilotChecklist('"instalado"'), []);
  assert.deepEqual(sanitizePilotChecklist('{"version":1,"done":"instalado"}'), []);
  assert.deepEqual(sanitizePilotChecklist("[]"), []);
  assert.deepEqual(
    sanitizePilotChecklist('{"version":1,"done":["emparejado","emparejado","inventado",42,null]}'),
    ["emparejado"]
  );
  // Formato heredado: un arreglo plano también se acepta.
  assert.deepEqual(sanitizePilotChecklist('["respaldo-local"]'), ["respaldo-local"]);
  // Un valor enorme no es un estado legítimo.
  assert.deepEqual(sanitizePilotChecklist("x".repeat(5000)), []);
  // Una lista saneada no inventa pasos.
  assert.deepEqual(sanitizePilotChecklist('{"done":["plan-fallo-hub"]}'), ["plan-fallo-hub"]);
});

test("readPilotChecklist sanea lo que encuentra guardado", () => {
  const broken = createStorage({ [PILOT_CHECKLIST_STORAGE_KEY]: "{roto" });
  assert.deepEqual(readPilotChecklist(broken), []);
  const mixed = createStorage({
    [PILOT_CHECKLIST_STORAGE_KEY]: '{"version":1,"done":["update-usb","update-usb","otro"]}'
  });
  assert.deepEqual(readPilotChecklist(mixed), ["update-usb"]);
});

test("el porcentaje avanza con pasos únicos y no con repeticiones", () => {
  assert.equal(checklistPercent([]), 0);
  assert.equal(checklistPercent(["instalado", "emparejado", "respaldo-local"]), 43);
  assert.equal(
    checklistPercent(EXPECTED_IDS),
    100
  );
  assert.equal(checklistPercent(["instalado", "instalado"]), 14);
  assert.equal(checklistPercent(["instalado", "desconocido"]), 14);
  assert.equal(checklistPercent(["a", "b", "c"]), 0);
});

test("alternar un paso lo agrega o lo quita manteniendo el orden canónico", () => {
  const first = togglePilotChecklistItem([], "respaldo-nube");
  assert.deepEqual(first, ["respaldo-nube"]);
  const both = togglePilotChecklistItem(first, "instalado");
  assert.deepEqual(both, ["instalado", "respaldo-nube"]);
  assert.deepEqual(togglePilotChecklistItem(both, "respaldo-nube"), ["instalado"]);
});

test("reiniciar borra las marcas (con removeItem o sobrescribiendo el estado)", () => {
  const storage = createStorage();
  writePilotChecklist(["instalado", "emparejado"], storage);
  resetPilotChecklist(storage);
  assert.equal(storage.raw(), null);
  assert.deepEqual(readPilotChecklist(storage), []);

  const noRemove: PilotChecklistStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("sin almacenamiento real");
    }
  };
  assert.doesNotThrow(() => resetPilotChecklist(noRemove));

  const overwriting = createStorage();
  const key = pilotChecklistStorageKey("u__c");
  writePilotChecklist(["instalado"], overwriting, key);
  resetPilotChecklist({ ...overwriting, removeItem: undefined }, key);
  assert.deepEqual(readPilotChecklist(overwriting, key), []);
  assert.notEqual(overwriting.raw(key), null);
});

test("el manual de campo existe y conserva las secciones que enlaza la lista", () => {
  const manual = readFileSync("docs/PILOTO_MANUAL.md", "utf8");
  const requiredHeadings = [
    "## Antes de empezar",
    "## Instalar en PC",
    "## Instalar en Android",
    "## Emparejar equipos por QR y manual",
    "## Vender sin internet",
    "## Respaldar",
    "## Restaurar",
    "## Actualizar",
    "## Si el hub falla",
    "## Métricas del piloto y qué reportar",
    "## Contacto y canales oficiales"
  ];
  for (const heading of requiredHeadings) {
    assert.ok(manual.includes(heading), `falta la sección ${heading}`);
  }
  // Nombres reales de la interfaz que el manual debe respetar.
  for (const label of [
    "Configuración → Red local",
    "Respaldo en la nube",
    "Diagnóstico de instalación",
    "Actualizaciones firmadas",
    "Actualizar desde archivo"
  ]) {
    assert.ok(manual.includes(label), `el manual no menciona ${label}`);
  }
  // Sin enlaces internos muertos ni secretos embebidos.
  assert.equal(manual.includes("]("), false);
  assert.equal(/service_role|SUPABASE_SERVICE|ELTOQUE_API_TOKEN/i.test(manual), false);
});
