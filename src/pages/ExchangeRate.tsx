import { useCallback, useEffect, useState } from "react";
import { ArrowDownUp, RefreshCw, Clock3, AlertCircle } from "lucide-react";

type Rate = { code: string; name: string; value?: unknown; buy?: unknown; sell?: unknown };
type Payload = { source?: string; capturedAt?: string; data?: any; error?: string };

function getRates(data: any): Rate[] {
  if (!data || typeof data !== "object") return [];
  const list = Array.isArray(data) ? data : data.rates ?? data.data ?? data.result ?? data.tasas ?? data;
  if (Array.isArray(list)) return list.map((r: any, i: number) => ({
    code: String(r.code ?? r.currency ?? r.moneda ?? r.symbol ?? `Tasa ${i + 1}`),
    name: String(r.name ?? r.nombre ?? r.description ?? r.code ?? r.currency ?? r.moneda ?? `Tasa ${i + 1}`),
    value: r.rate ?? r.value ?? r.valor ?? r.tasa ?? r.median ?? r.mediana,
    buy: r.buy ?? r.compra ?? r.bid, sell: r.sell ?? r.venta ?? r.ask
  }));
  return Object.entries(list).flatMap(([code, raw]: [string, any]) => {
    if (raw && typeof raw === "object") return [{
      code: String(raw.code ?? raw.currency ?? raw.moneda ?? code),
      name: String(raw.name ?? raw.nombre ?? raw.description ?? raw.code ?? code),
      value: raw.rate ?? raw.value ?? raw.valor ?? raw.tasa ?? raw.median ?? raw.mediana,
      buy: raw.buy ?? raw.compra ?? raw.bid, sell: raw.sell ?? raw.venta ?? raw.ask
    }];
    return typeof raw === "number" || typeof raw === "string" ? [{ code, name: code, value: raw }] : [];
  });
}
function money(value: unknown) {
  if (value === undefined || value === null || value === "") return "—";
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(n) : String(value);
}

export default function ExchangeRate() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/exchange-rates", { headers: { Accept: "application/json" }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Error HTTP ${response.status}`);
      setPayload(body);
    } catch (e: any) { setError(e?.message || "No se pudo conectar con el servicio."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const rates = getRates(payload?.data);
  const updated = payload?.capturedAt ? new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(new Date(payload.capturedAt)) : "";

  return <div className="w-full min-h-full overflow-y-auto bg-primary px-3 py-4 sm:px-5 sm:py-6">
    <section className="mx-auto max-w-5xl overflow-hidden rounded-[28px] border border-violet-100 bg-white shadow-xl shadow-violet-950/5">
      <header className="bg-gradient-to-br from-violet-950 via-indigo-900 to-violet-700 px-5 py-7 text-white sm:px-8 sm:py-9">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/10"><ArrowDownUp className="h-6 w-6" /></div>
            <div><p className="text-[9px] font-black uppercase tracking-[0.2em] text-violet-200">PALMYRA · INFORMACIÓN</p>
              <h1 className="mt-1 text-2xl font-black sm:text-3xl">Tasa de cambio</h1>
              <p className="mt-2 text-xs text-violet-100">Tasas de referencia del mercado informal cubano publicadas por elTOQUE.</p>
            </div>
          </div>
          <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-bold hover:bg-white/20 disabled:opacity-60">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {loading ? "Consultando…" : "Actualizar"}
          </button>
        </div>
      </header>
      <div className="grid gap-4 p-4 sm:p-6">
        <div className="flex flex-col gap-2 rounded-2xl border border-violet-100 bg-violet-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="text-sm font-black text-violet-950">Fuente: elTOQUE</h2><p className="mt-1 text-xs text-violet-800/70">Valores referenciales; no son tasas oficiales.</p></div>
          <div className="flex items-center gap-2 text-xs font-semibold text-violet-900"><Clock3 className="h-4 w-4" />{updated ? `Consulta: ${updated}` : "Esperando datos"}</div>
        </div>
        {error && <div role="alert" className="flex gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-900"><AlertCircle className="h-5 w-5 shrink-0" /><div><p className="text-sm font-bold">No se pudieron cargar las tasas</p><p className="mt-1 text-xs">{error}</p><button onClick={() => void load()} className="mt-3 rounded-lg bg-rose-100 px-3 py-2 text-xs font-bold">Reintentar</button></div></div>}
        {loading && !payload && <p className="rounded-xl border border-base bg-secondary p-5 text-sm text-muted">Consultando la API de elTOQUE…</p>}
        {!loading && !error && rates.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{rates.map((r, i) =>
          <article key={r.code + i} className="rounded-2xl border border-base bg-white p-4 shadow-sm">
            <p className="text-xs font-black uppercase tracking-wider text-violet-700">{r.code}</p><h3 className="mt-1 text-sm font-bold text-slate-900">{r.name}</h3>
            {r.value !== undefined && <div className="mt-4"><p className="text-[10px] font-semibold uppercase text-slate-500">Tasa de referencia</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{money(r.value)} <span className="text-xs text-slate-500">CUP</span></p></div>}
            {(r.buy !== undefined || r.sell !== undefined) && <div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl bg-emerald-50 p-2.5"><p className="text-[10px] font-bold uppercase text-emerald-800">Compra</p><p className="mt-1 text-sm font-black text-emerald-950">{money(r.buy)}</p></div><div className="rounded-xl bg-sky-50 p-2.5"><p className="text-[10px] font-bold uppercase text-sky-800">Venta</p><p className="mt-1 text-sm font-black text-sky-950">{money(r.sell)}</p></div></div>}
            {r.value === undefined && r.buy === undefined && r.sell === undefined && <pre className="mt-3 overflow-auto text-xs">{JSON.stringify(r)}</pre>}
          </article>)}</div>}
        {!loading && !error && payload && rates.length === 0 && <div className="rounded-xl border border-base bg-secondary p-4"><p className="text-sm font-bold text-primary">La API respondió, pero el formato de datos necesita adaptación.</p><pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-primary p-3 text-xs text-primary">{JSON.stringify(payload.data, null, 2)}</pre></div>}
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium leading-5 text-amber-900">Información exclusivamente informativa. PALMYRA no cambiará automáticamente precios, costos, inventario ni operaciones del POS.</p>
      </div>
    </section>
  </div>;
}
