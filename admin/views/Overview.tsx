import { useMemo } from "react";
import { AlertCircle, ArrowUpRight, Building2, CalendarClock, Check, CircleDollarSign, CreditCard, RefreshCw, ShieldCheck, TicketCheck, Wallet } from "lucide-react";
import type { PlatformSnapshot } from "../platformAdminApi";
import { Button, EmptyPanel, StatCard, formatDate, formatMoney, statusLabel } from "../shared";

export default function Overview({ snapshot, onRefresh }: { snapshot: PlatformSnapshot; onRefresh: () => Promise<void> }) {
  const overview = snapshot.overview || ({} as PlatformSnapshot["overview"]);
  const latest = useMemo(
    () => [...snapshot.companies].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 6),
    [snapshot.companies],
  );

  const priorities = [
    { count: overview.pending_plan_requests || 0, text: "solicitud(es) de plan esperando aprobación" },
    { count: overview.expiring_7d || 0, text: "plan(es) pagados vencen en los próximos 7 días" },
    { count: overview.support_open || 0, text: "ticket(s) de soporte sin atender" },
    { count: overview.open_invoices || 0, text: `factura(s) abiertas por ${formatMoney(overview.open_invoice_amount, "USD")}` },
  ];

  return (
    <div className="admin-content-stack">
      <section className="admin-welcome">
        <div>
          <p className="admin-eyebrow">VISIÓN GENERAL</p>
          <h1>El estado de PALMYRA, en una sola mirada.</h1>
          <p>Cada número viene de funciones seguras en Supabase. Ninguna aprobación ni suspensión se ejecuta desde el navegador.</p>
        </div>
        <Button onClick={() => void onRefresh()} variant="secondary"><RefreshCw size={15} />Actualizar datos</Button>
      </section>

      <section className="admin-stat-grid">
        <StatCard label="Empresas" value={overview.companies_total ?? snapshot.companies.length} detail={`${overview.companies_new_30d ?? 0} nuevas en 30 días`} icon={Building2} />
        <StatCard label="MRR estimado" value={formatMoney(overview.mrr_usd, "USD")} detail="Suscripciones pagadas vigentes" icon={CircleDollarSign} tone="green" />
        <StatCard label="Solicitudes" value={overview.pending_plan_requests ?? snapshot.requests.length} detail="Pendientes de activar" icon={CreditCard} tone="amber" />
        <StatCard label="Soporte" value={overview.support_open ?? 0} detail={`${overview.support_in_progress ?? 0} en atención`} icon={TicketCheck} tone="slate" />
      </section>

      <section className="admin-stat-grid">
        <StatCard label="Activas" value={overview.companies_active ?? 0} detail={`${overview.companies_setup ?? 0} en configuración`} icon={ShieldCheck} tone="green" />
        <StatCard label="Suspendidas" value={overview.companies_suspended ?? 0} detail={`${overview.companies_pending_payment ?? 0} con pago pendiente`} icon={AlertCircle} tone="amber" />
        <StatCard label="Vencen pronto" value={overview.expiring_7d ?? 0} detail="Planes pagados en 7 días" icon={CalendarClock} tone="amber" />
        <StatCard label="Cobrado 30 días" value={formatMoney(overview.payments_30d_amount, "USD")} detail={`${overview.payments_30d_count ?? 0} pago(s) registrados`} icon={Wallet} tone="slate" />
      </section>

      <section className="admin-grid-2">
        <div className="admin-panel">
          <div className="admin-panel__head"><div><p className="admin-kicker">OPERACIÓN</p><h2>Empresas más recientes</h2></div><ArrowUpRight size={17} /></div>
          <div className="admin-timeline">
            {latest.map((company) => (
              <div key={company.id} className="admin-timeline__item">
                <span className="admin-timeline__dot" />
                <div><strong>{company.name}</strong><span>{company.plan_name || "Sin plan"} · cuenta {statusLabel(company.account_status).toLowerCase()} · {formatDate(company.created_at)}</span></div>
              </div>
            ))}
            {latest.length === 0 ? <EmptyPanel title="Todavía no hay empresas visibles" description="Cuando exista una cuenta aparecerá aquí con su plan y estado." /> : null}
          </div>
        </div>

        <div className="admin-panel admin-panel--dark">
          <div className="admin-panel__head"><div><p className="admin-kicker">CONTROL</p><h2>Requiere tu atención</h2></div><ShieldCheck size={17} /></div>
          <div className="admin-rules">
            {priorities.map((item) => (
              <div key={item.text} className={item.count > 0 ? "is-alert" : ""}>
                {item.count > 0 ? <AlertCircle size={14} /> : <Check size={14} />}
                <span><strong>{item.count}</strong> {item.text}</span>
              </div>
            ))}
          </div>
          <p className="admin-rules__foot">Las acciones sensibles quedan registradas en <strong>Auditoría</strong> con el operador y la empresa afectada.</p>
        </div>
      </section>
    </div>
  );
}
