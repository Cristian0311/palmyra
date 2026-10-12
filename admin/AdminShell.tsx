import { lazy, Suspense, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity, AlertCircle, BarChart3, Building2, ChevronRight, CreditCard, LogOut, Menu, RefreshCw, Settings2, Shield, ShieldCheck, TicketCheck } from "lucide-react";
import { approveRequest, changeCompanyStatus, loadPlatformSnapshot, rejectRequest, type PlanRequest, type PlatformCompany, type PlatformSnapshot } from "./platformAdminApi";
import { adminSignOut } from "./supabase";
import { Button } from "./shared";

type View = "overview" | "companies" | "billing" | "support" | "audit" | "settings";

const navItems: Array<{ id: View; label: string; icon: typeof BarChart3; hint: string }> = [
  { id: "overview", label: "Dashboard", icon: BarChart3, hint: "Estado global de PALMYRA" },
  { id: "companies", label: "Empresas", icon: Building2, hint: "Clientes y cuentas" },
  { id: "billing", label: "Planes y pagos", icon: CreditCard, hint: "Solicitudes y activaciones" },
  { id: "support", label: "Soporte", icon: TicketCheck, hint: "Atención operativa" },
  { id: "audit", label: "Auditoría", icon: Activity, hint: "Acciones administrativas" },
  { id: "settings", label: "Configuración", icon: Settings2, hint: "Seguridad de la plataforma" },
];

const Overview = lazy(() => import("./views/Overview"));
const CompaniesView = lazy(() => import("./views/CompaniesView"));
const BillingView = lazy(() => import("./views/BillingView"));
const SupportView = lazy(() => import("./views/SupportView"));
const SettingsView = lazy(() => import("./views/SettingsView"));

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
          <Suspense fallback={<div className="admin-empty">Cargando área…</div>}>
          <AnimatePresence mode="wait">
            <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {view === "overview" ? <Overview snapshot={snapshot} onRefresh={async () => onSnapshotChange(await loadPlatformSnapshot())} /> :
                view === "companies" ? <CompaniesView companies={snapshot.companies} busy={busy} onToggle={(company) => void toggleCompany(company)} /> :
                view === "billing" ? <BillingView requests={snapshot.requests} busy={busy} onApprove={(r) => void approve(r)} onReject={(r) => void reject(r)} /> :
                view === "support" ? <SupportView /> :
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
