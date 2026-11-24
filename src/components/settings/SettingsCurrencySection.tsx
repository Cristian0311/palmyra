import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  History,
  RefreshCw,
  Save,
  Sparkles,
  TriangleAlert
} from 'lucide-react';
import { useStore } from '../../store/useStore';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { cn } from '../../lib/utils';
import {
  AUTO_RATE_THRESHOLD_DEFAULT,
  normalizeAutoRateThreshold
} from '../../lib/autoRatePolicy';
import {
  AUTO_RATE_EVENT,
  readAutoRateRun,
  readCachedAutoRatePayload,
  runAutoRateSync,
  type AutoRateRun
} from '../../services/autoExchangeRate';

type Toast = (message: string, type?: 'success' | 'error' | 'info') => void;
type Props = { active: boolean; onToast: Toast };

const EDITABLE_CODES = ['USD', 'EUR', 'MLC'];

function money(value: number) {
  return new Intl.NumberFormat('es-CU', { maximumFractionDigits: 2 }).format(value);
}

function timeLabel(iso?: string | null) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-CU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** CUP mínimos por unidad que se consideran plausibles para USD/EUR/MLC en Cuba. */
const MIN_PLAUSIBLE_RATE = 10;

/** Validación local del campo de tasa: positiva, numérica y con 2 decimales como máximo. */
function rateDraftError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Escribe una tasa mayor que 0.';
  if (!/^\d*(?:\.\d*)?$/.test(value)) return 'Usa solo números y hasta 2 decimales.';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 'La tasa debe ser mayor que 0.';
  if (numeric < MIN_PLAUSIBLE_RATE) return `La tasa mínima plausible es ${MIN_PLAUSIBLE_RATE}.`;
  const decimals = value.includes('.') ? value.split('.')[1].length : 0;
  if (decimals > 2) return 'Máximo 2 decimales.';
  return null;
}

function draftIsDirty(raw: string, rate: number) {
  const value = raw.trim();
  if (!value) return true;
  return Number(value) !== rate;
}

export function SettingsCurrencySection({ active, onToast }: Props) {
  const navigate = useNavigate();
  const currencies = useStore(state => state.currencies);
  const updateCurrencyRate = useStore(state => state.updateCurrencyRate);
  const storeConfig = useStore(state => state.storeConfig);
  const updateStoreConfig = useStore(state => state.updateStoreConfig);
  const getBaseCurrency = useStore(state => state.getBaseCurrency);
  const baseCurrency = getBaseCurrency();
  const visible = useMemo(
    () => currencies.filter(currency => EDITABLE_CODES.includes(currency.code)),
    [currencies]
  );
  const editable = useMemo(
    () => visible.filter(currency => !currency.isBase),
    [visible]
  );

  const toDrafts = useCallback(() => Object.fromEntries(
    currencies.map(currency => [currency.code, String(currency.rateToBase ?? '')])
  ), [currencies]);

  const [drafts, setDrafts] = useState<Record<string, string>>(toDrafts);
  const [dirty, setDirty] = useState(false);
  const [savingCode, setSavingCode] = useState<string | null>(null);
  const [run, setRun] = useState<AutoRateRun | null>(() => readAutoRateRun());
  const [checking, setChecking] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState(String(storeConfig.autoRateThreshold ?? AUTO_RATE_THRESHOLD_DEFAULT));
  const [toggling, setToggling] = useState(false);
  const autoEnabled = storeConfig.autoRateSync === true;
  const cachedCapturedAt = useMemo(() => (active ? readCachedAutoRatePayload()?.capturedAt || null : null), [active, run]);

  useEffect(() => {
    if (dirty) return;
    setDrafts(toDrafts());
  }, [toDrafts, dirty]);

  useEffect(() => {
    setThresholdDraft(String(storeConfig.autoRateThreshold ?? AUTO_RATE_THRESHOLD_DEFAULT));
  }, [storeConfig.autoRateThreshold]);

  useEffect(() => {
    if (!active) return;
    const handleUpdate = (event: Event) => {
      setRun((event as CustomEvent<AutoRateRun>).detail || readAutoRateRun());
    };
    window.addEventListener(AUTO_RATE_EVENT, handleUpdate);
    return () => window.removeEventListener(AUTO_RATE_EVENT, handleUpdate);
  }, [active]);

  if (!active) return null;

  const persistThreshold = () => {
    const value = normalizeAutoRateThreshold(thresholdDraft);
    setThresholdDraft(String(value));
    if (value !== storeConfig.autoRateThreshold) {
      updateStoreConfig({ ...storeConfig, autoRateThreshold: value });
    }
  };

  const handleSaveRate = async (code: string) => {
    const raw = (drafts[code] ?? '').trim();
    const value = Number(raw);
    if (rateDraftError(raw)) {
      onToast(`Introduce una tasa mayor que 0 para ${code}.`, 'error');
      return;
    }
    setSavingCode(code);
    try {
      const confirmed = await updateCurrencyRate(code, value);
      setDrafts(prev => ({ ...prev, [code]: String(value) }));
      const stillDirty = editable.some(currency => {
        if (currency.code === code) return false;
        return draftIsDirty(drafts[currency.code] ?? '', currency.rateToBase);
      });
      setDirty(stillDirty);
      if (confirmed) onToast(`Tasa de ${code} guardada y confirmada en la nube.`);
      else onToast(`Tasa de ${code} guardada en este dispositivo; queda pendiente de sincronizar.`, 'info');
    } catch {
      onToast('No se pudo confirmar el guardado remoto. El valor local se conservó.', 'error');
    } finally {
      setSavingCode(null);
    }
  };

  const handleAutoToggle = async () => {
    const enabled = !autoEnabled;
    updateStoreConfig({
      ...storeConfig,
      autoRateSync: enabled,
      autoRateThreshold: normalizeAutoRateThreshold(storeConfig.autoRateThreshold ?? AUTO_RATE_THRESHOLD_DEFAULT)
    });
    if (!enabled) {
      onToast('Sincronización automática desactivada. Las tasas quedan como están.', 'info');
      return;
    }
    setToggling(true);
    try {
      const result = await runAutoRateSync({ force: true });
      setRun(result);
      if (result.error) onToast(result.error, 'info');
      else if (result.applied.length) onToast(`Sincronización activada: ${result.applied.map(item => `${item.code} ${money(item.from)} → ${money(item.to)}`).join(', ')}.`);
      else onToast('Sincronización activada. La tasa actual está dentro del margen configurado.');
    } finally {
      setToggling(false);
    }
  };

  const handleCheckNow = async () => {
    setChecking(true);
    try {
      const result = await runAutoRateSync({ force: true });
      setRun(result);
      setDirty(false);
      if (result.error) onToast(result.error, 'error');
      else if (result.applied.length) onToast(`Tasas actualizadas: ${result.applied.map(item => `${item.code} ${money(item.from)} → ${money(item.to)}`).join(', ')}.`);
      else onToast('Sin cambios: la cotización no supera el margen configurado.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      <section className="rounded-2xl border border-base bg-secondary p-3 sm:p-5 shadow-sm space-y-4 min-w-0">
        <SettingsSectionHeader
          icon={CircleDollarSign}
          title="Tasas manuales del negocio"
          subtitle={`La moneda base es ${baseCurrency.code}. Las tasas de venta, caja y reportes usan estos valores.`}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 items-stretch">
          {editable.map(currency => {
            const draft = drafts[currency.code] ?? '';
            const error = rateDraftError(draft);
            const showError = Boolean(draft.trim()) && Boolean(error);
            const dirtyCard = draftIsDirty(draft, currency.rateToBase);
            const savingThis = savingCode === currency.code;
            const applied = run?.applied.find(item => item.code === currency.code);
            const hint = dirtyCard
              ? 'Cambios sin guardar en este equipo'
              : applied
                ? `Actualizada por sincronización · ${timeLabel(run?.at)}`
                : cachedCapturedAt
                  ? `Última referencia automática · ${timeLabel(cachedCapturedAt)}`
                  : 'Guardada en este dispositivo';
            const errorId = `rate-error-${currency.code}`;
            const hintId = `rate-hint-${currency.code}`;
            return (
              <div
                key={currency.code}
                className={cn(
                  'min-w-0 rounded-xl border bg-primary p-3.5 sm:p-4 shadow-sm flex flex-col gap-2.5 transition-colors',
                  showError
                    ? 'border-red-300 dark:border-red-900/60'
                    : dirtyCard
                      ? 'border-violet-300/80 dark:border-violet-900/60'
                      : 'border-base'
                )}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="palmyra-pill h-9 min-w-11 border-[color-mix(in_srgb,var(--primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--bg-secondary))] text-[var(--primary)] grid place-items-center shrink-0">
                    {currency.code}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-primary truncate">1 {currency.code} equivale a</span>
                    <span className="block text-xs font-medium text-muted truncate">{currency.name}</span>
                  </span>
                </div>

                <label className="block min-w-0">
                  <span className="sr-only">{`Tasa de cambio de ${currency.code} a ${baseCurrency.code}`}</span>
                  <span
                    className={cn(
                      'flex h-14 items-center gap-2 rounded-xl border bg-subtle px-3 transition-colors focus-within:ring-2',
                      showError
                        ? 'border-red-300 focus-within:border-red-400 focus-within:ring-red-500/20 dark:border-red-900/60'
                        : 'border-base focus-within:border-violet-500 focus-within:ring-violet-500/20'
                    )}
                  >
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Tasa de cambio de ${currency.code} a ${baseCurrency.code}`}
                      aria-invalid={showError || undefined}
                      aria-describedby={showError ? errorId : hintId}
                      value={draft}
                      onChange={event => {
                        setDrafts(prev => ({ ...prev, [currency.code]: event.target.value.replace(',', '.') }));
                        setDirty(true);
                      }}
                      onKeyDown={event => { if (event.key === 'Enter') handleSaveRate(currency.code); }}
                      placeholder="0"
                      className="w-full min-w-0 bg-transparent text-2xl font-black tabular-nums tracking-tight text-primary outline-none"
                    />
                    <span className="palmyra-pill shrink-0 border border-base bg-secondary text-secondary">
                      {baseCurrency.code}
                    </span>
                  </span>
                </label>

                {showError ? (
                  <p id={errorId} role="alert" className="flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">
                    <TriangleAlert size={12} className="shrink-0" />
                    <span className="min-w-0">{error}</span>
                  </p>
                ) : (
                  <p id={hintId} className="flex items-center gap-1.5 text-xs font-medium text-muted">
                    <Clock3 size={12} className="shrink-0" />
                    <span className="min-w-0 truncate">{hint}</span>
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => handleSaveRate(currency.code)}
                  disabled={savingThis || Boolean(error) || !dirtyCard}
                  className="mt-auto h-10 w-full rounded-xl bg-violet-600 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {savingThis ? <RefreshCw size={14} className="animate-spin" /> : <Save size={15} />}
                  {savingThis ? 'Guardando…' : 'Guardar tasa'}
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-sm font-medium leading-6 text-muted">
          Puedes vaciar el campo y escribir la tasa completa. Se aceptan hasta 2 decimales y cada tarjeta se guarda por separado. Estas tasas también se muestran en la página Tasa de cambio cuando la fuente automática (elTOQUE) no está disponible, para que esa pantalla nunca quede vacía.
        </p>
      </section>

      <section className="rounded-2xl border border-base bg-secondary p-3 sm:p-5 shadow-sm space-y-4 min-w-0">
        <SettingsSectionHeader
          icon={Sparkles}
          title="Sincronización automática con elTOQUE"
          subtitle="Mantiene tus tasas al día solo cuando la fuente cambia de forma significativa."
          action={
            <button
              type="button"
              role="switch"
              aria-checked={autoEnabled}
              aria-label="Activar sincronización automática con elTOQUE"
              onClick={handleAutoToggle}
              disabled={toggling}
              className="relative h-11 w-12 shrink-0 rounded-full disabled:opacity-60"
            >
              <span className={cn('absolute left-0 top-1/2 h-7 w-12 -translate-y-1/2 rounded-full border transition-colors', autoEnabled ? 'bg-violet-600 border-violet-600' : 'bg-slate-300 border-slate-400 dark:bg-slate-600 dark:border-slate-500')}>
                <span className={cn('absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow transition-all', autoEnabled ? 'left-[23px]' : 'left-[3px]')} />
              </span>
            </button>
          }
        />

        <div className={cn('grid grid-cols-1 md:grid-cols-2 items-start gap-3', !autoEnabled && 'opacity-70')}>
          <label className="rounded-xl border border-base bg-primary p-3 space-y-1.5">
            <span className="block text-sm font-semibold text-muted">Margen mínimo de cambio</span>
            <span className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                aria-label="Margen mínimo de cambio automático"
                value={thresholdDraft}
                disabled={!autoEnabled}
                onChange={event => setThresholdDraft(event.target.value)}
                onBlur={persistThreshold}
                onKeyDown={event => { if (event.key === 'Enter') persistThreshold(); }}
                className="w-20 h-10 rounded-lg border border-base bg-subtle px-3 text-sm font-black tabular-nums text-primary outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-60"
              />
              <span className="text-sm font-semibold text-muted">{baseCurrency.code} o más</span>
            </span>
            <span className="block text-sm font-medium leading-6 text-muted">
              Si la cotización sube o baja menos de {normalizeAutoRateThreshold(thresholdDraft)} {baseCurrency.code}, se mantiene tu tasa para evitar ruido en los precios.
            </span>
          </label>

          <div className="rounded-xl border border-base bg-primary p-3 space-y-2">
            <span className="block text-sm font-semibold text-muted">Estado</span>
            {run ? (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-primary">
                  {run.error ? <TriangleAlert size={13} className="text-amber-600 shrink-0" /> : <CheckCircle2 size={13} className="text-emerald-600 shrink-0" />}
                  <span className="min-w-0 break-words">{run.error || (run.applied.length ? `Aplicado: ${run.applied.map(item => `${item.code} ${money(item.from)} → ${money(item.to)}`).join(' · ')}` : 'Sin cambios: dentro del margen')}</span>
                </p>
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm font-medium text-muted">
                  <span className="inline-flex items-center gap-1"><Clock3 size={11} /> Revisado {timeLabel(run.at)}</span>
                  {run.capturedAt && <span>Fuente {timeLabel(run.capturedAt)}</span>}
                </p>
                {run.skipped.length > 0 && (
                  <p className="text-sm font-medium text-muted">Estables: {run.skipped.map(item => `${item.code} ${item.from === item.to ? 'igual' : `Δ ${money(item.delta)}`}`).join(' · ')}</p>
                )}
              </div>
            ) : (
              <p className="text-sm font-medium leading-6 text-muted">
                {cachedCapturedAt ? `Última cotización guardada: ${timeLabel(cachedCapturedAt)}.` : 'Aún no se ha comprobado la fuente en este equipo.'}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={handleCheckNow}
                disabled={!autoEnabled || checking || dirty}
                className="h-11 px-3 rounded-xl border border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-300 text-sm font-semibold flex items-center gap-1.5 hover:bg-violet-100/70 dark:hover:bg-violet-950/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw size={14} className={checking ? 'animate-spin' : ''} /> {checking ? 'Comprobando…' : 'Comprobar ahora'}
              </button>
              <button
                type="button"
                onClick={() => navigate('/exchange-rate')}
                className="h-11 px-3 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center gap-1.5 hover:bg-subtle transition-colors"
              >
                <History size={14} /> Historial <ArrowUpRight size={13} />
              </button>
            </div>
          </div>
        </div>

        <p className="rounded-xl border border-base bg-subtle p-3 text-sm font-medium leading-6 text-secondary">
          Los precios de compra y venta de elTOQUE se consultan desde el servidor de PALMYRA. Si no hay conexión o la fuente no responde en vivo, se conservan
          tus tasas y no se aplican datos viejos. La sincronización automática corre mientras PALMYRA esté abierto.
        </p>
      </section>
    </div>
  );
}
