import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Building2, CreditCard, Headphones, LayoutDashboard, LifeBuoy, Loader2, RefreshCw, ScrollText, Settings2, ShieldAlert, UsersRound, X,
} from "lucide-react";
import {
  loadPlatformAdminSnapshot, loadPlatformUsage, platformAdminError,
  type PlatformSupportRequest, type PlatformSupportSettings,
} from "../services/platformAdmin";
import { loadPlatformOverview, loadPlatformPlans, type PlatformOverview, type PlatformPlan } from "../services/platformAdminConsole";
import { useStore } from "../store/useStore";
import { useDocumentScrollPage } from "../hooks/useDocumentScrollPage";
import OverviewPanel from "../components/platformAdmin/OverviewPanel";
import CompaniesPanel from "../components/platformAdmin/CompaniesPanel";
import UsersPanel from "../components/platformAdmin/UsersPanel";
import PaymentsPanel from "../components/platformAdmin/PaymentsPanel";
import SupportPanel from "../components/platformAdmin/SupportPanel";
import AuditPanel from "../components/platformAdmin/AuditPanel";
import SettingsPanel from "../components/platformAdmin/SettingsPanel";
import type { AdminContext, AdminTab, CompanyLite, PlanRequestLite } from "../components/platformAdmin/types";
import { DEFAULT_FACEBOOK_URL } from "../services/platformSupport";

const TABS: Array<{ id: AdminTab; label: string; icon: typeof Building2 }> = [
  { id: "resumen", label: "Resumen", icon: LayoutDashboard },
  { id: "empresas", label: "Empresas", icon: Building2 },
  { id: "usuarios", label: "Usuarios", icon: UsersRound },
  { id: "planes", label: "Planes y cobros", icon: CreditCard },
  { id: "soporte", label: "Soporte", icon: LifeBuoy },
  { id: "auditoria", label: "Auditoría", icon: ScrollText },
  { id: "ajustes", label: "Ajustes", icon: Settings2 },
];

const EMPTY_SUPPORT: PlatformSupportSettings = {
  whatsapp_number: null, support_email: null, privacy_url: null,
  facebook_url: DEFAULT_FACEBOOK_URL, whatsapp_channel_url: null,
};

export default function PlatformAdmin() {
  useDocumentScrollPage();
  const navigate = useNavigate();
  const { addNotification } = useStore();
  const [tab, setTab] = useState<AdminTab>("resumen");
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [fatal, setFatal] = useState("");
  const [actionError, setActionError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [companies, setCompanies] = useState<CompanyLite[]>([]);
  const [requests, setRequests] = useState<PlanRequestLite[]>([]);
  const [supportRequests, setSupportRequests] = useState<PlatformSupportRequest[]>([]);
  const [supportSettings, setSupportSettings] = useState<PlatformSupportSettings>(EMPTY_SUPPORT);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [plans, setPlans] = useState<PlatformPlan[]>([]);
  const [usage, setUsage] = useState<Record<string, any> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setBooting(true);
    try {
      const [snapshot, overviewData, planList, usageData] = await Promise.all([
        loadPlatformAdminSnapshot(),
        loadPlatformOverview().catch(() => null),
        loadPlatformPlans().catch(() => [] as PlatformPlan[]),
        loadPlatformUsage().catch(() => null),
      ]);
      setCompanies((snapshot.companies || []) as CompanyLite[]);
      setRequests((snapshot.requests || []) as PlanRequestLite[]);
      setSupportRequests((snapshot.supportRequests || []) as PlatformSupportRequest[]);
      setSupportSettings({ ...EMPTY_SUPPORT, ...(snapshot.supportSettings || {}) });
      setOverview(overviewData);
      setPlans(planList);
      setUsage(usageData);
      setFatal("");
      setUpdatedAt(new Date());
    } catch (error) {
      setFatal(platformAdminError(error));
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const refresh = useCallback(async () => {
    await load(true);
    setVersion((value) => value + 1);
    setUpdatedAt(new Date());
  }, [load]);

  const run = useCallback(async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setActionError("");
    try {
      await fn();
      await load(true);
      setVersion((value) => value + 1);
      addNotification(message, "success");
    } catch (error) {
      setActionError(platformAdminError(error));
    } finally {
      setBusy(false);
    }
  }, [addNotification, load]);

  const pendingCount = requests.filter((request) => request.status === "pending").length;
  const openSupport = supportRequests.filter((request) => request.status === "open" || request.status === "in_progress").length;
  const lastUpdate = updatedAt ? new Intl.DateTimeFormat("es-CU", { hour: "2-digit", minute: "2-digit" }).format(updatedAt) : "—";

  const ctx: AdminContext = useMemo(() => ({
    busy, version, companies, plans, overview, usage,
    pendingRequests: requests, supportSettings,
    goTo: setTab, run, refresh,
  }), [busy, version, companies, plans, overview, usage, requests, supportSettings, run, refresh]);

  if (booting) {
    return (
      <div className="palmyra-scroll-page flex min-h-screen items-center justify-center bg-primary p-6">
        <div className="text-center">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-violet-600" />
          <p className="mt-3 text-xs font-black text-muted">Cargando administración de PALMYRA…</p>
        </div>
      </div>
    );
  }

  if (fatal && companies.length === 0) {
    return (
      <div className="palmyra-scroll-page flex min-h-screen items-center justify-center bg-primary p-5">
        <div className="w-full max-w-md rounded-3xl border border-base bg-secondary p-7 text-center">
          <ShieldAlert className="mx-auto h-9 w-9 text-rose-500" />
          <h1 className="mt-3 text-lg font-black text-primary">Acceso restringido</h1>
          <p className="mt-2 text-xs leading-5 text-muted">{fatal}</p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button type="button" onClick={() => void load(false)} className="h-10 rounded-xl bg-violet-600 px-4 text-xs font-black text-white">Reintentar</button>
            <button type="button" onClick={() => navigate("/")} className="h-10 rounded-xl border border-base px-4 text-xs font-black text-primary">Volver al CRM</button>
          </div>
        </div>
      </div>
    );
  }

  const badgeFor = (id: AdminTab) => {
    if (id === "planes" && pendingCount > 0) return pendingCount;
    if (id === "soporte" && openSupport > 0) return openSupport;
    return null;
  };

  return (
    <div className="palmyra-scroll-page min-h-screen bg-primary pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      <div className="mx-auto w-full max-w-6xl px-3 pt-3 sm:px-5 sm:pt-5">
        <header className="rounded-3xl border border-base bg-secondary p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#5B2DBA] to-[#8B63E6] text-base font-black text-white shadow-sm">P</span>
              <div>
                <p className="text-[9px] font-black uppercase tracking-[.2em] text-violet-600">Plataforma · PALMYRA</p>
                <h1 className="mt-0.5 text-xl font-black leading-tight text-primary sm:text-2xl">Consola administrativa</h1>
                <p className="mt-0.5 text-[11px] leading-5 text-muted">Empresas, usuarios, planes, cobros y soporte en un solo lugar. Actualizado {lastUpdate}.</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => navigate("/")} className="flex h-9 items-center gap-1.5 rounded-xl border border-base px-3 text-[10px] font-black text-primary">
                <ArrowLeft className="h-3.5 w-3.5" />CRM
              </button>
              <button type="button" onClick={() => void refresh()} disabled={busy} className="flex h-9 items-center gap-1.5 rounded-xl bg-violet-600 px-3 text-[10px] font-black text-white disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />Actualizar
              </button>
            </div>
          </div>

          <nav className="mt-4 flex gap-1 overflow-x-auto pb-1" aria-label="Secciones de administración">
            {TABS.map(({ id, label, icon: Icon }) => {
              const badge = badgeFor(id);
              const active = tab === id;
              return (
                <button key={id} type="button" onClick={() => setTab(id)} aria-current={active ? "page" : undefined}
                  className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[10px] font-black transition ${active ? "bg-violet-600 text-white shadow-sm" : "bg-subtle text-muted hover:text-primary"}`}>
                  <Icon className="h-3.5 w-3.5" />{label}
                  {badge ? <span className={`rounded-full px-1.5 py-0.5 text-[8px] ${active ? "bg-white/25 text-white" : "bg-amber-100 text-amber-800"}`}>{badge}</span> : null}
                </button>
              );
            })}
          </nav>
        </header>

        {actionError ? (
          <div className="mt-3 flex items-start justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11px] font-bold text-rose-700" role="alert">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError("")} aria-label="Cerrar aviso" className="shrink-0"><X className="h-3.5 w-3.5" /></button>
          </div>
        ) : null}

        <main className="mt-3 sm:mt-4">
          {tab === "resumen" ? <OverviewPanel ctx={ctx} /> : null}
          {tab === "empresas" ? <CompaniesPanel ctx={ctx} /> : null}
          {tab === "usuarios" ? <UsersPanel ctx={ctx} /> : null}
          {tab === "planes" ? <PaymentsPanel ctx={ctx} /> : null}
          {tab === "soporte" ? <SupportPanel ctx={ctx} /> : null}
          {tab === "auditoria" ? <AuditPanel ctx={ctx} /> : null}
          {tab === "ajustes" ? <SettingsPanel ctx={ctx} /> : null}
        </main>

        <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 text-[9px] font-bold text-muted">
          <span className="flex items-center gap-1"><Headphones className="h-3 w-3" />Consola reservada al equipo de plataforma.</span>
          <span>PALMYRA · {companies.length} empresa(s) monitoreada(s)</span>
        </footer>
      </div>
    </div>
  );
}
