/**
 * Registro visible de operaciones que el hub rechazó.
 *
 * El bucle de salida congela el cursor ante un rechazo para no perder trabajo,
 * pero eso, sin más, deja al cajero con una cola que no avanza y sin saber por
 * qué. Este registro guarda un resumen por `actionId` (tabla, filas afectadas,
 * código del hub y número de intentos) para que la UI lo muestre y permita
 * descartarlo cuando el conflicto ya se resolvió a mano.
 *
 * Es deliberadamente tolerante: nunca lanza hacia afuera. Si el almacén falla
 * (cuota, modo privado) se conserva una copia en memoria y la cola sigue
 * funcionando igual; solo se pierde la visibilidad tras reiniciar.
 */
import type { HubOperation } from "./opsClient";

export const HUB_CONFLICTS_KEY = "palmyra_hub_conflicts_v1";
/** Tope de conflictos conservados; los más antiguos se descartan. */
export const HUB_CONFLICT_LIMIT = 200;
/** Evento de ventana que la UI escucha para refrescar el panel. */
export const HUB_CONFLICT_EVENT = "palmyra:hub-conflict";

const DEFAULT_CODE = "rejected";

/** Almacén mínimo de clave/valor; `localStorage` adaptado o uno en memoria. */
export interface HubConflictStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface HubConflict {
  actionId: string;
  table: string;
  /** Filas implicadas: ids propuestos y ids borrados. */
  rowIds: string[];
  /** Código del hub (`version_conflict`, `append_only`…) o local. */
  code: string;
  /** Instante del último rechazo, en ms. */
  at: number;
  /** Veces que el hub rechazó esta misma operación. */
  attempts: number;
}

export interface HubConflictInput {
  actionId: string;
  table?: string;
  rowIds?: readonly string[];
  code?: string;
  at?: number;
}

export interface HubConflictSummary {
  total: number;
  byCode: Record<string, number>;
  lastAt: number | null;
}

/* ------------------------------------------------------------------ */
/* Almacén                                                             */
/* ------------------------------------------------------------------ */

let explicitStore: HubConflictStore | null = null;
let browserStoreCache: HubConflictStore | null = null;
let browserStoreResolved = false;
/** Respaldo en memoria; también la fuente cuando el almacén es inerte. */
let memory: HubConflict[] = [];

function createBrowserStore(): HubConflictStore | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return null;
    storage.getItem(HUB_CONFLICTS_KEY);
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      delete: (key) => storage.removeItem(key)
    };
  } catch {
    return null;
  }
}

function activeStore(): HubConflictStore | null {
  if (explicitStore) return explicitStore;
  if (!browserStoreResolved) {
    browserStoreCache = createBrowserStore();
    browserStoreResolved = true;
  }
  return browserStoreCache;
}

/** Almacén volátil para pruebas y respaldo sin `localStorage`. */
export function createMemoryConflictStore(): HubConflictStore {
  const data = new Map<string, string>();
  return {
    get(key: string): string | null {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    set(key: string, value: string): void {
      data.set(key, value);
    },
    delete(key: string): void {
      data.delete(key);
    }
  };
}

/** Sustituye el almacén; `null` restaura el `localStorage` del navegador. */
export function configureHubConflictStore(store: HubConflictStore | null): void {
  explicitStore = store;
  memory = [];
}

/** Deja el registro vacío conservando el almacén configurado. */
export function resetHubConflictsForTests(): void {
  memory = [];
  const store = activeStore();
  if (!store) return;
  try {
    store.delete(HUB_CONFLICTS_KEY);
  } catch {
    // El almacén roto no impide vaciar la copia en memoria.
  }
}

/* ------------------------------------------------------------------ */
/* Serialización                                                       */
/* ------------------------------------------------------------------ */

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRowIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const id = text(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function sanitizeConflict(raw: unknown): HubConflict | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<HubConflict>;
  const actionId = text(candidate.actionId);
  if (!actionId) return null;
  const at = typeof candidate.at === "number" && Number.isFinite(candidate.at) ? candidate.at : 0;
  const attempts =
    typeof candidate.attempts === "number" && Number.isFinite(candidate.attempts) && candidate.attempts >= 1
      ? Math.floor(candidate.attempts)
      : 1;
  return {
    actionId,
    table: text(candidate.table),
    rowIds: normalizeRowIds(candidate.rowIds),
    code: text(candidate.code) || DEFAULT_CODE,
    at: Math.max(0, Math.floor(at)),
    attempts
  };
}

function readConflicts(): HubConflict[] {
  const store = activeStore();
  if (!store) return memory.map((item) => ({ ...item, rowIds: item.rowIds.slice() }));
  let raw: string | null = null;
  try {
    raw = store.get(HUB_CONFLICTS_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return memory.map((item) => ({ ...item, rowIds: item.rowIds.slice() }));
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) return memory.map((item) => ({ ...item, rowIds: item.rowIds.slice() }));
  const conflicts: HubConflict[] = [];
  for (const entry of parsed) {
    const conflict = sanitizeConflict(entry);
    if (conflict) conflicts.push(conflict);
  }
  memory = conflicts.map((item) => ({ ...item, rowIds: item.rowIds.slice() }));
  return conflicts;
}

function writeConflicts(conflicts: HubConflict[]): void {
  memory = conflicts.map((item) => ({ ...item, rowIds: item.rowIds.slice() }));
  const store = activeStore();
  if (!store) return;
  try {
    store.set(HUB_CONFLICTS_KEY, JSON.stringify(memory));
  } catch {
    // Cuota o modo privado: se conserva la copia en memoria.
  }
}

function cloneConflict(conflict: HubConflict): HubConflict {
  return { ...conflict, rowIds: conflict.rowIds.slice() };
}

/**
 * Avisa a la UI. Solo ocurre si hay `window` de verdad (navegador o renderer);
 * fuera de él no hay nadie escuchando y el fallo se ignora.
 */
function emitConflict(conflict: HubConflict): void {
  try {
    const scope = globalThis as { window?: unknown; CustomEvent?: unknown };
    const target = scope.window as { dispatchEvent?: unknown } | undefined;
    if (!target || typeof target.dispatchEvent !== "function") return;
    const EventCtor = scope.CustomEvent as
      | (new (type: string, init?: { detail?: unknown }) => Event)
      | undefined;
    if (typeof EventCtor !== "function") return;
    target.dispatchEvent(new EventCtor(HUB_CONFLICT_EVENT, { detail: cloneConflict(conflict) }));
  } catch {
    // Un evento no puede romper el bucle de salida.
  }
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/**
 * Anota (o refresca) el rechazo de una operación. Devuelve el conflicto
 * guardado o `null` si la entrada no tenía `actionId`.
 */
export function recordHubConflict(input: HubConflictInput): HubConflict | null {
  try {
    const actionId = text(input?.actionId);
    if (!actionId) return null;
    const table = text(input?.table);
    const code = text(input?.code) || DEFAULT_CODE;
    const at =
      typeof input?.at === "number" && Number.isFinite(input.at) ? Math.max(0, Math.floor(input.at)) : Date.now();
    const rowIds = normalizeRowIds(input?.rowIds);

    const conflicts = readConflicts();
    const index = conflicts.findIndex((item) => item.actionId === actionId);
    let conflict: HubConflict;
    if (index >= 0) {
      const previous = conflicts[index];
      // Se mueve al final: el tope descarta por antigüedad de actividad.
      conflicts.splice(index, 1);
      conflict = {
        actionId,
        table: table || previous.table,
        rowIds: normalizeRowIds([...(previous.rowIds ?? []), ...rowIds]),
        code,
        at,
        attempts: previous.attempts + 1
      };
    } else {
      conflict = { actionId, table, rowIds, code, at, attempts: 1 };
    }
    conflicts.push(conflict);
    while (conflicts.length > HUB_CONFLICT_LIMIT) conflicts.shift();
    writeConflicts(conflicts);
    emitConflict(conflict);
    return cloneConflict(conflict);
  } catch {
    return null;
  }
}

/**
 * Traduce los `actionId` rechazados de un lote a conflictos con su tabla y sus
 * filas. Un acción que ya no esté en el lote (por ejemplo tras reiniciar) se
 * registra igual: es preferible verla sin detalle que no verla.
 */
export function recordHubConflictForOps(
  ops: readonly HubOperation[],
  rejectedActionIds: readonly string[],
  code?: string
): HubConflict[] {
  const recorded: HubConflict[] = [];
  try {
    if (!Array.isArray(rejectedActionIds) || rejectedActionIds.length === 0) return recorded;
    const byAction = new Map<string, HubOperation>();
    for (const op of Array.isArray(ops) ? ops : []) {
      const actionId = text(op?.actionId);
      if (actionId) byAction.set(actionId, op);
    }
    for (const actionId of rejectedActionIds) {
      const op = byAction.get(text(actionId));
      const rowIds: string[] = [];
      for (const row of op?.rows ?? []) {
        const id = text((row as { id?: unknown })?.id);
        if (id) rowIds.push(id);
      }
      for (const id of op?.deletes ?? []) {
        const clean = text(id);
        if (clean) rowIds.push(clean);
      }
      const conflict = recordHubConflict({
        actionId,
        table: op?.table ? String(op.table) : "",
        rowIds,
        code
      });
      if (conflict) recorded.push(conflict);
    }
  } catch {
    // El registro es informativo: jamás interrumpe el envío.
  }
  return recorded;
}

/** Conflictos vigentes, del más reciente al más antiguo (para la UI). */
export function listHubConflicts(): HubConflict[] {
  try {
    return readConflicts().reverse().map(cloneConflict);
  } catch {
    return [];
  }
}

/** Quita el aviso de un conflicto ya resuelto a mano. */
export function dismissHubConflict(actionId: string): boolean {
  try {
    const id = text(actionId);
    if (!id) return false;
    const conflicts = readConflicts();
    const remaining = conflicts.filter((item) => item.actionId !== id);
    if (remaining.length === conflicts.length) return false;
    writeConflicts(remaining);
    return true;
  } catch {
    return false;
  }
}

/**
 * Limpia los conflictos de operaciones que el hub ya acusó (aceptadas o
 * duplicadas). Devuelve cuántos avisos se quitaron.
 */
export function clearResolvedHubConflicts(acceptedActionIds: readonly string[]): number {
  try {
    if (!Array.isArray(acceptedActionIds) || acceptedActionIds.length === 0) return 0;
    const resolved = new Set<string>();
    for (const actionId of acceptedActionIds) {
      const id = text(actionId);
      if (id) resolved.add(id);
    }
    if (resolved.size === 0) return 0;
    const conflicts = readConflicts();
    const remaining = conflicts.filter((item) => !resolved.has(item.actionId));
    const removed = conflicts.length - remaining.length;
    if (removed > 0) writeConflicts(remaining);
    return removed;
  } catch {
    return 0;
  }
}

/** Resumen para el indicador de la barra o del panel de salud. */
export function conflictSummary(): HubConflictSummary {
  const summary: HubConflictSummary = { total: 0, byCode: {}, lastAt: null };
  try {
    const conflicts = readConflicts();
    summary.total = conflicts.length;
    for (const conflict of conflicts) {
      summary.byCode[conflict.code] = (summary.byCode[conflict.code] ?? 0) + 1;
      if (summary.lastAt === null || conflict.at > summary.lastAt) summary.lastAt = conflict.at;
    }
  } catch {
    // Un resumen ilegible se devuelve vacío.
  }
  return summary;
}
