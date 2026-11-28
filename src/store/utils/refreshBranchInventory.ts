import { pullBranchInventoryFromSupabase } from '../../services/supabaseSync';

type InventoryKeyed = { productId: string; branchId: string; variantLabel?: string };

/** Fila de stock = producto + almacén + variante. */
const inventoryKeyOf = (item: InventoryKeyed) =>
  `${item.productId}:${item.branchId}:${item.variantLabel || ''}`;

/**
 * Refrescos que se solapan sobre el mismo conjunto de almacenes comparten UNA
 * lectura y un solo `set`. Dos lecturas cruzadas escribirían la instantánea más
 * vieja después de la más nueva (p. ej. la conciliación de una venta anulada y
 * la de una recepción de traslado sobre el mismo almacén).
 */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Reemplaza las filas de los almacenes pedidos por las canónicas de la nube.
 * Las de otros almacenes se conservan tal cual.
 *
 * Ninguna fila local se protege: `palmyra_receive_transfer` y
 * `palmyra_cancel_transfer` mueven `stock_balances` dentro de la misma
 * transacción del RPC, así que cuando la llamada devuelve éxito la nube ya trae
 * el asiento hecho. Conservar el número local en su lugar descartaría el
 * movimiento concurrente de otro equipo sobre ese producto.
 */
export async function refreshInventoryBranchesFromSupabase(
  set: (partial: any) => void,
  get: () => { inventory?: InventoryKeyed[] },
  branchIds: string[]
): Promise<boolean> {
  const ids = Array.from(new Set(branchIds.filter(Boolean)));
  if (!ids.length) return true;
  const flightKey = ids.slice().sort().join('|');
  const pending = inFlight.get(flightKey);
  if (pending) return pending;
  const task = (async (): Promise<boolean> => {
    try {
      const results = await Promise.all(ids.map(id => pullBranchInventoryFromSupabase(id)));
      if (results.some(result => !result.success)) return false;
      const byKey = new Map<string, InventoryKeyed>();
      (get().inventory || []).forEach(item => {
        if (!ids.includes(item.branchId)) byKey.set(inventoryKeyOf(item), item);
      });
      for (const result of results) for (const item of result.inventory) {
        byKey.set(inventoryKeyOf(item), item);
      }
      set({ inventory: Array.from(byKey.values()) });
      return true;
    } catch {
      return false;
    }
  })();
  inFlight.set(flightKey, task);
  const release = (): void => {
    if (inFlight.get(flightKey) === task) inFlight.delete(flightKey);
  };
  void task.then(release, release);
  return task;
}
