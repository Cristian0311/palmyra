import { lazy, Suspense, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity, AlertCircle, BarChart3, Building2, ChevronRight, CreditCard, LogOut, Menu, RefreshCw, Settings2, ShieldCheck, TicketCheck } from "lucide-react";
import { adminErrorMessage, loadPlatformSnapshot, type PlatformSnapshot } from "./platformAdminApi";
import { adminSignOut } from "./supabase";

type View = "overview" | "companies" | "billing" | "support" | "audit" | "settings";

const navItems: Array<{ id: View; label: string; icon: typeof BarChart3; hint: string }> = [
  { id: "overview", label: "Dashboard", icon: BarChart3, hint: "Estado global de PALMYRA" },
  { id: "companies", label: "Empresas", icon: Building2, hint: "Clientes, planes y estados" },
  { id: "billing", label: "Planes y pagos", icon: CreditCard, hint: "Solicitudes, aprobaciones y cobros" },
  { id: "support", label: "Soporte", icon: TicketCheck, hint: "Atención operativa" },
  { id: "audit", label: "Auditoría", icon: Activity, hint: "Acciones administrativas registradas" },
  { id: "settings", label: "Configuración", icon: Settings2, hint: "Canales oficiales de atención" },
];

const Overview = lazy(() => import("./views/Overview"));
const CompaniesView = lazy(() => import("./views/CompaniesView"));
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
    billing: snapshot.overview?.pending_plan_requests ?? snapshot.requests.length,
    support: (snapshot.overview?.support_open || 0) + (snapshot.overview?.support_in_progress || 0),
  };

  return (
    <div className="admin-app">
      <div className={`admin-mobile-drawer ${mobileOpen ? "is-open" : ""}`}>
        <button type="button" aria-label="Cerrar menú" className="admin-mobile-backdrop" onClick={() => setMobileOpen(false)} />
        <nav className="admin-sidebar admin-sidebar--mobile">
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
            <button type="button" aria-label="Actualizar" onClick={() => void refresh()} disabled={refreshing} className="admin-square-button"><RefreshCw size={15} className={refreshing ? "spin" : ""} /></button>
          </div>
        </header>

        {error ? <div className="admin-global-error"><AlertCircle size={16} />{error}<button type="button" onClick={() => setError("")}>×</button></div> : null}

        <main className="admin-page">
          <Suspense fallback={<div className="admin-empty">Cargando área…</div>}>
          <AnimatePresence mode="wait">
            <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {view === "overview" ? <Overview snapshot={snapshot} onRefresh={refresh} /> :
                view === "companies" ? <CompaniesView companies={snapshot.companies} onChanged={refresh} /> :
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
      {navItems.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" onClick={() => onNavigate(id)} className={current === id ? "is-active" : ""}>
          <Icon size={16} /><span>{label}</span>
          {badges[id] ? <b className="admin-nav__badge">{badges[id]}</b> : current === id ? <i /> : null}
        </button>
      ))}
    </div>
  );
}
