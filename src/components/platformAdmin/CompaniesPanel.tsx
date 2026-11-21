import { useEffect, useMemo, useState } from "react";
import { Ban, CalendarClock, Check, ChevronRight, Package, Store, Users, Warehouse } from "lucide-react";
import { setPlatformCompanyStatus } from "../../services/platformAdmin";
import { assignPlatformCompanyPlan, loadPlatformCompanyDetail, type PlatformCompanyDetail, type PlatformPlan } from "../../services/platformAdminConsole";
import type { AdminContext, CompanyLite, PlanRequestLite } from "./types";
import { Badge, ConfirmDialog, Empty, FilterTabs, Modal, Pager, SearchBox, SectionCard, fmtDate, fmtDay, fmtMoney, methodLabel, pageSlice, statusLabel } from "./ui";

type Sort = "recent" | "name" | "expiry";

export default function CompaniesPanel({ ctx }: { ctx: AdminContext }) {
  const { companies, plans, busy, run, refresh } = ctx;
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "suspended" | "pending_payment" | "setup">("all");
  const [plan, setPlan] = useState("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CompanyLite | null>(null);
  const [confirm, setConfirm] = useState<{ company: CompanyLite; next: "active" | "suspended" } | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = companies.filter((company) => {
      const matchesQ = !needle || [company.name, company.slug, company.plan_name, company.id].some((value) => String(value || "").toLowerCase().includes(needle));
      const matchesStatus = status === "all" || String(company.account_status || "") === status;
      const matchesPlan = plan === "all" || (plan === "none" ? !company.plan_code : company.plan_code === plan);
      return matchesQ && matchesStatus && matchesPlan;
    });
    return items.sort((a, b) => {
      if (sort === "name") return String(a.name || "").localeCompare(String(b.name || ""), "es");
      if (sort === "expiry") {
        const aValue = a.period_end ? new Date(a.period_end).getTime() : Number.MAX_SAFE_INTEGER;
        const bValue = b.period_end ? new Date(b.period_end).getTime() : Number.MAX_SAFE_INTEGER;
        return aValue - bValue;
      }
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
  }, [companies, q, status, plan, sort]);

  const paged = pageSlice(filtered, page, 9);

  useEffect(() => { setPage(1); }, [q, status, plan, sort]);

  const toggle = async () => {
    if (!confirm) return;
    const { company, next } = confirm;
    await run(
      () => setPlatformCompanyStatus(company.id, next),
      next === "suspended" ? `${company.name} suspendida.` : `${company.name} reactivada.`,
    );
    setConfirm(null);
  };

  return (
    <div className="space-y-4">
      <SectionCard title="Directorio de empresas" subtitle="Busca, filtra y abre la ficha completa de cada cuenta." icon={<Store className="h-4 w-4" />}
        action={<span className="rounded-full bg-subtle px-2.5 py-1 text-[10px] font-black text-muted">{companies.length} cuenta(s)</span>}>
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
          <SearchBox value={q} onChange={setQ} placeholder="Buscar por nombre, slug, plan o ID…" />
          <div className="flex flex-wrap items-center gap-2">
            <FilterTabs<"all" | "active" | "suspended" | "pending_payment" | "setup"> value={status} onChange={setStatus} options={[
              ["all", "Todas"], ["active", "Activas"], ["suspended", "Suspendidas"], ["pending_payment", "Pago pendiente"], ["setup", "Configuración"],
            ]} />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] font-bold text-muted">
            Plan
            <select value={plan} onChange={(e) => setPlan(e.target.value)} className="h-8 rounded-lg border border-base bg-primary px-2 text-[10px] font-black text-primary">
              <option value="all">Todos</option>
              {plans.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              <option value="none">Sin plan</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] font-bold text-muted">
            Orden
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8 rounded-lg border border-base bg-primary px-2 text-[10px] font-black text-primary">
              <option value="recent">Más recientes</option>
              <option value="name">Nombre A–Z</option>
              <option value="expiry">Vencimiento próximo</option>
            </select>
          </label>
          <span className="ml-auto text-[10px] font-bold text-muted">{filtered.length} resultado(s)</span>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {paged.slice.map((company) => (
            <article key={company.id} className="flex flex-col rounded-2xl border border-base bg-primary p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-sm font-black text-white">{String(company.name || "?").slice(0, 1).toUpperCase()}</span>
                  <div className="min-w-0">
                    <h3 className="truncate text-xs font-black text-primary">{company.name}</h3>
                    <p className="truncate text-[10px] font-bold text-muted">{company.slug || company.id.slice(0, 8)}</p>
                  </div>
                </div>
                <Badge status={company.account_status} />
              </div>

              <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-subtle px-2.5 py-1.5">
                <span className="truncate text-[10px] font-black text-violet-700">{company.plan_name || "Sin plan"}</span>
                <span className="shrink-0 text-[9px] font-bold text-muted">
                  {company.plan_code === "free" ? "Sin vencimiento" : company.period_end ? `Vence ${fmtDay(company.period_end)}` : statusLabel(company.plan_status)}
                </span>
              </div>

              <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-center">
                {[[company.products, "Productos"], [company.employees, "Equipo"], [company.warehouses, "Almacenes"]].map(([value, label]) => (
                  <div key={String(label)} className="rounded-lg border border-base px-1 py-1.5">
                    <p className="text-xs font-black text-primary">{value ?? "—"}</p>
                    <p className="text-[8px] font-bold uppercase tracking-wide text-muted">{label}</p>
                  </div>
                ))}
              </div>

              <p className="mt-2 text-[9px] font-bold text-muted">Creada {fmtDay(company.created_at)}</p>

              <div className="mt-2.5 flex gap-1.5">
                <button type="button" onClick={() => setSelected(company)} className="flex h-9 flex-1 items-center justify-center gap-1 rounded-xl bg-violet-600 text-[10px] font-black text-white">Detalle <ChevronRight className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={busy} onClick={() => setConfirm({ company, next: company.account_status === "suspended" ? "active" : "suspended" })}
                  className="flex h-9 items-center justify-center gap-1 rounded-xl border border-base px-2.5 text-[10px] font-black text-primary disabled:opacity-50">
                  {company.account_status === "suspended" ? <Check className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                  {company.account_status === "suspended" ? "Reactivar" : "Suspender"}
                </button>
              </div>
            </article>
          ))}
        </div>

        {filtered.length === 0 ? <div className="mt-3"><Empty title="No encontramos esa empresa" description="Prueba con otro nombre, plan, estado o slug." /></div> : null}
        <div className="mt-3"><Pager page={paged.page} pages={paged.pages} total={paged.total} onPage={setPage} /></div>
      </SectionCard>

      {selected ? <CompanyDetailModal company={selected} plans={plans} onClose={() => setSelected(null)} onChanged={refresh} /> : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.next === "suspended" ? "Suspender empresa" : "Reactivar empresa"}
          tone={confirm.next === "suspended" ? "danger" : "primary"}
          confirmLabel={confirm.next === "suspended" ? "Suspender acceso" : "Reactivar acceso"}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void toggle()}
          body={<>
            <p><strong className="text-primary">{confirm.company.name}</strong> {confirm.next === "suspended" ? "no podrá iniciar sesión ni sincronizar hasta que la reactives." : "recuperará el acceso y la sincronización."}</p>
            <p className="mt-2">La acción queda registrada en Auditoría con tu usuario.</p>
          </>}
        />
      ) : null}
    </div>
  );
}

function CompanyDetailModal({ company, plans, onClose, onChanged }: { company: CompanyLite; plans: PlatformPlan[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<PlatformCompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [planCode, setPlanCode] = useState(company.plan_code || "starter");
  const [months, setMonths] = useState(1);
  const [note, setNote] = useState("");
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await loadPlatformCompanyDetail(company.id);
      setDetail(next);
      setPlanCode(next.subscription?.plan_code || company.plan_code || "starter");
    } catch (err: any) {
      setError(err?.message || "No se pudo cargar la ficha.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [company.id]);

  const apply = async () => {
    setApplying(true);
    setError("");
    try {
      const result = await assignPlatformCompanyPlan(company.id, planCode, months, note);
      setMessage(`${result.plan_name} asignado${result.current_period_end ? ` hasta ${fmtDay(result.current_period_end)}` : " sin vencimiento"}.`);
      setStep("form");
      setNote("");
      await load();
      await onChanged();
    } catch (err: any) {
      setError(err?.message || "No se pudo asignar el plan.");
      setStep("form");
    } finally {
      setApplying(false);
    }
  };

  const selectedPlan = plans.find((item) => item.code === planCode);
  const subscription = detail?.subscription;

  return (
    <Modal title={company.name} description="Suscripción, capacidad y movimientos de facturación." onClose={onClose} wide
      footer={<><button type="button" onClick={onClose} className="h-10 rounded-xl border border-base px-4 text-xs font-black text-primary">Cerrar</button></>}>
      {loading ? <p className="text-xs font-bold text-muted">Cargando ficha…</p> : null}
      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] font-bold text-rose-700">{error}</div> : null}
      {message ? <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-[11px] font-bold text-emerald-800">{message}</div> : null}

      {detail ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-base bg-primary p-3.5">
              <p className="text-[9px] font-black uppercase tracking-[.16em] text-violet-600">Suscripción</p>
              <h3 className="mt-1 text-sm font-black text-primary">{subscription?.plan_name || "Sin plan"}</h3>
              <dl className="mt-2 space-y-1 text-[11px]">
                {[
                  ["Estado", statusLabel(subscription?.status)],
                  ["Precio", `${fmtMoney(subscription?.monthly_price, "USD")}/mes`],
                  ["Vigencia", subscription?.current_period_end ? fmtDay(subscription.current_period_end) : "Sin vencimiento"],
                  ["Cuenta", statusLabel(detail.company.account_status)],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-center justify-between gap-2"><dt className="text-muted">{label}</dt><dd className="font-black text-primary">{value}</dd></div>
                ))}
              </dl>
            </div>
            <div className="rounded-2xl border border-base bg-primary p-3.5">
              <p className="text-[9px] font-black uppercase tracking-[.16em] text-violet-600">Capacidad instalada</p>
              <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
                {[[detail.counts.products, "Productos", <Package className="mx-auto h-3.5 w-3.5" key="p" />], [detail.counts.employees, "Equipo", <Users className="mx-auto h-3.5 w-3.5" key="e" />], [detail.counts.warehouses, "Almacenes", <Warehouse className="mx-auto h-3.5 w-3.5" key="w" />]].map(([value, label, icon]) => (
                  <div key={String(label)} className="rounded-lg border border-base px-1.5 py-2">
                    <span className="text-muted">{icon as any}</span>
                    <p className="mt-1 text-sm font-black text-primary">{value as number}</p>
                    <p className="text-[8px] font-bold uppercase text-muted">{label as string}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] font-bold text-muted">Moneda: {detail.company.currency || "—"} · Creada {fmtDay(detail.company.created_at)}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-violet-200 bg-violet-50/40 p-3.5 dark:border-violet-500/30 dark:bg-violet-500/5">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[11px] font-black text-primary"><CalendarClock className="h-4 w-4 text-violet-600" />Asignar o extender plan</p>
              <span className="text-[9px] font-bold text-muted">Cada cambio queda auditado</span>
            </div>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-[1.4fr_.8fr_1.4fr_auto]">
              <label className="text-[9px] font-black uppercase text-muted">Plan
                <select value={planCode} onChange={(e) => setPlanCode(e.target.value)} className="mt-1 h-9 w-full rounded-xl border border-base bg-secondary px-2 text-[11px] font-black text-primary">
                  {plans.map((item) => <option key={item.code} value={item.code}>{item.name} · {fmtMoney(item.monthly_price, "USD")}/mes</option>)}
                </select>
              </label>
              <label className="text-[9px] font-black uppercase text-muted">Duración
                <select value={months} disabled={planCode === "free"} onChange={(e) => setMonths(Number(e.target.value))} className="mt-1 h-9 w-full rounded-xl border border-base bg-secondary px-2 text-[11px] font-black text-primary disabled:opacity-50">
                  {[1, 3, 6, 12].map((value) => <option key={value} value={value}>{value} mes(es)</option>)}
                </select>
              </label>
              <label className="text-[9px] font-black uppercase text-muted">Nota interna
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pago recibido, acuerdo…" className="mt-1 h-9 w-full rounded-xl border border-base bg-secondary px-2 text-[11px] font-bold text-primary" />
              </label>
              <button type="button" disabled={applying || !selectedPlan} onClick={() => setStep("confirm")} className="mt-4 h-9 rounded-xl bg-violet-600 px-3 text-[10px] font-black text-white disabled:opacity-50 self-start">Asignar</button>
            </div>
            <p className="mt-1.5 text-[9px] leading-4 text-muted">Mismo plan: extiende desde el vencimiento actual. Plan distinto: reinicia el período. Anula solicitudes y facturas abiertas.</p>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <HistoryBlock title="Solicitudes" empty="Sin solicitudes." items={detail.requests.map((request: PlanRequestLite) => ({
              key: request.id, title: request.plan_name || request.plan_code || "Plan", meta: `${request.billing_months || 1} mes(es) · ${fmtDate(request.requested_at)}`, status: request.status, amount: fmtMoney(request.quoted_amount, request.quoted_currency || "USD"),
            }))} />
            <HistoryBlock title="Facturas" empty="Sin facturas." items={detail.invoices.map((invoice) => ({
              key: `${invoice.invoice_number}-${invoice.created_at}`, title: invoice.invoice_number, meta: fmtDate(invoice.created_at), status: invoice.status, amount: fmtMoney(invoice.amount, invoice.currency),
            }))} />
            <HistoryBlock title="Pagos" empty="Sin pagos." items={detail.payments.map((payment) => ({
              key: payment.id, title: fmtMoney(payment.amount, payment.currency), meta: `${methodLabel(payment.payment_method)} · ${fmtDate(payment.paid_at || payment.created_at)}`, status: payment.status, amount: payment.reference || "Sin referencia",
            }))} />
          </div>
        </div>
      ) : null}

      {step === "confirm" && selectedPlan ? (
        <ConfirmDialog
          title="Confirmar cambio de plan"
          confirmLabel={applying ? "Aplicando…" : "Confirmar plan"}
          busy={applying}
          onCancel={() => setStep("form")}
          onConfirm={() => void apply()}
          body={<>
            <p><strong className="text-primary">{company.name}</strong> pasará a <strong className="text-primary">{selectedPlan.name}</strong> {planCode === "free" ? "sin vencimiento" : `por ${months} mes(es)`}.</p>
            <p className="mt-2">Se cancelarán solicitudes pendientes y se anularán facturas abiertas de esta empresa.</p>
          </>}
        />
      ) : null}
    </Modal>
  );
}

function HistoryBlock({ title, empty, items }: { title: string; empty: string; items: Array<{ key: string; title: string; meta: string; status: string; amount: string }> }) {
  return (
    <div className="rounded-2xl border border-base bg-primary p-3">
      <p className="text-[9px] font-black uppercase tracking-[.16em] text-muted">{title}</p>
      {items.length === 0 ? <p className="mt-2 text-[10px] font-bold text-muted">{empty}</p> : (
        <div className="mt-1.5 divide-y divide-[color:var(--border-base)]">
          {items.slice(0, 6).map((item) => (
            <div key={item.key} className="flex items-start justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <p className="truncate text-[10px] font-black text-primary">{item.title}</p>
                <p className="truncate text-[9px] font-bold text-muted">{item.meta}</p>
              </div>
              <div className="shrink-0 text-right">
                <Badge status={item.status} />
                <p className="mt-0.5 max-w-[92px] truncate text-[9px] font-bold text-muted">{item.amount}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
