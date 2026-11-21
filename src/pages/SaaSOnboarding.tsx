import React, { useEffect, useState } from 'react';
import { ArrowLeft, Check, Building2, Lock, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ACQUISITION_PAYMENTS, BILLING_MONTHS, PALMYRA_PLANS, getPlan, isAcquisitionPaymentMethod, isBillingMonths, type AcquisitionPaymentMethod, type BillingMonths, type PlanCode } from '../config/saas';
import { createCompanyAcquisition } from '../services/subscription';
import { loadSaaSContext } from '../services/saas';
import { loadPlatformSupportSettings, type PlatformSocialLinks } from '../services/platformSupport';
import { consumePendingOfflineCredential } from '../services/offlineSaaSAuth';
import { registerCurrentDevice } from '../services/device';
import { getSupabase } from '../lib/supabase';

const input = 'mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-violet-600';
const isPlan = (value: unknown): value is PlanCode => PALMYRA_PLANS.some((plan) => plan.code === value);

export default function SaaSOnboarding() {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState('');
  const [warehouseName, setWarehouseName] = useState('Almacén principal');
  const [planCode, setPlanCode] = useState<PlanCode>(() => {
    const stored = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('palmyra_signup_plan');
    return isPlan(stored) ? stored : 'free';
  });
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
  const selected = getPlan(planCode);
  const facebookUrl = socialLinks.facebook_url;
  const whatsappUrl = socialLinks.whatsapp_channel_url;
  const socialLinksAvailable = Boolean(facebookUrl || whatsappUrl);
  const socialGateSatisfied = socialLinksAvailable
    && (!facebookUrl || followFacebook)
    && (!whatsappUrl || followWhatsapp);
  const freePlanLocked = planCode === 'free' && socialLinksAvailable && !socialVerified;

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
    event.preventDefault(); setError('');
    if (companyName.trim().length < 2 || warehouseName.trim().length < 2) { setError('Escribe el nombre de la empresa y del almacén (al menos 2 caracteres).'); return; }
    if (planCode === 'free' && socialLinksAvailable && !socialVerified) {
      setError('Plan Gratis: sigue la página de Facebook y únete al canal de WhatsApp. La verificación tarda 5 segundos y luego se desbloquea el plan.');
      return;
    }
    setBusy(true);
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
        sessionStorage.removeItem('palmyra_pending_onboarding');
        sessionStorage.setItem('palmyra_onboarding_completed', '1');
      } catch {}
      // Paid selections remain requests; the company starts on Gratis until manual approval.
      window.location.replace(result.request_id ? '/subscription' : '/');
    } catch (caught: any) {
      setError(caught?.message || 'No se pudo crear la empresa. Comprueba tu conexión e inténtalo de nuevo.');
      setBusy(false);
    }
  }

  return <main className="min-h-[100dvh] overflow-y-auto bg-slate-50 px-4 py-6 text-sm leading-6 text-slate-900" data-keyboard-viewport="native">
    <div className="mx-auto max-w-5xl">
      <button type="button" onClick={() => navigate('/landing')} disabled={busy} className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 font-semibold focus-visible:outline-violet-600"><ArrowLeft className="h-4 w-4" aria-hidden="true"/>Volver a PALMYRA</button>
      <header className="mb-6"><p className="text-xs font-semibold uppercase tracking-widest text-violet-700">Configuración inicial · Cuba</p><h1 className="mt-2 text-3xl font-bold tracking-tight">Un espacio para tu negocio</h1><p className="mt-3 text-slate-600">Comienza con Gratis, sin vencimiento, o solicita un plan de pago. Tu empresa comienza en Gratis hasta que PALMYRA confirme el pago.</p></header>
      <form onSubmit={createWorkspace} className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 sm:p-8" aria-busy={busy}>
        <fieldset disabled={busy} className="space-y-6">
          <legend className="flex items-center gap-2 text-xl font-bold"><Building2 className="h-5 w-5" aria-hidden="true"/>Tu empresa</legend>
          <div className="grid gap-4 pt-4 sm:grid-cols-2"><label className="font-semibold">Nombre de la empresa<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} minLength={2} maxLength={160} required autoComplete="organization" className={input}/></label><label className="font-semibold">Almacén principal<input value={warehouseName} onChange={(event) => setWarehouseName(event.target.value)} minLength={2} maxLength={120} required className={input}/></label></div>
          <fieldset><legend className="text-lg font-bold">Elige tu plan</legend><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{PALMYRA_PLANS.map((plan) => {
            const locked = plan.code === 'free' && socialLinksAvailable && !socialVerified;
            return <label key={plan.code} className={'relative min-h-11 rounded-xl border p-4 ' + (locked ? 'cursor-not-allowed border-slate-200 bg-slate-100 opacity-80' : 'cursor-pointer ' + (planCode === plan.code ? 'border-violet-500 bg-violet-50' : 'border-slate-200'))}>
              <span className="flex items-center justify-between gap-2"><span className="font-bold">{plan.name}</span><span className="flex items-center gap-1.5">{locked && <Lock className="h-4 w-4 text-slate-500" aria-hidden="true"/>}<input type="radio" name="onboarding-plan" value={plan.code} checked={planCode === plan.code} disabled={locked} onChange={() => setPlanCode(plan.code)} className="h-4 w-4 accent-violet-700"/></span></span>
              <span className="mt-2 block text-lg font-bold">{plan.price} USD<span className="text-sm font-normal">{plan.code === 'free' ? ' · siempre' : '/mes'}</span></span>
              <span className="mt-3 block">{plan.warehouses} almacén(es)<br/>{plan.employees} empleado(s) + propietario<br/>{plan.products} SKUs</span>
              <span className="mt-3 block text-xs font-semibold text-violet-800">{locked ? 'Sigue Facebook y WhatsApp para desbloquear' : plan.code === 'free' ? 'Sin vencimiento · solo local' : 'Confirmación manual del pago'}</span>
            </label>;
          })}</div></fieldset>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><h2 className="font-bold">{selected.name}</h2><p className="mt-1 text-slate-600">{selected.description}</p>{planCode === 'free' && <p className="mt-2 text-slate-600">Incluye POS básico, caja en efectivo, inventario y reportes básicos. No incluye respaldo comercial en la nube. Conserva una copia local de tus datos.</p>}</div>
          {planCode === 'free' && <section aria-labelledby="plan-gratis-social" className="rounded-xl border border-violet-300 bg-violet-50 p-4 text-slate-900">
            <h2 id="plan-gratis-social" className="flex items-center gap-2 text-base font-bold text-violet-900"><Lock className="h-4 w-4" aria-hidden="true"/>Plan Gratis: sigue a PALMYRA</h2>
            {socialLinksAvailable ? <>
              <p className="mt-1 text-slate-700">El plan Gratis requiere seguir la página de Facebook <strong>y</strong> unirte al canal de WhatsApp de PALMYRA. Abre los dos botones: al completarlos se verifica la suscripción durante 5 segundos y el plan queda desbloqueado.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {facebookUrl && <div className="flex flex-col rounded-xl border border-violet-200 bg-white p-3">
                  <a href={facebookUrl} target="_blank" rel="noopener noreferrer" onClick={() => setFollowFacebook(true)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 text-center text-sm font-semibold text-white focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-violet-700">{followFacebook ? 'Facebook abierto · ir de nuevo' : 'Seguir en Facebook'}</a>
                  <p className={'mt-2 text-xs font-semibold ' + (followFacebook ? 'text-emerald-700' : 'text-slate-600')}>Paso 1 · {followFacebook ? 'completado' : 'pendiente'}</p>
                </div>}
                {whatsappUrl && <div className="flex flex-col rounded-xl border border-violet-200 bg-white p-3">
                  <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" onClick={() => setFollowWhatsapp(true)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 text-center text-sm font-semibold text-white focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-violet-700">{followWhatsapp ? 'Canal abierto · ir de nuevo' : 'Unirme al canal de WhatsApp'}</a>
                  <p className={'mt-2 text-xs font-semibold ' + (followWhatsapp ? 'text-emerald-700' : 'text-slate-600')}>Paso 2 · {followWhatsapp ? 'completado' : 'pendiente'}</p>
                </div>}
              </div>
              {socialGateSatisfied && !socialVerified && <p role="status" className="mt-3 inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm font-bold text-violet-800"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true"/>Verificando suscripción… {verifySeconds} s</p>}
              {socialVerified && <p role="status" className="mt-3 inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800"><Check className="h-4 w-4" aria-hidden="true"/>Verificado. Ya puedes crear la empresa con el plan Gratis.</p>}
            </> : <p className="mt-1 text-slate-700">Los enlaces se publicarán pronto; puedes continuar y seguirlos desde Centro de atención → Soporte.</p>}
          </section>}
          {planCode !== 'free' && <>
            <label className="block font-semibold">Duración<select value={months} onChange={(event) => setMonths(Number(event.target.value) as BillingMonths)} className={input}>{BILLING_MONTHS.map((value) => <option key={value} value={value}>{value} mes(es) · {selected.price * value} USD</option>)}</select></label>
            <fieldset><legend className="font-semibold">Forma de pago</legend><div className="mt-2 grid gap-3 sm:grid-cols-2">{ACQUISITION_PAYMENTS.map((method) => <label key={method.code} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4"><input type="radio" name="onboarding-payment" value={method.code} checked={paymentMethod === method.code} onChange={() => setPaymentMethod(method.code)} className="mt-1 h-4 w-4 accent-violet-700"/><span><span className="block font-semibold">{method.label}</span><span className="block text-slate-600">{method.detail}</span></span></label>)}</div></fieldset>
            <p className="text-slate-600">No se cobra automáticamente. En CUP, acuerda el importe con PALMYRA antes del pago; no usamos tasas de cambio automáticas. Una solicitud pendiente no activa el plan de pago.</p>
          </>}
          <p className="text-slate-600">El propietario usa su cuenta PALMYRA para acceder al POS. El plan Gratis exige seguir la página de Facebook y unirse al canal de WhatsApp antes de seleccionarlo.</p>
          {error && <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-rose-900">{error}</p>}
          <button type="submit" disabled={busy || freePlanLocked} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-700 px-5 py-3 font-semibold text-white focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-violet-700 disabled:cursor-not-allowed disabled:opacity-50"><Check className="h-4 w-4" aria-hidden="true"/>{busy ? 'Creando empresa…' : freePlanLocked ? 'Desbloquea el plan Gratis para continuar' : planCode === 'free' ? 'Crear empresa con Gratis' : 'Crear empresa y registrar solicitud'}</button>
          {busy && <p role="status">No cierres esta ventana mientras se confirma la creación.</p>}
        </fieldset>
      </form>
    </div>
  </main>;
}
