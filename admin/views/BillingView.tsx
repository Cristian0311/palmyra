import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, CircleDollarSign, Clock3, CreditCard, RefreshCw, Wallet, X } from "lucide-react";
import {
  adminErrorMessage,
  approveRequest,
  loadBillingPayments,
  loadPlanRequests,
  rejectRequest,
  type PlanRequest,
  type PlatformPayment,
} from "../platformAdminApi";
import { Button, EmptyPanel, Modal, StatusBadge, formatDate, formatDay, formatMoney, methodLabel } from "../shared";

type Filter = "pending" | "approved" | "rejected" | "cancelled" | "all";

const FILTERS: Array<[Filter, string]> = [
  ["pending", "Pendientes"],
  ["approved", "Aprobadas"],
  ["rejected", "Rechazadas"],
  ["cancelled", "Canceladas"],
  ["all", "Todas"],
];

export default function BillingView({ onChanged }: { onChanged: () => Promise<void> }) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [requests, setRequests] = useState<PlanRequest[]>([]);
  const [payments, setPayments] = useState<PlatformPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [target, setTarget] = useState<PlanRequest | null>(null);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"CUP" | "USD">("USD");
  const [reference, setReference] = useState("");

  const loadRequests = async (nextFilter: Filter) => {
    setLoading(true);
    setError("");
    try {
      setRequests(await loadPlanRequests(nextFilter));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const loadPayments = async () => {
    try {
      setPayments(await loadBillingPayments(40));
    } catch {
      // El listado de pagos es informativo; no bloquea la aprobación.
    }
  };

  useEffect(() => { void loadRequests(filter); }, [filter]);
  useEffect(() => { void loadPayments(); }, []);

  const pendingCount = filter === "pending" ? requests.length : undefined;
  const totalQuoted = useMemo(
    () => requests.reduce((sum, request) => sum + Number(request.quoted_amount || 0), 0),
    [requests],
  );

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

      <section className="admin-toolbar">
        <div className="admin-filter-row">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
          ))}
        </div>
        <Button variant="secondary" onClick={() => void loadRequests(filter)} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />Actualizar</Button>
      </section>

      {error ? <div className="admin-global-error"><AlertCircle size={16} />{error}<button type="button" onClick={() => setError("")}>×</button></div> : null}
      {notice ? <div className="admin-settings-message admin-settings-message--success">{notice}</div> : null}

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>{loading ? "Cargando…" : `${requests.length} registro(s)`}</h2></div><CreditCard size={17} /></div>
        {!loading && requests.length === 0 ? <EmptyPanel title="No hay solicitudes en este estado" description="Cuando una empresa solicite o renueve un plan aparecerá aquí con su cotización." /> : null}
        {requests.length > 0 ? <div className="admin-request-list">
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
        <div className="admin-panel__head"><div><p className="admin-kicker">COBROS</p><h2>Últimos pagos registrados</h2></div><Wallet size={17} /></div>
        {payments.length === 0 ? <EmptyPanel title="Todavía no hay pagos" description="Cada aprobación registra un pago con su referencia y moneda." /> : <div className="admin-request-list">
          {payments.map((payment) => (
            <article key={payment.id} className="admin-request-row admin-request-row--compact">
              <div className="admin-request-main">
                <div className="admin-company-avatar admin-company-avatar--small">{String(payment.company_name || "?").slice(0, 1).toUpperCase()}</div>
                <div><strong>{payment.company_name}</strong><span>{methodLabel(payment.payment_method)} · {formatDate(payment.paid_at || payment.created_at)}</span><span className="admin-history-ref">{payment.manual_reference || payment.reference || "Sin referencia"}</span></div>
              </div>
              <div className="admin-request-price"><strong>{formatMoney(payment.amount, payment.currency)}</strong><span>{payment.plan_code || payment.status}</span></div>
              <div className="admin-request-actions"><StatusBadge status={payment.status} /></div>
            </article>
          ))}
        </div>}
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
