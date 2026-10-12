import { useEffect, useState } from "react";
import { AlertCircle, ArrowUpRight, RefreshCw, TicketCheck } from "lucide-react";
import { loadSupportRequests, type PlatformSupportRequest } from "../platformAdminApi";
import { Button, EmptyPanel, formatDate } from "../shared";

export default function SupportView() {
  const [requests, setRequests] = useState<PlatformSupportRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState("");

  const refresh = async (nextFilter = filter) => {
    setLoading(true);
    setError("");
    try {
      setRequests(await loadSupportRequests(nextFilter === "all" ? undefined : nextFilter));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las solicitudes.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [filter]);

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">ATENCIÓN</p>
          <h1>Centro de atención al cliente.</h1>
          <p>Las solicitudes enviadas desde cada empresa quedan registradas aquí antes de continuar por el canal oficial.</p>
        </div>
        <Button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""}/>Actualizar</Button>
      </section>
      <section className="admin-toolbar">
        <div className="admin-filter-row">
          {[["open","Abiertas"],["in_progress","En atención"],["resolved","Resueltas"],["closed","Cerradas"],["all","Todas"]].map(([value,label]) =>
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter===value ? "active" : ""}>{label}</button>
          )}
        </div>
      </section>
      {error ? <div className="admin-global-error"><AlertCircle size={16}/>{error}</div> : null}
      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">SOLICITUDES</p><h2>{requests.length} registros</h2></div><TicketCheck size={17}/></div>
        {loading ? <div className="admin-empty">Cargando solicitudes…</div> :
          requests.length ? <div className="admin-request-list">{requests.map(request =>
            <article key={request.id} className="admin-request-row">
              <div className="admin-request-main">
                <div className="admin-company-avatar admin-company-avatar--small">{request.company_name.slice(0,1).toUpperCase()}</div>
                <div><strong>{request.company_name}</strong><span>{request.request_type} · {request.subject}</span><span>{formatDate(request.created_at)}</span></div>
              </div>
              <div className="admin-request-price"><strong>{request.status}</strong><span>{request.contact_phone || "Sin teléfono"}</span></div>
              <div className="admin-request-actions"><a className="admin-btn admin-btn--secondary" href={`https://wa.me/?text=${encodeURIComponent("Solicitud "+request.id+" · "+request.company_name+" · "+request.subject)}`} target="_blank" rel="noreferrer"><ArrowUpRight size={14}/>Abrir canal</a></div>
            </article>
          )}</div> : <EmptyPanel title="No hay solicitudes en este estado" description="Cuando una empresa envíe una solicitud aparecerá aquí." />
        }
      </section>
    </div>
  );
}
