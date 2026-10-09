import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, ArrowDownRight, ArrowDownUp, ArrowUpRight, BarChart3,
  CheckCircle2, Clock3, RefreshCw, ShieldCheck, TrendingDown, TrendingUp
} from "lucide-react";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";

type Rate = { code: string; name: string; value?: number; buy?: number; sell?: number };
type Payload = { source?: string; capturedAt?: string; data?: any; error?: string; configured?: boolean };
type Snapshot = { capturedAt: string; rates: Record<string, number> };
type Period = "24h" | "7d" | "30d" | "all";

const HISTORY_KEY = "palmyra.exchange-rate-history.v1";
const HISTORY_LIMIT = 2500;
const REFRESH_MS = 5 * 60 * 1000;

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}
function getRates(data: any): Rate[] {
  if (!data || typeof data !== "object") return [];
  const candidates = [data.rates, data.data, data.result, data.tasas, data.exchangeRates, data.cotizaciones];
  const list = candidates.find(Array.isArray) ?? candidates.find((x) => x && typeof x === "object") ?? data;
  const makeRate = (raw: any, fallbackCode: string, index: number): Rate | null => {
    if (!raw || typeof raw !== "object") {
      const value = numeric(raw);
      return value === undefined ? null : { code: fallbackCode, name: fallbackCode, value };
    }
    const code = String(raw.code ?? raw.currency ?? raw.moneda ?? raw.symbol ?? raw.codigo ?? fallbackCode ?? `RATE-${index + 1}`).toUpperCase();
    const value = numeric(raw.rate ?? raw.value ?? raw.valor ?? raw.tasa ?? raw.median ?? raw.mediana ?? raw.trm ?? raw.promedio ?? raw.price ?? raw.precio ?? raw.last);
    const buy = numeric(raw.buy ?? raw.compra ?? raw.bid ?? raw.tasa_compra);
    const sell = numeric(raw.sell ?? raw.venta ?? raw.ask ?? raw.tasa_venta);
    if (value === undefined && buy === undefined && sell === undefined) return null;
    const names: Record<string, string> = { USD: "Dólar estadounidense", EUR: "Euro", MLC: "Moneda libremente convertible", CAD: "Dólar canadiense", MXN: "Peso mexicano" };
    return { code, name: String(raw.name ?? raw.nombre ?? raw.description ?? names[code] ?? code), value, buy, sell };
  };
  if (Array.isArray(list)) return list.map((r, i) => makeRate(r, "", i)).filter((r): r is Rate => Boolean(r));
  return Object.entries(list).flatMap(([code, raw], i) => {
    const rate = makeRate(raw, code, i);
    return rate ? [rate] : [];
  });
}
function money(value: unknown) {
  const n = numeric(value);
  return n === undefined ? "—" : new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(n);
}
function readHistory(): Snapshot[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => x?.capturedAt && x?.rates && typeof x.rates === "object").slice(-HISTORY_LIMIT) : [];
  } catch { return []; }
}
function percentChange(current?: number, previous?: number) {
  if (current === undefined || previous === undefined || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
function formatDate(value: string, withDate = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", withDate
    ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" }).format(date);
}
function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs font-semibold text-muted">Sin historial comparable</span>;
  const up = value > 0.00001;
  const down = value < -0.00001;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Activity;
  const color = up ? "text-emerald-700 bg-emerald-50" : down ? "text-rose-700 bg-rose-50" : "text-muted bg-subtle";
  return <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${color}`}><Icon className="h-3.5 w-3.5" />{value > 0 ? "+" : ""}{value.toFixed(2)}%</span>;
}

export default function ExchangeRate() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Snapshot[]>(readHistory);
  const [period, setPeriod] = useState<Period>("7d");
  const [selectedCode, setSelectedCode] = useState("");
  const [lastAttempt, setLastAttempt] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/exchange-rates", { headers: { Accept: "application/json" }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Error HTTP ${response.status}`);
      setPayload(body);
      const capturedAt = typeof body.capturedAt === "string" ? body.capturedAt : new Date().toISOString();
      setLastAttempt(new Date().toISOString());
      const rates = getRates(body.data);
      const values = Object.fromEntries(rates.flatMap((rate) => {
        const value = rate.value ?? rate.sell ?? rate.buy;
        return value === undefined ? [] : [[rate.code, value]];
      }));
      if (Object.keys(values).length) {
        setHistory((previous) => {
          const last = previous[previous.length - 1];
          const sameValues = last && Object.keys(values).length === Object.keys(last.rates).length
            && Object.entries(values).every(([code, value]) => last.rates[code] === value);
          if (sameValues && Date.now() - new Date(last.capturedAt).getTime() < REFRESH_MS - 5000) return previous;
          return [...previous, { capturedAt, rates: values }].slice(-HISTORY_LIMIT);
        });
      }
    } catch (e: any) {
      setError(e?.message || "No se pudo conectar con el servicio de tasas.");
      setLastAttempt(new Date().toISOString());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, REFRESH_MS);
    const onFocus = () => { if (document.visibilityState === "visible") void load(true); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus); };
  }, [load]);

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT))); } catch { /* Storage may be disabled or full. */ }
  }, [history]);

  const rates = useMemo(() => getRates(payload?.data), [payload]);
  useEffect(() => {
    if (rates.length && (!selectedCode || !rates.some((rate) => rate.code === selectedCode))) setSelectedCode(rates[0].code);
  }, [rates, selectedCode]);

  const selectedRate = rates.find((rate) => rate.code === selectedCode) ?? rates[0];
  const now = Date.now();
  const cutoff = period === "24h" ? now - 24 * 60 * 60 * 1000
    : period === "7d" ? now - 7 * 24 * 60 * 60 * 1000
    : period === "30d" ? now - 30 * 24 * 60 * 60 * 1000 : 0;
  const chartData = history
    .filter((item) => new Date(item.capturedAt).getTime() >= cutoff && item.rates[selectedCode] !== undefined)
    .map((item) => ({ timestamp: item.capturedAt, label: formatDate(item.capturedAt, period !== "24h"), value: item.rates[selectedCode] }));
  const currentValue = selectedRate?.value ?? selectedRate?.sell ?? selectedRate?.buy;
  const comparable = chartData.length > 1 ? chartData[0].value : undefined;
  const change = percentChange(currentValue, comparable);
  const updated = payload?.capturedAt ? formatDate(payload.capturedAt, true) : "";
  const statusText = error ? "Con incidencias" : payload ? "Fuente consultada" : "Esperando datos";

  return <div className="h-full w-full overflow-y-auto bg-primary px-3 py-4 sm:px-5 sm:py-6">
    <div className="mx-auto max-w-7xl space-y-5 pb-8">
      <section className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
        <header className="bg-gradient-to-r from-violet-950 via-indigo-900 to-violet-800 px-5 py-6 text-white sm:px-7">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/10"><BarChart3 className="h-6 w-6" /></div>
              <div>
                <p className="text-[9px] font-black uppercase tracking-[.2em] text-violet-200">PALMYRA · INTELIGENCIA DE MERCADO</p>
                <h1 className="mt-1 text-2xl font-black sm:text-3xl">Tasa de cambio</h1>
                <p className="mt-1 max-w-2xl text-xs text-violet-100">Cotizaciones de referencia y seguimiento de su evolución.</p>
              </div>
            </div>
            <button onClick={() => void load(true)} disabled={loading || refreshing} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-bold transition hover:bg-white/20 disabled:opacity-60">
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> {refreshing ? "Actualizando…" : "Actualizar datos"}
            </button>
          </div>
        </header>
        <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 rounded-xl p-2 ${error ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>{error ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}</div>
            <div>
              <p className="text-sm font-extrabold text-primary">Fuente: elTOQUE</p>
              <p className="mt-1 text-xs leading-5 text-muted">{error ? "No se pudo confirmar una actualización reciente. Se conservan los últimos datos disponibles." : "Valores de referencia del mercado informal; no equivalen a una tasa oficial ni garantizan una operación."}</p>
              {error && <p role="alert" className="mt-1 text-xs font-semibold text-amber-700">{error}</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted lg:justify-end">
            <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" /> {updated ? `Dato: ${updated}` : "Sin fecha de cotización"}</span>
            <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" /> {statusText}</span>
            <span className="inline-flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> Revisión cada 5 min</span>
          </div>
        </div>
      </section>

      {loading && !payload && <div className="rounded-2xl border border-base bg-secondary p-6 text-sm text-muted" aria-live="polite">Consultando las cotizaciones de elTOQUE…</div>}

      {rates.length > 0 && <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rates.map((rate) => {
          const value = rate.value ?? rate.sell ?? rate.buy;
          const active = selectedCode === rate.code;
          const previous = [...history].reverse().find((snapshot) => snapshot.rates[rate.code] !== undefined && snapshot.capturedAt !== payload?.capturedAt)?.rates[rate.code];
          const delta = percentChange(value, previous);
          return <button key={rate.code} type="button" onClick={() => setSelectedCode(rate.code)} className={`min-w-0 rounded-2xl border bg-secondary p-4 text-left shadow-sm transition hover:border-violet-300 hover:shadow-md ${active ? "border-violet-400 ring-2 ring-violet-500/10" : "border-base"}`}>
            <div className="flex items-start justify-between gap-2">
              <div><p className="text-[10px] font-black uppercase tracking-[.15em] text-violet-700">{rate.code} <span className="text-muted">/ CUP</span></p><h2 className="mt-1 text-sm font-bold text-primary">{rate.name}</h2></div>
              <span className="rounded-lg bg-subtle p-2 text-violet-700"><ArrowDownUp className="h-4 w-4" /></span>
            </div>
            <p className="mt-5 break-words text-2xl font-black tracking-tight text-primary sm:text-3xl">{money(value)} <span className="text-xs font-semibold text-muted">CUP</span></p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><Delta value={delta} /><span className="text-[10px] text-muted">{rate.buy !== undefined || rate.sell !== undefined ? "Compra y venta disponibles" : "Tasa de referencia"}</span></div>
          </button>;
        })}
      </section>}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,.85fr)]">
        <div className="min-w-0 rounded-2xl border border-base bg-secondary p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div><p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-700">Análisis histórico</p><h2 className="mt-1 text-lg font-extrabold text-primary">Evolución de la cotización</h2><p className="mt-1 text-xs text-muted">{selectedRate ? `${selectedRate.code} frente al CUP` : "Selecciona una moneda para analizarla"}</p></div>
            <div className="flex flex-wrap gap-1 rounded-xl bg-subtle p-1">
              {([{ id: "24h", label: "24 h" }, { id: "7d", label: "7 días" }, { id: "30d", label: "30 días" }, { id: "all", label: "Todo" }] as const).map((item) =>
                <button key={item.id} onClick={() => setPeriod(item.id)} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${period === item.id ? "bg-secondary text-violet-700 shadow-sm" : "text-muted hover:text-primary"}`}>{item.label}</button>)}
            </div>
          </div>
          <div className="mt-5 h-[260px] w-full">
            {chartData.length >= 2 ? <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="var(--border-base)" strokeDasharray="3 5" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis domain={["auto", "auto"]} width={58} tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} tickFormatter={(v) => new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 2 }).format(v)} />
                <Tooltip formatter={(value) => [`${money(value)} CUP`, "Cotización"]} labelFormatter={(label) => `Fecha: ${label}`} contentStyle={{ borderRadius: 12, borderColor: "var(--border-base)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: 12 }} />
                <Line type="monotone" dataKey="value" stroke="#7C4DDE" strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} connectNulls />
              </LineChart>
            </ResponsiveContainer> : <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-base bg-primary px-5 text-center">
              <div className="rounded-xl bg-subtle p-3 text-violet-700"><BarChart3 className="h-6 w-6" /></div>
              <p className="mt-3 text-sm font-bold text-primary">{chartData.length === 1 ? "Primer registro guardado" : "Recopilando historial real"}</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted">{chartData.length === 1 ? "La gráfica aparecerá cuando se registre otra cotización distinta o en la siguiente consulta periódica." : "Las cotizaciones se guardan en este navegador cuando la sección consulta la API. No se inventan puntos históricos."}</p>
            </div>}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-base pt-3 text-[10px] text-muted">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Datos capturados, sin valores simulados</span>
            <span>{chartData.length} puntos en el período</span>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm sm:p-5">
            <p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-700">Resumen del período</p>
            <h2 className="mt-1 text-lg font-extrabold text-primary">{selectedRate?.code ?? "Cotización"}</h2>
            <div className="mt-4 rounded-xl bg-primary p-4">
              <p className="text-xs font-semibold text-muted">Valor de referencia actual</p>
              <p className="mt-1 text-2xl font-black text-primary">{money(currentValue)} <span className="text-xs font-semibold text-muted">CUP</span></p>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-base p-3"><span className="text-xs text-muted">Variación frente al inicio</span><Delta value={change} /></div>
            {(selectedRate?.buy !== undefined || selectedRate?.sell !== undefined) && <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-emerald-50 p-3"><p className="text-[10px] font-bold uppercase text-emerald-800">Compra</p><p className="mt-1 text-lg font-black text-emerald-950">{money(selectedRate?.buy)}</p></div>
              <div className="rounded-xl bg-sky-50 p-3"><p className="text-[10px] font-bold uppercase text-sky-800">Venta</p><p className="mt-1 text-lg font-black text-sky-950">{money(selectedRate?.sell)}</p></div>
            </div>}
          </div>
          <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm sm:p-5">
            <div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-violet-700" /><h3 className="text-sm font-extrabold text-primary">Control de actualización</h3></div>
            <div className="mt-3 space-y-3 text-xs">
              <div className="flex items-center justify-between gap-3"><span className="text-muted">Última cotización</span><span className="font-semibold text-primary">{updated || "No disponible"}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="text-muted">Último intento</span><span className="font-semibold text-primary">{lastAttempt ? formatDate(lastAttempt, true) : "—"}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="text-muted">Registros guardados</span><span className="font-semibold text-primary">{history.length}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="text-muted">Estado</span><span className={`font-bold ${error ? "text-amber-700" : "text-emerald-700"}`}>{error ? "Revisar conexión" : "Monitorizando"}</span></div>
            </div>
          </div>
        </aside>
      </section>

      <section className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
        <div className="flex flex-col gap-2 border-b border-base p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div><h2 className="text-base font-extrabold text-primary">Tabla de cotizaciones</h2><p className="mt-1 text-xs text-muted">Valores recibidos directamente de la fuente.</p></div>
          <span className="text-xs text-muted">{rates.length} monedas detectadas</span>
        </div>
        {rates.length ? <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-xs">
            <thead className="bg-primary text-[10px] uppercase tracking-wider text-muted"><tr><th className="px-5 py-3 font-black">Moneda</th><th className="px-5 py-3 font-black">Referencia</th><th className="px-5 py-3 font-black">Compra</th><th className="px-5 py-3 font-black">Venta</th><th className="px-5 py-3 font-black">Variación</th></tr></thead>
            <tbody>{rates.map((rate) => {
              const value = rate.value ?? rate.sell ?? rate.buy;
              const previous = [...history].reverse().find((snapshot) => snapshot.rates[rate.code] !== undefined && snapshot.capturedAt !== payload?.capturedAt)?.rates[rate.code];
              return <tr key={rate.code} className="border-t border-base transition hover:bg-primary"><td className="px-5 py-3.5"><button onClick={() => setSelectedCode(rate.code)} className="text-left"><span className="font-black text-violet-700">{rate.code}</span><span className="mt-0.5 block text-muted">{rate.name}</span></button></td><td className="px-5 py-3.5 font-bold text-primary">{money(value)}</td><td className="px-5 py-3.5 text-primary">{money(rate.buy)}</td><td className="px-5 py-3.5 text-primary">{money(rate.sell)}</td><td className="px-5 py-3.5"><Delta value={percentChange(value, previous)} /></td></tr>;
            })}</tbody>
          </table>
        </div> : <div className="p-6 text-sm text-muted">{error ? "No hay cotizaciones disponibles. Comprueba la conexión y vuelve a intentarlo." : "Las cotizaciones aparecerán cuando la API responda con datos reconocibles."}</div>}
      </section>

      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <p><strong>Transparencia y control.</strong> Las tasas son informativas y no modifican automáticamente precios, costos, inventario ni operaciones del POS. El historial se conserva en este navegador; para recopilar cotizaciones mientras nadie tiene abierta esta sección y compartirlas entre dispositivos, se necesitaría un almacenamiento histórico central y un proceso programado en el servidor.</p>
      </div>
    </div>
  </div>;
}
