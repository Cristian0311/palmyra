import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, CircleDollarSign, CreditCard, RefreshCw, Wallet, X } from "lucide-react";
import { approvePlanRequest, rejectPlanRequest } from "../../services/platformAdmin";
import { loadPlanRequests, loadPlatformPayments, type PlatformPayment } from "../../services/platformAdminConsole";
import type { AdminContext, PlanRequestLite } from "./types";
import { Badge, Empty, FilterTabs, Modal, Pager, SectionCard, fmtDate, fmtMoney, methodLabel, pageSlice } from "./ui";

type Filter = "pending" | "approved" | "rejected" | "cancelled" | "all";

export default function PaymentsPanel({ ctx }: { ctx: AdminContext }) {
  const { busy, run, refresh, version } = ctx;
  const [filter, setFilter] = useState<Filter>("pending");
  const [requests, setRequests] = useState<PlanRequestLite[]>([]);
  const [payments, setPayments] = useState<PlatformPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [requestPage, setRequestPage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const [approval, setApproval] = useState<{ request: PlanRequestLite; amount: string; currency: "CUP" | "USD"; reference: string; error: string } | null>(null);
  const [reject, setReject] = useState<{ request: PlanRequestLite; note: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [nextRequests, nextPayments] = await Promise.all([
        loadPlanRequests(filter),
        loadPlatformPayments(60).catch(() => [] as PlatformPayment[]),
      ]);
      setRequests(nextRequests as PlanRequestLite[]);
      setPayments(nextPayments);
    } catch (err: any) {
      setLoadError(err?.message || "No se pudieron cargar las solicitudes.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); setRequestPage(1); }, [filter, version]);

  const totals = useMemo(() => {
    const pending = requests.filter((request) => request.status === "pending");
    return {
      pending: pending.length,
      quoted: pending.reduce((sum, request) => sum + Number(request.quoted_amount ?? (Number(request.monthly_price || 0) * Number(request.billing_months || 1))), 0),
    };
  }, [requests]);

  const pagedRequests = pageSlice(requests, requestPage, 8);
  const pagedPayments = pageSlice(payments, paymentPage, 8);

  const openApproval = (request: PlanRequestLite) => {
    const methodCurrency: "CUP" | "USD" = String(request.payment_method || "").startsWith("cup_") ? "CUP" : "USD";
    const suggested = request.quoted_amount ?? (request.monthly_price != null ? Number(request.monthly_price) * (request.billing_months || 1) : null);
    setApproval({
      request,
      amount: suggested != null ? String(suggested) : "",
      currency: (request.quoted_currency as "CUP" | "USD") || methodCurrency,
      reference: "",
      error: "",
    });
  };

  const confirmApproval = async () => {
    if (!approval) return;
    const amount = Number(approval.amount);
    if (!Number.isFinite(amount) || amount <= 0) { setApproval({ ...approval, error: "Indica el importe realmente recibido." }); return; }
    if (!approval.reference.trim()) { setApproval({ ...approval, error: "La referencia o comprobante es obligatoria." }); return; }
    const current = approval;
    setApproval(null);
    await run(
      () => approvePlanRequest({ requestId: current.request.id, receivedAmount: amount, receivedCurrency: current.currency, reference: current.reference.trim() }),
      `Pago registrado. ${current.request.company_name || "La empresa"} quedó activa.`,
    );
    await load();
  };

  const confirmReject = async () => {
    if (!reject) return;
    const current = reject;
    setReject(null);
    await run(() => rejectPlanRequest(current.request.id, current.note.trim()), "Solicitud rechazada y factura abierta anulada.");
    await load();
    await refresh();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <div className="rounded-2xl border border-base bg-secondary p-3.5"><p className="text-[9px] font-black uppercase tracking-[.14em] text-muted">Pendientes</p><p className="mt-1.5 text-xl font-black text-primary">{ctx.overview?.pending_plan_requests ?? totals.pending}</p><p className="text-[9px] font-bold text-muted">Por confirmar pago</p></div>
        <div className="rounded-2xl border border-base bg-secondary p-3.5"><p className="text-[9px] font-black uppercase tracking-[.14em] text-muted">Cotizado</p><p className="mt-1.5 text-xl font-black text-primary">{fmtMoney(totals.quoted, "USD")}</p><p className="text-[9px] font-bold text-muted">En solicitudes pendientes</p></div>
        <div className="rounded-2xl border border-base bg-secondary p-3.5"><p className="text-[9px] font-black uppercase tracking-[.14em] text-muted">Pagos recientes</p><p className="mt-1.5 text-xl font-black text-primary">{payments.length}</p><p className="text-[9px] font-bold text-muted">Últimos 60 registros</p></div>
        <div className="rounded-2xl border border-base bg-secondary p-3.5"><p className="text-[9px] font-black uppercase tracking-[.14em] text-muted">Cobrado</p><p className="mt-1.5 text-xl font-black text-primary">{fmtMoney(payments.filter((p) => p.status === "paid").reduce((sum, p) => sum + Number(p.amount || 0), 0), "USD")}</p><p className="text-[9px] font-bold text-muted">En la lista cargada</p></div>
      </div>

      <SectionCard title="Solicitudes de plan" subtitle="Aprueba con el importe real y referencia obligatoria; rechaza con motivo." icon={<CreditCard className="h-4 w-4" />}
        action={<button type="button" disabled={loading} onClick={() => void load()} className="flex h-8 items-center gap-1.5 rounded-lg border border-base px-2.5 text-[10px] font-black text-primary disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar</button>}>
        <FilterTabs<Filter> value={filter} onChange={setFilter} options={[
          ["pending", "Pendientes"], ["approved", "Aprobadas"], ["rejected", "Rechazadas"], ["cancelled", "Canceladas"], ["all", "Todas"],
        ]} />
        {loadError ? <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] font-bold text-rose-700">{loadError}</div> : null}

        <div className="mt-3 space-y-2">
          {!loading && requests.length === 0 ? <Empty title="No hay solicitudes en este estado" description="Cuando una empresa solicite o renueve un plan aparecerá aquí con su cotización." /> : null}
          {pagedRequests.slice.map((request) => (
            <article key={request.id} className="rounded-2xl border border-base bg-primary p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-black text-primary">{request.company_name || "Empresa sin nombre"}</p>
                    <Badge status={request.status} />
                  </div>
                  <p className="mt-0.5 text-[10px] font-bold text-muted">{request.plan_name || "Plan"} · {request.billing_months || 1} mes(es) · {methodLabel(request.payment_method)}</p>
                  <p className="mt-0.5 text-[10px] font-bold text-muted">{request.contact_phone || request.owner_email || "Sin contacto"} · {fmtDate(request.requested_at)}</p>
                  {request.note ? <p className="mt-1 text-[10px] italic text-muted">«{request.note}»</p> : null}
                </div>
                <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-end">
                  <div className="text-right">
                    <p className="text-sm font-black text-primary">{fmtMoney(request.quoted_amount ?? (request.monthly_price != null ? Number(request.monthly_price) * (request.billing_months || 1) : null), request.quoted_currency || "USD")}</p>
                    <p className="text-[9px] font-bold text-muted">cotización</p>
                  </div>
                  {request.status === "pending" ? (
                    <div className="flex gap-1.5">
                      <button type="button" disabled={busy} onClick={() => openApproval(request)} className="flex h-9 items-center gap-1 rounded-xl bg-emerald-600 px-2.5 text-[10px] font-black text-white disabled:opacity-50"><Check className="h-3.5 w-3.5" />Aprobar</button>
                      <button type="button" disabled={busy} onClick={() => setReject({ request, note: "" })} className="flex h-9 items-center gap-1 rounded-xl border border-base px-2.5 text-[10px] font-black text-primary disabled:opacity-50"><X className="h-3.5 w-3.5" />Rechazar</button>
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
        <div className="mt-3"><Pager page={pagedRequests.page} pages={pagedRequests.pages} total={pagedRequests.total} onPage={setRequestPage} /></div>
      </SectionCard>

      <SectionCard title="Pagos registrados" subtitle="Últimas confirmaciones manuales con su referencia." icon={<Wallet className="h-4 w-4" />}>
        {payments.length === 0 ? <Empty title="Todavía no hay pagos" description="Cada aprobación registra un pago con referencia y moneda." /> : (
          <div className="divide-y divide-[color:var(--border-base)] overflow-hidden rounded-2xl border border-base">
            {pagedPayments.slice.map((payment) => (
              <div key={payment.id} className="flex items-center justify-between gap-2 bg-primary px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-black text-primary">{payment.company_name}</p>
                  <p className="truncate text-[10px] font-bold text-muted">{methodLabel(payment.payment_method)} · {fmtDate(payment.paid_at || payment.created_at)}</p>
                  <p className="truncate text-[9px] font-bold text-muted">{payment.manual_reference || payment.reference || "Sin referencia"}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-black text-primary">{fmtMoney(payment.amount, payment.currency)}</p>
                  <Badge status={payment.status} />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3"><Pager page={pagedPayments.page} pages={pagedPayments.pages} total={pagedPayments.total} onPage={setPaymentPage} /></div>
      </SectionCard>

      <SectionCard title="Catálogo de planes" subtitle="Precios y límites vigentes en la base de datos; así cotiza el registro y la solicitud de extensión." icon={<CircleDollarSign className="h-4 w-4" />}>
        {ctx.plans.length === 0 ? <Empty title="Sin planes cargados" description="Aplica la actualización de planes para que el catálogo esté disponible." /> : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {ctx.plans.map((plan) => {
              const limits = plan.limits || {};
              return (
                <article key={plan.id} className="rounded-2xl border border-base bg-primary p-3">
                  <div className="flex items-center justify-between gap-1.5">
                    <p className="text-xs font-black text-primary">{plan.name}</p>
                    <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-black uppercase ${plan.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{plan.active ? "Activo" : "Inactivo"}</span>
                  </div>
                  <p className="mt-1.5 text-lg font-black text-primary">{Number(plan.monthly_price || 0) === 0 ? "Gratis" : fmtMoney(plan.monthly_price, plan.currency || "USD")}</p>
                  <p className="text-[9px] font-bold text-muted">{Number(plan.monthly_price || 0) === 0 ? "para siempre" : "por mes"}</p>
                  <ul className="mt-2 space-y-0.5 text-[9px] font-bold text-muted">
                    <li>Almacenes: {String(limits.warehouses ?? "—")}</li>
                    <li>Productos: {String(limits.products ?? "—")}</li>
                    <li>Empleados: {String(limits.employees ?? "—")}</li>
                  </ul>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>

      <div className="grid gap-2.5 sm:grid-cols-3">
        {[
          { Icon: CircleDollarSign, title: "CUP y USD", text: "Se confirma el importe realmente recibido, sin conversiones automáticas." },
          { Icon: CreditCard, title: "Renovación acumulativa", text: "Mismo plan: los meses se suman desde el vencimiento actual." },
          { Icon: AlertCircle, title: "Trazabilidad", text: "Cada aprobación crea factura pagada, pago y entrada en Auditoría." },
        ].map(({ Icon, title, text }) => (
          <div key={title} className="rounded-2xl border border-base bg-secondary p-3.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-subtle text-violet-600"><Icon className="h-4 w-4" /></span>
            <p className="mt-2 text-[11px] font-black text-primary">{title}</p>
            <p className="mt-0.5 text-[10px] leading-5 text-muted">{text}</p>
          </div>
        ))}
      </div>

      {approval ? (
        <Modal title={`Aprobar pago · ${approval.request.company_name || "Empresa"}`}
          description={`${approval.request.plan_name || "Plan"} · ${approval.request.billing_months || 1} mes(es) · ${methodLabel(approval.request.payment_method)}`}
          onClose={() => { if (!busy) setApproval(null); }}
          footer={<>
            <button type="button" disabled={busy} onClick={() => setApproval(null)} className="h-10 rounded-xl border border-base px-4 text-xs font-black text-primary">Cancelar</button>
            <button type="button" disabled={busy} onClick={() => void confirmApproval()} className="h-10 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white disabled:opacity-50">{busy ? "Activando…" : "Confirmar y activar"}</button>
          </>}>
          <p className="text-[11px] leading-5 text-muted">Cotización registrada: <strong className="text-primary">{fmtMoney(approval.request.quoted_amount ?? (approval.request.monthly_price != null ? Number(approval.request.monthly_price) * (approval.request.billing_months || 1) : null), approval.request.quoted_currency || "USD")}</strong>. En USD el importe recibido no puede ser menor; en CUP se acepta el monto acordado.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="text-[9px] font-black uppercase text-muted">Importe recibido
              <input type="number" min="0" step="0.01" inputMode="decimal" value={approval.amount} onChange={(e) => setApproval({ ...approval, amount: e.target.value, error: "" })} autoFocus className="mt-1 h-10 w-full rounded-xl border border-base bg-primary px-2.5 text-sm font-bold text-primary" />
            </label>
            <label className="text-[9px] font-black uppercase text-muted">Moneda
              <select value={approval.currency} onChange={(e) => setApproval({ ...approval, currency: e.target.value as "CUP" | "USD" })} className="mt-1 h-10 w-full rounded-xl border border-base bg-primary px-2.5 text-sm font-bold text-primary">
                <option value="USD">USD</option><option value="CUP">CUP</option>
              </select>
            </label>
            <label className="text-[9px] font-black uppercase text-muted sm:col-span-2">Referencia o comprobante
              <input value={approval.reference} onChange={(e) => setApproval({ ...approval, reference: e.target.value, error: "" })} placeholder="Nro. de transferencia, recibo…" className="mt-1 h-10 w-full rounded-xl border border-base bg-primary px-2.5 text-sm font-bold text-primary" />
            </label>
          </div>
          {approval.error ? <p className="mt-2 rounded-lg bg-rose-50 p-2 text-[10px] font-bold text-rose-700">{approval.error}</p> : null}
        </Modal>
      ) : null}

      {reject ? (
        <Modal title={`Rechazar solicitud · ${reject.request.company_name || "Empresa"}`} description="La factura abierta quedará anulada y la empresa podrá enviar una nueva solicitud."
          onClose={() => { if (!busy) setReject(null); }}
          footer={<>
            <button type="button" disabled={busy} onClick={() => setReject(null)} className="h-10 rounded-xl border border-base px-4 text-xs font-black text-primary">Cancelar</button>
            <button type="button" disabled={busy} onClick={() => void confirmReject()} className="h-10 rounded-xl bg-rose-600 px-4 text-xs font-black text-white disabled:opacity-50">{busy ? "Rechazando…" : "Rechazar solicitud"}</button>
          </>}>
          <label className="text-[9px] font-black uppercase text-muted">Motivo (se guarda en la solicitud)
            <textarea value={reject.note} onChange={(e) => setReject({ ...reject, note: e.target.value })} rows={3} placeholder="Ej.: el comprobante no coincide con el importe." className="mt-1 w-full rounded-xl border border-base bg-primary p-2.5 text-xs font-bold text-primary" />
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
