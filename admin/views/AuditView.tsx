import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, RefreshCw, Search } from "lucide-react";
import { adminErrorMessage, loadAdminAudit, type PlatformAuditEntry } from "../platformAdminApi";
import { Button, EmptyPanel, formatDate } from "../shared";

const ACTION_LABELS: Record<string, string> = {
  "plan_request.created": "Solicitud creada",
  "plan_request.approved": "Plan aprobado",
  "plan_request.rejected": "Solicitud rechazada",
  "plan_request.cancelled": "Solicitud cancelada",
  "company.status_changed": "Estado de empresa",
  "company.plan_assigned": "Plan asignado manualmente",
  "subscription.created": "Suscripción creada",
  "subscription.updated": "Suscripción actualizada",
  "support.status_changed": "Soporte actualizado",
};

const DETAIL_LABELS: Record<string, string> = {
  from: "antes",
  to: "después",
  plan_code: "plan",
  plan_id: "plan",
  months: "meses",
  billing_months: "meses",
  quoted_amount: "cotizado",
  note: "nota",
  subject: "asunto",
  active: "activa",
  period_end: "vence",
  from_plan: "plan anterior",
  to_plan: "plan nuevo",
  from_status: "estado anterior",
  to_status: "estado nuevo",
};

function renderDetail(detail?: Record<string, unknown>) {
  if (!detail) return "";
  return Object.entries(detail)
    .filter(([, value]) => value != null && value !== "" && typeof value !== "object")
    .slice(0, 6)
    .map(([key, value]) => `${DETAIL_LABELS[key] || key}: ${String(value)}`)
    .join(" · ");
}

export default function AuditView() {
  const [entries, setEntries] = useState<PlatformAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setEntries(await loadAdminAudit(200));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) =>
      [entry.action, ACTION_LABELS[entry.action], entry.company_name, entry.actor_email, renderDetail(entry.detail)]
        .some((value) => String(value || "").toLowerCase().includes(q)),
    );
  }, [entries, query]);

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">AUDITORÍA</p><h1>Cada decisión, con fecha y responsable.</h1><p>Aprobaciones, rechazos, cambios de estado, asignaciones de plan y triage de soporte quedan registrados automáticamente.</p></div>
        <Button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />Actualizar</Button>
      </section>
      <section className="admin-toolbar">
        <div className="admin-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por empresa, acción o administrador…" /></div>
        <span className="admin-muted">{filtered.length} registro(s)</span>
      </section>
      {error ? <div className="admin-global-error"><AlertCircle size={16} />{error}</div> : null}
      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">REGISTRO</p><h2>Historial administrativo</h2></div><Activity size={17} /></div>
        {loading ? <div className="admin-empty">Cargando auditoría…</div> : filtered.length === 0 ? <EmptyPanel title="Sin movimientos registrados" description="Las acciones nuevas aparecerán aquí en cuanto ocurran." /> : (
          <div className="admin-audit-list">
            {filtered.map((entry) => (
              <article key={entry.id} className="admin-audit-row">
                <span className="admin-audit-dot" aria-hidden="true" />
                <div className="admin-audit-main">
                  <strong>{ACTION_LABELS[entry.action] || entry.action}</strong>
                  <span>{entry.company_name || "Plataforma"} · {formatDate(entry.created_at)}</span>
                  {renderDetail(entry.detail) ? <span className="admin-audit-detail">{renderDetail(entry.detail)}</span> : null}
                </div>
                <span className="admin-audit-actor">{entry.actor_email || "Sistema"}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
