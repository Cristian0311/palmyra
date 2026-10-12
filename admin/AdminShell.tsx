import { lazy, Suspense, useEffect, useState } from "react";
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
} from "./platformAdminApi";
import { adminSignIn, adminSignOut, adminUser, getAdminSupabase } from "./supabase";
import { Button, StatCard, StatusBadge, EmptyPanel, formatDate, statusLabel, isToday, FileTextIcon } from "./shared";

const Overview = lazy(() => import("./views/Overview"));
const CompaniesView = lazy(() => import("./views/CompaniesView"));
const BillingView = lazy(() => import("./views/BillingView"));
const ExchangeRateView = lazy(() => import("./views/ExchangeRateView"));
const SupportView = lazy(() => import("./views/SupportView"));
const InfrastructureView = lazy(() => import("./views/InfrastructureView"));
const EnterpriseDataView = lazy(() => import("./views/EnterpriseDataView"));
const SettingsView = lazy(() => import("./views/SettingsView"));

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

export default function AdminShell({
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
          <Suspense fallback={<div className="admin-empty">Cargando sección…</div>}>
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
