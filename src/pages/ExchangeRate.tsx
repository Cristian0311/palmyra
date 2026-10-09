import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, BarChart3,
  CheckCircle2, RefreshCw, ShieldCheck, TrendingDown, TrendingUp
} from "lucide-react";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";

type Rate = {
  code: string;
  sourceCode: string;
  name: string;
  country: string;
  value?: number;
  buy?: number;
  sell?: number;
};
type Payload = { source?: string; capturedAt?: string; data?: any; error?: string; configured?: boolean };
type Snapshot = { capturedAt: string; rates: Record<string, number> };
type Period = "24h" | "7d" | "30d" | "all";
type MarketTab = "divisas" | "crypto";

const HISTORY_KEY = "palmyra.exchange-rate-history.v1";
const HISTORY_LIMIT = 2500;
const REFRESH_MS = 5 * 60 * 1000;

const ASSET_META: Record<string, { name: string; country: string }> = {
  USD: { name: "Dólar estadounidense", country: "Estados Unidos · uso oficial también en Ecuador" },
  EUR: { name: "Euro", country: "Zona euro" },
  ECU: { name: "Euro", country: "Zona euro" },
  MLC: { name: "Moneda libremente convertible", country: "Cuba · saldo en USD" },
  CAD: { name: "Dólar canadiense", country: "Canadá" },
  MXN: { name: "Peso mexicano", country: "México" },
  GBP: { name: "Libra esterlina", country: "Reino Unido" },
  CHF: { name: "Franco suizo", country: "Suiza" },
  RUB: { name: "Rublo ruso", country: "Rusia" },
  CUP: { name: "Peso cubano", country: "Cuba" },
  CNY: { name: "Yuan chino", country: "China" },
  JPY: { name: "Yen japonés", country: "Japón" },
  BRL: { name: "Real brasileño", country: "Brasil" },
  COP: { name: "Peso colombiano", country: "Colombia" },
  DOP: { name: "Peso dominicano", country: "República Dominicana" },
  AUD: { name: "Dólar australiano", country: "Australia" },
  NZD: { name: "Dólar neozelandés", country: "Nueva Zelanda" },
  ZELLE: { name: "Zelle · pagos en USD", country: "Estados Unidos · servicio de pagos" },
  CLA: { name: "Clásica", country: "Medio de pago publicado en Cuba" },
  BTC: { name: "Bitcoin", country: "Criptoactivo · red Bitcoin" },
  ETH: { name: "Ethereum", country: "Criptoactivo · red Ethereum" },
  BNB: { name: "BNB", country: "Criptoactivo · BNB Chain" },
  TRX: { name: "TRON", country: "Criptoactivo · red TRON" },
  USDT: { name: "Tether (USDT)", country: "Stablecoin vinculada al USD" },
  USDTTRC20: { name: "Tether (USDT · TRC-20)", country: "Stablecoin · red TRON" },
  USDTTRC: { name: "Tether (USDT · TRC-20)", country: "Stablecoin · red TRON" },
  USDC: { name: "USD Coin (USDC)", country: "Stablecoin vinculada al USD" },
  LTC: { name: "Litecoin", country: "Criptoactivo · red Litecoin" },
  DOGE: { name: "Dogecoin", country: "Criptoactivo · red Dogecoin" },
  SOL: { name: "Solana", country: "Criptoactivo · red Solana" },
  XRP: { name: "XRP", country: "Criptoactivo · red XRP Ledger" },
  TON: { name: "Toncoin", country: "Criptoactivo · red TON" }
};

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rateNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const direct = numeric(value);
    if (direct !== undefined) return direct;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      const parsed = numeric(nested.value ?? nested.rate ?? nested.valor ?? nested.tasa ?? nested.median ?? nested.mediana);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function isCryptoCode(code: string): boolean {
  const compact = code.toUpperCase().replace(/[-_\s]/g, "");
  return /^(BTC|ETH|BNB|TRX|USDT|USDC|LTC|DOGE|SOL|XRP|TON|ADA|BCH|DOT|AVAX|SHIB|LINK|XMR|MATIC|POL)/.test(compact);
}

function getRates(data: any): Rate[] {
  if (!data || typeof data !== "object") return [];
  let list: any = data;
  const containerKeys = ["tasas", "rates", "data", "result", "exchangeRates", "exchange_rates", "cotizaciones"];
  for (let depth = 0; depth < 4 && list && typeof list === "object" && !Array.isArray(list); depth += 1) {
    const looksLikeRate = ["rate", "value", "valor", "tasa", "median", "mediana", "buy", "compra", "sell", "venta"].some((key) => list[key] !== undefined);
    if (looksLikeRate) break;
    const nestedKey = containerKeys.find((key) => list[key] !== undefined && list[key] !== null);
    if (!nestedKey) break;
    list = list[nestedKey];
  }

  const makeRate = (raw: any, fallbackCode: string, index: number): Rate | null => {
    if (!raw || typeof raw !== "object") {
      const value = rateNumber(raw);
      if (value === undefined) return null;
      const sourceCode = (fallbackCode || "RATE-" + (index + 1)).toUpperCase();
      const code = sourceCode === "ECU" ? "EUR" : sourceCode;
      const compact = code.replace(/[-_\s]/g, "");
      const meta = ASSET_META[code] ?? ASSET_META[compact];
      return {
        code, sourceCode,
        name: meta?.name ?? code,
        country: meta?.country ?? "Referencia del mercado informal cubano",
        value
      };
    }
    const sourceCode = String(raw.code ?? raw.currency ?? raw.moneda ?? raw.symbol ?? raw.codigo ?? (fallbackCode || ("RATE-" + (index + 1)))).toUpperCase().trim();
    const code = sourceCode === "ECU" ? "EUR" : sourceCode;
    const compact = code.replace(/[-_\s]/g, "");
    const meta = ASSET_META[code] ?? ASSET_META[compact];
    const value = rateNumber(raw.rate, raw.value, raw.valor, raw.tasa, raw.tasa_referencia, raw.reference, raw.median, raw.mediana, raw.trm, raw.promedio, raw.price, raw.precio, raw.last, raw.rate_mid, raw.compra_venta);
    const buy = rateNumber(raw.buy, raw.compra, raw.bid, raw.tasa_compra, raw.median_buy, raw.mediana_compra, raw.compra_mediana, raw.rate_buy);
    const sell = rateNumber(raw.sell, raw.venta, raw.ask, raw.tasa_venta, raw.median_sell, raw.mediana_venta, raw.venta_mediana, raw.rate_sell);
    if (value === undefined && buy === undefined && sell === undefined) return null;
    const apiName = raw.name ?? raw.nombre ?? raw.description ?? raw.descripcion;
    const apiCountry = raw.country ?? raw.pais ?? raw.countryName;
    return {
      code,
      sourceCode,
      name: meta?.name ?? (apiName ? String(apiName) : code),
      country: meta?.country ?? (apiCountry ? String(apiCountry) : "Referencia del mercado informal cubano"),
      value, buy, sell
    };
  };

  if (Array.isArray(list)) return list.map((item, index) => makeRate(item, "", index)).filter((item): item is Rate => Boolean(item));
  if (list && typeof list === "object") {
    return Object.entries(list).flatMap(([code, raw], index) => {
      const rate = makeRate(raw, code, index);
      return rate ? [rate] : [];
    });
  }
  return [];
}
type OfferStats = { buy: number | null; sell: number | null; total: number | null; available: boolean };

function getOfferStats(data: unknown): OfferStats {
  const buyKeys = new Set(["buy", "compra", "bids", "buyoffers", "offersbuy", "ofertascompra", "compras"]);
  const sellKeys = new Set(["sell", "venta", "asks", "selloffers", "offerssell", "ofertasventa", "ventas"]);
  const allKeys = new Set(["offers", "ofertas", "listings", "anuncios", "marketoffers"]);
  const normalize = (key: string) => key.toLowerCase().replace(/[-_\s]/g, "");
  let buy: number | null = null;
  let sell: number | null = null;
  let total: number | null = null;
  const seen = new Set<object>();

  const classify = (item: any): "buy" | "sell" | null => {
    const raw = [item?.type, item?.side, item?.operation, item?.offer_type, item?.offerType, item?.tipo, item?.operacion, item?.transaction_type]
      .find((value) => typeof value === "string");
    const side = String(raw || "").toLowerCase();
    if (/buy|bid|compra|comprador/.test(side)) return "buy";
    if (/sell|ask|venta|vendedor/.test(side)) return "sell";
    return null;
  };

  const visit = (node: any) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const normalized = normalize(key);
      if (Array.isArray(value) && buyKeys.has(normalized)) buy = (buy ?? 0) + value.length;
      else if (Array.isArray(value) && sellKeys.has(normalized)) sell = (sell ?? 0) + value.length;
      else if (Array.isArray(value) && allKeys.has(normalized)) {
        total = (total ?? 0) + value.length;
        for (const item of value) {
          const side = classify(item);
          if (side === "buy") buy = (buy ?? 0) + 1;
          if (side === "sell") sell = (sell ?? 0) + 1;
        }
      } else visit(value);
    }
  };

  visit(data);
  const available = buy !== null || sell !== null || total !== null;
  return { buy, sell, total, available };
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
function AbsoluteDelta({ current, previous }: { current?: number; previous?: number }) {
  if (current === undefined || previous === undefined) return <span className="text-xs font-semibold text-muted">Sin dato anterior</span>;
  const difference = current - previous;
  const up = difference > 0.00001;
  const down = difference < -0.00001;
  const Icon = up ? TrendingUp : down ? TrendingDown : Activity;
  const color = up ? "text-emerald-700 bg-emerald-50" : down ? "text-rose-700 bg-rose-50" : "text-muted bg-subtle";
  const pct = percentChange(current, previous);
  return <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${color}`}><Icon className="h-3.5 w-3.5" />{difference > 0 ? "+" : ""}{money(difference)} CUP{pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)`}</span>;
}
function Sparkline({ values, positive }: { values: number[]; positive: boolean }) {
  if (values.length < 2) return <span className="text-[10px] text-muted">Sin historial</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, i) => (i / (values.length - 1)) * 100 + "," + (22 - ((value - min) / range) * 17)).join(" ");
  const color = positive ? "#16A34A" : "#E11D48";
  return <svg viewBox="0 0 100 26" preserveAspectRatio="none" className="h-6 w-full" aria-label="Gráfica de evolución reciente"><polyline points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>;
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
  const [marketTab, setMarketTab] = useState<MarketTab>("divisas");
  const [selectedCode, setSelectedCode] = useState("");

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/exchange-rates", { headers: { Accept: "application/json" }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Error HTTP ${response.status}`);
      setPayload(body);
      const capturedAt = typeof body.capturedAt === "string" ? body.capturedAt : new Date().toISOString();
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
  const offerStats = useMemo(() => getOfferStats(payload?.data), [payload]);
  const currencyRates = useMemo(() => rates.filter((rate) => !isCryptoCode(rate.code)), [rates]);
  const cryptoRates = useMemo(() => rates.filter((rate) => isCryptoCode(rate.code)), [rates]);
  const visibleRates = marketTab === "crypto" ? cryptoRates : currencyRates;

  useEffect(() => {
    if (visibleRates.length && !visibleRates.some((rate) => rate.code === selectedCode)) {
      setSelectedCode(visibleRates[0].code);
    }
  }, [visibleRates, selectedCode]);

  const selectedRate = visibleRates.find((rate) => rate.code === selectedCode) ?? visibleRates[0];
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

  return <div className="h-full min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-primary px-2 py-3 sm:px-3 sm:py-4 xl:px-5 xl:py-6">
    <div className="mx-auto w-full max-w-7xl min-w-0 space-y-3 pb-8 sm:space-y-4 xl:space-y-5">
      <section className="rounded-2xl border border-base bg-secondary px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-800"><BarChart3 className="h-5 w-5" /></div>
            <div className="min-w-0">
              <p className="text-[9px] font-black uppercase tracking-[.16em] text-violet-700">PALMYRA · FUENTE elTOQUE</p>
              <h1 className="text-xl font-black text-primary sm:text-2xl">Tasas de cambio</h1>
              <p className="text-xs text-muted">Mercado informal de Cuba · referencias, compra/venta e historial</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-2 text-xs font-bold text-primary"><span className={"h-2 w-2 rounded-full " + (error ? "bg-amber-500" : "bg-emerald-500")} />{error ? "Con incidencias" : payload ? "Fuente consultada" : "Conectando"}</span>
            <span className="text-xs text-muted">{updated ? "Actualizado " + updated : "Sin fecha disponible"}</span>
            <button onClick={() => void load(true)} disabled={loading || refreshing} className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-violet-700 px-3 py-2 text-xs font-bold text-white transition hover:bg-violet-800 disabled:opacity-60">
              <RefreshCw className={"h-3.5 w-3.5 " + (refreshing ? "animate-spin" : "")} />{refreshing ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
        </div>
        {error && <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"><AlertCircle className="mr-1 inline h-3.5 w-3.5" />{error}</p>}
      </section>

      {loading && !payload && <div className="rounded-2xl border border-base bg-secondary p-6 text-sm text-muted" aria-live="polite">Consultando las cotizaciones de elTOQUE…</div>}

      <nav className="flex w-full gap-1 rounded-xl border border-base bg-secondary p-1.5 sm:w-fit" aria-label="Tipo de mercado">
        <button type="button" onClick={() => setMarketTab("divisas")} className={"inline-flex min-w-32 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-extrabold transition sm:flex-none " + (marketTab === "divisas" ? "bg-violet-700 text-white shadow-sm" : "text-muted hover:bg-primary")}>
          <Activity className="h-4 w-4" />Divisas<span className={"rounded-md px-1.5 py-0.5 text-[10px] " + (marketTab === "divisas" ? "bg-white/15 text-white" : "bg-subtle text-muted")}>{currencyRates.length}</span>
        </button>
        <button type="button" onClick={() => setMarketTab("crypto")} className={"inline-flex min-w-32 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-extrabold transition sm:flex-none " + (marketTab === "crypto" ? "bg-violet-700 text-white shadow-sm" : "text-muted hover:bg-primary")}>
          <BarChart3 className="h-4 w-4" />Crypto<span className={"rounded-md px-1.5 py-0.5 text-[10px] " + (marketTab === "crypto" ? "bg-white/15 text-white" : "bg-subtle text-muted")}>{cryptoRates.length}</span>
        </button>
      </nav>

      <section className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-extrabold text-primary">Actividad de ofertas de compra y venta</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">Conteo de ofertas únicamente si la respuesta de elTOQUE incluye registros individuales. Las medianas de las tasas no permiten deducir cuántas personas están comprando o vendiendo.</p>
          </div>
          <span className={"rounded-lg px-2.5 py-1.5 text-[10px] font-bold " + (offerStats.available ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800")}>{offerStats.available ? "Datos de ofertas detectados" : "Conteo no disponible"}</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-base bg-primary p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Ofertas de compra</p>
            <p className="mt-1 text-xl font-black tabular-nums text-primary">{offerStats.buy === null ? "—" : offerStats.buy.toLocaleString("es-ES")}</p>
          </div>
          <div className="rounded-xl border border-base bg-primary p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Ofertas de venta</p>
            <p className="mt-1 text-xl font-black tabular-nums text-primary">{offerStats.sell === null ? "—" : offerStats.sell.toLocaleString("es-ES")}</p>
          </div>
          <div className="rounded-xl border border-base bg-primary p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Ofertas registradas</p>
            <p className="mt-1 text-xl font-black tabular-nums text-primary">{offerStats.total === null ? "—" : offerStats.total.toLocaleString("es-ES")}</p>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-muted">{offerStats.available ? "Estos valores cuentan registros de ofertas devueltos por la fuente, no personas únicas ni operaciones completadas." : "La respuesta actual no expone listas de ofertas que se puedan contar; solo se mostrarán cifras cuando la API las entregue. No se estiman ni se inventan conteos."}</p>
      </section>

      <section className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-base px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-sm font-extrabold text-primary">{marketTab === "divisas" ? "Divisas y medios de pago" : "Criptomonedas cotizadas"}</h2>
            <p className="mt-0.5 text-xs text-muted">{marketTab === "divisas" ? "Nombre, país o área monetaria y cotización frente al CUP." : "Solo activos que aparecen en la respuesta de elTOQUE; no se agregan precios externos ni estimados."}</p>
          </div>
          <span className="rounded-lg bg-subtle px-2.5 py-1.5 text-xs font-bold text-muted">{visibleRates.length} {visibleRates.length === 1 ? "activo" : "activos"}</span>
        </header>

        {visibleRates.length ? <>
          <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,.75fr)_minmax(0,.65fr)_minmax(0,.65fr)_minmax(0,1fr)] gap-3 bg-primary px-5 py-2.5 text-[10px] font-black uppercase tracking-wider text-muted xl:grid">
            <span>Moneda / activo</span><span>Referencia</span><span>Compra</span><span>Venta</span><span>Variación / tendencia</span>
          </div>
          <div className="divide-y divide-base">
            {visibleRates.map((rate) => {
              const value = rate.value ?? rate.sell ?? rate.buy;
              const previous = [...history].reverse().find((snapshot) => snapshot.rates[rate.code] !== undefined && snapshot.capturedAt !== payload?.capturedAt)?.rates[rate.code];
              const sparkValues = history.filter((snapshot) => snapshot.rates[rate.code] !== undefined).slice(-18).map((snapshot) => snapshot.rates[rate.code]);
              const rising = previous === undefined || value === undefined ? true : value >= previous;
              const active = selectedCode === rate.code;
              return <button key={rate.code} type="button" onClick={() => setSelectedCode(rate.code)} className={"grid w-full min-w-0 grid-cols-2 gap-x-3 gap-y-2 px-3 py-3 text-left transition hover:bg-primary sm:grid-cols-3 sm:px-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,.75fr)_minmax(0,.65fr)_minmax(0,.65fr)_minmax(0,1fr)] xl:items-center xl:gap-3 " + (active ? "bg-violet-50/50" : "bg-secondary")}>
                <div className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-3 xl:col-span-1">
                  <span className={"flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[10px] font-black " + (isCryptoCode(rate.code) ? "bg-indigo-100 text-indigo-800" : "bg-violet-100 text-violet-800")}>{rate.code.length > 5 ? rate.code.slice(0, 4) : rate.code}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-extrabold text-primary">{rate.name}</span>
                    <span className="mt-0.5 block min-w-0 break-words text-[11px] leading-tight text-muted">{rate.country}{rate.sourceCode === "ECU" ? " · código de origen elTOQUE: ECU" : ""}</span>
                  </span>
                </div>
                <div className="min-w-0">
                  <span className="block text-[10px] text-muted xl:hidden">Referencia</span>
                  <span className="block break-words text-base font-black tabular-nums text-primary">{money(value)} <span className="text-[10px] font-semibold text-muted">CUP</span></span>
                </div>
                <div className="min-w-0">
                  <span className="block text-[10px] text-muted xl:hidden">Compra</span>
                  <span className="text-sm font-semibold tabular-nums text-primary">{money(rate.buy)}</span>
                </div>
                <div className="min-w-0">
                  <span className="block text-[10px] text-muted xl:hidden">Venta</span>
                  <span className="text-sm font-semibold tabular-nums text-primary">{money(rate.sell)}</span>
                </div>
                <div className="col-span-2 flex min-w-0 items-center justify-between gap-3 sm:col-span-3 xl:col-span-1">
                  <AbsoluteDelta current={value} previous={previous} />
                  <div className="w-[76px] shrink-0">{sparkValues.length > 1 ? <Sparkline values={sparkValues} positive={rising} /> : <span className="block text-right text-[10px] text-muted">Sin historial</span>}</div>
                </div>
              </button>;
            })}
          </div>
        </> : <div className="flex flex-col items-center px-5 py-8 text-center">
          <div className="rounded-xl bg-subtle p-3 text-violet-700">{marketTab === "crypto" ? <BarChart3 className="h-5 w-5" /> : <Activity className="h-5 w-5" />}</div>
          <p className="mt-3 text-sm font-bold text-primary">{loading ? "Consultando elTOQUE…" : marketTab === "crypto" ? "No hay criptomonedas en esta respuesta" : "No hay cotizaciones de divisas disponibles"}</p>
          <p className="mt-1 max-w-md text-xs leading-5 text-muted">{marketTab === "crypto" ? "La pestaña se llena automáticamente con BTC, USDT, TRX, BNB u otros activos únicamente cuando elTOQUE los devuelve. No se mostrarán precios inventados ni datos de otra fuente como si fueran de elTOQUE." : "Cuando la API responda con cotizaciones reconocibles, aparecerán aquí."}</p>
          {error && <button type="button" onClick={() => void load(true)} className="mt-3 rounded-lg bg-violet-700 px-3 py-2 text-xs font-bold text-white">Reintentar conexión</button>}
        </div>}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-base px-4 py-2.5 text-[10px] text-muted sm:px-5">
          <span><CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-emerald-600" />Fuente: elTOQUE · valores informativos</span>
          <span>Compra/venta solo se muestran si la API los entrega por separado.</span>
        </footer>
      </section>

      {selectedRate && <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,.8fr)]">
        <div className="min-w-0 rounded-2xl border border-base bg-secondary p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-700">Historial local</p>
              <h2 className="mt-1 text-base font-extrabold text-primary">{selectedRate.name} <span className="font-semibold text-muted">/ CUP</span></h2>
              <p className="mt-0.5 text-xs text-muted">{selectedRate.country}</p>
            </div>
            <div className="flex gap-1 rounded-lg bg-subtle p-1">
              {([{ id: "24h", label: "24 h" }, { id: "7d", label: "7 días" }, { id: "30d", label: "30 días" }, { id: "all", label: "Todo" }] as const).map((item) =>
                <button key={item.id} type="button" onClick={() => setPeriod(item.id)} className={"rounded-md px-2.5 py-1.5 text-[11px] font-bold transition " + (period === item.id ? "bg-secondary text-violet-700 shadow-sm" : "text-muted hover:text-primary")}>{item.label}</button>)}
            </div>
          </div>
          <div className="mt-4 h-[170px] w-full sm:h-[200px] xl:h-[220px]">
            {chartData.length >= 2 ? <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 3 }}>
                <CartesianGrid stroke="var(--border-base)" strokeDasharray="3 5" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} minTickGap={22} />
                <YAxis domain={["auto", "auto"]} width={48} tick={{ fontSize: 9, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} tickFormatter={(v) => new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 2 }).format(v)} />
                <Tooltip formatter={(value) => [money(value) + " CUP", "Cotización"]} labelFormatter={(label) => "Fecha: " + label} contentStyle={{ borderRadius: 10, borderColor: "var(--border-base)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: 11 }} />
                <Line type="monotone" dataKey="value" stroke="#7C4DDE" strokeWidth={2.25} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} connectNulls />
              </LineChart>
            </ResponsiveContainer> : <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-base bg-primary px-4 text-center">
              <p className="text-sm font-bold text-primary">{chartData.length === 1 ? "Primer registro guardado" : "Aún no hay historial suficiente"}</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted">El histórico se acumula en este navegador con las consultas reales a la API; no se inventan puntos ni se descargan datos anteriores que elTOQUE no entregue.</p>
            </div>}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-base pt-3 text-[10px] text-muted">
            <span>{chartData.length} puntos en el período seleccionado</span><span>Consulta automática cada 5 min mientras la página está abierta</span>
          </div>
        </div>

        <aside className="min-w-0 rounded-2xl border border-base bg-secondary p-4 shadow-sm sm:p-5">
          <p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-700">Detalle de cotización</p>
          <div className="mt-2 flex items-start justify-between gap-3">
            <div><h3 className="text-lg font-black text-primary">{selectedRate.code}</h3><p className="text-xs text-muted">{selectedRate.name}</p></div>
            <span className="rounded-lg bg-violet-100 px-2 py-1 text-[10px] font-bold text-violet-800">{marketTab === "crypto" ? "Crypto" : "Divisa"}</span>
          </div>
          <div className="mt-4 rounded-xl bg-primary p-3">
            <p className="text-xs font-semibold text-muted">Tasa de referencia</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-primary">{money(currentValue)} <span className="text-xs font-semibold text-muted">CUP</span></p>
            <div className="mt-2"><Delta value={change} /></div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-base p-3"><p className="text-[10px] font-bold uppercase text-muted">Compra</p><p className="mt-1 text-base font-black tabular-nums text-primary">{money(selectedRate.buy)}</p></div>
            <div className="rounded-xl border border-base p-3"><p className="text-[10px] font-bold uppercase text-muted">Venta</p><p className="mt-1 text-base font-black tabular-nums text-primary">{money(selectedRate.sell)}</p></div>
          </div>
          <p className="mt-3 text-[10px] leading-4 text-muted">País / área monetaria: {selectedRate.country}. Los campos no publicados por elTOQUE se muestran como “—”.</p>
        </aside>
      </section>}

      <div className="flex items-start gap-2 rounded-xl border border-base bg-secondary px-3 py-2.5 text-[10px] leading-4 text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-700" />
        <p><strong className="text-primary">Nota:</strong> tasas referenciales de elTOQUE, no oficiales ni garantía de una operación. Los datos de compra/venta no se calculan si la fuente no los publica. El histórico se conserva en este navegador y no modifica precios, costos ni operaciones del POS.</p>
      </div>

    </div>
  </div>;
}
