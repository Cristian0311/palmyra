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
const RETIRED_LABEL = 'Almacén retirado';

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
