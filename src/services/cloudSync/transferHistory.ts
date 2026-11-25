/**
 * Historial de traslados con el mapeo correcto del esquema real.
 *
 * El bootstrap legado (supabaseSync) aplica sobre `transfers` el filtro
 * `status.not.in.(completed,cancelled)` y el enum real de la nube es
 * `posted|cancelled|in_transit|received`: PostgREST responde 22P02
 * ("invalid input value for enum transfer_status: completed") y la sección
 * de traslados queda vacía en el arranque. Además, su proyección convierte
 * `posted` → 'completed', destruyendo la distinción entre despachado y
 * recibido que necesita el flujo en dos fases.
 *
 * Este módulo es el camino sano, usado por la autocuración del arranque y por
 * la reconciliación de historial de traslados: pagina el historial completo
 * SIN filtros de enum y proyecta los estados reales con
 * `normalizeTransferStatus` (posted → in_transit, received → completed).
 * Nunca lanza: un fallo de red o de credenciales devuelve success:false y el
 * llamador conserva la copia local.
 */
import type { InventoryTransfer, InventoryLevel } from "../../types";
import { getSupabase } from "../../lib/supabase";
import { getActiveTenant } from "../tenant";
import {
  normalizeTransferOperationId,
  normalizeTransferStatus,
  transferIdentityKey
} from "../localDb/repositories";

// ---------------------------------------------------------------------------
// Asentamiento local de resoluciones (puro) y overrides de estado persistentes
// ---------------------------------------------------------------------------
// Compartidos por las acciones del store (inventoryActions) y por el
// procesador de la cola offline (processQueueItem) sin crear ciclos de
// importación: este módulo solo depende de tipos, lib/supabase, tenant y
// localDb/repositories.

type TransferStatus = InventoryTransfer["status"];

/** Suma las cantidades de un lado del traslado al inventario local (pura). */
function addTransferStockLocal(
  inventory: readonly InventoryLevel[],
  rows: InventoryTransfer[],
  side: "fromBranchId" | "toBranchId"
): InventoryLevel[] {
  const next = [...inventory];
  for (const row of rows) {
    const branchId = row[side];
    const quantity = Number(row.quantity || 0);
    if (!branchId || !Number.isFinite(quantity) || quantity <= 0) continue;
    const label = row.variantLabel && row.variantLabel !== "Producto Base" ? row.variantLabel : "";
    const idx = next.findIndex(item =>
      item.productId === row.productId && item.branchId === branchId && (item.variantLabel || "") === label
    );
    if (idx >= 0) {
      next[idx] = { ...next[idx], quantity: Number(next[idx].quantity || 0) + quantity };
    } else {
      next.push({
        id: crypto.randomUUID(),
        productId: row.productId,
        branchId,
        variantLabel: label || undefined,
        quantity,
        minQuantity: 5
      });
    }
  }
  return next;
}

/**
 * Asentamiento local IDEMPOTENTE de una resolución: solo toca filas con
 * estado 'in_transit' y las marca una vez hacia `targetStatus`. Con
 * `creditStock` y `creditSide` aplica el movimiento de stock local una sola
 * vez; con `creditStock:false` solo cambia el estado visible (el stock ya
 * fue resuelto por la nube y la reconciliación canónica traerá la verdad).
 */
export function settleTransferRows(
  transfers: readonly InventoryTransfer[],
  inventory: readonly InventoryLevel[],
  ids: readonly string[],
  targetStatus: TransferStatus,
  options: { creditStock?: boolean; creditSide?: "fromBranchId" | "toBranchId" } = {}
): { transfers: InventoryTransfer[]; inventory: InventoryLevel[]; changed: boolean } {
  const idSet = new Set((ids || []).map(id => normalizeTransferOperationId(id)).filter(Boolean));
  const rows = (transfers || []).filter(t =>
    idSet.has(transferIdentityKey(t)) && t.status === "in_transit"
  );
  const changed = rows.length > 0;
  const nextTransfers = (transfers || []).map(t =>
    idSet.has(transferIdentityKey(t)) && t.status === "in_transit"
      ? { ...t, status: targetStatus }
      : t
  );
  const creditStock = options.creditStock !== false;
  const base: InventoryLevel[] = [...(inventory || [])];
  const nextInventory =
    changed && creditStock && options.creditSide
      ? addTransferStockLocal(base, rows, options.creditSide)
      : base;
  return { transfers: nextTransfers, inventory: nextInventory, changed };
}

/**
 * Errores terminales del RPC de recepción/cancelación: reintentar el mismo
 * payload jamás prosperará. Se distinguen para asentar el estado visible
 * correcto (la nube ya resolvió la operación) en lugar de encolar y
 * reintentar para siempre.
 */
export function classifyTransferResolutionError(
  error: string | undefined | null,
  errorCode?: string | null
): "not_found" | "cancelled" | "not_in_transit" | "retriable" {
  const code = String(errorCode || "");
  if (code === "INVALID_OPERATION_ID") return "not_found";
  const message = String(error || "");
  if (/transfer_not_found/i.test(message)) return "not_found";
  if (/transfer_cancelled/i.test(message)) return "cancelled";
  if (/transfer_not_in_transit/i.test(message)) return "not_in_transit";
  return "retriable";
}

/**
 * Overrides persistentes de estado por identidad de traslado.
 *
 * Los traslados legacy 'posted' (una sola fase) ya tienen sus dos movimientos
 * aplicados en la nube. `palmyra_receive_transfer` responde success con
 * `status:'posted', already_existed:true` SIN mover el estado a 'received';
 * el cliente asienta la recepción localmente y registra aquí la identidad
 * para que la reconciliación del historial (posted → in_transit) no deshaga
 * el cambio visible. El override solo aplica cuando la fila local está en
 * 'in_transit' y persiste en localStorage para sobrevivir recargas hasta que
 * la migración del servidor convierta posted → received (entonces es inerte).
 */
const TRANSFER_STATUS_OVERRIDE_KEY = "palmyra.transfer.statusOverrides.v1";

const statusOverrides = new Map<string, TransferStatus>();

function loadStatusOverrides(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(TRANSFER_STATUS_OVERRIDE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      const id = normalizeTransferOperationId((entry as any)?.id);
      const status = (entry as any)?.status;
      if (id && (status === "completed" || status === "cancelled")) {
        statusOverrides.set(id, status as TransferStatus);
      }
    }
  } catch {
    // Almacenamiento no disponible o corrupto: el override vive solo en memoria.
  }
}

function persistStatusOverrides(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const payload = Array.from(statusOverrides.entries()).map(([id, status]) => ({ id, status }));
    localStorage.setItem(TRANSFER_STATUS_OVERRIDE_KEY, JSON.stringify(payload));
  } catch {
    // Sin persistencia disponible: se mantiene solo en memoria.
  }
}

loadStatusOverrides();

export function registerTransferStatusOverrides(
  ids: readonly string[],
  status: TransferStatus
): void {
  let changed = false;
  for (const rawId of ids || []) {
    const id = normalizeTransferOperationId(rawId);
    if (!id) continue;
    if (statusOverrides.get(id) !== status) {
      statusOverrides.set(id, status);
      changed = true;
    }
  }
  if (changed) persistStatusOverrides();
}

export function getTransferStatusOverrides(): Map<string, TransferStatus> {
  return new Map(statusOverrides);
}

/**
 * Aplica los overrides a filas 'in_transit' cuyas identidades (normalizadas)
 * están registradas. Único punto de aplicación: la reconciliación del
 * historial (syncTransferHistory), la autocuración del arranque y el refresco
 * por sucursal pasan sus filas por aquí para que una resolución confirmada por
 * la nube no reaparezca como accionable.
 */
export function applyTransferStatusOverrides(
  transfers: readonly InventoryTransfer[]
): InventoryTransfer[] {
  if (!statusOverrides.size || !Array.isArray(transfers)) {
    return transfers ? [...transfers] : [];
  }
  return transfers.map(t => {
    if (t.status !== "in_transit") return t;
    const forced = statusOverrides.get(transferIdentityKey(t));
    return forced ? { ...t, status: forced } : t;
  });
}

export interface TransferHistoryOptions {
  /** Cliente inyectable (pruebas); sin él se usa getSupabase(). */
  client?: any;
  /** Empresa inyectable (pruebas); sin ella se resuelve con getActiveTenant(). */
  tenant?: { companyId: string };
  /** Nombres ya cargados en el catálogo: evita consultas repetidas. */
  refs?: {
    productNames?: Map<string, string>;
    warehouseNames?: Map<string, string>;
    variantNames?: Map<string, string>;
  };
  /** Filtro opcional: solo traslados que toquen esta sucursal/almacén. */
  branchId?: string;
}

export interface TransferHistoryResult {
  success: boolean;
  transfers: InventoryTransfer[];
  message?: string;
}

const PAGE_SIZE = 500;
const ITEM_BATCH_IDS = 400;
const ITEM_PAGE_SIZE = 500;

function toRows(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Descarga completa del historial de traslados con los estados reales.
 * Pagina hasta el final (igual que el camino legado sano) y solo falla si
 * una página falla: nunca devuelve un historial a medias.
 */
export async function pullTransferHistoryCorrected(
  options: TransferHistoryOptions = {}
): Promise<TransferHistoryResult> {
  try {
    const tenant = (options.tenant || (await getActiveTenant())) as { companyId: string };
    const companyId = String(tenant?.companyId ?? "").trim();
    if (!companyId) return { success: false, transfers: [], message: "sin empresa activa" };
    const supabase = options.client || getSupabase();
    if (!supabase) return { success: false, transfers: [], message: "sin cliente de nube" };

    // 1) Padres: historial completo de la empresa, sin filtros de enum.
    // La paginación por offset puede solaparse bajo escrituras concurrentes
    // (una fila nueva desplaza el resto): se desduplica por id para que la
    // misma operación no se proyecte dos veces.
    const parentsById = new Map<string, any>();
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("transfers")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) return { success: false, transfers: [], message: error.message };
      const page = toRows(data);
      if (!page.length) break;
      for (const row of page) {
        if (row?.id && !parentsById.has(String(row.id))) parentsById.set(String(row.id), row);
      }
      if (page.length < PAGE_SIZE) break;
    }
    const parents = Array.from(parentsById.values());

    const scoped = options.branchId
      ? parents.filter(
          (t: any) =>
            t.origin_warehouse_id === options.branchId ||
            t.destination_warehouse_id === options.branchId
        )
      : parents;
    const ids = scoped.map((t: any) => t.id).filter(Boolean);
    if (!ids.length) return { success: true, transfers: [] };

    // 2) Líneas por lotes acotados de ids. Igual que los padres, las páginas
    // pueden solaparse: se desduplica por id de línea antes de proyectar.
    const itemRowsById = new Map<string, any>();
    for (let i = 0; i < ids.length; i += ITEM_BATCH_IDS) {
      const batch = ids.slice(i, i + ITEM_BATCH_IDS);
      for (let from = 0; ; from += ITEM_PAGE_SIZE) {
        const { data, error } = await supabase
          .from("transfer_items")
          .select("*")
          .in("transfer_id", batch)
          .order("id", { ascending: true })
          .range(from, from + ITEM_PAGE_SIZE - 1);
        if (error) return { success: false, transfers: [], message: error.message };
        const page = toRows(data);
        if (!page.length) break;
        for (const row of page) {
          if (row?.id && !itemRowsById.has(String(row.id))) itemRowsById.set(String(row.id), row);
        }
        if (page.length < ITEM_PAGE_SIZE) break;
      }
    }
    const itemRows = Array.from(itemRowsById.values());

    // 3) Nombres de catálogo (o reutiliza los que ya trae el arranque).
    const [productsRes, warehousesRes, variantsRes] = await Promise.all([
      options.refs?.productNames
        ? Promise.resolve({ data: [], error: null })
        : supabase.from("products").select("id,name").eq("company_id", companyId),
      options.refs?.warehouseNames
        ? Promise.resolve({ data: [], error: null })
        : supabase.from("warehouses").select("id,name").eq("company_id", companyId),
      options.refs?.variantNames
        ? Promise.resolve({ data: [], error: null })
        : supabase.from("product_variants").select("id,name").eq("company_id", companyId)
    ]);
    if (productsRes.error) return { success: false, transfers: [], message: productsRes.error.message };
    if (warehousesRes.error) return { success: false, transfers: [], message: warehousesRes.error.message };
    if (variantsRes.error) return { success: false, transfers: [], message: variantsRes.error.message };
    const productNames =
      options.refs?.productNames ||
      new Map<string, string>(toRows(productsRes.data).map((p: any) => [p.id, p.name]));
    const warehouseNames =
      options.refs?.warehouseNames ||
      new Map<string, string>(toRows(warehousesRes.data).map((w: any) => [w.id, w.name]));
    const variantNames =
      options.refs?.variantNames ||
      new Map<string, string>(toRows(variantsRes.data).map((v: any) => [v.id, v.name]));

    const itemsByTransfer = new Map<string, any[]>();
    for (const item of itemRows) {
      const list = itemsByTransfer.get(item.transfer_id) || [];
      list.push(item);
      itemsByTransfer.set(item.transfer_id, list);
    }

    const rows: InventoryTransfer[] = [];
    for (const t of scoped) {
      const items = itemsByTransfer.get(t.id) || [];
      for (const item of items) {
        rows.push({
          id: item.id,
          operationId: t.id,
          productId: item.product_id,
          productName: productNames.get(item.product_id) || "Producto",
          fromWarehouseId: t.origin_warehouse_id,
          fromBranchId: t.origin_warehouse_id,
          fromBranchName: warehouseNames.get(t.origin_warehouse_id) || "Origen",
          toWarehouseId: t.destination_warehouse_id,
          toBranchId: t.destination_warehouse_id,
          toBranchName: warehouseNames.get(t.destination_warehouse_id) || "Destino",
          variantLabel: variantNames.get(item.variant_id) || undefined,
          quantity: Number(item.quantity) || 0,
          variants: [],
          date: t.created_at,
          userId: t.created_by || "",
          batchId: t.batch_id || undefined,
          status: normalizeTransferStatus(t.status)
        });
      }
    }
    return { success: true, transfers: rows };
  } catch (error) {
    return {
      success: false,
      transfers: [],
      message: error instanceof Error ? error.message : "error al descargar el historial de traslados"
    };
  }
}
