import { useEffect, useState } from "react";
import { AlertCircle, ArrowUpRight, Check, Mail, RefreshCw, TicketCheck, X } from "lucide-react";
import { adminErrorMessage, loadSupportRequests, setSupportRequestStatus, type PlatformSupportRequest } from "../platformAdminApi";
import { Button, EmptyPanel, StatusBadge, formatDate } from "../shared";

const TYPE_LABELS: Record<string, string> = {
  question: "Consulta",
  bug: "Problema técnico",
  billing: "Facturación",
  feature: "Sugerencia",
  other: "Otro",
};

function whatsappUrl(request: PlatformSupportRequest) {
  const digits = String(request.contact_phone || "").replace(/\D/g, "");
  if (digits.length < 6) return "";
  const text = `Solicitud ${request.id.slice(0, 8).toUpperCase()} · ${request.company_name} · ${request.subject}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export default function SupportView({ onChanged }: { onChanged: () => Promise<void> }) {
  const [requests, setRequests] = useState<PlatformSupportRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const refresh = async (nextFilter = filter) => {
    setLoading(true);
    setError("");
    try {
      setRequests(await loadSupportRequests(nextFilter));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [filter]);

  const changeStatus = async (request: PlatformSupportRequest, status: "in_progress" | "resolved" | "closed") => {
    setBusyId(request.id);
    setError("");
    try {
      await setSupportRequestStatus(request.id, status);
      await Promise.all([refresh(), onChanged()]);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">ATENCIÓN</p>
          <h1>Centro de atención al cliente.</h1>
          <p>Las solicitudes enviadas desde cada empresa quedan registradas aquí antes de continuar por el canal oficial.</p>
        </div>
        <Button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />Actualizar</Button>
      </section>
      <section className="admin-toolbar">
        <div className="admin-filter-row">
          {[["open", "Abiertas"], ["in_progress", "En atención"], ["resolved", "Resueltas"], ["closed", "Cerradas"], ["all", "Todas"]].map(([value, label]) =>
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
          )}
        </div>
      </section>
      {error ? <div className="admin-global-error"><AlertCircle size={16} />{error}</div> : null}
      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>{loading ? "Cargando…" : `${requests.length} registros`}</h2></div><TicketCheck size={17} /></div>
        {loading ? <div className="admin-empty">Cargando solicitudes…</div> :
          requests.length ? <div className="admin-request-list">{requests.map((request) => {
            const url = whatsappUrl(request);
            return (
              <article key={request.id} className="admin-request-card">
                <div className="admin-request-main">
                  <div className="admin-company-avatar admin-company-avatar--small">{request.company_name.slice(0, 1).toUpperCase()}</div>
                  <div>
                    <strong>{request.company_name}</strong>
                    <span>{TYPE_LABELS[request.request_type] || request.request_type} · {request.subject}</span>
                    <span>{formatDate(request.created_at)}{request.owner_email ? ` · ${request.owner_email}` : ""}</span>
                  </div>
                </div>
                <p className="admin-request-message">{request.message}</p>
                <div className="admin-request-actions">
                  <StatusBadge status={request.status} />
                  <span className="admin-request-phone">{request.contact_phone || "Sin teléfono"}</span>
                  {url ? <a className="admin-btn admin-btn--secondary" href={url} target="_blank" rel="noreferrer"><ArrowUpRight size={14} />WhatsApp</a> : null}
                  {request.owner_email ? <a className="admin-btn admin-btn--secondary" href={`mailto:${request.owner_email}?subject=${encodeURIComponent(`PALMYRA · ${request.subject}`)}`}><Mail size={14} />Correo</a> : null}
                  {request.status !== "in_progress" && request.status !== "resolved" && request.status !== "closed" && <Button disabled={busyId === request.id} onClick={() => void changeStatus(request, "in_progress")}>En proceso</Button>}
                  {request.status !== "resolved" && request.status !== "closed" && <Button variant="primary" disabled={busyId === request.id} onClick={() => void changeStatus(request, "resolved")}><Check size={14} />Resolver</Button>}
                  {request.status !== "closed" && <Button variant="ghost" disabled={busyId === request.id} onClick={() => void changeStatus(request, "closed")}><X size={14} />Cerrar</Button>}
                </div>
              </article>
            );
          })}</div> : <EmptyPanel title="No hay solicitudes en este estado" description="Cuando una empresa envíe una solicitud aparecerá aquí." />}
      </section>
    </div>
  );
}
