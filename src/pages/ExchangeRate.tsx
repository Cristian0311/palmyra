import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowDownRight, ArrowUpRight, BarChart3, Clock3, KeyRound, Minus, RefreshCw, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import OperationsSurface from '../components/OperationsSurface';
import { getSupabase } from '../lib/supabase';
import {
  appendRateSnapshot,
  canonicalizeRates,
  canonicalizeRateSnapshots,
  canonicalRateCode,
  EXCHANGE_RATE_CACHE_KEY,
  isCryptoRate,
  isElToquePayload,
  parseExchangeRates,
  RATE_NAMES,
  readRateSnapshots,
  type ExchangePayload,
  type ExchangeRate,
  type RateSnapshot
} from '../lib/exchangeRates';

const CACHE_KEY = EXCHANGE_RATE_CACHE_KEY;
const HISTORY_KEY = 'palmyra.eltoque-observations.v2';
const REFRESH_MS = 5 * 60 * 1000;
type Period = '24h' | '7d' | '30d' | 'all';

const PERIOD_DAYS: Record<Period, number | null> = { '24h': 1, '7d': 7, '30d': 30, all: null };

function cachedPayload(): ExchangePayload | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return isElToquePayload(value) ? value : null;
  } catch { return null; }
}
function localHistory(): RateSnapshot[] {
  try { return readRateSnapshots(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')).slice(-2500); }
  catch { return []; }
}
function money(value?: number) {
  return value === undefined ? '—' : new Intl.NumberFormat('es-CU', { maximumFractionDigits: value < 1 ? 6 : 2 }).format(value);
}
function pct(value?: number) {
  return value === undefined ? '—' : `${value > 0 ? '+' : ''}${new Intl.NumberFormat('es-CU', { maximumFractionDigits: 2 }).format(value)}%`;
}
function dateLabel(value: string, timeOnly = false) {
  return new Intl.DateTimeFormat('es-CU', timeOnly ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function rateNumber(rate: ExchangeRate): number | undefined {
  return rate.value ?? rate.sell ?? rate.buy;
}
function rateTitle(rate: ExchangeRate): string {
  const code = canonicalRateCode(rate.code);
  return RATE_NAMES[code] || code;
}

type Delta = { absolute: number; percent: number } | null;
function computeDelta(current?: number, reference?: number): Delta {
  if (current === undefined || reference === undefined || reference === 0) return null;
  const absolute = current - reference;
  return { absolute, percent: (absolute / reference) * 100 };
}

function TrendPill({ delta, compact = false }: { delta: Delta; compact?: boolean }) {
  if (!delta) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-[10px] font-bold text-muted"><Minus className="h-3 w-3" /> Sin comparación</span>;
  }
  const up = delta.absolute > 0;
  const flat = delta.absolute === 0;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black tabular-nums ' + (flat ? 'border-base bg-subtle text-muted' : up ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300')} title={delta ? `${delta.absolute > 0 ? '+' : ''}${money(delta.absolute)} CUP en el período` : undefined}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {pct(delta.percent)}{!compact && <span className="hidden font-bold text-current/80 sm:inline"> · {up ? '+' : ''}{money(delta.absolute)}</span>}
    </span>
  );
}

function Sparkline({ values, id }: { values: number[]; id: string }) {
  if (values.length < 2) {
    return <div className="flex h-12 items-center text-[10px] font-bold uppercase tracking-wider text-muted">Sin historial en el período</div>;
  }
  const width = 220;
  const height = 48;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = height - 4 - ((value - min) / span) * (height - 8);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const rising = values[values.length - 1] >= values[0];
  const stroke = rising ? '#10b981' : '#f43f5e';
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-12 w-full" role="img" aria-label={`Tendencia de ${values.length} consultas`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id}-fill)`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r="2.4" fill={stroke} />
    </svg>
  );
}

function RefreshCountdown({ target, onRefresh, loading }: { target: number | null; onRefresh: () => void; loading: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = target ? Math.max(0, target - now) : null;
  const minutes = remaining === null ? null : Math.floor(remaining / 60000);
  const seconds = remaining === null ? null : Math.floor((remaining % 60000) / 1000);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-muted">
      <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
        {remaining === null ? 'Sin programar' : remaining === 0 ? 'Actualización disponible' : `Próxima en ${minutes}:${String(seconds).padStart(2, '0')}`}
      </span>
      {remaining === 0 && (
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 font-bold text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300">
          Actualizar ahora
        </button>
      )}
    </span>
  );
}

export default function ExchangeRate() {
  const [payload, setPayload] = useState<ExchangePayload | null>(cachedPayload);
  const [history, setHistory] = useState<RateSnapshot[]>(localHistory);
  const [remoteHistory, setRemoteHistory] = useState<RateSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(true);
  const [error, setError] = useState('');
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [period, setPeriod] = useState<Period>('7d');
  const [market, setMarket] = useState<'divisas' | 'crypto'>('divisas');
  const [selectedCode, setSelectedCode] = useState('');
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const cardIdPrefix = useId().replace(/[:]/g, '');

  const load = useCallback(async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.abort(); }, 15000);
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/exchange-rates', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: request.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setApiConfigured(typeof body?.configured === 'boolean' ? body.configured : null);
        throw new Error(typeof body?.error === 'string' ? body.error : 'La consulta no pudo completarse.');
      }
      if (!isElToquePayload(body)) throw new Error('La respuesta no contiene cotizaciones válidas de elTOQUE.');
      setApiConfigured(true);
      setPayload(body);
      setFromCache(Boolean(body.stale));
      setHistory(current => appendRateSnapshot(current, body));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(body)); setStorageError(false); }
      catch { setStorageError(true); }
    } catch (error) {
      if (request.signal.aborted && !timedOut) return;
      setFromCache(true);
      setError(timedOut ? 'La consulta agotó el tiempo de espera. Puedes reintentar.' : error instanceof Error ? error.message : 'Sin conexión con el servicio de tasas.');
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === request) controller.current = null;
      setNextRefreshAt(Date.now() + REFRESH_MS);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const sync = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(sync, REFRESH_MS);
    window.addEventListener('online', sync);
    return () => { window.clearInterval(timer); window.removeEventListener('online', sync); };
  }, [load]);

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
    catch { setStorageError(true); }
  }, [history]);

  useEffect(() => {
    let cancelled = false;
    const client = getSupabase();
    if (!client || !navigator.onLine) return;
    const days = PERIOD_DAYS[period];
    void (async () => {
      const { data, error } = await client.rpc('get_verified_exchange_rate_history', {
        p_since: days === null ? null : new Date(Date.now() - days * 86400000).toISOString(), p_limit: 2500
      });
      if (cancelled || error) return;
      setRemoteHistory(readRateSnapshots((Array.isArray(data) ? data : []).map(item => ({ capturedAt: item.captured_at, rates: item.rates }))));
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [period, payload?.capturedAt]);

  const rates = useMemo(() => canonicalizeRates(parseExchangeRates(payload?.data)), [payload]);
  const visibleRates = useMemo(() => {
    const filtered = rates.filter(rate => isCryptoRate(rate.code) === (market === 'crypto'));
    return filtered.slice().sort((a, b) => {
      const priority = ['USD', 'EUR', 'MLC', 'CLA', 'ZELLE'];
      const ai = priority.indexOf(a.code);
      const bi = priority.indexOf(b.code);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.code.localeCompare(b.code);
    });
  }, [rates, market]);
  const selected = visibleRates.find(rate => rate.code === selectedCode) ?? visibleRates[0];

  const snapshots = useMemo(() => {
    const entries = new Map(history.map(item => [item.capturedAt, item]));
    remoteHistory.forEach(item => entries.set(item.capturedAt, item));
    // ECU observations are stored raw but must feed the EUR chart and deltas.
    return canonicalizeRateSnapshots([...entries.values()]).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  }, [history, remoteHistory]);

  const since = useMemo(() => {
    const days = PERIOD_DAYS[period];
    return days === null ? 0 : Date.now() - days * 86400000;
  }, [period]);

  const seriesFor = useCallback((rawCode: string) => {
    const code = canonicalRateCode(rawCode);
    return snapshots
      .filter(item => Date.parse(item.capturedAt) >= since && item.rates[code] !== undefined)
      .map(item => ({ timestamp: item.capturedAt, label: dateLabel(item.capturedAt, period === '24h'), value: item.rates[code] }));
  }, [snapshots, since, period]);

  const deltaFor = (rate: ExchangeRate): Delta => {
    const code = canonicalRateCode(rate.code);
    const values = seriesFor(code);
    if (values.length >= 2) return computeDelta(values[values.length - 1].value, values[0].value);
    const current = rateNumber(rate);
    const previous = [...snapshots].reverse().find(item => item.capturedAt < (payload?.capturedAt || '') && item.rates[code] !== undefined)?.rates[code];
    return computeDelta(current, previous);
  };

  const chart = selected ? seriesFor(selected.code) : [];
  const selectedDelta = selected ? deltaFor(selected) : null;
  const selectedStats = useMemo(() => {
    if (!chart.length) return null;
    const values = chart.map(item => item.value);
    return { min: Math.min(...values), max: Math.max(...values), first: values[0], last: values[values.length - 1] };
  }, [chart]);
  const hasBuySell = visibleRates.some(rate => rate.buy !== undefined || rate.sell !== undefined);
  const stale = fromCache || Boolean(payload?.stale) || Boolean(payload && Date.now() - Date.parse(payload.capturedAt) >= REFRESH_MS);
  const globalDelta = useMemo(() => {
    const usd = visibleRates.find(rate => rate.code === 'USD');
    return usd ? deltaFor(usd) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRates, snapshots, since, payload?.capturedAt]);

  const periodLabel = period === '24h' ? '24 h' : period === '7d' ? '7 días' : period === '30d' ? '30 días' : 'todo el historial';

  return (
    <OperationsSurface className="w-full min-w-0">
      <main className="mx-auto w-full min-w-0 max-w-7xl space-y-5 pb-16">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="kicker font-bold uppercase tracking-[0.2em] text-violet-600 dark:text-violet-300">Cuba · Mercado informal · elTOQUE</p>
            <h1 className="mt-1 text-2xl font-bold text-primary sm:text-3xl">Tasas de cambio</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-secondary">Cotizaciones reales publicadas por elTOQUE, en CUP por unidad. No modifican los precios ni la tasa de venta de tu negocio.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
            <RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin motion-reduce:animate-none' : '')} aria-hidden="true" />{loading ? 'Consultando…' : 'Actualizar'}
          </button>
        </header>

        <section className="rounded-2xl border border-base bg-secondary p-4 shadow-xs" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className={'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ' + (payload && !stale ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-base bg-subtle text-muted')}>
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-primary">
                  {payload ? (stale ? 'Última consulta guardada' : 'Conexión activa con elTOQUE') : loading ? 'Consultando la fuente…' : 'Sin cotizaciones disponibles'}
                  {payload && !stale && <LiveDot />}
                  {payload && stale && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">Sin conexión en vivo</span>}
                </p>
                <p className="mt-0.5 text-[11px] font-semibold text-muted">{payload ? `Consultado el ${dateLabel(payload.capturedAt)}` : 'Aún no hay una consulta válida'}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {globalDelta && (
                <span className="hidden items-center gap-1 text-[11px] font-bold text-muted md:inline-flex">USD {periodLabel}: <TrendPill delta={globalDelta} compact /></span>
              )}
              <RefreshCountdown target={nextRefreshAt} onRefresh={() => void load()} loading={loading} />
            </div>
          </div>
        </section>

        {error && (
          <div role="alert" className={'flex items-start gap-3 rounded-2xl border p-4 text-sm leading-6 ' + (apiConfigured === false ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200' : 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200')}>
            {apiConfigured === false ? <KeyRound className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertCircle className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />}
            <div className="min-w-0">
              <p className="font-bold">{apiConfigured === false ? 'Falta la credencial de elTOQUE en el servidor' : 'No se pudo actualizar la cotización'}</p>
              <p className="mt-0.5">{apiConfigured === false
                ? 'El administrador debe definir ELTOQUE_API_TOKEN en el servidor. Mientras tanto se muestra la última consulta guardada; PALMYRA no inventa ni sustituye tasas.'
                : error}{error && payload && apiConfigured !== false ? ' Se mantiene la última cotización, no una tasa en vivo.' : ''}</p>
            </div>
          </div>
        )}
        {payload?.notice && !error && (
          <p role="status" className="rounded-xl border border-base bg-subtle p-3 text-sm leading-6 text-secondary">{payload.notice}</p>
        )}
        {storageError && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">El dispositivo no pudo guardar la consulta. No estará disponible al cerrar la aplicación.</p>}

        {rates.length > 0 ? (
          <>
            {rates.some(rate => isCryptoRate(rate.code)) && (
              <nav aria-label="Tipo de cotización" className="flex gap-2">
                {(['divisas', 'crypto'] as const).map(tab => (
                  <button key={tab} type="button" onClick={() => setMarket(tab)} aria-pressed={market === tab} className={'min-h-11 rounded-xl px-4 text-sm font-semibold transition-colors ' + (market === tab ? 'bg-violet-600 text-white' : 'border border-base bg-secondary text-primary hover:border-violet-300')}>{tab === 'divisas' ? 'Divisas' : 'Criptoactivos'}</button>
                ))}
              </nav>
            )}

            <section aria-label="Cotizaciones disponibles" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleRates.map(rate => {
                const delta = deltaFor(rate);
                const values = seriesFor(rate.code).map(item => item.value);
                const shown = rateNumber(rate);
                const active = selected?.code === rate.code;
                return (
                  <button key={rate.code} type="button" aria-pressed={active} onClick={() => setSelectedCode(rate.code)} className={'group min-w-0 rounded-2xl border bg-secondary p-4 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-violet-400 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600 ' + (active ? 'border-violet-500 ring-1 ring-violet-500' : 'border-base')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-lg font-black leading-none text-primary">{rate.code}</p>
                        <p className="mt-1 truncate text-[11px] font-semibold text-secondary" title={rateTitle(rate)}>{rateTitle(rate)}</p>
                      </div>
                      <TrendPill delta={delta} compact />
                    </div>
                    <p className="mt-3 text-3xl font-black tabular-nums leading-none text-primary">{money(shown)} <span className="text-xs font-semibold text-muted">CUP</span></p>
                    {shown === undefined && <p className="mt-1 text-[11px] font-semibold text-muted">La fuente no publicó una tasa de referencia.</p>}
                    <div className="mt-3"><Sparkline values={values} id={`${cardIdPrefix}-${rate.code}`} /></div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-base pt-2 text-[11px] font-semibold text-secondary">
                      {hasBuySell ? (
                        <span className="flex flex-wrap gap-x-4 gap-y-0.5"><span>Compra <b className="tabular-nums text-primary">{money(rate.buy)}</b></span><span>Venta <b className="tabular-nums text-primary">{money(rate.sell)}</b></span></span>
                      ) : <span className="text-muted">Sin compra/venta publicada</span>}
                      <span className="text-muted">{values.length ? `${values.length} consultas` : 'Sin historial'}</span>
                    </div>
                  </button>
                );
              })}
            </section>

            {selected && (
              <section className="rounded-2xl border border-base bg-secondary p-4 shadow-xs sm:p-6">
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-primary">Evolución de {selected.code} / CUP</h2>
                    <p className="mt-1 text-sm text-muted">{remoteHistory.length ? 'Historial de la fuente y consultas de este dispositivo.' : 'Consultas guardadas en este dispositivo.'}</p>
                  </div>
                  <div className="flex flex-wrap gap-1" aria-label="Período del historial">
                    {([{ id: '24h', label: '24 h' }, { id: '7d', label: '7 días' }, { id: '30d', label: '30 días' }, { id: 'all', label: 'Todo' }] as const).map(item => (
                      <button type="button" key={item.id} aria-pressed={period === item.id} onClick={() => setPeriod(item.id)} className={'min-h-11 rounded-lg px-3 text-sm font-semibold ' + (period === item.id ? 'bg-violet-600 text-white' : 'bg-subtle text-primary hover:bg-violet-50 dark:hover:bg-violet-950/30')}>{item.label}</button>
                    ))}
                  </div>
                </header>

                {selectedStats && (
                  <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-xl border border-base bg-subtle p-3">
                      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Actual</dt>
                      <dd className="mt-0.5 flex items-center gap-1.5 text-lg font-black tabular-nums text-primary">{money(selectedStats.last)} {(selectedDelta?.absolute ?? 0) > 0 ? <TrendingUp className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : (selectedDelta?.absolute ?? 0) < 0 ? <TrendingDown className="h-4 w-4 text-rose-600" aria-hidden="true" /> : null}</dd>
                      <dd className="mt-1"><TrendPill delta={selectedDelta} compact /></dd>
                    </div>
                    <div className="rounded-xl border border-base bg-subtle p-3">
                      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Mínimo</dt>
                      <dd className="mt-0.5 text-lg font-black tabular-nums text-primary">{money(selectedStats.min)}</dd>
                    </div>
                    <div className="rounded-xl border border-base bg-subtle p-3">
                      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Máximo</dt>
                      <dd className="mt-0.5 text-lg font-black tabular-nums text-primary">{money(selectedStats.max)}</dd>
                    </div>
                    <div className="rounded-xl border border-base bg-subtle p-3">
                      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Consultas</dt>
                      <dd className="mt-0.5 text-lg font-black tabular-nums text-primary">{chart.length}</dd>
                    </div>
                  </dl>
                )}

                <div className="mt-5 h-72" role="img" aria-label={`Evolución de ${selected.code}: ${chart.length} consultas; los valores exactos están en la tabla de historial.`}>
                  {chart.length >= 2 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chart} margin={{ top: 8, right: 16, left: 10, bottom: 8 }}>
                        <defs>
                          <linearGradient id="palmyra-rate-fill" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor="#7C4DDE" stopOpacity="0.28" />
                            <stop offset="100%" stopColor="#7C4DDE" stopOpacity="0.02" />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--border-base)" strokeDasharray="3 5" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={40} tickLine={false} axisLine={{ stroke: 'var(--border-base)' }} />
                        <YAxis domain={['auto', 'auto']} width={70} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                        <Tooltip labelFormatter={(_, items) => items[0]?.payload?.timestamp ? dateLabel(items[0].payload.timestamp) : ''} formatter={value => [`${money(Number(value))} CUP`, 'Referencia']} contentStyle={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', borderRadius: 12, border: '1px solid var(--border-base)' }} />
                        <Area type="monotone" dataKey="value" stroke="#7C4DDE" strokeWidth={2.5} fill="url(#palmyra-rate-fill)" dot={chart.length < 20 ? { r: 2.5, fill: '#7C4DDE', strokeWidth: 0 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl bg-subtle p-4 text-center">
                      <BarChart3 className="h-8 w-8 text-muted" aria-hidden="true" />
                      <p className="text-sm text-secondary">{chart.length === 1 ? 'Hay una consulta guardada. La comparación aparecerá con la siguiente.' : 'Aún no hay consultas de referencia en este período.'}</p>
                      <p className="max-w-sm text-[11px] font-semibold text-muted">La línea se construye con las tasas reales guardadas en este dispositivo y con el historial verificado del servidor.</p>
                    </div>
                  )}
                </div>

                {chart.length > 0 && (
                  <details className="mt-4 border-t border-base pt-3">
                    <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-primary">Ver consultas ({chart.length})</summary>
                    <div className="max-h-64 overflow-auto custom-scrollbar">
                      <table className="w-full text-left text-sm">
                        <thead><tr className="text-muted"><th className="p-2">Fecha de consulta</th><th className="p-2 text-right">CUP por unidad</th><th className="p-2 text-right">Cambio</th></tr></thead>
                        <tbody>
                          {chart.slice().reverse().map((item, index, list) => {
                            const previous = list[index + 1]?.value;
                            const delta = computeDelta(item.value, previous);
                            return (
                              <tr key={item.timestamp} className="border-t border-base text-primary">
                                <td className="p-2">{dateLabel(item.timestamp)}</td>
                                <td className="p-2 text-right tabular-nums">{money(item.value)}</td>
                                <td className="p-2 text-right"><TrendPill delta={delta} compact /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </section>
            )}
          </>
        ) : (
          <section className="rounded-2xl border border-dashed border-base bg-secondary px-5 py-12 text-center">
            <Activity className="mx-auto h-10 w-10 text-muted" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold text-primary">{loading ? 'Esperando cotizaciones' : 'No hay tasas de elTOQUE para mostrar'}</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">Cuando la fuente responda aparecerán únicamente sus monedas y valores. No se usarán tasas de otro proveedor ni conversiones calculadas para llenar esta pantalla.</p>
          </section>
        )}

        <p className="text-xs leading-5 text-muted">Fuente: elTOQUE · Referencias del mercado informal, no tasas oficiales ni garantía de una operación. Compra y venta solo aparecen si la API las publica. La fecha indicada corresponde a la consulta, no necesariamente al momento de publicación del proveedor. Actualización automática cada 5 minutos con esta pantalla abierta.</p>
      </main>
    </OperationsSurface>
  );
}

function LiveDot() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
      <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70 motion-reduce:animate-none" /><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" /></span>
      En vivo
    </span>
  );
}
