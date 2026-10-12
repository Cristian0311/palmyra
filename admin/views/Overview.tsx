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

export default function Overview({ snapshot, onRefresh }: { snapshot: PlatformSnapshot; onRefresh: () => Promise<void> }) {
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
