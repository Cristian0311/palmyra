import PlanFeatureGate from "../components/PlanFeatureGate";
import OperationsSurface from "../components/OperationsSurface";
import { InfoTooltip } from "../components/InfoTooltip";
import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Banknote,
  CheckCircle2,
  CircleCheck,
  CircleDollarSign,
  Clock3,
  Hash,
  Loader2,
  Minus,
  Package,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldPlus,
  User,
  X,
  XCircle,
} from "lucide-react";
import { useStore } from "../store/useStore";
import { cn } from "../lib/utils";
import { documentCode, ticketDisplay } from "../lib/documentCodes";
import type { Customer, ReturnItem, Transaction, Warranty } from "../types";

type ReturnFilter = 'all' | 'pending' | 'completed' | 'rejected';
type WarrantyFilter = 'all' | 'active' | 'expiring' | 'expired' | 'closed';
type RefundMethod = 'cash' | 'transfer' | 'store_credit';

const REASONS = [
  { value: 'defecto_fabrica', label: 'Defecto de fábrica' },
  { value: 'dano_transporte', label: 'Daño en transporte' },
  { value: 'producto_incorrecto', label: 'Producto incorrecto' },
  { value: 'insatisfaccion', label: 'Insatisfacción' },
  { value: 'otros', label: 'Otros / ver notas' },
];

const reasonLabel = (value: string) => REASONS.find(r => r.value === value)?.label || value || 'Sin motivo';

const REFUND_METHODS: { value: RefundMethod; label: string }[] = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'store_credit', label: 'Crédito a favor' },
];

const MS_DAY = 86_400_000;
const safeDate = (iso?: string) => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};
const shortDate = (iso?: string) => {
  const date = safeDate(iso);
  return date ? date.toLocaleDateString('es-CU', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
};
const daysLeft = (iso: string) => {
  const date = safeDate(iso);
  if (!date) return 0;
  return Math.ceil((date.getTime() - Date.now()) / MS_DAY);
};
const returnCode = (item: ReturnItem) => documentCode('RET', item.id);
const warrantyCode = (w: Warranty) => documentCode('GAR', w.id);
const ticketLabel = (tx: Transaction) => ticketDisplay(tx.ticketNumber, tx.id);
const fmtMoney = (value: number, currency: string) =>
  `${(Number(value) || 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

type TxLine = {
  key: string;
  productId: string;
  productName: string;
  variantLabel?: string;
  sold: number;
  returned: number;
  price: number;
};

function buildTicketLines(tx: Transaction, returns: ReturnItem[]): TxLine[] {
  const map = new Map<string, TxLine>();
  for (const item of tx.items) {
    const key = `${item.product.id}::${item.variantLabel || ''}`;
    const existing = map.get(key);
    if (existing) {
      existing.sold += item.quantity;
    } else {
      map.set(key, {
        key,
        productId: item.product.id,
        productName: item.product.name,
        variantLabel: item.variantLabel,
        sold: item.quantity,
        returned: 0,
        price: Number(item.price) || 0,
      });
    }
  }
  for (const ret of returns) {
    if (ret.transactionId !== tx.id || ret.status === 'rejected') continue;
    const line = map.get(`${ret.productId}::${ret.variantLabel || ''}`);
    if (line) line.returned += ret.quantity;
  }
  return Array.from(map.values());
}

function ReturnsContent() {
  const {
    returns,
    transactions,
    products,
    warranties,
    customers,
    currencies,
    currentBranchId,
    createReturn,
    updateReturn,
    processReturn,
    addNotification,
    getBaseCurrency,
  } = useStore(useShallow((state) => ({
    returns: state.returns,
    transactions: state.transactions,
    products: state.products,
    warranties: state.warranties,
    customers: state.customers,
    currencies: state.currencies,
    currentBranchId: state.currentBranchId,
    createReturn: state.createReturn,
    updateReturn: state.updateReturn,
    processReturn: state.processReturn,
    addNotification: state.addNotification,
    getBaseCurrency: state.getBaseCurrency,
  })));

  const baseCurrency = getBaseCurrency();
  const [activeTab, setActiveTab] = useState<'returns' | 'warranties'>('returns');
  const [searchQuery, setSearchQuery] = useState('');
  const [returnFilter, setReturnFilter] = useState<ReturnFilter>('all');
  const [warrantyFilter, setWarrantyFilter] = useState<WarrantyFilter>('all');
  const [modalState, setModalState] = useState<
    | { kind: 'new'; prefill?: { transactionId: string; productId?: string; type?: 'warranty_exchange' | 'refund' } }
    | { kind: 'action'; returnItem: ReturnItem; action: 'complete' | 'reject' }
    | { kind: 'refund'; returnItem: ReturnItem }
    | null
  >(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const transactionById = useMemo(() => new Map(transactions.map(t => [t.id, t])), [transactions]);

  const pendingReturns = returns.filter(r => r.status === 'pending');
  const receivedReturns = returns.filter(r => r.status === 'completed');
  const openRefunds = returns.filter(r => r.type === 'refund' && r.refundStatus !== 'paid' && r.refundStatus !== 'rejected');
  const activeWarranties = warranties.filter(w => w.status === 'active' && daysLeft(w.expiryDate) > 0);
  const expiringWarranties = activeWarranties.filter(w => daysLeft(w.expiryDate) <= 30);

  const query = searchQuery.trim().toLowerCase();
  const customerOf = (tx?: Transaction) => (tx?.customerId ? customerById.get(tx.customerId) : undefined);

  const filteredReturns = useMemo(() => {
    const list = returns.filter(ret => {
      if (returnFilter !== 'all' && ret.status !== returnFilter) return false;
      if (!query) return true;
      const product = productById.get(ret.productId);
      const tx = transactionById.get(ret.transactionId);
      const customer = customerOf(tx);
      return (
        ret.id.toLowerCase().includes(query) ||
        returnCode(ret).toLowerCase().includes(query) ||
        ret.transactionId.toLowerCase().includes(query) ||
        (tx?.ticketNumber || '').toLowerCase().includes(query) ||
        (product?.name || '').toLowerCase().includes(query) ||
        (customer?.name || '').toLowerCase().includes(query) ||
        (customer?.phone || '').includes(query)
      );
    });
    return list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [returns, returnFilter, query, productById, transactionById, customerById]);

  const filteredWarranties = useMemo(() => {
    const list = warranties.filter(w => {
      const left = daysLeft(w.expiryDate);
      const expired = left <= 0 || w.status === 'expired';
      const closed = w.status === 'claimed' || w.status === 'refunded' || w.status === 'exchanged';
      if (warrantyFilter === 'active' && (expired || closed)) return false;
      if (warrantyFilter === 'expiring' && (expired || closed || left > 30)) return false;
      if (warrantyFilter === 'expired' && !expired) return false;
      if (warrantyFilter === 'closed' && !closed) return false;
      if (!query) return true;
      return (
        w.id.toLowerCase().includes(query) ||
        warrantyCode(w).toLowerCase().includes(query) ||
        w.productName.toLowerCase().includes(query) ||
        (w.customerName || '').toLowerCase().includes(query) ||
        (w.serialNumber || '').toLowerCase().includes(query) ||
        w.transactionId.toLowerCase().includes(query)
      );
    });
    return list.sort((a, b) => (a.expiryDate || '').localeCompare(b.expiryDate || ''));
  }, [warranties, warrantyFilter, query]);

  const runReturnAction = async (returnItem: ReturnItem, action: 'complete' | 'reject', note: string) => {
    setBusyId(returnItem.id);
    if (note.trim()) {
      updateReturn(returnItem.id, {
        notes: returnItem.notes ? `${returnItem.notes} · ${note.trim()}` : note.trim(),
      });
    }
    const confirmed = await processReturn(returnItem.id, action);
    setBusyId(null);
    setModalState(null);
    if (confirmed === false) {
      addNotification('No se pudo confirmar con la nube. La devolución quedó en cola para reintento automático.', 'warning');
    } else {
      addNotification(action === 'complete' ? 'Recepción física confirmada.' : 'Devolución rechazada.', 'success');
    }
  };

  const openWarrantyReturn = (warranty: Warranty) => {
    const tx = transactionById.get(warranty.transactionId);
    if (!tx) {
      addNotification('La venta de esta garantía no está disponible en este dispositivo.', 'warning');
      return;
    }
    setModalState({
      kind: 'new',
      prefill: { transactionId: tx.id, productId: warranty.productId, type: 'warranty_exchange' },
    });
  };

  const viewWarrantyCase = (warranty: Warranty) => {
    const linked = returns.find(r => r.transactionId === warranty.transactionId && r.productId === warranty.productId);
    if (!linked) {
      addNotification('Esta garantía aún no tiene una devolución registrada.', 'info');
      return;
    }
    setActiveTab('returns');
    setReturnFilter('all');
    setSearchQuery(linked.id);
  };

  const returnCounts = {
    all: returns.length,
    pending: pendingReturns.length,
    completed: receivedReturns.length,
    rejected: returns.filter(r => r.status === 'rejected').length,
  };
  const warrantyCounts = {
    all: warranties.length,
    active: activeWarranties.length,
    expiring: expiringWarranties.length,
    expired: warranties.filter(w => daysLeft(w.expiryDate) <= 0 || w.status === 'expired').length,
    closed: warranties.filter(w => w.status === 'claimed' || w.status === 'refunded' || w.status === 'exchanged').length,
  };

  return (
    <OperationsSurface className="flex flex-col gap-4 -mx-3 -mt-3 px-3 pb-10 pt-3 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4 lg:-mx-6 lg:-mt-6 lg:px-6">
      <header className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 data-palmi-content="returns" className="text-xl sm:text-2xl font-black text-primary tracking-tight">Garantías y Devoluciones</h1>
            <InfoTooltip
              text="Registra devoluciones desde el ticket de venta, confirma la recepción física y controla los reembolsos y cambios por garantía por separado."
              position="bottom"
            />
          </div>
          <p className="text-sm text-muted mt-1">Recepción, cambios y reembolsos conectados al inventario y a los certificados de garantía.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-base bg-subtle p-1" role="tablist" aria-label="Secciones de post-venta">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'returns'}
              onClick={() => setActiveTab('returns')}
              className={cn(
                'flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 text-sm font-bold transition-colors',
                activeTab === 'returns' ? 'bg-secondary text-primary shadow-xs' : 'text-muted hover:text-primary',
              )}
            >
              Devoluciones
              <span className="rounded-md bg-violet-600 px-1.5 py-0.5 text-[10px] font-black text-white">{pendingReturns.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'warranties'}
              onClick={() => setActiveTab('warranties')}
              className={cn(
                'flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 text-sm font-bold transition-colors',
                activeTab === 'warranties' ? 'bg-secondary text-primary shadow-xs' : 'text-muted hover:text-primary',
              )}
            >
              Garantías
              <span className="rounded-md bg-subtle px-1.5 py-0.5 text-[10px] font-black text-secondary">{activeWarranties.length}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setModalState({ kind: 'new' })}
            className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-violet-600 px-4 text-sm font-bold text-white transition-colors hover:bg-violet-700"
          >
            <RotateCcw size={15} /> Nueva devolución
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm" aria-hidden="true">
              <Clock3 size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>Pendientes de recepción</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-amber-600 dark:text-amber-400">{pendingReturns.length}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>caso(s)</span>
          </div>
          <span className="mt-1 block font-semibold text-muted" style={{ fontSize: 12 }}>Esperando verificación física del artículo</span>
        </div>

        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-700 text-white shadow-sm" aria-hidden="true">
              <Banknote size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>Reembolsos por pagar</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-sky-600 dark:text-sky-400">{openRefunds.length}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>caso(s)</span>
          </div>
          <span className="mt-1 block font-semibold text-muted" style={{ fontSize: 12 }}>Registra monto y medio de pago al reembolsar</span>
        </div>

        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-sm" aria-hidden="true">
              <CheckCircle2 size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>Recepciones completadas</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-emerald-600 dark:text-emerald-400">{receivedReturns.length}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>recibidas</span>
          </div>
          <span className="mt-1 block font-semibold text-muted" style={{ fontSize: 12 }}>Stock y garantías ya actualizados</span>
        </div>

        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-violet-700 text-white shadow-sm" aria-hidden="true">
              <ShieldCheck size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>Garantías vigentes</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-primary">{activeWarranties.length}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>activas</span>
          </div>
          <span className={cn('mt-1 block font-semibold', expiringWarranties.length ? 'text-amber-600 dark:text-amber-400' : 'text-muted')} style={{ fontSize: 12 }}>
            {expiringWarranties.length ? `${expiringWarranties.length} vencen en los próximos 30 días` : 'Ninguna vence en los próximos 30 días'}
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
        <div className="flex flex-col gap-2 border-b border-base p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {activeTab === 'returns' ? (
              ([
                ['all', 'Todas'],
                ['pending', 'Pendientes'],
                ['completed', 'Recibidas'],
                ['rejected', 'Rechazadas'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setReturnFilter(key)}
                  className={cn(
                    'flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 text-sm font-bold transition-colors',
                    returnFilter === key
                      ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300'
                      : 'border-base bg-secondary text-secondary hover:bg-subtle hover:text-primary',
                  )}
                >
                  {label}
                  <span className="text-[11px] font-black text-muted">{returnCounts[key]}</span>
                </button>
              ))
            ) : (
              ([
                ['all', 'Todas'],
                ['active', 'Vigentes'],
                ['expiring', 'Por vencer'],
                ['expired', 'Vencidas'],
                ['closed', 'Cerradas'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setWarrantyFilter(key)}
                  className={cn(
                    'flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 text-sm font-bold transition-colors',
                    warrantyFilter === key
                      ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300'
                      : 'border-base bg-secondary text-secondary hover:bg-subtle hover:text-primary',
                  )}
                >
                  {label}
                  <span className="text-[11px] font-black text-muted">{warrantyCounts[key]}</span>
                </button>
              ))
            )}
          </div>

          <div className="relative w-full lg:max-w-xs">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === 'returns' ? 'Ticket, cliente, producto o código…' : 'Producto, serie, cliente o ticket…'}
              className="w-full rounded-xl border border-base bg-secondary py-2 pl-9 pr-3 text-sm font-semibold text-primary outline-none transition-shadow placeholder:font-medium placeholder:text-muted focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          {activeTab === 'returns' ? (
            <table className="w-full min-w-[960px] text-left text-sm [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-2.5">
              <thead className="border-b border-base bg-subtle text-[11px] font-black uppercase tracking-wider text-muted">
                <tr>
                  <th>Devolución</th>
                  <th>Ticket / Cliente</th>
                  <th>Producto</th>
                  <th>Tipo / Motivo</th>
                  <th>Recepción</th>
                  <th>Reembolso</th>
                </tr>
              </thead>
              <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-base">
                {filteredReturns.map(ret => {
                  const product = productById.get(ret.productId);
                  const tx = transactionById.get(ret.transactionId);
                  const customer = customerOf(tx);
                  const isBusy = busyId === ret.id;
                  const refundOpen = ret.type === 'refund' && ret.refundStatus !== 'paid' && ret.refundStatus !== 'rejected';
                  return (
                    <tr key={ret.id} className="align-top transition-colors hover:bg-subtle/60">
                      <td>
                        <div className="whitespace-nowrap font-mono text-sm font-black text-primary">{returnCode(ret)}</div>
                        <div className="mt-0.5 whitespace-nowrap text-xs font-semibold text-muted">{shortDate(ret.date)}</div>
                      </td>
                      <td>
                        <div className="whitespace-nowrap font-mono text-xs font-bold text-secondary">{tx ? ticketLabel(tx) : ticketDisplay(null, ret.transactionId)}</div>
                        {customer ? (
                          <div className="mt-0.5">
                            <div className="text-xs font-black uppercase tracking-tight text-primary">{customer.name}</div>
                            {customer.phone && <div className="text-[11px] font-semibold text-muted">{customer.phone}</div>}
                          </div>
                        ) : (
                          <div className="mt-0.5 text-[11px] font-semibold italic text-muted">Consumidor final</div>
                        )}
                      </td>
                      <td>
                        <div className="font-bold text-primary">{product?.name || 'Producto no disponible'}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-muted">
                          <span>Cant.: {ret.quantity}</span>
                          {ret.variantLabel && <span className="rounded-md bg-subtle px-1.5 py-0.5">{ret.variantLabel}</span>}
                        </div>
                      </td>
                      <td>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-black uppercase tracking-wide',
                            ret.type === 'warranty_exchange'
                              ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
                              : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
                          )}
                        >
                          <ArrowRightLeft size={11} /> {ret.type === 'warranty_exchange' ? 'Garantía' : 'Reembolso'}
                        </span>
                        <div className="mt-1 text-xs font-semibold text-secondary">{reasonLabel(ret.reason)}</div>
                      </td>
                      <td>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-black uppercase tracking-wide',
                            ret.status === 'pending' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
                            ret.status === 'completed' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
                            ret.status === 'rejected' && 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
                            ret.status === 'approved' && 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
                          )}
                        >
                          {ret.status === 'pending' && <Clock3 size={11} />}
                          {ret.status === 'completed' && <CheckCircle2 size={11} />}
                          {ret.status === 'rejected' && <XCircle size={11} />}
                          {ret.status === 'pending' ? 'Pendiente' : ret.status === 'completed' ? 'Recibida' : ret.status === 'rejected' ? 'Rechazada' : 'Aprobada'}
                        </span>
                        {ret.status === 'pending' && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setModalState({ kind: 'action', returnItem: ret, action: 'complete' })}
                              className="flex min-h-[34px] items-center gap-1 rounded-lg bg-violet-600 px-2.5 text-xs font-bold text-white transition-colors hover:bg-violet-700 disabled:opacity-60"
                            >
                              {isBusy ? <Loader2 size={12} className="animate-spin" /> : <CircleCheck size={12} />} Recibir
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setModalState({ kind: 'action', returnItem: ret, action: 'reject' })}
                              className="flex min-h-[34px] items-center gap-1 rounded-lg border border-red-200 px-2.5 text-xs font-bold text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40 disabled:opacity-60"
                            >
                              <XCircle size={12} /> Rechazar
                            </button>
                            <button
                              type="button"
                              onClick={() => updateReturn(ret.id, {
                                type: ret.type === 'refund' ? 'warranty_exchange' : 'refund',
                                refundStatus: ret.type === 'refund' ? 'not_required' : 'pending',
                              })}
                              className="flex min-h-[34px] items-center rounded-lg border border-base px-2.5 text-xs font-bold text-muted transition-colors hover:bg-subtle hover:text-primary"
                              title="Convertir el trámite entre cambio por garantía y reembolso"
                            >
                              Cambiar tipo
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        {ret.type !== 'refund' ? (
                          <span className="text-xs font-semibold text-muted">No aplica</span>
                        ) : (
                          <div className="space-y-1.5">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-black uppercase tracking-wide',
                                ret.refundStatus === 'paid' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
                                ret.refundStatus === 'approved' && 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
                                ret.refundStatus === 'rejected' && 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
                                (!ret.refundStatus || ret.refundStatus === 'pending' || ret.refundStatus === 'not_required') &&
                                  'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
                              )}
                            >
                              <CircleDollarSign size={11} />
                              {ret.refundStatus === 'paid' ? 'Pagado' : ret.refundStatus === 'approved' ? 'Aprobado' : ret.refundStatus === 'rejected' ? 'Rechazado' : 'Pendiente'}
                            </span>
                            {ret.refundAmount ? (
                              <div className="whitespace-nowrap text-xs font-black tabular-nums text-primary">
                                {fmtMoney(ret.refundAmount, ret.refundCurrencyCode || baseCurrency.code)}
                              </div>
                            ) : (
                              <div className="text-[11px] font-semibold text-muted">Monto por definir</div>
                            )}
                            <div className="text-[11px] font-semibold text-muted">
                              {ret.refundMethod ? REFUND_METHODS.find(m => m.value === ret.refundMethod)?.label : 'Sin medio de pago'}
                            </div>
                            {refundOpen && (
                              <button
                                type="button"
                                onClick={() => setModalState({ kind: 'refund', returnItem: ret })}
                                className="flex min-h-[34px] items-center gap-1 rounded-lg border border-base px-2.5 text-xs font-bold text-violet-700 transition-colors hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-500/10"
                              >
                                <Banknote size={12} /> Registrar pago
                              </button>
                            )}
                            {ret.refundStatus === 'paid' && ret.refundedAt && (
                              <div className="text-[11px] font-semibold text-muted">Pagado el {shortDate(ret.refundedAt)}</div>
                            )}
                          </div>
                        )}
                        {ret.notes && (
                          <p className="mt-1.5 max-w-[220px] text-[11px] font-medium leading-snug text-muted" title={ret.notes}>
                            {ret.notes}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filteredReturns.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <div className="flex flex-col items-center gap-2 py-12 text-center">
                        <RotateCcw size={28} className="text-muted" aria-hidden="true" />
                        <p className="text-base font-black text-primary">Sin devoluciones en esta vista</p>
                        <p className="max-w-sm text-sm text-muted">
                          {query || returnFilter !== 'all'
                            ? 'Ajusta el buscador o el filtro de estado.'
                            : 'Registra la primera devolución desde el ticket de venta.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full min-w-[980px] text-left text-sm [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-2.5">
              <thead className="border-b border-base bg-subtle text-[11px] font-black uppercase tracking-wider text-muted">
                <tr>
                  <th>Garantía</th>
                  <th>Producto / Serie</th>
                  <th>Cliente</th>
                  <th>Cobertura</th>
                  <th>Estado</th>
                  <th>Ticket</th>
                  <th className="text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-base">
                {filteredWarranties.map(w => {
                  const left = daysLeft(w.expiryDate);
                  const expired = left <= 0 || w.status === 'expired';
                  const closed = w.status === 'claimed' || w.status === 'refunded' || w.status === 'exchanged';
                  const purchase = safeDate(w.purchaseDate)?.getTime() || 0;
                  const expiry = safeDate(w.expiryDate)?.getTime() || 0;
                  const span = Math.max(1, expiry - purchase);
                  const progress = Math.min(100, Math.max(4, ((Date.now() - purchase) / span) * 100));
                  const customer = w.customerId
                    ? customerById.get(w.customerId)
                    : customers.find(c => c.name === w.customerName);
                  const tx = transactionById.get(w.transactionId);
                  return (
                    <tr key={w.id} className="align-top transition-colors hover:bg-subtle/60">
                      <td>
                        <div className="whitespace-nowrap font-mono text-xs font-black text-primary">{warrantyCode(w)}</div>
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5 font-bold text-primary">
                          <Package size={13} className="shrink-0 text-muted" />
                          {w.productName}
                        </div>
                        {w.serialNumber && (
                          <div className="mt-0.5 flex items-center gap-1 text-[11px] font-bold uppercase text-violet-600 dark:text-violet-300">
                            <Hash size={10} /> {w.serialNumber}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5 font-bold uppercase tracking-tight text-primary">
                          <User size={13} className="shrink-0 text-muted" />
                          {w.customerName || customer?.name || 'Consumidor final'}
                        </div>
                        {customer?.phone && <div className="mt-0.5 text-[11px] font-semibold text-muted">{customer.phone}</div>}
                      </td>
                      <td>
                        <div className="whitespace-nowrap text-[11px] font-semibold text-muted">
                          {shortDate(w.purchaseDate)} → {shortDate(w.expiryDate)}
                        </div>
                        <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-subtle">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              expired ? 'bg-red-500' : left <= 30 ? 'bg-amber-500' : 'bg-emerald-500',
                            )}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <div className={cn('mt-1 text-[11px] font-bold', expired ? 'text-red-600 dark:text-red-400' : left <= 30 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}>
                          {expired ? `Vencida hace ${Math.abs(left)} día(s)` : `Quedan ${left} día(s)`}
                        </div>
                      </td>
                      <td>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-black uppercase tracking-wide',
                            w.status === 'refunded' && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
                            w.status === 'exchanged' && 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
                            w.status === 'claimed' && 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
                            (w.status === 'expired' || (w.status === 'active' && expired)) && 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
                            w.status === 'active' && !expired && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
                          )}
                        >
                          {w.status === 'refunded' ? 'Reembolsada' : w.status === 'exchanged' ? 'Cambiada' : w.status === 'claimed' ? 'Reclamada' : expired ? 'Expirada' : 'Vigente'}
                        </span>
                      </td>
                      <td>
                        <div className="whitespace-nowrap font-mono text-xs font-bold text-secondary">{tx ? ticketLabel(tx) : ticketDisplay(null, w.transactionId)}</div>
                      </td>
                      <td className="text-right">
                        {closed ? (
                          <button
                            type="button"
                            onClick={() => viewWarrantyCase(w)}
                            className="flex min-h-[34px] items-center gap-1 rounded-lg border border-base px-2.5 text-xs font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary ml-auto"
                          >
                            <Receipt size={12} /> Ver caso
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openWarrantyReturn(w)}
                            disabled={expired}
                            className={cn(
                              'ml-auto flex min-h-[34px] items-center gap-1 rounded-lg px-2.5 text-xs font-bold transition-colors',
                              expired
                                ? 'cursor-not-allowed border border-base text-muted opacity-60'
                                : 'bg-violet-600 text-white hover:bg-violet-700',
                            )}
                          >
                            <ShieldPlus size={12} /> {expired ? 'Vencida' : 'Devolver'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filteredWarranties.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="flex flex-col items-center gap-2 py-12 text-center">
                        <ShieldCheck size={28} className="text-muted" aria-hidden="true" />
                        <p className="text-base font-black text-primary">Sin garantías en esta vista</p>
                        <p className="max-w-sm text-sm text-muted">
                          {query || warrantyFilter !== 'all'
                            ? 'Ajusta el buscador o el filtro de estado.'
                            : 'Los certificados se generan automáticamente al vender productos con garantía.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <ProcedureGuide />

      {modalState?.kind === 'new' && (
        <NewReturnModal
          transactions={transactions}
          returns={returns}
          warranties={warranties}
          customers={customers}
          currentBranchId={currentBranchId}
          prefill={modalState.prefill}
          onClose={() => setModalState(null)}
          onCreate={(items, type) => {
            items.forEach(item => createReturn(item));
            setModalState(null);
            addNotification(
              items.length === 1
                ? `Devolución registrada (${type === 'refund' ? 'reembolso pendiente de pago' : 'cambio por garantía'}).`
                : `${items.length} devoluciones registradas (${type === 'refund' ? 'reembolsos pendientes de pago' : 'cambios por garantía'}).`,
              'success',
            );
          }}
        />
      )}

      {modalState?.kind === 'action' && (
        <ReturnActionModal
          returnItem={modalState.returnItem}
          action={modalState.action}
          productName={productById.get(modalState.returnItem.productId)?.name || 'Producto'}
          customerName={customerOf(transactionById.get(modalState.returnItem.transactionId))?.name}
          busy={busyId === modalState.returnItem.id}
          onClose={() => setModalState(null)}
          onConfirm={(note) => void runReturnAction(modalState.returnItem, modalState.action, note)}
        />
      )}

      {modalState?.kind === 'refund' && (
        <RefundModal
          returnItem={modalState.returnItem}
          defaultAmount={(() => {
            const tx = transactionById.get(modalState.returnItem.transactionId);
            const line = tx?.items.find(i => i.product.id === modalState.returnItem.productId);
            const unit = line?.price ?? productById.get(modalState.returnItem.productId)?.price ?? 0;
            return Math.round(unit * modalState.returnItem.quantity * 100) / 100;
          })()}
          currencies={currencies.map(c => c.code)}
          baseCurrency={baseCurrency.code}
          onClose={() => setModalState(null)}
          onSave={(data) => {
            updateReturn(modalState.returnItem.id, {
              refundStatus: data.status,
              refundAmount: data.amount,
              refundCurrencyCode: data.currency,
              refundMethod: data.method,
              refundedAt: data.status === 'paid' ? new Date().toISOString() : modalState.returnItem.refundedAt,
            });
            setModalState(null);
            addNotification(data.status === 'paid' ? 'Reembolso registrado como pagado.' : 'Reembolso aprobado pendiente de pago.', 'success');
          }}
        />
      )}
    </OperationsSurface>
  );
}

function ProcedureGuide() {
  const steps = [
    {
      icon: RotateCcw,
      title: '1. Registra',
      text: 'Busca el ticket, marca uno o varios artículos y define cambio o reembolso.',
      tone: 'text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-500/10',
    },
    {
      icon: Package,
      title: '2. Recibe y verifica',
      text: 'Confirma la recepción física. El stock y el certificado de garantía se actualizan.',
      tone: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10',
    },
    {
      icon: Banknote,
      title: '3. Cierra',
      text: 'En reembolsos registra monto, moneda y medio de pago; en cambios entrega el nuevo artículo.',
      tone: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10',
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {steps.map(step => {
        const Icon = step.icon;
        return (
          <div key={step.title} className="flex items-start gap-3 rounded-2xl border border-base bg-secondary p-3.5">
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', step.tone)} aria-hidden="true">
              <Icon size={16} />
            </span>
            <div>
              <p className="text-sm font-black text-primary">{step.title}</p>
              <p className="mt-0.5 text-xs font-medium leading-relaxed text-muted">{step.text}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type NewReturnModalProps = {
  transactions: Transaction[];
  returns: ReturnItem[];
  warranties: Warranty[];
  customers: Customer[];
  currentBranchId: string;
  prefill?: { transactionId: string; productId?: string; type?: 'warranty_exchange' | 'refund' };
  onClose: () => void;
  onCreate: (items: ReturnItem[], type: 'warranty_exchange' | 'refund') => void;
};

function NewReturnModal({ transactions, returns, warranties, customers, currentBranchId, prefill, onClose, onCreate }: NewReturnModalProps) {
  const [query, setQuery] = useState('');
  const [txId, setTxId] = useState(prefill?.transactionId || '');
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [type, setType] = useState<'warranty_exchange' | 'refund'>(prefill?.type || 'warranty_exchange');
  const [reason, setReason] = useState('defecto_fabrica');
  const [notes, setNotes] = useState('');
  const prefilled = useRef(false);

  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const tx = transactions.find(t => t.id === txId);
  const lines = useMemo(() => (tx ? buildTicketLines(tx, returns) : []), [tx, returns]);

  useEffect(() => {
    if (prefilled.current || !prefill?.productId) return;
    const line = lines.find(l => l.productId === prefill.productId);
    if (line && line.sold > line.returned) {
      setSelections({ [line.key]: 1 });
      prefilled.current = true;
    }
  }, [lines, prefill]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = transactions.filter(t => t.status !== 'refunded');
    if (q) {
      list = list.filter(t => {
        const customer = t.customerId ? customerById.get(t.customerId) : undefined;
        return (
          t.id.toLowerCase().includes(q) ||
          (t.ticketNumber || '').toLowerCase().includes(q) ||
          (customer?.name || '').toLowerCase().includes(q) ||
          (customer?.phone || '').includes(q) ||
          t.items.some(i => i.product.name.toLowerCase().includes(q))
        );
      });
    }
    return [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6);
  }, [transactions, query, customerById]);

  const selectedLines = lines.filter(l => (selections[l.key] || 0) > 0 && l.sold > l.returned);
  const totalUnits = selectedLines.reduce((sum, line) => sum + Math.min(selections[line.key], line.sold - line.returned), 0);
  const warrantyHit = tx ? warranties.find(w => w.transactionId === tx.id && w.productId === selectedLines[0]?.productId) : undefined;

  const toggleLine = (line: TxLine) => {
    if (line.sold - line.returned <= 0) return;
    setSelections(prev => {
      if (prev[line.key]) {
        const next = { ...prev };
        delete next[line.key];
        return next;
      }
      return { ...prev, [line.key]: 1 };
    });
  };

  const setQuantity = (line: TxLine, value: number) => {
    const remaining = line.sold - line.returned;
    const qty = Math.max(1, Math.min(remaining, Math.floor(value) || 1));
    setSelections(prev => ({ ...prev, [line.key]: qty }));
  };

  const handleSubmit = () => {
    if (!tx || selectedLines.length === 0) return;
    const items = selectedLines.map<ReturnItem>(line => ({
      id: crypto.randomUUID(),
      transactionId: tx.id,
      productId: line.productId,
      variantLabel: line.variantLabel,
      quantity: Math.min(selections[line.key], line.sold - line.returned),
      reason,
      date: new Date().toISOString(),
      status: 'pending',
      type,
      notes: notes.trim() || undefined,
      branchId: tx.branchId || currentBranchId,
      refundStatus: type === 'refund' ? 'pending' : 'not_required',
    }));
    onCreate(items, type);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-base bg-secondary shadow-2xl animate-in zoom-in-95 duration-200 sm:max-w-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-base px-4 py-3">
          <div>
            <h2 className="text-base font-black text-primary">Registrar devolución</h2>
            <p className="text-xs font-semibold text-muted">Desde el ticket de venta, con cantidades y motivo.</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-subtle hover:text-primary" aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-muted">1. Busca el ticket</label>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="search"
                autoFocus={!prefill}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ticket, cliente, teléfono o producto…"
                className="w-full rounded-xl border border-base bg-secondary py-2.5 pl-9 pr-3 text-sm font-semibold text-primary outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
              />
            </div>

            {!tx && (
              <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
                {results.map(t => {
                  const customer = t.customerId ? customerById.get(t.customerId) : undefined;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setTxId(t.id);
                        setSelections({});
                        setQuery('');
                        prefilled.current = true;
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-base px-3 py-2 text-left transition-colors hover:border-violet-300 hover:bg-violet-50/60 dark:hover:border-violet-500/40 dark:hover:bg-violet-500/10"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-black text-primary">{ticketLabel(t)}</span>
                          <span className="text-[11px] font-semibold text-muted">{shortDate(t.date)}</span>
                        </div>
                        <div className="truncate text-xs font-semibold text-secondary">
                          {customer ? `${customer.name}${customer.phone ? ` · ${customer.phone}` : ''}` : 'Consumidor final'} · {t.items.length} art.
                        </div>
                      </div>
                      <span className="shrink-0 text-sm font-black tabular-nums text-primary">
                        {(Number(t.total) || 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </button>
                  );
                })}
                {results.length === 0 && (
                  <div className="rounded-xl border border-dashed border-base p-6 text-center text-sm font-semibold text-muted">
                    No se encontraron ventas con ese criterio.
                  </div>
                )}
              </div>
            )}

            {tx && (
              <div className="mt-2 rounded-xl border border-base bg-subtle/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-black text-primary">{ticketLabel(tx)}</span>
                      <span className="text-xs font-semibold text-muted">{shortDate(tx.date)}</span>
                    </div>
                    <div className="text-xs font-semibold text-secondary">
                      {tx.customerId && customerById.get(tx.customerId)
                        ? `${customerById.get(tx.customerId)!.name}${customerById.get(tx.customerId)!.phone ? ` · ${customerById.get(tx.customerId)!.phone}` : ''}`
                        : 'Consumidor final'}
                    </div>
                  </div>
                  <button type="button" onClick={() => { setTxId(''); setSelections({}); }} className="rounded-lg border border-base px-2.5 py-1.5 text-xs font-bold text-secondary transition-colors hover:bg-secondary hover:text-primary">
                    Cambiar ticket
                  </button>
                </div>
              </div>
            )}
          </div>

          {tx && (
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-muted">2. Marca los artículos a devolver</label>
              <div className="space-y-1.5">
                {lines.map(line => {
                  const remaining = line.sold - line.returned;
                  const selected = selections[line.key] || 0;
                  const disabled = remaining <= 0;
                  return (
                    <div
                      key={line.key}
                      role="button"
                      tabIndex={disabled ? -1 : 0}
                      onClick={() => toggleLine(line)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLine(line); } }}
                      className={cn(
                        'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 transition-colors',
                        disabled
                          ? 'cursor-not-allowed border-base opacity-60'
                          : selected
                            ? 'cursor-pointer border-violet-400 bg-violet-50/70 dark:border-violet-500/50 dark:bg-violet-500/10'
                            : 'cursor-pointer border-base hover:border-violet-300 hover:bg-subtle/60',
                      )}
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        <span
                          className={cn(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border-2',
                            selected ? 'border-violet-600 bg-violet-600 text-white' : 'border-base',
                          )}
                          aria-hidden="true"
                        >
                          {selected > 0 && <CheckCircle2 size={11} />}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold text-primary">
                            {line.productName}
                            {line.variantLabel && <span className="ml-1.5 rounded bg-subtle px-1.5 py-0.5 text-[10px] font-bold text-secondary">{line.variantLabel}</span>}
                          </div>
                          <div className="text-[11px] font-semibold text-muted">
                            Vendidos: {line.sold} · Devueltos: {line.returned} · Disponibles: {remaining}
                          </div>
                        </div>
                      </div>

                      {disabled ? (
                        <span className="shrink-0 rounded-lg bg-subtle px-2 py-1 text-[11px] font-black uppercase text-muted">Devuelto</span>
                      ) : selected ? (
                        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => (selected <= 1 ? toggleLine(line) : setQuantity(line, selected - 1))}
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-base bg-secondary text-primary transition-colors hover:bg-subtle"
                            aria-label="Menos cantidad"
                          >
                            <Minus size={12} />
                          </button>
                          <input
                            type="number"
                            min={1}
                            max={remaining}
                            value={selected}
                            onChange={(e) => setQuantity(line, Number(e.target.value))}
                            className="h-7 w-12 rounded-lg border border-base bg-secondary text-center text-sm font-black tabular-nums text-primary outline-none focus:border-violet-400"
                            aria-label="Cantidad a devolver"
                          />
                          <button
                            type="button"
                            onClick={() => setQuantity(line, selected + 1)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-base bg-secondary text-primary transition-colors hover:bg-subtle"
                            aria-label="Más cantidad"
                          >
                            <Plus size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setQuantity(line, remaining)}
                            className="ml-1 text-[10px] font-black uppercase text-violet-700 hover:underline dark:text-violet-300"
                          >
                            Todo
                          </button>
                        </div>
                      ) : (
                        <span className="shrink-0 text-[11px] font-bold text-muted">
                          {line.price ? line.price.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {warrantyHit && (
                <div className="mt-2 flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50/70 p-2.5 dark:border-violet-500/40 dark:bg-violet-500/10">
                  <ShieldCheck size={14} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" />
                  <p className="text-xs font-semibold text-violet-800 dark:text-violet-200">
                    {daysLeft(warrantyHit.expiryDate) > 0
                      ? `Garantía vigente hasta ${shortDate(warrantyHit.expiryDate)}. El certificado se marcará como cambiado o reembolsado al confirmar la recepción.`
                      : `La garantía de este artículo venció el ${shortDate(warrantyHit.expiryDate)}. Puedes registrarlo igual como caso comercial.`}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-muted">3. Tipo de trámite</label>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  ['warranty_exchange', 'Cambio por garantía'],
                  ['refund', 'Reembolso de dinero'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setType(value)}
                    className={cn(
                      'min-h-[44px] rounded-xl border px-2 text-xs font-bold transition-colors',
                      type === value
                        ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300'
                        : 'border-base bg-secondary text-secondary hover:bg-subtle',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-muted">4. Motivo</label>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-bold text-primary outline-none focus:border-violet-400"
              >
                {REASONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-muted">Notas (opcional)</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Detalle del problema, estado del empaque…"
              className="w-full resize-none rounded-xl border border-base bg-secondary px-3 py-2 text-sm font-medium text-primary outline-none placeholder:text-muted focus:border-violet-400"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-base bg-subtle/60 px-4 py-3">
          <span className="text-xs font-bold text-secondary">
            {selectedLines.length ? `${selectedLines.length} artículo(s) · ${totalUnits} unidad(es)` : 'Sin artículos seleccionados'}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="min-h-[40px] rounded-xl border border-base px-3 text-sm font-bold text-secondary transition-colors hover:bg-secondary hover:text-primary">
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!tx || selectedLines.length === 0}
              className={cn(
                'flex min-h-[40px] items-center gap-1.5 rounded-xl px-4 text-sm font-bold transition-colors',
                tx && selectedLines.length
                  ? 'bg-violet-600 text-white hover:bg-violet-700'
                  : 'cursor-not-allowed bg-subtle text-muted',
              )}
            >
              <RotateCcw size={14} /> Registrar {totalUnits > 1 ? `(${totalUnits})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type ReturnActionModalProps = {
  returnItem: ReturnItem;
  action: 'complete' | 'reject';
  productName: string;
  customerName?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
};

function ReturnActionModal({ returnItem, action, productName, customerName, busy, onClose, onConfirm }: ReturnActionModalProps) {
  const [note, setNote] = useState('');
  const complete = action === 'complete';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="w-full max-h-[92dvh] overflow-y-auto rounded-t-3xl border border-base bg-secondary p-4 shadow-2xl animate-in zoom-in-95 duration-200 sm:max-w-md sm:rounded-2xl">
        <div className="flex items-start gap-3">
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', complete ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400')}>
            {complete ? <CircleCheck size={18} /> : <XCircle size={18} />}
          </span>
          <div>
            <h2 className="text-base font-black text-primary">{complete ? 'Confirmar recepción' : 'Rechazar devolución'}</h2>
            <p className="mt-0.5 text-sm text-muted">
              {complete
                ? 'Verifica físicamente el artículo antes de confirmar. El stock y la garantía se actualizarán.'
                : 'La devolución quedará cerrada como rechazada y no moverá inventario ni dinero.'}
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-base bg-subtle/60 p-3 text-sm">
          <div className="font-bold text-primary">{productName} · {returnItem.quantity} unidad(es)</div>
          <div className="mt-0.5 text-xs font-semibold text-muted">
            {customerName || 'Consumidor final'} · {returnCode(returnItem)}
          </div>
        </div>

        <label className="mt-3 block text-[11px] font-black uppercase tracking-wider text-muted">Nota (opcional)</label>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={complete ? 'Estado del empaque, accesorios recibidos…' : 'Motivo del rechazo…'}
          className="mt-1 w-full resize-none rounded-xl border border-base bg-secondary px-3 py-2 text-sm font-medium text-primary outline-none placeholder:text-muted focus:border-violet-400"
        />

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-[40px] rounded-xl border border-base px-3 text-sm font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary disabled:opacity-60">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note)}
            disabled={busy}
            className={cn(
              'flex min-h-[40px] items-center gap-1.5 rounded-xl px-4 text-sm font-bold text-white transition-colors disabled:opacity-70',
              complete ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700',
            )}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {complete ? 'Confirmar recepción' : 'Rechazar devolución'}
          </button>
        </div>
      </div>
    </div>
  );
}

type RefundModalProps = {
  returnItem: ReturnItem;
  defaultAmount: number;
  currencies: string[];
  baseCurrency: string;
  onClose: () => void;
  onSave: (data: { amount: number; currency: string; method: RefundMethod; status: 'paid' | 'approved' }) => void;
};

function RefundModal({ returnItem, defaultAmount, currencies, baseCurrency, onClose, onSave }: RefundModalProps) {
  const [amount, setAmount] = useState(String(returnItem.refundAmount ?? defaultAmount ?? 0));
  const [currency, setCurrency] = useState(returnItem.refundCurrencyCode || baseCurrency);
  const [method, setMethod] = useState<RefundMethod>((returnItem.refundMethod as RefundMethod) || 'cash');
  const parsed = Math.max(0, Number(amount) || 0);
  const codes = Array.from(new Set([baseCurrency, ...currencies].filter(Boolean)));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="w-full max-h-[92dvh] overflow-y-auto rounded-t-3xl border border-base bg-secondary p-4 shadow-2xl animate-in zoom-in-95 duration-200 sm:max-w-md sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300">
              <Banknote size={18} />
            </span>
            <div>
              <h2 className="text-base font-black text-primary">Registrar reembolso</h2>
              <p className="mt-0.5 text-sm text-muted">Define el monto y el medio de pago para dejar el caso cerrado.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-subtle hover:text-primary" aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-muted">Monto a reembolsar</label>
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-base bg-secondary px-3 py-2.5 text-lg font-black tabular-nums text-primary outline-none focus:border-violet-400"
                aria-label="Monto a reembolsar"
              />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="rounded-xl border border-base bg-secondary px-2 py-2.5 text-sm font-bold text-primary outline-none focus:border-violet-400"
                aria-label="Moneda del reembolso"
              >
                {codes.map(code => <option key={code} value={code}>{code}</option>)}
              </select>
            </div>
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-muted">Medio de pago</label>
            <div className="grid grid-cols-3 gap-1.5">
              {REFUND_METHODS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMethod(option.value)}
                  className={cn(
                    'min-h-[44px] rounded-xl border px-2 text-xs font-bold transition-colors',
                    method === option.value
                      ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300'
                      : 'border-base bg-secondary text-secondary hover:bg-subtle',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-[40px] rounded-xl border border-base px-3 text-sm font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onSave({ amount: parsed, currency, method, status: 'approved' })}
            className="min-h-[40px] rounded-xl border border-violet-300 px-3 text-sm font-bold text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
          >
            Guardar como aprobado
          </button>
          <button
            type="button"
            onClick={() => onSave({ amount: parsed, currency, method, status: 'paid' })}
            disabled={parsed <= 0}
            className={cn(
              'flex min-h-[40px] items-center gap-1.5 rounded-xl px-4 text-sm font-bold text-white transition-colors',
              parsed > 0 ? 'bg-emerald-600 hover:bg-emerald-700' : 'cursor-not-allowed bg-subtle text-muted',
            )}
          >
            <CircleCheck size={14} /> Marcar como pagado
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Returns() {
  return (
    <PlanFeatureGate feature="warranty_returns" title="Sistema de garantías y devoluciones" description="Esta función está incluida en Caravana para negocios que necesitan ampliar el control de su operación.">
      <ReturnsContent />
    </PlanFeatureGate>
  );
}
