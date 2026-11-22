import { lazy, Suspense, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity, AlertCircle, BarChart3, Building2, ChevronRight, CreditCard, LogOut, Menu, RefreshCw, Settings2, ShieldCheck, TicketCheck, Users } from "lucide-react";
import { adminErrorMessage, loadPlatformSnapshot, type PlatformSnapshot } from "./platformAdminApi";
import { adminSignOut } from "./supabase";
import AdminNotifications from "./adminNotifications";

type View = "overview" | "companies" | "users" | "billing" | "support" | "audit" | "settings";

type NavItem = { id: View; label: string; icon: typeof BarChart3; hint: string };

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Operación",
    items: [
      { id: "overview", label: "Dashboard", icon: BarChart3, hint: "Estado global de PALMYRA" },
      { id: "companies", label: "Empresas", icon: Building2, hint: "Clientes, planes y estados" },
      { id: "users", label: "Usuarios", icon: Users, hint: "Directorio de personas" },
    ],
  },
  {
    label: "Negocio",
    items: [
      { id: "billing", label: "Planes y pagos", icon: CreditCard, hint: "Solicitudes, cobros y catálogo" },
      { id: "support", label: "Soporte", icon: TicketCheck, hint: "Bandeja de atención" },
    ],
  },
  {
    label: "Sistema",
    items: [
      { id: "audit", label: "Auditoría", icon: Activity, hint: "Acciones administrativas" },
      { id: "settings", label: "Configuración", icon: Settings2, hint: "Canales y sistema" },
    ],
  },
];

const navItems = navGroups.flatMap((group) => group.items);

const Overview = lazy(() => import("./views/Overview"));
const CompaniesView = lazy(() => import("./views/CompaniesView"));
const UsersView = lazy(() => import("./views/UsersView"));
const BillingView = lazy(() => import("./views/BillingView"));
const SupportView = lazy(() => import("./views/SupportView"));
const AuditView = lazy(() => import("./views/AuditView"));
const SettingsView = lazy(() => import("./views/SettingsView"));

function viewFromHash(): View {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return navItems.some((item) => item.id === raw) ? (raw as View) : "overview";
}

export default function AdminShell({
  snapshot,
  onSnapshotChange,
}: {
  snapshot: PlatformSnapshot;
  onSnapshotChange: (snapshot: PlatformSnapshot) => void;
}) {
  const [view, setView] = useState<View>(viewFromHash);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setView(viewFromHash());
    window.addEventListener("hashchange", sync);
    if (!window.location.hash) window.history.replaceState(null, "", "#/overview");
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = (next: View) => {
    setMobileOpen(false);
    if (viewFromHash() === next) setView(next);
    else window.location.hash = `#/${next}`;
  };

  const refresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      onSnapshotChange(await loadPlatformSnapshot());
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  const signOut = async () => {
    await adminSignOut();
    window.location.reload();
  };

  const current = navItems.find((item) => item.id === view) || navItems[0];
  const badges: Partial<Record<View, number>> = {
    companies: snapshot.overview?.companies_suspended || 0,
    billing: snapshot.overview?.pending_plan_requests ?? snapshot.requests.length,
    support: (snapshot.overview?.support_open || 0) + (snapshot.overview?.support_in_progress || 0),
  };

  return (
    <div className="admin-app">
      <div className={`admin-mobile-drawer ${mobileOpen ? "is-open" : ""}`}>
        <button type="button" aria-label="Cerrar menú" className="admin-mobile-backdrop" onClick={() => setMobileOpen(false)} />
        <nav className="admin-sidebar admin-sidebar--mobile" aria-label="Navegación administrativa">
          <BrandLockup />
          <NavList current={view} onNavigate={navigate} badges={badges} />
          <div className="admin-sidebar__foot">
            <div className="admin-protection"><ShieldCheck size={15} /><div><strong>Zona protegida</strong><span>Autorización en Supabase</span></div></div>
            <button type="button" onClick={() => void signOut()} className="admin-logout"><LogOut size={15} />Cerrar sesión</button>
          </div>
        </nav>
      </div>

      <aside className="admin-sidebar admin-sidebar--desktop">
        <BrandLockup />
        <NavList current={view} onNavigate={navigate} badges={badges} />
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
            <AdminNotifications />
            <button type="button" aria-label="Actualizar datos" onClick={() => void refresh()} disabled={refreshing} className="admin-square-button"><RefreshCw size={15} className={refreshing ? "spin" : ""} /></button>
          </div>
        </header>

        {error ? <div className="admin-global-error" role="alert"><AlertCircle size={16} />{error}<button type="button" aria-label="Descartar error" onClick={() => setError("")}>×</button></div> : null}

        <main className="admin-page">
          <Suspense fallback={<div className="admin-empty">Cargando área…</div>}>
          <AnimatePresence mode="wait">
            <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {view === "overview" ? <Overview snapshot={snapshot} onRefresh={refresh} onNavigate={navigate} /> :
                view === "companies" ? <CompaniesView companies={snapshot.companies} onChanged={refresh} /> :
                view === "users" ? <UsersView /> :
                view === "billing" ? <BillingView onChanged={refresh} /> :
                view === "support" ? <SupportView onChanged={refresh} /> :
                view === "audit" ? <AuditView /> :
                <SettingsView />}
            </motion.div>
          </AnimatePresence>
          </Suspense>
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

function NavList({ current, onNavigate, badges }: { current: View; onNavigate: (view: View) => void; badges: Partial<Record<View, number>> }) {
  return (
    <div className="admin-nav">
      {navGroups.map((group) => (
        <div key={group.label} className="admin-nav__group">
          <p className="admin-nav__group-label">{group.label}</p>
          {group.items.map(({ id, label, icon: Icon, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              className={current === id ? "is-active" : ""}
              aria-current={current === id ? "page" : undefined}
              title={hint}
            >
              <Icon size={16} className="admin-nav__icon" />
              <span className="admin-nav__text"><strong>{label}</strong><small>{hint}</small></span>
              {badges[id] ? <b className="admin-nav__badge" aria-label={`${badges[id]} pendientes`}>{badges[id]}</b> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
