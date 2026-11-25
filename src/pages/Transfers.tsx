import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useRef, useState } from "react";
import { getAuthorizedWarehouseIds } from "../modules/warehouse/warehouseScope";
import {
  ArrowLeftRight,
  Search,
  Plus,
  Package,
  MapPin,
  ArrowRight,
  History,
  CheckCircle,
  Clock,
  RefreshCw,
  AlertTriangle,
  Building2,
  X,
  Minus,
  Truck,
  PackageCheck,
  Undo2,
  ArrowDownRight,
  ArrowUpRight,
} from "lucide-react";
import { useStore } from "../store/useStore";
import { cn } from "../lib/utils";
import { documentCode } from "../lib/documentCodes";
import PlanFeatureGate from "../components/PlanFeatureGate";
import { ReportsStatBubbles } from "../components/reports/ReportsStatBubbles";
import type { InventoryTransfer } from "../types";

type HistoryMode = 'general' | 'branch';

type TransferGroupRow = {
  key: string;
  rows: InventoryTransfer[];
  first: InventoryTransfer;
  totalQty: number;
  dateMs: number;
  dateLabel: string;
  timeLabel: string;
  direction: 'out' | 'in' | null;
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  in_transit: 'En tránsito',
  cancelled: 'Cancelado',
  completed: 'Recibido',
};

// Clave centinela para la acción masiva: ninguna fila real usa este valor.
const BULK_RESOLVE_KEY = '__bulk__';

function StatusBadge({ status }: { status: InventoryTransfer['status'] }) {
  const tone =
    status === 'pending'
      ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300'
      : status === 'in_transit'
        ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300'
        : status === 'cancelled'
          ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300';
  const Icon = status === 'pending' ? Clock : status === 'in_transit' ? Truck : status === 'cancelled' ? AlertTriangle : CheckCircle;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-black uppercase tracking-wide whitespace-nowrap', tone)}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {STATUS_LABEL[status] || 'Traslado'}
    </span>
  );
}

function DirectionBadge({ direction }: { direction: 'out' | 'in' }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-black uppercase tracking-wide whitespace-nowrap',
      direction === 'out'
        ? 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
    )}>
      {direction === 'out' ? <ArrowUpRight className="h-3 w-3" aria-hidden="true" /> : <ArrowDownRight className="h-3 w-3" aria-hidden="true" />}
      {direction === 'out' ? 'Salida' : 'Entrada'}
    </span>
  );
}

export default function Transfers() {
  const {
    branches,
    products,
    inventory,
    transferProductsBulk,
    receiveTransfer,
    cancelTransfer,
    transfers,
    currentBranchId,
    addNotification,
    currentUser,
    syncWithSupabase,
    isSyncing,
    syncResult,
  } = useStore(useShallow((state) => ({
    branches: state.branches,
    products: state.products,
    inventory: state.inventory,
    transferProductsBulk: state.transferProductsBulk,
    receiveTransfer: state.receiveTransfer,
    cancelTransfer: state.cancelTransfer,
    transfers: state.transfers,
    currentBranchId: state.currentBranchId,
    addNotification: state.addNotification,
    currentUser: state.currentUser,
    syncWithSupabase: state.syncWithSupabase,
    isSyncing: state.isSyncing,
    syncResult: state.syncResult,
  })));

  const authorizedBranchIds = useMemo(
    () => currentUser?.role === 'admin' ? [] : getAuthorizedWarehouseIds(currentUser),
    [currentUser]
  );
  const isBranchRestricted = currentUser?.role !== 'admin' && authorizedBranchIds.length > 0;
  const allowedBranches = useMemo(
    () => isBranchRestricted ? branches.filter(branch => authorizedBranchIds.includes(branch.id)) : branches,
    [branches, isBranchRestricted, authorizedBranchIds]
  );

  const [activeTab, setActiveTab] = useState<'history' | 'new'>('history');
  const [historyMode, setHistoryMode] = useState<HistoryMode>('general');
  const [branchFilter, setBranchFilter] = useState(currentBranchId || '');
  const [historySearch, setHistorySearch] = useState('');
  const [bulkTransferItems, setBulkTransferItems] = useState<{ productId: string, quantity: number, variant?: string }[]>([]);
  const [bulkTransferSourceId, setBulkTransferSourceId] = useState(currentBranchId || (branches[0]?.id || ''));
  const [bulkTransferTargetId, setBulkTransferTargetId] = useState("");

  // Mantener origen/filtro dentro de los almacenes autorizados del empleado.
  useEffect(() => {
    if (!isBranchRestricted) return;
    const allowedIds = new Set(allowedBranches.map(branch => branch.id));
    if (!allowedIds.has(bulkTransferSourceId)) setBulkTransferSourceId(allowedBranches[0]?.id || '');
    if (!allowedIds.has(branchFilter)) setBranchFilter(allowedBranches[0]?.id || '');
    if (bulkTransferTargetId && !allowedIds.has(bulkTransferTargetId)) setBulkTransferTargetId('');
  }, [isBranchRestricted, allowedBranches, bulkTransferSourceId, branchFilter, bulkTransferTargetId]);
  const [transferSearch, setTransferSearch] = useState("");
  const [isExecutingTransfer, setIsExecutingTransfer] = useState(false);
  const [resolvingTransitKey, setResolvingTransitKey] = useState<string | null>(null);
  const [expandedBatches, setExpandedBatches] = useState<string[]>([]);
  // Confirmación en dos pasos para recibir/cancelar mercancía en tránsito.
  const [transitConfirm, setTransitConfirm] = useState<{ key: string; action: 'receive' | 'cancel' } | null>(null);
  // Confirmación en dos pasos para la acción masiva sobre todo el tránsito.
  const [bulkTransitConfirm, setBulkTransitConfirm] = useState<'receive' | 'cancel' | null>(null);
  // Guarda de reentrada: impide que un doble clic dispare dos recepciones.
  const resolvingRef = useRef(false);

  const branchLabelById = useMemo(
    () => new Map(branches.map((branch) => [branch.id, branch.name])),
    [branches]
  );

  const branchLabel = (id?: string, fallback = 'Sucursal') =>
    (id && branchLabelById.get(id)) || fallback;

  const stockByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of inventory) {
      const key = `${row.productId}|${row.branchId}|${row.variantLabel || ''}`;
      map.set(key, (map.get(key) || 0) + (Number(row.quantity) || 0));
    }
    return map;
  }, [inventory]);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const productVariantLabels = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const product of products) {
      const labels = Array.from(new Set([
        ...(product.availableSizes || []),
        ...(product.availableColors || []),
      ])).map((value) => String(value).trim()).filter(Boolean);
      map.set(product.id, labels.length ? labels : ['']);
    }
    return map;
  }, [products]);

  const stockAt = (productId: string, branchId: string, variant?: string) =>
    stockByKey.get(`${productId}|${branchId}|${variant || ''}`) || 0;

  /**
   * Defensa de UI contra el merge de fuentes (syncActions / replaceRemoteRecords
   * mezclan por `id || operationId`): una fila legada hidratada con id = id del
   * traslado padre duplica las filas de nube que traen id = id de línea y
   * operationId = id del padre. Aquí se descartan esos ecos (fila sin
   * operationId cuyo id es el operationId de otras filas) y cualquier id
   * repetido, para no mostrar el mismo traslado dos veces ni inflar KPIs.
   */
  const dedupedTransfers = useMemo(() => {
    const operationIds = new Set<string>();
    for (const transfer of transfers) {
      if (transfer.operationId) operationIds.add(String(transfer.operationId));
    }
    const seen = new Set<string>();
    const kept: InventoryTransfer[] = [];
    for (const transfer of transfers) {
      const id = String(transfer.id || '');
      if (!transfer.operationId && id && operationIds.has(id)) continue;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      kept.push(transfer);
    }
    return kept;
  }, [transfers]);

  const branchScopedTransfers = useMemo(() => {
    const visible = isBranchRestricted
      ? dedupedTransfers.filter((transfer) =>
          authorizedBranchIds.includes(transfer.fromBranchId) || authorizedBranchIds.includes(transfer.toBranchId)
        )
      : dedupedTransfers;
    if (historyMode !== 'branch' || !branchFilter) return visible;
    return visible.filter((transfer) =>
      transfer.fromBranchId === branchFilter || transfer.toBranchId === branchFilter
    );
  }, [dedupedTransfers, historyMode, branchFilter, isBranchRestricted, authorizedBranchIds]);

  const inTransitGroups = useMemo(() => {
    const groups = new Map<string, InventoryTransfer[]>();
    for (const transfer of branchScopedTransfers) {
      if (transfer.status !== 'in_transit') continue;
      const key = transfer.batchId || transfer.operationId || transfer.id;
      const list = groups.get(key) || [];
      list.push(transfer);
      groups.set(key, list);
    }
    return Array.from(groups.entries())
      .map(([key, rows]) => ({
        key,
        rows,
        operationIds: Array.from(new Set(rows.map((row) => String(row.operationId || row.id)).filter(Boolean))),
        totalQty: rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
        dateMs: new Date(rows[0]?.date || 0).getTime(),
        fromBranchName: rows[0]?.fromBranchName || 'Origen',
        toBranchName: rows[0]?.toBranchName || 'Destino',
      }))
      .sort((a, b) => b.dateMs - a.dateMs);
  }, [branchScopedTransfers]);

  const allTransitOperationIds = useMemo(
    () => Array.from(new Set(inTransitGroups.flatMap((group) => group.operationIds))),
    [inTransitGroups]
  );

  const historyGroups = useMemo<TransferGroupRow[]>(() => {
    const term = historySearch.trim().toLowerCase();
    const scoped = term
      ? branchScopedTransfers.filter((transfer) =>
          [transfer.productName, transfer.fromBranchName, transfer.toBranchName, transfer.variantLabel, transfer.batchId]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(term)
        )
      : branchScopedTransfers;
    const groups = new Map<string, InventoryTransfer[]>();
    for (const transfer of scoped) {
      const key = transfer.batchId || transfer.id;
      const list = groups.get(key) || [];
      list.push(transfer);
      groups.set(key, list);
    }
    return Array.from(groups.entries())
      .map(([key, rows]) => {
        const first = rows[0];
        const date = new Date(first.date);
        const direction = historyMode === 'branch' && branchFilter
          ? (first.fromBranchId === branchFilter ? 'out' as const : first.toBranchId === branchFilter ? 'in' as const : null)
          : null;
        return {
          key,
          rows,
          first,
          totalQty: rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0),
          dateMs: date.getTime() || 0,
          dateLabel: date.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' }),
          timeLabel: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          direction,
        };
      })
      .sort((a, b) => b.dateMs - a.dateMs);
  }, [branchScopedTransfers, historySearch, historyMode, branchFilter]);

  const stats = useMemo(() => {
    const units = branchScopedTransfers.reduce((sum, transfer) => sum + (Number(transfer.quantity) || 0), 0);
    const batches = new Set(branchScopedTransfers.map((transfer) => transfer.batchId || transfer.id)).size;
    const transitRows = branchScopedTransfers.filter((transfer) => transfer.status === 'in_transit');
    const transitBatches = new Set(transitRows.map((transfer) => transfer.batchId || transfer.operationId || transfer.id)).size;
    const transitUnits = transitRows.reduce((sum, transfer) => sum + (Number(transfer.quantity) || 0), 0);
    const receivedRows = branchScopedTransfers.filter((transfer) => transfer.status === 'completed');
    const receivedBatches = new Set(receivedRows.map((transfer) => transfer.batchId || transfer.operationId || transfer.id)).size;
    const receivedUnits = receivedRows.reduce((sum, transfer) => sum + (Number(transfer.quantity) || 0), 0);
    if (historyMode === 'branch' && branchFilter) {
      const outgoing = branchScopedTransfers.filter((transfer) => transfer.fromBranchId === branchFilter).length;
      const incoming = branchScopedTransfers.filter((transfer) => transfer.toBranchId === branchFilter).length;
      return { units, batches, transitBatches, transitUnits, receivedBatches, receivedUnits, outgoing, incoming, topBranch: null as { name: string; count: number } | null };
    }
    const counts = new Map<string, { id: string; count: number }>();
    for (const transfer of branchScopedTransfers) {
      for (const id of [transfer.fromBranchId, transfer.toBranchId]) {
        if (!id) continue;
        const entry = counts.get(id) || { id, count: 0 };
        entry.count += 1;
        counts.set(id, entry);
      }
    }
    const top = Array.from(counts.values()).sort((a, b) => b.count - a.count)[0];
    return {
      units,
      batches,
      transitBatches,
      transitUnits,
      receivedBatches,
      receivedUnits,
      outgoing: 0,
      incoming: 0,
      topBranch: top ? { name: branchLabelById.get(top.id) || 'Sucursal', count: top.count } : null,
    };
  }, [branchScopedTransfers, historyMode, branchFilter, branchLabelById]);

  const bubbleItems = historyMode === 'branch' && branchFilter
    ? [
        { label: 'Operaciones', value: String(stats.batches), hint: `${branchScopedTransfers.length} líneas en esta sucursal`, icon: ArrowLeftRight, tone: 'violet' as const },
        { label: 'Unidades movidas', value: String(stats.units), hint: 'Artículos en esta sucursal', icon: Package, tone: 'blue' as const },
        { label: 'Salidas', value: String(stats.outgoing), hint: 'Líneas enviadas a otras sucursales', icon: ArrowUpRight, tone: 'amber' as const },
        { label: 'Entradas', value: String(stats.incoming), hint: 'Líneas recibidas de otras sucursales', icon: ArrowDownRight, tone: 'emerald' as const },
      ]
    : [
        { label: 'Operaciones', value: String(stats.batches), hint: `${branchScopedTransfers.length} líneas registradas`, icon: ArrowLeftRight, tone: 'violet' as const },
        { label: 'En tránsito', value: String(stats.transitBatches), hint: `${stats.transitUnits} uds por recibir`, icon: Truck, tone: 'amber' as const },
        { label: 'Por recibir', value: `${stats.transitUnits} uds`, hint: `${stats.transitBatches} lotes en camino`, icon: Package, tone: 'blue' as const },
        { label: 'Recibidos', value: String(stats.receivedBatches), hint: `${stats.receivedUnits} uds recibidas`, icon: CheckCircle, tone: 'emerald' as const },
      ];

  const resolveTransit = async (key: string, operationIds: string[], action: 'receive' | 'cancel') => {
    // Evita doble envío por doble clic antes del primer render con disabled.
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setTransitConfirm(null);
    setBulkTransitConfirm(null);
    setResolvingTransitKey(key);
    try {
      const result = action === 'receive'
        ? await receiveTransfer(operationIds)
        : await cancelTransfer(operationIds);
      if (result.success) {
        addNotification(
          result.warning ||
            (result.pending
              ? (action === 'receive'
                  ? 'Recepción guardada. Se confirmará con la nube al recuperar conexión.'
                  : 'Cancelación guardada. Se confirmará con la nube al recuperar conexión.')
              : (action === 'receive'
                  ? 'Mercancía recibida y sumada al almacén de destino.'
                  : 'Traslado cancelado y mercancía devuelta al origen.')),
          result.warning ? 'warning' : (result.pending ? 'info' : 'success')
        );
      } else {
        addNotification(result.error || 'No se pudo completar la operación.', 'error');
      }
    } catch (error: any) {
      addNotification(error?.message || 'No se pudo completar la operación.', 'error');
    } finally {
      resolvingRef.current = false;
      setResolvingTransitKey(null);
    }
  };

  const resolveAllTransit = async (action: 'receive' | 'cancel') => {
    if (resolvingRef.current) return;
    if (!allTransitOperationIds.length) {
      addNotification('No hay traslados en tránsito.', 'info');
      return;
    }
    resolvingRef.current = true;
    setTransitConfirm(null);
    setBulkTransitConfirm(null);
    setResolvingTransitKey(BULK_RESOLVE_KEY);
    try {
      const count = allTransitOperationIds.length;
      const result = action === 'receive'
        ? await receiveTransfer(allTransitOperationIds)
        : await cancelTransfer(allTransitOperationIds);
      if (result.success) {
        addNotification(
          result.warning ||
            (result.pending
              ? (action === 'receive'
                  ? `${count} recepciones guardadas. Se confirmarán con la nube al recuperar conexión.`
                  : `${count} cancelaciones guardadas. Se confirmarán con la nube al recuperar conexión.`)
              : (action === 'receive'
                  ? 'Toda la mercancía en tránsito fue recibida y sumada a los almacenes de destino.'
                  : 'Todos los traslados en tránsito fueron cancelados y la mercancía devuelta al origen.')),
          result.warning ? 'warning' : (result.pending ? 'info' : 'success')
        );
      } else {
        addNotification(result.error || 'No se pudo completar la operación.', 'error');
      }
    } catch (error: any) {
      addNotification(error?.message || 'No se pudo completar la operación.', 'error');
    } finally {
      resolvingRef.current = false;
      setResolvingTransitKey(null);
    }
  };

  const retrySync = async () => {
    if (isSyncing) return;
    try {
      await syncWithSupabase();
    } catch {
      // El store ya registra el resultado del sync; aquí no hay nada que añadir.
    }
  };

  const toggleBatch = (key: string) => {
    setExpandedBatches((prev) => prev.includes(key) ? prev.filter((id) => id !== key) : [...prev, key]);
  };

  const addedKeys = useMemo(
    () => new Set(bulkTransferItems.map((item) => `${item.productId}|${item.variant || ''}`)),
    [bulkTransferItems]
  );

  const productEntries = useMemo(() => products.map((product) => {
    const variants = productVariantLabels.get(product.id) || [''];
    let bestVariant: string | undefined;
    let bestStock = 0;
    for (const variant of variants) {
      const qty = stockAt(product.id, bulkTransferSourceId, variant);
      if (bestVariant === undefined && qty > 0) {
        bestVariant = variant;
        bestStock = qty;
      }
    }
    return { product, variants, bestVariant, stock: bestStock };
  }), [products, productVariantLabels, bulkTransferSourceId, stockByKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleProducts = useMemo(() => {
    const term = transferSearch.trim().toLowerCase();
    return productEntries
      .filter((entry) => {
        const haystack = `${entry.product.name} ${entry.product.sku || ''}`.toLowerCase();
        if (term && !haystack.includes(term)) return false;
        return !addedKeys.has(`${entry.product.id}|${entry.bestVariant || ''}`);
      })
      .slice(0, 30);
  }, [productEntries, transferSearch, addedKeys]);

  const shipments = useMemo(() => bulkTransferItems
    .map((item) => {
      const product = productById.get(item.productId);
      if (!product) return null;
      return {
        item,
        product,
        variants: productVariantLabels.get(item.productId) || [''],
        stock: stockAt(item.productId, bulkTransferSourceId, item.variant),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  [bulkTransferItems, productById, productVariantLabels, bulkTransferSourceId, stockByKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateShipmentQuantity = (index: number, nextQuantity: number, maxStock: number) => {
    setBulkTransferItems((prev) => prev.map((candidate, idx) =>
      idx === index ? { ...candidate, quantity: Math.max(1, Math.min(Math.max(1, maxStock), nextQuantity)) } : candidate
    ));
  };

  return (
    <PlanFeatureGate
      feature="transfers"
      title="Transferencias entre almacenes"
      description="Esta función mueve mercancía entre almacenes. Un plan Oasis tiene un solo almacén, por lo que no necesita transferencias. Puedes explorar la función y actualizar el plan cuando tengas varios puntos."
      highlights={[
        "Mueve mercancía entre almacenes sin perder trazabilidad",
        "Despacho, recepción y cancelación en dos fases",
        "Historial por sucursal con el stock siempre al día"
      ]}
    >
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500">

      <header className="flex flex-col gap-3 rounded-2xl border border-base bg-secondary p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white shadow-md">
            <ArrowLeftRight className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 data-palmi-content="transfers" className="truncate text-lg font-black uppercase leading-none tracking-tight text-primary sm:text-xl">Transferencias</h2>
            <p className="mt-1 truncate text-[11px] font-bold uppercase tracking-widest text-muted">Inventario entre almacenes y sucursales</p>
          </div>
        </div>

        <div className="grid w-full grid-cols-2 gap-1 rounded-xl border border-base bg-subtle p-1 sm:w-auto">
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            aria-pressed={activeTab === 'history'}
            className={cn(
              'min-h-11 rounded-lg px-3 text-[11px] font-black uppercase tracking-wide transition-all',
              activeTab === 'history' ? 'bg-secondary text-violet-700 shadow-xs dark:text-violet-300' : 'text-muted hover:text-primary'
            )}
          >
            Historial
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('new')}
            aria-pressed={activeTab === 'new'}
            className={cn(
              'min-h-11 rounded-lg px-3 text-[11px] font-black uppercase tracking-wide transition-all',
              activeTab === 'new' ? 'bg-secondary text-violet-700 shadow-xs dark:text-violet-300' : 'text-muted hover:text-primary'
            )}
          >
            Nuevo traslado
          </button>
        </div>
      </header>

      {activeTab === 'history' ? (
        <>
          <section className="flex flex-col gap-2 rounded-2xl border border-base bg-secondary p-3 shadow-xs lg:flex-row lg:items-center">
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-base bg-subtle p-1">
              <button
                type="button"
                onClick={() => setHistoryMode('general')}
                aria-pressed={historyMode === 'general'}
                className={cn(
                  'min-h-11 rounded-lg px-3 text-[11px] font-black uppercase tracking-wide transition-all whitespace-nowrap',
                  historyMode === 'general' ? 'bg-violet-600 text-white shadow-xs' : 'text-secondary hover:text-primary'
                )}
              >
                Historial general
              </button>
              <button
                type="button"
                onClick={() => {
                  setHistoryMode('branch');
                  if (!branchFilter) setBranchFilter(currentBranchId || branches[0]?.id || '');
                }}
                aria-pressed={historyMode === 'branch'}
                className={cn(
                  'min-h-11 rounded-lg px-3 text-[11px] font-black uppercase tracking-wide transition-all whitespace-nowrap',
                  historyMode === 'branch' ? 'bg-violet-600 text-white shadow-xs' : 'text-secondary hover:text-primary'
                )}
              >
                Por sucursal
              </button>
            </div>

            {historyMode === 'branch' && (
              <select
                value={branchFilter}
                onChange={(event) => setBranchFilter(event.target.value)}
                aria-label="Sucursal a consultar"
                className="min-h-10 w-full rounded-xl border border-base bg-subtle px-3 text-[12px] font-black uppercase text-primary lg:w-64"
              >
                {allowedBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branchLabel(branch.id, branch.name)}</option>
                ))}
              </select>
            )}

            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                type="search"
                value={historySearch}
                onChange={(event) => setHistorySearch(event.target.value)}
                placeholder="Buscar producto, lote o sucursal…"
                aria-label="Buscar en el historial de transferencias"
                className="min-h-10 w-full rounded-xl border border-base bg-subtle pl-9 pr-3 text-[12px] font-bold text-primary"
              />
            </div>
          </section>

          {syncResult && Array.isArray(syncResult.errors) && syncResult.errors.length > 0 && branchScopedTransfers.length === 0 && (
            <section role="alert" className="flex flex-col gap-2 rounded-2xl border border-rose-200 bg-rose-50/70 p-3 shadow-xs dark:border-rose-900/60 dark:bg-rose-950/30 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div className="flex min-w-0 items-start gap-2 sm:items-center">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400 sm:mt-0" aria-hidden="true" />
                <p className="text-[12px] font-bold text-rose-700 dark:text-rose-300">
                  No se pudieron cargar las transferencias desde la nube. Revisa tu conexión y reintenta la sincronización.
                </p>
              </div>
              <button
                type="button"
                disabled={isSyncing}
                onClick={() => void retrySync()}
                className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-4 text-[11px] font-black uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSyncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                {isSyncing ? 'Sincronizando…' : 'Reintentar'}
              </button>
            </section>
          )}

          <ReportsStatBubbles items={bubbleItems} />

          {inTransitGroups.length > 0 && (
            <section className="overflow-hidden rounded-2xl border border-amber-200 bg-secondary shadow-xs dark:border-amber-900/60">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50/70 px-3 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/30">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-secondary text-amber-600 dark:border-amber-900/60 dark:text-amber-300">
                    <Truck className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate text-[12px] font-black uppercase tracking-wide text-amber-900 dark:text-amber-200">Mercancía en tránsito</h3>
                    <p className="truncate text-[11px] font-semibold text-amber-700/90 dark:text-amber-300/80">Confirma la recepción en destino o devuélvela al origen.</p>
                  </div>
                </div>
                {bulkTransitConfirm ? (
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <span className="min-w-0 max-w-[320px] text-[11px] font-bold text-amber-900 dark:text-amber-200">
                      {bulkTransitConfirm === 'receive'
                        ? `¿Recibir las ${inTransitGroups.length} operaciones en tránsito?`
                        : `¿Cancelar las ${inTransitGroups.length} operaciones en tránsito y devolver la mercancía al origen?`}
                    </span>
                    <button
                      type="button"
                      disabled={resolvingTransitKey !== null}
                      onClick={() => setBulkTransitConfirm(null)}
                      className="inline-flex min-h-9 items-center justify-center rounded-lg border border-base bg-secondary px-3 text-[11px] font-black uppercase tracking-wide text-muted transition-colors hover:bg-subtle disabled:opacity-50"
                    >
                      No
                    </button>
                    <button
                      type="button"
                      disabled={resolvingTransitKey !== null}
                      onClick={() => void resolveAllTransit(bulkTransitConfirm)}
                      className={cn(
                        'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[11px] font-black uppercase tracking-wide text-white shadow-sm transition-colors disabled:opacity-50',
                        bulkTransitConfirm === 'receive' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
                      )}
                    >
                      {resolvingTransitKey === BULK_RESOLVE_KEY
                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        : bulkTransitConfirm === 'receive'
                          ? <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          : <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />}
                      {bulkTransitConfirm === 'receive' ? 'Sí, recibir todas' : 'Sí, cancelar todas'}
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <span className="rounded-lg border border-amber-200 bg-secondary px-2 py-1 text-[11px] font-black text-amber-800 dark:border-amber-900/60 dark:text-amber-300">
                      {inTransitGroups.length} pendiente{inTransitGroups.length === 1 ? '' : 's'}
                    </span>
                    <button
                      type="button"
                      disabled={resolvingTransitKey !== null}
                      onClick={() => setBulkTransitConfirm('cancel')}
                      className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-base bg-secondary px-3 text-[11px] font-black uppercase tracking-wide text-secondary transition-colors hover:bg-subtle disabled:opacity-50"
                    >
                      <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> Cancelar todas
                    </button>
                    <button
                      type="button"
                      disabled={resolvingTransitKey !== null}
                      onClick={() => setBulkTransitConfirm('receive')}
                      className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-[11px] font-black uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {resolvingTransitKey === BULK_RESOLVE_KEY ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />}
                      Recibir todas
                    </button>
                  </div>
                )}
              </div>
              <ul className="divide-y divide-base">
                {inTransitGroups.map((group) => {
                  const busy = resolvingTransitKey === group.key || resolvingTransitKey === BULK_RESOLVE_KEY;
                  const confirming = transitConfirm?.key === group.key ? transitConfirm.action : null;
                  return (
                    <li key={group.key} className="flex flex-col gap-2 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="palmyra-pill border border-base bg-subtle text-secondary" title={group.fromBranchName}>
                            {group.fromBranchName}
                          </span>
                          <ArrowRight className="h-3 w-3 shrink-0 text-[var(--warning)]" aria-hidden="true" />
                          <span className="palmyra-pill border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--bg-secondary))] text-[var(--warning)]" title={group.toBranchName}>
                            {group.toBranchName}
                          </span>
                          <span className="palmyra-pill border-transparent bg-[var(--text-primary)] text-[var(--text-inverse)]">{group.totalQty} uds</span>
                        </div>
                        <p className="mt-1.5 truncate text-[11px] font-semibold text-muted" title={`${new Date(group.dateMs).toLocaleString()} · ${group.rows.map((row) => row.productName).join(', ')}`}>
                          {new Date(group.dateMs).toLocaleString('es-CU')} · {group.rows.slice(0, 3).map((row) => row.productName).join(', ')}
                          {group.rows.length > 3 ? ` +${group.rows.length - 3} más` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 lg:shrink-0">
                        {confirming ? (
                          <>
                            <span className="mr-auto min-w-0 text-[11px] font-bold text-muted lg:mr-2 lg:max-w-[240px]">
                              {confirming === 'receive'
                                ? `¿Recibir ${group.totalQty} uds en ${group.toBranchName}?`
                                : `¿Cancelar y devolver ${group.totalQty} uds a ${group.fromBranchName}?`}
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setTransitConfirm(null)}
                              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-base bg-secondary px-3 text-[11px] font-black uppercase tracking-wide text-muted transition-colors hover:bg-subtle disabled:opacity-50 lg:min-h-9 lg:flex-none"
                            >
                              No
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void resolveTransit(group.key, group.operationIds, confirming)}
                              className={cn(
                                'inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-[11px] font-black uppercase tracking-wide text-white shadow-sm transition-colors disabled:opacity-50 lg:min-h-9 lg:flex-none',
                                confirming === 'receive' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
                              )}
                            >
                              {busy
                                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                : confirming === 'receive'
                                  ? <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
                                  : <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />}
                              {confirming === 'receive' ? 'Sí, recibir' : 'Sí, cancelar'}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setTransitConfirm({ key: group.key, action: 'cancel' })}
                              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-base bg-secondary px-3 text-[11px] font-black uppercase tracking-wide text-secondary transition-colors hover:bg-subtle disabled:opacity-50 lg:min-h-9 lg:flex-none"
                            >
                              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> Cancelar
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setTransitConfirm({ key: group.key, action: 'receive' })}
                              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-[11px] font-black uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50 lg:min-h-9 lg:flex-none"
                            >
                              {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />}
                              Recibir
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-xs">
            <div className="flex items-center justify-between gap-2 border-b border-base bg-subtle/60 px-3 py-2.5">
              <span className="flex min-w-0 items-center gap-2 text-[12px] font-black uppercase tracking-wide text-primary">
                <History className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                <span className="truncate">
                  {historyMode === 'branch' ? `Movimientos de ${branchLabel(branchFilter)}` : 'Historial de movimientos'}
                </span>
              </span>
              <span className="shrink-0 text-[11px] font-bold text-muted">
                {historyGroups.length} operaci{historyGroups.length === 1 ? 'ón' : 'ones'}
              </span>
            </div>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[840px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-base bg-subtle text-[11px] font-black uppercase tracking-wider text-muted">
                    <th className="px-3 py-2.5">Fecha y hora</th>
                    <th className="px-3 py-2.5">Ruta</th>
                    <th className="px-3 py-2.5 text-center">Cantidad</th>
                    <th className="px-3 py-2.5">Productos</th>
                    <th className="px-3 py-2.5 text-center">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base">
                  {historyGroups.length > 0 ? historyGroups.map((group) => {
                    const isExpanded = expandedBatches.includes(group.key);
                    const visibleItems = isExpanded ? group.rows : group.rows.slice(0, 2);
                    const hasMore = group.rows.length > 2;
                    return (
                      <tr key={group.key} className="transition-colors hover:bg-subtle/60">
                        <td className="whitespace-nowrap px-3 py-3 align-top">
                          <p className="text-[12px] font-black text-primary">{group.dateLabel}</p>
                          <p className="font-mono text-[11px] text-muted">{group.timeLabel}</p>
                          <p className="font-mono text-[10px] font-black uppercase tracking-wide text-[var(--primary)]">{documentCode('TR', group.first.id)}</p>
                          {group.rows.length > 1 && (
                            <span className="palmyra-pill mt-1 border-[color-mix(in_srgb,var(--primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--bg-secondary))] text-[var(--primary)]">
                              Lote de {group.rows.length}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="palmyra-pill max-w-[150px] border border-base bg-secondary text-secondary" title={group.first.fromBranchName}>
                              {group.first.fromBranchName}
                            </span>
                            <ArrowRight className="h-3 w-3 shrink-0 text-[var(--primary)]" aria-hidden="true" />
                            <span className="palmyra-pill max-w-[150px] border-[color-mix(in_srgb,var(--primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--bg-secondary))] text-[var(--primary)]" title={group.first.toBranchName}>
                              {group.first.toBranchName}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex flex-col items-center gap-1">
                            <span className="palmyra-pill whitespace-nowrap border-transparent bg-[var(--text-primary)] text-[var(--text-inverse)] tabular-nums">{group.totalQty} uds</span>
                            {group.direction && <DirectionBadge direction={group.direction} />}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex max-w-md flex-wrap gap-1.5">
                            {visibleItems.map((row) => (
                              <div key={row.id} className="flex min-w-0 max-w-[240px] items-center gap-1 rounded-md border border-base bg-subtle px-2 py-1">
                                <span className="truncate text-[11px] font-bold text-primary" title={row.productName}>{row.productName}</span>
                                {row.variantLabel && (
                                  <span className="shrink-0 text-[11px] font-black uppercase text-violet-600 dark:text-violet-300">{row.variantLabel}</span>
                                )}
                                <span className="shrink-0 text-[11px] font-black text-muted">({row.quantity})</span>
                              </div>
                            ))}
                            {hasMore && (
                              <button
                                type="button"
                                onClick={() => toggleBatch(group.key)}
                                className="rounded-md border border-violet-200 bg-secondary px-2 py-1 text-[11px] font-black uppercase text-violet-700 transition-all hover:bg-violet-50 active:scale-95 dark:border-violet-900/60 dark:text-violet-300"
                              >
                                {isExpanded ? 'Mostrar menos' : `Ver ${group.rows.length - 2} más`}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center align-top">
                          <StatusBadge status={group.first.status} />
                        </td>
                      </tr>
                    );
                  }) : (
                    <tr>
                      <td colSpan={5} className="px-6 py-14 text-center">
                        <div className="flex flex-col items-center gap-1.5 text-muted">
                          <ArrowLeftRight className="h-10 w-10 opacity-30" aria-hidden="true" />
                          <p className="text-[12px] font-black uppercase tracking-wider">Sin registros de transferencia</p>
                          <p className="max-w-xs text-[11px] font-semibold">
                            {historySearch || historyMode === 'branch'
                              ? 'Cambia la sucursal o la búsqueda para ver otros movimientos.'
                              : 'Usa «Nuevo traslado» para mover stock entre tus almacenes.'}
                          </p>
                          <button
                            type="button"
                            disabled={isSyncing}
                            onClick={() => void retrySync()}
                            className="mt-2 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary px-4 text-[11px] font-black uppercase tracking-wide text-secondary transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isSyncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                            {isSyncing ? 'Sincronizando…' : 'Reintentar carga'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-base lg:hidden">
              {historyGroups.length > 0 ? historyGroups.map((group) => {
                const isExpanded = expandedBatches.includes(group.key);
                const visibleItems = isExpanded ? group.rows : group.rows.slice(0, 2);
                const hasMore = group.rows.length > 2;
                return (
                  <li key={group.key} className="space-y-2 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-black text-primary">
                          {group.dateLabel} · {group.timeLabel}
                        </p>
                        <p className="font-mono text-[10px] font-black uppercase tracking-wide text-muted">{documentCode('TR', group.first.id)}</p>
                        {group.rows.length > 1 && (
                          <span className="palmyra-pill mt-0.5 border-[color-mix(in_srgb,var(--primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--bg-secondary))] text-[var(--primary)]">
                            Lote de {group.rows.length}
                          </span>
                        )}
                      </div>
                      <StatusBadge status={group.first.status} />
                    </div>

                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="palmyra-pill min-w-0 flex-1 border border-base bg-subtle text-secondary" title={group.first.fromBranchName}>
                        {group.first.fromBranchName}
                      </span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-[var(--primary)]" aria-hidden="true" />
                      <span className="palmyra-pill min-w-0 flex-1 border-[color-mix(in_srgb,var(--primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--bg-secondary))] text-[var(--primary)]" title={group.first.toBranchName}>
                        {group.first.toBranchName}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 rounded-lg border border-base bg-subtle px-2.5 py-1.5">
                      <span className="text-[10px] font-black uppercase tracking-wider text-muted">Cantidad</span>
                      <span className="flex items-center gap-1.5">
                        <span className="palmyra-pill border-transparent bg-[var(--text-primary)] text-[var(--text-inverse)] tabular-nums">{group.totalQty} uds</span>
                        {group.direction && <DirectionBadge direction={group.direction} />}
                      </span>
                    </div>

                    <div className="space-y-1">
                      {visibleItems.map((row) => (
                        <div key={row.id} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                          <span className="min-w-0 flex-1 truncate font-bold text-primary" title={row.productName}>{row.productName}</span>
                          {row.variantLabel && <span className="shrink-0 font-black uppercase text-violet-600 dark:text-violet-300">{row.variantLabel}</span>}
                          <span className="shrink-0 font-black text-muted">{row.quantity} uds</span>
                        </div>
                      ))}
                      {hasMore && (
                        <button
                          type="button"
                          onClick={() => toggleBatch(group.key)}
                          className="min-h-10 rounded-md border border-violet-200 bg-secondary px-3 text-[11px] font-black uppercase text-violet-700 dark:border-violet-900/60 dark:text-violet-300"
                        >
                          {isExpanded ? 'Mostrar menos' : `Ver ${group.rows.length - 2} más`}
                        </button>
                      )}
                    </div>
                  </li>
                );
              }) : (
                <li className="px-6 py-12 text-center">
                  <ArrowLeftRight className="mx-auto h-10 w-10 opacity-30 text-muted" aria-hidden="true" />
                  <p className="mt-2 text-[12px] font-black uppercase tracking-wider text-muted">Sin registros de transferencia</p>
                  <p className="mt-1 text-[11px] font-semibold text-muted">
                    {historySearch || historyMode === 'branch'
                      ? 'Cambia la sucursal o la búsqueda para ver otros movimientos.'
                      : 'Usa «Nuevo traslado» para mover stock entre tus almacenes.'}
                  </p>
                  <button
                    type="button"
                    disabled={isSyncing}
                    onClick={() => void retrySync()}
                    className="mt-3 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary px-4 text-[11px] font-black uppercase tracking-wide text-secondary transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSyncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                    {isSyncing ? 'Sincronizando…' : 'Reintentar carga'}
                  </button>
                </li>
              )}
            </ul>
          </section>
        </>
      ) : (
        <div className="space-y-4">
          <section className="rounded-2xl border border-base bg-secondary p-3 shadow-xs sm:p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block min-w-0">
                <span className="mb-1 block px-1 text-[11px] font-black uppercase tracking-widest text-muted">Origen de mercancía</span>
                <div className="relative">
                  <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <select
                    value={bulkTransferSourceId}
                    onChange={(event) => {
                      setBulkTransferSourceId(event.target.value);
                      setBulkTransferItems([]);
                    }}
                    className="min-h-10 w-full appearance-none truncate rounded-xl border border-base bg-subtle pl-9 pr-3 text-[12px] font-black uppercase text-primary"
                  >
                    {allowedBranches.map((branch) => (
                      <option key={branch.id} value={branch.id}>{branchLabel(branch.id, branch.name)}</option>
                    ))}
                  </select>
                </div>
              </label>
              <label className="block min-w-0">
                <span className="mb-1 block px-1 text-[11px] font-black uppercase tracking-widest text-muted">Destino de mercancía</span>
                <div className="relative">
                  <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-violet-500" aria-hidden="true" />
                  <select
                    value={bulkTransferTargetId}
                    onChange={(event) => setBulkTransferTargetId(event.target.value)}
                    className="min-h-10 w-full appearance-none truncate rounded-xl border border-violet-200 bg-subtle pl-9 pr-3 text-[12px] font-black uppercase text-primary dark:border-violet-900/60"
                  >
                    <option value="">Seleccionar destino…</option>
                    {allowedBranches.filter((branch) => branch.id !== bulkTransferSourceId).map((branch) => (
                      <option key={branch.id} value={branch.id}>{branchLabel(branch.id, branch.name)}</option>
                    ))}
                  </select>
                </div>
              </label>
            </div>
            <button
              type="button"
              disabled={isExecutingTransfer || bulkTransferItems.length === 0 || !bulkTransferTargetId}
              onClick={async () => {
                setIsExecutingTransfer(true);
                try {
                  const result = await transferProductsBulk(
                    bulkTransferSourceId,
                    bulkTransferTargetId,
                    bulkTransferItems.map((item) => ({
                      productId: item.productId,
                      quantity: item.quantity,
                      variant: item.variant,
                    }))
                  );
                  if (result.success) {
                    addNotification(
                      'Mercancía enviada. Queda en tránsito hasta que el almacén de destino confirme la recepción.',
                      'success'
                    );
                    setBulkTransferItems([]);
                    setBulkTransferTargetId('');
                    setActiveTab('history');
                  } else {
                    addNotification(result.error || 'Error al realizar el traslado masivo.', 'error');
                  }
                } catch {
                  addNotification('Error al procesar el traslado.', 'error');
                } finally {
                  setIsExecutingTransfer(false);
                }
              }}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 text-[12px] font-black uppercase tracking-widest text-white shadow-md transition-all hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {isExecutingTransfer ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />}
              Confirmar envío ({bulkTransferItems.length} artículo{bulkTransferItems.length === 1 ? '' : 's'})
            </button>
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_320px]">
            <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-base bg-secondary shadow-xs">
              <div className="border-b border-base p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="Buscar productos por nombre o SKU…"
                    value={transferSearch}
                    onChange={(event) => setTransferSearch(event.target.value)}
                    aria-label="Buscar productos para transferir"
                    className="min-h-10 w-full rounded-xl border border-base bg-subtle pl-9 pr-3 text-[12px] font-bold text-primary"
                  />
                </div>
              </div>
              <div className="max-h-[min(78vh,820px)] min-h-[320px] flex-1 overflow-y-auto p-3">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {visibleProducts.map(({ product, bestVariant, stock }) => (
                    <button
                      key={product.id}
                      type="button"
                      disabled={stock <= 0}
                      onClick={() => {
                        if (stock <= 0) return;
                        setBulkTransferItems((prev) => [...prev, { productId: product.id, quantity: 1, variant: bestVariant || undefined }]);
                      }}
                      className={cn(
                        'flex min-w-0 flex-col gap-2 rounded-xl border p-2.5 text-left shadow-xs transition-all',
                        stock > 0
                          ? 'border-base bg-secondary hover:border-violet-400 hover:shadow-md'
                          : 'cursor-not-allowed border-base bg-subtle opacity-60 grayscale'
                      )}
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-[12px] font-black uppercase text-primary" title={product.name}>{product.name}</p>
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      </div>
                      <div className="mt-auto flex items-center justify-between border-t border-base pt-1.5">
                        <span className="text-[11px] font-bold uppercase tracking-tight text-muted">{bestVariant ? `Stock · ${bestVariant}` : 'Stock disponible'}</span>
                        <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-black', stock > 0 ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300' : 'bg-subtle text-muted')}>
                          {stock} uds
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
                {visibleProducts.length === 0 && (
                  <div className="flex flex-col items-center gap-1.5 py-10 text-center text-muted">
                    <Package className="h-9 w-9 opacity-30" aria-hidden="true" />
                    <p className="text-[12px] font-black uppercase tracking-wider">Sin productos disponibles</p>
                    <p className="text-[11px] font-semibold">Prueba otro origen o cambia la búsqueda.</p>
                  </div>
                )}
              </div>
            </section>

            <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-base bg-secondary shadow-xs">
              <div className="flex items-center justify-between gap-2 border-b border-base bg-subtle/60 p-3">
                <h3 className="flex min-w-0 items-center gap-2 text-[12px] font-black uppercase tracking-wide text-primary">
                  <ArrowLeftRight className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                  Lista de envío
                </h3>
                <span className="shrink-0 rounded-lg bg-violet-600 px-2 py-1 text-[11px] font-black text-white">{bulkTransferItems.length} ítems</span>
              </div>
              <div className="max-h-[min(78vh,820px)] flex-1 space-y-2.5 overflow-y-auto p-3">
                {bulkTransferItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted">
                    <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-subtle">
                      <ArrowLeftRight className="h-7 w-7 opacity-40" aria-hidden="true" />
                    </span>
                    <p className="text-[12px] font-black uppercase tracking-wider">Lista de envío vacía</p>
                    <p className="max-w-[220px] text-[11px] font-semibold">Selecciona productos de la izquierda para comenzar el traslado.</p>
                  </div>
                ) : shipments.map(({ item, product, variants, stock }, index) => {
                  const selectedVariant = String(item.variant || '');
                  const rowKey = `${item.productId}:${selectedVariant}`;
                  return (
                    <div key={rowKey} className="rounded-xl border border-base bg-secondary p-3 shadow-xs animate-in slide-in-from-right-2 duration-200">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-[12px] font-black uppercase text-primary" title={product.name}>{product.name}</p>
                        <button
                          type="button"
                          onClick={() => setBulkTransferItems((prev) => prev.filter((_, idx) => idx !== index))}
                          aria-label={`Quitar ${product.name} del envío`}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-500 transition-colors hover:bg-rose-100 hover:text-rose-600 dark:bg-rose-950/40 dark:text-rose-300"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      {variants.length > 1 && (
                        <select
                          value={selectedVariant}
                          onChange={(event) => {
                            const nextVariant = event.target.value;
                            const nextStock = stockAt(item.productId, bulkTransferSourceId, nextVariant);
                            setBulkTransferItems((prev) => {
                              const duplicate = prev.some((candidate, candidateIndex) =>
                                candidateIndex !== index &&
                                candidate.productId === item.productId &&
                                (candidate.variant || '') === nextVariant
                              );
                              if (duplicate) return prev;
                              return prev.map((candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? { ...candidate, variant: nextVariant, quantity: Math.max(1, Math.min(candidate.quantity, Math.max(1, nextStock))) }
                                  : candidate
                              );
                            });
                          }}
                          aria-label={`Variante de ${product.name}`}
                          className="mb-2 min-h-9 w-full truncate rounded-lg border border-violet-200 bg-subtle px-2 text-[11px] font-black uppercase text-violet-700 dark:border-violet-900/60 dark:text-violet-300"
                        >
                          {variants.map((variant) => (
                            <option key={variant} value={variant}>
                              {variant || 'Sin variante'} — {stockAt(item.productId, bulkTransferSourceId, variant)} uds
                            </option>
                          ))}
                        </select>
                      )}
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-base bg-subtle p-2">
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-black uppercase leading-none text-muted">{selectedVariant ? `Disponible · ${selectedVariant}` : 'Disponible'}</p>
                          <p className="mt-1 text-[11px] font-black text-primary">{stock} uds</p>
                        </div>
                        <div className="flex items-center gap-1 rounded-lg border border-base bg-secondary p-1">
                          <button
                            type="button"
                            onClick={() => updateShipmentQuantity(index, item.quantity - 1, stock)}
                            aria-label="Reducir cantidad"
                            className="flex h-11 w-11 items-center justify-center rounded-md text-secondary transition-colors hover:bg-subtle hover:text-violet-600 lg:h-8 lg:w-8"
                          >
                            <Minus className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={stock}
                            value={item.quantity}
                            aria-label={`Cantidad a transferir de ${product.name}`}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => {
                              if (event.currentTarget.value === '' || stock <= 0) return;
                              const requested = Math.floor(Number(event.currentTarget.value));
                              if (!Number.isFinite(requested)) return;
                              updateShipmentQuantity(index, requested, stock);
                            }}
                            className="h-11 w-11 border-0 bg-transparent p-0 text-center text-[13px] font-black tabular-nums text-primary focus:ring-0 lg:h-8"
                          />
                          <button
                            type="button"
                            onClick={() => updateShipmentQuantity(index, item.quantity + 1, stock)}
                            aria-label="Aumentar cantidad"
                            className="flex h-11 w-11 items-center justify-center rounded-md text-secondary transition-colors hover:bg-subtle hover:text-violet-600 lg:h-8 lg:w-8"
                          >
                            <Plus className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
    </PlanFeatureGate>
  );
}
