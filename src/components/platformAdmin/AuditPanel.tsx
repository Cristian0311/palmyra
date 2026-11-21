import { useEffect, useMemo, useState } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import { loadPlatformAudit, type PlatformAuditEntry } from "../../services/platformAdminConsole";
import type { AdminContext } from "./types";
import { Empty, FilterTabs, Pager, SearchBox, SectionCard, auditLabel, fmtDate, pageSlice } from "./ui";

type Filter = "all" | "plan" | "company" | "subscription" | "support";

export default function AuditPanel({ ctx }: { ctx: AdminContext }) {
  const { version } = ctx;
  const [rows, setRows] = useState<PlatformAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await loadPlatformAudit(300));
    } catch (err: any) {
      setError(err?.message || "No se pudo cargar la auditoría.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); setPage(1); }, [version]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesQ = !needle || [row.actor_email, row.company_name, row.action, JSON.stringify(row.detail || {})].some((value) => String(value || "").toLowerCase().includes(needle));
      const matchesFilter = filter === "all" || String(row.action || "").startsWith(filter === "plan" ? "plan_request" : filter === "company" ? "company" : filter === "subscription" ? "subscription" : "support");
      return matchesQ && matchesFilter;
    });
  }, [rows, q, filter]);

  const paged = pageSlice(filtered, page, 14);

  return (
    <SectionCard title="Auditoría de plataforma" subtitle="Quién hizo qué, sobre qué empresa y cuándo." icon={<ScrollText className="h-4 w-4" />}
      action={<button type="button" disabled={loading} onClick={() => void load()} className="flex h-8 items-center gap-1.5 rounded-lg border border-base px-2.5 text-[10px] font-black text-primary disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar</button>}>
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
        <SearchBox value={q} onChange={setQ} placeholder="Buscar por operador, empresa, acción o detalle…" />
        <FilterTabs<Filter> value={filter} onChange={setFilter} options={[
          ["all", "Todo"], ["plan", "Planes"], ["company", "Empresas"], ["subscription", "Suscripción"], ["support", "Soporte"],
        ]} />
      </div>

      {error ? <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] font-bold text-rose-700">{error}</div> : null}
      {loading ? <p className="mt-3 text-xs font-bold text-muted">Cargando auditoría…</p> : null}

      {!loading ? (
        <div className="mt-3 divide-y divide-[color:var(--border-base)] overflow-hidden rounded-2xl border border-base">
          {paged.slice.map((row) => (
            <div key={row.id} className="bg-primary px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <p className="text-[11px] font-black text-primary">{auditLabel(row.action)}</p>
                <p className="text-[9px] font-bold text-muted">{fmtDate(row.created_at)}</p>
              </div>
              <p className="mt-0.5 text-[10px] font-bold text-muted">{row.company_name || "Plataforma"} · {row.actor_email || "Sistema"}</p>
              {row.detail && Object.keys(row.detail).length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(row.detail).filter(([, value]) => value != null && value !== "").slice(0, 6).map(([key, value]) => (
                    <span key={key} className="rounded bg-subtle px-1.5 py-0.5 text-[8px] font-bold text-muted">{key}: {String(value).slice(0, 60)}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {paged.slice.length === 0 ? <div className="p-3"><Empty title="Sin registros" description="Ajusta la búsqueda o el filtro." /></div> : null}
        </div>
      ) : null}

      <div className="mt-3"><Pager page={paged.page} pages={paged.pages} total={paged.total} onPage={setPage} /></div>
      <p className="mt-2 text-[9px] leading-4 text-muted">La auditoría es inmutable desde la consola: solo lectura. Se guarda automáticamente en cada aprobación, rechazo, suspensión y cambio de plan.</p>
    </SectionCard>
  );
}
