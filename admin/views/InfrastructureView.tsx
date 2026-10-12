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

export default function InfrastructureView() {
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
