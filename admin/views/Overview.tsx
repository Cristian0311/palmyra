import { useMemo } from "react";
import { AlertCircle, ArrowUpRight, Building2, Check, CreditCard, RefreshCw, ShieldCheck } from "lucide-react";
import type { PlatformSnapshot } from "../platformAdminApi";
import { Button, EmptyPanel, StatCard, formatDate, isToday } from "../shared";

export default function Overview({ snapshot, onRefresh }: { snapshot: PlatformSnapshot; onRefresh: () => Promise<void> }) {
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
