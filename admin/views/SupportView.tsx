import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowUpRight, Check, Clock3, Mail, RefreshCw, RotateCcw, Search, TicketCheck, X } from "lucide-react";
import { adminErrorMessage, loadSupportRequests, setSupportRequestStatus, type PlatformSupportRequest } from "../platformAdminApi";
import { Button, EmptyPanel, LoadingBlock, StatusBadge, formatDate } from "../shared";

const TYPE_LABELS: Record<string, string> = {
  question: "Consulta",
  bug: "Problema técnico",
  billing: "Facturación",
  feature: "Sugerencia",
  other: "Otro",
};

const FILTERS: Array<[string, string]> = [
  ["open", "Pendientes"],
  ["in_progress", "En proceso"],
  ["resolved", "Resueltos"],
  ["closed", "Cerrados"],
  ["all", "Todos"],
];

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
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((request) =>
      [request.company_name, request.subject, request.message, request.owner_email, request.contact_phone]
        .some((value) => String(value || "").toLowerCase().includes(q)),
    );
  }, [requests, query]);

  const selected = filtered.find((request) => request.id === selectedId) || filtered[0] || null;

  const changeStatus = async (request: PlatformSupportRequest, status: "open" | "in_progress" | "resolved" | "closed") => {
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

  const url = selected ? whatsappUrl(selected) : "";

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">ATENCIÓN</p>
          <h1>Bandeja de soporte.</h1>
          <p>Solicitudes enviadas desde cada empresa, con su contexto completo. Responde por el canal oficial y deja el estado actualizado.</p>
        </div>
        <Button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />Actualizar</Button>
      </section>

      <section className="admin-toolbar">
        <div className="admin-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por empresa, asunto, mensaje o contacto…" aria-label="Buscar solicitudes de soporte" />
        </div>
        <div className="admin-filter-row">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
          ))}
        </div>
      </section>

      {error ? (
        <div className="admin-global-error" role="alert">
          <AlertCircle size={16} />{error}
          <Button variant="ghost" onClick={() => void refresh()}>Reintentar</Button>
        </div>
      ) : null}

      <section className="admin-panel admin-support-inbox">
        <div className="admin-panel__head">
          <div><p className="admin-kicker">SOLICITUDES</p><h2>{loading ? "Cargando…" : `${filtered.length} de ${requests.length} registros`}</h2></div>
          <TicketCheck size={17} />
        </div>

        {loading ? <LoadingBlock label="Cargando bandeja de soporte…" /> : null}
        {!loading && filtered.length === 0 ? (
          <EmptyPanel
            title="No hay solicitudes con esos filtros"
            description="Cambia el estado o limpia la búsqueda. Las solicitudes nuevas aparecerán aquí automáticamente al actualizar."
            action={<Button onClick={() => { setQuery(""); setFilter("all"); }}>Ver todas</Button>}
          />
        ) : null}

        {!loading && filtered.length > 0 ? (
          <div className="admin-inbox">
            <div className="admin-inbox__list" aria-label="Solicitudes de soporte">
              {filtered.map((request) => (
                <button
                  key={request.id}
                  type="button"
                  className={`admin-inbox__item${selected?.id === request.id ? " is-active" : ""}`}
                  onClick={() => setSelectedId(request.id)}
                  aria-current={selected?.id === request.id ? "true" : undefined}
                >
                  <span className="admin-inbox__top">
                    <strong>{request.company_name}</strong>
                    <StatusBadge status={request.status} />
                  </span>
                  <span className="admin-inbox__subject">{request.subject}</span>
                  <span className="admin-inbox__meta">{TYPE_LABELS[request.request_type] || request.request_type} · {formatDate(request.created_at)}</span>
                </button>
              ))}
            </div>

            {selected ? (
              <article className="admin-inbox__detail">
                <header>
                  <div>
                    <p className="admin-kicker">{TYPE_LABELS[selected.request_type] || selected.request_type}</p>
                    <h3>{selected.subject}</h3>
                    <span>{selected.company_name} · {formatDate(selected.created_at)}</span>
                  </div>
                  <StatusBadge status={selected.status} />
                </header>
                <p className="admin-request-message">{selected.message}</p>
                <dl className="admin-kv admin-kv--boxed">
                  <div><dt>Teléfono</dt><dd>{selected.contact_phone || "Sin teléfono"}</dd></div>
                  <div><dt>Correo</dt><dd className="admin-break">{selected.owner_email || "Sin correo"}</dd></div>
                  <div><dt>Actualizada</dt><dd>{formatDate(selected.updated_at)}</dd></div>
                  <div><dt>Identificador</dt><dd className="admin-mono admin-break">{selected.id}</dd></div>
                </dl>
                <div className="admin-inbox__actions">
                  {url ? <a className="admin-btn admin-btn--secondary" href={url} target="_blank" rel="noreferrer"><ArrowUpRight size={14} />WhatsApp</a> : null}
                  {selected.owner_email ? <a className="admin-btn admin-btn--secondary" href={`mailto:${selected.owner_email}?subject=${encodeURIComponent(`PALMYRA · ${selected.subject}`)}`}><Mail size={14} />Correo</a> : null}
                  {selected.status !== "in_progress" ? <Button disabled={busyId === selected.id} onClick={() => void changeStatus(selected, "in_progress")}><Clock3 size={14} />En proceso</Button> : null}
                  {selected.status !== "resolved" ? <Button variant="primary" disabled={busyId === selected.id} onClick={() => void changeStatus(selected, "resolved")}><Check size={14} />Resolver</Button> : null}
                  {selected.status !== "closed" ? <Button variant="ghost" disabled={busyId === selected.id} onClick={() => void changeStatus(selected, "closed")}><X size={14} />Cerrar</Button> : null}
                  {selected.status === "resolved" || selected.status === "closed" ? <Button variant="secondary" disabled={busyId === selected.id} onClick={() => void changeStatus(selected, "open")}><RotateCcw size={14} />Reabrir</Button> : null}
                </div>
              </article>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
