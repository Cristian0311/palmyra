import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Banknote, Building2, Caravan, Castle, Check, CloudOff, CloudUpload,
  Landmark, Loader2, Lock, Sparkles, Store, Users, Wallet
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useDocumentScrollPage } from "../hooks/useDocumentScrollPage";
import {
  ACQUISITION_PAYMENTS, BILLING_MONTHS, PALMYRA_PLANS, getPlan, isAcquisitionPaymentMethod,
  isBillingMonths, type AcquisitionPaymentMethod, type BillingMonths, type PlanCode
} from '../config/saas';
import { createCompanyAcquisition } from '../services/subscription';
import { companyCreatedAlertLines, sendOwnerAlert } from '../services/ownerAlerts';
import { paymentMethodLabel } from '../utils/whatsapp';
import { loadSaaSContext } from '../services/saas';
import { loadPlatformSupportSettings, type PlatformSocialLinks } from '../services/platformSupport';
import { consumePendingOfflineCredential } from '../services/offlineSaaSAuth';
import { registerCurrentDevice } from '../services/device';
import { getSupabase } from '../lib/supabase';
import { entryPathForSurface, lockDevAppSurface } from '../lib/appSurface';
import { PalmyraWordmark } from '../components/PalmyraWordmark';

const input = 'mt-1.5 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600';
const card = 'rounded-3xl border border-violet-100 bg-white p-4 sm:p-5';
const isPlan = (value: unknown): value is PlanCode => PALMYRA_PLANS.some((plan) => plan.code === value);

const PLAN_META: Record<PlanCode, { icon: typeof CloudOff; note: string }> = {
  free: { icon: CloudOff, note: 'Sin vencimiento' },
  starter: { icon: Sparkles, note: 'Inicio esencial' },
  growth: { icon: Caravan, note: 'Operación en expansión' },
  pro: { icon: Castle, note: 'Control empresarial' },
};

const PAYMENT_ICONS: Record<AcquisitionPaymentMethod, typeof Banknote> = {
  cup_cash: Banknote,
  cup_bank_transfer: Landmark,
  usd_cash: Wallet,
};

function readStoredPlan(): PlanCode {
  try {
    const stored = sessionStorage.getItem('palmyra_signup_plan') || localStorage.getItem('palmyra_signup_plan');
    return isPlan(stored) ? stored : 'free';
  } catch {
    return 'free';
  }
}

export default function SaaSOnboarding() {
  useDocumentScrollPage();
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState('');
  const [warehouseName, setWarehouseName] = useState('Almacén principal');
  const [planCode, setPlanCode] = useState<PlanCode>(readStoredPlan);
  const [paymentMethod, setPaymentMethod] = useState<AcquisitionPaymentMethod>('cup_cash');
  const [months, setMonths] = useState<BillingMonths>(1);
  const [socialLinks, setSocialLinks] = useState<PlatformSocialLinks>({ facebook_url: null, whatsapp_channel_url: null });
  const [followFacebook, setFollowFacebook] = useState(false);
  const [followWhatsapp, setFollowWhatsapp] = useState(false);
  const [socialVerified, setSocialVerified] = useState(false);
  const [verifySeconds, setVerifySeconds] = useState<number>(5);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guardRef = useRef(false);

  const selected = getPlan(planCode);
  const selectedMeta = PLAN_META[selected.code];
  const SelectedIcon = selectedMeta.icon;
  const facebookUrl = socialLinks.facebook_url;
  const whatsappUrl = socialLinks.whatsapp_channel_url;
  const socialLinksAvailable = Boolean(facebookUrl || whatsappUrl);
  const socialGateSatisfied = socialLinksAvailable
    && (!facebookUrl || followFacebook)
    && (!whatsappUrl || followWhatsapp);
  const freePlanLocked = planCode === 'free' && socialLinksAvailable && !socialVerified;
  const totalUsd = selected.price * months;
  const paymentLabel = ACQUISITION_PAYMENTS.find((method) => method.code === paymentMethod)?.label || '';

  // Una cuenta que ya tiene empresa nunca vuelve a la configuración inicial.
  useEffect(() => {
    if (guardRef.current) return;
    guardRef.current = true;
    void (async () => {
      let context = null;
      try {
        context = await loadSaaSContext();
      } catch { /* La comprobación se reintenta al hidratar la sesión. */ }
      if (context?.companyId) {
        try { sessionStorage.removeItem('palmyra_pending_onboarding'); } catch {}
        lockDevAppSurface();
        window.location.replace(entryPathForSurface());
        return;
      }
      // Sin sesión no hay forma de crear la empresa. Antes, una marca vieja en
      // sessionStorage abría el formulario y el usuario lo perdía todo al enviar.
      if (!context && (typeof navigator === 'undefined' || navigator.onLine)) {
        try {
          const { data } = (await getSupabase()?.auth.getSession()) || { data: { session: null } };
          if (!data?.session) window.location.replace('/auth?mode=signin');
        } catch { /* Si no se puede comprobar, el formulario seguirá disponible. */ }
      }
    })();
  }, []);

  useEffect(() => {
    let active = true;
    // Social links are optional on the server: missing URLs never block signup.
    void loadPlatformSupportSettings()
      .then((settings) => {
        if (active) setSocialLinks({ facebook_url: settings.facebook_url, whatsapp_channel_url: settings.whatsapp_channel_url });
      })
      .catch(() => { /* Keep the neutral note when the platform settings are unavailable. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const auth = await getSupabase()?.auth.getUser();
        const userId = auth?.data.user?.id;
        if (!active || !userId) return;
        // Retain business-name and social-follow drafts between visits.
        const key = 'palmyra_onboarding_draft_v3:' + userId;
        const draft = JSON.parse(localStorage.getItem(key) || 'null');
        if (draft) {
          if (typeof draft.companyName === 'string') setCompanyName(draft.companyName);
          if (typeof draft.warehouseName === 'string') setWarehouseName(draft.warehouseName);
          if (isPlan(draft.planCode)) setPlanCode(draft.planCode);
          if (isAcquisitionPaymentMethod(draft.paymentMethod)) setPaymentMethod(draft.paymentMethod);
          if (isBillingMonths(draft.months)) setMonths(draft.months);
          if (typeof draft.followFacebook === 'boolean') setFollowFacebook(draft.followFacebook);
          if (typeof draft.followWhatsapp === 'boolean') setFollowWhatsapp(draft.followWhatsapp);
        }
        setStorageKey(key);
      } catch { /* Local draft storage is optional. */ }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ companyName, warehouseName, planCode, paymentMethod, months, followFacebook, followWhatsapp })); } catch {}
  }, [storageKey, companyName, warehouseName, planCode, paymentMethod, months, followFacebook, followWhatsapp]);

  // Free plan rule: both official channels must be opened, then a visible
  // 5-second check runs before the plan can be selected.
  useEffect(() => {
    if (!socialGateSatisfied || socialVerified) return;
    let remaining = 5;
    setVerifySeconds(remaining);
    const timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(timer);
        setSocialVerified(true);
      } else {
        setVerifySeconds(remaining);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [socialGateSatisfied, socialVerified]);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (companyName.trim().length < 2 || warehouseName.trim().length < 2) {
      setError('Escribe el nombre de la empresa y del almacén (al menos 2 caracteres).');
      return;
    }
    if (planCode === 'free' && socialLinksAvailable && !socialVerified) {
      setError('Plan Gratis: sigue la página de Facebook y únete al canal de WhatsApp. La verificación tarda 5 segundos y luego se desbloquea el plan.');
      return;
    }
    setBusy(true);
    // La empresa nueva también entra por la pantalla de descarga: el permiso
    // local de desarrollo no debe dejar ver la operación antes de tiempo.
    lockDevAppSurface();
    try {
      const result = await createCompanyAcquisition({ name: companyName, warehouseName, planCode, paymentMethod, months });
      if (!result?.company_id || !result.warehouse_id) throw new Error('El servidor no confirmó la creación de la empresa.');
      try { await registerCurrentDevice(result.company_id, result.warehouse_id); } catch { /* App retries device registration. */ }
      try {
        const context = await loadSaaSContext(true);
        if (context?.companyId === result.company_id) await consumePendingOfflineCredential(context);
      } catch { /* Online onboarding remains valid; offline preparation can be retried. */ }
      try {
        if (storageKey) localStorage.removeItem(storageKey);
        sessionStorage.removeItem('palmyra_signup_plan');
        localStorage.removeItem('palmyra_signup_plan');
        sessionStorage.removeItem('palmyra_pending_onboarding');
        sessionStorage.setItem('palmyra_onboarding_completed', '1');
      } catch {}
      // Paid selections remain requests; the company starts on Gratis until manual approval.
      await sendOwnerAlert('company_new', companyCreatedAlertLines({
        companyName,
        planName: getPlan(planCode).name,
        paymentMethodLabel: paymentMethodLabel(paymentMethod),
        months,
      }), result.company_id);
      // El pago del plan se completa en web; la operación en cambio exige la app.
      window.location.replace(result.request_id ? '/subscription' : entryPathForSurface());
    } catch (caught: any) {
      setError(caught?.message || 'No se pudo crear la empresa. Comprueba tu conexión e inténtalo de nuevo.');
      setBusy(false);
    }
  }

  return (
    <main className="palmyra-scroll-page min-h-[100dvh] overflow-y-auto bg-[#F7F5FC] px-3 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))] text-sm leading-6 text-slate-900 scroll-pb-28 sm:px-5 sm:py-6" data-keyboard-viewport="native">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => navigate('/landing')} disabled={busy} aria-label="Ir a la página de inicio de PALMYRA">
            <PalmyraWordmark className="h-7 w-auto sm:h-9" />
          </button>
          <button
            type="button"
            onClick={() => navigate('/landing')}
            disabled={busy}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-violet-200 bg-white px-3 text-[11px] font-black text-[#5B2DBA]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Volver
          </button>
        </header>

        <section className="relative mt-4 overflow-hidden rounded-3xl bg-gradient-to-br from-[#3B1B78] via-[#4B239B] to-[#6535C5] p-5 text-white sm:p-6">
          <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-[#9B7BE8]/30 blur-3xl" aria-hidden="true" />
          <div className="relative">
            <p className="text-[10px] font-black uppercase tracking-[.2em] text-violet-200">Configuración inicial · Cuba</p>
            <h1 className="mt-1.5 text-2xl font-black tracking-[-.03em] sm:text-3xl">Deja listo tu espacio</h1>
            <p className="mt-2 max-w-2xl text-xs leading-6 text-violet-100/80">
              Dos datos y un plan. Tu empresa empieza en Gratis sin vencimiento; si eliges un plan de pago, queda como solicitud hasta que PALMYRA confirme el pago.
            </p>
            <ol className="mt-4 flex flex-wrap gap-2 text-[10px] font-black">
              {[
                ['1', 'Empresa'],
                ['2', 'Plan'],
                ['3', 'Listo'],
              ].map(([step, label], index) => (
                <li key={step} className={'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ' + (index < 2 ? 'border-white/30 bg-white/15 text-white' : 'border-white/15 bg-white/5 text-violet-200/70')}>
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-[10px]">{step}</span>{label}
                </li>
              ))}
            </ol>
          </div>
        </section>

        <form onSubmit={createWorkspace} className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]" aria-busy={busy}>
          <div className="space-y-4">
            <section className={card} aria-labelledby="company-title">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]"><Building2 className="h-4 w-4" aria-hidden="true" /></span>
                <div>
                  <h2 id="company-title" className="text-base font-black text-[#3B1B78]">Tu empresa</h2>
                  <p className="text-[11px] text-slate-500">El nombre que verán tu equipo y tus clientes.</p>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block text-[11px] font-black uppercase tracking-wide text-slate-500">
                  Nombre de la empresa
                  <input value={companyName} onChange={(event) => setCompanyName(event.target.value)} minLength={2} maxLength={160} required autoComplete="organization" disabled={busy} className={input} placeholder="Mi negocio" />
                </label>
                <label className="block text-[11px] font-black uppercase tracking-wide text-slate-500">
                  Almacén principal
                  <input value={warehouseName} onChange={(event) => setWarehouseName(event.target.value)} minLength={2} maxLength={120} required disabled={busy} className={input} placeholder="Almacén principal" />
                </label>
              </div>
            </section>

            <section className={card} aria-labelledby="plan-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]"><Store className="h-4 w-4" aria-hidden="true" /></span>
                  <div>
                    <h2 id="plan-title" className="text-base font-black text-[#3B1B78]">Elige tu plan</h2>
                    <p className="text-[11px] text-slate-500">Los cuatro planes incluyen respaldo comercial en la nube y modo offline.</p>
                  </div>
                </div>
                <span className="rounded-full border border-violet-200 bg-[#F7F5FC] px-3 py-1 text-[10px] font-black uppercase tracking-wider text-[#5B2DBA]">Sin cobro automático</span>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {PALMYRA_PLANS.map((plan) => {
                  const meta = PLAN_META[plan.code];
                  const Icon = meta.icon;
                  const active = planCode === plan.code;
                  const locked = plan.code === 'free' && socialLinksAvailable && !socialVerified;
                  const featured = plan.code === 'growth';
                  return (
                    <label
                      key={plan.code}
                      className={'relative flex flex-col rounded-2xl border p-3.5 transition ' + (
                        active
                          ? 'border-[#8B63E6] bg-[#F7F5FC] shadow-[0_18px_40px_-30px_rgba(101,53,197,.65)]'
                          : 'border-violet-100 bg-white hover:border-violet-300'
                      ) + (locked ? ' cursor-not-allowed opacity-70' : ' cursor-pointer')}
                    >
                      <input
                        type="radio"
                        name="onboarding-plan"
                        value={plan.code}
                        checked={active}
                        disabled={locked}
                        onChange={() => setPlanCode(plan.code)}
                        className="sr-only"
                      />
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]"><Icon className="h-4 w-4" aria-hidden="true" /></span>
                        <div className="flex items-center gap-1.5">
                          {featured ? <span className="rounded-full bg-[#5B2DBA] px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-white">Más elegido</span> : null}
                          {locked ? <Lock className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" /> : null}
                          <span className={'flex h-4 w-4 items-center justify-center rounded-full border-2 ' + (active ? 'border-[#5B2DBA]' : 'border-slate-300')} aria-hidden="true">
                            {active ? <span className="h-2 w-2 rounded-full bg-[#5B2DBA]" /> : null}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between gap-2">
                        <h3 className="text-[15px] font-black text-[#3B1B78]">{plan.name}</h3>
                        <p className="text-lg font-black text-[#3B1B78]">
                          {plan.price === 0 ? 'Gratis' : `${plan.price} USD`}
                          {plan.price !== 0 ? <span className="ml-0.5 text-[10px] font-bold text-slate-400">/mes</span> : null}
                        </p>
                      </div>
                      <p className="text-[10px] font-black uppercase tracking-wide text-[#7C4DDE]">{meta.note}</p>
                      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                        {[
                          [String(plan.warehouses), 'Almacén'],
                          [String(plan.employees), 'Empleados'],
                          [String(plan.products), 'SKUs'],
                        ].map(([value, label]) => (
                          <div key={label} className="rounded-lg border border-violet-100 bg-white px-1.5 py-1.5 text-center">
                            <p className="text-[12px] font-black text-[#5B2DBA]">{value}</p>
                            <p className="text-[10px] font-bold uppercase text-slate-400">{label}</p>
                          </div>
                        ))}
                      </div>
                      {active ? (
                        <>
                          <p className="mt-2.5 text-[11px] leading-5 text-slate-500">{plan.description}</p>
                          <ul className="mt-2 space-y-1">
                            {plan.features.slice(0, 6).map((feature) => (
                              <li key={feature} className="flex items-start gap-1.5 text-[11px] leading-5 text-slate-600">
                                <Check className="mt-0.5 h-3 w-3 shrink-0 text-[#6535C5]" aria-hidden="true" />{feature}
                              </li>
                            ))}
                          </ul>
                          {plan.features.length > 6 ? (
                            <p className="mt-1 text-[10px] font-bold text-[#7C4DDE]">+ {plan.features.length - 6} prestaciones incluidas</p>
                          ) : null}
                        </>
                      ) : (
                        <p className="mt-2.5 line-clamp-2 text-[11px] leading-5 text-slate-500">{plan.description}</p>
                      )}
                      <p className="mt-auto pt-2.5 text-[10px] font-bold text-slate-400">
                        {locked
                          ? 'Sigue Facebook y WhatsApp para desbloquear'
                          : plan.code === 'free'
                            ? 'Sin vencimiento · respaldo en la nube'
                            : 'Confirmación manual del pago'}
                      </p>
                    </label>
                  );
                })}
              </div>

              {planCode === 'free' && (
                <section aria-labelledby="plan-gratis-social" className="mt-3 rounded-2xl border border-violet-200 bg-[#F7F5FC] p-3.5">
                  <h3 id="plan-gratis-social" className="flex items-center gap-2 text-sm font-black text-[#3B1B78]">
                    <Lock className="h-4 w-4 text-[#6535C5]" aria-hidden="true" /> Plan Gratis: sigue a PALMYRA
                  </h3>
                  {socialLinksAvailable ? (
                    <>
                      <p className="mt-1 text-[11px] leading-5 text-slate-600">
                        El plan Gratis requiere seguir la página de Facebook <strong>y</strong> unirte al canal de WhatsApp de PALMYRA. Abre los dos botones: la verificación tarda 5 segundos y el plan queda desbloqueado.
                      </p>
                      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                        {facebookUrl && (
                          <div className="rounded-xl border border-violet-200 bg-white p-2.5">
                            <a href={facebookUrl} target="_blank" rel="noopener noreferrer" onClick={() => setFollowFacebook(true)} className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-[#5B2DBA] px-3 text-center text-[11px] font-black text-white">
                              {followFacebook ? 'Facebook abierto · ir de nuevo' : 'Seguir en Facebook'}
                            </a>
                            <p className={'mt-1.5 text-[10px] font-bold ' + (followFacebook ? 'text-emerald-700' : 'text-slate-500')}>Paso 1 · {followFacebook ? 'completado' : 'pendiente'}</p>
                          </div>
                        )}
                        {whatsappUrl && (
                          <div className="rounded-xl border border-violet-200 bg-white p-2.5">
                            <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" onClick={() => setFollowWhatsapp(true)} className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-[#5B2DBA] px-3 text-center text-[11px] font-black text-white">
                              {followWhatsapp ? 'Canal abierto · ir de nuevo' : 'Unirme al canal de WhatsApp'}
                            </a>
                            <p className={'mt-1.5 text-[10px] font-bold ' + (followWhatsapp ? 'text-emerald-700' : 'text-slate-500')}>Paso 2 · {followWhatsapp ? 'completado' : 'pendiente'}</p>
                          </div>
                        )}
                      </div>
                      {socialGateSatisfied && !socialVerified && (
                        <p role="status" className="mt-2.5 inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-3 py-1.5 text-[11px] font-bold text-[#5B2DBA]">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Verificando suscripción… {verifySeconds} s
                        </p>
                      )}
                      {socialVerified && (
                        <p role="status" className="mt-2.5 inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-800">
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />Verificado. Ya puedes crear la empresa con el plan Gratis.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-[11px] leading-5 text-slate-600">Los enlaces se publicarán pronto; puedes continuar y seguirlos desde Centro de atención → Soporte.</p>
                  )}
                </section>
              )}

              {planCode !== 'free' && (
                <div className="mt-4 space-y-3 border-t border-violet-100 pt-4">
                  <fieldset>
                    <legend className="text-[11px] font-black uppercase tracking-wide text-slate-500">Duración</legend>
                    <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {BILLING_MONTHS.map((value) => (
                        <button
                          key={value}
                          type="button"
                          disabled={busy}
                          onClick={() => setMonths(value)}
                          className={'min-h-11 rounded-xl border px-2 py-1.5 text-center text-[11px] font-black transition ' + (
                            months === value
                              ? 'border-[#8B63E6] bg-[#EFE8FF] text-[#3B1B78]'
                              : 'border-violet-100 bg-white text-slate-500 hover:border-violet-300'
                          )}
                        >
                          {value} {value === 1 ? 'mes' : 'meses'}
                          <span className="mt-0.5 block text-[10px] font-bold text-[#7C4DDE]">{selected.price * value} USD</span>
                        </button>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="text-[11px] font-black uppercase tracking-wide text-slate-500">Forma de pago</legend>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                      {ACQUISITION_PAYMENTS.map((method) => {
                        const Icon = PAYMENT_ICONS[method.code];
                        const active = paymentMethod === method.code;
                        return (
                          <label
                            key={method.code}
                            className={'flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border p-2.5 ' + (active ? 'border-[#8B63E6] bg-[#F7F5FC]' : 'border-violet-100 bg-white')}
                          >
                            <input type="radio" name="onboarding-payment" value={method.code} checked={active} disabled={busy} onChange={() => setPaymentMethod(method.code)} className="mt-1 h-3.5 w-3.5 accent-[#6535C5]" />
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 text-[11px] font-black text-[#3B1B78]"><Icon className="h-3.5 w-3.5 text-[#6535C5]" aria-hidden="true" />{method.label}</span>
                              <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{method.detail}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <p className="text-[11px] leading-5 text-slate-500">
                    No se cobra automáticamente. En CUP, acuerda el importe con PALMYRA antes del pago; no usamos tasas automáticas. Una solicitud pendiente no activa el plan de pago.
                  </p>
                </div>
              )}
            </section>

            {error && <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-3.5 text-[11px] font-bold text-rose-800">{error}</p>}
          </div>

          <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
            <section className="rounded-3xl border border-violet-100 bg-white p-4">
              <p className="text-[10px] font-black uppercase tracking-[.18em] text-[#7C4DDE]">Resumen</p>
              <div className="mt-2 flex items-center gap-2.5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]"><SelectedIcon className="h-5 w-5" aria-hidden="true" /></span>
                <div className="min-w-0">
                  <p className="truncate text-base font-black text-[#3B1B78]">{selected.name}</p>
                  <p className="text-[10px] font-bold text-slate-400">{selectedMeta.note}</p>
                </div>
              </div>
              <dl className="mt-3 space-y-1.5 border-t border-violet-100 pt-3 text-[11px]">
                <div className="flex items-center justify-between gap-2"><dt className="text-slate-500">Almacenes</dt><dd className="font-black text-[#3B1B78]">{selected.warehouses}</dd></div>
                <div className="flex items-center justify-between gap-2"><dt className="text-slate-500">Equipo</dt><dd className="font-black text-[#3B1B78]">{selected.employees} + propietario</dd></div>
                <div className="flex items-center justify-between gap-2"><dt className="text-slate-500">Productos</dt><dd className="font-black text-[#3B1B78]">{selected.products} SKUs</dd></div>
                {planCode !== 'free' ? <div className="flex items-center justify-between gap-2"><dt className="text-slate-500">Duración</dt><dd className="font-black text-[#3B1B78]">{months} {months === 1 ? 'mes' : 'meses'}</dd></div> : null}
                {planCode !== 'free' ? <div className="flex items-start justify-between gap-2"><dt className="text-slate-500">Pago</dt><dd className="max-w-[60%] text-right font-black text-[#3B1B78]">{paymentLabel}</dd></div> : null}
              </dl>
              <div className="mt-3 flex items-end justify-between gap-2 rounded-2xl bg-[#F7F5FC] px-3 py-2.5">
                <span className="text-[10px] font-black uppercase tracking-wide text-slate-500">{planCode === 'free' ? 'Precio' : 'Total'}</span>
                <span className="text-right">
                  <span className="block text-xl font-black text-[#3B1B78]">{planCode === 'free' ? 'Gratis' : `${totalUsd} USD`}</span>
                  <span className="block text-[10px] font-bold text-slate-400">{planCode === 'free' ? 'Sin vencimiento' : `${selected.price} USD × ${months} · confirmación manual`}</span>
                </span>
              </div>
              <button
                type="submit"
                disabled={busy || freePlanLocked}
                className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#5B2DBA] px-4 text-xs font-black text-white hover:bg-[#4B239B] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
                {busy
                  ? 'Creando empresa…'
                  : freePlanLocked
                    ? 'Desbloquea Gratis para continuar'
                    : planCode === 'free'
                      ? 'Crear empresa con Gratis'
                      : 'Crear empresa y solicitar plan'}
              </button>
              <p className="mt-2 text-[10px] leading-4 text-slate-400">El propietario usa su cuenta PALMYRA para entrar al POS. Al crear la empresa se registra este dispositivo.</p>
            </section>

            <section className="rounded-3xl border border-violet-100 bg-[#EFE8FF]/70 p-3.5 text-[11px] leading-5 text-[#3B1B78]">
              <p className="flex items-center gap-1.5 font-black"><CloudUpload className="h-3.5 w-3.5" aria-hidden="true" /> Respaldo en la nube incluido</p>
              <p className="mt-1 text-[#4B3A6B]">Los cuatro planes sincronizan tu operación con PALMYRA y funcionan sin internet cuando la conexión falla.</p>
            </section>

            <section className="rounded-3xl border border-violet-100 bg-white p-3.5 text-[11px] leading-5 text-slate-500">
              <p className="flex items-center gap-1.5 font-black text-[#3B1B78]"><Users className="h-3.5 w-3.5 text-[#6535C5]" aria-hidden="true" /> ¿Necesitas más?</p>
              <button
                type="button"
                onClick={() => navigate('/landing')}
                className="mt-1 inline-flex items-center gap-1 font-black text-[#6535C5]"
              >
                Comparar planes completos <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </button>
            </section>
          </aside>
        </form>
      </div>
    </main>
  );
}
