import PlanFeatureGate from "../components/PlanFeatureGate";
import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Clock3,
  History,
  Loader2,
  Mail,
  Package,
  Pencil,
  Phone,
  Plus,
  ReceiptText,
  Search,
  ShoppingBag,
  Trash2,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useStore } from "../store/useStore";
import { Customer, Transaction } from "../types";
import { cn } from "../lib/utils";
import { ticketDisplay, documentCode } from "../lib/documentCodes";
import { InfoTooltip } from "../components/InfoTooltip";
import OperationsSurface from "../components/OperationsSurface";

type CustomerActivity = {
  purchases: number;
  total: number;
  units: number;
  lastDate?: string;
};

type CustomerFilter = 'all' | 'active' | 'idle';

const shortDate = (iso?: string) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("es-CU", { day: "2-digit", month: "short", year: "numeric" });
};

const ticketLabel = (tx: Transaction) => ticketDisplay(tx.ticketNumber, tx.id);

const customerCode = (id: string) => documentCode('CLI', id);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function CustomersContent() {
  const {
    customers, addCustomer, updateCustomer, deleteCustomer, transactions, branches, getBaseCurrency, addNotification,
  } = useStore(useShallow((state) => ({
    customers: state.customers,
    addCustomer: state.addCustomer,
    updateCustomer: state.updateCustomer,
    deleteCustomer: state.deleteCustomer,
    transactions: state.transactions,
    branches: state.branches,
    getBaseCurrency: state.getBaseCurrency,
    addNotification: state.addNotification,
  })));
  const baseCurrency = getBaseCurrency();

  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<CustomerFilter>('all');
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [viewingCustomer, setViewingCustomer] = useState<Customer | null>(null);
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null);
  const [formData, setFormData] = useState({ name: "", email: "", phone: "", taxId: "" });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [formError, setFormError] = useState("");

  const validTransactions = useMemo(
    () => transactions.filter(tx => !tx.deletedAt && tx.status !== 'refunded'),
    [transactions]
  );

  const activityByCustomer = useMemo(() => {
    const map = new Map<string, CustomerActivity>();
    for (const tx of validTransactions) {
      if (!tx.customerId) continue;
      const current = map.get(tx.customerId) || { purchases: 0, total: 0, units: 0 };
      current.purchases += 1;
      current.total += Number(tx.total) || 0;
      current.units += (tx.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      if (!current.lastDate || new Date(tx.date).getTime() > new Date(current.lastDate).getTime()) {
        current.lastDate = tx.date;
      }
      map.set(tx.customerId, current);
    }
    return map;
  }, [validTransactions]);

  const stats = useMemo(() => {
    let withSales = 0;
    let revenue = 0;
    let purchases = 0;
    for (const customer of customers) {
      const activity = activityByCustomer.get(customer.id);
      if (!activity) continue;
      withSales += 1;
      revenue += activity.total;
      purchases += activity.purchases;
    }
    return {
      total: customers.length,
      withSales,
      withoutSales: customers.length - withSales,
      revenue,
      purchases,
      averageTicket: purchases ? revenue / purchases : 0,
    };
  }, [customers, activityByCustomer]);

  const filteredCustomers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return customers
      .filter(customer => {
        const activity = activityByCustomer.get(customer.id);
        if (filter === 'active' && !activity) return false;
        if (filter === 'idle' && activity) return false;
        if (!query) return true;
        return (
          customer.name.toLowerCase().includes(query) ||
          (customer.email || '').toLowerCase().includes(query) ||
          (customer.phone || '').toLowerCase().includes(query) ||
          (customer.taxId || '').toLowerCase().includes(query) ||
          customerCode(customer.id).toLowerCase().includes(query)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [customers, activityByCustomer, filter, searchQuery]);

  const customerTransactions = (customerId: string) =>
    validTransactions
      .filter(tx => tx.customerId === customerId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const formatMoney = (amount: number) =>
    `${baseCurrency.symbol} ${(Number(amount) || 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const branchLabel = (branchId?: string) =>
    branches.find(branch => branch.id === branchId)?.name || "Sucursal principal";

  const openCreate = () => {
    setEditingCustomer(null);
    setFormData({ name: "", email: "", phone: "", taxId: "" });
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormData({
      name: customer.name,
      email: customer.email || "",
      phone: customer.phone || "",
      taxId: customer.taxId || "",
    });
    setFormError("");
    setShowForm(true);
  };

  const handleSaveCustomer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingCustomer) return;

    const name = formData.name.trim();
    const email = formData.email.trim();
    const phone = formData.phone.trim();
    const taxId = formData.taxId.trim();

    if (!name) {
      setFormError("El nombre del cliente es obligatorio.");
      return;
    }
    if (email && !EMAIL_PATTERN.test(email)) {
      setFormError("El correo no tiene un formato válido (ejemplo: cliente@correo.com).");
      return;
    }

    const duplicate = customers.find(customer =>
      customer.id !== editingCustomer?.id &&
      ((phone && customer.phone && customer.phone.replace(/\s+/g, '') === phone.replace(/\s+/g, '')) ||
        (email && customer.email && customer.email.toLowerCase().trim() === email.toLowerCase()))
    );
    if (duplicate) {
      setFormError(`Ya existe un cliente con ese ${phone && duplicate.phone ? 'teléfono' : 'correo'}: ${duplicate.name}.`);
      return;
    }

    setSavingCustomer(true);
    setFormError("");
    try {
      const saved = editingCustomer
        ? await updateCustomer(editingCustomer.id, { name, email, phone, taxId })
        : await addCustomer({ id: crypto.randomUUID(), name, email, phone, taxId });

      if (!saved) {
        setFormError("No se pudo guardar el cliente. Revisa la conexión y vuelve a intentarlo.");
        return;
      }

      addNotification(
        editingCustomer ? "Cliente actualizado" : "Cliente registrado",
        "success",
        editingCustomer ? `${name} se actualizó correctamente.` : `${name} ya está disponible para ventas y cotizaciones.`
      );
      setShowForm(false);
      setEditingCustomer(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "No se pudo guardar el cliente.");
    } finally {
      setSavingCustomer(false);
    }
  };

  const confirmDelete = () => {
    if (!deletingCustomer) return;
    deleteCustomer(deletingCustomer.id);
    addNotification("Cliente eliminado", "info", `${deletingCustomer.name} se retiró del directorio.`);
    setDeletingCustomer(null);
    setViewingCustomer(null);
  };

  const kpis = [
    {
      label: "Clientes registrados",
      value: stats.total.toLocaleString('es-CU'),
      detail: `${stats.withSales} con compras · ${stats.withoutSales} sin compras`,
      icon: Users,
      tone: "violet",
    },
    {
      label: "Clientes con compras",
      value: stats.withSales.toLocaleString('es-CU'),
      detail: `${stats.purchases} ventas registradas`,
      icon: ShoppingBag,
      tone: "emerald",
    },
    {
      label: "Ventas acumuladas",
      value: formatMoney(stats.revenue),
      detail: "Total de compras de tus clientes",
      icon: Wallet,
      tone: "sky",
    },
    {
      label: "Ticket promedio",
      value: formatMoney(stats.averageTicket),
      detail: "Promedio por venta a clientes",
      icon: TrendingUp,
      tone: "amber",
    },
  ];

  const kpiTones: Record<string, string> = {
    violet: "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300",
    emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300",
    sky: "bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300",
    amber: "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300",
  };

  const filterChips: { key: CustomerFilter; label: string; count: number }[] = [
    { key: 'all', label: "Todos", count: stats.total },
    { key: 'active', label: "Con compras", count: stats.withSales },
    { key: 'idle', label: "Sin compras", count: stats.withoutSales },
  ];

  const viewingActivity = viewingCustomer ? activityByCustomer.get(viewingCustomer.id) : undefined;
  const viewingTransactions = viewingCustomer ? customerTransactions(viewingCustomer.id) : [];
  const deleteBlocked = Boolean(deletingCustomer && activityByCustomer.get(deletingCustomer.id));

  const actionBase = "rounded-lg border border-base text-muted transition-colors hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-950/30";
  const renderRowActions = (customer: Customer, activity?: CustomerActivity, mobile = false) => (
    <div className="flex justify-end gap-1.5">
      <button
        type="button"
        onClick={() => setViewingCustomer(customer)}
        aria-label={`Ver ficha de ${customer.name}`}
        title="Ver ficha"
        className={cn(actionBase, mobile ? "flex h-9 w-9 items-center justify-center" : "p-1.5")}
      >
        <History size={mobile ? 15 : 14} />
      </button>
      <button
        type="button"
        onClick={() => openEdit(customer)}
        aria-label={`Editar ${customer.name}`}
        title="Editar"
        className={cn(actionBase, mobile ? "flex h-9 w-9 items-center justify-center" : "p-1.5")}
      >
        <Pencil size={mobile ? 15 : 14} />
      </button>
      <button
        type="button"
        onClick={() => setDeletingCustomer(customer)}
        disabled={Boolean(activity)}
        aria-label={`Eliminar ${customer.name}`}
        title={activity ? "Tiene ventas registradas y no puede eliminarse" : "Eliminar cliente"}
        className={cn(
          actionBase,
          mobile ? "flex h-9 w-9 items-center justify-center" : "p-1.5",
          "hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-950/30"
        )}
      >
        <Trash2 size={mobile ? 15 : 14} />
      </button>
    </div>
  );

  return (
    <OperationsSurface className="flex flex-col gap-4 -mx-3 -mt-3 px-3 pb-10 pt-3 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4 lg:-mx-6 lg:-mt-6 lg:px-6">
      <header className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-2">
            <Users size={20} className="text-violet-600 dark:text-violet-300" />
            <h1 data-palmi-content="customers" className="text-xl sm:text-2xl font-black tracking-tight text-primary">Clientes</h1>
            <InfoTooltip
              text="Directorio de clientes con su historial de compras, total gastado y ticket promedio. Puedes registrar o editar clientes aquí o desde el POS."
              position="bottom"
            />
          </div>
          <p className="mt-1 text-sm text-muted">Ficha completa de cada cliente: contacto, compras y valor acumulado.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-sm font-bold text-white shadow-xs transition-all hover:bg-violet-700 cursor-pointer sm:w-auto"
        >
          <Plus size={15} />
          Nuevo cliente
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Resumen de clientes">
        {kpis.map(kpi => (
          <div key={kpi.label} className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[9px] font-black uppercase tracking-widest text-muted">{kpi.label}</p>
              <span className={cn("flex h-7 w-7 items-center justify-center rounded-xl", kpiTones[kpi.tone])}>
                <kpi.icon size={14} />
              </span>
            </div>
            <p className="mt-2 truncate text-xl font-black tabular-nums text-primary">{kpi.value}</p>
            <p className="mt-1 text-[10px] font-semibold text-muted">{kpi.detail}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-base bg-secondary shadow-2xs">
        <div className="flex flex-col gap-2 border-b border-base p-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Buscar por nombre, teléfono, correo o documento..."
              aria-label="Buscar clientes"
              className="h-10 w-full rounded-xl border border-base bg-primary pl-9 pr-3 text-sm font-semibold text-primary outline-none placeholder:text-muted focus:border-violet-400"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {filterChips.map(chip => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFilter(chip.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wide transition-colors cursor-pointer",
                  filter === chip.key
                    ? "border-violet-600 bg-violet-600 text-white"
                    : "border-base bg-primary text-muted hover:text-primary"
                )}
              >
                {chip.label}
                <span className={cn("rounded px-1 text-[9px] tabular-nums", filter === chip.key ? "bg-white/20" : "bg-subtle")}>{chip.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-base md:hidden">
          {filteredCustomers.map(customer => {
            const activity = activityByCustomer.get(customer.id);
            return (
              <div key={customer.id} className="p-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm font-black text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                    {customer.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black text-primary">{customer.name}</p>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-muted">
                      {customerCode(customer.id)}
                      {customer.taxId ? ` · ${customer.taxId}` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      {customer.phone ? (
                        <p className="flex items-center gap-1 text-[11px] font-semibold text-secondary">
                          <Phone size={10} className="text-muted" /> {customer.phone}
                        </p>
                      ) : null}
                      {customer.email ? (
                        <p className="flex items-center gap-1 truncate text-[11px] font-semibold text-muted">
                          <Mail size={10} className="text-muted/70" /> {customer.email}
                        </p>
                      ) : null}
                      {!customer.phone && !customer.email ? (
                        <span className="text-[11px] font-semibold text-muted">Sin contacto</span>
                      ) : null}
                    </div>
                  </div>
                  {renderRowActions(customer, activity, true)}
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl bg-subtle px-3 py-2">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-muted">Compras</p>
                    <p className="text-xs font-black text-primary">
                      {activity ? `${activity.purchases} · ${shortDate(activity.lastDate)}` : "Sin compras"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] font-black uppercase tracking-widest text-muted">Total comprado</p>
                    <p className={cn("text-xs font-black tabular-nums", activity ? "text-primary" : "text-muted")}>
                      {activity ? formatMoney(activity.total) : "—"}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead className="bg-subtle/60">
              <tr>
                <th className="px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-muted">Cliente</th>
                <th className="px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-muted">Contacto</th>
                <th className="px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-muted">Compras</th>
                <th className="px-4 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-muted">Ticket prom.</th>
                <th className="px-4 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-muted">Total comprado</th>
                <th className="px-4 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-muted">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {filteredCustomers.map(customer => {
                const activity = activityByCustomer.get(customer.id);
                const average = activity && activity.purchases ? activity.total / activity.purchases : 0;
                return (
                  <tr key={customer.id} className="group transition-colors hover:bg-subtle/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-black text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                          {customer.name.charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-primary">{customer.name}</p>
                          <p className="text-[10px] font-bold uppercase tracking-wide text-muted">
                            {customerCode(customer.id)}
                            {customer.taxId ? ` · ${customer.taxId}` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-0.5">
                        {customer.phone ? (
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-secondary">
                            <Phone size={11} className="text-muted" /> {customer.phone}
                          </p>
                        ) : null}
                        {customer.email ? (
                          <p className="flex items-center gap-1.5 truncate text-[11px] font-semibold text-muted">
                            <Mail size={11} className="text-muted/70" /> {customer.email}
                          </p>
                        ) : null}
                        {!customer.phone && !customer.email ? (
                          <span className="text-[11px] font-semibold text-muted">Sin contacto</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {activity ? (
                        <div>
                          <p className="text-sm font-black tabular-nums text-primary">{activity.purchases}</p>
                          <p className="text-[10px] font-semibold text-muted">Última: {shortDate(activity.lastDate)}</p>
                        </div>
                      ) : (
                        <span className="rounded-md bg-subtle px-2 py-1 text-[9px] font-black uppercase tracking-wide text-muted">Sin compras</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs font-bold tabular-nums text-secondary">{activity ? formatMoney(average) : "—"}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={cn("text-sm font-black tabular-nums", activity ? "text-primary" : "text-muted")}>
                        {activity ? formatMoney(activity.total) : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {renderRowActions(customer, activity)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filteredCustomers.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
            <Users size={30} className="text-muted opacity-50" />
            <p className="text-sm font-black text-primary">
              {customers.length === 0 ? "Aún no hay clientes registrados" : "No hay clientes que coincidan"}
            </p>
            <p className="max-w-sm text-xs font-semibold text-muted">
              {customers.length === 0
                ? "Registra tu primer cliente para asociar ventas, cotizaciones y garantías."
                : "Cambia el término de búsqueda o el filtro seleccionado."}
            </p>
            {customers.length === 0 && (
              <button
                type="button"
                onClick={openCreate}
                className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-black uppercase tracking-wide text-white hover:bg-violet-700 cursor-pointer"
              >
                <UserPlus size={14} /> Registrar cliente
              </button>
            )}
          </div>
        )}
      </section>

      {/* Ficha del cliente */}
      {viewingCustomer && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-900/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`Ficha de ${viewingCustomer.name}`}
        >
          <div className="flex h-full w-full max-w-md flex-col border-l border-base bg-secondary shadow-2xl animate-in slide-in-from-right duration-300">
            <div className="border-b border-base bg-subtle p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-600 text-lg font-black text-white">
                    {viewingCustomer.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-black text-primary">{viewingCustomer.name}</h2>
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted">{customerCode(viewingCustomer.id)}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setViewingCustomer(null)}
                  aria-label="Cerrar ficha"
                  className="rounded-full p-1.5 text-muted transition-colors hover:bg-base"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {viewingCustomer.phone ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-base bg-primary px-2 py-1 text-[10px] font-bold text-secondary">
                    <Phone size={11} className="text-muted" /> {viewingCustomer.phone}
                  </span>
                ) : null}
                {viewingCustomer.email ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-base bg-primary px-2 py-1 text-[10px] font-bold text-secondary">
                    <Mail size={11} className="text-muted" /> {viewingCustomer.email}
                  </span>
                ) : null}
                {viewingCustomer.taxId ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-base bg-primary px-2 py-1 text-[10px] font-bold text-secondary">
                    <ReceiptText size={11} className="text-muted" /> {viewingCustomer.taxId}
                  </span>
                ) : null}
                {!viewingCustomer.phone && !viewingCustomer.email && !viewingCustomer.taxId ? (
                  <span className="text-[10px] font-semibold text-muted">Sin datos de contacto registrados.</span>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 border-b border-base p-4">
              <div className="rounded-xl border border-base bg-primary p-3">
                <p className="text-[8px] font-black uppercase tracking-widest text-muted">Total comprado</p>
                <p className="mt-1 text-base font-black tabular-nums text-primary">{formatMoney(viewingActivity?.total || 0)}</p>
              </div>
              <div className="rounded-xl border border-base bg-primary p-3">
                <p className="text-[8px] font-black uppercase tracking-widest text-muted">Compras</p>
                <p className="mt-1 text-base font-black tabular-nums text-primary">{viewingActivity?.purchases || 0}</p>
              </div>
              <div className="rounded-xl border border-base bg-primary p-3">
                <p className="text-[8px] font-black uppercase tracking-widest text-muted">Ticket promedio</p>
                <p className="mt-1 text-sm font-black tabular-nums text-primary">
                  {formatMoney(viewingActivity && viewingActivity.purchases ? viewingActivity.total / viewingActivity.purchases : 0)}
                </p>
              </div>
              <div className="rounded-xl border border-base bg-primary p-3">
                <p className="text-[8px] font-black uppercase tracking-widest text-muted">Última compra</p>
                <p className="mt-1 text-sm font-black text-primary">{shortDate(viewingActivity?.lastDate)}</p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[9px] font-black uppercase tracking-widest text-muted">Historial de compras</p>
                <span className="text-[9px] font-bold text-muted">
                  {viewingTransactions.length} {viewingTransactions.length === 1 ? "ticket" : "tickets"}
                </span>
              </div>

              {viewingTransactions.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <ShoppingBag size={34} className="text-muted opacity-40" />
                  <p className="text-sm font-black text-primary">Sin compras todavía</p>
                  <p className="max-w-[230px] text-xs font-semibold text-muted">
                    Cuando este cliente compre en el POS, sus tickets aparecerán aquí con su detalle.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {viewingTransactions.map(tx => (
                    <article key={tx.id} className="rounded-xl border border-base bg-primary p-3 shadow-2xs">
                      <div className="flex items-start justify-between gap-2 border-b border-dashed border-base pb-2">
                        <div className="min-w-0">
                          <p className="text-[10px] font-black uppercase tracking-wide text-primary">{ticketLabel(tx)}</p>
                          <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-muted">
                            <Clock3 size={10} /> {shortDate(tx.date)} · {branchLabel(tx.branchId)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-black tabular-nums text-primary">{formatMoney(tx.total)}</p>
                          {tx.status === 'partial_refund' && (
                            <span className="mt-0.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                              Reembolso parcial
                            </span>
                          )}
                        </div>
                      </div>
                      <ul className="mt-2 space-y-1">
                        {(tx.items || []).slice(0, 4).map((item, index) => (
                          <li key={`${tx.id}-${index}`} className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-secondary">
                              <Package size={10} className="shrink-0 text-muted" />
                              <span className="truncate">{item.quantity}× {item.product?.name || "Producto"}{item.variantLabel ? ` · ${item.variantLabel}` : ""}</span>
                            </span>
                            <span className="shrink-0 text-[10px] font-bold tabular-nums text-muted">{formatMoney(item.price * item.quantity)}</span>
                          </li>
                        ))}
                        {(tx.items || []).length > 4 && (
                          <li className="text-[10px] font-semibold text-muted">+{tx.items.length - 4} producto(s) más</li>
                        )}
                      </ul>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-base bg-subtle p-4">
              <button
                type="button"
                onClick={() => openEdit(viewingCustomer)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-base bg-primary px-3 py-2.5 text-xs font-black uppercase tracking-wide text-primary transition-colors hover:bg-secondary cursor-pointer"
              >
                <Pencil size={14} /> Editar cliente
              </button>
              <button
                type="button"
                onClick={() => setDeletingCustomer(viewingCustomer)}
                disabled={Boolean(viewingActivity)}
                title={viewingActivity ? "Este cliente tiene ventas registradas y no puede eliminarse." : "Eliminar cliente"}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-black uppercase tracking-wide text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300"
              >
                <Trash2 size={14} /> Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Alta / edición */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-3 backdrop-blur-sm sm:p-4">
          <div className="palmyra-mobile-modal w-full max-w-md overflow-hidden rounded-2xl border border-base bg-secondary shadow-2xl animate-in zoom-in-95" role="dialog" aria-modal="true" aria-label={editingCustomer ? "Editar cliente" : "Nuevo cliente"}>
            <div className="flex items-center justify-between border-b border-base bg-subtle px-4 py-3">
              <div>
                <h3 className="text-sm font-black text-primary">{editingCustomer ? "Editar cliente" : "Nuevo cliente"}</h3>
                <p className="text-[10px] font-semibold text-muted">Los datos quedan disponibles para ventas, cotizaciones y garantías.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                aria-label="Cerrar formulario"
                className="rounded-full p-1.5 text-muted transition-colors hover:bg-base"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveCustomer} className="space-y-3 p-4">
              <div>
                <label htmlFor="customer-name" className="mb-1 block text-[9px] font-black uppercase tracking-widest text-muted">Nombre completo *</label>
                <input
                  id="customer-name"
                  required
                  type="text"
                  value={formData.name}
                  onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                  placeholder="Ej. María Pérez"
                  className="w-full rounded-lg border border-base bg-primary px-3 py-2 text-sm font-bold text-primary outline-none focus:border-violet-400"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="customer-phone" className="mb-1 block text-[9px] font-black uppercase tracking-widest text-muted">Teléfono</label>
                  <input
                    id="customer-phone"
                    type="tel"
                    value={formData.phone}
                    onChange={(event) => setFormData({ ...formData, phone: event.target.value })}
                    placeholder="5555-1020"
                    className="w-full rounded-lg border border-base bg-primary px-3 py-2 text-sm font-bold text-primary outline-none focus:border-violet-400"
                  />
                </div>
                <div>
                  <label htmlFor="customer-taxid" className="mb-1 block text-[9px] font-black uppercase tracking-widest text-muted">CI o pasaporte</label>
                  <input
                    id="customer-taxid"
                    type="text"
                    value={formData.taxId}
                    onChange={(event) => setFormData({ ...formData, taxId: event.target.value })}
                    placeholder="Documento"
                    className="w-full rounded-lg border border-base bg-primary px-3 py-2 text-sm font-bold text-primary outline-none focus:border-violet-400"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="customer-email" className="mb-1 block text-[9px] font-black uppercase tracking-widest text-muted">Correo (opcional)</label>
                <input
                  id="customer-email"
                  type="email"
                  value={formData.email}
                  onChange={(event) => setFormData({ ...formData, email: event.target.value })}
                  placeholder="cliente@correo.com"
                  className="w-full rounded-lg border border-base bg-primary px-3 py-2 text-sm font-bold text-primary outline-none focus:border-violet-400"
                />
              </div>

              {formError && (
                <div className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-bold text-red-600 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300" role="alert">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {formError}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  disabled={savingCustomer}
                  className="flex-1 rounded-xl border border-base bg-primary px-3 py-2.5 text-xs font-black uppercase tracking-wide text-primary transition-colors hover:bg-secondary disabled:opacity-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingCustomer}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-3 py-2.5 text-xs font-black uppercase tracking-wide text-white transition-colors hover:bg-violet-700 disabled:cursor-wait disabled:opacity-70 cursor-pointer"
                >
                  {savingCustomer ? <Loader2 size={14} className="animate-spin" /> : null}
                  {savingCustomer ? "Guardando…" : editingCustomer ? "Guardar cambios" : "Registrar cliente"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmación de eliminación */}
      {deletingCustomer && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-3 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-base bg-secondary shadow-2xl" role="alertdialog" aria-modal="true" aria-label="Eliminar cliente">
            <div className="p-4">
              <div className="flex items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300">
                  <Trash2 size={16} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-black text-primary">
                    {deleteBlocked ? "No se puede eliminar" : "¿Eliminar cliente?"}
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-muted">
                    {deleteBlocked
                      ? `${deletingCustomer.name} tiene ventas registradas. Conserva el historial para mantener la trazabilidad de la caja y los reportes.`
                      : `${deletingCustomer.name} se retirará del directorio. Esta acción no afecta ventas ni documentos existentes.`}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex gap-2 border-t border-base bg-subtle p-3">
              <button
                type="button"
                onClick={() => setDeletingCustomer(null)}
                className="flex-1 rounded-xl border border-base bg-primary px-3 py-2 text-xs font-black uppercase tracking-wide text-primary hover:bg-secondary cursor-pointer"
              >
                {deleteBlocked ? "Entendido" : "Cancelar"}
              </button>
              {!deleteBlocked && (
                <button
                  type="button"
                  onClick={confirmDelete}
                  className="flex-1 rounded-xl bg-red-600 px-3 py-2 text-xs font-black uppercase tracking-wide text-white hover:bg-red-700 cursor-pointer"
                >
                  Eliminar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </OperationsSurface>
  );
}

export default function Customers() {
  return (
    <PlanFeatureGate feature="customers_suppliers" title="Clientes" description="Esta función está incluida en Caravana para negocios que necesitan ampliar el control de su operación." highlights={[
      "Directorio con historial de compras y ticket promedio",
      "Total gastado y valor acumulado por cliente",
      "Alta y edición desde el POS o desde la ficha"
    ]}>
      <CustomersContent />
    </PlanFeatureGate>
  );
}
