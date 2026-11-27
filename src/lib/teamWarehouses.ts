/**
 * Equipo · almacenes permitidos de un trabajador.
 *
 * Un almacén registrado en la empresa está operativo por definición: no existe
 * el estado «inactivo» para asignar personal. El editor lista todos los
 * almacenes de la empresa en una rejilla con scroll propio, y la fila del
 * listado resume los asignados en chips compactos con «+N» cuando hay más de
 * los que caben.
 */

/** Chips compactos visibles en la fila del listado de trabajadores. */
export const TEAM_ROSTER_CHIP_LIMIT = 3;

export interface WarehouseChip {
  id: string;
  name: string;
  /** true para el almacén principal (primero asignado): siempre va inline. */
  isMain: boolean;
  /** Key única para React: `id` puede venir vacío o repetido en datos sucios. */
  key: string;
}

export interface WarehousePlan {
  /** Almacenes que se renderizan como tarjeta/chip. */
  visible: WarehouseChip[];
  /** Almacenes agrupados en el botón «+N». */
  hidden: WarehouseChip[];
  hiddenCount: number;
  showToggle: boolean;
  /** Resumen compacto tipo «Principal +2 más» para la burbuja de la fila. */
  summaryLabel: string;
}

type NamedWarehouse = { id?: string | null; name?: string | null };

/**
 * Los almacenes dados de baja o borrados siguen en `employee.warehouse_ids`.
 * Si no resolvemos su nombre, el chip mostraría un `undefined` ruidoso: se
 * etiquetan como retirados en lugar de ocultarlos (ocultarlos haría creer que
 * el trabajador tiene menos acceso del real).
 */
export const RETIRED_LABEL = 'Almacén retirado';

function normalizeChip(warehouse: NamedWarehouse, index: number): WarehouseChip {
  const raw = String(warehouse?.name ?? '').trim();
  const id = String(warehouse?.id ?? '').trim();
  return {
    id,
    // Un id vacío o repetido rompería las keys de React: se garantiza única.
    key: id ? `${id}-${index}` : `warehouse-${index}`,
    name: raw || RETIRED_LABEL,
    isMain: index === 0,
  };
}

export function planTeamWarehouses(
  warehouses: readonly NamedWarehouse[] | null | undefined,
  options: { inlineLimit?: number } = {}
): WarehousePlan {
  const inlineLimit = Math.max(1, Number(options.inlineLimit) || TEAM_ROSTER_CHIP_LIMIT);
  const chips = (warehouses || []).map(normalizeChip);
  if (chips.length <= inlineLimit) {
    return {
      visible: chips,
      hidden: [],
      hiddenCount: 0,
      showToggle: false,
      summaryLabel: '',
    };
  }
  // El principal (`form.warehouseIds[0]`, el que recibe el default_warehouse_id)
  // nunca se colapsa: es el que el cajero usa por defecto.
  const main = chips.filter(chip => chip.isMain);
  const rest = chips.filter(chip => !chip.isMain);
  const visible = [...main, ...rest.slice(0, Math.max(0, inlineLimit - main.length))];
  const hidden = chips.filter(chip => !visible.includes(chip));
  return {
    visible,
    hidden,
    hiddenCount: hidden.length,
    showToggle: true,
    summaryLabel: `+${hidden.length} más`,
  };
}

/** Texto accesible del contenedor de almacenes de la fila del equipo. */
export function formatTeamWarehouseNames(names: readonly string[] | null | undefined): string {
  const clean = (names || []).map(name => String(name || '').trim()).filter(Boolean);
  return clean.length ? clean.join(', ') : 'Sin almacén';
}

type CompanyWarehouse = { id?: string | null; name?: string | null };

export interface TeamWarehouseOption {
  id: string;
  name: string;
  /** Key única para React cuando hay ids vacíos o repetidos en datos sucios. */
  key: string;
  /** true cuando figura en el alcance actual del trabajador. */
  assigned: boolean;
}

export interface TeamWarehouseSelection {
  /** Todos los almacenes de la empresa; los ya asignados van primero. */
  selectable: TeamWarehouseOption[];
  /** Asignados que ya no existen en la empresa (borrados u ocultos). */
  retired: TeamWarehouseOption[];
}

/**
 * Cruza los almacenes de la empresa con el alcance guardado del trabajador.
 *
 * Todos los almacenes registrados son asignables: un negocio que dio de alta un
 * almacén lo tiene operativo. Sólo se separan los ids asignados que ya no
 * existen en la empresa para explicarlos y retirarlos al guardar.
 */
export function resolveTeamWarehouseSelection(
  warehouses: readonly CompanyWarehouse[] | null | undefined,
  assignedIds: readonly string[] | null | undefined
): TeamWarehouseSelection {
  const byId = new Map<string, Required<Pick<CompanyWarehouse, 'id' | 'name'>>>();
  for (const warehouse of warehouses || []) {
    const id = String(warehouse?.id ?? '').trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: String(warehouse?.name ?? '').trim() || RETIRED_LABEL
    });
  }

  const selectable: TeamWarehouseOption[] = [];
  const retired: TeamWarehouseOption[] = [];
  const seen = new Set<string>();

  for (const raw of assignedIds || []) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const match = byId.get(id);
    const option: TeamWarehouseOption = {
      id,
      name: match?.name || RETIRED_LABEL,
      key: `assigned-${id}`,
      assigned: true
    };
    if (match) selectable.push(option);
    else retired.push(option);
  }

  for (const warehouse of byId.values()) {
    if (seen.has(warehouse.id)) continue;
    selectable.push({ id: warehouse.id, name: warehouse.name, key: `available-${warehouse.id}`, assigned: false });
  }

  return { selectable, retired };
}

/** Ids que se pueden enviar a la RPC: la selección del formulario limitada a los
 * almacenes existentes. Preserva el orden (el primero sigue siendo el principal). */
export function pickAssignableWarehouseIds(
  selection: TeamWarehouseSelection | null | undefined,
  ids: readonly string[] | null | undefined
): string[] {
  const allowed = new Set((selection?.selectable || []).map(option => option.id));
  const result: string[] = [];
  for (const raw of ids || []) {
    const id = String(raw ?? '').trim();
    if (!allowed.has(id) || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Baja de almacén: una sola fila `warehouses` significa dos cosas distintas
// ---------------------------------------------------------------------------

/**
 * Fila cruda de `public.warehouses` (llegan en snake_case desde Supabase).
 * `active === false` es la marca de baja que escribe `deleteBranchFromSupabase`;
 * no existe borrado físico porque ventas, turnos y traslados apuntan al id.
 */
export type RawWarehouseRow = {
  id?: string | null;
  name?: string | null;
  active?: boolean | null;
};

/** Almacén ya proyectado a la store (`Branch`): lleva `isActive`. */
export type OperationalBranchRecord = {
  id?: string | null;
  name?: string | null;
  isActive?: boolean | null;
};

/**
 * Regla canónica de la lista operativa: un almacén dado de baja NO existe.
 *
 * Se aplica sobre la fila cruda para poder filtrar ANTES de proyectar, de modo
 * que el contador `hidden` del arranque siga informando cuántos quedaron fuera
 * (si se filtrara en el `map`, ese número sería siempre cero).
 */
export function isWarehouseRowRetired(row: RawWarehouseRow | null | undefined): boolean {
  return row?.active === false;
}

/** Versión sobre la entidad de la store (arranque legacy e hidratación local). */
export function isBranchRecordRetired(branch: OperationalBranchRecord | null | undefined): boolean {
  return branch?.isActive === false;
}

/**
 * Lista operativa: descarta los dados de baja.
 *
 * Sin este filtro, el pull devolvía la fila con `active=false`, `mapBranch` la
 * re-proyectaba y el almacén «resucitaba» en Configuración justo después de
 * avisar de que se había eliminado.
 */
export function selectOperationalWarehouseRows<T extends RawWarehouseRow>(
  rows: readonly T[] | null | undefined
): T[] {
  return (rows || []).filter(row => !isWarehouseRowRetired(row));
}

/** Ids de los almacenes retirados: sirve para auditar qué quedó oculto. */
export function collectRetiredWarehouseIds(
  rows: readonly RawWarehouseRow[] | null | undefined
): string[] {
  const ids: string[] = [];
  for (const row of rows || []) {
    if (!isWarehouseRowRetired(row)) continue;
    const id = String(row?.id ?? '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Diccionario id → nombre para el HISTÓRICO. Deliberadamente NO filtra los
 * dados de baja: una venta, un turno o un traslado viejo conservan el id del
 * almacén donde ocurrieron, y si la fila desaparece del mapa el reporte muestra
 * «Origen»/«Destino» genérico o un nombre vacío.
 */
export function buildWarehouseNameMap(
  rows: readonly (RawWarehouseRow | OperationalBranchRecord)[] | null | undefined,
  fallbackLabel = RETIRED_LABEL
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows || []) {
    const id = String(row?.id ?? '').trim();
    if (!id) continue;
    const name = String(row?.name ?? '').trim();
    // La primera fila con nombre gana: evita que una proyección sin nombre
    // borre el nombre ya resuelto por otra fuente.
    if (!map.has(id) || (name && map.get(id) === fallbackLabel)) {
      map.set(id, name || fallbackLabel);
    }
  }
  return map;
}

/** Nombre histórico de un almacén, con etiqueta visible si está dado de baja. */
export function resolveHistoricalWarehouseName(
  lookup: Map<string, string> | null | undefined,
  warehouseId: string | null | undefined,
  fallbackLabel = RETIRED_LABEL
): string {
  const id = String(warehouseId ?? '').trim();
  if (!id) return fallbackLabel;
  return String(lookup?.get(id) ?? '').trim() || fallbackLabel;
}

// ---------------------------------------------------------------------------
// Regla de integridad determinista para dar de baja un almacén
// ---------------------------------------------------------------------------

export type WarehouseDeletionBlocker = 'inventory' | 'sales' | 'sessions';

export interface WarehouseStockSummary {
  /** Unidades físicas que quedarían huérfanas si el almacén desapareciera. */
  units: number;
  /** Productos distintos con existencias en el almacén. */
  products: number;
}

export interface WarehouseRelationCounts {
  stock: WarehouseStockSummary;
  sales: number;
  sessions: number;
}

export interface WarehouseDeletionDecision {
  ok: boolean;
  reason?: WarehouseDeletionBlocker | 'unknown';
  detail: string;
  counts: WarehouseRelationCounts;
}

/**
 * Resultado de `useStore.deleteBranch`. Amplía la decisión de integridad con el
 * estado de la sincronización, porque «eliminado» en un dispositivo offline no
 * significa «eliminado en la nube».
 */
export interface WarehouseDeletionOutcome extends WarehouseDeletionDecision {
  /** true cuando la baja ya está confirmada en la nube. */
  synced?: boolean;
  /** true cuando la baja quedó encolada y se aplicará al reconectar. */
  pendingSync?: boolean;
}

type SaleLike = { branchId?: string | null; warehouseId?: string | null };
type SessionLike = { branchId?: string | null; warehouseId?: string | null; status?: string | null };
type StockLike = {
  branchId?: string | null;
  warehouseId?: string | null;
  quantity?: number | null;
  productId?: string | null;
  variantLabel?: string | null;
};

function scopedTo(scope: string, ...values: Array<string | null | undefined>): boolean {
  return values.some(value => String(value ?? '').trim() === scope);
}

/**
 * Decide si un almacén se puede dar de baja. Es la única fuente de la verdad:
 * `useStore.deleteBranch` la ejecuta y `processQueueItem` la vuelve a evaluar al
 * sincronizar, para que la cola offline no pueda borrar lo que la UI bloqueó.
 *
 * Orden determinista (de más a menos recuperable):
 *  1. `inventory`: tiene unidades físicas. Nunca se borra ni se reasigna stock:
 *     dejaría mercancía sin dueño. Primero hay que vaciarlo o trasladarla.
 *  2. `sales`: tiene ventas registradas. Son historial fiscal; borrar el almacén
 *     rompería reportes y trazabilidad.
 *  3. `sessions`: tuvo turnos de caja. Mismo motivo: el arqueo queda referenciado.
 *
 * Un nivel en cero pero con filas (inventario con cantidad 0) sí permite la
 * baja: las líneas sin unidades no dejan huérfanos.
 */
export function evaluateWarehouseDeletion(input: {
  inventory?: readonly StockLike[] | null;
  transactions?: readonly SaleLike[] | null;
  cashSessions?: readonly SessionLike[] | null;
  warehouseId?: string | null;
}): WarehouseDeletionDecision {
  const scope = String(input?.warehouseId ?? '').trim();
  const stockRows = (input?.inventory || []).filter(level => scopedTo(scope, level?.branchId, level?.warehouseId));

  const positive = stockRows.filter(level => Number(level?.quantity) > 0);
  // Agrupar por producto (no por variante): es lo que el dueño entiende por
  // «cuántos productos tiene guardados este almacén».
  const productKeys = new Set(positive.map(level => String(level?.productId ?? '').trim() || '(sin producto)'));
  const units = positive.reduce((sum, level) => sum + Math.max(0, Number(level?.quantity) || 0), 0);
  const sales = (input?.transactions || []).filter(tx => scopedTo(scope, tx?.branchId, tx?.warehouseId)).length;
  const sessions = (input?.cashSessions || []).filter(s => scopedTo(scope, s?.branchId, s?.warehouseId)).length;
  const counts: WarehouseRelationCounts = { stock: { units, products: productKeys.size }, sales, sessions };

  if (units > 0 || productKeys.size > 0) {
    const productos = `${counts.stock.products} producto${counts.stock.products === 1 ? '' : 's'}`;
    return {
      ok: false,
      reason: 'inventory',
      detail: `No se puede eliminar: tiene ${formatUnits(counts.stock.units)} en ${productos}. Traslada o agota ese inventario antes de dar de baja el almacén. No se borra ni se reasigna automáticamente.`,
      counts,
    };
  }
  if (sales > 0) {
    return {
      ok: false,
      reason: 'sales',
      detail: `No se puede eliminar: tiene ${sales} venta${sales === 1 ? '' : 's'} registrada${sales === 1 ? '' : 's'}. El historial debe conservar su almacén.`,
      counts,
    };
  }
  if (sessions > 0) {
    return {
      ok: false,
      reason: 'sessions',
      detail: `No se puede eliminar: tuvo ${sessions} turno${sessions === 1 ? '' : 's'} de caja. Los arqueos quedan vinculados a él.`,
      counts,
    };
  }
  return {
    ok: true,
    detail: 'Almacén sin inventario, ventas ni turnos: se puede dar de baja.',
    counts,
  };
}

function formatUnits(units: number): string {
  const rounded = Math.round(units * 1000) / 1000;
  // El `: ''` es obligatorio: sin la rama falsa esbuild no parsea el ternario
  // dentro de la plantilla y el archivo entero falla al importar.
  const count = Number.isInteger(rounded) ? rounded.toLocaleString('es-ES') : String(rounded);
  return `${count} ${rounded === 1 ? 'unidad' : 'unidades'}`;
}
