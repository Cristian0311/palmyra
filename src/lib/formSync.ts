/**
 * Sincronización formulario ↔ store.
 *
 * Módulo puro (sin React ni red) para poder probarlo con `node:test`. Nace del
 * bug de Configuración → Empresa: el formulario copiaba el `storeConfig` del
 * store en cada referencia nueva, y los pulls/realtime del store emiten objetos
 * nuevos aunque el contenido no cambie. Resultado: al escribir en Dirección o
 * Teléfono el estado local se pisaba y la edición desaparecía.
 */

export type ConfigSyncSnapshot<T> = {
  /** Valor del store que el formulario refleja en este momento. */
  synced: T;
  /**
   * Referencia del store sobre la cual hay una edición local sin guardar.
   * null = el formulario está limpio y puede seguir al store.
   */
  dirtyBaseline: T | null;
};

export type ConfigSyncDecision<T> = {
  adopt: boolean;
  snapshot: ConfigSyncSnapshot<T>;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  for (const key of keys) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/** Comparación profunda estructural: dos referencias nuevas con lo mismo son iguales. */
export function isSameConfig<T>(a: T, b: T): boolean {
  return sameValue(a, b);
}

/**
 * Decide si el formulario debe adoptar el valor del store.
 *
 * - Primera hidratación (carga inicial o cambio de empresa): siempre se adopta.
 * - Sin cambios sin guardar: se adopta solo si el contenido realmente cambió,
 *   de modo que una referencia nueva equivalente no reinicia el formulario.
 * - Con cambios sin guardar: nunca se pisa al usuario. Solo se adopta cuando el
 *   store vale ya exactamente lo que muestra el formulario (por ejemplo, después
 *   de guardar), porque en ese caso la adopción no toca ni un carácter.
 */
export function shouldAdoptStoreConfig<T>(local: T, store: T, lastSynced: T | null): boolean {
  if (lastSynced === null) return true;
  if (isSameConfig(local, lastSynced)) return !isSameConfig(store, lastSynced);
  return isSameConfig(store, local);
}

/**
 * Misma decisión que `shouldAdoptStoreConfig` y además la snapshot siguiente.
 * El llamador pasa la snapshot que guardó en el último render.
 */
export function resolveConfigSync<T>(
  snapshot: ConfigSyncSnapshot<T> | null,
  local: T,
  store: T,
): ConfigSyncDecision<T> {
  const adopt = shouldAdoptStoreConfig(local, store, snapshot?.synced ?? null);
  if (!adopt) return { adopt: false, snapshot };
  // Al adoptar, el formulario queda espejo del store y deja de tener edición pendiente.
  return { adopt: true, snapshot: { synced: store, dirtyBaseline: null } };
}
