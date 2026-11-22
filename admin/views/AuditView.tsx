import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, Download, RefreshCw, Search } from "lucide-react";
import { adminErrorMessage, loadAdminAudit, type PlatformAuditEntry } from "../platformAdminApi";
import { ACTION_LABELS, Button, EmptyPanel, LoadingBlock, auditDetailText, downloadCsv, formatDate } from "../shared";

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export default function AuditView() {
  const [entries, setEntries] = useState<PlatformAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("all");
  const [company, setCompany] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setEntries(await loadAdminAudit(500));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const actions = useMemo(() => {
    const values = new Set(entries.map((entry) => entry.action));
    return [...values].sort((a, b) => (ACTION_LABELS[a] || a).localeCompare(ACTION_LABELS[b] || b, "es"));
  }, [entries]);

  const companies = useMemo(() => {
    const values = new Set(entries.map((entry) => entry.company_name).filter((value): value is string => Boolean(value)));
    return [...values].sort((a, b) => a.localeCompare(b, "es"));
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const start = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const end = to ? new Date(`${to}T23:59:59`).getTime() : null;
    return entries.filter((entry) => {
      const stamp = new Date(entry.created_at).getTime();
      const matchesQuery = !q || [entry.action, ACTION_LABELS[entry.action], entry.company_name, entry.actor_email, auditDetailText(entry.detail)]
        .some((value) => String(value || "").toLowerCase().includes(q));
      return (
        matchesQuery &&
        (action === "all" || entry.action === action) &&
        (company === "all" || entry.company_name === company) &&
        (start == null || stamp >= start) &&
        (end == null || stamp <= end)
      );
    });
  }, [entries, query, action, company, from, to]);

  const hasFilters = Boolean(query.trim()) || action !== "all" || company !== "all" || Boolean(from) || Boolean(to);

  const clearFilters = () => {
    setQuery("");
    setAction("all");
    setCompany("all");
    setFrom("");
    setTo("");
  };

  const exportRows = () => {
    downloadCsv(`palmyra-auditoria-${todayStamp()}.csv`, [
      ["Fecha", "Acción", "Empresa", "Administrador", "Detalle"],
      ...filtered.map((entry) => [
        formatDate(entry.created_at),
        ACTION_LABELS[entry.action] || entry.action,
        entry.company_name || "Plataforma",
        entry.actor_email || "Sistema",
        auditDetailText(entry.detail),
      ]),
    ]);
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">AUDITORÍA</p><h1>Cada decisión, con fecha y responsable.</h1><p>Aprobaciones, rechazos, cambios de estado, asignaciones de plan y triage de soporte quedan registrados automáticamente.</p></div>
        <Button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />Actualizar</Button>
      </section>

      <section className="admin-toolbar">
        <div className="admin-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por empresa, acción, detalle o administrador…" aria-label="Buscar en auditoría" />
        </div>
        <div className="admin-toolbar__extra">
          <Button variant="secondary" onClick={exportRows} disabled={filtered.length === 0}><Download size={14} />CSV</Button>
        </div>
      </section>

      <section className="admin-filter-bar">
        <label>Acción
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="all">Todas las acciones</option>
            {actions.map((value) => <option key={value} value={value}>{ACTION_LABELS[value] || value}</option>)}
          </select>
        </label>
        <label>Empresa
          <select value={company} onChange={(event) => setCompany(event.target.value)}>
            <option value="all">Todas las empresas</option>
            {companies.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>Desde
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>Hasta
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <div className="admin-filter-bar__actions">
          {hasFilters ? <Button variant="ghost" onClick={clearFilters}>Limpiar</Button> : null}
          <span className="admin-muted">{filtered.length} registro(s)</span>
        </div>
      </section>

      {error ? (
        <div className="admin-global-error" role="alert">
          <AlertCircle size={16} />{error}
          <Button variant="ghost" onClick={() => void refresh()}>Reintentar</Button>
        </div>
      ) : null}

      <section className="admin-panel">
        <div className="admin-panel__head"><div><p className="admin-kicker">REGISTRO</p><h2>Historial administrativo</h2></div><Activity size={17} /></div>
        {loading ? <LoadingBlock label="Cargando auditoría…" /> : null}
        {!loading && filtered.length === 0 ? (
          <EmptyPanel
            title={entries.length === 0 ? "Sin movimientos registrados" : "No hay movimientos con esos filtros"}
            description={entries.length === 0 ? "Las acciones nuevas aparecerán aquí en cuanto ocurran." : "Ajusta la acción, la empresa o el rango de fechas."}
            action={hasFilters ? <Button onClick={clearFilters}>Limpiar filtros</Button> : undefined}
          />
        ) : null}
        {!loading && filtered.length > 0 ? (
          <div className="admin-audit-list">
            {filtered.map((entry) => (
              <article key={entry.id} className="admin-audit-row">
                <span className="admin-audit-dot" aria-hidden="true" />
                <div className="admin-audit-main">
                  <strong>{ACTION_LABELS[entry.action] || entry.action}</strong>
                  <span>{entry.company_name || "Plataforma"} · {formatDate(entry.created_at)}</span>
                  {auditDetailText(entry.detail) ? <span className="admin-audit-detail">{auditDetailText(entry.detail)}</span> : null}
                </div>
                <span className="admin-audit-actor">{entry.actor_email || "Sistema"}</span>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
