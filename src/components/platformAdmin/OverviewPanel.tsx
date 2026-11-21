import { Activity, AlertCircle, ArrowUpRight, Building2, CalendarClock, Check, CircleDollarSign, DatabaseZap, ShieldCheck, TicketCheck, UserRound, Wallet } from "lucide-react";
import type { AdminContext } from "./types";
import { Badge, Empty, Kpi, SectionCard, fmtDay, fmtMoney, statusLabel } from "./ui";

export default function OverviewPanel({ ctx }: { ctx: AdminContext }) {
  const { overview, companies, usage, pendingRequests, goTo } = ctx;
  const recent = [...companies].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 6);
  const priorities = [
    { count: overview?.pending_plan_requests ?? pendingRequests.length, text: "solicitud(es) de plan por aprobar", tab: "planes" as const },
    { count: overview?.expiring_7d ?? 0, text: "plan(es) pagados vencen en 7 días", tab: "empresas" as const },
    { count: overview?.support_open ?? 0, text: "ticket(s) de soporte sin atender", tab: "soporte" as const },
    { count: overview?.open_invoices ?? 0, text: `factura(s) abiertas por ${fmtMoney(overview?.open_invoice_amount, "USD")}`, tab: "planes" as const },
  ];

  const renderGb = Number(usage?.render?.bandwidthGb);
  const renderPct = Number.isFinite(renderGb) ? Math.min(100, (renderGb / Number(usage?.limits?.renderFreeBandwidthGb || 5)) * 100) : null;
  const dbMb = Number(usage?.supabase?.databaseMb);
  const dbPct = Number.isFinite(dbMb) ? Math.min(100, (dbMb / Number(usage?.limits?.supabaseFreeDatabaseMb || 500)) * 100) : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Kpi label="Empresas" value={overview?.companies_total ?? companies.length} detail={`${overview?.companies_new_30d ?? 0} nuevas en 30 días`} icon={<Building2 className="h-4 w-4" />} />
        <Kpi label="MRR estimado" value={fmtMoney(overview?.mrr_usd, "USD")} detail="Suscripciones pagadas vigentes" icon={<CircleDollarSign className="h-4 w-4" />} tone="green" />
        <Kpi label="Solicitudes" value={overview?.pending_plan_requests ?? pendingRequests.length} detail="Pendientes de activar" icon={<Wallet className="h-4 w-4" />} tone="amber" />
        <Kpi label="Soporte" value={overview?.support_open ?? 0} detail={`${overview?.support_in_progress ?? 0} en atención`} icon={<TicketCheck className="h-4 w-4" />} tone="slate" />
        <Kpi label="Usuarios" value={overview?.users_total ?? 0} detail="Cuentas registradas" icon={<UserRound className="h-4 w-4" />} />
        <Kpi label="Activas" value={overview?.companies_active ?? 0} detail={`${overview?.companies_setup ?? 0} en configuración`} icon={<ShieldCheck className="h-4 w-4" />} tone="green" />
        <Kpi label="Suspendidas" value={overview?.companies_suspended ?? 0} detail={`${overview?.companies_pending_payment ?? 0} con pago pendiente`} icon={<AlertCircle className="h-4 w-4" />} tone="red" />
        <Kpi label="Cobrado 30 días" value={fmtMoney(overview?.payments_30d_amount, "USD")} detail={`${overview?.payments_30d_count ?? 0} pago(s) registrados`} icon={<CalendarClock className="h-4 w-4" />} tone="amber" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
        <SectionCard title="Requiere tu atención" subtitle="Prioridad de la operación diaria" icon={<ShieldCheck className="h-4 w-4" />}>
          <div className="space-y-2">
            {priorities.map((item) => (
              <button key={item.text} type="button" onClick={() => goTo(item.tab)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-base bg-primary px-3 py-2.5 text-left transition hover:border-violet-300">
                <span className="flex items-center gap-2 text-[11px] font-bold text-muted">
                  {item.count > 0 ? <AlertCircle className="h-3.5 w-3.5 text-amber-500" /> : <Check className="h-3.5 w-3.5 text-emerald-500" />}
                  <span><strong className="text-primary">{item.count}</strong> {item.text}</span>
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted" />
              </button>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Empresas más recientes" subtitle="Últimas cuentas creadas" icon={<Building2 className="h-4 w-4" />} action={<button type="button" onClick={() => goTo("empresas")} className="text-[10px] font-black text-violet-600">Ver todas</button>}>
          {recent.length === 0 ? <Empty title="Sin empresas todavía" description="Cuando se cree una cuenta aparecerá aquí con su plan y estado." /> : (
            <div className="divide-y divide-[color:var(--border-base)]">
              {recent.map((company) => (
                <div key={company.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black text-primary">{company.name}</p>
                    <p className="truncate text-[10px] font-bold text-muted">{company.plan_name || "Sin plan"} · {statusLabel(company.account_status)} · {fmtDay(company.created_at)}</p>
                  </div>
                  <Badge status={company.account_status} />
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Consumo de infraestructura" subtitle="Render y Supabase Free, con alerta al 80 % del límite" icon={<Activity className="h-4 w-4" />}>
        {!usage ? (
          <Empty title="Consumo no disponible" description="Configura las credenciales de servidor para activar la lectura automática." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className={`rounded-2xl border p-3.5 ${renderPct !== null && renderPct >= 80 ? "border-amber-300 bg-amber-50/60" : "border-base bg-primary"}`}>
              <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-[9px] font-black uppercase text-muted"><Activity className="h-3.5 w-3.5 text-rose-500" />Render · ancho de banda</span><span className="text-[9px] font-bold text-muted">Free 5 GB/mes</span></div>
              <p className="mt-2 text-xl font-black text-primary">{renderPct !== null ? `${renderGb.toFixed(2)} GB` : "No disponible"}</p>
              {renderPct !== null ? <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full ${renderPct >= 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${renderPct}%` }} /></div> : null}
              <p className="mt-1.5 text-[9px] font-bold text-muted">{usage.render?.requests != null ? `${Number(usage.render.requests).toLocaleString("es-CU")} solicitudes HTTP` : "Seguimiento mensual"}</p>
            </div>
            <div className={`rounded-2xl border p-3.5 ${dbPct !== null && dbPct >= 80 ? "border-amber-300 bg-amber-50/60" : "border-base bg-primary"}`}>
              <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-[9px] font-black uppercase text-muted"><DatabaseZap className="h-3.5 w-3.5 text-violet-600" />Supabase · base de datos</span><span className="text-[9px] font-bold text-muted">Free 500 MB</span></div>
              <p className="mt-2 text-xl font-black text-primary">{dbPct !== null ? `${dbMb.toFixed(1)} MB` : "No disponible"}</p>
              {dbPct !== null ? <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full ${dbPct >= 80 ? "bg-amber-500" : "bg-violet-500"}`} style={{ width: `${dbPct}%` }} /></div> : null}
              <p className="mt-1.5 text-[9px] font-bold text-muted">Tamaño real de PostgreSQL</p>
            </div>
          </div>
        )}
        <p className="mt-2.5 text-[9px] leading-4 text-muted">Las credenciales viven en el servidor. Este panel nunca expone llaves en el navegador.</p>
      </SectionCard>
    </div>
  );
}
