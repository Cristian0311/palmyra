import { useMemo } from "react";
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Building2,
  CalendarClock,
  Check,
  CircleDollarSign,
  CreditCard,
  RefreshCw,
  ShieldCheck,
  TicketCheck,
  Users,
  Wallet,
} from "lucide-react";
import type { PlatformSnapshot } from "../platformAdminApi";
import { Button, EmptyPanel, StatCard, formatDate, formatMoney, statusLabel } from "../shared";

type Shortcut = { id: "companies" | "users" | "billing" | "support" | "audit"; label: string; hint: string; icon: typeof BarChart3 };

const SHORTCUTS: Shortcut[] = [
  { id: "companies", label: "Empresas", hint: "Planes, estados y fichas", icon: Building2 },
  { id: "users", label: "Usuarios", hint: "Directorio y membresías", icon: Users },
  { id: "support", label: "Soporte", hint: "Bandeja y estados", icon: TicketCheck },
  { id: "billing", label: "Planes y pagos", hint: "Aprobaciones y cobros", icon: CreditCard },
  { id: "audit", label: "Auditoría", hint: "Historial administrativo", icon: ShieldCheck },
];

export default function Overview({
  snapshot,
  onRefresh,
  onNavigate,
}: {
  snapshot: PlatformSnapshot;
  onRefresh: () => Promise<void>;
  onNavigate: (view: Shortcut["id"]) => void;
}) {
  const overview = snapshot.overview || ({} as PlatformSnapshot["overview"]);

  const latest = useMemo(
    () => [...snapshot.companies].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 5),
    [snapshot.companies],
  );

  const topUsage = useMemo(
    () => [...snapshot.companies]
      .map((company) => ({
        company,
        signal: Number(company.products || 0) + Number(company.employees || 0) * 2 + Number(company.warehouses || 0) * 3,
      }))
      .sort((a, b) => b.signal - a.signal)
      .slice(0, 5),
    [snapshot.companies],
  );

  const paidPlans = snapshot.companies.filter((company) => ["starter", "growth", "pro"].includes(String(company.plan_code || "")) && ["active", "trialing"].includes(String(company.plan_status || ""))).length;

  const statusRows = [
    { label: "Activas", value: overview.companies_active ?? 0, tone: "green" },
    { label: "En configuración", value: overview.companies_setup ?? 0, tone: "violet" },
    { label: "Pago pendiente", value: overview.companies_pending_payment ?? 0, tone: "amber" },
    { label: "Suspendidas", value: overview.companies_suspended ?? 0, tone: "red" },
  ];
  const statusTotal = Math.max(1, overview.companies_total ?? snapshot.companies.length);

  const priorities = [
    { count: overview.pending_plan_requests || 0, text: "solicitud(es) de plan esperando aprobación", view: "billing" as const },
    { count: overview.expiring_7d || 0, text: "plan(es) pagados vencen en los próximos 7 días", view: "companies" as const },
    { count: (overview.support_open || 0) + (overview.support_in_progress || 0), text: "ticket(s) de soporte sin resolver", view: "support" as const },
    { count: overview.open_invoices || 0, text: `factura(s) abiertas por ${formatMoney(overview.open_invoice_amount, "USD")}`, view: "billing" as const },
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
        <StatCard label="MRR estimado" value={formatMoney(overview.mrr_usd, "USD")} detail={`${paidPlans} plan(es) de pago vigentes`} icon={CircleDollarSign} tone="green" />
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
          <div className="admin-panel__head"><div><p className="admin-kicker">CARTERA</p><h2>Empresas por estado de cuenta</h2></div><BarChart3 size={17} /></div>
          <div className="admin-status-bars">
            {statusRows.map((row) => (
              <button key={row.label} type="button" onClick={() => onNavigate("companies")} className="admin-status-bar">
                <span className="admin-status-bar__label">{row.label}</span>
                <span className="admin-status-bar__track"><i className={`is-${row.tone}`} style={{ width: `${Math.max(row.value > 0 ? 4 : 0, Math.round((row.value / statusTotal) * 100))}%` }} /></span>
                <strong>{row.value}</strong>
              </button>
            ))}
          </div>
          <p className="admin-form-hint">Total: {overview.companies_total ?? snapshot.companies.length} empresa(s) · {overview.users_total ?? 0} usuario(s) registrados en la plataforma.</p>
        </div>

        <div className="admin-panel admin-panel--dark">
          <div className="admin-panel__head"><div><p className="admin-kicker">CONTROL</p><h2>Requiere tu atención</h2></div><ShieldCheck size={17} /></div>
          <div className="admin-rules">
            {priorities.map((item) => (
              <button key={item.text} type="button" className={item.count > 0 ? "is-alert" : ""} onClick={() => onNavigate(item.view)}>
                {item.count > 0 ? <AlertCircle size={14} /> : <Check size={14} />}
                <span><strong>{item.count}</strong> {item.text}</span>
                <ArrowRight size={13} className="admin-rules__arrow" />
              </button>
            ))}
          </div>
          <p className="admin-rules__foot">Las acciones sensibles quedan registradas en <strong>Auditoría</strong> con el operador y la empresa afectada.</p>
        </div>
      </section>

      <section className="admin-grid-2">
        <div className="admin-panel">
          <div className="admin-panel__head"><div><p className="admin-kicker">OPERACIÓN</p><h2>Empresas con más actividad</h2></div><ArrowUpRight size={17} /></div>
          <div className="admin-timeline">
            {topUsage.map(({ company }) => (
              <button key={company.id} type="button" className="admin-timeline__item admin-timeline__item--button" onClick={() => onNavigate("companies")}>
                <span className="admin-timeline__dot" />
                <div>
                  <strong>{company.name}</strong>
                  <span>{company.plan_name || "Sin plan"} · {company.products ?? 0} productos · {company.employees ?? 0} usuarios · {company.warehouses ?? 0} almacenes</span>
                </div>
                <ArrowRight size={13} />
              </button>
            ))}
            {topUsage.length === 0 ? <EmptyPanel title="Todavía no hay empresas visibles" description="Cuando exista una cuenta aparecerá aquí con su consumo." /> : null}
          </div>
        </div>

        <div className="admin-panel">
          <div className="admin-panel__head"><div><p className="admin-kicker">ACCESOS</p><h2>Atajos de operación</h2></div><ArrowRight size={17} /></div>
          <div className="admin-shortcut-grid">
            {SHORTCUTS.map(({ id, label, hint, icon: Icon }) => (
              <button key={id} type="button" className="admin-shortcut" onClick={() => onNavigate(id)}>
                <span className="admin-icon-box"><Icon size={15} /></span>
                <span><strong>{label}</strong><small>{hint}</small></span>
                <ArrowRight size={13} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">ALTAS</p><h2>Empresas más recientes</h2></div><ArrowUpRight size={17} /></div>
        <div className="admin-timeline">
          {latest.map((company) => (
            <div key={company.id} className="admin-timeline__item">
              <span className="admin-timeline__dot" />
              <div><strong>{company.name}</strong><span>{company.plan_name || "Sin plan"} · cuenta {statusLabel(company.account_status).toLowerCase()} · {formatDate(company.created_at)}</span></div>
            </div>
          ))}
          {latest.length === 0 ? <EmptyPanel title="Todavía no hay empresas visibles" description="Cuando exista una cuenta aparecerá aquí con su plan y estado." /> : null}
        </div>
      </section>
    </div>
  );
}
