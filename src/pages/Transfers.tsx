import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState, useEffect } from "react";
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
  HelpCircle,
  Activity,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  TrendingDown,
  TrendingUp,
  Boxes,
  Building2,
  X,
  Minus
} from "lucide-react";
import { useStore } from "../store/useStore";
import { InfoTooltip } from "../components/InfoTooltip";
import { cn } from "../lib/utils";

export default function Transfers() {
  const { 
    branches, 
    products, 
    inventory, 
    transferInventory,
    transferInventoryBatch, 
    transferProductsBulk,
    transfers, 
    currentBranchId,
    addNotification,
    users
  } = useStore(useShallow((state) => ({ branches: state.branches, products: state.products, inventory: state.inventory, transferInventory: state.transferInventory, transferInventoryBatch: state.transferInventoryBatch, transferProductsBulk: state.transferProductsBulk, transfers: state.transfers, currentBranchId: state.currentBranchId, addNotification: state.addNotification, users: state.users })));

  const getBranchDisplayName = (b: { id: string; name: string }) => {
    const assignedUser = (users || []).find(u => u.branchId === b.id);
    return assignedUser ? `${b.name} (${assignedUser.name})` : b.name;
  };

  const [activeTab, setActiveTab] = useState<'history' | 'new'>('history');
  const [bulkTransferItems, setBulkTransferItems] = useState<{ productId: string, quantity: number, variant?: string }[]>([]);
  const [bulkTransferSourceId, setBulkTransferSourceId] = useState(currentBranchId || (branches[0]?.id || ''));
  const [bulkTransferTargetId, setBulkTransferTargetId] = useState("");
  const [transferSearch, setTransferSearch] = useState("");
  const [isExecutingTransfer, setIsExecutingTransfer] = useState(false);
  const [expandedBatches, setExpandedBatches] = useState<string[]>([]);
  
  const [showAddModal, setShowAddModal] = useState(false);
  
  const [formData, setFormData] = useState({
    productId: '',
    fromBranchId: currentBranchId || (branches[0]?.id || ''),
    toBranchId: '',
  });
  const [variantQuantities, setVariantQuantities] = useState<{ [key: string]: number }>({});
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const effectiveFromBranchId = formData.fromBranchId || (branches.length > 0 ? branches[0].id : '');
  const effectiveToBranchId = formData.toBranchId;
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const branchById = useMemo(() => new Map(branches.map(branch => [branch.id, branch])), [branches]);
  const selectedProduct = productById.get(formData.productId);
  const fromBranch = branchById.get(effectiveFromBranchId);
  const toBranch = branchById.get(effectiveToBranchId);

  useEffect(() => {
    if (showAddModal) {
      // Logic when modal opens (resetting etc)
    }
  }, [showAddModal]);

  // Calculate live available stock in source branch
  const hasVariants = (selectedProduct?.availableSizes?.length || 0) + (selectedProduct?.availableColors?.length || 0) > 0;
  const variantsList: string[] = hasVariants 
    ? Array.from(new Set([...(selectedProduct?.availableSizes || []), ...(selectedProduct?.availableColors || [])]))
    : [''];

  const getSourceStockForVariant = (variantLabel: string = ''): number => {
    if (!selectedProduct || !effectiveFromBranchId) return 0;
    const item = inventory.find(
      i => i.productId === selectedProduct.id && 
           i.branchId === effectiveFromBranchId && 
           (i.variantLabel || '') === (variantLabel || '')
    );
    return item ? Number(item.quantity) : 0;
  };

  const getTargetStockForVariant = (variantLabel: string = ''): number => {
    if (!selectedProduct || !effectiveToBranchId) return 0;
    const item = inventory.find(
      i => i.productId === selectedProduct.id && 
           i.branchId === effectiveToBranchId && 
           (i.variantLabel || '') === (variantLabel || '')
    );
    return item ? Number(item.quantity) : 0;
  };

  const totalSourceStock: number = variantsList.reduce((acc: number, v: string) => acc + getSourceStockForVariant(v), 0);
  const totalTargetStock: number = effectiveToBranchId 
    ? variantsList.reduce((acc: number, v: string) => acc + getTargetStockForVariant(v), 0) 
    : 0;

  const totalTransferring: number = Object.keys(variantQuantities).reduce((acc: number, key: string) => {
    const val = Number(variantQuantities[key]);
    return acc + (isNaN(val) ? 0 : val);
  }, 0);

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!effectiveFromBranchId || !effectiveToBranchId) {
      setError("Debes seleccionar tanto la sucursal de origen como la de destino.");
      return;
    }

    if (effectiveFromBranchId === effectiveToBranchId) {
      setError("La sucursal de origen y destino no pueden ser la misma.");
      return;
    }

    if (!selectedProduct) {
      setError("Debes seleccionar un producto válido.");
      return;
    }

    const variantsToTransfer: [string, number][] = hasVariants 
      ? Object.entries(variantQuantities)
          .map(([v, qty]): [string, number] => [v, Number(qty) || 0])
          .filter(([_, qty]) => qty > 0) 
      : [['', Number(variantQuantities['']) || 0]];

    if (variantsToTransfer.length === 0 || variantsToTransfer.every(([_, qty]) => qty <= 0)) {
      setError("Debes ingresar una cantidad mayor a 0 para transferir.");
      return;
    }

    // Live verification: Check that no variant exceeds current source stock
    for (const [variant, qty] of variantsToTransfer) {
      const available = getSourceStockForVariant(variant);
      if (qty > available) {
        setError(`No hay suficiente stock en origen para ${variant ? `la variante "${variant}"` : 'este producto'}. Disponible: ${available} uds, intentas transferir: ${qty} uds.`);
        return;
      }
    }

    setIsSubmitting(true);
    const variantsPayload = variantsToTransfer.map(([v, q]) => ({ variantLabel: v, quantity: q }));

    const result = await transferInventoryBatch(
      formData.productId,
      effectiveFromBranchId,
      effectiveToBranchId,
      variantsPayload
    );

    setIsSubmitting(false);

    if (result.success) {
      addNotification(
        (result as any).pending
          ? "Traslado guardado offline. Quedó pendiente de confirmación con la nube."
          : "Traslado individual completado exitosamente.",
        (result as any).pending ? 'info' : 'success'
      );
      setShowAddModal(false);
      setFormData({ ...formData, productId: '' });
      setVariantQuantities({});
      setError("");
    } else {
      setError(result.error || "No se pudo completar la transferencia. Revisa el stock disponible.");
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-20 p-4 sm:p-6 max-w-full overflow-x-hidden bg-slate-50/50 min-h-screen">
      
      {/* Header */}
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-secondary p-4 sm:p-5 rounded-2xl border border-base shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-md shadow-indigo-100 dark:shadow-none shrink-0">
            <ArrowLeftRight className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg sm:text-xl font-black text-primary tracking-tight uppercase leading-none">Transferencias</h2>
            <p className="text-[9px] font-bold text-muted uppercase tracking-widest mt-1">Gestión de inventario entre sucursales</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
          <div className="flex bg-subtle p-1 rounded-xl border border-base">
            <button
              onClick={() => setActiveTab('history')}
              className={cn(
                "px-3.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer",
                activeTab === 'history' ? "bg-secondary text-indigo-600 shadow-xs border border-base" : "text-muted hover:text-primary"
              )}
            >
              Historial
            </button>
            <button
              onClick={() => setActiveTab('new')}
              className={cn(
                "px-3.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer",
                activeTab === 'new' ? "bg-secondary text-indigo-600 shadow-xs border border-base" : "text-muted hover:text-primary"
              )}
            >
              Nuevo Traslado
            </button>
          </div>
          <button 
            type="button"
            onClick={() => {
              setShowAddModal(true);
              setError("");
              if (products.length > 0 && !formData.productId) {
                setFormData(prev => ({ ...prev, productId: products[0].id }));
              }
            }}
            className="btn-primary"
          >
            <Plus className="w-3.5 h-3.5" />
            Traslado Individual
          </button>
        </div>
      </header>

      {activeTab === 'history' ? (
        /* Main Content Grid */
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Left Column: Transfer History */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-white">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center">
                    <History className="w-4 h-4 text-indigo-600" />
                  </div>
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">Historial de Movimientos</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">
                    {transfers.length} Operaciones
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50/80 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                      <th className="px-6 py-4">Fecha / Hora</th>
                      <th className="px-6 py-4">Ruta y Cantidad Total</th>
                      <th className="px-6 py-4">Detalle de Productos</th>
                      <th className="px-6 py-4 text-center">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {transfers.length > 0 ? (() => {
                      const grouped = transfers.reduce((acc, t) => {
                        const key = t.batchId || t.id;
                        if (!acc[key]) acc[key] = [];
                        acc[key].push(t);
                        return acc;
                      }, {} as Record<string, typeof transfers>);

                      const sortedGroups = Object.values(grouped).sort((a, b) => 
                        new Date(b[0].date).getTime() - new Date(a[0].date).getTime()
                      );

                      return sortedGroups.map(group => {
                        const first = group[0];
                        const isBatch = group.length > 1;
                        const isExpanded = expandedBatches.includes(first.batchId || first.id);
                        const totalQty = group.reduce((sum, t) => sum + t.quantity, 0);
                        const visibleItems = isExpanded ? group : group.slice(0, 2);
                        const hasMore = group.length > 2;

                        return (
                          <React.Fragment key={first.batchId || first.id}>
                            <tr className={cn(
                              "hover:bg-slate-50/60 transition-colors group border-l-4",
                              isBatch ? "border-l-indigo-500" : "border-l-transparent"
                            )}>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-[11px] font-bold text-slate-900">{new Date(first.date).toLocaleDateString()}</div>
                                <div className="text-[9px] font-mono text-slate-400">{new Date(first.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                                {isBatch && (
                                  <div className="mt-1">
                                    <span className="text-[8px] font-black uppercase text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100">
                                      Lote de {group.length}
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-2">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] font-black text-slate-700 uppercase bg-white px-2 py-1 rounded border border-slate-200 shadow-sm">
                                      {first.fromBranchName}
                                    </span>
                                    <ArrowRight className="w-3 h-3 text-indigo-400 shrink-0" />
                                    <span className="text-[10px] font-black text-indigo-700 uppercase bg-indigo-50 px-2 py-1 rounded border border-indigo-100 shadow-sm">
                                      {first.toBranchName}
                                    </span>
                                  </div>
                                  <span className="ml-2 text-[10px] font-black bg-slate-900 text-white px-2 py-1 rounded-lg">
                                    {totalQty} UDS
                                  </span>
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex flex-wrap gap-2 max-w-md">
                                  {visibleItems.map((t) => (
                                    <div key={t.id} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 px-2 py-1 rounded-md">
                                      <span className="text-[10px] font-bold text-slate-800 truncate max-w-[120px]">{t.productName}</span>
                                      {t.variantLabel && (
                                        <span className="text-[8px] font-black text-indigo-500 uppercase">{t.variantLabel}</span>
                                      )}
                                      <span className="text-[9px] font-black text-slate-400">({t.quantity})</span>
                                    </div>
                                  ))}
                                  
                                  {hasMore && (
                                    <button 
                                      onClick={() => {
                                        if (isExpanded) {
                                          setExpandedBatches(prev => prev.filter(id => id !== (first.batchId || first.id)));
                                        } else {
                                          setExpandedBatches(prev => [...prev, first.batchId || first.id]);
                                        }
                                      }}
                                      className="text-[9px] font-black text-indigo-600 hover:text-indigo-700 bg-white border border-indigo-100 px-2 py-1 rounded-md transition-all active:scale-95"
                                    >
                                      {isExpanded ? "MOSTRAR MENOS" : `VER ${group.length - 2} MÁS`}
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td className="px-6 py-4 text-center">
                                {first.status === 'pending' ? (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-black text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
                                    <Clock className="w-3 h-3 text-amber-600" />
                                    PENDIENTE
                                  </span>
                                ) : first.status === 'cancelled' ? (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-black text-rose-700 bg-rose-50 px-2.5 py-1 rounded-full border border-rose-200">
                                    <AlertTriangle className="w-3 h-3 text-rose-600" />
                                    CONFLICTO
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-black text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                                    <CheckCircle className="w-3 h-3 text-emerald-600" />
                                    OK
                                  </span>
                                )}
                              </td>
                            </tr>
                          </React.Fragment>
                        );
                      });
                    })() : (
                      <tr>
                        <td colSpan={5} className="px-6 py-16 text-center">
                          <div className="flex flex-col items-center justify-center text-slate-300">
                            <ArrowLeftRight className="w-12 h-12 mb-3 text-slate-200" />
                            <p className="text-xs font-black uppercase tracking-widest text-slate-400">Sin registros de transferencia</p>
                            <p className="text-xs text-slate-400 mt-1 max-w-xs">Usa el botón "Nueva Transferencia" para mover stock entre tus almacenes de manera segura.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right Column: System Status & Diagnostic Summary */}
          <div className="space-y-4">
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-900 mb-5 flex items-center justify-between border-b border-slate-100 pb-3">
                <span>Métricas de Operación</span>
                <Activity className="w-4 h-4 text-indigo-600" />
              </h3>
              
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center border border-slate-200 shadow-xs">
                    <Package className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-black text-slate-900 leading-none">{transfers.length}</p>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mt-1">Transferencias Totales</p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center border border-slate-200 shadow-xs">
                    <Building2 className="w-6 h-6 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-black text-slate-900 leading-none">{branches.length}</p>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mt-1">Puntos de Distribución</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 p-6 rounded-2xl text-white shadow-xl">
              <h3 className="text-xs font-black text-indigo-300 uppercase tracking-widest flex items-center gap-2 mb-4">
                <Boxes className="w-4 h-4" />
                Seguridad de Inventario
              </h3>
              <div className="space-y-4 text-[11px]">
                <div className="flex gap-3 items-start">
                  <div className="w-5 h-5 bg-emerald-500/20 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  </div>
                  <p className="font-medium text-slate-300">
                    <strong className="text-white block mb-0.5 uppercase tracking-wide">Validación Atómica</strong>
                    El stock se verifica en tiempo real antes de cada movimiento.
                  </p>
                </div>
                <div className="flex gap-3 items-start">
                  <div className="w-5 h-5 bg-emerald-500/20 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  </div>
                  <p className="font-medium text-slate-300">
                    <strong className="text-white block mb-0.5 uppercase tracking-wide">Trazabilidad Total</strong>
                    Cada transferencia genera un registro inmutable con ID de lote.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-300">
          <div className="p-5 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 flex flex-col lg:flex-row gap-5 shrink-0">
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5 px-1">Origen de Mercancía</label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <select 
                    value={bulkTransferSourceId}
                    onChange={(e) => {
                      setBulkTransferSourceId(e.target.value);
                      setBulkTransferItems([]); 
                    }}
                    className="w-full bg-white dark:bg-slate-800 border border-slate-200 rounded-xl pl-10 pr-3 py-3 text-xs font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500 shadow-sm appearance-none"
                  >
                    {branches.map(b => (
                      <option key={b.id} value={b.id}>{getBranchDisplayName(b)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5 px-1">Destino de Mercancía</label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400" />
                  <select 
                    value={bulkTransferTargetId}
                    onChange={(e) => setBulkTransferTargetId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-800 border border-indigo-100 rounded-xl pl-10 pr-3 py-3 text-xs font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500 shadow-sm appearance-none"
                  >
                    <option value="">Seleccionar destino...</option>
                    {branches.filter(b => b.id !== bulkTransferSourceId).map(b => (
                      <option key={b.id} value={b.id}>{getBranchDisplayName(b)}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex items-end gap-2">
              <button
                disabled={isExecutingTransfer || bulkTransferItems.length === 0 || !bulkTransferTargetId}
                onClick={async () => {
                  setIsExecutingTransfer(true);
                  try {
                    const result = await transferProductsBulk(
                      bulkTransferSourceId, 
                      bulkTransferTargetId, 
                      bulkTransferItems.map(item => ({
                        productId: item.productId,
                        quantity: item.quantity,
                        variant: item.variant
                      }))
                    );
                    
                    if (result.success) {
                      addNotification(
                        (result as any).pending
                          ? 'Traslado masivo guardado offline. Quedó pendiente de confirmación con la nube.'
                          : 'Traslado masivo completado exitosamente.',
                        (result as any).pending ? 'info' : 'success'
                      );
                      setBulkTransferItems([]);
                      setActiveTab('history');
                    } else {
                      addNotification(result.error || "Error al realizar el traslado masivo.", 'error');
                    }
                  } catch (err) {
                    addNotification("Error al procesar el traslado.", 'error');
                  } finally {
                    setIsExecutingTransfer(false);
                  }
                }}
                className="w-full lg:w-auto px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2 cursor-pointer h-[42px]"
              >
                {isExecutingTransfer ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ArrowLeftRight className="w-3.5 h-3.5" />}
                Confirmar Envío ({bulkTransferItems.length} tipos)
              </button>
            </div>
          </div>

          <div className="flex-1 flex flex-col lg:flex-row min-h-0">
            <div className="flex-1 flex flex-col border-r border-slate-200 min-h-0 bg-slate-50/30 dark:bg-slate-900/30">
              <div className="p-4 border-b border-slate-200 bg-white dark:bg-slate-900/50">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                  <input 
                    type="text" 
                    placeholder="Buscar productos por nombre o SKU..."
                    value={transferSearch}
                    onChange={(e) => setTransferSearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 rounded-xl text-xs font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500 shadow-xs transition-all"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-auto p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {products
                    .filter(p => 
                      !bulkTransferItems.some(item => item.productId === p.id && (!item.variant || item.variant === '')) &&
                      (p.name.toLowerCase().includes(transferSearch.toLowerCase()) || 
                       p.sku?.toLowerCase().includes(transferSearch.toLowerCase()))
                    )
                    .slice(0, 21)
                    .map(product => {
                      const productVariants = Array.from(new Set([
                        ...(product.availableSizes || []),
                        ...(product.availableColors || [])
                      ])).map(v => String(v).trim()).filter(Boolean);
                      const cardVariants = productVariants.length ? productVariants : [''];
                      const availableVariant = cardVariants.find(v => {
                        const row = inventory.find(inv =>
                          inv.productId === product.id &&
                          inv.branchId === bulkTransferSourceId &&
                          (inv.variantLabel || '') === v
                        );
                        return Number(row?.quantity || 0) > 0;
                      });
                      const stock = availableVariant === undefined ? 0 : Number(
                        inventory.find(inv =>
                          inv.productId === product.id &&
                          inv.branchId === bulkTransferSourceId &&
                          (inv.variantLabel || '') === availableVariant
                        )?.quantity || 0
                      );
                      return (
                        <button
                          key={product.id}
                          disabled={stock <= 0}
                          onClick={() => {
                            if (availableVariant === undefined) return;
                            setBulkTransferItems(prev => [
                              ...prev,
                              { productId: product.id, quantity: 1, variant: availableVariant || undefined }
                            ]);
                          }}
                          className={cn(
                            "p-4 rounded-xl border text-left transition-all group flex flex-col gap-2 shadow-sm",
                            stock > 0 
                              ? "bg-white dark:bg-slate-800 border-slate-200 hover:border-indigo-500 hover:shadow-md cursor-pointer" 
                              : "bg-slate-100 dark:bg-slate-900 border-slate-100 opacity-60 grayscale cursor-not-allowed"
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[11px] font-black text-slate-900 dark:text-slate-100 uppercase truncate leading-tight">{product.name}</p>
                            <div className="w-6 h-6 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                              <Plus className="w-3.5 h-3.5 text-indigo-600" />
                            </div>
                          </div>
                          <div className="flex items-center justify-between mt-auto pt-2 border-t border-slate-50 dark:border-slate-700/50">
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">Stock Origen</span>
                            <span className={cn(
                              "text-[10px] font-black px-2 py-0.5 rounded-md",
                              stock > 0 ? "text-indigo-600 bg-indigo-50" : "text-slate-400 bg-slate-100"
                            )}>{stock} uds</span>
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            </div>

            <div className="w-full lg:w-96 flex flex-col bg-white dark:bg-slate-900 min-h-0 border-l border-slate-200">
              <div className="p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50 dark:bg-slate-800/30 shrink-0">
                <h3 className="text-xs font-black text-slate-900 dark:text-slate-100 uppercase tracking-widest flex items-center gap-2">
                  <ArrowLeftRight className="w-4 h-4 text-indigo-600" />
                  Lista de Envío
                </h3>
                <span className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-[10px] font-black shadow-sm">
                  {bulkTransferItems.length} items
                </span>
              </div>
              <div className="flex-1 overflow-auto p-5 space-y-3">
                {bulkTransferItems.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-40">
                    <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                      <ArrowLeftRight className="w-8 h-8 text-slate-300" />
                    </div>
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Lista de Envío Vacía</p>
                    <p className="text-[10px] text-slate-400 mt-2 font-medium">Selecciona productos de la izquierda para comenzar el traslado.</p>
                  </div>
                ) : (
                  bulkTransferItems.map((item, index) => {
                    const product = products.find(p => p.id === item.productId);
                    const productVariants = Array.from(new Set([
                      ...(product?.availableSizes || []),
                      ...(product?.availableColors || [])
                    ])).map(v => String(v).trim()).filter(Boolean);
                    const selectedVariant = String(item.variant || '');
                    const stock = Number(
                      inventory.find(inv =>
                        inv.productId === item.productId &&
                        inv.branchId === bulkTransferSourceId &&
                        (inv.variantLabel || '') === selectedVariant
                      )?.quantity || 0
                    );
                    const rowKey = item.productId + ':' + selectedVariant;
                    
                    return (
                      <div key={rowKey} className="p-4 bg-white dark:bg-slate-800/50 rounded-xl border border-slate-200 shadow-xs animate-in slide-in-from-right-2 duration-200">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <p className="text-xs font-black text-slate-900 dark:text-slate-100 uppercase truncate leading-tight">{product?.name}</p>
                          <button 
                            onClick={() => setBulkTransferItems(prev => prev.filter((i, idx) => idx !== index))}
                            className="w-6 h-6 rounded-lg bg-rose-50 text-rose-400 hover:bg-rose-100 hover:text-rose-600 flex items-center justify-center transition-all shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {productVariants.length > 0 && (
                          <select
                            value={selectedVariant}
                            onChange={(e) => {
                              const nextVariant = e.target.value;
                              setBulkTransferItems(prev => {
                                const duplicate = prev.some((candidate, candidateIndex) =>
                                  candidateIndex !== index &&
                                  candidate.productId === item.productId &&
                                  (candidate.variant || '') === nextVariant
                                );
                                if (duplicate) return prev;
                                return prev.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, variant: nextVariant, quantity: Math.min(
                                        Math.max(1, candidate.quantity),
                                        Number(inventory.find(inv =>
                                          inv.productId === candidate.productId &&
                                          inv.branchId === bulkTransferSourceId &&
                                          (inv.variantLabel || '') === nextVariant
                                        )?.quantity || 0)
                                      ) }
                                    : candidate
                                );
                              });
                            }}
                            className="mb-2 w-full bg-white border border-indigo-100 rounded-lg px-2 py-2 text-[9px] font-black uppercase text-indigo-700 outline-none"
                          >
                            {productVariants.map(v => (
                              <option key={v} value={v}>
                                {v} — {Number(inventory.find(inv =>
                                  inv.productId === item.productId &&
                                  inv.branchId === bulkTransferSourceId &&
                                  (inv.variantLabel || '') === v
                                )?.quantity || 0)} uds
                              </option>
                            ))}
                          </select>
                        )}
                        <div className="flex items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900 p-2.5 rounded-xl border border-slate-100 shadow-inner">
                          <div className="flex flex-col">
                            <span className="text-[8px] font-black text-slate-400 uppercase leading-none mb-1">
                              {selectedVariant ? 'Disponible · ' + selectedVariant : 'Disponible'}
                            </span>
                            <span className="text-[10px] font-black text-slate-700">{stock} uds</span>
                          </div>
                          <div className="flex items-center gap-1 bg-white dark:bg-slate-800 rounded-lg p-1 border border-slate-100">
                            <button 
                              onClick={() => setBulkTransferItems(prev => prev.map((i, idx) => idx === index ? { ...i, quantity: Math.max(1, Math.min(i.quantity, Math.max(1, stock)) - 1) } : i))}
                              className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                            >
                              <Minus className="w-4 h-4" />
                            </button>
                            <span className="text-xs font-black w-8 text-center text-indigo-600">{item.quantity}</span>
                            <button 
                              onClick={() => setBulkTransferItems(prev => prev.map((i, idx) => idx === index ? { ...i, quantity: Math.min(stock, i.quantity + 1) } : i))}
                              className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Transfer Modal with Real-time Stock Inspector */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden border border-slate-200 animate-in zoom-in-95 my-auto">
            
            {/* Modal Header */}
            <div className="p-6 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg">
                  <ArrowLeftRight className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider">Traslado Individual</h3>
                  <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5 font-bold">Verificación de stock en tiempo real</p>
                </div>
              </div>

              <button 
                type="button"
                onClick={() => setShowAddModal(false)}
                className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
              
              {/* Error Alert */}
              {error && (
                <div className="p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs font-black flex items-start gap-3 animate-in shake">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              <form onSubmit={handleTransfer} className="space-y-6">
                
                {/* Branch Selection Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                      Almacén Origen
                    </label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <select 
                        required
                        value={effectiveFromBranchId}
                        onChange={e => {
                          setFormData({ ...formData, fromBranchId: e.target.value });
                          setVariantQuantities({});
                          setError("");
                        }}
                        className="w-full pl-10 pr-3 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-xs font-bold text-slate-900 appearance-none"
                      >
                        {branches.map(b => (
                          <option key={b.id} value={b.id}>
                            {getBranchDisplayName(b)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-[10px] font-black text-indigo-600 uppercase tracking-widest ml-1">
                      Almacén Destino
                    </label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400" />
                      <select 
                        required
                        value={effectiveToBranchId}
                        onChange={e => {
                          setFormData({ ...formData, toBranchId: e.target.value });
                          setError("");
                        }}
                        className="w-full pl-10 pr-3 py-3 bg-indigo-50/30 border border-indigo-100 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-xs font-bold text-indigo-950 appearance-none"
                      >
                        <option value="">Seleccionar destino...</option>
                        {branches.filter(b => b.id !== effectiveFromBranchId).map(b => (
                          <option key={b.id} value={b.id}>
                            {getBranchDisplayName(b)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Product Selection */}
                <div className="space-y-2">
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                    Producto a Transferir
                  </label>
                  <div className="relative">
                    <Package className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <select 
                      required
                      value={formData.productId}
                      onChange={e => {
                        setFormData({ ...formData, productId: e.target.value });
                        setVariantQuantities({});
                        setError("");
                      }}
                      className="w-full pl-10 pr-3 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-xs font-bold text-slate-900 appearance-none"
                    >
                      <option value="">Selecciona Producto...</option>
                      {products.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} {p.sku ? `(SKU: ${p.sku})` : ''} - ${p.price}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Stock Info Summary */}
                {selectedProduct && (
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">Disponible en Origen</span>
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "text-lg font-black",
                          totalSourceStock > 0 ? "text-slate-900" : "text-rose-600"
                        )}>{totalSourceStock}</span>
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Unidades</span>
                      </div>
                    </div>
                    <div className="space-y-1 border-l border-slate-200 pl-4">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">Stock en Destino</span>
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-black text-indigo-600">
                          {effectiveToBranchId ? totalTargetStock : '--'}
                        </span>
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Unidades</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Variant Quantity Inputs OR Single Product Input */}
                {selectedProduct && hasVariants ? (
                  <div className="space-y-3">
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                      Variantes de Producto
                    </label>
                    <div className="max-h-56 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                      {variantsList.map(variant => {
                        const currentStock = getSourceStockForVariant(variant);
                        const isOutOfStock = currentStock <= 0;

                        return (
                          <div 
                            key={variant} 
                            className={`flex justify-between items-center p-3 rounded-xl border transition-all ${
                              isOutOfStock 
                                ? 'bg-slate-100/70 border-slate-200 opacity-60' 
                                : 'bg-white border-slate-200'
                            }`}
                          >
                            <div>
                              <span className="text-xs font-black text-slate-800 block">
                                {variant}
                              </span>
                              <span className={`text-[9px] font-bold ${
                                isOutOfStock ? 'text-rose-600' : 'text-slate-400'
                              } uppercase tracking-tighter`}>
                                Disponible: {currentStock} uds
                              </span>
                            </div>

                            <div className="flex items-center gap-2">
                              <input 
                                type="number" 
                                min="0"
                                max={currentStock}
                                disabled={isOutOfStock}
                                value={variantQuantities[variant] ?? ''}
                                onChange={e => {
                                  const val = parseInt(e.target.value) || 0;
                                  setVariantQuantities({
                                    ...variantQuantities,
                                    [variant]: Math.min(currentStock, Math.max(0, val))
                                  });
                                  setError("");
                                }}
                                className="w-16 px-2 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-xs font-black text-center disabled:bg-slate-100"
                                placeholder="0"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : selectedProduct && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between ml-1">
                      <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        Cantidad a Transferir
                      </label>
                      <span className="text-[9px] font-bold text-slate-400 uppercase">
                        Máximo: {totalSourceStock} uds
                      </span>
                    </div>

                    <div className="relative flex items-center gap-3">
                      <input 
                        type="number" 
                        min="1"
                        max={totalSourceStock}
                        disabled={totalSourceStock <= 0}
                        required
                        value={variantQuantities[''] ?? ''}
                        onChange={e => {
                          const val = parseInt(e.target.value) || 0;
                          setVariantQuantities({
                            ...variantQuantities,
                            '': Math.min(totalSourceStock, Math.max(0, val))
                          });
                          setError("");
                        }}
                        className="flex-1 px-4 py-4 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-xl font-black text-slate-900 disabled:opacity-50"
                        placeholder="0"
                      />

                      {totalSourceStock > 0 && (
                        <button
                          type="button"
                          onClick={() => setVariantQuantities({ '': totalSourceStock })}
                          className="px-4 py-4 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 font-black rounded-xl text-xs uppercase transition-colors whitespace-nowrap"
                        >
                          Todo ({totalSourceStock})
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Buttons */}
                <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-slate-100">
                  <button 
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="flex-1 py-4 bg-white border border-slate-200 text-slate-500 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-50 active:scale-95 transition-all"
                  >
                    Cancelar
                  </button>
                  <button 
                    type="submit"
                    disabled={isSubmitting || totalSourceStock <= 0 || totalTransferring <= 0 || !effectiveToBranchId}
                    className="flex-1 py-4 bg-slate-900 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 shadow-lg shadow-slate-200 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isSubmitting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Procesando...
                      </>
                    ) : (
                      <>
                        <ArrowLeftRight className="w-4 h-4" />
                        Confirmar Envío
                      </>
                    )}
                  </button>
                </div>
              </form>

            </div>
          </div>
        </div>
      )}

    </div>
  );
}
