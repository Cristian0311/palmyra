import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleDollarSign,
  Clock3,
  CreditCard,
  Download,
  Layers,
  RefreshCw,
  Wallet,
  X,
} from "lucide-react";
import {
  adminErrorMessage,
  approveRequest,
  loadBillingPayments,
  loadPlanRequests,
  loadPlatformPlans,
  rejectRequest,
  type PlanRequest,
  type PlatformPayment,
  type PlatformPlan,
} from "../platformAdminApi";
import { Button, EmptyPanel, FEATURE_LABELS, LoadingBlock, Modal, StatusBadge, downloadCsv, formatDate, formatDay, formatMoney, methodLabel } from "../shared";

type Filter = "pending" | "approved" | "rejected" | "cancelled" | "all";

const FILTERS: Array<[Filter, string]> = [
  ["pending", "Pendientes"],
  ["approved", "Aprobadas"],
  ["rejected", "Rechazadas"],
  ["cancelled", "Canceladas"],
  ["all", "Todas"],
];

function planFeatureKeys(plan: PlatformPlan) {
  const features = plan.features || {};
  const keys = Array.isArray(features.feature_keys) ? features.feature_keys : [];
  const normalized = keys.filter((key): key is string => typeof key === "string");
  if (normalized.length) return normalized;
  return Array.isArray(features.features) ? features.features.filter((item): item is string => typeof item === "string") : [];
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export default function BillingView({ onChanged }: { onChanged: () => Promise<void> }) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [requests, setRequests] = useState<PlanRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [payments, setPayments] = useState<PlatformPayment[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(true);
  const [plans, setPlans] = useState<PlatformPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [target, setTarget] = useState<PlanRequest | null>(null);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"CUP" | "USD">("USD");
  const [reference, setReference] = useState("");

  const [payMethod, setPayMethod] = useState("all");
  const [payCurrency, setPayCurrency] = useState("all");
  const [payCompany, setPayCompany] = useState("all");
  const [payFrom, setPayFrom] = useState("");
  const [payTo, setPayTo] = useState("");

  const loadRequests = async (nextFilter: Filter) => {
    setLoadingRequests(true);
    setError("");
    try {
      setRequests(await loadPlanRequests(nextFilter));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoadingRequests(false);
    }
  };

  const loadPayments = async () => {
    setLoadingPayments(true);
    try {
      setPayments(await loadBillingPayments(500));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoadingPayments(false);
    }
  };

  const loadPlans = async () => {
    setLoadingPlans(true);
    try {
      setPlans(await loadPlatformPlans());
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoadingPlans(false);
    }
  };

  useEffect(() => { void loadRequests(filter); }, [filter]);
  useEffect(() => { void loadPayments(); void loadPlans(); }, []);

  const pendingCount = filter === "pending" ? requests.length : undefined;
  const totalQuoted = useMemo(
    () => requests.reduce((sum, request) => sum + Number(request.quoted_amount || 0), 0),
    [requests],
  );

  const paymentCompanies = useMemo(
    () => [...new Set(payments.map((payment) => payment.company_name).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, "es")),
    [payments],
  );
  const paymentMethods = useMemo(
    () => [...new Set(payments.map((payment) => payment.payment_method).filter((value): value is string => Boolean(value)))].sort(),
    [payments],
  );
  const paymentCurrencies = useMemo(
    () => [...new Set(payments.map((payment) => payment.currency).filter((value): value is string => Boolean(value)))].sort(),
    [payments],
  );

  const filteredPayments = useMemo(() => {
    const from = payFrom ? new Date(`${payFrom}T00:00:00`).getTime() : null;
    const to = payTo ? new Date(`${payTo}T23:59:59`).getTime() : null;
    return payments.filter((payment) => {
      const stamp = new Date(payment.paid_at || payment.created_at).getTime();
      return (
        (payMethod === "all" || payment.payment_method === payMethod) &&
        (payCurrency === "all" || payment.currency === payCurrency) &&
        (payCompany === "all" || payment.company_name === payCompany) &&
        (from == null || stamp >= from) &&
        (to == null || stamp <= to)
      );
    });
  }, [payments, payMethod, payCurrency, payCompany, payFrom, payTo]);

  const totals = useMemo(() => {
    const map = new Map<string, number>();
    filteredPayments.forEach((payment) => {
      if (payment.status !== "paid") return;
      map.set(payment.currency, (map.get(payment.currency) || 0) + Number(payment.amount || 0));
    });
    return [...map.entries()];
  }, [filteredPayments]);

  const paymentsFiltered = payMethod !== "all" || payCurrency !== "all" || payCompany !== "all" || Boolean(payFrom) || Boolean(payTo);

  const clearPaymentFilters = () => {
    setPayMethod("all");
    setPayCurrency("all");
    setPayCompany("all");
    setPayFrom("");
    setPayTo("");
  };

  const exportPayments = () => {
    downloadCsv(`palmyra-pagos-${todayStamp()}.csv`, [
      ["Fecha", "Empresa", "Plan", "Método", "Moneda", "Importe", "Estado", "Referencia"],
      ...filteredPayments.map((payment) => [
        formatDate(payment.paid_at || payment.created_at),
        payment.company_name,
        payment.plan_code || "",
        methodLabel(payment.payment_method),
        payment.currency,
        payment.amount,
        payment.status,
        payment.manual_reference || payment.reference || "",
      ]),
    ]);
  };

  const openApprove = (request: PlanRequest) => {
    const suggested = request.quoted_amount ?? (request.monthly_price != null ? Number(request.monthly_price) * (request.billing_months || 1) : null);
    const methodCurrency: "CUP" | "USD" = String(request.payment_method || "").startsWith("cup_") ? "CUP" : "USD";
    setTarget(request);
    setAmount(suggested != null ? String(suggested) : "");
    setCurrency((request.quoted_currency as "CUP" | "USD") || methodCurrency);
    setReference("");
    setError("");
    setNotice("");
  };

  const confirmApprove = async () => {
    if (!target) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await approveRequest(target.id, { amount: Number(amount), currency, reference });
      setNotice(`${result.plan_name || "Plan"} activado${result.current_period_end ? ` hasta ${formatDay(result.current_period_end)}` : ""}.`);
      setTarget(null);
      await Promise.all([loadRequests(filter), loadPayments(), onChanged()]);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async (request: PlanRequest) => {
    const note = window.prompt(`Motivo del rechazo para ${request.company_name || "la empresa"} (opcional):`, "");
    if (note === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await rejectRequest(request.id, note);
      setNotice("Solicitud rechazada. La factura abierta quedó anulada.");
      await Promise.all([loadRequests(filter), onChanged()]);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">PLANES Y PAGOS</p><h1>Monetización con revisión humana.</h1><p>Aprueba con el importe real y una referencia obligatoria. Cada aprobación extiende el período, registra el pago y queda auditada.</p></div>
        <div className="admin-page-count"><strong>{pendingCount ?? totalQuoted.toLocaleString("es-CU")}</strong><span>{pendingCount != null ? "pendientes" : "USD cotizados"}</span></div>
      </section>

      {error ? (
        <div className="admin-global-error" role="alert">
          <AlertCircle size={16} />{error}
          <Button variant="ghost" onClick={() => { void loadRequests(filter); void loadPayments(); void loadPlans(); }}>Reintentar</Button>
          <button type="button" aria-label="Descartar error" onClick={() => setError("")}>×</button>
        </div>
      ) : null}
      {notice ? <div className="admin-settings-message admin-settings-message--success" role="status">{notice}</div> : null}

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>{loadingRequests ? "Cargando…" : `${requests.length} registro(s)`}</h2></div><CreditCard size={17} /></div>
        <div className="admin-toolbar admin-toolbar--flush">
          <div className="admin-filter-row">
            {FILTERS.map(([value, label]) => (
              <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => void loadRequests(filter)} disabled={loadingRequests}><RefreshCw size={14} className={loadingRequests ? "spin" : ""} />Actualizar</Button>
        </div>

        {loadingRequests ? <LoadingBlock label="Cargando solicitudes de plan…" /> : null}
        {!loadingRequests && requests.length === 0 ? <EmptyPanel title="No hay solicitudes en este estado" description="Cuando una empresa solicite o renueve un plan aparecerá aquí con su cotización." /> : null}
        {!loadingRequests && requests.length > 0 ? <div className="admin-request-list">
          {requests.map((request) => (
            <article key={request.id} className="admin-request-row">
              <div className="admin-request-main">
                <div className="admin-company-avatar admin-company-avatar--small">{String(request.company_name || "?").slice(0, 1).toUpperCase()}</div>
                <div>
                  <strong>{request.company_name || "Empresa sin nombre"}</strong>
                  <span>{request.plan_name || "Plan"} · {request.billing_months || 1} mes(es) · {formatDate(request.requested_at)}</span>
                  <span>{methodLabel(request.payment_method)} · {request.contact_phone || request.owner_email || "Sin contacto"}</span>
                </div>
              </div>
              <div className="admin-request-price">
                <strong>{formatMoney(request.quoted_amount ?? (request.monthly_price != null ? Number(request.monthly_price) * (request.billing_months || 1) : null), request.quoted_currency || "USD")}</strong>
                <span>cotización</span>
              </div>
              <div className="admin-request-actions">
                <StatusBadge status={request.status} />
                {request.status === "pending" ? <>
                  <Button disabled={busy} variant="primary" onClick={() => openApprove(request)}><Check size={14} />Aprobar</Button>
                  <Button disabled={busy} variant="secondary" onClick={() => void reject(request)}><X size={14} />Rechazar</Button>
                </> : null}
              </div>
            </article>
          ))}
        </div> : null}
      </section>

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">COBROS</p><h2>{loadingPayments ? "Cargando pagos…" : `${filteredPayments.length} de ${payments.length} pagos`}</h2></div><Wallet size={17} /></div>

        <div className="admin-filter-bar">
          <label>Método
            <select value={payMethod} onChange={(event) => setPayMethod(event.target.value)}>
              <option value="all">Todos</option>
              {paymentMethods.map((method) => <option key={method} value={method}>{methodLabel(method)}</option>)}
            </select>
          </label>
          <label>Moneda
            <select value={payCurrency} onChange={(event) => setPayCurrency(event.target.value)}>
              <option value="all">Todas</option>
              {paymentCurrencies.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label>Empresa
            <select value={payCompany} onChange={(event) => setPayCompany(event.target.value)}>
              <option value="all">Todas</option>
              {paymentCompanies.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>Desde
            <input type="date" value={payFrom} onChange={(event) => setPayFrom(event.target.value)} />
          </label>
          <label>Hasta
            <input type="date" value={payTo} onChange={(event) => setPayTo(event.target.value)} />
          </label>
          <div className="admin-filter-bar__actions">
            {paymentsFiltered ? <Button variant="ghost" onClick={clearPaymentFilters}>Limpiar</Button> : null}
            <Button variant="secondary" onClick={exportPayments} disabled={filteredPayments.length === 0}><Download size={14} />CSV</Button>
          </div>
        </div>

        {totals.length > 0 ? (
          <div className="admin-total-row">
            <span>Total cobrado visible:</span>
            {totals.map(([code, total]) => <strong key={code}>{formatMoney(total, code)}</strong>)}
          </div>
        ) : null}

        {loadingPayments ? <LoadingBlock label="Leyendo pagos registrados…" /> : null}
        {!loadingPayments && filteredPayments.length === 0 ? (
          <EmptyPanel
            title="No hay pagos con esos filtros"
            description="Cada aprobación registra un pago con su referencia y moneda. Ajusta el rango de fechas o limpia los filtros."
            action={paymentsFiltered ? <Button onClick={clearPaymentFilters}>Limpiar filtros</Button> : undefined}
          />
        ) : null}
        {!loadingPayments && filteredPayments.length > 0 ? <div className="admin-request-list">
          {filteredPayments.map((payment) => (
            <article key={payment.id} className="admin-request-row admin-request-row--compact">
              <div className="admin-request-main">
                <div className="admin-company-avatar admin-company-avatar--small">{String(payment.company_name || "?").slice(0, 1).toUpperCase()}</div>
                <div><strong>{payment.company_name}</strong><span>{methodLabel(payment.payment_method)} · {formatDate(payment.paid_at || payment.created_at)}</span><span className="admin-history-ref">{payment.manual_reference || payment.reference || "Sin referencia"}</span></div>
              </div>
              <div className="admin-request-price"><strong>{formatMoney(payment.amount, payment.currency)}</strong><span>{payment.plan_code || payment.status}</span></div>
              <div className="admin-request-actions"><StatusBadge status={payment.status} /></div>
            </article>
          ))}
        </div> : null}
      </section>

      <section className="admin-panel">
        <div className="admin-panel__head">
          <div><p className="admin-kicker">CATÁLOGO</p><h2>Planes disponibles (solo lectura)</h2></div>
          <Layers size={17} />
        </div>
        {loadingPlans ? <LoadingBlock label="Cargando catálogo de planes…" /> : null}
        {!loadingPlans && plans.length === 0 ? <EmptyPanel title="Sin planes activos" description="La base de datos no devolvió planes activos." /> : null}
        {!loadingPlans && plans.length > 0 ? (
          <div className="admin-plan-catalog">
            {plans.map((plan) => {
              const features = planFeatureKeys(plan);
              return (
                <article key={plan.code} className="admin-plan-card">
                  <header>
                    <div><strong>{plan.name}</strong><span>{plan.code}</span></div>
                    <b>{formatMoney(plan.monthly_price, plan.currency || "USD")}</b>
                  </header>
                  <dl className="admin-plan-card__limits">
                    <div><dt>Productos</dt><dd>{String(plan.limits?.products ?? "∞")}</dd></div>
                    <div><dt>Empleados</dt><dd>{String(plan.limits?.employees ?? "∞")}</dd></div>
                    <div><dt>Almacenes</dt><dd>{String(plan.limits?.warehouses ?? "∞")}</dd></div>
                  </dl>
                  {features.length > 0 ? (
                    <div className="admin-feature-list">
                      {features.slice(0, 8).map((key) => <span key={key} className="admin-feature-chip"><Check size={11} />{FEATURE_LABELS[key] || key}</span>)}
                      {features.length > 8 ? <span className="admin-feature-chip admin-feature-chip--locked">+{features.length - 8}</span> : null}
                    </div>
                  ) : <p className="admin-muted">Sin funciones declaradas.</p>}
                </article>
              );
            })}
          </div>
        ) : null}
        <p className="admin-form-hint">El catálogo se edita en la base de datos; desde esta consola solo se consulta y se asigna a cada empresa en su ficha.</p>
      </section>

      <section className="admin-grid-3">
        {[
          [CircleDollarSign, "Registro manual", "CUP y USD se confirman con el importe realmente recibido y una referencia obligatoria."],
          [Clock3, "Renovación acumulativa", "Mismo plan: los meses se suman desde el vencimiento actual, sin perder días pagados."],
          [CreditCard, "Trazabilidad", "Cada aprobación crea factura pagada, pago y entrada en Auditoría."],
        ].map(([Icon, title, text]) => {
          const I = Icon as typeof CircleDollarSign;
          return <div className="admin-mini-panel" key={String(title)}><span className="admin-icon-box"><I size={15} /></span><h3>{title as string}</h3><p>{text as string}</p></div>;
        })}
      </section>

      {target ? <Modal
        title={`Aprobar pago · ${target.company_name || "Empresa"}`}
        description={`${target.plan_name || "Plan"} · ${target.billing_months || 1} mes(es) · ${methodLabel(target.payment_method)}`}
        onClose={() => { if (!busy) setTarget(null); }}
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => setTarget(null)}>Cancelar</Button>
          <Button variant="primary" disabled={busy} onClick={() => void confirmApprove()}><Check size={14} />{busy ? "Activando…" : "Confirmar y activar"}</Button>
        </>}
      >
        <p className="admin-form-hint">Cotización registrada: <strong>{formatMoney(target.quoted_amount, target.quoted_currency || "USD")}</strong>. En USD el importe recibido no puede ser menor; en CUP se acepta el monto acordado.</p>
        <div className="admin-plan-form admin-plan-form--modal">
          <label>Importe recibido
            <input type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus />
          </label>
          <label>Moneda
            <select value={currency} onChange={(event) => setCurrency(event.target.value as "CUP" | "USD")}>
              <option value="USD">USD</option>
              <option value="CUP">CUP</option>
            </select>
          </label>
          <label className="admin-plan-form__note">Referencia o comprobante
            <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Nro. de transferencia, recibo…" />
          </label>
        </div>
        {error ? <div className="admin-alert admin-alert--error"><AlertCircle size={15} />{error}</div> : null}
      </Modal> : null}
    </div>
  );
}
