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

export default function EnterpriseDataView({ mode, control }: { mode: "sync"|"audit"|"analytics"|"security"|"health"; control: PlatformControlCenter|null }) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const [infra, setInfra] = useState<InfrastructureUsage | null>(null);
  const [infraError, setInfraError] = useState("");
  useEffect(() => {
    if (mode !== "security" && mode !== "health") return;
    let cancelled = false;
    setInfraError("");
    void loadInfrastructureUsage().then(value => { if (!cancelled) setInfra(value); }).catch(err => {
      if (!cancelled) setInfraError(err instanceof Error ? err.message : "No se pudo consultar infraestructura.");
    });
    return () => { cancelled = true; };
  }, [mode]);
  if (!control) return <div className="admin-empty"><RefreshCw size={18} className="spin"/><h3>Cargando datos Enterprise…</h3><p>Consultando Supabase con datos reales.</p></div>;
  if (mode === "sync") return <div className="admin-content-stack">
    <section className="admin-page-head"><div><p className="admin-eyebrow">SINCRONIZACIÓN</p><h1>Centro de sincronización.</h1><p>Cola, errores y conflictos reales del SaaS.</p></div><span className="admin-mini-badge">{control.analytics.sync_pending} pendientes · {control.analytics.sync_failed} fallidas</span></section>
    <section className="admin-grid-3"><StatCard label="Pendientes" value={control.analytics.sync_pending} detail="Operaciones en cola" icon={RefreshCw}/><StatCard label="Fallidas" value={control.analytics.sync_failed} detail="Requieren diagnóstico" icon={AlertCircle} tone="amber"/><StatCard label="Conflictos" value={control.analytics.conflicts_open} detail="Sin resolución" icon={XCircle} tone="slate"/></section>
    <section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">ÚLTIMAS OPERACIONES</p><h2>Cola del servidor</h2></div><RefreshCw size={17}/></div>
      <div className="admin-request-list">{control.sync.map(item=><article className="admin-request-row" key={item.id}><div className="admin-request-main"><div className="admin-company-avatar admin-company-avatar--small">{item.company_name.slice(0,1).toUpperCase()}</div><div><strong>{item.company_name}</strong><span>{item.operation} · {item.entity_type} · {item.entity_id}</span><span>{formatDate(item.created_at)}</span></div></div><div className="admin-request-price"><strong>{item.status}</strong><span>{item.attempts} intentos</span></div><div className="admin-request-actions">{item.last_error?<><span className="admin-status admin-status--red"><span/>Error</span><Button variant="secondary" disabled={retrying===item.id} onClick={() => {
        setRetrying(item.id);
        void retryPlatformSyncItem(item.id).then(() => window.location.reload()).catch(err => window.alert(err instanceof Error ? err.message : "No se pudo reprogramar la sincronización.")).finally(() => setRetrying(null));
      }}><RefreshCw size={12}/>{retrying===item.id ? "Reprogramando…" : "Reintentar"}</Button></>:<span className="admin-status admin-status--green"><span/>OK</span>}</div></article>)}</div>
      {!control.sync.length?<EmptyPanel title="Cola limpia" description="No hay operaciones en la cola del servidor."/>:null}
    </section>
    <section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">CONFLICTOS</p><h2>Sin resolver</h2></div><XCircle size={17}/></div>{control.conflicts.length?<div className="admin-table-list">{control.conflicts.map(c=><div className="admin-table-list-row" key={c.id}><div><strong>{c.company_name} · {c.entity_type}</strong><small>{c.operation_id} · {formatDate(c.created_at)}</small></div><b>{c.entity_id}</b></div>)}</div>:<EmptyPanel title="Sin conflictos" description="No existen conflictos abiertos en Supabase."/>}</section>
  </div>;

  if (mode === "audit") return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">AUDITORÍA ENTERPRISE</p><h1>Trazabilidad completa.</h1><p>Acciones registradas por empresa, usuario, entidad y momento.</p></div><span className="admin-mini-badge">{control.audit.length} eventos recientes</span></section><section className="admin-panel"><div className="admin-table-list">{control.audit.map(a=><div className="admin-table-list-row" key={a.id}><div><strong>{a.action} · {a.entity_type}</strong><small>{a.company_name||"Plataforma"} · {a.user_id||"Sistema"} · {formatDate(a.created_at)}</small></div><b>{a.entity_id||"—"}</b></div>)}</div>{!control.audit.length?<EmptyPanel title="Sin eventos" description="No hay registros de auditoría disponibles."/>:null}</section></div>;

  if (mode === "analytics") return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">ANALYTICS</p><h1>Uso real del SaaS.</h1><p>Métricas agregadas directamente desde las tablas operativas de Supabase.</p></div></section><section className="admin-stat-grid"><StatCard label="Empresas" value={control.analytics.companies_total} detail={control.analytics.companies_active+" activas"} icon={Building2}/><StatCard label="Usuarios" value={control.analytics.users_total} detail="Membresías activas" icon={Users}/><StatCard label="Productos" value={control.analytics.products_total} detail="Registrados" icon={Package}/><StatCard label="Ventas" value={control.analytics.sales_total} detail={control.analytics.sales_30d+" en 30 días"} icon={ShoppingCart} tone="green"/><StatCard label="Ventas 30d" value={control.analytics.sales_value_30d.toLocaleString("es-CU")} detail="Valor acumulado" icon={CircleDollarSign} tone="green"/><StatCard label="MRR" value={control.billing.mrr.toLocaleString("es-CU")} detail="Suscripciones activas/prueba" icon={CreditCard}/></section><section className="admin-grid-2"><div className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">BILLING</p><h2>Estado financiero</h2></div><CreditCard size={17}/></div><div className="admin-grid-2 admin-infra-real-grid"><div className="admin-mini-panel"><h3>Suscripciones</h3><strong className="admin-overview-number">{control.billing.active_subscriptions}</strong><p>activas/prueba</p></div><div className="admin-mini-panel"><h3>Facturas pendientes</h3><strong className="admin-overview-number">{control.billing.pending_invoices}</strong><p>{control.billing.pending_amount.toLocaleString("es-CU")} por cobrar</p></div><div className="admin-mini-panel"><h3>Pagos 30d</h3><strong className="admin-overview-number">{control.billing.payments_30d}</strong><p>{control.billing.paid_amount_30d.toLocaleString("es-CU")} cobrados</p></div></div></div><div className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">ALERTAS</p><h2>Prioridades</h2></div><AlertCircle size={17}/></div>{control.alerts.slice(0,8).map(a=><div className="admin-table-list-row" key={a.type+a.company_id}><div><strong>{a.title}</strong><small>{a.company_name||"Plataforma"} · {a.detail}</small></div><span className={"admin-status admin-status--"+(a.severity==="critical"?"red":"amber")}><span/>{a.severity}</span></div>)}</div></section></div>;

  if (mode === "security") return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">SEGURIDAD</p><h1>Controles de acceso y señales.</h1><p>La autorización del panel depende de Supabase y de la tabla de administradores de plataforma.</p></div><span className="admin-status admin-status--green"><span/>RPC protegido</span></section><section className="admin-grid-3"><StatCard label="Eventos auditados" value={control.audit.length} detail="Últimos registros" icon={ShieldCheck}/><StatCard label="Alertas críticas" value={control.alerts.filter(a=>a.severity==="critical").length} detail="Requieren revisión" icon={AlertCircle} tone="amber"/><StatCard label="Conflictos" value={control.analytics.conflicts_open} detail="Bloqueos de sincronización" icon={XCircle} tone="slate"/></section>
    <section className="admin-grid-3"><StatCard label="Render" value={infra?.render.configured ? (infra.render.error ? "ATENCIÓN" : "CONECTADO") : "NO CONFIGURADO"} detail={infra?.render.error || "API de Render disponible"} icon={Activity} tone={infra?.render.error ? "amber" : "green"}/><StatCard label="Supabase" value={infra?.supabase.configured ? (infra.supabase.error ? "ATENCIÓN" : "CONECTADO") : "NO CONFIGURADO"} detail={infra?.supabase.error || "RPC y métricas disponibles"} icon={Database} tone={infra?.supabase.error ? "amber" : "green"}/><StatCard label="Gestión API" value={infra?.providerSources.supabaseManagement === "not_configured" ? "PENDIENTE" : "CONECTADA"} detail={infra?.providerSources.supabaseManagement === "not_configured" ? "Falta token de Management API" : "Métricas de gestión disponibles"} icon={LockKeyhole} tone={infra?.providerSources.supabaseManagement === "not_configured" ? "amber" : "green"}/></section>
    {infraError ? <div className="admin-alert admin-alert--error"><AlertCircle size={16}/>{infraError}</div> : null}
    <section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">REGLA</p><h2>Principio de mínimo privilegio</h2></div><LockKeyhole size={17}/></div><p className="admin-panel-subtitle">El frontend no decide quién es administrador. Cada RPC Enterprise verifica auth.uid() contra public.platform_admins antes de devolver datos.</p></section></div>;

  return <div className="admin-content-stack"><section className="admin-page-head"><div><p className="admin-eyebrow">HEALTH CENTER</p><h1>Estado operativo global.</h1><p>Estado calculado con datos reales del backend y proveedores.</p></div></section><section className="admin-grid-3"><StatCard label="Base operativa" value={infra?.supabase.configured ? (infra.supabase.error ? "ATENCIÓN" : "OK") : "SIN DATO"} detail={infra?.supabase.error || "Supabase conectado"} icon={Database} tone={infra?.supabase.error ? "amber" : "green"}/><StatCard label="Sincronización" value={control.analytics.sync_failed ? "DEGRADADA" : "OK"} detail={control.analytics.sync_failed+" fallidas · "+control.analytics.sync_pending+" pendientes"} icon={RefreshCw} tone={control.analytics.sync_failed ? "amber":"green"}/><StatCard label="Render" value={infra?.render.configured ? (infra.render.error ? "ATENCIÓN" : "OK") : "SIN DATO"} detail={infra?.render.error || (infra?.render.services.length || 0)+" servicios descubiertos"} icon={Activity} tone={infra?.render.error ? "amber" : "green"}/></section><section className="admin-panel"><div className="admin-panel__head"><div><p className="admin-kicker">ALERTAS</p><h2>Incidencias que requieren atención</h2></div><AlertCircle size={17}/></div>{control.alerts.length?control.alerts.map(a=><div className="admin-table-list-row" key={a.type+a.company_id}><div><strong>{a.title}</strong><small>{a.company_name||"Plataforma"} · {a.detail}</small></div><span className={"admin-status admin-status--"+(a.severity==="critical"?"red":"amber")}><span/>{a.severity}</span></div>):<EmptyPanel title="Todo estable" description="No se detectaron alertas en los datos consultados."/ >}</section></div>;
}
