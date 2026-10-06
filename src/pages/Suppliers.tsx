import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState, useEffect } from "react";
import { useStore } from "../store/useStore";
import { Supplier, SupplierOrder } from "../types";
import { 
  Users, 
  Truck, 
  Plus, 
  Search, 
  Star, 
  Phone, 
  Mail, 
  MapPin, 
  History, 
  ChevronRight, 
  ExternalLink, 
  FileText,
  X,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Trash2,
  Edit
} from "lucide-react";
import { cn } from "../lib/utils";
import { InfoTooltip } from "../components/InfoTooltip";
import { loadSaaSContext } from "../services/saas";
import { canUsePlanFeature } from "../services/planAccess";

export default function Suppliers() {
  const { suppliers, addSupplier, updateSupplier, deleteSupplier, supplierOrders, products, createSupplierOrder, updateSupplierOrder, branches, getBaseCurrency } = useStore(useShallow((state) => ({ suppliers: state.suppliers, addSupplier: state.addSupplier, updateSupplier: state.updateSupplier, deleteSupplier: state.deleteSupplier, supplierOrders: state.supplierOrders, products: state.products, createSupplierOrder: state.createSupplierOrder, updateSupplierOrder: state.updateSupplierOrder, branches: state.branches, getBaseCurrency: state.getBaseCurrency })));
  const baseCurrency = getBaseCurrency();
  const [searchTerm, setSearchTerm] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [planAllowsPurchases, setPlanAllowsPurchases] = useState(false);
  useEffect(() => { void loadSaaSContext().then(ctx => setPlanAllowsPurchases(canUsePlanFeature(ctx?.subscription?.planCode, "purchases"))).catch(() => setPlanAllowsPurchases(false)); }, []);
  
  const [formData, setFormData] = useState<Partial<Supplier>>({
    name: "",
    phone: "",
    address: "",
    products: []
  });

  const [editingOrder, setEditingOrder] = useState<SupplierOrder | null>(null);

  const [orderFormData, setOrderFormData] = useState<{
    supplierId: string;
    branchId: string;
    items: { productId: string; variantLabel?: string; quantity: number; cost: number }[];
    transportCost?: number;
    transportDetails?: string;
    expectedDeliveryDate?: string;
  }>({
    supplierId: "",
    branchId: "",
    items: [{ productId: "", quantity: 1, cost: 0 }],
    expectedDeliveryDate: ""
  });

  const handleOpenOrderModal = (order?: SupplierOrder) => {
    if (!planAllowsPurchases) return;
    if (order) {
      setEditingOrder(order);
      setOrderFormData({
        supplierId: order.supplierId,
        branchId: order.branchId,
        expectedDeliveryDate: order.expectedDeliveryDate || "",
        transportDetails: order.transportDetails || "",
        transportCost: order.transportCost || 0,
        items: order.items.map(i => ({ productId: i.productId, variantLabel: i.variantLabel, quantity: i.quantity, cost: i.cost }))
      });
    } else {
      setEditingOrder(null);
      setOrderFormData({
        supplierId: selectedSupplier ? selectedSupplier.id : "",
        branchId: "",
        expectedDeliveryDate: "",
        transportDetails: "",
        transportCost: 0,
        items: [{ productId: "", quantity: 1, cost: 0 }]
      });
    }
    setShowOrderModal(true);
  };

  const filteredSuppliers = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return suppliers;
    return suppliers.filter(s => 
      s.name.toLowerCase().includes(query) ||
      (s.typeOfMerchandise || "").toLowerCase().includes(query)
    );
  }, [suppliers, searchTerm]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedSupplier) {
      updateSupplier(selectedSupplier.id, formData);
    } else {
      addSupplier({ id: crypto.randomUUID(), ...formData } as Supplier);
    }
    setShowAddModal(false);
    setSelectedSupplier(null);
    setFormData({ name: "", phone: "", address: "", products: [] });
  };

  const handleOrderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const supplier = suppliers.find(s => s.id === orderFormData.supplierId);
    const total = orderFormData.items.reduce((sum, i) => sum + (i.quantity * i.cost), 0);
    
    const items = orderFormData.items.map(i => ({
      ...i,
      productName: products.find(p => p.id === i.productId)?.name || 'Producto'
    }));

    const transportCost = orderFormData.transportCost || 0;
    const transportDetails = orderFormData.transportDetails || "";

    if (editingOrder) {
      updateSupplierOrder(editingOrder.id, {
        supplierId: orderFormData.supplierId,
        branchId: orderFormData.branchId,
        expectedDeliveryDate: orderFormData.expectedDeliveryDate,
        items,
        total,
        transportCost,
        transportDetails
      });
    } else {
      createSupplierOrder({
        id: crypto.randomUUID(),
        supplierId: orderFormData.supplierId,
        branchId: orderFormData.branchId,
        date: new Date().toISOString(),
        expectedDeliveryDate: orderFormData.expectedDeliveryDate,
        items,
        total,
        status: 'pending',
        transportCost,
        transportDetails
      });
    }
    setShowOrderModal(false);
    setEditingOrder(null);
  };

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-20">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 px-1">
        <div className="flex items-center gap-2">
          <h1 data-palmi-content="suppliers" className="text-xl font-black text-primary uppercase tracking-tight">Proveedores</h1>
          <InfoTooltip text="Abastecimiento y Órdenes de Compra." position="bottom" />
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <button 
            onClick={() => { setSelectedSupplier(null); setFormData({ name: "", phone: "", address: "", products: [] }); setShowAddModal(true); }}
            className="flex-1 sm:flex-none px-4 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
          >
            <Plus size={14} />
            Nuevo
          </button>
          <button 
            onClick={() => handleOpenOrderModal()}
            disabled={!planAllowsPurchases}
            title={!planAllowsPurchases ? "Las compras y órdenes de compra están disponibles desde Caravana." : "Nueva orden de compra"}
            className="flex-1 sm:flex-none px-4 py-2 bg-secondary border border-base text-primary rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-subtle transition-all flex items-center justify-center gap-2"
          >
            <Truck size={14} />
            Nueva Orden
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Lista de Proveedores */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-secondary p-2 rounded-xl border border-base shadow-sm">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
              <input 
                type="text" 
                placeholder="Buscar por nombre o tipo de mercancía..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {filteredSuppliers.map(s => (
              <div key={s.id} className="bg-secondary p-4 rounded-xl shadow-sm border border-base group hover:border-indigo-500/30 transition-all">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-black text-xs">
                      {s.name.charAt(0)}
                    </div>
                    <div>
                      <h3 className="text-xs font-black text-primary uppercase tracking-tight">{s.name}</h3>
                      <p className="text-[9px] font-bold text-muted uppercase">
                        {s.products && s.products.length > 0 ? `${s.products.length} productos asociados` : (s.typeOfMerchandise || 'Proveedor')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5">
                    {[...Array(5)].map((_, i) => (
                      <Star key={i} size={10} className={cn(i < (s.rating || 5) ? "fill-amber-400 text-amber-400" : "text-base")} />
                    ))}
                  </div>
                </div>

                <div className="space-y-1 mb-3">
                  <div className="flex items-center gap-2 text-[10px] text-secondary font-bold">
                    <Phone size={10} className="text-muted shrink-0" /> {s.phone}
                  </div>
                  {s.address && (
                    <div className="flex items-center gap-2 text-[10px] text-muted font-bold truncate">
                      <MapPin size={10} className="text-muted/50 shrink-0" /> {s.address}
                    </div>
                  )}
                </div>

                {/* List of associated merchandise/products */}
                {s.products && s.products.length > 0 && (
                  <div className="mb-3 bg-subtle p-2 rounded-lg border border-base border-dashed">
                    <p className="text-[7px] font-black uppercase tracking-widest text-muted mb-1">Mercancía ({s.products.length})</p>
                    <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                      {s.products.slice(0, 3).map((sp, idx) => {
                        const prod = products.find(p => p.id === sp.productId);
                        return (
                          <span key={idx} className="text-[7px] font-black bg-primary border border-base text-secondary px-1.5 py-0.5 rounded flex items-center gap-1 uppercase">
                            {prod?.name || 'Producto'}
                            {sp.purchasePrice ? <span className="text-indigo-600 font-black">${sp.purchasePrice}</span> : null}
                          </span>
                        );
                      })}
                      {s.products.length > 3 && <span className="text-[7px] font-black text-muted uppercase px-1">+ {s.products.length - 3} más</span>}
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  <button 
                    onClick={() => { setSelectedSupplier(s); setFormData({ ...s, products: s.products || [] }); setShowAddModal(true); }}
                    className="flex-1 py-1.5 bg-subtle text-primary rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all border border-base"
                  >
                    Editar
                  </button>
                  <button onClick={() => {
                    const hasOrders = (supplierOrders || []).some(o => o.supplierId === s.id);
                    if (hasOrders) {
                      window.alert("Este proveedor tiene órdenes registradas y no puede eliminarse. Conserva el historial de compras.");
                      return;
                    }
                    if (window.confirm("¿Eliminar proveedor? Esta acción solo está disponible si no tiene órdenes registradas.")) deleteSupplier(s.id);
                  }} className="p-1.5 bg-subtle text-muted rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 hover:text-rose-600 transition-all border border-base">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Órdenes Recientes */}
        <div className="space-y-4">
          <div className="bg-secondary rounded-xl border border-base shadow-sm overflow-hidden flex flex-col h-[600px]">
            <div className="p-3 bg-subtle border-b border-base flex items-center gap-2">
              <History size={14} className="text-indigo-600" />
              <h3 className="text-[10px] font-black text-primary uppercase tracking-widest">Órdenes de Compra</h3>
            </div>
            <div className="divide-y divide-base overflow-y-auto custom-scrollbar flex-1">
              {supplierOrders.map(order => (
                <div key={order.id} className="p-3 hover:bg-subtle/50 transition-colors">
                  <div className="flex justify-between items-start mb-2 gap-2">
                    <div className="min-w-0">
                      <div className="text-[9px] font-black text-primary uppercase truncate">#{order.id.slice(-8)}</div>
                      <div className="text-[7px] font-bold text-muted uppercase truncate">
                        {suppliers.find(s => s.id === order.supplierId)?.name || 'Proveedor'} • {new Date(order.date).toLocaleDateString()}
                      </div>
                    </div>
                    <span className={cn(
                      "shrink-0 px-1.5 py-0.5 rounded text-[7px] font-black uppercase tracking-widest",
                      order.status === 'pending' ? "bg-amber-100 text-amber-700" :
                      order.status === 'received' ? "bg-emerald-100 text-emerald-700" : "bg-base text-muted"
                    )}>
                      {order.status === 'pending' ? 'Pendiente' : order.status === 'received' ? 'Recibida' : 'Cancelada'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center gap-2 mb-2">
                    <div className="text-[9px] font-black text-secondary uppercase truncate">
                      {order.items.length} Ptos • ${order.total.toLocaleString()}
                    </div>
                    {order.status === 'pending' && (
                      <div className="flex items-center gap-1">
                        <button 
                          onClick={() => handleOpenOrderModal(order)}
                          className="p-1.5 bg-subtle text-muted rounded-lg border border-base hover:text-indigo-600"
                        >
                          <Edit size={10} />
                        </button>
                        <button 
                          onClick={() => { if (planAllowsPurchases) updateSupplierOrder(order.id, { status: 'received' }); }}
                          title="Marcar como recibida"
                          aria-label="Marcar orden como recibida"
                          className="p-1.5 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 rounded-lg border border-emerald-100 dark:border-emerald-800"
                        >
                          <CheckCircle2 size={10} />
                        </button>
                        <button 
                          onClick={() => {
                            if (!planAllowsPurchases) return; if (window.confirm('¿Cancelar esta orden de compra? La orden se conservará en el historial y no se agregará inventario.')) {
                              updateSupplierOrder(order.id, { status: 'cancelled' });
                            }
                          }}
                          title="Cancelar orden"
                          aria-label="Cancelar orden de compra"
                          className="p-1.5 bg-rose-50 dark:bg-rose-900/30 text-rose-600 rounded-lg border border-rose-100 dark:border-rose-800"
                        >
                          <XCircle size={10} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 bg-primary/50 p-2 rounded-lg border border-base border-dashed">
                    {order.items.slice(0, 2).map((item, idx) => (
                      <div key={idx} className="flex justify-between text-[7px] font-bold text-muted uppercase">
                        <span className="truncate pr-2">{item.quantity}x {item.productName}</span>
                        <span className="shrink-0">${(item.quantity * item.cost).toLocaleString()}</span>
                      </div>
                    ))}
                    {order.items.length > 2 && <div className="text-[7px] font-bold text-muted/50 uppercase text-center">+ {order.items.length - 2} más</div>}
                  </div>
                </div>
              ))}
              {supplierOrders.length === 0 && (
                <div className="p-8 text-center text-[9px] font-black text-muted uppercase tracking-[0.2em]">
                  Sin órdenes
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Modal Add / Edit Supplier */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex justify-center items-center p-4 backdrop-blur-xs">
          <div className="bg-secondary rounded-2xl w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden flex flex-col max-h-[90vh] border border-base">
            <div className="p-4 border-b border-base flex justify-between items-center bg-subtle">
              <div>
                <h2 className="text-sm font-black text-primary uppercase tracking-tight">{selectedSupplier ? 'Editar Proveedor' : 'Nuevo Proveedor'}</h2>
                <p className="text-[9px] font-bold text-muted uppercase tracking-widest">Información de contacto y mercancía</p>
              </div>
              <button onClick={() => setShowAddModal(false)} className="p-2 hover:bg-base rounded-full transition-colors"><X size={18} className="text-muted" /></button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-black text-muted uppercase tracking-widest">Nombre</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="Ej: Distribuidora Central"
                    value={formData.name || ''} 
                    onChange={e => setFormData({...formData, name: e.target.value})} 
                    className="w-full px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-500 text-primary" 
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black text-muted uppercase tracking-widest">Teléfono</label>
                    <input 
                      type="text" 
                      required 
                      placeholder="+53 5..."
                      value={formData.phone || ''} 
                      onChange={e => setFormData({...formData, phone: e.target.value})} 
                      className="w-full px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-500 text-primary" 
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-black text-muted uppercase tracking-widest">Dirección</label>
                    <input 
                      type="text" 
                      placeholder="Calle..."
                      value={formData.address || ''} 
                      onChange={e => setFormData({...formData, address: e.target.value})} 
                      className="w-full px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-500 text-primary" 
                    />
                  </div>
                </div>
              </div>

              {/* Selector de Mercancía desde el inventario */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-[10px] font-black text-muted uppercase tracking-widest">Mercancía Asociada</label>
                  <button 
                    type="button"
                    onClick={() => {
                      const current = formData.products || [];
                      setFormData({
                        ...formData,
                        products: [...current, { productId: products[0]?.id || '', purchasePrice: 0 }]
                      });
                    }}
                    className="px-2 py-1 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-wider hover:bg-indigo-100 transition-all flex items-center gap-1"
                  >
                    <Plus size={10} /> Agregar
                  </button>
                </div>

                <div className="space-y-2 max-h-40 overflow-y-auto p-2 bg-subtle rounded-xl border border-base">
                  {(!formData.products || formData.products.length === 0) ? (
                    <div className="text-center py-4 text-muted text-[9px] font-bold uppercase tracking-wider">
                      Sin productos asignados.
                    </div>
                  ) : (
                    formData.products.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-2 p-1.5 bg-secondary rounded-lg border border-base shadow-sm">
                        <select 
                          value={item.productId}
                          onChange={e => {
                            const updated = [...(formData.products || [])];
                            updated[idx] = { ...updated[idx], productId: e.target.value };
                            setFormData({ ...formData, products: updated });
                          }}
                          className="flex-1 min-w-0 bg-primary border border-base text-primary rounded-md px-2 py-1 text-[10px] font-bold outline-none"
                        >
                          <option value="">Seleccionar...</option>
                          {products.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-1.5">
                          <div className="flex items-center gap-1 bg-primary px-1.5 py-1 rounded-md border border-base w-16">
                            <span className="text-[8px] font-bold text-muted">$</span>
                            <input 
                              type="number" 
                              step="0.01"
                              value={item.purchasePrice || ''}
                              onChange={e => {
                                const updated = [...(formData.products || [])];
                                updated[idx] = { ...updated[idx], purchasePrice: parseFloat(e.target.value) || 0 };
                                setFormData({ ...formData, products: updated });
                              }}
                              className="w-full bg-transparent text-[10px] font-bold text-primary outline-none"
                            />
                          </div>
                          <button 
                            type="button" 
                            onClick={() => {
                              const updated = (formData.products || []).filter((_, i) => i !== idx);
                              setFormData({ ...formData, products: updated });
                            }}
                            className="p-1 text-muted hover:text-rose-600 transition-all"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="pt-2 flex gap-2">
                <button type="button" onClick={() => setShowAddModal(false)} className="flex-1 py-2 bg-subtle text-primary rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-base transition-all border border-base">
                  Cancelar
                </button>
                <button type="submit" className="flex-1 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100">
                  {selectedSupplier ? 'Guardar' : 'Registrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Purchase Order */}
      {showOrderModal && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex justify-center items-center p-4 backdrop-blur-xs">
          <div className="bg-secondary rounded-2xl w-full max-w-xl shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh] border border-base">
            <div className="p-4 border-b border-base flex justify-between items-center bg-subtle">
              <h2 className="text-sm font-black text-primary uppercase tracking-tight">Nueva Orden de Compra</h2>
              <button onClick={() => setShowOrderModal(false)} className="p-2 hover:bg-base rounded-full transition-colors"><X size={18} className="text-muted" /></button>
            </div>
            <form onSubmit={handleOrderSubmit} className="p-5 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-black text-muted uppercase tracking-widest">Proveedor</label>
                  <select required value={orderFormData.supplierId} onChange={e => setOrderFormData({...orderFormData, supplierId: e.target.value})} className="w-full px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none text-primary">
                    <option value="">Seleccionar</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-black text-muted uppercase tracking-widest">Sucursal</label>
                  <select required value={orderFormData.branchId} onChange={e => setOrderFormData({...orderFormData, branchId: e.target.value})} className="w-full px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold outline-none text-primary">
                    <option value="">Seleccionar</option>
                    {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-subtle p-2 rounded-xl border border-base">
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">Logística</label>
                  <input 
                    type="text" 
                    placeholder="Detalles..."
                    value={orderFormData.transportDetails || ""}
                    onChange={e => setOrderFormData({...orderFormData, transportDetails: e.target.value})}
                    className="w-full bg-transparent border-none text-[10px] font-black focus:ring-0 p-0 text-primary uppercase"
                  />
                </div>
                <div className="bg-subtle p-2 rounded-xl border border-base">
                  <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">Costo Transp.</label>
                  <input 
                    type="number" 
                    placeholder="0.00"
                    value={orderFormData.transportCost || ""}
                    onChange={e => setOrderFormData({...orderFormData, transportCost: parseFloat(e.target.value) || 0})}
                    className="w-full bg-transparent border-none text-[10px] font-black focus:ring-0 p-0 text-primary"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <h4 className="text-[10px] font-black text-primary uppercase tracking-widest">Productos</h4>
                  <button 
                    type="button"
                    onClick={() => setOrderFormData({...orderFormData, items: [...orderFormData.items, { productId: "", quantity: 1, cost: 0 }]})}
                    className="text-[9px] font-black text-indigo-600 uppercase tracking-widest flex items-center gap-1 hover:bg-indigo-50 px-2 py-1 rounded-lg"
                  >
                    <Plus size={12} /> Añadir
                  </button>
                </div>
                <div className="space-y-2">
                  {orderFormData.items.map((item, idx) => {
                    const selectedProductInfo = products.find(p => p.id === item.productId);
                    const hasVariants = selectedProductInfo && ((selectedProductInfo.availableSizes && selectedProductInfo.availableSizes.length > 0) || (selectedProductInfo.availableColors && selectedProductInfo.availableColors.length > 0));
                    
                    return (
                      <div key={idx} className="flex flex-col gap-2 p-3 bg-subtle rounded-xl border border-base">
                        <div className="flex items-center gap-2">
                          <select required value={item.productId} onChange={e => {
                            const newItems = [...orderFormData.items];
                            newItems[idx].productId = e.target.value;
                            newItems[idx].variantLabel = undefined;
                            const p = products.find(prod => prod.id === e.target.value);
                            if (p) newItems[idx].cost = p.costPrice;
                            setOrderFormData({...orderFormData, items: newItems});
                          }} className="flex-1 bg-primary border border-base rounded-lg px-2 py-1.5 text-[10px] font-bold outline-none text-primary">
                            <option value="">Producto...</option>
                            {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <button 
                            type="button"
                            onClick={() => setOrderFormData({...orderFormData, items: orderFormData.items.filter((_, i) => i !== idx)})}
                            className="p-1.5 text-muted hover:text-rose-500 transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        
                        <div className="grid grid-cols-3 gap-2">
                          <div className="space-y-1">
                            <label className="text-[7px] font-black text-muted uppercase">Cant.</label>
                            <input type="number" min="1" required value={item.quantity || ""} onChange={e => {
                              const newItems = [...orderFormData.items];
                              newItems[idx].quantity = parseInt(e.target.value) || 0;
                              setOrderFormData({...orderFormData, items: newItems});
                            }} className="w-full px-2 py-1 bg-primary border border-base rounded text-[10px] font-bold text-primary" />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[7px] font-black text-muted uppercase">Costo</label>
                            <input type="number" step="0.01" required value={item.cost || ""} onChange={e => {
                              const newItems = [...orderFormData.items];
                              newItems[idx].cost = parseFloat(e.target.value) || 0;
                              setOrderFormData({...orderFormData, items: newItems});
                            }} className="w-full px-2 py-1 bg-primary border border-base rounded text-[10px] font-bold text-primary" />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[7px] font-black text-muted uppercase">Variante</label>
                            {hasVariants ? (
                              <select 
                                required
                                value={item.variantLabel || ""} 
                                onChange={e => {
                                  const newItems = [...orderFormData.items];
                                  newItems[idx].variantLabel = e.target.value;
                                  setOrderFormData({...orderFormData, items: newItems});
                                }} 
                                className="w-full px-2 py-1 bg-primary border border-base rounded text-[10px] font-bold text-primary"
                              >
                                <option value="">Variante...</option>
                                {selectedProductInfo.availableSizes?.map(s => <option key={`size-${s}`} value={s}>{s}</option>)}
                                {selectedProductInfo.availableColors?.map(c => <option key={`color-${c}`} value={c}>{c}</option>)}
                              </select>
                            ) : (
                              <div className="w-full px-2 py-1 bg-base rounded text-[10px] font-bold text-muted text-center">-</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="pt-2 border-t border-base flex justify-between items-center">
                <div className="text-[9px] font-black text-muted uppercase tracking-widest">Total Estimado</div>
                <div className="text-lg font-black text-primary">${orderFormData.items.reduce((sum, i) => sum + (i.quantity * i.cost), 0).toLocaleString()}</div>
              </div>

              <button type="submit" className="w-full py-3 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100">
                {editingOrder ? 'Guardar Cambios' : 'Crear Orden'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
