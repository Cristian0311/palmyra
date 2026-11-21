import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Headphones, Loader2, MessageCircle, RefreshCw, XCircle } from "lucide-react";
import { setSupportRequestStatus } from "../../services/platformAdmin";
import { loadPlatformSupportRequests } from "../../services/platformAdminConsole";
import type { AdminContext } from "./types";
import { Badge, Empty, FilterTabs, Pager, SectionCard, fmtDate, pageSlice } from "./ui";

type SupportRow = {
  id: string; company_id: string; company_name: string; request_type: string; subject: string; message: string;
  contact_phone?: string | null; owner_email?: string | null; status: string; created_at: string; updated_at: string;
};

export default function SupportPanel({ ctx }: { ctx: AdminContext }) {
  const { busy, run, version } = ctx;
  const [filter, setFilter] = useState<"open" | "in_progress" | "resolved" | "closed" | "all">("open");
  const [rows, setRows] = useState<SupportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [page, setPage] = useState(1);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setRows((await loadPlatformSupportRequests(filter)) as SupportRow[]);
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar las solicitudes de atención.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); setPage(1); }, [filter, version]);

  const counts = useMemo(() => ({
    open: rows.filter((row) => row.status === "open").length,
    inProgress: rows.filter((row) => row.status === "in_progress").length,
  }), [rows]);

  const paged = pageSlice(rows, page, 8);

  const update = async (row: SupportRow, status: "in_progress" | "resolved" | "closed") => {
    const message = status === "resolved" ? "Solicitud resuelta." : status === "closed" ? "Solicitud cerrada." : "Solicitud marcada en atención.";
    await run(() => setSupportRequestStatus(row.id, status), message);
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          ["Abiertas", ctx.overview?.support_open ?? counts.open, "Sin atender"],
          ["En atención", ctx.overview?.support_in_progress ?? counts.inProgress, "En curso"],
          ["En esta vista", rows.length, "Según filtro"],
          ["Canal", "WhatsApp", "Soporte oficial"],
        ].map(([label, value, detail]) => (
          <div key={String(label)} className="rounded-2xl border border-base bg-secondary p-3.5">
            <p className="text-[9px] font-black uppercase tracking-[.14em] text-muted">{label}</p>
            <p className="mt-1.5 text-lg font-black text-primary">{value as any}</p>
            <p className="text-[9px] font-bold text-muted">{detail as string}</p>
          </div>
        ))}
      </div>

      <SectionCard title="Centro de atención" subtitle="Cada cambio de estado es visible para la empresa que escribió." icon={<Headphones className="h-4 w-4" />}
        action={<button type="button" disabled={loading} onClick={() => void load()} className="flex h-8 items-center gap-1.5 rounded-lg border border-base px-2.5 text-[10px] font-black text-primary disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar</button>}>
        <FilterTabs<"open" | "in_progress" | "resolved" | "closed" | "all"> value={filter} onChange={setFilter} options={[
          ["open", "Abiertas"], ["in_progress", "En atención"], ["resolved", "Resueltas"], ["closed", "Cerradas"], ["all", "Todas"],
        ]} />
        {error ? <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] font-bold text-rose-700">{error}</div> : null}
        {loading ? <p className="mt-3 flex items-center gap-2 text-xs font-bold text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Cargando solicitudes…</p> : null}

        <div className="mt-3 space-y-2">
          {!loading && rows.length === 0 ? <Empty title="Sin solicitudes en este estado" description="Cuando una empresa escriba desde el CRM aparecerá aquí." /> : null}
          {paged.slice.map((row) => (
            <article key={row.id} className="rounded-2xl border border-base bg-primary p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-black text-primary">{row.company_name || "Empresa"}</p>
                    <Badge status={row.status} />
                  </div>
                  <p className="mt-0.5 text-[10px] font-bold text-muted">{row.request_type} · {row.subject}</p>
                </div>
                <p className="text-[9px] font-bold text-muted">{fmtDate(row.created_at)}</p>
              </div>

              <p className={`mt-2 text-[11px] leading-5 text-muted ${expanded === row.id ? "" : "line-clamp-2"}`}>{row.message}</p>
              {row.message.length > 160 ? (
                <button type="button" onClick={() => setExpanded(expanded === row.id ? "" : row.id)} className="mt-0.5 text-[9px] font-black text-violet-600">
                  {expanded === row.id ? "Ocultar mensaje" : "Leer completo"}
                </button>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <p className="mr-auto flex items-center gap-1 text-[9px] font-bold text-muted">
                  <MessageCircle className="h-3 w-3" />
                  {row.contact_phone || row.owner_email || "Sin contacto"}
                </p>
                {row.status !== "in_progress" && row.status !== "resolved" && row.status !== "closed" ? <button type="button" disabled={busy} onClick={() => void update(row, "in_progress")} className="h-8 rounded-lg border border-base px-2.5 text-[10px] font-black text-primary disabled:opacity-50">En atención</button> : null}
                {row.status !== "resolved" ? <button type="button" disabled={busy} onClick={() => void update(row, "resolved")} className="flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 text-[10px] font-black text-white disabled:opacity-50"><CheckCircle2 className="h-3.5 w-3.5" />Resolver</button> : null}
                {row.status !== "closed" ? <button type="button" disabled={busy} onClick={() => void update(row, "closed")} className="flex h-8 items-center gap-1 rounded-lg border border-base px-2.5 text-[10px] font-black text-muted disabled:opacity-50"><XCircle className="h-3.5 w-3.5" />Cerrar</button> : null}
              </div>
            </article>
          ))}
        </div>
        <div className="mt-3"><Pager page={paged.page} pages={paged.pages} total={paged.total} onPage={setPage} /></div>
      </SectionCard>
    </div>
  );
}
