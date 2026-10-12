import { Activity, Check, CircleDollarSign, Clock3, CreditCard, X } from "lucide-react";
import type { PlanRequest } from "../platformAdminApi";
import { Button, EmptyPanel, formatDate } from "../shared";

export default function BillingView({
  requests,
  busy,
  onApprove,
  onReject,
}: {
  requests: PlanRequest[];
  busy: boolean;
  onApprove: (request: PlanRequest) => void;
  onReject: (request: PlanRequest) => void;
}) {
  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">PLANES Y PAGOS</p><h1>Monetización con revisión humana.</h1><p>Esta primera consola reutiliza las solicitudes de plan ya protegidas. Las tablas de facturación ampliadas se añadirán sobre este núcleo, no duplicando datos.</p></div>
        <div className="admin-page-count"><strong>{requests.length}</strong><span>pendientes</span></div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>Activaciones pendientes</h2></div><Clock3 size={17} /></div>
        {requests.length ? (
          <div className="admin-request-list">
            {requests.map((request) => (
              <article key={request.id} className="admin-request-row">
                <div className="admin-request-main">
                  <div className="admin-company-avatar admin-company-avatar--small">{String(request.company_name || "?").slice(0, 1).toUpperCase()}</div>
                  <div><strong>{request.company_name || "Empresa sin nombre"}</strong><span>{request.plan_name || "Plan"} · {formatDate(request.requested_at)}</span></div>
                </div>
                <div className="admin-request-price">
                  <strong>{request.monthly_price != null ? `$ ${Number(request.monthly_price).toFixed(2)}` : "—"}</strong>
                  <span>{request.payment_method || "Pago manual"}</span>
                </div>
                <div className="admin-request-actions">
                  <Button disabled={busy} variant="primary" onClick={() => onApprove(request)}><Check size={14} />Aprobar</Button>
                  <Button disabled={busy} variant="secondary" onClick={() => onReject(request)}><X size={14} />Rechazar</Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyPanel title="No hay solicitudes pendientes" description="Cuando llegue una nueva solicitud aparecerá aquí con su empresa, plan y método de pago." />
        )}
      </section>

      <section className="admin-grid-3">
        {[
          [CircleDollarSign, "Pagos manuales", "Listo para efectivo y transferencia. El registro definitivo seguirá viviendo en Supabase.", "En núcleo"],
          [CreditCard, "Planes", "Los planes se mantienen centralizados para que CRM y Admin no terminen con precios distintos.", "Preparado"],
          [Activity, "Historial", "Las aprobaciones y rechazos deben auditarse para conservar trazabilidad.", "Preparado"],
        ].map(([Icon, title, text, badge]) => {
          const I = Icon as typeof CircleDollarSign;
          return <div className="admin-mini-panel" key={String(title)}><span className="admin-icon-box"><I size={15} /></span><h3>{title as string}</h3><p>{text as string}</p><span className="admin-mini-badge">{badge as string}</span></div>;
        })}
      </section>
    </div>
  );
}
