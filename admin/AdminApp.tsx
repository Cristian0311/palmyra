import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  approveRequest,
  changeCompanyStatus,
  loadPlatformSnapshot,
  rejectRequest,
  type PlanRequest,
  type PlatformCompany,
  type PlatformSnapshot,
} from "./platformAdminApi";
import { adminSignIn, adminSignOut, adminUser, getAdminSupabase } from "./supabase";
import "./admin.css";

type View = "overview" | "companies" | "billing" | "support" | "audit" | "settings";

const navItems: Array<{ id: View; label: string; icon: typeof BarChart3; hint: string }> = [
  { id: "overview", label: "Dashboard", icon: BarChart3, hint: "Estado global de PALMYRA" },
  { id: "companies", label: "Empresas", icon: Building2, hint: "Clientes y cuentas" },
  { id: "billing", label: "Planes y pagos", icon: CreditCard, hint: "Solicitudes y activaciones" },
  { id: "support", label: "Soporte", icon: TicketCheck, hint: "Atención operativa" },
  { id: "audit", label: "Auditoría", icon: Activity, hint: "Acciones administrativas" },
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
    return { total: companies.length, active, suspended, today, requests: snapshot.requests.length };
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
}: {
  company: PlatformCompany;
  busy: boolean;
  onToggle: (company: PlatformCompany) => void;
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
      </div>
      <div className="admin-company-card__metrics">
        <div><strong>{company.products ?? "—"}</strong><span>Productos</span></div>
        <div><strong>{company.employees ?? "—"}</strong><span>Usuarios</span></div>
        <div><strong>{company.warehouses ?? "—"}</strong><span>Almacenes</span></div>
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

  return (
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
        {filtered.map((company) => <CompanyCard key={company.id} company={company} busy={busy} onToggle={onToggle} />)}
        {filtered.length === 0 ? <EmptyPanel title="No encontramos esa empresa" description="Prueba con otro nombre, slug o estado." /> : null}
      </section>
    </div>
  );
}

function BillingView({
  requests,
  busy,
  onApprove,
  onReject,
}: {
  requests: PlanRequest[];
  busy: boolean;
  onApprove: (request: PlanRequest) => void;
  onReject: (request: PlanRequest) => void;
}) {
  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">PLANES Y PAGOS</p><h1>Monetización con revisión humana.</h1><p>Esta primera consola reutiliza las solicitudes de plan ya protegidas. Las tablas de facturación ampliadas se añadirán sobre este núcleo, no duplicando datos.</p></div>
        <div className="admin-page-count"><strong>{requests.length}</strong><span>pendientes</span></div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>Activaciones pendientes</h2></div><Clock3 size={17} /></div>
        {requests.length ? (
          <div className="admin-request-list">
            {requests.map((request) => (
              <article key={request.id} className="admin-request-row">
                <div className="admin-request-main">
                  <div className="admin-company-avatar admin-company-avatar--small">{String(request.company_name || "?").slice(0, 1).toUpperCase()}</div>
                  <div><strong>{request.company_name || "Empresa sin nombre"}</strong><span>{request.plan_name || "Plan"} · {formatDate(request.requested_at)}</span></div>
                </div>
                <div className="admin-request-price">
                  <strong>{request.monthly_price != null ? `$ ${Number(request.monthly_price).toFixed(2)}` : "—"}</strong>
                  <span>{request.payment_method || "Pago manual"}</span>
                </div>
                <div className="admin-request-actions">
                  <Button disabled={busy} variant="primary" onClick={() => onApprove(request)}><Check size={14} />Aprobar</Button>
                  <Button disabled={busy} variant="secondary" onClick={() => onReject(request)}><X size={14} />Rechazar</Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyPanel title="No hay solicitudes pendientes" description="Cuando llegue una nueva solicitud aparecerá aquí con su empresa, plan y método de pago." />
        )}
      </section>

      <section className="admin-grid-3">
        {[
          [CircleDollarSign, "Pagos manuales", "Listo para efectivo y transferencia. El registro definitivo seguirá viviendo en Supabase.", "En núcleo"],
          [CreditCard, "Planes", "Los planes se mantienen centralizados para que CRM y Admin no terminen con precios distintos.", "Preparado"],
          [Activity, "Historial", "Las aprobaciones y rechazos deben auditarse para conservar trazabilidad.", "Preparado"],
        ].map(([Icon, title, text, badge]) => {
          const I = Icon as typeof CircleDollarSign;
          return <div className="admin-mini-panel" key={String(title)}><span className="admin-icon-box"><I size={15} /></span><h3>{title as string}</h3><p>{text as string}</p><span className="admin-mini-badge">{badge as string}</span></div>;
        })}
      </section>
    </div>
  );
}

function PlaceholderView({ view }: { view: View }) {
  const meta: Record<View, { eyebrow: string; title: string; copy: string; icon: typeof Activity }> = {
    overview: { eyebrow: "DASHBOARD", title: "Dashboard", copy: "Vista general.", icon: BarChart3 },
    companies: { eyebrow: "EMPRESAS", title: "Empresas", copy: "Gestión de cuentas.", icon: Building2 },
    billing: { eyebrow: "PLANES", title: "Planes y pagos", copy: "Gestión comercial.", icon: CreditCard },
    support: { eyebrow: "SOPORTE", title: "Centro de soporte", copy: "Sesiones temporales y trazabilidad.", icon: TicketCheck },
    audit: { eyebrow: "AUDITORÍA", title: "Auditoría administrativa", copy: "Registro de acciones críticas.", icon: Activity },
    settings: { eyebrow: "CONFIGURACIÓN", title: "Configuración", copy: "Seguridad y operación de la plataforma.", icon: Settings2 },
  };
  const m = meta[view];
  const Icon = m.icon;
  return <div className="admin-placeholder"><div className="admin-placeholder__icon"><Icon size={24} /></div><p className="admin-eyebrow">{m.eyebrow}</p><h1>{m.title}</h1><p>{m.copy} Esta pantalla ya tiene su lugar y contrato visual; conectaremos su fuente de datos sobre el mismo núcleo seguro.</p></div>;
}

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
                view === "companies" ? <CompaniesView companies={snapshot.companies} busy={busy} onToggle={(company) => void toggleCompany(company)} /> :
                view === "billing" ? <BillingView requests={snapshot.requests} busy={busy} onApprove={(r) => void approve(r)} onReject={(r) => void reject(r)} /> :
                <PlaceholderView view={view} />}
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

  return <AdminShell snapshot={snapshot} onSnapshotChange={setSnapshot} />;
}
