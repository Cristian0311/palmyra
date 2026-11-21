import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ChevronRight, Search, XCircle } from "lucide-react";
import {
  adminErrorMessage,
  changeCompanyStatus,
  loadCompanyDetail,
  loadPlatformPlans,
  setCompanyPlan,
  type PlatformCompany,
  type PlatformCompanyDetail,
  type PlatformPlan,
} from "../platformAdminApi";
import { Button, EmptyPanel, Modal, StatusBadge, formatDate, formatDay, formatMoney, methodLabel, statusLabel } from "../shared";

function CompanyCard({
  company,
  busy,
  onToggle,
  onOpen,
}: {
  company: PlatformCompany;
  busy: boolean;
  onToggle: (company: PlatformCompany) => void;
  onOpen: (company: PlatformCompany) => void;
}) {
  const suspended = company.account_status === "suspended";
  return (
    <article className="admin-company-card">
      <div className="admin-company-card__head">
        <div className="admin-company-avatar">{company.name.slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0">
          <h3>{company.name}</h3>
          <p>{company.slug || company.id}</p>
        </div>
        <StatusBadge status={company.account_status} />
      </div>
      <div className="admin-company-card__plan">
        <span className="admin-plan-chip">{company.plan_name || "Sin plan"}</span>
        <span>{company.plan_code === "free" ? "Sin vencimiento" : company.period_end ? `Vence ${formatDay(company.period_end)}` : statusLabel(company.plan_status)}</span>
      </div>
      <div className="admin-company-card__metrics">
        <div><strong>{company.products ?? "—"}</strong><span>Productos</span></div>
        <div><strong>{company.employees ?? "—"}</strong><span>Usuarios</span></div>
        <div><strong>{company.warehouses ?? "—"}</strong><span>Almacenes</span></div>
      </div>
      <div className="admin-company-card__foot">
        <span>Creada {formatDate(company.created_at)}</span>
        <span className="admin-company-card__actions">
          <Button variant="secondary" onClick={() => onOpen(company)}>Detalle<ChevronRight size={14} /></Button>
          <Button disabled={busy} variant={suspended ? "primary" : "secondary"} onClick={() => onToggle(company)}>
            {suspended ? <Check size={14} /> : <XCircle size={14} />}
            {suspended ? "Reactivar" : "Suspender"}
          </Button>
        </span>
      </div>
    </article>
  );
}

function CompanyDetailModal({
  company,
  plans,
  onClose,
  onChanged,
}: {
  company: PlatformCompany;
  plans: PlatformPlan[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<PlatformCompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [planCode, setPlanCode] = useState<string>(company.plan_code || "starter");
  const [months, setMonths] = useState(1);
  const [note, setNote] = useState("");
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState("");

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      setDetail(await loadCompanyDetail(company.id));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [company.id]);

  const applyPlan = async () => {
    const plan = plans.find((item) => item.code === planCode);
    if (!plan) return;
    const duration = plan.code === "free" ? "sin vencimiento" : `${months} mes(es)`;
    if (!window.confirm(`¿Asignar ${plan.name} a ${company.name} por ${duration}? Se cancelarán solicitudes pendientes de esa empresa.`)) return;
    setApplying(true);
    setError("");
    setMessage("");
    try {
      const result = await setCompanyPlan(company.id, plan.code, months, note);
      setMessage(`${result.plan_name} asignado${result.current_period_end ? ` hasta ${formatDay(result.current_period_end)}` : " sin vencimiento"}.`);
      setNote("");
      await reload();
      await onChanged();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const subscription = detail?.subscription;

  return (
    <Modal title={company.name} description="Detalle de cuenta, plan y movimientos de facturación." onClose={onClose} wide>
      {loading ? <p className="admin-muted">Cargando detalle…</p> : null}
      {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
      {message ? <div className="admin-settings-message admin-settings-message--success">{message}</div> : null}

      {detail ? <>
        <div className="admin-detail-grid">
          <div className="admin-detail-block">
            <p className="admin-kicker">SUSCRIPCIÓN</p>
            <h3>{subscription?.plan_name || "Sin plan"}</h3>
            <dl className="admin-kv">
              <div><dt>Estado</dt><dd>{statusLabel(subscription?.status)}</dd></div>
              <div><dt>Precio</dt><dd>{formatMoney(subscription?.monthly_price, "USD")}/mes</dd></div>
              <div><dt>Vigencia</dt><dd>{subscription?.current_period_end ? formatDay(subscription.current_period_end) : "Sin vencimiento"}</dd></div>
              <div><dt>Cuenta</dt><dd>{statusLabel(detail.company.account_status)}</dd></div>
            </dl>
          </div>
          <div className="admin-detail-block">
            <p className="admin-kicker">OPERACIÓN</p>
            <h3>Datos de la empresa</h3>
            <dl className="admin-kv">
              <div><dt>Productos</dt><dd>{detail.counts.products}</dd></div>
              <div><dt>Empleados</dt><dd>{detail.counts.employees}</dd></div>
              <div><dt>Almacenes</dt><dd>{detail.counts.warehouses}</dd></div>
              <div><dt>Moneda</dt><dd>{detail.company.currency || "CUP"}</dd></div>
            </dl>
          </div>
        </div>

        <section className="admin-detail-block">
          <div className="admin-detail-block__head">
            <div><p className="admin-kicker">ADMINISTRACIÓN</p><h3>Asignar o extender plan</h3></div>
            <CalendarClock size={17} />
          </div>
          <div className="admin-plan-form">
            <label>Plan
              <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
                {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name} · {formatMoney(plan.monthly_price, "USD")}/mes</option>)}
              </select>
            </label>
            <label>Duración
              <select value={months} disabled={planCode === "free"} onChange={(event) => setMonths(Number(event.target.value))}>
                {[1, 3, 6, 12].map((value) => <option key={value} value={value}>{value} mes(es)</option>)}
              </select>
            </label>
            <label className="admin-plan-form__note">Nota interna (opcional)
              <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ej.: pago recibido en efectivo" />
            </label>
            <Button variant="primary" disabled={applying || plans.length === 0} onClick={() => void applyPlan()}>
              {applying ? "Aplicando…" : "Asignar plan"}
            </Button>
          </div>
          <p className="admin-form-hint">La asignación manual activa la empresa, extiende desde el vencimiento actual si es el mismo plan y anula facturas abiertas. Queda registrada en Auditoría.</p>
        </section>

        <section className="admin-history">
          <p className="admin-kicker">HISTORIAL</p>
          <div className="admin-history__grid">
            <div>
              <h4>Solicitudes</h4>
              {detail.requests.length === 0 ? <p className="admin-muted">Sin solicitudes.</p> : detail.requests.map((request) => (
                <div key={request.id} className="admin-history-row">
                  <div><strong>{request.plan_name || request.plan_code}</strong><span>{request.billing_months || 1} mes(es) · {formatDate(request.requested_at)}</span></div>
                  <div className="admin-history-row__end"><StatusBadge status={request.status} /><span>{formatMoney(request.quoted_amount, request.quoted_currency || "USD")}</span></div>
                </div>
              ))}
            </div>
            <div>
              <h4>Facturas</h4>
              {detail.invoices.length === 0 ? <p className="admin-muted">Sin facturas.</p> : detail.invoices.map((invoice) => (
                <div key={`${invoice.invoice_number}-${invoice.created_at}`} className="admin-history-row">
                  <div><strong>{invoice.invoice_number}</strong><span>{formatDate(invoice.created_at)}</span></div>
                  <div className="admin-history-row__end"><StatusBadge status={invoice.status} /><span>{formatMoney(invoice.amount, invoice.currency)}</span></div>
                </div>
              ))}
            </div>
            <div>
              <h4>Pagos</h4>
              {detail.payments.length === 0 ? <p className="admin-muted">Sin pagos registrados.</p> : detail.payments.map((payment) => (
                <div key={payment.id} className="admin-history-row">
                  <div><strong>{formatMoney(payment.amount, payment.currency)}</strong><span>{methodLabel(payment.payment_method)} · {formatDate(payment.paid_at || payment.created_at)}</span><span className="admin-history-ref">{payment.reference || "Sin referencia"}</span></div>
                  <div className="admin-history-row__end"><StatusBadge status={payment.status} /></div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </> : null}
    </Modal>
  );
}

export default function CompaniesView({
  companies,
  onChanged,
}: {
  companies: PlatformCompany[];
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PlatformCompany | null>(null);
  const [plans, setPlans] = useState<PlatformPlan[]>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return companies.filter((company) => {
      const matchesSearch = !q || [company.name, company.slug, company.id, company.plan_name].some((v) => String(v || "").toLowerCase().includes(q));
      const matchesFilter = filter === "all" || String(company.account_status || "") === filter;
      return matchesSearch && matchesFilter;
    });
  }, [companies, query, filter]);

  const toggle = async (company: PlatformCompany) => {
    const next = company.account_status === "suspended" ? "active" : "suspended";
    if (!window.confirm(next === "suspended" ? `¿Suspender ${company.name}?` : `¿Reactivar ${company.name}?`)) return;
    setBusyId(company.id);
    setError("");
    try {
      await changeCompanyStatus(company.id, next);
      await onChanged();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusyId("");
    }
  };

  const open = async (company: PlatformCompany) => {
    setSelected(company);
    if (plans.length) return;
    try {
      setPlans(await loadPlatformPlans());
    } catch (err) {
      setError(adminErrorMessage(err));
    }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">EMPRESAS</p><h1>Todos tus clientes, sin perder el contexto.</h1><p>Busca una cuenta, revisa su plan, su vencimiento y su historial, y cambia estados administrativos sin tocar su operación interna.</p></div>
        <div className="admin-page-count"><strong>{filtered.length}</strong><span>visibles</span></div>
      </section>
      <section className="admin-toolbar">
        <div className="admin-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar empresa, slug, plan o ID…" /></div>
        <div className="admin-filter-row">
          {[
            ["all", "Todas"],
            ["active", "Activas"],
            ["suspended", "Suspendidas"],
            ["pending_payment", "Pago pendiente"],
            ["setup", "Configuración"],
          ].map(([value, label]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
          ))}
        </div>
      </section>
      {error ? <div className="admin-global-error">{error}<button type="button" onClick={() => setError("")}>×</button></div> : null}
      <section className="admin-company-grid">
        {filtered.map((company) => <CompanyCard key={company.id} company={company} busy={busyId === company.id} onToggle={(item) => void toggle(item)} onOpen={(item) => void open(item)} />)}
        {filtered.length === 0 ? <EmptyPanel title="No encontramos esa empresa" description="Prueba con otro nombre, plan, slug o estado." /> : null}
      </section>
      {selected ? <CompanyDetailModal company={selected} plans={plans} onClose={() => setSelected(null)} onChanged={onChanged} /> : null}
    </div>
  );
}
