import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertCircle, ArrowDownRight, ArrowUpRight, BarChart3, CircleDollarSign, Clock3, Minus, RefreshCw, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import OperationsSurface from '../components/OperationsSurface';
import { useStore } from '../store/useStore';
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
import {
  RATE_HUB_FRESH_MS,
  RATE_OFFLINE_NOTICE,
  RATE_REFRESH_FALLBACK_NOTICE,
  RATE_SOURCE_FRESH_MS,
  RATE_UNAVAILABLE_NOTICE,
  describeExchangeRateSource,
  formatRateAge,
  hubQuotesToPayload,
  isDeviceOffline,
  resolveExchangeRates,
  type ExchangeRateSourceKind,
  type ExchangeRateSourceView
} from '../services/exchangeRatesHub';
import { RATE_TARGET_MS } from '../services/lanHub/rateScheduler';

const CACHE_KEY = EXCHANGE_RATE_CACHE_KEY;
const HISTORY_KEY = 'palmyra.eltoque-observations.v2';
/** La pantalla revisa con la cadencia del hub (45 min), no cada 5 minutos. */
const REFRESH_MS = RATE_TARGET_MS;
/** Una copia repartida por el hub vale hasta 60 min; la de la nube, 30. */
const CACHE_FRESH_MS = RATE_HUB_FRESH_MS;
const CLOUD_FRESH_MS = RATE_SOURCE_FRESH_MS;
type Period = '24h' | '7d' | '30d' | 'all';

/** Etiqueta de pantalla de la fuente real de la tasa. */
const SOURCE_TITLES: Record<ExchangeRateSourceKind, string> = {
  hub: 'Hub local',
  cloud: 'elTOQUE',
  cached: 'Última válida'
};

const PERIOD_DAYS: Record<Period, number | null> = { '24h': 1, '7d': 7, '30d': 30, all: null };

/** Códigos que el dueño puede guardar a mano en Configuración → Monedas y tasas. */
const MANUAL_RATE_CODES = ['USD', 'EUR', 'MLC'];

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
  const navigate = useNavigate();
  const currencies = useStore(state => state.currencies);
  const [payload, setPayload] = useState<ExchangePayload | null>(cachedPayload);
  const [history, setHistory] = useState<RateSnapshot[]>(localHistory);
  const [remoteHistory, setRemoteHistory] = useState<RateSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(true);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [period, setPeriod] = useState<Period>('7d');
  const [market, setMarket] = useState<'divisas' | 'crypto'>('divisas');
  const [selectedCode, setSelectedCode] = useState('');
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const [rateSource, setRateSource] = useState<ExchangeRateSourceView>(() => describeExchangeRateSource(null));
  const inFlight = useRef(false);
  /** Última tasa ya visible: nunca se reemplaza por una pantalla vacía. */
  const payloadRef = useRef<ExchangePayload | null>(payload);
  const cardIdPrefix = useId().replace(/[:]/g, '');
  useEffect(() => { payloadRef.current = payload; }, [payload]);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      // El hub está apagado (LAN_HUB_ENABLED = false): siempre /api/exchange-rates.
      const resolved = await resolveExchangeRates();
      const offline = isDeviceOffline();
      const source = describeExchangeRateSource(resolved);
      setRateSource(source);
      const body = hubQuotesToPayload(resolved.rates);
      if (!body || !isElToquePayload(body)) {
        // Sin cotizaciones nuevas no se borra lo que el dueño ya estaba viendo.
        // El aviso trae el motivo real (credencial, límite, fuente caída) cuando
        // se pudo leer, y siempre indica cómo reintentar y ajustar a mano.
        // Sin Internet el motivo de la ruta local no es la causa: se muestra
        // el aviso offline en su lugar.
        setFromCache(true);
        setWarning('');
        setError(offline ? RATE_OFFLINE_NOTICE : resolved.error || RATE_UNAVAILABLE_NOTICE);
        return;
      }
      const stale = resolved.stale || source.stale;
      const notice = stale
        ? body.notice || RATE_REFRESH_FALLBACK_NOTICE
        : body.notice;
      const next: ExchangePayload = { ...body, stale, ...(notice ? { notice } : {}) };
      setPayload(next);
      setFromCache(stale);
      setWarning(offline ? RATE_OFFLINE_NOTICE : stale || resolved.error ? RATE_REFRESH_FALLBACK_NOTICE : '');
      setError('');
      setHistory(current => appendRateSnapshot(current, next));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); setStorageError(false); }
      catch { setStorageError(true); }
    } catch {
      // Cualquier fallo queda en copy neutral: sin hub, IP ni nombres de red.
      const offline = isDeviceOffline();
      const hadRate = payloadRef.current !== null;
      setFromCache(true);
      setWarning(offline ? RATE_OFFLINE_NOTICE : RATE_REFRESH_FALLBACK_NOTICE);
      setError(hadRate ? '' : offline ? RATE_OFFLINE_NOTICE : RATE_UNAVAILABLE_NOTICE);
    } finally {
      inFlight.current = false;
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
  /** Moneda base del negocio (CUP por defecto) para etiquetar las tasas manuales. */
  const baseCode = useMemo(() => {
    const base = (currencies || []).find(currency => currency.isBase);
    return base?.code || 'CUP';
  }, [currencies]);
  /**
   * Tasas de venta guardadas a mano en Configuración → Monedas y tasas. Son la
   * última red de seguridad de la pantalla: cuando la fuente automática no
   * entrega nada, se muestran estas en lugar de un panel vacío.
   */
  const manualRates = useMemo(() => (currencies || [])
    .filter(currency => MANUAL_RATE_CODES.includes(currency.code) && !currency.isBase
      && Number.isFinite(currency.rateToBase) && currency.rateToBase > 0)
    .map(currency => ({ code: currency.code, value: currency.rateToBase }))
    .sort((a, b) => MANUAL_RATE_CODES.indexOf(a.code) - MANUAL_RATE_CODES.indexOf(b.code)), [currencies]);
  const visibleRates = useMemo(() => {
    const filtered = rates.filter(rate => isCryptoRate(rate.code) === (market === 'crypto'));
    return filtered.slice().sort((a, b) => {
      const priority = ['USD', 'EUR', 'MLC', 'CLA', 'ZELLE', 'CAD', 'MXN'];
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
  const cacheFreshMs = rateSource.kind === 'hub' ? CACHE_FRESH_MS : CLOUD_FRESH_MS;
  const stale = fromCache || Boolean(payload?.stale) || Boolean(payload && Date.now() - Date.parse(payload.capturedAt) >= cacheFreshMs);
  /** Antigüedad de la captura mostrada: la guardada o la que resolvió la fuente. */
  const rateAge = payload ? Date.now() - Date.parse(payload.capturedAt) : rateSource.ageMs;
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

        {(error || warning) && (
          <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <AlertCircle className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
              <p className="min-w-0 font-semibold">{error || warning}</p>
            </div>
            <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-10 shrink-0 items-center gap-2 self-start rounded-xl border border-amber-400 bg-white px-3 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 sm:self-auto">
              <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin motion-reduce:animate-none' : '')} aria-hidden="true" />Reintentar
            </button>
          </div>
        )}

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
                  {payload && stale && <span className="palmyra-pill border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">Sin conexión en vivo{rateAge > 0 ? ` · ${formatRateAge(rateAge)}` : ''}</span>}
                  <SourceBadge source={rateSource} />
                </p>
                <p className="mt-0.5 text-[11px] font-semibold text-muted">{payload ? `Consultado el ${dateLabel(payload.capturedAt)} · ${formatRateAge(rateAge)} · ${rateSource.detail}` : rateSource.detail}</p>
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

        {storageError && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">El dispositivo no pudo guardar la consulta. No estará disponible al cerrar la aplicación.</p>}

        {rates.length > 0 && manualRates.length > 0 && (
          <section aria-label="Tasas manuales de tu negocio" className="flex flex-wrap items-center gap-2 rounded-2xl border border-base bg-secondary p-3">
            <span className="palmyra-pill border border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300">Tasas de tu negocio · venta</span>
            {manualRates.map(rate => (
              <span key={rate.code} className="palmyra-pill border border-base bg-subtle text-primary">
                {rate.code} <b className="tabular-nums">{money(rate.value)}</b> {baseCode}
              </span>
            ))}
            <button type="button" onClick={() => navigate('/settings?section=currency')} className="palmyra-pill border border-base bg-subtle font-bold text-primary hover:border-violet-300">Ajustar</button>
          </section>
        )}

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
        ) : manualRates.length > 0 ? (
          <section aria-label="Tasas guardadas a mano" className="rounded-2xl border border-base bg-secondary p-5">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-primary">Tasas guardadas a mano</h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">La fuente automática (elTOQUE) no está disponible ahora mismo. Estas son las tasas de venta que guardaste en Configuración → Monedas y tasas, y son las que sigue usando tu negocio.</p>
              </div>
              <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
                <RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin motion-reduce:animate-none' : '')} aria-hidden="true" />{loading ? 'Consultando…' : 'Reintentar'}
              </button>
            </header>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {manualRates.map(rate => (
                <div key={rate.code} className="rounded-2xl border border-base bg-subtle p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-lg font-black leading-none text-primary">{rate.code}</p>
                      <p className="mt-1 truncate text-[11px] font-semibold text-secondary" title={rateTitle({ code: rate.code })}>{rateTitle({ code: rate.code })}</p>
                    </div>
                    <span className="palmyra-pill border border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300">Manual · venta</span>
                  </div>
                  <p className="mt-3 text-3xl font-black tabular-nums leading-none text-primary">{money(rate.value)} <span className="text-xs font-semibold text-muted">{baseCode}</span></p>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-dashed border-base bg-secondary px-5 py-12 text-center">
            <Activity className="mx-auto h-10 w-10 text-muted" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold text-primary">{loading ? 'Esperando cotizaciones' : 'Sin tasas todavía'}</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">La fuente elTOQUE no respondió y este dispositivo aún no tiene tasas guardadas. Pulsa Reintentar para volver a consultarla, o guarda tus tasas de venta a mano y se mostrarán aquí al instante.</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
                <RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin motion-reduce:animate-none' : '')} aria-hidden="true" />{loading ? 'Consultando…' : 'Reintentar'}
              </button>
              <button type="button" onClick={() => navigate('/settings?section=currency')} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-base bg-secondary px-4 text-sm font-semibold text-primary hover:border-violet-300">
                <CircleDollarSign className="h-4 w-4" aria-hidden="true" />Guardar tasas manuales
              </button>
            </div>
          </section>
        )}

        <p className="text-xs leading-5 text-muted">Fuente: elTOQUE · Referencias del mercado informal, no tasas oficiales ni garantía de una operación. Compra y venta solo aparecen si la API las publica. La fecha indicada corresponde a la consulta, no necesariamente al momento de publicación del proveedor. La tasa se consulta automáticamente cada 45 minutos por Wi-Fi y esta pantalla se revisa con esa misma cadencia. Sin conexión se conserva la última tasa válida y se indica su antigüedad. Si no hay ninguna guardada, se muestran tus tasas manuales de Configuración → Monedas y tasas; si tampoco las has guardado, esta pantalla te indica cómo hacerlo.</p>
      </main>
    </OperationsSurface>
  );
}

function SourceBadge({ source }: { source: ExchangeRateSourceView }) {
  const tone = source.kind === 'hub'
    ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300'
    : source.kind === 'cloud'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300';
  return (
    <span className={'palmyra-pill border ' + tone}>
      {SOURCE_TITLES[source.kind] ?? source.label}{source.stale && source.kind !== 'cached' ? ' · vencida' : ''}
    </span>
  );
}

function LiveDot() {
  return (
    <span className="palmyra-pill border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
      <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70 motion-reduce:animate-none" /><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" /></span>
      En vivo
    </span>
  );
}
