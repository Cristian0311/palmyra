import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  BadgeDollarSign,
  BarChart3,
  Boxes,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleCheck,
  CloudUpload,
  Contact,
  CreditCard,
  Crown,
  Headset,
  Landmark,
  LineChart,
  Package,
  Palmtree,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Sprout,
  Truck,
  Users,
  Wallet,
  Warehouse,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { loadSubscriptionOverview, selectSubscriptionPlan } from '../services/subscription';
import {
  ACQUISITION_PAYMENTS,
  BILLING_MONTHS,
  PALMYRA_PLANS,
  getPlan,
  isPermanentPlan,
  renewalPeriod,
  type AcquisitionPaymentMethod,
  type BillingMonths,
  type PaidPlanCode,
} from '../config/saas';
import { buildWhatsAppPaymentUrl, paymentMethodLabel } from '../utils/whatsapp';
import { cn } from '../lib/utils';

const button = 'min-h-11 rounded-xl px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 disabled:opacity-50 disabled:cursor-not-allowed';
const panel = 'rounded-2xl border border-base bg-secondary p-5 sm:p-6';
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString('es-CU') : '—';
const money = (value: number) => value.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusName = (status?: string) => ({ active: 'Activo', trialing: 'Prueba existente', pending: 'Pendiente de confirmación', approved: 'Aprobada', rejected: 'Rechazada', cancelled: 'Cancelada', expired: 'Vencido', past_due: 'En período de gracia', pending_payment: 'Pago pendiente', paid: 'Pagada', open: 'Pendiente de pago', void: 'Anulada', suspended: 'Suspendido' }[status || ''] || status || 'Sin datos');

const PLAN_ICONS: Record<string, LucideIcon> = { free: Sprout, starter: Palmtree, growth: Truck, pro: Crown };
const PLAN_STYLES: Record<string, { icon: string; chip: string; ring: string }> = {
  free: { icon: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200', chip: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200', ring: 'ring-slate-300 dark:ring-slate-600' },
  starter: { icon: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300', chip: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300', ring: 'ring-sky-300 dark:ring-sky-700' },
  growth: { icon: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300', chip: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300', ring: 'ring-violet-400 dark:ring-violet-600' },
  pro: { icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300', chip: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300', ring: 'ring-emerald-400 dark:ring-emerald-600' },
};

const FEATURE_ICONS: Array<[RegExp, LucideIcon]> = [
  [/respaldo|nube/i, CloudUpload],
  [/almac[eé]n|multi-almac/i, Warehouse],
  [/empleado|equipo|roles|propietario/i, Users],
  [/producto|sku/i, Package],
  [/punto de venta|pos/i, ShoppingCart],
  [/caja/i, Wallet],
  [/inventario/i, Boxes],
  [/cliente|proveedor/i, Contact],
  [/offline/i, WifiOff],
  [/compras|recepci/i, Truck],
  [/transferencia/i, ArrowLeftRight],
  [/anal[ií]tica/i, LineChart],
  [/reporte/i, BarChart3],
  [/soporte/i, Headset],
];
const featureIcon = (feature: string): LucideIcon =>
  FEATURE_ICONS.find(([pattern]) => pattern.test(feature))?.[1] || Check;

const PAYMENT_ICONS: Record<string, LucideIcon> = {
  cup_cash: Wallet,
  cup_bank_transfer: Landmark,
  usd_cash: BadgeDollarSign,
};

function statusTone(status?: string) {
  if (status === 'active' || status === 'approved' || status === 'paid') return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
  if (status === 'pending' || status === 'open' || status === 'pending_payment' || status === 'past_due') return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300';
  if (status === 'suspended' || status === 'expired' || status === 'rejected') return 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300';
  return 'border-base bg-subtle text-secondary';
}

export default function Subscription() {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadSubscriptionOverview>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [planCode, setPlanCode] = useState<PaidPlanCode>('starter');
  const [paymentMethod, setPaymentMethod] = useState<AcquisitionPaymentMethod>('cup_cash');
  const [months, setMonths] = useState<BillingMonths>(1);
  const planPreselected = useRef(false);

  async function refresh() {
    setLoading(true);
    setError('');
    try { setData(await loadSubscriptionOverview()); }
    catch (caught: any) { setError(caught?.message || 'No se pudo cargar la suscripción.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (planPreselected.current || !data) return;
    const joined = data.subscription?.plans as any;
    const code = (Array.isArray(joined) ? joined[0]?.code : joined?.code) || data.ctx.subscription?.planCode;
    if (code === 'starter' || code === 'growth' || code === 'pro') setPlanCode(code);
    planPreselected.current = true;
  }, [data]);

  const subscription: any = data?.subscription;
  const currentCode = subscription?.plans?.code || data?.ctx.subscription?.planCode;
  const current = currentCode ? getPlan(currentCode) : null;
  const limits = subscription?.plans?.limits || data?.ctx.subscription?.limits;
  const permanent = isPermanentPlan(currentCode);
  const request = data?.request;
  const pending = request?.status === 'pending';
  const selected = getPlan(planCode);
  const remotePlan = data?.plans.find((plan) => plan.code === planCode);
  const catalogReady = Boolean(data?.plans.some((plan) => plan.code === 'free'));
  const expiry = subscription?.status === 'trialing' ? subscription.trial_ends_at : subscription?.current_period_end;
  const samePlanRenewal = Boolean(currentCode && currentCode !== 'free' && currentCode === planCode);
  const renewalPreview = useMemo(() => {
    if (!samePlanRenewal) return null;
    try { return renewalPeriod(expiry ?? null, new Date().toISOString(), months); }
    catch { return null; }
  }, [samePlanRenewal, expiry, months]);
  const contactUrl = pending ? buildWhatsAppPaymentUrl({
    companyName: data?.ctx.company?.name, planName: request.plan_name || request.plan_code,
    paymentMethod: request.payment_method, months: request.billing_months || 1,
    amount: request.quoted_amount == null ? undefined : Number(request.quoted_amount),
    currency: request.quoted_currency || 'USD', requestId: request.id,
  }) : '';

  function choosePlan(code: PaidPlanCode) {
    setPlanCode(code);
    setError('');
    setNotice('');
    requestAnimationFrame(() => {
      const target = document.getElementById('request-plan');
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (target as HTMLSelectElement | null)?.focus({ preventScroll: true });
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!remotePlan || pending || !data?.ctx.isOwner) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await selectSubscriptionPlan(remotePlan.id, paymentMethod, months);
      setNotice('Solicitud registrada. El plan actual y su vencimiento no cambian hasta la aprobación del pago.');
      await refresh();
    } catch (caught: any) { setError(caught?.message || 'No se pudo registrar la solicitud.'); }
    finally { setBusy(false); }
  }

  const CurrentIcon = current ? PLAN_ICONS[current.code] || Sprout : Sprout;

  return <main className="mx-auto w-full min-w-0 max-w-7xl space-y-6 pb-10 text-sm leading-6 text-primary" aria-busy={loading || busy}>
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">Cuenta · Planes</p>
        <h1 data-palmi-content="subscription" className="mt-1 text-3xl font-bold tracking-tight">Tu plan, sin sorpresas</h1>
        <p className="mt-2 text-muted">Consulta tus límites, extiende tu plan o solicita uno nuevo. Todo pago se confirma manualmente.</p>
      </div>
      <button type="button" disabled={busy || loading} onClick={() => void refresh()} className={cn(button, 'inline-flex items-center justify-center gap-2 border border-base bg-secondary')}>
        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />Actualizar
      </button>
    </header>

    {error && <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-red-900">{error}</p>}
    {notice && <p role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900">{notice}</p>}
    {loading && <p role="status" className="text-muted">Cargando datos de la suscripción…</p>}

    {data && <>
      <section className="relative overflow-hidden rounded-3xl border border-violet-500/30 bg-gradient-to-br from-violet-700 via-violet-800 to-indigo-900 p-5 text-white shadow-xl shadow-violet-900/20 sm:p-7" aria-labelledby="current-plan-title">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/25 bg-white/15" aria-hidden="true">
              <CurrentIcon className="h-7 w-7" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-white/70">Plan actual</p>
              <h2 id="current-plan-title" className="mt-1 text-3xl font-black tracking-tight">{subscription?.plans?.name || data.ctx.subscription?.planName || 'Sin plan'}</h2>
              <p className="mt-1 text-white/75">{permanent ? 'Gratis para siempre, con respaldo comercial en la nube.' : 'Renovable por 1, 3, 6 o 12 meses.'}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/30 bg-white/15 px-3 py-1 text-xs font-black uppercase tracking-wider">
              <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {statusName(data.ctx.company?.account_status === 'suspended' ? 'suspended' : subscription?.status)}
            </span>
            {currentCode && currentCode !== 'free' && <button type="button" disabled={busy || pending || !data.ctx.isOwner} onClick={() => choosePlan(currentCode as PaidPlanCode)} className={cn(button, 'inline-flex items-center gap-2 border border-white/30 bg-white/15 text-white hover:bg-white/25')}>
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />Extender plan
            </button>}
          </div>
        </div>

        <dl className="relative mt-6 grid gap-4 rounded-2xl border border-white/15 bg-slate-950/20 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs font-semibold uppercase tracking-wider text-white/60">Vencimiento</dt><dd className="mt-1 text-lg font-black">{permanent ? 'Sin vencimiento' : date(expiry)}</dd>{subscription?.grace_ends_at && <p className="text-xs text-white/65">Gracia hasta {date(subscription.grace_ends_at)}</p>}</div>
          <div><dt className="text-xs font-semibold uppercase tracking-wider text-white/60">Almacenes y SKUs</dt><dd className="mt-1 text-lg font-black">{String(limits?.warehouses ?? current?.warehouses ?? '—')} · {String(limits?.products ?? current?.products ?? '—')}</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-wider text-white/60">Equipo</dt><dd className="mt-1 text-lg font-black">{String(limits?.employees ?? current?.employees ?? '—')} empleado(s)</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-wider text-white/60">Respaldo</dt><dd className="mt-1 flex items-center gap-1.5 text-lg font-black"><CloudUpload className="h-4 w-4" aria-hidden="true" />Nube incluida</dd></div>
        </dl>
        {subscription?.status === 'trialing' && <p className="relative mt-4 text-sm text-white/75">Tu prueba existente conserva su fecha de vencimiento. Los nuevos registros ya no reciben una prueba promocional.</p>}
      </section>

      {!catalogReady && <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">El catálogo nuevo aún no está disponible en el servidor. No se enviarán solicitudes hasta completar el despliegue.</p>}

      <section aria-labelledby="comparison-title">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="comparison-title" className="text-xl font-bold">Compara los cuatro planes</h2>
            <p className="mt-1 text-muted">Precios de referencia en USD. Todos incluyen respaldo comercial en la nube.</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-base bg-secondary px-3 py-1 text-xs font-semibold text-muted"><Sparkles className="h-3.5 w-3.5 text-violet-600" aria-hidden="true" />Sin tarjeta automática</span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {PALMYRA_PLANS.map((plan) => {
            const Icon = PLAN_ICONS[plan.code] || Sprout;
            const styles = PLAN_STYLES[plan.code] || PLAN_STYLES.free;
            const isCurrent = currentCode === plan.code;
            return <article key={plan.code} className={cn(panel, 'flex flex-col', isCurrent && cn('ring-2', styles.ring))}>
              <div className="flex items-start justify-between gap-2">
                <span className={cn('flex h-11 w-11 items-center justify-center rounded-2xl', styles.icon)} aria-hidden="true"><Icon className="h-6 w-6" /></span>
                {isCurrent && <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-bold', styles.chip)}>Plan actual</span>}
              </div>
              <h3 className="mt-3 text-lg font-bold">{plan.name}</h3>
              <p className="mt-2 flex items-baseline gap-1"><span className="text-3xl font-black">{plan.price}</span><span className="text-sm font-semibold text-muted">USD{plan.code === 'free' ? ' · siempre' : ' / mes'}</span></p>
              <p className="mt-2 text-muted">{plan.description}</p>
              <ul className="mt-4 flex-1 space-y-2">
                {plan.features.map((feature) => {
                  const FeatureIcon = featureIcon(feature);
                  return <li key={feature} className="flex items-start gap-2"><FeatureIcon className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" /><span>{feature}</span></li>;
                })}
              </ul>
              {plan.code === 'free' ? (
                <p className="mt-5 flex items-start gap-2 border-t border-base pt-3 text-xs text-muted"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{isCurrent ? 'Tu plan Gratis no vence y conserva el respaldo en la nube.' : 'Se elige al crear la empresa. No extiende ni cancela un período pagado.'}</p>
              ) : (
                <button type="button" disabled={busy || pending || !data.ctx.isOwner} onClick={() => choosePlan(plan.code as PaidPlanCode)} className={cn(button, 'mt-5 inline-flex items-center justify-center gap-2 border border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300')}>
                  {isCurrent ? <><CalendarPlus className="h-4 w-4" aria-hidden="true" />Extender {plan.name}</> : <>Elegir {plan.name}</>}
                </button>
              )}
            </article>;
          })}
        </div>
      </section>

      {data.ctx.isOwner ? <>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <section className={panel} aria-labelledby="payment-title">
            <div className="flex items-center gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" aria-hidden="true"><CalendarClock className="h-4 w-4" /></span><h2 id="payment-title" className="text-xl font-bold">Solicitar o renovar</h2></div>
            <p className="mt-2 text-muted">La renovación del mismo plan suma meses desde la fecha mayor entre el vencimiento actual y la aprobación. No pierdes días ya pagados. Un cambio de plan inicia un nuevo período al aprobarse.</p>
            <form onSubmit={submit} className="mt-5 space-y-5">
              <fieldset disabled={busy || pending || !catalogReady} className="space-y-5 disabled:opacity-60">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-semibold" htmlFor="request-plan">Plan<select id="request-plan" value={planCode} onChange={(event) => setPlanCode(event.target.value as PaidPlanCode)} className="mt-2 min-h-11 w-full rounded-xl border border-base bg-primary px-3 text-sm">{PALMYRA_PLANS.filter((plan) => plan.code !== 'free').map((plan) => <option key={plan.code} value={plan.code}>{plan.name} · {plan.price} USD/mes</option>)}</select></label>
                  <label className="block text-sm font-semibold" htmlFor="request-months">Duración<select id="request-months" value={months} onChange={(event) => setMonths(Number(event.target.value) as BillingMonths)} className="mt-2 min-h-11 w-full rounded-xl border border-base bg-primary px-3 text-sm">{BILLING_MONTHS.map((value) => <option key={value} value={value}>{value} mes(es)</option>)}</select></label>
                </div>
                <fieldset>
                  <legend className="text-sm font-semibold">Forma de pago</legend>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">{ACQUISITION_PAYMENTS.map((method) => {
                    const Icon = PAYMENT_ICONS[method.code] || Wallet;
                    const active = paymentMethod === method.code;
                    return <label key={method.code} className={cn('flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-4', active ? 'border-violet-500 bg-violet-50 text-slate-900 dark:bg-violet-950/40 dark:text-violet-100' : 'border-base')}>
                      <input type="radio" name="payment-method" value={method.code} checked={active} onChange={() => setPaymentMethod(method.code)} className="mt-1 h-4 w-4 accent-violet-700" />
                      <span className="flex min-w-0 flex-1 items-start gap-2"><Icon className={cn('mt-0.5 h-4 w-4 shrink-0', active ? 'text-violet-700 dark:text-violet-300' : 'text-muted')} aria-hidden="true" /><span className="min-w-0"><span className="block font-semibold">{method.label}</span><span className="mt-1 block text-sm">{method.detail}</span></span></span>
                    </label>;
                  })}</div>
                </fieldset>
                <div className="rounded-xl border border-base bg-subtle p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div><p className="font-semibold">{selected.name} · {months} mes(es)</p><p className="mt-1 text-sm text-muted">{paymentMethod.startsWith('cup_') ? 'El importe final en CUP se acuerda y confirma manualmente. No se genera una conversión.' : 'Coordina las instrucciones oficiales con PALMYRA. No hay pasarela ni cobro automático.'}</p></div>
                    <p className="shrink-0 text-right"><span className="text-xl font-black">{money(selected.price * months)}</span><span className="block text-xs font-semibold text-muted">USD de referencia</span></p>
                  </div>
                  {samePlanRenewal && <p className="mt-3 flex items-start gap-2 border-t border-base pt-3 text-sm"><CalendarPlus className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" aria-hidden="true" /><span>{renewalPreview ? <>Al aprobarse, tu nuevo vencimiento sería el <strong>{date(renewalPreview.end)}</strong>. Conservas los días que ya pagaste.</> : 'La extensión se calcula desde tu vencimiento actual al aprobarse el pago.'}</span></p>}
                </div>
                <button type="submit" disabled={!remotePlan} className={cn(button, 'inline-flex w-full items-center justify-center gap-2 bg-violet-700 text-white hover:bg-violet-800 sm:w-auto')}>{busy ? 'Registrando…' : samePlanRenewal ? 'Solicitar extensión' : 'Enviar solicitud de pago'}</button>
              </fieldset>
              {pending && <p className="text-muted">Ya tienes una solicitud pendiente. Coordina su confirmación o rechazo antes de crear otra.</p>}
            </form>
          </section>

          <div className="space-y-4">
            {request && <section className={panel} aria-labelledby="request-status">
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="request-status" className="text-lg font-bold">Solicitud</h2><span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-bold', statusTone(request.status))}>{statusName(request.status)}</span></div>
              <p className="mt-3 font-semibold">{request.plan_name || request.plan_code}</p>
              <p className="text-muted">{request.billing_months || 1} mes(es) · {date(request.requested_at)}</p>
              <p className="text-muted">{paymentMethodLabel(request.payment_method)}</p>
              {request.note && <p className="mt-2 rounded-xl border border-base bg-subtle p-3 text-muted">{request.note}</p>}
              {pending && <><p className="mt-3 text-sm text-muted">Pendiente no significa pagado. Esta solicitud no activa prestaciones ni extiende la vigencia actual.</p><a href={contactUrl} target="_blank" rel="noopener noreferrer" className={cn(button, 'mt-4 inline-flex w-full items-center justify-center bg-violet-700 text-white')}>Coordinar pago por WhatsApp</a><p className="mt-2 text-xs text-muted">Se abrirá WhatsApp con empresa, plan e identificador de solicitud.</p></>}
            </section>}

            <section className={cn(panel, 'space-y-4')} aria-labelledby="how-title">
              <h2 id="how-title" className="text-lg font-bold">Cómo funciona</h2>
              <ol className="space-y-3">
                {[
                  ['Elige plan y duración', 'Puedes extender el plan activo sin esperar a que venza.', BadgeDollarSign],
                  ['Coordina el pago', 'WhatsApp deja constancia de empresa, plan y solicitud.', ArrowLeftRight],
                  ['Aprobación manual', 'El período empieza al aprobarse; nunca se cobra automático.', ShieldCheck],
                ].map(([title, detail, Icon]: any, index) => <li key={title} className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-black text-violet-700 dark:bg-violet-950 dark:text-violet-300" aria-hidden="true">{index + 1}</span>
                  <span className="min-w-0"><span className="flex items-center gap-1.5 font-semibold"><Icon className="h-4 w-4 text-violet-600" aria-hidden="true" />{title}</span><span className="mt-0.5 block text-sm text-muted">{detail}</span></span>
                </li>)}
              </ol>
            </section>
          </div>
        </div>

        <section className={panel} aria-labelledby="invoices-title">
          <div className="flex items-center gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" aria-hidden="true"><CreditCard className="h-4 w-4" /></span><h2 id="invoices-title" className="text-xl font-bold">Facturas</h2></div>
          <p className="mt-2 text-muted">Una factura pendiente no es un comprobante de pago. Los períodos definitivos se asignan al aprobar.</p>
          {data.invoices.length === 0 ? <p className="mt-5 text-muted">Todavía no hay facturas.</p> : <ul className="mt-4 divide-y divide-base">{data.invoices.map((invoice) => <li key={invoice.id} className="flex flex-col justify-between gap-2 py-4 sm:flex-row"><div><p className="break-all font-semibold">{invoice.invoice_number}</p><p className="text-muted">{date(invoice.period_start)} — {date(invoice.period_end)}{invoice.status === 'open' ? ' · período provisional' : ''}</p></div><div className="sm:text-right"><p className="font-semibold">{money(Number(invoice.amount))} {invoice.currency_code}</p><p className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-bold', statusTone(invoice.status))}>{statusName(invoice.status)}</p></div></li>)}</ul>}
        </section>
      </> : <p className={cn(panel, 'flex items-center gap-3')}><ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" />Solo el propietario puede solicitar planes y consultar facturas.</p>}
    </>}
  </main>;
}
