import { Component, useEffect, useMemo, useState, type ErrorInfo, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  Building2,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  CreditCard,
  Database,
  Package,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  ShoppingCart,
  Settings2,
  Shield,
  Headphones,
  Phone,
  Mail,
  Save,
  ExternalLink,
  Edit3,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Users,
  X,
  XCircle,
  Banknote,
  MapPinned,
  LockKeyhole,
  FileText,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  approveRequest,
  changeCompanyStatus,
  loadPlatformSnapshot,
  rejectRequest,
  type PlanRequest,
  type PlatformPlan,
  type ExchangeRatePayload,
  type PlatformCompany,
  type PlatformSnapshot,
  type InfrastructureUsage,
  type PlatformControlCenter,
  loadPlatformControlCenter,
  loadInfrastructureUsage,
  loadExchangeRates,
  loadSupportRequests,
  loadSupportSettings,
  saveSupportSettings,
  type PlatformSupportRequest,
  type PlatformSupportSettings,
  loadPlatformPlans,
  retryPlatformSyncItem,
  updatePlatformPlan,
} from "../platformAdminApi";
import { adminSignIn, adminSignOut, adminUser, getAdminSupabase } from "../supabase";
import { Button, StatCard, StatusBadge, EmptyPanel, formatDate, statusLabel, isToday, FileTextIcon } from "../shared";

function CompanyCard({
  company,
  busy,
  onToggle,
  onDetails,
}: {
  company: PlatformCompany;
  busy: boolean;
  onToggle: (company: PlatformCompany) => void;
  onDetails?: (company: PlatformCompany) => void;
}) {
  const suspended = company.account_status === "suspended";
  return (
    <article className="admin-company-card">
      <div className="admin-company-card__head">
        <div className="admin-company-avatar">{company.name.slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0">
          <h3>{company.name}</h3>
          <p>{company.slug || company.id}</p>
        </div>
        <StatusBadge status={company.account_status} />
        {onDetails ? <Button variant="ghost" className="admin-company-details-btn" onClick={() => onDetails(company)}><ArrowUpRight size={12}/>360°</Button> : null}
      </div>
      <div className="admin-company-plan">
        <span>{company.plan_name || company.plan_code || "Sin plan"}</span>
        <span>{company.plan_limits?.products ? `${company.products ?? 0}/${company.plan_limits.products} productos` : "Límite no disponible"}</span>
        <span>{company.plan_limits?.employees ? `${company.employees ?? 0}/${company.plan_limits.employees} empleados` : ""}</span>
        {"sync_failed" in company && Number((company as any).sync_failed || 0) > 0 ? <span className="admin-company-plan--alert">{Number((company as any).sync_failed)} sync fallidas</span> : null}
      </div>
      <div className="admin-company-card__metrics">
        <div><strong>{company.products ?? "—"}</strong><span>Productos</span></div>
        <div><strong>{company.employees ?? "—"}</strong><span>Usuarios</span></div>
        <div><strong>{company.sales ?? "—"}</strong><span>Ventas</span></div>
        <div><strong>{company.data_records ?? "—"}</strong><span>Registros</span></div>
      </div>
      <div className="admin-company-card__foot">
        <span>Creada {formatDate(company.created_at)}</span>
        <Button disabled={busy} variant={suspended ? "primary" : "secondary"} onClick={() => onToggle(company)}>
          {suspended ? <Check size={14} /> : <XCircle size={14} />}
          {suspended ? "Reactivar" : "Suspender"}
        </Button>
      </div>
    </article>
  );
}

export default function CompaniesView({
  companies,
  busy,
  onToggle,
}: {
  companies: PlatformCompany[];
  busy: boolean;
  onToggle: (company: PlatformCompany) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return companies.filter((company) => {
      const matchesSearch = !q || [company.name, company.slug, company.id].some((v) => String(v || "").toLowerCase().includes(q));
      const matchesFilter = filter === "all" || String(company.account_status || "") === filter;
      return matchesSearch && matchesFilter;
    });
  }, [companies, query, filter]);

  const [selected, setSelected] = useState<PlatformCompany | null>(null);

  return (
    <>
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">EMPRESAS</p><h1>Todos tus clientes, sin perder el contexto.</h1><p>Busca una cuenta, revisa su operación y cambia estados administrativos sin tocar su lógica interna.</p></div>
        <div className="admin-page-count"><strong>{filtered.length}</strong><span>visibles</span></div>
      </section>
      <section className="admin-toolbar">
        <div className="admin-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar empresa, slug o ID..." /></div>
        <div className="admin-filter-row">
          {[
            ["all", "Todas"],
            ["active", "Activas"],
            ["suspended", "Suspendidas"],
            ["pending_payment", "Pago pendiente"],
          ].map(([value, label]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
          ))}
        </div>
      </section>
      <section className="admin-company-grid">
        {filtered.map((company) => <CompanyCard key={company.id} company={company} busy={busy} onToggle={onToggle} onDetails={setSelected} />)}
        {filtered.length === 0 ? <EmptyPanel title="No encontramos esa empresa" description="Prueba con otro nombre, slug o estado." /> : null}
      </section>
    </div>
    {selected ? (
      <div className="admin-detail-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelected(null); }}>
        <aside className="admin-company-detail">
          <div className="admin-company-detail__head">
            <div><p className="admin-eyebrow">EMPRESA · 360°</p><h2>{selected.name}</h2><span>{selected.slug || selected.id}</span></div>
            <button type="button" className="admin-square-button" onClick={() => setSelected(null)} aria-label="Cerrar"><X size={15}/></button>
          </div>
          <div className="admin-company-detail__status"><StatusBadge status={selected.account_status}/><span>{selected.plan_name || selected.plan_code || "Sin plan"}</span></div>
          <div className="admin-company-detail__grid">
            {[
              ["Productos", selected.products],
              ["Empleados", selected.employees],
              ["Almacenes", selected.warehouses],
              ["Ventas", selected.sales],
              ["Movimientos", selected.stock_movements],
              ["Sesiones de caja", selected.cash_sessions],
              ["Registros", selected.data_records],
            ].map(([label,value]) => <div key={String(label)}><strong>{Number(value||0).toLocaleString("es-CU")}</strong><span>{label}</span></div>)}
          </div>
          <div className="admin-company-detail__section">
            <span>Última venta</span><strong>{formatDate(selected.last_sale_at)}</strong>
          </div>
          <div className="admin-company-detail__section">
            <span>Límites del plan</span>
            <div className="admin-company-limit-list">
              <b>Productos <em>{selected.products ?? 0} / {selected.plan_limits?.products ?? "∞"}</em></b>
              <b>Empleados <em>{selected.employees ?? 0} / {selected.plan_limits?.employees ?? "∞"}</em></b>
              <b>Almacenes <em>{selected.warehouses ?? 0} / {selected.plan_limits?.warehouses ?? "∞"}</em></b>
            </div>
          </div>
          <div className="admin-company-detail__footer">
            <Button variant={selected.account_status === "suspended" ? "primary" : "danger"} onClick={() => { onToggle(selected); setSelected(null); }}>
              {selected.account_status === "suspended" ? "Reactivar empresa" : "Suspender empresa"}
            </Button>
          </div>
        </aside>
      </div>
    ) : null}
  </>
  );
}
