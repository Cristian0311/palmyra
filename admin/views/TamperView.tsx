import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Building2, Clock, MonitorSmartphone, RefreshCw, Search, ShieldAlert } from "lucide-react";
import {
  adminErrorMessage,
  loadClockTamperReports,
  type PlatformClockTamperReport,
  type PlatformCompany,
} from "../platformAdminApi";
import { Button, EmptyPanel, LoadingBlock, StatCard, formatDate } from "../shared";

const DAY_MS = 24 * 60 * 60 * 1000;

const KIND_LABELS: Record<string, string> = {
  "wall-rollback": "Retroceso del reloj",
  "monotonic-regression": "Regresión del contador",
  clock_rollback: "Retroceso del reloj",
  wall_rollback: "Retroceso del reloj",
  monotonic_regression: "Regresión del contador",
};

const SOURCE_LABELS: Record<string, string> = {
  watermark: "Marca de agua",
  "server-anchor": "Hora del servidor",
  monotonic: "Contador monotónico",
};

/** Motivo legible del reporte, venga del contrato viejo (`kind`) o del nuevo. */
function reasonOf(report: PlatformClockTamperReport) {
  const key = report.kind || report.reason || "";
  return KIND_LABELS[key] || reasonOfRaw(key);
}

function reasonOfRaw(value?: string | null) {
  if (!value) return "Anomalía de reloj";
  return value.replace(/[_-]+/g, " ");
}

/** Magnitud del retroceso: columna nueva (`skew_ms`) o detalle saneado. */
function skewOf(report: PlatformClockTamperReport) {
  const fromColumn = Number(report.skew_ms);
  if (Number.isFinite(fromColumn) && fromColumn > 0) return fromColumn;
  const fromDetail = Number((report.detail as { skewMs?: unknown } | null | undefined)?.skewMs);
  return Number.isFinite(fromDetail) && fromDetail > 0 ? fromDetail : 0;
}

function skewLabel(value?: number | null) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "sin magnitud";
  const minutes = ms / 60_000;
  if (minutes >= 120) return `${(minutes / 60).toFixed(1)} h`;
  if (minutes >= 1) return `${Math.round(minutes)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** Un reporte reciente es el que se detectó en las últimas 24 horas. */
function isRecent(value?: string | null, now = Date.now()) {
  const stamp = Date.parse(String(value || ""));
  return Number.isFinite(stamp) && now - stamp <= DAY_MS && now - stamp >= 0;
}

export default function TamperView({ companies = [] }: { companies?: PlatformCompany[] }) {
  const [reports, setReports] = useState<PlatformClockTamperReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setReports(await loadClockTamperReports(200));
    } catch (err) {
      setError(adminErrorMessage(err, "No se pudieron cargar los reportes de seguridad."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const companyNames = useMemo(() => {
    const map = new Map<string, string>();
    companies.forEach((company) => map.set(company.id, company.name));
    return map;
  }, [companies]);

  const companyName = (report: PlatformClockTamperReport) =>
    report.company_name || companyNames.get(report.company_id) || `Empresa ${report.company_id.slice(0, 8)}`;

  const now = Date.now();
  const last24h = useMemo(
    () => reports.filter((report) => isRecent(report.detected_at, now)).length,
    [reports, now],
  );
  const devices = useMemo(
    () => new Set(reports.map((report) => report.device_id || "sin-equipo")).size,
    [reports],
  );
  const involvedCompanies = useMemo(
    () => new Set(reports.map((report) => report.company_id)).size,
    [reports],
  );

  const kinds = useMemo(() => {
    const values = new Set(
      reports.map((report) => report.kind || report.reason).filter((value): value is string => Boolean(value)),
    );
    return [...values].sort();
  }, [reports]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reports.filter((report) => {
      const matchesQuery = !q || [
        companyName(report),
        report.device_id,
        report.lease_id,
        reasonOf(report),
        SOURCE_LABELS[report.source || ""] || report.source,
      ].some((value) => String(value || "").toLowerCase().includes(q));
      return matchesQuery && (kind === "all" || (report.kind || report.reason) === kind);
    });
  }, [reports, query, kind, companyNames]);

  const hasFilters = Boolean(query.trim()) || kind !== "all";

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">SEGURIDAD</p>
          <h1>Si un equipo atrasa su reloj, aquí se ve.</h1>
          <p>
            Cada detección de la guarda de licencia se envía al reconectar. Solo se registra la clase
            de anomalía, el origen, la magnitud y la fecha: nunca datos personales ni credenciales.
          </p>
        </div>
        <Button onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spin" : ""} />Actualizar
        </Button>
      </section>

      <section className="admin-stat-grid">
        <StatCard
          label="Últimas 24 h"
          value={last24h}
          detail="Detecciones reportadas"
          icon={ShieldAlert}
          tone={last24h > 0 ? "amber" : "green"}
        />
        <StatCard
          label="Reportes"
          value={reports.length}
          detail="Cargados desde el servidor"
          icon={Clock}
          tone="slate"
        />
        <StatCard
          label="Equipos"
          value={devices}
          detail="Dispositivos implicados"
          icon={MonitorSmartphone}
          tone="violet"
        />
        <StatCard
          label="Empresas"
          value={involvedCompanies}
          detail="Negocios implicados"
          icon={Building2}
          tone="slate"
        />
      </section>

      <section className="admin-toolbar">
        <div className="admin-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por empresa, equipo, motivo u origen…"
            aria-label="Buscar en reportes de seguridad"
          />
        </div>
        <div className="admin-toolbar__extra">
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Filtrar por motivo">
            <option value="all">Todos los motivos</option>
            {kinds.map((value) => (
              <option key={value} value={value}>{KIND_LABELS[value] || reasonOfRaw(value)}</option>
            ))}
          </select>
          {hasFilters ? (
            <Button variant="ghost" onClick={() => { setQuery(""); setKind("all"); }}>Limpiar</Button>
          ) : null}
        </div>
      </section>

      {error ? (
        <div className="admin-global-error" role="alert">
          <AlertCircle size={16} />{error}
          <Button variant="ghost" onClick={() => void refresh()}>Reintentar</Button>
        </div>
      ) : null}

      <section className="admin-panel">
        <div className="admin-panel__head">
          <div><p className="admin-kicker">TELEMETRÍA DE RELOJ</p><h2>Reportes recientes</h2></div>
          <ShieldAlert size={17} />
        </div>

        {loading ? <LoadingBlock label="Cargando reportes de seguridad…" /> : null}

        {!loading && filtered.length === 0 ? (
          <EmptyPanel
            title={reports.length === 0 ? "Sin reportes de manipulación" : "Ningún reporte coincide con el filtro"}
            description={
              reports.length === 0
                ? "Cuando un equipo atrase su reloj, la detección se enviará al reconectar y aparecerá aquí."
                : "Prueba con otro equipo, empresa o motivo."
            }
            action={hasFilters ? <Button onClick={() => { setQuery(""); setKind("all"); }}>Limpiar filtros</Button> : undefined}
          />
        ) : null}

        {!loading && filtered.length > 0 ? (
          <div className="admin-audit-list">
            {filtered.map((report) => {
              const recent = isRecent(report.detected_at, now);
              return (
                <article key={report.id} className="admin-audit-row">
                  <span className="admin-audit-dot" aria-hidden="true" />
                  <div className="admin-audit-main">
                    <strong>{reasonOf(report)}</strong>
                    <span>
                      {companyName(report)} · {report.device_id ? `Equipo ${report.device_id}` : "Equipo sin identificar"}
                    </span>
                    <span>
                      {formatDate(report.detected_at)} · {SOURCE_LABELS[report.source || ""] || report.source || "origen no informado"} · Δ {skewLabel(skewOf(report))}
                    </span>
                    {report.lease_id ? <span className="admin-audit-detail">Lease {report.lease_id}</span> : null}
                  </div>
                  <span className="admin-audit-actor">
                    <span className={`admin-status admin-status--${recent ? "amber" : "slate"}`}>
                      <span />{recent ? "Últimas 24 h" : "Anterior"}
                    </span>
                  </span>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
