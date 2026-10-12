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

export default function BillingView({
  requests, busy, onApprove, onReject,
}: { requests: PlanRequest[]; busy: boolean; onApprove: (request: PlanRequest) => void; onReject: (request: PlanRequest) => void; }) {
  const [plans, setPlans] = useState<PlatformPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [planError, setPlanError] = useState("");
  const [editingPlan, setEditingPlan] = useState<PlatformPlan | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const [planForm, setPlanForm] = useState({price:"0",trial:"0",products:"",employees:"",warehouses:"",active:true,features:""});

  const refreshPlans = async () => {
    setLoadingPlans(true); setPlanError("");
    try { setPlans(await loadPlatformPlans()); }
    catch (err) { setPlanError(err instanceof Error ? err.message : "No se pudieron cargar los planes."); }
    finally { setLoadingPlans(false); }
  };
  useEffect(() => { void refreshPlans(); }, []);

  const openPlanEditor = (plan: PlatformPlan) => {
    const featureData = Array.isArray(plan.features) ? plan.features : (plan.features?.features || []);
    setEditingPlan(plan);
    setPlanForm({
      price:String(plan.monthly_price ?? 0),
      trial:String(plan.trial_days ?? 0),
      products:String(plan.limits?.products ?? ""),
      employees:String(plan.limits?.employees ?? ""),
      warehouses:String(plan.limits?.warehouses ?? ""),
      active:Boolean(plan.active),
      features:featureData.join("\n")
    });
  };

  const savePlan = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingPlan) return;
    setSavingPlan(true); setPlanError("");
    try {
      await updatePlatformPlan({
        id:editingPlan.id,
        monthlyPrice:Number(planForm.price)||0,
        trialDays:Math.max(0,Number(planForm.trial)||0),
        limits:{
          products:planForm.products.trim()===""?null:Number(planForm.products),
          employees:planForm.employees.trim()===""?null:Number(planForm.employees),
          warehouses:planForm.warehouses.trim()===""?null:Number(planForm.warehouses)
        },
        features:{description:editingPlan.features && !Array.isArray(editingPlan.features) ? String(editingPlan.features.description||"") : "",features:planForm.features.split("\n").map(v=>v.trim()).filter(Boolean)},
        active:planForm.active
      });
      setEditingPlan(null);
      await refreshPlans();
    } catch(err) {
      setPlanError(err instanceof Error ? err.message : "No se pudo guardar el plan.");
    } finally { setSavingPlan(false); }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head"><div><p className="admin-eyebrow">PLANES Y PAGOS</p><h1>Planes claros, compactos y administrables.</h1><p>Catálogo real leído desde Supabase: precio, límites, funciones, periodo de prueba y empresas actualmente asociadas.</p></div><div className="admin-page-count"><strong>{plans.length}</strong><span>planes</span></div></section>
      {planError ? <div className="admin-alert admin-alert--error"><AlertCircle size={16}/>{planError}</div> : null}
      <section className="admin-plan-grid">
        {plans.map(plan => {
          const featureData = Array.isArray(plan.features) ? plan.features : (plan.features?.features || []);
          const description = Array.isArray(plan.features) ? "" : String(plan.features?.description || "");
          return <article key={plan.id} className={`admin-plan-card ${plan.active ? "" : "is-inactive"}`}>
            <div className="admin-plan-card__head"><div><span className="admin-plan-code">{plan.code}</span><h2>{plan.name}</h2></div><div className="admin-plan-card__actions"><span className={`admin-plan-status ${plan.active ? "is-active" : "is-inactive"}`}>{plan.active ? "Activo" : "Inactivo"}</span><button type="button" className="admin-plan-edit" onClick={()=>openPlanEditor(plan)} aria-label={`Editar ${plan.name}`}><Edit3 size={13}/></button></div></div>
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
      {editingPlan ? <div className="fixed inset-0 z-[250] bg-slate-950/60 backdrop-blur-sm p-3 flex items-center justify-center" onClick={()=>setEditingPlan(null)}>
        <form className="admin-plan-editor admin-panel" onSubmit={savePlan} onClick={e=>e.stopPropagation()}>
          <div className="admin-panel__head"><div><p className="admin-kicker">CATÁLOGO</p><h2>Editar {editingPlan.name}</h2><p>Los cambios afectan el catálogo futuro y quedan registrados en auditoría.</p></div><button type="button" className="admin-square-button" onClick={()=>setEditingPlan(null)}><X size={15}/></button></div>
          <div className="admin-plan-editor-grid">
            <label>Precio mensual<input type="number" min="0" step="0.01" value={planForm.price} onChange={e=>setPlanForm({...planForm,price:e.target.value})}/></label>
            <label>Días de prueba<input type="number" min="0" step="1" value={planForm.trial} onChange={e=>setPlanForm({...planForm,trial:e.target.value})}/></label>
            <label>Máx. productos<input type="number" min="0" value={planForm.products} onChange={e=>setPlanForm({...planForm,products:e.target.value})}/></label>
            <label>Máx. empleados<input type="number" min="0" value={planForm.employees} onChange={e=>setPlanForm({...planForm,employees:e.target.value})}/></label>
            <label>Máx. almacenes<input type="number" min="0" value={planForm.warehouses} onChange={e=>setPlanForm({...planForm,warehouses:e.target.value})}/></label>
            <label className="admin-plan-editor-toggle"><input type="checkbox" checked={planForm.active} onChange={e=>setPlanForm({...planForm,active:e.target.checked})}/> Plan activo</label>
          </div>
          <label className="admin-plan-editor-features">Funciones, una por línea<textarea rows={7} value={planForm.features} onChange={e=>setPlanForm({...planForm,features:e.target.value})}/></label>
          <div className="admin-settings-footer"><span>Plan: {editingPlan.code}</span><div><Button variant="secondary" onClick={()=>setEditingPlan(null)}>Cancelar</Button><Button variant="primary" type="submit" disabled={savingPlan}>{savingPlan?"Guardando…":"Guardar plan"}</Button></div></div>
        </form>
      </div> : null}
    </div>
  );
}
