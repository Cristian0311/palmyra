import React, { useState, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { 
  Activity, 
  Search, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Database, 
  Layers, 
  Save, 
  Wrench, 
  Copy, 
  Check, 
  Building2, 
  ArrowRight,
  Info,
  X
} from "lucide-react";
import { useStore } from "../store/useStore";
import { getSupabase } from "../lib/supabase";
import { Product, Branch } from "../types";
import { cn } from "../lib/utils";

interface StockDiagnosticModalProps {
  isOpen: boolean;
  onClose: () => void;
  preselectedProductId?: string;
}

export function StockDiagnosticModal({ isOpen, onClose, preselectedProductId }: StockDiagnosticModalProps) {
  const { 
    products, 
    branches, 
    inventory, 
    reconcileProductStock, 
    repairOrphanedInventoryLevels 
  } = useStore(useShallow((state) => ({ products: state.products, branches: state.branches, inventory: state.inventory, fetchProductStockRealtime: state.fetchProductStockRealtime, reconcileProductStock: state.reconcileProductStock, repairOrphanedInventoryLevels: state.repairOrphanedInventoryLevels })));

  const [selectedProductId, setSelectedProductId] = useState<string>(preselectedProductId || products[0]?.id || "");
  const [searchTerm, setSearchTerm] = useState("");
  const [loadingDb, setLoadingDb] = useState(false);
  const [dbInventory, setDbInventory] = useState<any[]>([]);
  const [editQuantities, setEditQuantities] = useState<{ [branchVariantKey: string]: number }>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [repairLoading, setRepairLoading] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Filtered product list for selector
  const filteredProducts = products.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    (p.sku && p.sku.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (p.barcode && p.barcode.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const selectedProduct = products.find(p => p.id === selectedProductId);

  // Query live DB stock whenever selectedProductId changes
  const loadDbStock = async (prodId: string) => {
    if (!prodId) return;
    setLoadingDb(true);
    setFeedbackMsg(null);
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase no está configurado.");
      const { data, error } = await supabase
        .from('inventory_levels')
        .select('*')
        .eq('product_id', prodId);

      if (error) {
        setFeedbackMsg({ type: 'error', text: `Error consultando Supabase: ${error.message}` });
      } else {
        setDbInventory(data || []);
        // Pre-fill edit state
        const initialEdits: { [key: string]: number } = {};
        branches.forEach(b => {
          const hasVariants = (selectedProduct?.availableSizes?.length || 0) + (selectedProduct?.availableColors?.length || 0) > 0;
          if (hasVariants) {
            const variants = Array.from(new Set([...(selectedProduct?.availableSizes || []), ...(selectedProduct?.availableColors || [])]));
            variants.forEach(v => {
              const row = (data || []).find((r: any) => r.branch_id === b.id && (r.variant_label || '') === v);
              initialEdits[`${b.id}_${v}`] = row ? Number(row.quantity) : 0;
            });
          } else {
            const row = (data || []).find((r: any) => r.branch_id === b.id && (r.variant_label || '') === '');
            initialEdits[`${b.id}_base`] = row ? Number(row.quantity) : 0;
          }
        });
        setEditQuantities(initialEdits);
      }
    } catch (e: any) {
      setFeedbackMsg({ type: 'error', text: `Excepción de red: ${e.message}` });
    } finally {
      setLoadingDb(false);
    }
  };

  useEffect(() => {
    if (isOpen && selectedProductId) {
      loadDbStock(selectedProductId);
    }
  }, [isOpen, selectedProductId]);

  if (!isOpen) return null;

  const handleSaveBranchCorrection = async (branchId: string, variantLabel: string = '') => {
    const key = variantLabel ? `${branchId}_${variantLabel}` : `${branchId}_base`;
    const newQty = editQuantities[key] ?? 0;
    setSavingKey(key);
    setFeedbackMsg(null);

    const result = await reconcileProductStock(selectedProductId, [
      {
        branchId,
        variantLabel: variantLabel || undefined,
        quantity: Math.max(0, newQty)
      }
    ]);

    setSavingKey(null);
    if (result.success) {
      setFeedbackMsg({ type: 'success', text: `Stock actualizado con éxito en Supabase para la sucursal.` });
      await loadDbStock(selectedProductId);
    } else {
      setFeedbackMsg({ type: 'error', text: result.error || 'Error guardando corrección en Supabase.' });
    }
  };

  const handleRepairOrphans = async () => {
    setRepairLoading(true);
    setFeedbackMsg(null);
    const res = await repairOrphanedInventoryLevels();
    setRepairLoading(false);
    setFeedbackMsg({ 
      type: res.repaired > 0 ? 'success' : 'info', 
      text: res.message 
    });
    if (selectedProductId) {
      await loadDbStock(selectedProductId);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(id);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  return (
    <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95">
        
        {/* Modal Header */}
        <div className="px-6 py-5 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black uppercase tracking-tight">Diagnóstico y Comparativa de Stock</h2>
                <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider">Multi-Sucursal</span>
              </div>
              <p className="text-xs text-slate-400">Verifica y corrige discrepancias entre Supabase (DB) y la memoria local en tiempo real</p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Feedback Alert Bar */}
        {feedbackMsg && (
          <div className={`px-6 py-3 text-xs font-black flex items-center justify-between ${
            feedbackMsg.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-b border-emerald-100' :
            feedbackMsg.type === 'error' ? 'bg-rose-50 text-rose-800 border-b border-rose-100' :
            'bg-indigo-50 text-indigo-800 border-b border-indigo-100'
          }`}>
            <div className="flex items-center gap-2">
              {feedbackMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> :
               feedbackMsg.type === 'error' ? <AlertTriangle className="w-4 h-4 text-rose-600" /> :
               <Info className="w-4 h-4 text-indigo-600" />}
              <span>{feedbackMsg.text}</span>
            </div>
            <button onClick={() => setFeedbackMsg(null)} className="text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Top Controls: Product Selector & Action Bar */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 space-y-1.5">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                <Search className="w-3.5 h-3.5 text-indigo-600" />
                Buscar o Seleccionar Producto a Diagnosticar
              </label>
              <div className="relative">
                <select
                  value={selectedProductId}
                  onChange={(e) => setSelectedProductId(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  {products.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.sku ? `(SKU: ${p.sku})` : ''} - ${p.price}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => loadDbStock(selectedProductId)}
                disabled={loadingDb}
                className="flex-1 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 active:scale-95 text-white rounded-2xl text-[10px] font-black uppercase tracking-wider flex items-center justify-center gap-2 transition-all shadow-sm disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingDb ? 'animate-spin text-indigo-400' : ''}`} />
                {loadingDb ? 'Consultando...' : 'Re-consultar DB'}
              </button>

              <button
                type="button"
                onClick={handleRepairOrphans}
                disabled={repairLoading}
                title="Repara registros de inventario con branch_id nulo"
                className="px-3 py-2.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-2xl text-[10px] font-black uppercase flex items-center gap-1.5 transition-all"
              >
                <Wrench className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Reparar Huérfanos</span>
              </button>
            </div>
          </div>

          {/* Selected Product Summary Badge */}
          {selectedProduct && (
            <div className="p-4 bg-gradient-to-r from-slate-50 to-indigo-50/30 rounded-2xl border border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-black text-slate-900">{selectedProduct.name}</h3>
                  {selectedProduct.sku && (
                    <span className="bg-slate-200 text-slate-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase">
                      SKU: {selectedProduct.sku}
                    </span>
                  )}
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-800">
                    ID: {selectedProduct.id.slice(0, 8)}...
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Precio Venta: <span className="font-bold text-slate-900">${selectedProduct.price}</span> | Costo: <span className="font-bold text-slate-900">${selectedProduct.costPrice || 0}</span>
                </p>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <div className="px-3 py-1.5 bg-white rounded-xl border border-slate-200 text-center shadow-xs">
                  <span className="text-[9px] text-slate-400 font-black uppercase block">Sucursales con Stock</span>
                  <span className="text-sm font-black text-indigo-600">
                    {branches.filter(b => {
                      const branchStock = dbInventory.filter(r => r.branch_id === b.id).reduce((s, r) => s + (Number(r.quantity) || 0), 0);
                      return branchStock > 0;
                    }).length} de {branches.length}
                  </span>
                </div>
                <div className="px-3 py-1.5 bg-white rounded-xl border border-slate-200 text-center shadow-xs">
                  <span className="text-[9px] text-slate-400 font-black uppercase block">Stock Global Supabase</span>
                  <span className="text-sm font-black text-emerald-600">
                    {dbInventory.reduce((s, r) => s + (Number(r.quantity) || 0), 0)} uds
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Multi-Branch Inventory Comparison Matrix */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-tighter flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-indigo-600" />
                  Auditoría Multi-Sucursal
                </h3>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Comparativa de Existencias en Tiempo Real</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-3 py-1 bg-amber-50 border border-amber-100 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                  <span className="text-[9px] font-black text-amber-700 uppercase">Diferencia Detectada</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {branches.map(branch => {
                const branchDbRecords = dbInventory.filter(r => r.branch_id === branch.id);
                const branchLocalRecords = inventory.filter(i => i.productId === selectedProductId && i.branchId === branch.id);

                const totalDbStock = branchDbRecords.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0);
                const totalLocalStock = branchLocalRecords.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0);
                const isDesynced = totalDbStock !== totalLocalStock;

                const hasVariants = (selectedProduct?.availableSizes?.length || 0) + (selectedProduct?.availableColors?.length || 0) > 0;
                const variantsList = hasVariants 
                  ? Array.from(new Set([...(selectedProduct?.availableSizes || []), ...(selectedProduct?.availableColors || [])])) 
                  : [''];

                return (
                  <div 
                    key={branch.id} 
                    className={cn(
                      "relative overflow-hidden rounded-[2rem] border transition-all duration-300",
                      isDesynced 
                        ? "bg-white border-amber-200 shadow-xl shadow-amber-900/5 ring-1 ring-amber-500/10" 
                        : totalDbStock > 0 
                        ? "bg-white border-slate-100 shadow-sm hover:shadow-md" 
                        : "bg-slate-50/50 border-slate-100 opacity-80"
                    )}
                  >
                    {/* Visual Sync Status Bar */}
                    <div className={cn(
                      "absolute top-0 left-0 right-0 h-1",
                      isDesynced ? "bg-amber-500" : totalDbStock > 0 ? "bg-emerald-500" : "bg-slate-200"
                    )} />

                    <div className="p-6 space-y-4">
                      {/* Branch Header */}
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <h4 className="text-base font-black text-slate-900 tracking-tight">{branch.name}</h4>
                            {isDesynced && <AlertTriangle className="w-4 h-4 text-amber-500" />}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded uppercase">UUID: {branch.id.slice(0,8)}</span>
                            {branch.isMain && <span className="text-[8px] font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-full uppercase border border-indigo-100">Principal</span>}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Existencia DB</div>
                          <div className="flex items-baseline justify-end gap-1">
                            <span className={cn(
                              "text-2xl font-black tracking-tighter",
                              isDesynced ? "text-amber-600" : totalDbStock > 0 ? "text-slate-900" : "text-slate-400"
                            )}>{totalDbStock}</span>
                            <span className="text-[10px] font-bold text-slate-400">UDS</span>
                          </div>
                        </div>
                      </div>

                      {/* Stock Detail & Corrections */}
                      <div className="space-y-3 bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
                        {variantsList.map(variant => {
                          const key = variant ? `${branch.id}_${variant}` : `${branch.id}_base`;
                          const currentDb = branchDbRecords.find(r => (r.variant_label || '') === (variant || ''))?.quantity ?? 0;
                          const currentLocal = branchLocalRecords.find(i => (i.variantLabel || '') === (variant || ''))?.quantity ?? 0;
                          const isSavingThis = savingKey === key;
                          const diff = currentDb - currentLocal;

                          return (
                            <div key={key} className="space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-black text-slate-700 uppercase tracking-tight">
                                  {variant ? `Variante: ${variant}` : 'Unidad Base'}
                                </span>
                                {diff !== 0 && (
                                  <span className={cn(
                                    "text-[9px] font-black px-2 py-0.5 rounded-full",
                                    diff > 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                                  )}>
                                    {diff > 0 ? `+${diff}` : diff} Discrepancia
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                <div className="flex-1 relative">
                                  <input 
                                    type="number" 
                                    min="0"
                                    value={editQuantities[key] ?? currentDb}
                                    onChange={(e) => setEditQuantities({
                                      ...editQuantities,
                                      [key]: parseInt(e.target.value) || 0
                                    })}
                                    className="w-full pl-3 pr-10 py-2 bg-white border border-slate-200 rounded-xl text-xs font-black text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none transition-all shadow-inner"
                                  />
                                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-black text-slate-400 uppercase">UDS</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleSaveBranchCorrection(branch.id, variant)}
                                  disabled={isSavingThis}
                                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 active:scale-95 text-white rounded-xl text-[10px] font-black uppercase flex items-center gap-2 transition-all disabled:opacity-50 shadow-sm"
                                >
                                  {isSavingThis ? (
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Save className="w-3.5 h-3.5" />
                                  )}
                                  Corregir
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {isDesynced && (
                        <div className="flex items-center gap-2 text-[9px] font-bold text-amber-700 bg-amber-100/50 p-2 rounded-lg border border-amber-200">
                          <Info className="w-3.5 h-3.5" />
                          <span>La memoria local (Zustand) muestra {totalLocalStock} uds. Presiona corregir para sincronizar con la DB.</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Cheatsheet: Console Diagnostic Commands */}
          <div className="p-5 bg-slate-900 text-slate-200 rounded-3xl space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-black uppercase tracking-wider text-indigo-400 flex items-center gap-2">
                <Database className="w-4 h-4" />
                Comandos de Diagnóstico en Consola (DevTools)
              </h4>
              <span className="text-[10px] text-slate-400">Presiona F12 o Ctrl+Shift+I</span>
            </div>

            <p className="text-xs text-slate-400">
              Puedes ejecutar estos comandos directamente en la consola del navegador para auditorías inmediatas:
            </p>

            <div className="space-y-2">
              <div className="bg-slate-950 p-3 rounded-2xl border border-slate-800 flex items-center justify-between font-mono text-xs text-emerald-400">
                <code>__diagnoseProductStock("{selectedProduct?.name || 'Nombre Producto'}")</code>
                <button
                  onClick={() => copyToClipboard(`__diagnoseProductStock("${selectedProduct?.name || 'Nombre Producto'}")`, 'cmd1')}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-sans font-bold flex items-center gap-1 transition-colors"
                >
                  {copiedCmd === 'cmd1' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copiedCmd === 'cmd1' ? 'Copiado' : 'Copiar'}
                </button>
              </div>

              <div className="bg-slate-950 p-3 rounded-2xl border border-slate-800 flex items-center justify-between font-mono text-xs text-indigo-300">
                <code>__listAllBranchesInventory()</code>
                <button
                  onClick={() => copyToClipboard(`__listAllBranchesInventory()`, 'cmd2')}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-sans font-bold flex items-center gap-1 transition-colors"
                >
                  {copiedCmd === 'cmd2' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copiedCmd === 'cmd2' ? 'Copiado' : 'Copiar'}
                </button>
              </div>
            </div>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-sm"
          >
            Cerrar Diagnóstico
          </button>
        </div>

      </div>
    </div>
  );
}
