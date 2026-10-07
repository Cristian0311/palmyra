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
} from "./platformAdminApi";
import { adminSignIn, adminSignOut, adminUser, getAdminSupabase } from "./supabase";
import "./admin.css";

type View = "overview" | "companies" | "billing" | "support" | "sync" | "audit" | "analytics" | "security" | "health" | "infrastructure" | "exchange" | "settings";

const navItems: Array<{ id: View; label: string; icon: typeof BarChart3; hint: string }> = [
  { id: "overview", label: "Dashboard", icon: BarChart3, hint: "Estado global de PALMYRA" },
  { id: "companies", label: "Empresas", icon: Building2, hint: "Clientes y cuentas" },
  { id: "billing", label: "Planes y pagos", icon: CreditCard, hint: "Catálogo, límites y activaciones" },
  { id: "exchange", label: "Tasa de cambio", icon: CircleDollarSign, hint: "Referencia informativa de elTOQUE" },
  { id: "support", label: "Soporte", icon: TicketCheck, hint: "Atención operativa" },
  { id: "sync", label: "Sincronización", icon: RefreshCw, hint: "Cola, errores y conflictos" },
  { id: "audit", label: "Auditoría", icon: Activity, hint: "Trazabilidad de operaciones" },
  { id: "analytics", label: "Analytics", icon: BarChart3, hint: "Uso y crecimiento real" },
  { id: "security", label: "Seguridad", icon: Shield, hint: "Acceso y controles" },
  { id: "health", label: "Health Center", icon: ShieldCheck, hint: "Estado operativo global" },
  { id: "infrastructure", label: "Infraestructura", icon: Database, hint: "Salud y recursos del SaaS" },
  { id: "settings", label: "Configuración", icon: Settings2, hint: "Seguridad de la plataforma" },
];

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(status?: string | null) {
  const map: Record<string, string> = {
    active: "Activa",
    suspended: "Suspendida",
    setup: "Configuración",
    pending_payment: "Pago pendiente",
    trialing: "Prueba",
    cancelled: "Cancelada",
  };
  return map[status || ""] || status || "Sin estado";
}

function isToday(value?: string | null) {
  if (!value) return false;
  const d = new Date(value);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`admin-btn admin-btn--${variant} ${className}`}
    >
      {children}
    </button>
  );
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "violet",
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof BarChart3;
  tone?: "violet" | "green" | "amber" | "slate";
}) {
  return (
    <article className={`admin-stat admin-stat--${tone}`}>
      <div className="admin-stat__top">
        <span>{label}</span>
        <span className="admin-icon-box"><Icon size={15} strokeWidth={2.2} /></span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function StatusBadge({ status }: { status?: string | null }) {
  const normalized = String(status || "").toLowerCase();
  const tone =
    normalized === "active" ? "green" :
    normalized === "suspended" ? "red" :
    normalized === "pending_payment" ? "amber" :
    "slate";
  return <span className={`admin-status admin-status--${tone}`}><span />{statusLabel(status)}</span>;
}

class AdminErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[PALMYRA ADMIN] Render error", error, info); }
  render() {
    if (this.state.error) return <main className="admin-auth admin-error-screen"><section className="admin-auth-card"><div className="admin-brand-mark"><span>!</span></div><p className="admin-eyebrow">PALMYRA · CONTROL CENTER</p><h1>Se produjo un error en el panel</h1><p className="admin-auth-copy">{this.state.error.message || "Error inesperado de interfaz."}</p><div className="admin-error-actions"><Button variant="primary" onClick={() => window.location.reload()}><RefreshCw size={14}/>Recargar panel</Button><Button variant="secondary" onClick={() => this.setState({error:null})}>Intentar continuar</Button></div></section></main>;
    return this.props.children;
  }
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (snapshot: PlatformSnapshot) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { error: signInError } = await adminSignIn(email, password);
      if (signInError) throw signInError;
      const snapshot = await loadPlatformSnapshot();
      onAuthenticated(snapshot);
    } catch (err) {
      await adminSignOut().catch(() => undefined);
      setError(err instanceof Error ? err.message : "No se pudo validar el acceso administrativo.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="admin-auth">
      <div className="admin-auth__glow admin-auth__glow--one" />
      <div className="admin-auth__glow admin-auth__glow--two" />
      <section className="admin-auth-card">
        <div className="admin-brand-mark"><span>✦</span></div>
        <p className="admin-eyebrow">PALMYRA · CONTROL CENTER</p>
        <h1>Acceso administrativo</h1>
        <p className="admin-auth-copy">
          Una consola independiente para operar el SaaS sin mezclar la administración de PALMYRA con el CRM de las empresas.
        </p>
        <form onSubmit={submit} className="admin-auth-form">
          <label>
            <span>Correo administrativo</span>
            <input
              autoComplete="username"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@palmyra..."
              required
            />
          </label>
          <label>
            <span>Contraseña</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </label>
          {error ? <div className="admin-alert admin-alert--error"><AlertCircle size={16} />{error}</div> : null}
          <Button type="submit" variant="primary" disabled={loading} className="admin-auth-submit">
            {loading ? <RefreshCw size={16} className="spin" /> : <ShieldCheck size={16} />}
            {loading ? "Validando acceso..." : "Entrar al centro de control"}
          </Button>
        </form>
        <div className="admin-auth-foot">
          <Shield size={14} />
          La autorización real se verifica en Supabase mediante RPC seguro.
        </div>
      </section>
    </main>
  );
}

function EmptyPanel({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="admin-empty">
      <div className="admin-empty__icon"><Sparkles size={18} /></div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Overview({ snapshot, onRefresh }: { snapshot: PlatformSnapshot; onRefresh: () => Promise<void> }) {
  const metrics = useMemo(() => {
    const companies = snapshot.companies;
    const active = companies.filter((c) => c.account_status === "active").length;
    const suspended = companies.filter((c) => c.account_status === "suspended").length;
    const today = companies.filter((c) => isToday(c.created_at)).length;
    const openSupport = snapshot.supportRequests.filter((r) => ["open", "in_progress"].includes(String(r.status))).length;
    const products = companies.reduce((sum, c) => sum + Number(c.products || 0), 0);
    const users = companies.reduce((sum, c) => sum + Number(c.employees || 0), 0);
    const warehouses = companies.reduce((sum, c) => sum + Number(c.warehouses || 0), 0);
    const records = companies.reduce((sum, c) => sum + Number(c.data_records || 0), 0);
    const sales = companies.reduce((sum, c) => sum + Number(c.sales || 0), 0);
    const topDataCompany = [...companies].sort((a,b) => Number(b.data_records||0)-Number(a.data_records||0))[0] || null;
    return { total: companies.length, active, suspended, today, requests: snapshot.requests.length, openSupport, products, users, warehouses, records, sales, topDataCompany };
  }, [snapshot]);

  return (
    <div className="admin-content-stack">
      <section className="admin-welcome">
        <div>
          <p className="admin-eyebrow">VISIÓN GENERAL</p>
          <h1>El estado de PALMYRA, en una sola mirada.</h1>
          <p>La consola está diseñada para que una acción administrativa siempre tenga contexto, estado y trazabilidad.</p>
        </div>
        <Button onClick={() => void onRefresh()} variant="secondary"><RefreshCw size={15} />Actualizar datos</Button>
      </section>

      <section className="admin-stat-grid">
        <StatCard label="Empresas" value={metrics.total} detail={`${metrics.today} registradas hoy`} icon={Building2} />
        <StatCard label="Activas" value={metrics.active} detail="Operando normalmente" icon={ShieldCheck} tone="green" />
        <StatCard label="Suspendidas" value={metrics.suspended} detail="Requieren revisión" icon={AlertCircle} tone="amber" />
        <StatCard label="Solicitudes" value={metrics.requests} detail="Pendientes de activar" icon={CreditCard} tone="slate" />
        <StatCard label="Soporte abierto" value={metrics.openSupport} detail="Abiertas o en atención" icon={Headphones} tone="amber" />
        <StatCard label="Registros operativos" value={metrics.records} detail="Huella de datos visible del SaaS" icon={Database} tone="slate" />
        <StatCard label="Ventas registradas" value={metrics.sales} detail="Actividad comercial acumulada" icon={ShoppingCart} tone="green" />
      </section>

      <section className="admin-panel admin-company-consumption">
        <div className="admin-panel__head"><div><p className="admin-kicker">CONSUMO POR EMPRESA</p><h2>Quién está generando más datos</h2><p>Indicador operativo calculado a partir de productos, variantes, ventas, partidas, movimientos, caja, empleados y almacenes.</p></div><Database size={17}/></div>
        <div className="admin-company-consumption-list">
          {[...snapshot.companies].sort((a,b)=>Number(b.data_records||0)-Number(a.data_records||0)).slice(0,8).map((company,index)=>(
            <div key={company.id} className="admin-company-consumption-row">
              <span className="admin-company-rank">{String(index+1).padStart(2,"0")}</span>
              <div className="min-w-0 flex-1"><strong>{company.name}</strong><small>{company.plan_name || company.plan_code || "Sin plan"} · {Number(company.sales||0).toLocaleString("es-CU")} ventas</small></div>
              <div className="admin-company-consumption-value"><strong>{Number(company.data_records||0).toLocaleString("es-CU")}</strong><small>registros</small></div>
            </div>
          ))}
          {!snapshot.companies.length ? <EmptyPanel title="Sin empresas" description="No hay datos de consumo empresarial todavía." /> : null}
        </div>
      </section>

      <section className="admin-grid-3">
        {[
          [Package, "Productos registrados", metrics.products, "Suma visible de todas las empresas"],
          [Users, "Usuarios del SaaS", metrics.users, "Usuarios/trabajadores visibles"],
          [Building2, "Almacenes", metrics.warehouses, "Almacenes registrados"],
        ].map(([Icon, title, value, detail]) => {
          const I = Icon as typeof Package;
          return <div className="admin-mini-panel" key={String(title)}><span className="admin-icon-box"><I size={15} /></span><h3>{title as string}</h3><strong className="admin-overview-number">{String(value)}</strong><p>{detail as string}</p></div>;
        })}
      </section>

      <section className="admin-grid-2">
        <div className="admin-panel">
          <div className="admin-panel__head"><div><p className="admin-kicker">OPERACIÓN</p><h2>Actividad reciente</h2></div><ArrowUpRight size={17} /></div>
          <div className="admin-timeline">
            {snapshot.companies.slice(0, 5).map((company) => (
              <div key={company.id} className="admin-timeline__item">
                <span className="admin-timeline__dot" />
                <div><strong>{company.name}</strong><span>Cuenta {statusLabel(company.account_status).toLowerCase()} · {formatDate(company.created_at)}</span></div>
              </div>
            ))}
            {snapshot.companies.length === 0 ? <EmptyPanel title="Todavía no hay empresas visibles" description="Cuando el acceso administrativo esté conectado, este espacio mostrará actividad real." /> : null}
          </div>
        </div>

        <div className="admin-panel admin-panel--dark">
          <div className="admin-panel__head"><div><p className="admin-kicker">CONTROL</p><h2>Reglas del centro</h2></div><ShieldCheck size={17} /></div>
          <div className="admin-rules">
            {[
              "El CRM de cada empresa permanece aislado del panel administrativo.",
              "Las decisiones críticas se ejecutan mediante funciones seguras en Supabase.",
              "El navegador nunca recibe una clave secreta de Supabase.",
              "Las acciones administrativas deben quedar registradas en auditoría.",
            ].map((item) => <div key={item}><Check size={14} /><span>{item}</span></div>)}
          </div>
        </div>
      </section>
    </div>
  );
}

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

function CompaniesView({
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

function BillingView({
  requests, busy, onApprove, onReject,
}: { requests: PlanRequest[]; busy: boolean; onApprove: (request: PlanRequest) => void; onReject: (request: PlanRequest) => void; }) {
  const [plans, setPlans] = useState<PlatformPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [planError, setPlanError] = useState("");
  const refreshPlans = async () => { setLoadingPlans(true); setPlanError(""); try { setPlans(await loadPlatformPlans()); } catch (err) { setPlanError(err instanceof Error ? err.message : "No se pudieron cargar los planes."); } finally { setLoadingPlans(false); } };
  useEffect(() => { void refreshPlans(); }, []);
  return (
    <div className="admin-content-stack">
      <section className="admin-page-head"><div><p className="admin-eyebrow">PLANES Y PAGOS</p><h1>Planes claros, compactos y administrables.</h1><p>Catálogo real leído desde Supabase: precio, límites, funciones, periodo de prueba y empresas actualmente asociadas.</p></div><div className="admin-page-count"><strong>{plans.length}</strong><span>planes</span></div></section>
      {planError ? <div className="admin-alert admin-alert--error"><AlertCircle size={16}/>{planError}</div> : null}
      <section className="admin-plan-grid">
        {plans.map(plan => {
          const featureData = Array.isArray(plan.features) ? plan.features : (plan.features?.features || []);
          const description = Array.isArray(plan.features) ? "" : String(plan.features?.description || "");
          return <article key={plan.id} className={`admin-plan-card ${plan.active ? "" : "is-inactive"}`}>
            <div className="admin-plan-card__head"><div><span className="admin-plan-code">{plan.code}</span><h2>{plan.name}</h2></div><span className={`admin-plan-status ${plan.active ? "is-active" : "is-inactive"}`}>{plan.active ? "Activo" : "Inactivo"}</span></div>
            <div className="admin-plan-price"><strong>${Number(plan.monthly_price || 0).toFixed(2)}</strong><span>/ mes · {plan.billing_currency_code || "USD"}</span></div>
            <div className="admin-plan-facts"><div><strong>{plan.limits?.products ?? "—"}</strong><span>Productos</span></div><div><strong>{plan.limits?.employees ?? "—"}</strong><span>Empleados</span></div><div><strong>{plan.limits?.warehouses ?? "—"}</strong><span>Almacenes</span></div><div><strong>{plan.companies ?? 0}</strong><span>Empresas</span></div></div>
            {plan.trial_days > 0 ? <div className="admin-plan-trial"><Clock3 size={12}/> {plan.trial_days} días de prueba</div> : null}
            {description ? <p className="admin-plan-description">{description}</p> : null}
            <div className="admin-plan-features">{featureData.map((feature:string) => <span key={feature}><Check size={10}/>{feature}</span>)}</div>
          </article>;
        })}
        {!plans.length && !loadingPlans ? <EmptyPanel title="No hay planes disponibles" description="Supabase no devolvió planes para este administrador."/> : null}
      </section>
      <section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>{requests.length} activaciones pendientes</h2><p className="admin-panel-subtitle">Cada solicitud se aprueba o rechaza sobre el registro real de Supabase.</p></div><Clock3 size={17}/></div>
      {requests.length ? <div className="admin-request-list">{requests.map(request => <article key={request.id} className="admin-request-row"><div className="admin-request-main"><div className="admin-company-avatar admin-company-avatar--small">{String(request.company_name || "?").slice(0,1).toUpperCase()}</div><div><strong>{request.company_name || "Empresa sin nombre"}</strong><span>{request.plan_name || "Plan"} · {formatDate(request.requested_at)}</span></div></div><div className="admin-request-price"><strong>{request.monthly_price != null ? `$ ${Number(request.monthly_price).toFixed(2)}` : "—"}</strong><span>{request.payment_method || "Pago manual"}</span></div><div className="admin-request-actions"><Button disabled={busy} variant="primary" onClick={() => onApprove(request)}><Check size={14}/>Aprobar</Button><Button disabled={busy} variant="secondary" onClick={() => onReject(request)}><X size={14}/>Rechazar</Button></div></article>)}</div> : <EmptyPanel title="No hay solicitudes pendientes" description="Cuando llegue una nueva solicitud aparecerá aquí con su empresa, plan y método de pago."/>}
      </section>
    </div>
  );
}

function ExchangeRateView() {
  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">TASA DE CAMBIO PALMYRA</p>
          <h1>Referencia informativa del mercado cubano.</h1>
          <p>PALMYRA mostrará las cotizaciones publicadas por la fuente oficial de datos una vez habilitada la integración.</p>
        </div>
        <span className="admin-mini-badge"><LockKeyhole size={11}/> PRÓXIMAMENTE</span>
      </section>

      <section className="admin-coming-soon admin-coming-soon--exchange">
        <div className="admin-coming-soon__icon"><Banknote size={28}/></div>
        <p className="admin-eyebrow">EN DESARROLLO</p>
        <h2>Tasa de Cambio PALMYRA</h2>
        <p>
          Esta sección será exclusivamente informativa. No permitirá configurar una tasa,
          modificar precios del CRM ni funcionará como conversor.
        </p>

        <div className="admin-exchange-preview">
          <div className="admin-exchange-preview__head">
            <div><strong>Cotizaciones por provincia</strong><span>Vista preparada para datos oficiales</span></div>
            <MapPinned size={17}/>
          </div>
          <div className="admin-exchange-preview__columns">
            <span>Provincia</span><span>USD</span><span>EUR</span><span>MLC</span>
          </div>
          {["Pinar del Río","Artemisa","La Habana","Mayabeque","Matanzas","Villa Clara","Cienfuegos","Sancti Spíritus","Ciego de Ávila","Camagüey","Las Tunas","Holguín","Granma","Santiago de Cuba","Guantánamo","Isla de la Juventud"].slice(0,6).map((province) => (
            <div className="admin-exchange-preview__row" key={province}>
              <strong>{province}</strong><span>—</span><span>—</span><span>—</span>
            </div>
          ))}
          <div className="admin-exchange-preview__more">+ provincias restantes cuando la fuente oficial esté habilitada</div>
        </div>

        <div className="admin-coming-soon__note">
          <ShieldCheck size={15}/>
          <span>La integración utilizará la API oficial de elTOQUE cuando sea habilitada. Hasta entonces PALMYRA no mostrará valores inventados.</span>
        </div>
      </section>
    </div>
  );
}

function SupportView() {
  const [requests, setRequests] = useState<PlatformSupportRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState("");

  const refresh = async (nextFilter = filter) => {
    setLoading(true);
    setError("");
    try {
      setRequests(await loadSupportRequests(nextFilter === "all" ? undefined : nextFilter));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las solicitudes.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [filter]);

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">ATENCIÓN</p>
          <h1>Centro de atención al cliente.</h1>
          <p>Las solicitudes enviadas desde cada empresa quedan registradas aquí antes de continuar por el canal oficial.</p>
        </div>
        <Button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""}/>Actualizar</Button>
      </section>
      <section className="admin-toolbar">
        <div className="admin-filter-row">
          {[["open","Abiertas"],["in_progress","En atención"],["resolved","Resueltas"],["closed","Cerradas"],["all","Todas"]].map(([value,label]) =>
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter===value ? "active" : ""}>{label}</button>
          )}
        </div>
      </section>
      {error ? <div className="admin-global-error"><AlertCircle size={16}/>{error}</div> : null}
      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>{requests.length} registros</h2></div><TicketCheck size={17}/></div>
        {loading ? <div className="admin-empty">Cargando solicitudes…</div> :
          requests.length ? <div className="admin-request-list">{requests.map(request =>
            <article key={request.id} className="admin-request-row">
              <div className="admin-request-main">
                <div className="admin-company-avatar admin-company-avatar--small">{request.company_name.slice(0,1).toUpperCase()}</div>
                <div><strong>{request.company_name}</strong><span>{request.request_type} · {request.subject}</span><span>{formatDate(request.created_at)}</span></div>
              </div>
              <div className="admin-request-price"><strong>{request.status}</strong><span>{request.contact_phone || "Sin teléfono"}</span></div>
              <div className="admin-request-actions"><a className="admin-btn admin-btn--secondary" href={`https://wa.me/?text=${encodeURIComponent("Solicitud "+request.id+" · "+request.company_name+" · "+request.subject)}`} target="_blank" rel="noreferrer"><ArrowUpRight size={14}/>Abrir canal</a></div>
            </article>
          )}</div> : <EmptyPanel title="No hay solicitudes en este estado" description="Cuando una empresa envíe una solicitud aparecerá aquí." />
        }
      </section>
    </div>
  );
}

function capacityTone(percent: number | null) {
  if (percent == null) return "neutral";
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warning";
  return "healthy";
}

function capacityLabel(percent: number | null) {
  if (percent == null) return "Sin dato";
  if (percent >= 90) return "Crítico";
  if (percent >= 75) return "Vigilar";
  return "Saludable";
}

function formatUsage(value: number | null, unit: "gb" | "mb" | "percent") {
  if (value == null) return "—";
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "gb") return value >= 1 ? `${value.toFixed(2)} GB` : `${(value * 1024).toFixed(0)} MB`;
  return value >= 1024 ? `${(value / 1024).toFixed(2)} GB` : `${value.toFixed(1)} MB`;
}

function UsageBar({ percent, label }: { percent: number | null; label: string }) {
  const tone = capacityTone(percent);
  return (
    <div className="admin-usage-bar-wrap">
      <div className="admin-usage-bar"><span className={`admin-usage-bar__fill admin-usage-bar__fill--${tone}`} style={{ width: `${Math.min(100, Math.max(0, percent || 0))}%` }} /></div>
      <span className={`admin-usage-status admin-usage-status--${tone}`}>{label}</span>
    </div>
  );
}

function InfrastructureView() {
  const [usage,setUsage]=useState<InfrastructureUsage|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");

  const refresh=async()=>{
    setLoading(true);setError("");
    try{setUsage(await loadInfrastructureUsage());}
    catch(err){setError(err instanceof Error?err.message:"No se pudo consultar las métricas reales.");}
    finally{setLoading(false);}
  };
  useEffect(()=>{void refresh()},[]);

  const render=usage?.render;
  const supabase=usage?.supabase;
  const services=render?.services||[];
  const topCompanies=[...(supabase?.companyMetrics||[])].sort((a,b)=>Number(b.data_records||0)-Number(a.data_records||0)).slice(0,8);
  const topTables=[...(supabase?.tables||[])].slice(0,12);
  const decision=(render?.bandwidthPercent||0)>=90 || (supabase?.databasePercent||0)>=90
    ?"Ampliación recomendada"
    :(render?.bandwidthPercent||0)>=75 || (supabase?.databasePercent||0)>=75
      ?"Vigilar crecimiento":"Capacidad saludable";

  return <div className="admin-content-stack">
    <section className="admin-page-head">
      <div><p className="admin-eyebrow">INFRAESTRUCTURA REAL</p><h1>Centro de observabilidad de PALMYRA.</h1><p>Lecturas directamente desde Render y Supabase. Sin números simulados: cada tarjeta indica su fuente y cuándo fue capturada.</p></div>
      <Button onClick={()=>void refresh()} variant="secondary" disabled={loading}><RefreshCw size={15} className={loading?"spin":""}/>{loading?"Actualizando…":"Actualizar métricas"}</Button>
    </section>

    {error?<div className="admin-alert admin-alert--error"><AlertCircle size={16}/>{error}</div>:null}

    <section className="admin-grid-3">
      <article className="admin-capacity-summary admin-capacity-summary--render">
        <div className="admin-capacity-summary__head"><span className="admin-icon-box"><Activity size={15}/></span><span className="admin-capacity-plan">RENDER API</span></div>
        <p>Ancho de banda del workspace · mes actual</p>
        <strong>{formatUsage(render?.bandwidthGb??null,"gb")}</strong>
        <span>Cuota: {formatUsage(render?.bandwidthLimitGb??null,"gb")}</span>
        <UsageBar percent={render?.bandwidthPercent??null} label={capacityLabel(render?.bandwidthPercent??null)}/>
        <small>Disponible: {formatUsage(render?.bandwidthAvailableGb??null,"gb")} · {services.length} servicios descubiertos</small>
      </article>
      <article className="admin-capacity-summary admin-capacity-summary--supabase">
        <div className="admin-capacity-summary__head"><span className="admin-icon-box"><Database size={15}/></span><span className="admin-capacity-plan">{supabase?.plan||"SUPABASE"}</span></div>
        <p>Postgres · tamaño real de base de datos</p>
        <strong>{formatUsage(supabase?.databaseMb??null,"mb")}</strong>
        <span>Límite: {formatUsage(supabase?.databaseLimitMb??null,"mb")}</span>
        <UsageBar percent={supabase?.databasePercent??null} label={capacityLabel(supabase?.databasePercent??null)}/>
        <small>Disponible: {formatUsage(supabase?.databaseAvailableMb??null,"mb")} · {supabase?.activeConnections??0} conexiones activas</small>
      </article>
      <article className="admin-capacity-summary admin-capacity-summary--decision">
        <div className="admin-capacity-summary__head"><span className="admin-icon-box"><ShieldCheck size={15}/></span><span className="admin-capacity-plan">ESTADO</span></div>
        <p>Decisión operativa</p><strong>{decision}</strong>
        <span>{supabase?.syncQueue?.pending??0} sincronizaciones pendientes en servidor</span>
        <div className="admin-capacity-decision"><Check size={14}/><span>{supabase?.syncQueue?.failed??0} fallidas · {supabase?.syncQueue?.conflicts??0} conflictos</span></div>
      </article>
    </section>

    <section className="admin-panel">
      <div className="admin-panel__head"><div><p className="admin-kicker">RENDER · API EN VIVO</p><h2>Todos los servicios descubiertos</h2><p className="admin-panel-subtitle">Web Service, Static Site, workers, cron y cualquier otro recurso del workspace configurado.</p></div><span className="admin-mini-badge">{services.length} servicios</span></div>
      <div className="admin-infra-usage-grid">
        {services.map(service=><article className="admin-infra-service" key={service.id}>
          <div className="admin-infra-service__head">
            <div><strong>{service.name}</strong><small>{service.type} · {service.region||"región no disponible"}</small></div>
            <span className={"admin-capacity-dot admin-capacity-dot--"+capacityTone(service.bandwidthGb!=null&&render?.bandwidthLimitGb?Math.min(100,service.bandwidthGb/render.bandwidthLimitGb*100):null)}/>
          </div>
          <div className="admin-service-meta-line"><span>Plan: <b>{service.plan||"No expuesto por API"}</b></span><span>Estado: <b>{service.suspended||"—"}</b></span></div>
          <div className="admin-infra-metric"><div><span>Ancho de banda atribuido</span><strong>{formatUsage(service.bandwidthGb,"gb")}</strong></div><span>mes actual</span></div>
          <UsageBar percent={service.bandwidthGb!=null&&render?.bandwidthLimitGb?Math.min(100,service.bandwidthGb/render.bandwidthLimitGb*100):null} label={service.bandwidthGb==null?"Sin lectura":"cuota workspace"}/>
          <div className="admin-infra-resource-grid">
            <div><span>CPU reciente</span><strong>{service.cpuPercent==null?"—":formatUsage(service.cpuPercent,"percent")}</strong><small>{service.cpuCurrent==null||service.cpuLimit==null?"No disponible":String(service.cpuCurrent.toFixed(5))+" / "+String(service.cpuLimit.toFixed(3))}</small></div>
            <div><span>Memoria reciente</span><strong>{service.memoryPercent==null?"—":formatUsage(service.memoryPercent,"percent")}</strong><small>{formatUsage(service.memoryCurrentMb,"mb")} / {formatUsage(service.memoryLimitMb,"mb")}</small></div>
            <div><span>Peticiones · 6h</span><strong>{service.requestCount6h==null?"—":service.requestCount6h.toLocaleString("es-CU")}</strong><small>{service.metricsAvailable.requests?"Render API":"No disponible"}</small></div>
          </div>
          <div className="admin-service-meta-line"><span>Repo: <b>{service.repo?service.repo.split("/").slice(-2).join("/"):"—"}</b></span><span>Rama: <b>{service.branch||"—"}</b></span></div>
          {service.error?<small className="admin-infra-error">{service.error}</small>:null}
          {service.url?<a href={service.url} target="_blank" rel="noreferrer">Abrir servicio <ExternalLink size={12}/></a>:null}
        </article>)}
        {!services.length&&!loading?<div className="admin-empty-state">Render no devolvió servicios para este workspace.</div>:null}
      </div>
    </section>

    <section className="admin-grid-2">
      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SUPABASE · POSTGRES</p><h2>Capacidad real</h2></div><span className="admin-mini-badge">{supabase?.activeConnections??0} conexiones</span></div>
        <div className="admin-grid-2 admin-infra-real-grid">
          <div className="admin-mini-panel"><h3>Base de datos</h3><strong className="admin-overview-number">{formatUsage(supabase?.databaseMb??null,"mb")}</strong><p>de {formatUsage(supabase?.databaseLimitMb??null,"mb")}</p><UsageBar percent={supabase?.databasePercent??null} label={capacityLabel(supabase?.databasePercent??null)}/></div>
          <div className="admin-mini-panel"><h3>Storage</h3><strong className="admin-overview-number">{formatUsage((supabase?.storageBytes||0)/1024/1024,"mb")}</strong><p>{supabase?.storageObjects??0} objetos reales</p></div>
          <div className="admin-mini-panel"><h3>API requests</h3><strong className="admin-overview-number">{supabase?.apiRequests==null?"—":supabase.apiRequests.toLocaleString("es-CU")}</strong><p>{supabase?.apiRequestsSource==="supabase_management_api"?"Management API · 1 día":"Management API no configurada"}</p></div>
          <div className="admin-mini-panel"><h3>Cola nube</h3><strong className="admin-overview-number">{supabase?.syncQueue?.pending??0}</strong><p>{supabase?.syncQueue?.applied_operations??0} operaciones aplicadas</p></div>
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">TABLAS MÁS GRANDES</p><h2>Dónde está creciendo Postgres</h2></div><Database size={17}/></div>
        <div className="admin-table-list">
          {topTables.map(row=><div className="admin-table-list-row" key={row.schema+"."+row.table}><div><strong>{row.table}</strong><small>{row.schema} · {Number(row.rows||0).toLocaleString("es-CU")} filas</small></div><b>{formatUsage(Number(row.bytes||0)/1024/1024,"mb")}</b></div>)}
        </div>
      </section>
    </section>

    <section className="admin-panel admin-company-consumption">
      <div className="admin-panel__head"><div><p className="admin-kicker">CONSUMO REAL POR EMPRESA</p><h2>Quién genera más carga de datos</h2><p>Conteo real de registros operativos de la base, separado del tamaño físico global de Postgres.</p></div><Users size={17}/></div>
      <div className="admin-company-consumption-list">
        {topCompanies.map((company,index)=><div key={company.id} className="admin-company-consumption-row"><span className="admin-company-rank">{String(index+1).padStart(2,"0")}</span><div className="min-w-0 flex-1"><strong>{company.name}</strong><small>{Number(company.data_records||0).toLocaleString("es-CU")} registros · {Number(company.sales||0).toLocaleString("es-CU")} ventas · {Number(company.products||0).toLocaleString("es-CU")} productos</small></div><div className="admin-company-consumption-value"><strong>{Number(company.stock_movements||0).toLocaleString("es-CU")}</strong><small>movimientos</small></div></div>)}
      </div>
    </section>

    {usage?<p className="admin-infra-updated">Lectura: {formatDate(usage.capturedAt)} · Periodo Render: {formatDate(usage.monthStart)} · Fuentes: {usage.providerSources.render}, {usage.providerSources.supabase}{usage.providerSources.supabaseManagement!=="not_configured"?", "+usage.providerSources.supabaseManagement:""}</p>:null}
  </div>;
}



function EnterpriseDataView({ mode, control }: { mode: "sync"|"audit"|"analytics"|"security"|"health"; control: PlatformControlCenter|null }) {
  if (!control) return <div className="admin-empty"><RefreshCw size={18} className="spin"/><h3>Cargando datos Enterprise…</h3><p>Consultando Supabase con datos reales.</p></div>;
  if (mode === "sync") return <div className="admin-content-stack">
    <section className="admin-page-head"><div><p className="admin-eyebrow">SINCRONIZACIÓN</p><h1>Centro de sincronización.</h1><p>Cola, errores y conflictos reales del SaaS.</p></div><span className="admin-mini-badge">{control.analytics.sync_pending} pendientes · {control.analytics.sync_failed} fallidas</span></section>
    <section className="admin-grid-3"><StatCard label="Pendientes" value={control.analytics.sync_pending} detail="Operaciones en cola" icon={RefreshCw}/><StatCard label="Fallidas" value={control.analytics.sync_failed} detail="Requieren diagnóstico" icon={AlertCircle} tone="amber"/><StatCard label="Conflictos" value={control.analytics.conflicts_open} detail="Sin resolución" icon={XCircle} tone="slate"/></section>
    <section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">ÚLTIMAS OPERACIONES</p><h2>Cola del servidor</h2></div><RefreshCw size={17}/></div>
      <div className="admin-request-list">{control.sync.map(item=><article className="admin-request-row" key={item.id}><div className="admin-request-main"><div className="admin-company-avatar admin-company-avatar--small">{item.company_name.slice(0,1).toUpperCase()}</div><div><strong>{item.company_name}</strong><span>{item.operation} · {item.entity_type} · {item.entity_id}</span><span>{formatDate(item.created_at)}</span></div></div><div className="admin-request-price"><strong>{item.status}</strong><span>{item.attempts} intentos</span></div><div className="admin-request-actions">{item.last_error?<span className="admin-status admin-status--red"><span/>Error</span>:<span className="admin-status admin-status--green"><span/>OK</span>}</div></article>)}</div>
      {!control.sync.length?<EmptyPanel title="Cola limpia" description="No hay operaciones en la cola del servidor."/>:null}
    </section>
    <section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">CONFLICTOS</p><h2>Sin resolver</h2></div><XCircle size={17}/></div>{control.conflicts.length?<div className="admin-table-list">{control.conflicts.map(c=><div className="admin-table-list-row" key={c.id}><div><strong>{c.company_name} · {c.entity_type}</strong><small>{c.operation_id} · {formatDate(c.created_at)}</small></div><b>{c.entity_id}</b></div>)}</div>:<EmptyPanel title="Sin conflictos" description="No existen conflictos abiertos en Supabase."/>}</section>
  </div>;

  if (mode === "audit") return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">AUDITORÍA ENTERPRISE</p><h1>Trazabilidad completa.</h1><p>Acciones registradas por empresa, usuario, entidad y momento.</p></div><span className="admin-mini-badge">{control.audit.length} eventos recientes</span></section><section className="admin-panel"><div className="admin-table-list">{control.audit.map(a=><div className="admin-table-list-row" key={a.id}><div><strong>{a.action} · {a.entity_type}</strong><small>{a.company_name||"Plataforma"} · {a.user_id||"Sistema"} · {formatDate(a.created_at)}</small></div><b>{a.entity_id||"—"}</b></div>)}</div>{!control.audit.length?<EmptyPanel title="Sin eventos" description="No hay registros de auditoría disponibles."/>:null}</section></div>;

  if (mode === "analytics") return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">ANALYTICS</p><h1>Uso real del SaaS.</h1><p>Métricas agregadas directamente desde las tablas operativas de Supabase.</p></div></section><section className="admin-stat-grid"><StatCard label="Empresas" value={control.analytics.companies_total} detail={control.analytics.companies_active+" activas"} icon={Building2}/><StatCard label="Usuarios" value={control.analytics.users_total} detail="Membresías activas" icon={Users}/><StatCard label="Productos" value={control.analytics.products_total} detail="Registrados" icon={Package}/><StatCard label="Ventas" value={control.analytics.sales_total} detail={control.analytics.sales_30d+" en 30 días"} icon={ShoppingCart} tone="green"/><StatCard label="Ventas 30d" value={control.analytics.sales_value_30d.toLocaleString("es-CU")} detail="Valor acumulado" icon={CircleDollarSign} tone="green"/><StatCard label="MRR" value={control.billing.mrr.toLocaleString("es-CU")} detail="Suscripciones activas/prueba" icon={CreditCard}/></section><section className="admin-grid-2"><div className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">BILLING</p><h2>Estado financiero</h2></div><CreditCard size={17}/></div><div className="admin-grid-2 admin-infra-real-grid"><div className="admin-mini-panel"><h3>Suscripciones</h3><strong className="admin-overview-number">{control.billing.active_subscriptions}</strong><p>activas/prueba</p></div><div className="admin-mini-panel"><h3>Facturas pendientes</h3><strong className="admin-overview-number">{control.billing.pending_invoices}</strong><p>{control.billing.pending_amount.toLocaleString("es-CU")} por cobrar</p></div><div className="admin-mini-panel"><h3>Pagos 30d</h3><strong className="admin-overview-number">{control.billing.payments_30d}</strong><p>{control.billing.paid_amount_30d.toLocaleString("es-CU")} cobrados</p></div></div></div><div className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">ALERTAS</p><h2>Prioridades</h2></div><AlertCircle size={17}/></div>{control.alerts.slice(0,8).map(a=><div className="admin-table-list-row" key={a.type+a.company_id}><div><strong>{a.title}</strong><small>{a.company_name||"Plataforma"} · {a.detail}</small></div><span className={"admin-status admin-status--"+(a.severity==="critical"?"red":"amber")}><span/>{a.severity}</span></div>)}</div></section></div>;

  if (mode === "security") return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">SEGURIDAD</p><h1>Controles de acceso y señales.</h1><p>La autorización del panel depende de Supabase y de la tabla de administradores de plataforma.</p></div><span className="admin-status admin-status--green"><span/>RPC protegido</span></section><section className="admin-grid-3"><StatCard label="Eventos auditados" value={control.audit.length} detail="Últimos registros" icon={ShieldCheck}/><StatCard label="Alertas críticas" value={control.alerts.filter(a=>a.severity==="critical").length} detail="Requieren revisión" icon={AlertCircle} tone="amber"/><StatCard label="Conflictos" value={control.analytics.conflicts_open} detail="Bloqueos de sincronización" icon={XCircle} tone="slate"/></section><section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">REGLA</p><h2>Principio de mínimo privilegio</h2></div><LockKeyhole size={17}/></div><p className="admin-panel-subtitle">El frontend no decide quién es administrador. Cada RPC Enterprise verifica auth.uid() contra public.platform_admins antes de devolver datos.</p></section></div>;

  return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">HEALTH CENTER</p><h1>Estado operativo global.</h1><p>Estado calculado con datos reales del backend y proveedores.</p></div></section><section className="admin-grid-3"><StatCard label="Base operativa" value="OK" detail="Supabase RPC operativo" icon={Database} tone="green"/><StatCard label="Sincronización" value={control.analytics.sync_failed ? "DEGRADADA" : "OK"} detail={control.analytics.sync_failed+" fallidas"} icon={RefreshCw} tone={control.analytics.sync_failed ? "amber":"green"}/><StatCard label="Billing" value="OK" detail={control.billing.active_subscriptions+" suscripciones"} icon={CreditCard} tone="green"/></section><section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">ALERTAS</p><h2>Incidencias que requieren atención</h2></div><AlertCircle size={17}/></div>{control.alerts.length?control.alerts.map(a=><div className="admin-table-list-row" key={a.type+a.company_id}><div><strong>{a.title}</strong><small>{a.company_name||"Plataforma"} · {a.detail}</small></div><span className={"admin-status admin-status--"+(a.severity==="critical"?"red":"amber")}><span/>{a.severity}</span></div>):<EmptyPanel title="Todo estable" description="No se detectaron alertas en los datos consultados."/ >}</section></div>;
}

function SettingsView() {
  const [settings,setSettings] = useState<PlatformSupportSettings>({whatsapp_number:null,support_email:null,privacy_url:null});
  const [form,setForm] = useState({whatsapp_number:"",support_email:"",privacy_url:""});
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState(false);
  const [message,setMessage] = useState("");
  const [error,setError] = useState("");

  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const value=await loadSupportSettings();
      setSettings(value);
      setForm({whatsapp_number:value.whatsapp_number||"",support_email:value.support_email||"",privacy_url:value.privacy_url||""});
    } catch(err) {
      setError(err instanceof Error?err.message:"No se pudo cargar la configuración.");
    } finally { setLoading(false); }
  };

  useEffect(()=>{void refresh()},[]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setMessage(""); setError("");
    try {
      const value=await saveSupportSettings(form);
      setSettings(value);
      setForm({whatsapp_number:value.whatsapp_number||"",support_email:value.support_email||"",privacy_url:value.privacy_url||""});
      setMessage("Configuración guardada correctamente.");
    } catch(err) {
      setError(err instanceof Error?err.message:"No se pudo guardar la configuración.");
    } finally { setSaving(false); }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">CONFIGURACIÓN</p><h1>Centro de atención de PALMYRA.</h1><p>Define el canal que utilizarán todas las empresas desde el Centro de atención del CRM.</p></div>
        <span className="admin-status admin-status--green"><span/>Protegido por Supabase</span>
      </section>
      <section className="admin-panel admin-support-settings">
        <div className="admin-panel__head"><div><p className="admin-kicker">ATENCIÓN AL CLIENTE</p><h2>Canales oficiales</h2></div><Settings2 size={17}/></div>
        <form className="admin-settings-form" onSubmit={submit}>
          <label><span><Phone size={13}/>WhatsApp de atención</span><div className="admin-field-icon"><Phone size={15}/><input value={form.whatsapp_number} onChange={e=>setForm({...form,whatsapp_number:e.target.value})} placeholder="+53 5555 5555" inputMode="tel"/></div><small>Se limpiará automáticamente a formato numérico al guardar.</small></label>
          <label><span><Mail size={13}/>Correo de soporte</span><div className="admin-field-icon"><Mail size={15}/><input type="email" value={form.support_email} onChange={e=>setForm({...form,support_email:e.target.value})} placeholder="soporte@palmyra.com"/></div></label>
          <label><span><FileText size={13}/>Política y privacidad</span><div className="admin-field-icon"><ExternalLink size={15}/><input type="url" value={form.privacy_url} onChange={e=>setForm({...form,privacy_url:e.target.value})} placeholder="https://…"/></div><small>Opcional. Aparecerá como enlace oficial dentro del CRM.</small></label>
          {error?<div className="admin-settings-message admin-settings-message--error">{error}</div>:null}
          {message?<div className="admin-settings-message admin-settings-message--success">{message}</div>:null}
          <div className="admin-settings-footer"><span>{loading?"Cargando…":settings.whatsapp_number?"Canal configurado y disponible":"Sin canal configurado"}</span><Button type="submit" variant="primary" disabled={saving||loading}><Save size={14}/>{saving?"Guardando…":"Guardar cambios"}</Button></div>
        </form>
      </section>
    </div>
  );
}

function FileTextIcon(){return <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M6 2h9l3 3v17H6V2Zm8 1.5V6h3.5L14 3.5ZM8 8h8V6.5H8V8Zm0 4h8v-1.5H8V12Zm0 4h6v-1.5H8V16Z"/></svg>}

function AdminShell({
  snapshot,
  onSnapshotChange,
}: {
  snapshot: PlatformSnapshot;
  onSnapshotChange: (snapshot: PlatformSnapshot) => void;
}) {
  const [view, setView] = useState<View>("overview");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [control, setControl] = useState<PlatformControlCenter | null>(null);

  const act = async (operation: () => Promise<unknown>, successSnapshot?: boolean) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      if (successSnapshot !== false) onSnapshotChange(await loadPlatformSnapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  };

  const toggleCompany = async (company: PlatformCompany) => {
    const next = company.account_status === "suspended" ? "active" : "suspended";
    const ok = window.confirm(next === "suspended" ? `¿Suspender ${company.name}?` : `¿Reactivar ${company.name}?`);
    if (!ok) return;
    await act(() => changeCompanyStatus(company.id, next));
  };

  const approve = async (request: PlanRequest) => {
    await act(() => approveRequest(request.id));
  };

  const reject = async (request: PlanRequest) => {
    const note = window.prompt("Motivo del rechazo (opcional):", "");
    if (note === null) return;
    await act(() => rejectRequest(request.id, note));
  };

  const signOut = async () => {
    await adminSignOut();
    window.location.reload();
  };

  useEffect(() => {
    const enterpriseViews: View[] = ["sync", "audit", "analytics", "security", "health"];
    if (!enterpriseViews.includes(view)) return;
    let cancelled = false;
    setError("");
    void loadPlatformControlCenter()
      .then((value) => { if (!cancelled) setControl(value); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo cargar el centro Enterprise."); });
    return () => { cancelled = true; };
  }, [view]);
  const current = navItems.find((item) => item.id === view) || navItems[0];

  return (
    <div className="admin-app">
      <div className={`admin-mobile-drawer ${mobileOpen ? "is-open" : ""}`}>
        <button type="button" aria-label="Cerrar menú" className="admin-mobile-backdrop" onClick={() => setMobileOpen(false)} />
        <nav className="admin-sidebar admin-sidebar--mobile">
          <BrandLockup />
          <NavList current={view} onNavigate={(next) => { setView(next); setMobileOpen(false); }} />
        </nav>
      </div>

      <aside className="admin-sidebar admin-sidebar--desktop">
        <BrandLockup />
        <NavList current={view} onNavigate={setView} />
        <div className="admin-sidebar__foot">
          <div className="admin-protection"><ShieldCheck size={15} /><div><strong>Zona protegida</strong><span>Autorización en Supabase</span></div></div>
          <button type="button" onClick={() => void signOut()} className="admin-logout"><LogOut size={15} />Cerrar sesión</button>
        </div>
      </aside>

      <section className="admin-main">
        <header className="admin-topbar">
          <button type="button" className="admin-menu-button" aria-label="Abrir menú" onClick={() => setMobileOpen(true)}><Menu size={18} /></button>
          <div><div className="admin-breadcrumb">PALMYRA ADMIN <ChevronRight size={13} /> {current.label}</div><span className="admin-topbar-hint">{current.hint}</span></div>
          <div className="admin-topbar__actions">
            <span className="admin-live"><i />Sistema operativo</span>
            <button type="button" aria-label="Actualizar" onClick={() => void act(() => Promise.resolve(), true)} disabled={busy} className="admin-square-button"><RefreshCw size={15} className={busy ? "spin" : ""} /></button>
          </div>
        </header>

        {error ? <div className="admin-global-error"><AlertCircle size={16} />{error}<button type="button" onClick={() => setError("")}>×</button></div> : null}

        <main className="admin-page">
          <AnimatePresence mode="wait">
            <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {view === "overview" ? <Overview snapshot={snapshot} onRefresh={async () => onSnapshotChange(await loadPlatformSnapshot())} /> :
                view === "companies" ? <CompaniesView companies={control?.companies?.length ? control.companies : snapshot.companies} busy={busy} onToggle={(company) => void toggleCompany(company)} /> :
                view === "billing" ? <BillingView requests={snapshot.requests} busy={busy} onApprove={(r) => void approve(r)} onReject={(r) => void reject(r)} /> :
                view === "exchange" ? <ExchangeRateView /> :
                view === "support" ? <SupportView /> :
                view === "sync" ? <EnterpriseDataView mode="sync" control={control} /> :
                view === "audit" ? <EnterpriseDataView mode="audit" control={control} /> :
                view === "analytics" ? <EnterpriseDataView mode="analytics" control={control} /> :
                view === "security" ? <EnterpriseDataView mode="security" control={control} /> :
                view === "health" ? <EnterpriseDataView mode="health" control={control} /> :
                view === "infrastructure" ? <InfrastructureView /> :
                view === "settings" ? <SettingsView /> :
                <div className="admin-placeholder"><div className="admin-placeholder__icon"><Shield size={24}/></div><p className="admin-eyebrow">PRÓXIMAMENTE</p><h1>{current.label}</h1><p>Área preparada para ampliar el control de plataforma sobre el mismo núcleo seguro.</p></div>}
            </motion.div>
          </AnimatePresence>
        </main>
      </section>
    </div>
  );
}

function BrandLockup() {
  return (
    <div className="admin-brand">
      <img src="/palmyra-mark-exact.svg" alt="" />
      <div><strong>PALMYRA</strong><span>CONTROL CENTER</span></div>
    </div>
  );
}

function NavList({ current, onNavigate }: { current: View; onNavigate: (view: View) => void }) {
  return (
    <div className="admin-nav">
      {navItems.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" onClick={() => onNavigate(id)} className={current === id ? "is-active" : ""}>
          <Icon size={16} /><span>{label}</span>{current === id ? <i /> : null}
        </button>
      ))}
    </div>
  );
}

export default function AdminApp() {
  const [booting, setBooting] = useState(true);
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);

  const authenticateExistingSession = async () => {
    try {
      await adminUser();
      setSnapshot(await loadPlatformSnapshot());
    } catch {
      await adminSignOut().catch(() => undefined);
      setSnapshot(null);
    } finally {
      setBooting(false);
    }
  };

  useEffect(() => {
    void authenticateExistingSession();
    const { data } = getAdminSupabase().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") setSnapshot(null);
      if (event === "SIGNED_IN") void authenticateExistingSession();
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (booting) {
    return <main className="admin-auth admin-auth--boot"><div className="admin-brand-mark admin-brand-mark--pulse"><span>✦</span></div><p>Validando sesión administrativa…</p></main>;
  }

  if (!snapshot) {
    return <LoginScreen onAuthenticated={setSnapshot} />;
  }

  return <AdminErrorBoundary><AdminShell snapshot={snapshot} onSnapshotChange={setSnapshot} /></AdminErrorBoundary>;
}
