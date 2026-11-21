import PlanFeatureGate from '../components/PlanFeatureGate';
import OperationsSurface from '../components/OperationsSurface';
import OperationsDialog from '../components/OperationsDialog';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useRef, useState, type ElementType, type FormEvent } from 'react';
import {
  ArrowRight, ArrowUpDown, Ban, Building2, CheckCircle2, Clock, CreditCard, FileText, Mail, MapPin,
  Package, PackageSearch, Pencil, Phone, Plus, Search, ShoppingCart, Trash2, Truck, Users,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import type { Product, Supplier, SupplierOrder } from '../types';
import { loadSaaSContext } from '../services/saas';
import { canUsePlanFeature } from '../services/planAccess';
import { getOfflineQueue } from '../services/offlineQueue';
import { runPendingOrderAction } from '../utils/operationsUi';
import { cn } from '../lib/utils';
import { documentCode } from '../lib/documentCodes';

const inputClass = 'block mt-1 w-full min-w-0 rounded-xl border border-base bg-primary px-3 py-2.5 text-primary outline-none focus:border-violet-500';
const secondaryButton = 'inline-flex items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-4 py-2 font-bold text-primary transition-colors hover:bg-subtle disabled:opacity-50';
const primaryButton = 'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 font-black uppercase tracking-wide text-white shadow-md shadow-violet-600/20 transition-all hover:shadow-lg disabled:opacity-50';
const dangerButton = 'inline-flex items-center justify-center gap-2 rounded-xl border border-red-300 bg-red-50 px-4 py-2 font-bold text-red-700 transition-colors hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/60';

const statusLabels: Record<SupplierOrder['status'], string> = {
  pending: 'Pendiente', received: 'Recibida', cancelled: 'Cancelada', draft: 'Borrador',
};
const statusStyles: Record<SupplierOrder['status'], { chip: string; icon: ElementType }> = {
  pending: { chip: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200', icon: Clock },
  received: { chip: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200', icon: CheckCircle2 },
  cancelled: { chip: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200', icon: Ban },
  draft: { chip: 'border-base bg-subtle text-secondary', icon: FileText },
};

type OrderDraft = {
  supplierId: string; branchId: string; expectedDeliveryDate: string; transportCost: number; transportDetails: string;
  items: { productId: string; variantLabel?: string; quantity: number; cost: number }[];
};
const emptyOrder = (supplierId = ''): OrderDraft => ({ supplierId, branchId: '', expectedDeliveryDate: '', transportCost: 0, transportDetails: '', items: [] });
const hasQueuedReceipt = (id: string) => getOfflineQueue().some(item => item.type === 'supplier_receive' && (item.actionId === `supplier:${id}` || (item.data as { id?: string })?.id === id));

const AVATAR_TONES = [
  'from-violet-500 to-indigo-600',
  'from-emerald-500 to-teal-600',
  'from-sky-500 to-blue-600',
  'from-amber-500 to-orange-600',
  'from-fuchsia-500 to-purple-600',
  'from-red-500 to-pink-600',
];
function avatarTone(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'PR';
}

function StatBubble({ label, value, sub, icon: Icon, tone }: { label: string; value: string | number; sub?: string; icon: ElementType; tone: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-base bg-secondary p-3 sm:p-3.5">
      <div className={cn('pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full bg-gradient-to-br opacity-10', tone)} aria-hidden="true" />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm', tone)}>
            <Icon size={15} aria-hidden="true" />
          </span>
          <span className="min-w-0 truncate font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>{label}</span>
        </div>
        <span className="mt-2 block truncate text-lg font-black leading-none text-primary sm:text-2xl" title={String(value)}>{value}</span>
        {sub && <span className="mt-1 block font-bold leading-tight text-muted" style={{ fontSize: 11 }}>{sub}</span>}
      </div>
    </div>
  );
}

function ProductSearch({ products, currency, excludeIds = [], onPick, placeholder = 'Buscar por nombre o SKU…' }: {
  products: Product[];
  currency: string;
  excludeIds?: string[];
  onPick: (product: Product) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const term = query.trim().toLocaleLowerCase('es');
  const results = useMemo(() => {
    if (!term) return [];
    return products
      .filter(product => !excludeIds.includes(product.id))
      .filter(product => `${product.name} ${product.sku || ''} ${product.barcode || ''}`.toLocaleLowerCase('es').includes(term))
      .slice(0, 8);
  }, [products, term, excludeIds]);

  return (
    <div className="relative">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={event => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          placeholder={placeholder}
          aria-label="Buscar producto"
          className="w-full rounded-xl border border-base bg-primary py-2.5 pl-9 pr-3 text-primary outline-none focus:border-violet-500"
        />
      </div>
      {open && term && (
        <div className="absolute inset-x-0 z-30 mt-1 overflow-hidden rounded-xl border border-base bg-secondary shadow-xl">
          <ul className="max-h-60 overflow-y-auto py-1" role="listbox" aria-label="Productos encontrados">
            {results.map(product => (
              <li key={product.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => { onPick(product); setQuery(''); setOpen(false); }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-subtle"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-primary">{product.name}</span>
                    <span className="block truncate text-muted" style={{ fontSize: 12 }}>{product.sku || 'Sin SKU'}</span>
                  </span>
                  <span className="shrink-0 font-black tabular-nums text-primary" style={{ fontSize: 12 }}>
                    {product.costPrice.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {currency}
                  </span>
                </button>
              </li>
            ))}
            {!results.length && <li className="px-3 py-3 text-muted">No hay productos que coincidan. Revisa el nombre o el SKU.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function SupplierDetail({ supplier, ordersCount, products, money, onClose, onEdit, onOrders, onDelete }: {
  supplier: Supplier;
  ordersCount: number;
  products: Product[];
  money: (value: number) => string;
  onClose: () => void;
  onEdit: () => void;
  onOrders: () => void;
  onDelete: () => void;
}) {
  const linked = supplier.products || [];
  return (
    <OperationsDialog title="Ficha del proveedor" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <span className={cn('flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-md', avatarTone(supplier.id))} style={{ fontSize: 20, fontWeight: 900 }}>
            {initials(supplier.name)}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-xl font-black text-primary">{supplier.name}</h3>
            <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-base bg-subtle px-2.5 py-1 font-bold text-secondary" style={{ fontSize: 12 }}>
              <Package size={12} aria-hidden="true" /> {supplier.typeOfMerchandise || 'Mercancía sin clasificar'}
            </span>
          </div>
        </div>

        <dl className="grid gap-2 sm:grid-cols-2">
          {[
            { icon: Phone, label: 'Teléfono', value: supplier.phone || 'No registrado' },
            { icon: MapPin, label: 'Dirección', value: supplier.address || 'Sin dirección' },
            { icon: Mail, label: 'Correo', value: supplier.email || 'Sin correo' },
            { icon: Truck, label: 'Órdenes', value: `${ordersCount} ${ordersCount === 1 ? 'registrada' : 'registradas'}` },
          ].map(row => (
            <div key={row.label} className="flex items-start gap-2 rounded-xl border border-base bg-subtle p-3">
              <row.icon size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
              <div className="min-w-0">
                <dt className="font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.1em' }}>{row.label}</dt>
                <dd className="truncate font-bold text-primary">{row.value}</dd>
              </div>
            </div>
          ))}
        </dl>

        <section>
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-black uppercase text-secondary" style={{ fontSize: 12, letterSpacing: '0.08em' }}>Productos asociados</h4>
            <span className="font-bold text-muted" style={{ fontSize: 12 }}>{linked.length}</span>
          </div>
          {linked.length ? (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {linked.map((item, index) => {
                const product = products.find(candidate => candidate.id === item.productId);
                return (
                  <li key={`${item.productId}-${index}`} className="flex items-center justify-between gap-2 rounded-xl border border-base p-3">
                    <span className="min-w-0 truncate font-bold text-primary">{product?.name || 'Producto no disponible'}</span>
                    <span className="shrink-0 font-black tabular-nums text-secondary" style={{ fontSize: 12 }}>{money(item.purchasePrice || 0)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 rounded-xl border border-dashed border-base p-3 text-secondary">Aún no tiene productos asociados. Puedes agregarlos desde Editar.</p>
          )}
        </section>

        <div className="flex flex-wrap gap-2 border-t border-base pt-4">
          <button type="button" onClick={onEdit} className={primaryButton}><Pencil size={16} aria-hidden="true" /> Editar</button>
          <button type="button" onClick={onOrders} className={secondaryButton}><ShoppingCart size={16} aria-hidden="true" /> Ver órdenes</button>
          <button type="button" onClick={onDelete} disabled={ordersCount > 0} title={ordersCount > 0 ? 'Solo se elimina un proveedor sin órdenes registradas' : 'Eliminar proveedor'} className={cn(dangerButton, 'ml-auto')}>
            <Trash2 size={16} aria-hidden="true" /> Eliminar
          </button>
        </div>
        {ordersCount > 0 && <p className="text-muted" style={{ fontSize: 12 }}>No se puede eliminar porque tiene órdenes registradas; conserva el historial de compras.</p>}
      </div>
    </OperationsDialog>
  );
}

function SuppliersContent() {
  const { suppliers, supplierOrders, products, branches, addSupplier, updateSupplier, deleteSupplier, createSupplierOrder, updateSupplierOrder, getBaseCurrency } = useStore(useShallow(state => ({
    suppliers: state.suppliers, supplierOrders: state.supplierOrders, products: state.products, branches: state.branches,
    addSupplier: state.addSupplier, updateSupplier: state.updateSupplier, deleteSupplier: state.deleteSupplier,
    createSupplierOrder: state.createSupplierOrder, updateSupplierOrder: state.updateSupplierOrder, getBaseCurrency: state.getBaseCurrency,
  })));
  const [view, setView] = useState<'suppliers' | 'orders'>('suppliers');
  const [search, setSearch] = useState('');
  const [sortAsc, setSortAsc] = useState(true);
  const [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [supplierModal, setSupplierModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [supplierDraft, setSupplierDraft] = useState<Partial<Supplier>>({ name: '', phone: '', address: '', products: [] });
  const [orderModal, setOrderModal] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [orderDraft, setOrderDraft] = useState<OrderDraft>(emptyOrder());
  const [confirmation, setConfirmation] = useState<{ id: string; status: 'received' | 'cancelled' } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const [planAllowsPurchases, setPlanAllowsPurchases] = useState(false);
  const [busy, setBusy] = useState(false);
  const saveLock = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [, setQueueVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void loadSaaSContext().then(ctx => { if (active) setPlanAllowsPurchases(canUsePlanFeature(ctx?.subscription?.planCode, 'purchases')); }).catch(() => { if (active) setPlanAllowsPurchases(false); });
    const refreshQueue = () => setQueueVersion(version => version + 1);
    window.addEventListener('offline_queue_updated', refreshQueue);
    return () => { active = false; window.removeEventListener('offline_queue_updated', refreshQueue); };
  }, []);

  const currency = getBaseCurrency().code;
  const selectedSupplier = suppliers.find(supplier => supplier.id === selectedId);
  const detailOrder = supplierOrders.find(order => order.id === detailOrderId);
  const supplierById = useMemo(() => new Map(suppliers.map(supplier => [supplier.id, supplier])), [suppliers]);
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const term = search.trim().toLocaleLowerCase('es');
  const filteredSuppliers = suppliers.filter(supplier => `${supplier.name} ${supplier.phone || ''} ${supplier.address || ''} ${supplier.typeOfMerchandise || ''}`.toLocaleLowerCase('es').includes(term));
  const sortedSuppliers = [...filteredSuppliers].sort((a, b) => (sortAsc ? 1 : -1) * a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  const directoryOrders = sortedSuppliers.reduce((total, supplier) => total + supplierOrders.filter(order => order.supplierId === supplier.id).length, 0);
  const filteredOrders = supplierOrders.filter(order => (!selectedId || order.supplierId === selectedId)
    && (status === 'all' || order.status === status)
    && `${order.id} ${supplierById.get(order.supplierId)?.name || ''}`.toLocaleLowerCase('es').includes(term))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const money = (value: number) => `${value.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  const shortDate = (value?: string) => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CU', { day: '2-digit', month: 'short' }) : '';
  const longDate = (value?: string) => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CU', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const orderTotal = orderDraft.items.reduce((sum, item) => sum + item.quantity * item.cost, 0);
  const resetFeedback = () => { setMessage(''); setError(''); };

  const activeOrders = supplierOrders.filter(order => order.status !== 'cancelled');
  const totalSpent = activeOrders.reduce((sum, order) => sum + (order.total || 0) + (order.transportCost || 0), 0);
  const pendingOrders = supplierOrders.filter(order => order.status === 'pending').length;
  const receivedOrders = supplierOrders.filter(order => order.status === 'received').length;
  const ordersFor = (supplierId: string) => supplierOrders.filter(order => order.supplierId === supplierId).length;
  const supplierProducts = supplierDraft.products || [];
  const linkedProductIds = supplierProducts.map(item => item.productId);
  const linkedProductCount = new Set(linkedProductIds).size;

  function openSupplier(supplier?: Supplier) {
    resetFeedback(); setEditingSupplier(supplier || null);
    setSupplierDraft(supplier ? { ...supplier, products: [...(supplier.products || [])] } : { name: '', phone: '', address: '', products: [] });
    setSupplierModal(true);
  }
  function openOrder(order?: SupplierOrder, supplierId?: string) {
    if (!planAllowsPurchases || (order && (order.status !== 'pending' || hasQueuedReceipt(order.id)))) return;
    resetFeedback(); setSelectedId(null);
    setEditingOrderId(order?.id || null);
    setOrderDraft(order ? {
      supplierId: order.supplierId, branchId: order.branchId, expectedDeliveryDate: order.expectedDeliveryDate?.slice(0, 10) || '',
      transportCost: order.transportCost || 0, transportDetails: order.transportDetails || '', items: order.items.map(item => ({ ...item })),
    } : emptyOrder(supplierId || selectedId || ''));
    setOrderModal(true);
  }
  function saveSupplier(event: FormEvent) {
    event.preventDefault(); resetFeedback();
    if (!supplierDraft.name?.trim() || !supplierDraft.phone?.trim()) return setError('Completa el nombre y teléfono del proveedor.');
    const ids = (supplierDraft.products || []).map(item => item.productId);
    if (new Set(ids).size !== ids.length) return setError('Hay un producto repetido en la lista. Deja una sola línea por producto.');
    if ((supplierDraft.products || []).some(item => !products.some(product => product.id === item.productId) || !Number.isFinite(item.purchasePrice) || (item.purchasePrice || 0) < 0)) return setError('Revisa los productos asociados y sus precios de compra.');
    const payload = {
      ...supplierDraft,
      name: supplierDraft.name.trim(),
      phone: supplierDraft.phone.trim(),
      address: supplierDraft.address?.trim() || '',
      email: supplierDraft.email?.trim() || '',
      typeOfMerchandise: (supplierDraft.typeOfMerchandise || '').trim(),
    };
    if (editingSupplier) updateSupplier(editingSupplier.id, payload);
    else addSupplier({ ...payload, id: crypto.randomUUID() } as Supplier);
    setSupplierModal(false); setMessage(editingSupplier ? 'Proveedor actualizado.' : 'Proveedor guardado en el registro.');
  }
  async function saveOrder(event: FormEvent) {
    event.preventDefault();
    if (!planAllowsPurchases || saveLock.current) return;
    resetFeedback();
    if (!suppliers.some(supplier => supplier.id === orderDraft.supplierId) || !branches.some(branch => branch.id === orderDraft.branchId && branch.isActive !== false)) return setError('Selecciona un proveedor y un almacén activo.');
    if (!orderDraft.items.length || orderDraft.items.some(item => !products.some(product => product.id === item.productId) || !Number.isInteger(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.cost) || item.cost < 0)) return setError('Agrega al menos un producto con cantidad entera mayor que cero y costo válido.');
    const keys = orderDraft.items.map(item => `${item.productId}::${item.variantLabel || ''}`);
    if (new Set(keys).size !== keys.length) return setError('Hay productos repetidos con la misma variante. Une las cantidades en una sola línea.');
    if (!Number.isFinite(orderDraft.transportCost) || orderDraft.transportCost < 0 || !Number.isFinite(orderTotal)) return setError('Revisa los montos de productos y transporte.');
    saveLock.current = true; setBusy(true);
    try {
      const payload = { ...orderDraft, total: orderTotal, items: orderDraft.items.map(item => ({ ...item, productName: products.find(product => product.id === item.productId)!.name })) };
      if (editingOrderId) {
        const applied = await runPendingOrderAction(editingOrderId, () => useStore.getState().supplierOrders.find(order => order.id === editingOrderId), () => hasQueuedReceipt(editingOrderId), () => updateSupplierOrder(editingOrderId, payload));
        if (!applied) throw new Error('La orden ya cambió o tiene una recepción pendiente. Cierra el formulario y revisa su estado.');
      } else createSupplierOrder({ ...payload, id: crypto.randomUUID(), date: new Date().toISOString(), status: 'pending' });
      setOrderModal(false); setMessage('Orden guardada. El inventario solo cambia al confirmar la recepción.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar la orden.'); }
    finally { saveLock.current = false; setBusy(false); }
  }
  async function confirmOrder() {
    if (!confirmation || !planAllowsPurchases || saveLock.current) return;
    const action = confirmation;
    saveLock.current = true; setBusy(true); resetFeedback();
    try {
      const applied = await runPendingOrderAction(action.id, () => useStore.getState().supplierOrders.find(order => order.id === action.id), () => hasQueuedReceipt(action.id), () => updateSupplierOrder(action.id, { status: action.status }));
      if (!applied) throw new Error('Esta orden ya cambió o tiene una recepción en curso. No se repetirá la operación.');
      const latest = useStore.getState().supplierOrders.find(order => order.id === action.id);
      setMessage(hasQueuedReceipt(action.id) ? 'Recepción guardada para sincronización. No vuelvas a recibir esta orden; revisa Conexión y datos en Configuración.' : latest?.status === action.status ? (action.status === 'received' ? 'Recepción confirmada.' : 'Orden cancelada; se conserva el historial.') : 'No se pudo confirmar el cambio. Revisa el estado de la orden antes de continuar.');
      setConfirmation(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo procesar la orden.'); }
    finally { saveLock.current = false; setBusy(false); }
  }
  function confirmDeleteSupplier() {
    if (!deleteTarget) return;
    deleteSupplier(deleteTarget.id); setDeleteTarget(null); setSelectedId(null); setMessage('Proveedor eliminado.');
  }
  function updateOrderItem(index: number, changes: Partial<OrderDraft['items'][number]>) {
    setOrderDraft(current => ({ ...current, items: current.items.map((row, i) => i === index ? { ...row, ...changes } : row) }));
  }

  const feedback = <>
    {message && <p role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"><CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{message}</p>}
    {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 font-semibold text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"><Ban size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{error}</p>}
  </>;

  const tabClass = (active: boolean) => cn(
    'inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 font-black uppercase transition-all sm:flex-none',
    active ? 'bg-violet-600 text-white shadow-md shadow-violet-600/20' : 'text-secondary hover:bg-subtle',
  );

  return <OperationsSurface className="-mx-3 -mt-3 flex flex-col gap-4 px-3 pb-10 pt-3 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4 lg:-mx-6 lg:-mt-6 lg:px-6">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 data-palmi-content="suppliers" className="text-2xl font-black tracking-tight text-primary sm:text-3xl">Proveedores y compras</h1>
        <p className="mt-1 text-secondary">Contactos, mercancía y seguimiento de cada orden de compra.</p>
        <p className="mt-0.5 text-muted" style={{ fontSize: 12 }}>El inventario solo se actualiza al confirmar la recepción de una orden.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => openSupplier()} className={cn(primaryButton, 'flex-1 sm:flex-none')}>
          <Plus size={18} aria-hidden="true" /> Nuevo proveedor
        </button>
        <button type="button" onClick={() => openOrder()} disabled={!planAllowsPurchases} title={planAllowsPurchases ? 'Crear una orden de compra' : 'Tu plan no incluye Compras'} className={cn(secondaryButton, 'flex-1 sm:flex-none')}>
          <ShoppingCart size={18} aria-hidden="true" /> Nueva orden
        </button>
      </div>
    </header>

    {!supplierModal && !orderModal && !confirmation && !deleteTarget && feedback}

    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      <StatBubble label="Proveedores" value={suppliers.length} sub={`${suppliers.filter(s => !s.products?.length).length} sin mercancía asociada`} icon={Users} tone="from-violet-500 to-indigo-600" />
      <StatBubble label="Órdenes" value={supplierOrders.length} sub={`${pendingOrders} ${pendingOrders === 1 ? 'pendiente' : 'pendientes'} · ${receivedOrders} ${receivedOrders === 1 ? 'recibida' : 'recibidas'}`} icon={Truck} tone="from-sky-500 to-blue-600" />
      <StatBubble label="Inversión" value={money(totalSpent)} sub="Sin órdenes canceladas" icon={CreditCard} tone="from-emerald-500 to-teal-600" />
      <StatBubble label="Almacenes" value={branches.filter(branch => branch.isActive !== false).length} sub="Destinos de recepción activos" icon={Building2} tone="from-amber-500 to-orange-600" />
    </div>

    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="flex w-full rounded-2xl border border-base bg-secondary p-1 sm:w-auto" role="tablist" aria-label="Vista de proveedores y compras">
        <button type="button" role="tab" aria-selected={view === 'suppliers'} onClick={() => { setView('suppliers'); setSearch(''); }} className={tabClass(view === 'suppliers')} style={{ fontSize: 12 }}>
          <Users size={16} aria-hidden="true" /> Directorio
          <span className={cn('rounded-full px-2 py-0.5 font-black', view === 'suppliers' ? 'bg-white/20' : 'bg-subtle text-secondary')} style={{ fontSize: 11 }}>{suppliers.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={view === 'orders'} onClick={() => { setView('orders'); setSearch(''); }} className={tabClass(view === 'orders')} style={{ fontSize: 12 }}>
          <Truck size={16} aria-hidden="true" /> Órdenes
          <span className={cn('rounded-full px-2 py-0.5 font-black', view === 'orders' ? 'bg-white/20' : 'bg-subtle text-secondary')} style={{ fontSize: 11 }}>{supplierOrders.length}</span>
        </button>
      </div>
      <div className="flex w-full flex-col gap-2 sm:ml-auto sm:w-auto sm:flex-row">
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">{view === 'suppliers' ? 'Buscar proveedor' : 'Buscar orden'}</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={view === 'suppliers' ? 'Nombre, teléfono o mercancía' : 'Número de orden o proveedor'} className="w-full rounded-xl border border-base bg-secondary py-2.5 pl-9 pr-3 text-primary outline-none focus:border-violet-500" />
        </label>
        {view === 'orders' && (
          <label className="block w-full sm:w-44">
            <span className="sr-only">Filtrar por estado</span>
            <select value={status} onChange={event => setStatus(event.target.value)} className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 font-bold text-primary outline-none focus:border-violet-500">
              <option value="all">Todos los estados</option>
              <option value="pending">Pendientes</option>
              <option value="received">Recibidas</option>
              <option value="cancelled">Canceladas</option>
              <option value="draft">Borradores</option>
            </select>
          </label>
        )}
      </div>
    </div>

    {view === 'suppliers' ? (
      filteredSuppliers.length ? (
        <section aria-label="Directorio de proveedores" className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
            <p className="font-bold text-muted" style={{ fontSize: 12 }}>
              {sortedSuppliers.length} {sortedSuppliers.length === 1 ? 'proveedor' : 'proveedores'} · {directoryOrders} {directoryOrders === 1 ? 'orden' : 'órdenes'}
            </p>
            <button
              type="button"
              onClick={() => setSortAsc(current => !current)}
              aria-label={sortAsc ? 'Ordenar proveedores de la Z a la A' : 'Ordenar proveedores de la A a la Z'}
              title={sortAsc ? 'Orden actual: A–Z' : 'Orden actual: Z–A'}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-base bg-secondary px-2.5 font-black uppercase text-secondary transition-colors hover:border-violet-400 hover:text-violet-700 dark:hover:text-violet-300"
              style={{ fontSize: 11 }}
            >
              <ArrowUpDown size={13} aria-hidden="true" /> {sortAsc ? 'A–Z' : 'Z–A'}
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-base bg-secondary">
            <div className="hidden border-b border-base bg-subtle/70 px-4 py-2.5 lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.7fr)_minmax(0,1.1fr)_minmax(0,5rem)_auto] lg:items-center lg:gap-3">
              {['Proveedor', 'Contacto', 'Suministra', 'Órdenes', 'Acciones'].map((label, index) => (
                <span
                  key={label}
                  className={cn('font-black uppercase text-muted', index === 3 && 'text-center', index === 4 && 'text-right')}
                  style={{ fontSize: 10, letterSpacing: '0.1em' }}
                >
                  {label}
                </span>
              ))}
            </div>

            <ul className="divide-y divide-base">
              {sortedSuppliers.map(supplier => {
                const count = ordersFor(supplier.id);
                const linked = supplier.products?.length || 0;
                const selected = selectedId === supplier.id;
                return (
                  <li
                    key={supplier.id}
                    className={cn(
                      'transition-colors',
                      selected ? 'bg-violet-50 ring-1 ring-inset ring-violet-400 dark:bg-violet-950/40 dark:ring-violet-700' : 'hover:bg-subtle',
                    )}
                  >
                    <div
                      onClick={() => setSelectedId(supplier.id)}
                      className="flex min-w-0 cursor-pointer flex-col gap-2.5 px-3 py-3 sm:px-4 lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.7fr)_minmax(0,1.1fr)_minmax(0,5rem)_auto] lg:items-center lg:gap-3"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm', avatarTone(supplier.id))} style={{ fontSize: 15, fontWeight: 900 }} aria-hidden="true">
                          {initials(supplier.name)}
                        </span>
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={event => { event.stopPropagation(); setSelectedId(supplier.id); }}
                            aria-label={`Ver detalle de ${supplier.name}`}
                            className="block max-w-full truncate text-left font-black text-primary transition-colors hover:text-violet-600 dark:hover:text-violet-300"
                          >
                            {supplier.name}
                          </button>
                          <span className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded-full border border-base bg-subtle px-2 py-0.5 font-bold text-secondary" style={{ fontSize: 11 }}>
                            <Package size={11} aria-hidden="true" />
                            <span className="truncate">{supplier.typeOfMerchandise || 'Sin clasificar'}</span>
                          </span>
                        </div>
                      </div>

                      <div className="flex min-w-0 flex-col gap-0.5 text-secondary" style={{ fontSize: 12 }}>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Phone size={13} className="shrink-0 text-muted" aria-hidden="true" />
                          {supplier.phone
                            ? <a href={`tel:${supplier.phone}`} onClick={event => event.stopPropagation()} className="min-w-0 truncate hover:text-violet-600 dark:hover:text-violet-300">{supplier.phone}</a>
                            : <span className="text-muted">Sin teléfono</span>}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <MapPin size={13} className="shrink-0 text-muted" aria-hidden="true" />
                          <span className="min-w-0 truncate">{supplier.address || 'Sin dirección'}</span>
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 lg:contents">
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-base bg-subtle px-2 py-1 font-bold text-secondary" style={{ fontSize: 11 }} title={`${linked} productos asociados`}>
                          <Package size={11} aria-hidden="true" /> <span className="truncate">{linked} {linked === 1 ? 'producto' : 'productos'}</span>
                        </span>
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-base bg-subtle px-2 py-1 font-bold text-secondary lg:justify-self-center" style={{ fontSize: 11 }} title={`${count} órdenes registradas`}>
                          <Truck size={11} aria-hidden="true" />
                          <span className="font-black tabular-nums text-primary">{count}</span> <span className="truncate">{count === 1 ? 'orden' : 'órdenes'}</span>
                        </span>
                        <div className="ml-auto flex items-center gap-1.5 lg:ml-0 lg:justify-self-end">
                          <button
                            type="button"
                            onClick={event => { event.stopPropagation(); setSelectedId(supplier.id); }}
                            aria-label={`Ver detalle de ${supplier.name}`}
                            title="Ver detalle"
                            className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm transition-colors hover:bg-violet-700"
                          >
                            <ArrowRight size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={event => { event.stopPropagation(); openSupplier(supplier); }}
                            aria-label={`Editar ${supplier.name}`}
                            title="Editar proveedor"
                            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-subtle hover:text-violet-600 dark:hover:text-violet-300"
                          >
                            <Pencil size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={event => { event.stopPropagation(); setSelectedId(supplier.id); setView('orders'); setSearch(''); }}
                            aria-label={`Ver órdenes de ${supplier.name}`}
                            title="Ver órdenes"
                            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-subtle hover:text-violet-600 dark:hover:text-violet-300"
                          >
                            <ShoppingCart size={16} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-base bg-secondary p-8 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300"><Users size={26} aria-hidden="true" /></span>
          <h2 className="mt-3 text-lg font-black text-primary">{search ? 'Sin coincidencias' : 'Aún no hay proveedores'}</h2>
          <p className="mx-auto mt-1 max-w-md text-secondary">{search ? 'Prueba con otro nombre, teléfono o tipo de mercancía.' : 'Registra el primer proveedor para organizar compras, precios y recepciones.'}</p>
          {!search && <button type="button" onClick={() => openSupplier()} className={cn(primaryButton, 'mt-4')}><Plus size={16} aria-hidden="true" /> Registrar proveedor</button>}
        </section>
      )
    ) : (
      <section className="flex flex-col gap-3">
        {!planAllowsPurchases && <p className="rounded-xl border border-base bg-subtle p-3 text-secondary">La creación y recepción de órdenes requieren acceso a Compras. El historial se conserva.</p>}
        {selectedSupplier && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 dark:border-violet-900 dark:bg-violet-950/40">
            <span className="font-bold text-violet-700 dark:text-violet-300">Órdenes de {selectedSupplier.name}</span>
            <button type="button" onClick={() => setSelectedId(null)} className="ml-auto inline-flex items-center gap-1 font-black uppercase text-violet-700 dark:text-violet-300" style={{ fontSize: 11 }}>
              Mostrar todas <ArrowRight size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        {filteredOrders.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredOrders.map(order => {
              const meta = statusStyles[order.status] || statusStyles.pending;
              const StatusIcon = meta.icon;
              const queued = hasQueuedReceipt(order.id);
              return (
                <article key={order.id} className="flex flex-col rounded-2xl border border-base bg-secondary p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-black text-primary">Orden {documentCode('OC', order.id)}</h3>
                      <p className="mt-0.5 truncate text-secondary">{supplierById.get(order.supplierId)?.name || 'Proveedor no disponible'}</p>
                    </div>
                    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 font-black uppercase', queued ? 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200' : meta.chip)} style={{ fontSize: 10, letterSpacing: '0.06em' }}>
                      <StatusIcon size={11} aria-hidden="true" />
                      {queued ? 'Por sincronizar' : statusLabels[order.status]}
                    </span>
                  </div>
                  <div className="mt-3 space-y-1.5 text-secondary">
                    <div className="flex items-center gap-2"><Clock size={14} className="shrink-0 text-muted" aria-hidden="true" /> {new Date(order.date).toLocaleDateString('es-CU', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                    <div className="flex items-center gap-2"><Package size={14} className="shrink-0 text-muted" aria-hidden="true" /> {order.items.length} {order.items.length === 1 ? 'producto' : 'productos'}{order.expectedDeliveryDate ? ` · entrega ${shortDate(order.expectedDeliveryDate)}` : ''}</div>
                  </div>
                  <div className="mt-4 flex items-end justify-between gap-2 border-t border-base pt-3">
                    <div className="min-w-0">
                      <span className="block font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>Total con transporte</span>
                      <span className="block truncate text-lg font-black tabular-nums text-primary">{money(order.total + (order.transportCost || 0))}</span>
                    </div>
                    <button type="button" onClick={() => setDetailOrderId(order.id)} aria-label={`Ver orden ${documentCode('OC', order.id)}`} className={secondaryButton} style={{ fontSize: 12 }}>
                      Ver orden
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-base bg-secondary p-8 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300"><Truck size={26} aria-hidden="true" /></span>
            <h2 className="mt-3 text-lg font-black text-primary">No hay órdenes que coincidan</h2>
            <p className="mx-auto mt-1 max-w-md text-secondary">Ajusta la búsqueda o el estado, o crea una orden para un proveedor.</p>
            {planAllowsPurchases && <button type="button" onClick={() => openOrder()} className={cn(primaryButton, 'mt-4')}><Plus size={16} aria-hidden="true" /> Nueva orden</button>}
          </div>
        )}
      </section>
    )}

    {selectedSupplier && (
      <SupplierDetail
        supplier={selectedSupplier}
        ordersCount={ordersFor(selectedSupplier.id)}
        products={products}
        money={money}
        onClose={() => setSelectedId(null)}
        onEdit={() => { setSelectedId(null); openSupplier(selectedSupplier); }}
        onOrders={() => { setSelectedId(selectedSupplier.id); setView('orders'); setSearch(''); }}
        onDelete={() => { setSelectedId(null); setDeleteTarget(selectedSupplier); }}
      />
    )}

    {deleteTarget && (
      <OperationsDialog title="Eliminar proveedor" onClose={() => setDeleteTarget(null)}>
        <div className="space-y-4">
          <p className="text-secondary">¿Eliminar a <strong className="text-primary">{deleteTarget.name}</strong>? Se borrará su ficha y los precios de compra asociados. Esta acción no se puede deshacer.</p>
          {ordersFor(deleteTarget.id) > 0 && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Tiene órdenes registradas; por seguridad no se puede eliminar.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setDeleteTarget(null)} className={secondaryButton}>Volver</button>
            <button type="button" onClick={confirmDeleteSupplier} disabled={ordersFor(deleteTarget.id) > 0} className={dangerButton}><Trash2 size={16} aria-hidden="true" /> Eliminar definitivamente</button>
          </div>
        </div>
      </OperationsDialog>
    )}

    {detailOrder && !orderModal && !confirmation && (() => {
      const meta = statusStyles[detailOrder.status] || statusStyles.pending;
      const StatusIcon = meta.icon;
      return (
        <OperationsDialog title={`Orden ${documentCode('OC', detailOrder.id)}`} onClose={() => setDetailOrderId(null)}>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-black text-primary">{supplierById.get(detailOrder.supplierId)?.name || 'Proveedor no disponible'}</p>
              <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-black uppercase', hasQueuedReceipt(detailOrder.id) ? 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200' : meta.chip)} style={{ fontSize: 10, letterSpacing: '0.06em' }}>
                <StatusIcon size={12} aria-hidden="true" />
                {hasQueuedReceipt(detailOrder.id) ? 'Recepción por sincronizar' : statusLabels[detailOrder.status]}
              </span>
            </div>

            <dl className="grid gap-2 sm:grid-cols-2">
              {[
                { label: 'Almacén de destino', value: branches.find(branch => branch.id === detailOrder.branchId)?.name || 'No disponible' },
                { label: 'Entrega prevista', value: longDate(detailOrder.expectedDeliveryDate) || 'No definida' },
                { label: 'Fecha de la orden', value: new Date(detailOrder.date).toLocaleDateString('es-CU') },
                { label: 'Transporte', value: `${money(detailOrder.transportCost || 0)} · ${detailOrder.transportDetails || 'Sin detalles'}` },
              ].map(row => (
                <div key={row.label} className="rounded-xl border border-base bg-subtle p-3">
                  <dt className="font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>{row.label}</dt>
                  <dd className="mt-0.5 font-bold text-primary">{row.value}</dd>
                </div>
              ))}
            </dl>

            <section>
              <h3 className="font-black uppercase text-secondary" style={{ fontSize: 12, letterSpacing: '0.08em' }}>Productos</h3>
              <ul className="mt-2 divide-y divide-base rounded-xl border border-base">
                {detailOrder.items.map((item, index) => (
                  <li key={index} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <span className="min-w-0">
                      <span className="block font-bold text-primary">{item.quantity} × {item.productName}</span>
                      <span className="block text-muted" style={{ fontSize: 12 }}>{item.variantLabel ? `${item.variantLabel} · ` : ''}{money(item.cost)} por unidad</span>
                    </span>
                    <strong className="tabular-nums text-primary">{money(item.quantity * item.cost)}</strong>
                  </li>
                ))}
              </ul>
            </section>

            <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/40">
              <div className="flex justify-between text-secondary"><span>Mercancía</span><span className="tabular-nums">{money(detailOrder.total)}</span></div>
              <div className="flex justify-between text-secondary"><span>Transporte</span><span className="tabular-nums">{money(detailOrder.transportCost || 0)}</span></div>
              <div className="mt-1 flex justify-between border-t border-violet-200 pt-1 font-black text-primary dark:border-violet-900"><span>Total</span><span className="tabular-nums">{money(detailOrder.total + (detailOrder.transportCost || 0))}</span></div>
            </div>

            {detailOrder.status === 'pending' && !hasQueuedReceipt(detailOrder.id) && (
              <div className="space-y-3 border-t border-base pt-4">
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={!planAllowsPurchases || busy} onClick={() => { resetFeedback(); setConfirmation({ id: detailOrder.id, status: 'received' }); }} className={primaryButton}><CheckCircle2 size={16} aria-hidden="true" /> Confirmar recepción</button>
                  <button type="button" disabled={!planAllowsPurchases || busy} onClick={() => openOrder(detailOrder)} className={secondaryButton}><Pencil size={16} aria-hidden="true" /> Editar orden</button>
                  <button type="button" disabled={!planAllowsPurchases || busy} onClick={() => { resetFeedback(); setConfirmation({ id: detailOrder.id, status: 'cancelled' }); }} className={cn(dangerButton, 'ml-auto')}><Ban size={16} aria-hidden="true" /> Cancelar orden</button>
                </div>
                <p className="text-muted" style={{ fontSize: 12 }}>La recepción se registra por la orden completa e incorpora las cantidades al inventario. No la repitas.</p>
              </div>
            )}
            {hasQueuedReceipt(detailOrder.id) && <p role="status" className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">Esta recepción ya está guardada para sincronización. No se puede editar, cancelar ni volver a recibir mientras esté pendiente.</p>}
          </div>
        </OperationsDialog>
      );
    })()}

    {confirmation && (
      <OperationsDialog title={confirmation.status === 'received' ? 'Confirmar recepción de mercancía' : 'Cancelar orden de compra'} busy={busy} onClose={() => setConfirmation(null)}>
        {feedback}
        <p className="my-4 text-secondary">{confirmation.status === 'received' ? 'Confirma solo si la mercancía llegó completa al almacén indicado. La recepción se registra por la orden completa, sin recepciones parciales, e incorpora las cantidades al inventario; no debes repetirla.' : 'La orden se conservará como cancelada y no se agregará mercancía al inventario.'}</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy} onClick={() => setConfirmation(null)} className={secondaryButton}>Volver</button>
          <button type="button" disabled={busy} onClick={() => void confirmOrder()} className={confirmation.status === 'received' ? primaryButton : 'rounded-xl bg-red-600 px-4 font-black uppercase text-white transition-colors hover:bg-red-700 disabled:opacity-50'}>{busy ? 'Procesando…' : confirmation.status === 'received' ? 'Recibir mercancía' : 'Cancelar orden'}</button>
        </div>
      </OperationsDialog>
    )}

    {supplierModal && (
      <OperationsDialog title={editingSupplier ? 'Editar proveedor' : 'Nuevo proveedor'} onClose={() => setSupplierModal(false)}>
        {feedback}
        <form onSubmit={saveSupplier} className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block font-bold text-secondary">Nombre *<input required autoFocus value={supplierDraft.name || ''} onChange={event => setSupplierDraft({ ...supplierDraft, name: event.target.value })} className={inputClass} /></label>
            <label className="block font-bold text-secondary">Teléfono *<input type="tel" required placeholder="+53" value={supplierDraft.phone || ''} onChange={event => setSupplierDraft({ ...supplierDraft, phone: event.target.value })} className={inputClass} /></label>
            <label className="block font-bold text-secondary">Dirección<input value={supplierDraft.address || ''} onChange={event => setSupplierDraft({ ...supplierDraft, address: event.target.value })} className={inputClass} /></label>
            <label className="block font-bold text-secondary">Tipo de mercancía<input placeholder="Ej: alimentos, textiles…" value={supplierDraft.typeOfMerchandise || ''} onChange={event => setSupplierDraft({ ...supplierDraft, typeOfMerchandise: event.target.value })} className={inputClass} /></label>
            <label className="block font-bold text-secondary sm:col-span-2">Correo (opcional)<input type="email" value={supplierDraft.email || ''} onChange={event => setSupplierDraft({ ...supplierDraft, email: event.target.value })} className={inputClass} /></label>
          </div>

          <fieldset className="rounded-xl border border-base p-3">
            <legend className="px-2 font-black uppercase text-secondary" style={{ fontSize: 12, letterSpacing: '0.08em' }}>Productos y precios de compra</legend>
            <p className="mb-3 text-muted" style={{ fontSize: 12 }}>{linkedProductCount} {linkedProductCount === 1 ? 'producto asociado' : 'productos asociados'}. Busca por nombre o SKU para agregarlos sin recorrer la lista completa.</p>

            {supplierProducts.length > 0 && (
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                {supplierProducts.map((item, index) => {
                  const product = productById.get(item.productId);
                  return (
                    <div key={`${item.productId}-${index}`} className="rounded-xl border border-base bg-subtle p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-bold text-primary">{product?.name || 'Producto no disponible'}</p>
                          <p className="truncate text-muted" style={{ fontSize: 12 }}>{product?.sku || 'Sin SKU'}</p>
                        </div>
                        <button type="button" aria-label={`Quitar ${product?.name || 'producto'}`} onClick={() => setSupplierDraft({ ...supplierDraft, products: supplierProducts.filter((_, i) => i !== index) })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300">
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                      <label className="mt-2 block font-bold text-secondary" style={{ fontSize: 12 }}>Precio de compra ({currency})
                        <input required type="number" min="0" step="0.01" value={item.purchasePrice ?? 0} onChange={event => setSupplierDraft({ ...supplierDraft, products: supplierProducts.map((row, i) => i === index ? { ...row, purchasePrice: Number(event.target.value) } : row) })} className={inputClass} />
                      </label>
                    </div>
                  );
                })}
              </div>
            )}

            {products.length ? (
              <ProductSearch
                products={products}
                currency={currency}
                excludeIds={linkedProductIds}
                onPick={product => setSupplierDraft(current => ({ ...current, products: [...(current.products || []), { productId: product.id, purchasePrice: product.costPrice || 0 }] }))}
                placeholder={supplierProducts.length ? 'Agregar otro producto…' : 'Buscar producto para agregar…'}
              />
            ) : (
              <p className="rounded-xl border border-dashed border-base p-3 text-secondary">No hay productos en el inventario. Créalos primero en Inventario.</p>
            )}
            {supplierProducts.length === 0 && products.length > 0 && <p className="mt-2 flex items-center gap-1.5 text-muted" style={{ fontSize: 12 }}><PackageSearch size={13} aria-hidden="true" /> Elige un producto del buscador y ajusta su precio si hace falta.</p>}
          </fieldset>

          <div className="flex flex-wrap justify-end gap-2 border-t border-base pt-4">
            <button type="button" onClick={() => setSupplierModal(false)} className={secondaryButton}>Cancelar</button>
            <button type="submit" className={primaryButton}>{editingSupplier ? 'Guardar cambios' : 'Registrar proveedor'}</button>
          </div>
        </form>
      </OperationsDialog>
    )}

    {orderModal && (
      <OperationsDialog title={editingOrderId ? 'Editar orden de compra' : 'Nueva orden de compra'} busy={busy} size="lg" onClose={() => setOrderModal(false)}>
        {feedback}
        <form onSubmit={saveOrder} className="mt-4">
          <fieldset disabled={busy} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block font-bold text-secondary">Proveedor *<select required value={orderDraft.supplierId} onChange={event => setOrderDraft({ ...orderDraft, supplierId: event.target.value })} className={inputClass}><option value="">Seleccionar</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
              <label className="block font-bold text-secondary">Almacén de destino *<select required value={orderDraft.branchId} onChange={event => setOrderDraft({ ...orderDraft, branchId: event.target.value })} className={inputClass}><option value="">Seleccionar</option>{branches.filter(branch => branch.isActive !== false).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
              <label className="block font-bold text-secondary">Entrega prevista<input type="date" value={orderDraft.expectedDeliveryDate} onChange={event => setOrderDraft({ ...orderDraft, expectedDeliveryDate: event.target.value })} className={inputClass} /></label>
              <label className="block font-bold text-secondary">Costo de transporte ({currency})<input type="number" min="0" step="0.01" value={orderDraft.transportCost} onChange={event => setOrderDraft({ ...orderDraft, transportCost: Number(event.target.value) })} className={inputClass} /></label>
              <label className="block font-bold text-secondary sm:col-span-2">Detalles de transporte<input placeholder="Ej: flete desde La Habana" value={orderDraft.transportDetails} onChange={event => setOrderDraft({ ...orderDraft, transportDetails: event.target.value })} className={inputClass} /></label>
            </div>

            <section className="rounded-xl border border-base p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-black uppercase text-secondary" style={{ fontSize: 12, letterSpacing: '0.08em' }}>Productos de la orden</h3>
                <span className="font-bold text-muted" style={{ fontSize: 12 }}>{orderDraft.items.length}</span>
              </div>

              {orderDraft.items.length > 0 && (
                <div className="mt-3 space-y-2">
                  {orderDraft.items.map((item, index) => {
                    const product = productById.get(item.productId);
                    const variants = [...new Set([...(product?.availableSizes || []), ...(product?.availableColors || [])])];
                    return (
                      <div key={`${item.productId}-${index}`} className="rounded-xl border border-base bg-subtle p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-bold text-primary">{product?.name || 'Producto no disponible'}</p>
                            <p className="truncate text-muted" style={{ fontSize: 12 }}>{product?.sku || 'Sin SKU'} · {money(item.quantity * item.cost)}</p>
                          </div>
                          <button type="button" aria-label={`Quitar ${product?.name || 'producto'}`} onClick={() => setOrderDraft({ ...orderDraft, items: orderDraft.items.filter((_, i) => i !== index) })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300">
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <label className="block font-bold text-secondary" style={{ fontSize: 12 }}>Cantidad *
                            <input required type="number" min="1" step="1" value={item.quantity} onChange={event => updateOrderItem(index, { quantity: Number(event.target.value) })} className={inputClass} />
                          </label>
                          <label className="block font-bold text-secondary" style={{ fontSize: 12 }}>Costo unitario ({currency}) *
                            <input required type="number" min="0" step="0.01" value={item.cost} onChange={event => updateOrderItem(index, { cost: Number(event.target.value) })} className={inputClass} />
                          </label>
                        </div>
                        {variants.length > 0 && (
                          <label className="mt-2 block font-bold text-secondary" style={{ fontSize: 12 }}>Variante *
                            <select required value={item.variantLabel || ''} onChange={event => updateOrderItem(index, { variantLabel: event.target.value })} className={inputClass}>
                              <option value="">Seleccionar variante</option>
                              {variants.map(variant => <option key={variant} value={variant}>{variant}</option>)}
                            </select>
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {products.length ? (
                <div className="mt-3">
                  <ProductSearch
                    products={products}
                    currency={currency}
                    onPick={product => setOrderDraft(current => ({ ...current, items: [...current.items, { productId: product.id, quantity: 1, cost: product.costPrice || 0 }] }))}
                    placeholder="Buscar producto para la orden…"
                  />
                  {!orderDraft.items.length && <p className="mt-2 flex items-center gap-1.5 text-muted" style={{ fontSize: 12 }}><PackageSearch size={13} aria-hidden="true" /> Busca por nombre o SKU; la primera coincidencia se agrega con su último costo.</p>}
                </div>
              ) : (
                <p className="mt-3 rounded-xl border border-dashed border-base p-3 text-secondary">No hay productos en el inventario. Créalos primero en Inventario.</p>
              )}
            </section>

            <div className="grid gap-2 rounded-xl border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/40 sm:grid-cols-3">
              <div><span className="block font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>Mercancía</span><span className="font-black tabular-nums text-primary">{money(orderTotal)}</span></div>
              <div><span className="block font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>Transporte</span><span className="font-black tabular-nums text-primary">{money(orderDraft.transportCost)}</span></div>
              <div><span className="block font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>Total estimado</span><span className="font-black tabular-nums text-violet-700 dark:text-violet-300">{money(orderTotal + (orderDraft.transportCost || 0))}</span></div>
            </div>

            <p className="text-secondary" style={{ fontSize: 12 }}>Crear la orden no modifica las existencias. Confirma la recepción cuando llegue la mercancía.</p>

            <div className="flex flex-wrap justify-end gap-2 border-t border-base pt-4">
              <button type="button" onClick={() => setOrderModal(false)} className={secondaryButton}>Cancelar</button>
              <button type="submit" disabled={!planAllowsPurchases || busy} className={primaryButton}>{busy ? 'Guardando…' : 'Guardar orden'}</button>
            </div>
          </fieldset>
        </form>
      </OperationsDialog>
    )}
  </OperationsSurface>;
}

export default function Suppliers() {
  return <PlanFeatureGate feature="customers_suppliers" title="Proveedores" description="Esta función está incluida en Caravana para negocios que necesitan ampliar el control de su operación."><SuppliersContent /></PlanFeatureGate>;
}
