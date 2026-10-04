import React from "react";
import { Search, Plus, X, Loader2 } from "lucide-react";
import type { Branch, CashRegisterSession, Product, User, Currency } from "../../types";

export interface AddItemToShiftModalProps {
  session: CashRegisterSession;
  sessionLabel: string;
  branches: Branch[];
  products: Product[];
  users: User[];
  currencies: Currency[];
  formatMoney: (amount: number, code?: string) => string;
  manualItemProductSearch: string;
  manualItemProductId: string;
  manualItemQuantity: number;
  manualItemPrice: number;
  manualItemWorkerId: string;
  manualItemPaymentMethod: "cash" | "transfer";
  manualItemCurrencyCode: string;
  isAddingManualItem: boolean;
  onSearchChange: (value: string) => void;
  onProductChange: (value: string) => void;
  onQuantityChange: (value: number) => void;
  onPriceChange: (value: number) => void;
  onWorkerChange: (value: string) => void;
  onPaymentMethodChange: (value: "cash" | "transfer") => void;
  onCurrencyChange: (value: string) => void;
  onSubmit: (affectStock: boolean) => void | Promise<void>;
  onCancel: () => void;
}

export default function AddItemToShiftModal({
  session,
  sessionLabel,
  branches,
  products,
  users,
  currencies,
  formatMoney,
  manualItemProductSearch,
  manualItemProductId,
  manualItemQuantity,
  manualItemPrice,
  manualItemWorkerId,
  manualItemPaymentMethod,
  manualItemCurrencyCode,
  isAddingManualItem,
  onSearchChange,
  onProductChange,
  onQuantityChange,
  onPriceChange,
  onWorkerChange,
  onPaymentMethodChange,
  onCurrencyChange,
  onSubmit,
  onCancel,
}: AddItemToShiftModalProps) {
  return (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs z-[100] flex items-center justify-center p-3 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-5 sm:p-6 shadow-2xl border border-base max-w-lg w-full max-h-[94vh] flex flex-col overflow-hidden animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-base pb-3 mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-50 dark:bg-indigo-950/50 rounded-2xl flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                  <Plus className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-tight">
                    Regularizar venta del turno
                  </h3>
                  <p className="text-[10px] font-bold text-muted uppercase">
                    {sessionLabel} • {branches.find(b => b.id === session.branchId)?.name || 'Sucursal'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onCancel}
                className="p-1 hover:bg-subtle rounded-full text-muted hover:text-primary transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 p-3 rounded-2xl mb-3 text-left">
              <p className="text-[9px] font-bold text-amber-950 dark:text-amber-200 uppercase leading-relaxed">
                Corrección documental del turno. Esta pantalla permite reconstruir una venta que faltó en el informe. Elige explícitamente si la corrección debe afectar el stock físico.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3.5 pr-1 custom-scrollbar text-primary">
              {/* Buscador y Selector de Producto */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-[9px] font-black uppercase text-muted tracking-wider">
                    Buscar y Seleccionar Producto:
                  </label>
                  {manualItemProductSearch && (
                    <button
                      type="button"
                      onClick={() => onSearchChange("")}
                      className="text-[8px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                    >
                      Limpiar filtro
                    </button>
                  )}
                </div>

                {/* Search Input Field */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={manualItemProductSearch}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder="Filtrar por nombre o SKU..."
                    className="w-full pl-9 pr-3.5 py-2 bg-subtle border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-indigo-500/20 placeholder:text-muted/60"
                  />
                </div>

                {/* Dropdown with filtered results */}
                {(() => {
                  const query = (manualItemProductSearch || "").toLowerCase().trim();
                  const filteredCatalog = products.filter(p => 
                    !query || 
                    (p.name && p.name.toLowerCase().includes(query)) ||
                    (p.sku && p.sku.toLowerCase().includes(query))
                  );

                  return (
                    <div>
                      <select
                        value={manualItemProductId}
                        onChange={(e) => {
                          const pId = e.target.value;
                          onProductChange(pId);
                          const prod = products.find(p => p.id === pId);
                          if (prod) {
                            onPriceChange(prod.price || 0);
                          }
                        }}
                        className="w-full px-3.5 py-2.5 bg-subtle border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
                      >
                        <option value="">-- Selecciona un producto ({filteredCatalog.length} disponibles) --</option>
                        {filteredCatalog.map(p => (
                          <option key={p.id} value={p.id}>
                            {p.name} {p.sku ? `(${p.sku})` : ''} — ${p.price?.toLocaleString()} CUP
                          </option>
                        ))}
                      </select>
                      {filteredCatalog.length === 0 && (
                        <p className="text-[9px] text-amber-600 dark:text-amber-400 font-bold mt-1">
                          No se encontraron productos que coincidan con &quot;{manualItemProductSearch}&quot;.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Cantidad y Precio de Venta */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-1.5">
                    Cantidad Vendida:
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={manualItemQuantity}
                    onChange={(e) => onQuantityChange(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full px-3.5 py-2 bg-subtle border border-base rounded-xl text-xs font-black font-mono text-primary outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
                <div>
                  <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-1.5">
                    Precio Unitario (CUP):
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={manualItemPrice}
                    onChange={(e) => onPriceChange(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-full px-3.5 py-2 bg-subtle border border-base rounded-xl text-xs font-black font-mono text-primary outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              {/* Vendedor / Trabajador responsable */}
              <div>
                <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-1.5">
                  Vendedor Responsable:
                </label>
                <select
                  value={manualItemWorkerId || session.userId}
                  onChange={(e) => onWorkerChange(e.target.value)}
                  className="w-full px-3.5 py-2 bg-subtle border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role === 'admin' ? 'Administrador' : 'Empleado'})
                    </option>
                  ))}
                </select>
              </div>

              {/* Método de Pago y Moneda */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-1.5">
                    Método de Pago:
                  </label>
                  <select
                    value={manualItemPaymentMethod}
                    onChange={(e) => onPaymentMethodChange(e.target.value as any)}
                    className="w-full px-3.5 py-2 bg-subtle border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-indigo-500/20"
                  >
                    <option value="cash">Efectivo</option>
                    <option value="transfer">Transferencia Bancaria</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-1.5">
                    Moneda Cobrada:
                  </label>
                  <select
                    value={manualItemCurrencyCode}
                    onChange={(e) => onCurrencyChange(e.target.value)}
                    className="w-full px-3.5 py-2 bg-subtle border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-indigo-500/20"
                  >
                    {currencies.map(c => (
                      <option key={c.code} value={c.code}>{c.code} ({c.name})</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Subtotal Total Calculado */}
              <div className="bg-indigo-50/50 dark:bg-indigo-950/30 p-3 rounded-xl border border-indigo-200/60 dark:border-indigo-900/60 flex justify-between items-center">
                <span className="text-[10px] font-black text-indigo-900 dark:text-indigo-300 uppercase">Monto Total a Sumar al Turno:</span>
                <span className="text-base font-black text-indigo-700 dark:text-indigo-400 font-mono">
                  {formatMoney(manualItemQuantity * manualItemPrice, manualItemCurrencyCode)}
                </span>
              </div>
            </div>

            <div className="space-y-2 pt-4 border-t border-base mt-2 flex flex-col">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/50">
                    <div className="text-[8px] font-black uppercase text-indigo-700 dark:text-indigo-300">Solo reporte</div>
                    <div className="text-[8px] font-bold text-indigo-900/80 dark:text-indigo-200 mt-0.5">Corrige ventas/comisiones sin volver a tocar la mercancía.</div>
                  </div>
                  <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/50">
                    <div className="text-[8px] font-black uppercase text-amber-700 dark:text-amber-300">Reporte + stock</div>
                    <div className="text-[8px] font-bold text-amber-900/80 dark:text-amber-200 mt-0.5">Usa esta opción solo cuando el producto realmente salió del inventario.</div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isAddingManualItem || !manualItemProductId || manualItemQuantity <= 0}
                  onClick={() => onSubmit(false)}
                  className="py-3 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-black rounded-xl text-[10px] uppercase tracking-wider transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {isAddingManualItem ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5 text-indigo-600" />
                  )}
                  <span>Solo reporte · NO cambia stock</span>
                </button>

                <button
                  type="button"
                  disabled={isAddingManualItem || !manualItemProductId || manualItemQuantity <= 0}
                  onClick={() => onSubmit(true)}
                  className="py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl text-[10px] uppercase tracking-wider transition-all shadow-md shadow-indigo-600/20 active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {isAddingManualItem ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  <span>Reporte + stock · Ajuste físico</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => onCancel}
                disabled={isAddingManualItem}
                className="w-full py-2.5 bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary font-black rounded-xl text-[9px] uppercase tracking-wider transition-all cursor-pointer disabled:opacity-50 mt-1"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
  );
}
