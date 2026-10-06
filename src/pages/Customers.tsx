import { PlanFeatureGate } from "../components/PlanFeatureGate";
import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState } from "react";
import { Users, Search, Plus, Star, Phone, Mail, Edit, Trash2, History, X, Package, Clock, DollarSign, ShoppingBag, HelpCircle } from "lucide-react";
import { useStore } from "../store/useStore";
import { Customer, Transaction } from "../types";
import { cn } from "../lib/utils";
import { InfoTooltip } from "../components/InfoTooltip";

function CustomersContent() {
  const { customers, addCustomer, updateCustomer, deleteCustomer, transactions, getBaseCurrency } = useStore(useShallow((state) => ({ customers: state.customers, addCustomer: state.addCustomer, updateCustomer: state.updateCustomer, deleteCustomer: state.deleteCustomer, transactions: state.transactions, getBaseCurrency: state.getBaseCurrency })));
  const baseCurrency = getBaseCurrency();
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [viewingHistory, setViewingHistory] = useState<Customer | null>(null);
  const [newCustomer, setNewCustomer] = useState({ name: "", email: "", phone: "", taxId: "" });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [saveError, setSaveError] = useState("");

  const filteredCustomers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return customers;
    return customers.filter(c => 
      c.name.toLowerCase().includes(query) ||
      c.email?.toLowerCase().includes(query) ||
      c.phone?.includes(searchQuery)
    );
  }, [customers, searchQuery]);

  const getCustomerTransactions = (customerId: string) => {
    return transactions.filter(t => t.customerId === customerId).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  };

  const formatMoney = (amount: number) => {
    return `${baseCurrency.symbol} ${amount.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const handleAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingCustomer || !newCustomer.name.trim()) return;
    setSavingCustomer(true);
    setSaveError("");
    try {
      const saved = editingCustomer
        ? await updateCustomer(editingCustomer.id, {
            name: newCustomer.name.trim(),
            email: newCustomer.email.trim(),
            phone: newCustomer.phone.trim(),
            taxId: newCustomer.taxId.trim()
          })
        : await addCustomer({
            id: crypto.randomUUID(),
            name: newCustomer.name.trim(),
            email: newCustomer.email.trim(),
            phone: newCustomer.phone.trim(),
            taxId: newCustomer.taxId.trim()
          });

      if (!saved) {
        setSaveError("No se pudo guardar el cliente en la base de datos. Revisa el mensaje y vuelve a intentarlo.");
        return;
      }

      setShowAddModal(false);
      setEditingCustomer(null);
      setNewCustomer({ name: "", email: "", phone: "", taxId: "" });
    } catch (error: any) {
      setSaveError(error?.message || "No se pudo guardar el cliente.");
    } finally {
      setSavingCustomer(false);
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 flex flex-col pb-8">
      <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 px-1">
        <div className="flex items-center gap-2">
          <h2 data-palmi-content="customers" className="text-xl font-black text-primary tracking-tight uppercase">Clientes</h2>
          <InfoTooltip text="Gestiona tu directorio de clientes y su historial." position="bottom" />
        </div>
        <button 
          onClick={() => setShowAddModal(true)}
          className="w-full sm:w-auto bg-indigo-600 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
        >
          <Plus size={14} />
          Nuevo
        </button>
      </header>

      <div className="bg-secondary p-2 rounded-xl border border-base shadow-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted w-3.5 h-3.5" />
          <input 
            type="text" 
            placeholder="Buscar por nombre, correo o teléfono..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none transition-all text-xs font-medium"
          />
        </div>
      </div>

      <div className="bg-secondary rounded-xl border border-base shadow-sm overflow-hidden flex-1 flex flex-col min-h-[300px]">
        <div className="overflow-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-subtle border-b border-base shadow-sm">
              <tr>
                <th className="px-4 py-2.5 text-[9px] font-black text-muted uppercase tracking-widest">Cliente</th>
                <th className="px-4 py-2.5 text-[9px] font-black text-muted uppercase tracking-widest hidden sm:table-cell">Contacto</th>
                <th className="px-4 py-2.5 text-[9px] font-black text-muted uppercase tracking-widest text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {filteredCustomers.map(customer => (
                <tr key={customer.id} className="hover:bg-subtle/50 transition-colors group">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-black">
                        {customer.name.charAt(0)}
                      </div>
                      <div>
                        <div className="text-[11px] font-black text-primary uppercase tracking-tighter">{customer.name}</div>
                        <div className="text-[8px] font-bold text-muted uppercase tracking-widest">#{customer.id.slice(-6)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    <div className="space-y-0.5">
                      {customer.phone && (
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-secondary">
                          <Phone size={10} className="text-muted" />
                          {customer.phone}
                        </div>
                      )}
                      {customer.email && (
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted italic">
                          <Mail size={10} className="text-muted/50" />
                          {customer.email}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1.5">
                      <button 
                        onClick={() => setViewingHistory(customer)}
                        className="text-muted hover:text-emerald-600 transition-colors p-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg border border-base"
                      >
                        <History size={14} />
                      </button>
                      <button 
                        onClick={() => {
                          setEditingCustomer(customer);
                          setNewCustomer({ name: customer.name, email: customer.email || "", phone: customer.phone || "", taxId: customer.taxId || "" });
                          setShowAddModal(true);
                        }}
                        className="text-muted hover:text-indigo-600 transition-colors p-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg border border-base"
                      >
                        <Edit size={14} />
                      </button>
                      <button 
                        onClick={() => {
                          const hasHistory = (transactions || []).some(t => t.customerId === customer.id);
                          if (hasHistory) {
                            window.alert("Este cliente tiene ventas registradas y no puede eliminarse. Conserva el historial para mantener la trazabilidad.");
                            return;
                          }
                          if (window.confirm("¿Eliminar cliente? Esta acción solo está disponible si no tiene historial de ventas.")) deleteCustomer(customer.id);
                        }}
                        className="text-muted hover:text-rose-600 transition-colors p-1.5 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg border border-base"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* History Sidebar/Modal */}
      {viewingHistory && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex justify-end">
          <div className="w-full max-w-sm bg-secondary h-full shadow-2xl flex flex-col border-l border-base animate-in slide-in-from-right duration-300">
            <div className="p-4 border-b border-base flex justify-between items-center bg-subtle">
              <div>
                <h3 className="text-xs font-black text-primary uppercase tracking-tighter">Historial</h3>
                <p className="text-[9px] font-black text-indigo-600 uppercase tracking-widest">{viewingHistory.name}</p>
              </div>
              <button onClick={() => setViewingHistory(null)} className="p-1.5 hover:bg-base rounded-full transition-colors text-muted">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {getCustomerTransactions(viewingHistory.id).length > 0 ? (
                getCustomerTransactions(viewingHistory.id).map(tx => (
                  <div key={tx.id} className="p-3 bg-primary border border-base rounded-xl shadow-sm">
                    <div className="flex justify-between items-start mb-2 pb-2 border-b border-base border-dashed">
                      <div>
                        <div className="text-[9px] font-black text-primary uppercase">#{tx.id.slice(-8)}</div>
                        <div className="text-[7px] font-black text-muted uppercase tracking-widest flex items-center gap-1 mt-0.5">
                          <Clock size={8} />
                          {new Date(tx.date).toLocaleDateString()}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] font-black text-emerald-600">{formatMoney(tx.total)}</div>
                      </div>
                    </div>
                    
                    <div className="space-y-1.5">
                      {tx.items.map((item, idx) => (
                        <div key={idx} className="flex justify-between items-center">
                          <div className="flex items-center gap-1.5">
                            <Package size={10} className="text-muted" />
                            <span className="text-[9px] font-bold text-secondary uppercase tracking-tight">{item.quantity}x {item.product.name}</span>
                          </div>
                          <span className="text-[8px] font-bold text-muted">{formatMoney(item.product.price * item.quantity)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted opacity-40 py-20">
                  <ShoppingBag size={48} className="mb-4" />
                  <p className="text-[9px] font-black uppercase tracking-widest">Sin transacciones</p>
                </div>
              )}
            </div>

            <div className="p-4 bg-subtle border-t border-base">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[8px] font-black text-muted uppercase tracking-widest">Total Acumulado</span>
                <span className="text-sm font-black text-primary">
                  {formatMoney(getCustomerTransactions(viewingHistory.id).reduce((sum, t) => sum + t.total, 0))}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[8px] font-black text-muted uppercase tracking-widest">Visitas</span>
                <span className="text-[10px] font-black text-indigo-600 uppercase">
                  {getCustomerTransactions(viewingHistory.id).length}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Agregar Cliente (Compact) */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
          <div className="palmyra-mobile-modal bg-secondary rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden border border-base animate-in zoom-in-95">
            <div className="p-4 border-b border-base bg-subtle flex justify-between items-center">
               <h3 className="text-xs font-black text-primary uppercase tracking-widest">{editingCustomer ? "Editar Cliente" : "Nuevo Cliente"}</h3>
               <button onClick={() => setShowAddModal(false)} className="text-muted hover:text-primary font-bold">✕</button>
            </div>
            <div className="p-4">
              <form onSubmit={handleAddCustomer} className="space-y-3">
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">Nombre Completo *</label>
                  <input 
                    required
                    type="text" 
                    value={newCustomer.name}
                    onChange={(e) => setNewCustomer({...newCustomer, name: e.target.value})}
                    className="w-full px-3 py-2 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-xs font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">CI o Pasaporte</label>
                  <input 
                    type="text" 
                    value={newCustomer.taxId}
                    onChange={(e) => setNewCustomer({...newCustomer, taxId: e.target.value})}
                    className="w-full px-3 py-2 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-xs font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">Correo (Opcional)</label>
                  <input 
                    type="email" 
                    value={newCustomer.email}
                    onChange={(e) => setNewCustomer({...newCustomer, email: e.target.value})}
                    className="w-full px-3 py-2 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-xs font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">Teléfono</label>
                  <input 
                    type="tel" 
                    value={newCustomer.phone}
                    onChange={(e) => setNewCustomer({...newCustomer, phone: e.target.value})}
                    className="w-full px-3 py-2 bg-primary border border-base rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-xs font-bold"
                  />
                </div>
                <div className="pt-2">
                  <button 
                    type="submit" 
                    className="w-full py-2.5 bg-indigo-600 text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 disabled:opacity-50" disabled={savingCustomer}
                  >
                    {savingCustomer ? "Guardando..." : "Guardar Cliente"}
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


export default function Customers() {
  return (
    <PlanFeatureGate feature="customers_suppliers" title="Clientes" description="Esta función está incluida en Caravana para negocios que necesitan ampliar el control de su operación.">
      <CustomersContent />
    </PlanFeatureGate>
  );
}
