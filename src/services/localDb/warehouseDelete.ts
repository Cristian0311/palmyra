/**
 * Borrado local de un almacén dado de baja.
 *
 * La baja remota es lógica (`warehouses.active = false`), pero en el dispositivo
 * el almacén debe DESAPARECER: si solo se quita del estado en memoria, la próxima
 * hidratación lo devuelve. Estos son los caminos que lo rehidrataban y su cura:
 *
 *  1. `hydrateFromLocalDb` → lee `warehouses` con `includeDeleted: true` y toma
 *     las filas vivas (`liveRows`). Con el tombstone (`deleted_at`) la fila sale
 *     de `liveRows` y entra en `snapshot.deleted`, que el puente proyecta como
 *     borrado. Se prefiere la lápida al borrado seco porque el journal local la
 *     sube al hub y el materializador la traduce a `active = false`.
 *  2. El puente del hub (`applyLocalSnapshotToStore`) → misma fuente, misma cura.
 *  3. El JSON persistido por Zustand → lo reescribe el propio `persist` cuando
 *     `deleteBranch` saca la rama del estado; no se toca ese snapshot a mano.
 *     La capa en sombra (`legacyShadow`) poda la fila en su siguiente pasada
 *     porque el id desaparece del JSON, así que aquí solo se adelanta.
 *
 * Todo es best-effort: un fallo del almacén local no puede convertir una baja
 * correcta en un error visible, pero SÍ se reporta para no afirmar que se borró.
 */
import { readLocalStateStorage } from "../localStateStorage";
import { getRuntimeDriver } from "./runtimeDriver";
import type { LocalDbDriver, LocalRow } from "./contract";

export interface WarehouseLocalPurgeResult {
  /** true si la fila quedó fuera del almacén local (o nunca estuvo). */
  localDb: boolean;
  /** true si el JSON persistido ya no contiene esa rama. */
  persistedJson: boolean;
  /** Diagnóstico legible cuando alguna de las dos persistencias falló. */
  detail?: string;
}

/** Se puede inyectar el driver para probar el tombstone sin abrir IndexedDB. */
export interface RemoveWarehouseOptions {
  companyId?: string | null;
  driver?: LocalDbDriver | null;
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Quita el almacén del almacén local respetando el aislamiento por empresa:
 * una fila de otra compañía nunca se toca, aunque alguien pase su id.
 */
async function tombstoneWarehouseRow(
  driver: LocalDbDriver,
  companyId: string,
  warehouseId: string
): Promise<boolean> {
  await driver.ready();
  const row = await driver.get<LocalRow>("warehouses", warehouseId);
  if (!row) return true; // No existe: ya está fuera de cualquier hidratación.
  if (normalizeId(row.company_id) !== companyId) return true;
  if (row.deleted_at) return true;
  const at = new Date().toISOString();
  const version = Number(row.version);
  await driver.put("warehouses", [
    {
      ...row,
      version: Number.isFinite(version) && version > 0 ? version + 1 : 1,
      updated_at: at,
      origin_device: String(row.origin_device || "local"),
      deleted_at: at,
    },
  ]);
  return true;
}

/** Comprueba —sin reescribirlo— que el JSON persistido ya no menciona el almacén. */
async function persistedBranchGone(warehouseId: string): Promise<boolean> {
  try {
    const raw = await readLocalStateStorage();
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const branches = parsed?.state?.branches;
    if (!Array.isArray(branches)) return true;
    return !branches.some(branch => normalizeId((branch as Record<string, unknown>)?.id) === warehouseId);
  } catch (error) {
    console.warn("[PALMYRA] No se pudo comprobar el JSON persistido tras la baja:", error);
    return false;
  }
}

/**
 * Borra el almacén de toda persistencia local. Nunca lanza: devuelve qué se
 * consiguió para que el llamador pueda dejar de afirmar éxitos falsos.
 */
export async function removeWarehouseFromLocalDb(
  warehouseId: string,
  options: RemoveWarehouseOptions = {}
): Promise<WarehouseLocalPurgeResult> {
  const id = normalizeId(warehouseId);
  if (!id) return { localDb: false, persistedJson: false, detail: "Almacén sin identificador." };

  let companyId = normalizeId(options.companyId);
  let localDb = false;
  let detail: string | undefined;

  try {
    const driver = options.driver || (await getRuntimeDriver());
    if (!companyId) {
      const rows = await driver.query<LocalRow>({
        table: "warehouses",
        where: [{ field: "id", op: "eq", value: id }],
        includeDeleted: true,
        limit: 1,
      });
      companyId = normalizeId(rows[0]?.company_id);
    }
    if (companyId) {
      localDb = await tombstoneWarehouseRow(driver, companyId, id);
    } else {
      // Sin empresa activa no hay forma segura de tocar el almacén local, pero
      // tampoco riesgo: la hidratación trabaja por alcance y no encontrará fila.
      localDb = true;
    }
  } catch (error) {
    detail = `No se pudo borrar el almacén del almacén local: ${String((error as any)?.message || error)}`;
    console.warn("[PALMYRA]", detail);
  }

  const persistedJson = await persistedBranchGone(id);
  if (!persistedJson) {
    // El `set()` de `deleteBranch` ya sacó la rama del estado, pero Zustand puede
    // estar escribiendo el snapshot con retardo. Se comprueba otra vez aparte: si
    // el JSON sigue mencionando el almacén, la capa en sombra podría recrear la
    // fila, así que se avisa en lugar de afirmar que ya está borrado.
    void recheckPersistedBranch(id, detail);
    if (!detail) {
      detail = "El almacén aún aparece en el estado guardado del dispositivo; se confirmará en unos segundos.";
    }
  }
  return { localDb, persistedJson, ...(detail ? { detail } : {}) };
}

/** Revisa el JSON persistido fuera del camino crítico y avisa si sigue ahí. */
async function recheckPersistedBranch(warehouseId: string, alreadyReported?: string): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 4000));
  if (await persistedBranchGone(warehouseId)) return;
  const detail =
    alreadyReported ||
    "El almacén sigue en el estado guardado del dispositivo; revisa la sincronización.";
  console.warn(`[PALMYRA] Almacén ${warehouseId}: ${detail}`);
}
