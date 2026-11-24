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
import type { InventoryTransfer } from "../../types";
import { getSupabase } from "../../lib/supabase";
import { getActiveTenant } from "../tenant";
import { normalizeTransferStatus } from "../localDb/repositories";

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
