import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState } from "react";
import { RotateCcw, Search, CheckCircle, XCircle, AlertTriangle, ShieldCheck, X, Calendar, User, Package, Hash } from "lucide-react";
import { useStore } from "../store/useStore";
import { cn, generateId } from "../lib/utils";
import { ReturnItem, Warranty } from "../types";

export default function Returns() {
  const { returns, transactions, products, categories, createReturn, updateReturn, processReturn, warranties, updateWarranty } = useStore(useShallow((state) => ({ returns: state.returns, transactions: state.transactions, products: state.products, categories: state.categories, createReturn: state.createReturn, updateReturn: state.updateReturn, processReturn: state.processReturn, warranties: state.warranties, updateWarranty: state.updateWarranty })));
  const [activeTab, setActiveTab] = useState<'returns' | 'warranties'>('returns');
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [transactionSearch, setTransactionSearch] = useState("");

  const [formData, setFormData] = useState<Partial<ReturnItem>>({
    transactionId: "",
    productId: "",
    quantity: 1,
    reason: "defecto_fabrica",
    type: "warranty_exchange",
    notes: "",
    refundStatus: "not_required"
  });

  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const transactionById = useMemo(() => new Map(transactions.map(transaction => [transaction.id, transaction])), [transactions]);
  const getProduct = (id: string) => productById.get(id);
  const getTransaction = (id: string) => transactionById.get(id) || transactions.find(t => t.id.includes(id));

  const foundTransaction = transactionSearch.length > 3 ? transactions.find(t => 
    t.id.toLowerCase().includes(transactionSearch.toLowerCase()) || 
    t.customerId?.toLowerCase().includes(transactionSearch.toLowerCase()) ||
    warranties.some(w => w.id.toLowerCase().includes(transactionSearch.toLowerCase()) && w.transactionId === t.id)
  ) : null;

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.transactionId || !formData.productId) return;
    
    const refundStatus = formData.type === 'refund' ? 'pending' : 'not_required';
    createReturn({
      ...formData,
      id: generateId('RET'),
      date: new Date().toISOString(),
      status: 'pending',
      refundStatus
    } as ReturnItem);
    setShowAddModal(false);
    setFormData({ transactionId: "", productId: "", quantity: 1, reason: "defecto_fabrica", type: "warranty_exchange", notes: "" });
    setTransactionSearch("");
  };

  const filteredReturns = useMemo(() => returns.filter(ret => {
    const p = getProduct(ret.productId);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!ret.transactionId.toLowerCase().includes(q) && 
          !p?.name.toLowerCase().includes(q) &&
          !ret.id.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [returns, searchQuery, productById]);

  const filteredWarranties = useMemo(() => warranties.filter(w => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!w.productName.toLowerCase().includes(q) && 
          !w.customerName?.toLowerCase().includes(q) &&
          !w.serialNumber?.toLowerCase().includes(q) &&
          !w.transactionId.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [warranties, searchQuery]);

  const isExpired = (expiryDate: string) => new Date(expiryDate) < new Date();

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300 lg:h-full flex flex-col">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 data-palmi-content="returns" className="text-xl font-black text-slate-900 tracking-tight uppercase">Gestión de Post-Venta</h2>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Devoluciones y Control de Garantías</p>
        </div>
        <div className="flex bg-slate-100 p-1 rounded-xl">
          <button 
            onClick={() => setActiveTab('returns')}
            className={cn(
              "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
              activeTab === 'returns' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}
          >
            Devoluciones
          </button>
          <button 
            onClick={() => setActiveTab('warranties')}
            className={cn(
              "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
              activeTab === 'warranties' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}
          >
            Certificados de Garantía
          </button>
        </div>
      </header>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
          <input 
            type="text" 
            placeholder="Filtrar por producto, cliente o ID..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder:text-slate-300 font-medium"
          />
        </div>
        {activeTab === 'returns' && (
          <button onClick={() => setShowAddModal(true)} className="bg-slate-900 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-slate-800 transition-all shadow-sm">
            <RotateCcw className="w-3 h-3" />
            Nueva Devolución
          </button>
        )}
      </div>

      {activeTab === 'returns' && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-3 text-left">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-[9px] font-black uppercase tracking-wider text-indigo-900">Control de devoluciones</p>
              <p className="text-[8px] font-bold text-indigo-800 mt-0.5 leading-relaxed">Primero se autoriza y recibe físicamente el artículo. El reembolso monetario se registra aparte con monto y medio de pago explícitos. Confirmar recepción no mueve dinero automáticamente.</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 overflow-hidden flex-1">
        <div className="overflow-x-auto h-full">
          {activeTab === 'returns' ? (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">ID / Fecha</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Transacción</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Producto</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tipo / Razón</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Estado físico</th>
          <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reembolso</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredReturns.map((ret) => {
                  const product = getProduct(ret.productId);
                  return (
                    <tr key={ret.id} className="hover:bg-slate-50/30 transition-colors">
                      <td className="px-6 py-3">
                        <div className="text-[11px] font-black text-slate-900 font-mono">{ret.id}</div>
                        <div className="text-[9px] font-bold text-slate-400 uppercase">{new Date(ret.date).toLocaleDateString()}</div>
                      </td>
                      <td className="px-6 py-3">
                        <div className="text-[10px] font-bold text-slate-500 font-mono mb-1">{ret.transactionId}</div>
                        {(() => {
                          const tx = transactions.find(t => t.id === ret.transactionId);
                          const cust = tx ? useStore.getState().customers.find(c => c.id === tx.customerId) : null;
                          return cust ? (
                            <div className="flex flex-col">
                              <span className="text-[9px] font-black text-slate-900 uppercase tracking-tighter">{cust.name}</span>
                              <span className="text-[8px] font-bold text-slate-400">{cust.phone}</span>
                            </div>
                          ) : <span className="text-[9px] font-bold text-slate-300 italic">Consumidor Final</span>;
                        })()}
                      </td>
                      <td className="px-6 py-3">
                        <div className="text-[11px] font-black text-slate-900">{product?.name || 'Desconocido'}</div>
                        <div className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">Qty: {ret.quantity}</div>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-1 mb-1">
                          {ret.type === 'warranty_exchange' ? (
                            <span className="text-[9px] font-black text-blue-600 bg-blue-50 px-2 py-0.5 rounded-lg uppercase tracking-tighter">Garantía</span>
                          ) : (
                            <span className="text-[9px] font-black text-slate-600 bg-slate-100 px-2 py-0.5 rounded-lg uppercase tracking-tighter">Reembolso</span>
                          )}
                        </div>
                        <div className="text-[10px] font-medium text-slate-500 italic">
                          {ret.reason === 'defecto_fabrica' ? 'Defecto de Fábrica' :
                           ret.reason === 'dano_transporte' ? 'Daño en Transporte' :
                           ret.reason === 'producto_incorrecto' ? 'Producto Incorrecto' :
                           ret.reason === 'insatisfaccion' ? 'Insatisfacción' :
                           ret.reason || 'Sin motivo'}
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        <div className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[9px] font-black uppercase mb-2",
                          ret.status === 'pending' && "text-amber-600 bg-amber-50",
                          ret.status === 'completed' && "text-emerald-600 bg-emerald-50"
                        )}>
                          {ret.status === 'pending' && <AlertTriangle className="w-2.5 h-2.5"/>}
                          {ret.status === 'completed' && <CheckCircle className="w-2.5 h-2.5"/>}
                          {ret.status === 'pending' ? 'Pendiente recepción' : 'Recibido'}
                        </div>
                        <div className="flex flex-col gap-1">
                          {ret.status === 'pending' && (
                            <div className="flex flex-col gap-1 w-full">
                              <button 
                                onClick={() => {
                                  if(confirm('¿Confirmar recepción física de este retorno?')) {
                                    processReturn(ret.id, 'complete');
                                  }
                                }}
                                className="text-[9px] font-black bg-indigo-600 text-white px-2 py-1.5 rounded-lg uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-sm w-full text-center"
                              >
                                Confirmar recepción
                              </button>
                              <button 
                                onClick={() => processReturn(ret.id, 'reject')}
                                className="text-[9px] font-black bg-rose-50 text-rose-600 border border-rose-100 px-2 py-1.5 rounded-lg uppercase tracking-widest hover:bg-rose-100 transition-all w-full text-center"
                              >
                                Rechazar
                              </button>
                            </div>
                          )}
                          {ret.status === 'pending' && (
                            <button 
                              onClick={() => updateReturn(ret.id, { type: ret.type === 'refund' ? 'warranty_exchange' : 'refund', refundStatus: ret.type === 'refund' ? 'not_required' : 'pending' })}
                              className="text-[9px] font-black bg-white border border-slate-200 text-slate-500 px-2 py-1.5 rounded-lg uppercase tracking-widest hover:bg-slate-50 transition-all"
                            >
                              {ret.type === 'refund' ? 'Cambiar a Garantía' : 'Cambiar a Reembolso'}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3 align-top">
                        {ret.type === 'refund' ? (
                          <div className="space-y-1.5">
                            <span className={cn(
                              "inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[8px] font-black uppercase",
                              ret.refundStatus === 'paid' ? "bg-emerald-50 text-emerald-700" :
                              ret.refundStatus === 'approved' ? "bg-blue-50 text-blue-700" :
                              "bg-amber-50 text-amber-700"
                            )}>
                              {ret.refundStatus === 'paid' ? 'Pagado' : ret.refundStatus === 'approved' ? 'Aprobado' : 'Pendiente'}
                            </span>
                            {ret.refundAmount ? (
                              <div className="text-[9px] font-black text-slate-700">{ret.refundAmount.toLocaleString()} {ret.refundCurrencyCode || 'CUP'}</div>
                            ) : (
                              <div className="text-[8px] font-bold text-slate-400 uppercase">Monto pendiente de definir</div>
                            )}
                            <div className="text-[8px] font-bold text-slate-400 uppercase">
                              {ret.refundMethod ? `Medio: ${ret.refundMethod === 'store_credit' ? 'Crédito cliente' : ret.refundMethod === 'cash' ? 'Efectivo' : 'Transferencia'}` : 'Sin medio de pago definido'}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[8px] font-black uppercase text-slate-400">No aplica</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">ID Garantía</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Producto / Serie</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Cliente</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Periodo</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Estado</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Ticket</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredWarranties.map((w) => {
                  const expired = isExpired(w.expiryDate);
                  return (
                    <tr key={w.id} className="hover:bg-slate-50/30 transition-colors">
                      <td className="px-6 py-3">
                        <div className="text-[11px] font-black text-slate-900 font-mono">{w.id}</div>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          <Package className="w-3 h-3 text-slate-300" />
                          <div className="text-[11px] font-black text-slate-900">{w.productName}</div>
                        </div>
                        {w.serialNumber && (
                          <div className="flex items-center gap-1 mt-0.5 text-[9px] font-bold text-indigo-500 uppercase">
                            <Hash className="w-2.5 h-2.5" /> {w.serialNumber}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          <User className="w-3 h-3 text-slate-300" />
                          <div>
                            <div className="text-[11px] font-black text-slate-900 uppercase tracking-tighter">{w.customerName}</div>
                            {(() => {
                              const cust = useStore.getState().customers.find(c => c.name === w.customerName);
                              return cust && <div className="text-[8px] font-bold text-slate-400">{cust.phone}</div>;
                            })()}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-3">
                          <div>
                            <p className="text-[8px] font-black text-slate-300 uppercase">Compra</p>
                            <p className="text-[10px] font-bold text-slate-500">{new Date(w.purchaseDate).toLocaleDateString()}</p>
                          </div>
                          <div className="w-4 h-px bg-slate-200"></div>
                          <div>
                            <p className="text-[8px] font-black text-slate-300 uppercase">Vence</p>
                            <p className={cn("text-[10px] font-bold", expired ? "text-rose-500" : "text-emerald-500")}>
                              {new Date(w.expiryDate).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        <span className={cn(
                          "px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-tighter",
                          w.status === 'refunded' ? "bg-slate-100 text-slate-600" :
                          w.status === 'exchanged' ? "bg-blue-100 text-blue-600" :
                          expired ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"
                        )}>
                          {w.status === 'refunded' ? 'Reembolsada' : 
                           w.status === 'exchanged' ? 'Cambiada' : 
                           expired ? 'Expirada' : 'En Garantía'}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-[10px] font-mono font-bold text-slate-400">
                        {w.transactionId.slice(-6)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex justify-center items-center p-4">
          <div className="bg-white rounded-[2rem] w-full max-w-sm flex flex-col shadow-2xl animate-in zoom-in-95 duration-200 border border-white/20">
            <div className="flex justify-between items-center p-6 border-b border-slate-50">
              <h2 className="text-lg font-black text-slate-900 uppercase tracking-tight">Nueva Devolución</h2>
              <button onClick={() => setShowAddModal(false)} className="p-1 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            
            <form onSubmit={handleAddSubmit} className="p-6 space-y-4">
              <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Buscar Ticket o Cliente</label>
                <div className="relative">
                  <Search className="absolute left-0 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-300" />
                  <input 
                    type="text" 
                    value={transactionSearch} 
                    onChange={e => setTransactionSearch(e.target.value)} 
                    className="w-full bg-transparent border-none text-xs font-black focus:ring-0 pl-5 p-0 text-slate-900" 
                    placeholder="Escribe el ID del ticket..." 
                  />
                </div>
              </div>

              {foundTransaction ? (
                <div className="bg-indigo-50/50 p-3 rounded-2xl border border-indigo-100 animate-in fade-in zoom-in-95 max-h-48 overflow-y-auto">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[9px] font-black text-indigo-600 uppercase tracking-widest">Productos del Ticket</span>
                    <span className="text-[8px] font-bold text-indigo-400 uppercase">{new Date(foundTransaction.date).toLocaleDateString()}</span>
                  </div>
                  <div className="space-y-2">
                    {foundTransaction.items.map((item, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setFormData({
                          ...formData,
                          transactionId: foundTransaction.id,
                          productId: item.product.id,
                          quantity: 1
                        })}
                        className={cn(
                          "w-full flex items-center justify-between p-2 rounded-xl border transition-all text-left",
                          formData.productId === item.product.id ? "bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-100" : "bg-white border-slate-100 text-slate-700 hover:border-indigo-200"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Package className="w-3 h-3" />
                          <span className="text-[10px] font-black uppercase tracking-tighter">{item.product.name}</span>
                        </div>
                        <span className="text-[9px] font-bold opacity-60">Qty: {item.quantity}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : transactionSearch.length > 3 && (
                <div className="p-4 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">No se encontró el ticket</p>
                </div>
              )}

              <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Motivo de Devolución</label>
                <select required value={formData.reason} onChange={e => setFormData({...formData, reason: e.target.value})} className="w-full bg-transparent border-none text-[10px] font-black focus:ring-0 p-0 text-slate-900 uppercase">
                  <option value="defecto_fabrica">Defecto de Fábrica</option>
                  <option value="dano_transporte">Daño en Transporte</option>
                  <option value="producto_incorrecto">Producto Incorrecto</option>
                  <option value="insatisfaccion">Insatisfacción</option>
                  <option value="otros">Otros / Ver Notas</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                  <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Cantidad</label>
                  <input type="number" min="1" required value={formData.quantity ?? 1} onChange={e => setFormData({...formData, quantity: parseInt(e.target.value) || 0})} className="w-full bg-transparent border-none text-xs font-black focus:ring-0 p-0 text-slate-900" />
                </div>
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                  <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Tipo Trámite</label>
                  <select required value={formData.type} onChange={e => setFormData({...formData, type: e.target.value as any})} className="w-full bg-transparent border-none text-[10px] font-black focus:ring-0 p-0 text-slate-900 uppercase">
                    <option value="warranty_exchange">Cambio por Garantía</option>
                    <option value="refund">Reembolso de Dinero</option>
                  </select>
                </div>
              </div>
              <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Motivo / Notas</label>
                <textarea rows={2} value={formData.notes} onChange={e => setFormData({...formData, notes: e.target.value})} className="w-full bg-transparent border-none text-xs font-medium focus:ring-0 p-0 text-slate-900 resize-none" placeholder="¿Por qué se devuelve?" />
              </div>
              
              <button 
                type="submit" 
                disabled={!formData.productId}
                className={cn(
                  "w-full mt-4 font-black text-[10px] uppercase tracking-widest py-4 rounded-2xl transition-all shadow-lg",
                  formData.productId ? "bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-100" : "bg-slate-100 text-slate-400 cursor-not-allowed"
                )}
              >
                Registrar Solicitud
              </button>
            </form>
          </div>
        </div>
      )}
      
      <ProcedureGuide />
    </div>
  );
}

function ProcedureGuide() {
  return (
    <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="bg-emerald-50/50 p-4 rounded-2xl border border-emerald-100">
        <h4 className="text-[10px] font-black text-emerald-800 uppercase tracking-widest mb-2 flex items-center gap-2">
          <CheckCircle className="w-3 h-3" /> Devolución Aceptada
        </h4>
        <ul className="text-[9px] font-medium text-emerald-700 space-y-1.5 list-disc pl-3">
          <li>Verificar que el producto esté en su empaque original.</li>
          <li>Comprobar que el ID de Garantía coincida con el producto físico.</li>
          <li>Si es <b>Reembolso</b>, el producto vuelve al inventario automáticamente al finalizar.</li>
          <li>Si es <b>Cambio</b>, entregar el nuevo producto y el sistema descontará stock.</li>
        </ul>
      </div>
      
      <div className="bg-rose-50/50 p-4 rounded-2xl border border-rose-100">
        <h4 className="text-[10px] font-black text-rose-800 uppercase tracking-widest mb-2 flex items-center gap-2">
          <XCircle className="w-3 h-3" /> Devolución Rechazada
        </h4>
        <ul className="text-[9px] font-medium text-rose-700 space-y-1.5 list-disc pl-3">
          <li>Rechazar si el daño fue por mal uso del cliente.</li>
          <li>Rechazar si la garantía ha expirado (ver fecha en tabla).</li>
          <li>Explicar cordialmente al cliente el motivo del rechazo.</li>
          <li>No se realizan cambios ni reembolsos sin el ticket de venta.</li>
        </ul>
      </div>

      <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100">
        <h4 className="text-[10px] font-black text-indigo-800 uppercase tracking-widest mb-2 flex items-center gap-2">
          <ShieldCheck className="w-3 h-3" /> Proceso de Garantía
        </h4>
        <ul className="text-[9px] font-medium text-indigo-700 space-y-1.5 list-disc pl-3">
          <li>Usar el ID de Garantía para rastrear el tiempo restante.</li>
          <li>Los números de serie son únicos y deben verificarse físicamente.</li>
          <li>En calzado, verificar que la talla sea la correcta en el sistema.</li>
          <li>Registrar notas detalladas del problema para auditoría.</li>
        </ul>
      </div>
    </div>
  );
}
