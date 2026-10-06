import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  CreditCard,
  Landmark,
  Package,
  ShieldCheck,
  Sparkles,
  Users,
  Warehouse,
  WalletCards,
  LockKeyhole,
  Caravan,
  Castle
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PALMYRA_PLANS, type PlanCode } from "../config/saas";
import { createCompanyOnboarding } from "../services/saas";
import { registerCurrentDevice } from "../services/device";
import { getSupabase } from "../lib/supabase";
import { goToWhatsAppPayment } from "../utils/whatsapp";
import { DEFAULT_FACEBOOK_URL, loadPublicSocialLinks, type PlatformSocialLinks } from "../services/platformSupport";

const planIcons: Record<PlanCode, typeof Sparkles> = {
  starter: Sparkles,
  growth: Caravan,
  pro: Castle
};

type OnboardingDraft = {
  companyName: string;
  warehouseName: string;
  planCode: PlanCode;
  paymentMethod: "manual_cash" | "manual_bank_transfer";
  facebookOpened: boolean;
  whatsappOpened: boolean;
  socialVerified: boolean;
  socialVerifyingUntil: number | null;
};

const ONBOARDING_DRAFT_PREFIX = "palmyra_onboarding_draft_v3:";

function getErrorMessage(error: unknown, stage: string) {
  const source = error as any;
  const raw = String(
    source?.message ||
    source?.error_description ||
    source?.details ||
    source?.hint ||
    ""
  ).trim();

  const map: Record<string, string> = {
    plan_warehouses_limit: "El primer almacén se crea automáticamente durante la configuración.",
    plan_warehouse_limit: "El primer almacén está incluido en tu plan.",
    plan_warehouse_limit_reached: "Has alcanzado el límite de almacenes de este plan.",
    company_already_exists: "Esta cuenta ya tiene una empresa. No puedes crear una segunda empresa.",
    company_slug_taken: "Ese nombre de empresa ya está siendo utilizado. Prueba con otro nombre.",
    invalid_company_name: "Escribe un nombre de empresa válido.",
    invalid_company_slug: "El nombre de empresa contiene caracteres no válidos.",
    invalid_warehouse_name: "Escribe un nombre de almacén válido.",
    invalid_company_currency: "La moneda configurada para Cuba no está disponible.",
    invalid_plan: "El plan seleccionado no es válido.",
    plan_not_available: "El plan seleccionado no está disponible en este momento.",
    authentication_required: "La sesión expiró. Vuelve a iniciar sesión y continúa la configuración.",
    employee_role_not_found: "No se pudo preparar el acceso inicial. Inténtalo nuevamente."
  };

  const key = Object.keys(map).find((item) => raw.includes(item));
  if (key) return map[key];

  if (/Cannot access ['"]?p['"]? before initialization/i.test(raw)) {
    return "Se detectó un error interno al finalizar la configuración. Recarga PALMYRA y vuelve a intentarlo.";
  }

  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(raw)) {
    return "No se pudo conectar con PALMYRA. Comprueba la conexión y vuelve a intentarlo.";
  }

  return raw || `No se pudo completar la configuración (${stage}). Inténtalo nuevamente.`;
}

function Field({
  label,
  icon: Icon,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus = false
}: {
  label: string;
  icon: typeof Building2;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="block min-w-0">
      <span className="form-label">{label}</span>
      <div className="relative">
        <Icon className="field-icon" aria-hidden="true" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          className="field-input pr-3 font-bold"
        />
      </div>
    </label>
  );
}

export default function SaaSOnboarding() {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [warehouseName, setWarehouseName] = useState("Almacén principal");
  const [planCode, setPlanCode] = useState<PlanCode>(() => {
    const stored =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem("palmyra_signup_plan")
        : null;
    return stored === "growth" || stored === "pro" || stored === "starter"
      ? stored
      : "starter";
  });
  const [paymentMethod, setPaymentMethod] =
    useState<"manual_cash" | "manual_bank_transfer">("manual_cash");
  const [busy, setBusy] = useState(false);
  const [creationStage, setCreationStage] = useState(0);
  const [error, setError] = useState("");
  const [socialLinks, setSocialLinks] = useState<PlatformSocialLinks>({ facebook_url: DEFAULT_FACEBOOK_URL, whatsapp_channel_url: null });
  const [socialLoading, setSocialLoading] = useState(false);
  const [facebookOpened, setFacebookOpened] = useState(false);
  const [whatsappOpened, setWhatsappOpened] = useState(false);
  const [socialVerified, setSocialVerified] = useState(false);
  const [socialVerifyingUntil, setSocialVerifyingUntil] = useState<number | null>(null);
  const [socialRemaining, setSocialRemaining] = useState(0);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);

  useEffect(() => {
    let active = true;
    const loadDraft = async () => {
      let userId = "anonymous";
      try {
        const supabase = getSupabase();
        if (supabase) {
          const { data } = await supabase.auth.getUser();
          userId = data.user?.id || "anonymous";
        }
      } catch {}

      const key = ONBOARDING_DRAFT_PREFIX + userId;
      let draft: Partial<OnboardingDraft> | null = null;
      try {
        const raw = localStorage.getItem(key);
        draft = raw ? JSON.parse(raw) : null;
      } catch {}

      if (!active) return;
      setStorageKey(key);

      if (draft) {
        if (typeof draft.companyName === "string") setCompanyName(draft.companyName);
        if (typeof draft.warehouseName === "string") setWarehouseName(draft.warehouseName);
        if (draft.planCode === "starter" || draft.planCode === "growth" || draft.planCode === "pro") {
          setPlanCode(draft.planCode);
        }
        if (draft.paymentMethod === "manual_cash" || draft.paymentMethod === "manual_bank_transfer") {
          setPaymentMethod(draft.paymentMethod);
        }
        setFacebookOpened(Boolean(draft.facebookOpened));
        setWhatsappOpened(Boolean(draft.whatsappOpened));

        const until = typeof draft.socialVerifyingUntil === "number" ? draft.socialVerifyingUntil : null;
        const stillVerifying = Boolean(until && until > Date.now());
        setSocialVerifyingUntil(stillVerifying ? until : null);
        setSocialRemaining(stillVerifying ? Math.max(1, Math.ceil((until! - Date.now()) / 1000)) : 0);
        setSocialVerified(Boolean(draft.socialVerified) || Boolean(until && until <= Date.now()));
      }

      setDraftReady(true);
    };

    void loadDraft();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!draftReady || !storageKey) return;
    const draft: OnboardingDraft = {
      companyName,
      warehouseName,
      planCode,
      paymentMethod,
      facebookOpened,
      whatsappOpened,
      socialVerified,
      socialVerifyingUntil
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {}
  }, [
    draftReady,
    storageKey,
    companyName,
    warehouseName,
    planCode,
    paymentMethod,
    facebookOpened,
    whatsappOpened,
    socialVerified,
    socialVerifyingUntil
  ]);

  useEffect(() => {
    if (planCode !== "starter") {
      setSocialLoading(false);
      setSocialVerifyingUntil(null);
      setSocialRemaining(0);
      return;
    }
    let active = true;
    setSocialLoading(true);
    void loadPublicSocialLinks()
      .then((links) => {
        if (!active) return;
        setSocialLinks(links);
      })
      .catch((socialError) => {
        console.warn("[PALMYRA] No se pudieron cargar los canales sociales en onboarding:", socialError);
        if (active) {
          setSocialLinks({ facebook_url: DEFAULT_FACEBOOK_URL, whatsapp_channel_url: null });
        }
      })
      .finally(() => {
        if (active) setSocialLoading(false);
      });
    return () => { active = false; };
  }, [planCode]);

  useEffect(() => {
    if (!socialVerifyingUntil) return;

    const tick = () => {
      const remainingMs = Math.max(0, socialVerifyingUntil - Date.now());
      setSocialRemaining(Math.max(0, Math.ceil(remainingMs / 1000)));
      if (remainingMs <= 0) {
        setSocialVerifyingUntil(null);
        setSocialRemaining(0);
        setSocialVerified(true);
      }
    };

    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [socialVerifyingUntil]);

  const verifyStarterPromotion = () => {
    setError("");
    if (!socialLinks.facebook_url || !socialLinks.whatsapp_channel_url) {
      setSocialVerified(false);
      setError("La promoción de 90 días no puede verificarse todavía porque faltan los dos canales oficiales de PALMYRA.");
      return;
    }
    if (!facebookOpened || !whatsappOpened) {
      setSocialVerified(false);
      setError("Haz estas dos cosas primero: sigue Facebook y únete al canal de WhatsApp. Luego vuelve aquí y pulsa Verificar.");
      return;
    }

    const until = Date.now() + 5000;
    setSocialVerified(false);
    setSocialVerifyingUntil(until);
    setSocialRemaining(5);
  };

  const selectedPlan = useMemo(
    () =>
      PALMYRA_PLANS.find((plan) => plan.code === planCode) ||
      PALMYRA_PLANS[0],
    [planCode]
  );
  const SelectedPlanIcon = planIcons[selectedPlan.code];

  const createWorkspace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const normalizedCompanyName = companyName.trim();
    const normalizedWarehouseName = warehouseName.trim();

    if (normalizedCompanyName.length < 2) {
      setError("Escribe el nombre de tu empresa.");
      return;
    }

    if (normalizedWarehouseName.length < 2) {
      setError("Escribe el nombre del almacén principal.");
      return;
    }

    if (planCode === "starter" && !socialVerified) {
      setError("Verifica primero la promoción de 90 días gratis antes de crear la empresa.");
      return;
    }

    setBusy(true);
    setCreationStage(1);
    const startedAt = Date.now();
    let stage = "validación";
    const stageTimer = window.setInterval(() => setCreationStage((current) => current < 4 ? current + 1 : current), 900);
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    try {
      stage = "creación de la empresa";

      const result = await createCompanyOnboarding({
        name: normalizedCompanyName,
        warehouseName: normalizedWarehouseName,
        planCode,
        paymentMethod
      });

      if (!result?.company_id || !result?.warehouse_id) {
        throw new Error("La empresa no devolvió los identificadores esperados.");
      }

      setCreationStage(5);
      stage = "registro del dispositivo";
      try {
        await registerCurrentDevice(result.company_id, result.warehouse_id);
      } catch (deviceError) {
        // El dispositivo se puede registrar de nuevo durante la hidratación de App.
        // No bloqueamos la entrada al CRM por una carrera transitoria del registro.
        console.warn("[PALMYRA] No se pudo registrar el dispositivo inicial:", deviceError);
      }

      // El RPC devolvió los identificadores: la creación ya está confirmada.
      // Mostramos explícitamente la confirmación antes de abandonar onboarding.
      window.clearInterval(stageTimer);
      setCreationStage(5);
      await wait(900);
      setCreationStage(6);
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(1200, 5500 - elapsed);
      await wait(remaining);

      stage = "finalización";
      if (storageKey) {
        try { localStorage.removeItem(storageKey); } catch {}
      }
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem("palmyra_signup_plan");
        sessionStorage.removeItem("palmyra_pending_onboarding");
        sessionStorage.setItem("palmyra_onboarding_completed", "1");
      }

      if (result?.account_status === "pending_payment") {
        let ownerName = "";
        let ownerEmail = "";
        try {
          const supabase = getSupabase();
          if (supabase) {
            const { data: authData } = await supabase.auth.getUser();
            ownerEmail = authData.user?.email || "";
            ownerName =
              authData.user?.user_metadata?.full_name ||
              authData.user?.user_metadata?.name ||
              "";
          }
        } catch (authError) {
          console.warn("[PALMYRA] No se pudo leer el nombre/correo del propietario para WhatsApp:", authError);
        }

        goToWhatsAppPayment({
          ownerName,
          ownerEmail,
          companyName: normalizedCompanyName,
          warehouseName: normalizedWarehouseName,
          planName: selectedPlan.name,
          planCode: selectedPlan.code,
          amount: Number(selectedPlan.price) || undefined,
          currency: selectedPlan.priceCurrency,
          paymentMethod,
          requestId: result?.request_id || undefined
        });
        return;
      }

      // Starter/Oasis = 90 días gratis y cuenta activa: entra directamente al CRM.
      window.location.replace("/");
    } catch (caughtError) {
      console.error("[PALMYRA] Error de onboarding:", {
        stage,
        error: caughtError
      });
      window.clearInterval(stageTimer);
      setError(getErrorMessage(caughtError, stage));
      setBusy(false);
      setCreationStage(0);
    }
  };

  return (
    <main className="relative h-[100dvh] min-h-[100dvh] overflow-y-auto bg-[#F7F5FC]" data-keyboard-viewport="native">
      {busy && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#24133d]/45 px-4 backdrop-blur-sm" aria-live="polite" aria-busy="true">
          <div className="w-full max-w-sm rounded-3xl border border-violet-100 bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#F0E9FF]"><img src="/palmyra-mark-exact.svg" alt="" aria-hidden="true" className="h-10 w-10 object-contain" /></div>
            <h2 className="mt-4 text-base font-black text-[#3B1B6E]">Configurando tu espacio</h2>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">No cierres esta ventana. PALMYRA está creando y verificando todo automáticamente.</p>
            <div className="mt-5 space-y-2 text-left">
              {["Registrando nombre de empresa","Creando almacén principal","Configurando plan y suscripción","Preparando acceso, usuario y permisos","Confirmando la creación","Espacio creado correctamente"].map((label, index) => {
                const active = creationStage === index + 1; const done = creationStage > index + 1;
                return <div key={label} className={"flex items-center gap-2.5 rounded-xl px-3 py-2 text-[10px] font-bold " + (active ? "bg-[#F5F0FF] text-[#6535C5]" : done ? "text-emerald-600" : "text-slate-300")}><span className={"flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[8px] font-black " + (active ? "bg-[#6535C5] text-white" : done ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-300")}>{done ? <Check className="h-3 w-3" /> : index + 1}</span><span>{label}</span>{active && <span className="ml-auto h-3 w-3 animate-spin rounded-full border-2 border-[#DCCEFF] border-t-[#6535C5]" />}</div>;
              })}
            </div>
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-6xl px-3 py-3 sm:px-5 sm:py-5">
        <header className="mb-3 flex items-center justify-between gap-3 px-1 sm:mb-4">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="shrink-0"
            aria-label="PALMYRA"
          >
            <img
              src="/palmyra-logo-exact.svg"
              alt="PALMYRA"
              className="block h-auto w-[170px] max-w-[46vw] object-contain"
            />
          </button>

          <span className="rounded-full border border-violet-100 bg-white px-3 py-1.5 text-[8px] font-black uppercase tracking-[.15em] text-[#7C4DDE] shadow-sm">
            Configuración inicial
          </span>
        </header>

        <div className="overflow-hidden rounded-[24px] border border-violet-100 bg-white shadow-[0_24px_70px_-46px_rgba(59,27,110,.5)]">
          <div className="grid min-w-0 lg:grid-cols-[.82fr_1.18fr]">
            <section className="relative min-w-0 overflow-hidden bg-[#3B1B6E] p-4 text-white sm:p-6 lg:p-8">
              <div className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[#8B63E6]/30 blur-3xl" />
              <div className="relative z-10">
                <div className="mb-4 flex items-center justify-between gap-3 lg:mb-7">
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-2.5 py-1.5 text-[8px] font-black uppercase tracking-wider">
                    <Building2 className="h-3.5 w-3.5" />
                    Tu empresa
                  </span>

                  <span className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1.5 text-[8px] font-black uppercase tracking-wider text-violet-100">
                    Paso 1 de 1
                  </span>
                </div>

                <h1 className="max-w-xl text-2xl font-black leading-tight tracking-[-.04em] sm:text-3xl lg:text-4xl">
                  Configura tu espacio de trabajo.
                </h1>

                <p className="mt-3 max-w-xl text-[11px] leading-5 text-violet-100/80 sm:text-xs sm:leading-6">
                  Solo necesitamos tu empresa y su almacén principal. PALMYRA
                  prepara el espacio y aplica automáticamente los límites de tu
                  plan.
                </p>

                <div className="mt-5 rounded-2xl border border-white/10 bg-white/10 p-3.5 sm:mt-6 sm:p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10">
                      <SelectedPlanIcon className="h-4 w-4 text-violet-100" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[7px] font-black uppercase tracking-[.14em] text-violet-200">
                        Plan seleccionado
                      </p>
                      <p className="mt-0.5 truncate text-sm font-black">
                        {selectedPlan.name}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {[
                      ["Almacenes", selectedPlan.warehouses],
                      ["Empleados", selectedPlan.employees],
                      ["Productos", selectedPlan.products]
                    ].map(([label, value]) => (
                      <div
                        key={String(label)}
                        className="rounded-xl bg-black/10 px-2 py-2 text-center"
                      >
                        <p className="text-[7px] text-violet-200">
                          {label}
                        </p>
                        <p className="mt-0.5 text-sm font-black">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-4 grid gap-2 text-[9px] text-violet-100/80 sm:mt-5">
                  <span className="inline-flex items-center gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-violet-200" />
                    Datos aislados por empresa
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <Warehouse className="h-3.5 w-3.5 shrink-0 text-violet-200" />
                    Almacenes controlados por plan
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <Users className="h-3.5 w-3.5 shrink-0 text-violet-200" />
                    Trabajadores con acceso propio
                  </span>
                </div>
              </div>
            </section>

            <section className="min-w-0 p-4 sm:p-6 lg:p-8">
              <form onSubmit={createWorkspace} className="min-w-0">
                <div>
                  <p className="text-[8px] font-black uppercase tracking-[.18em] text-[#7C4DDE]">
                    Datos principales
                  </p>
                  <h2 className="mt-1 text-lg font-black tracking-tight text-[#2A1938] sm:text-xl">
                    Crea tu empresa
                  </h2>
                  <p className="mt-1 text-[10px] leading-4 text-slate-400 sm:text-[11px]">
                    Los datos de Cuba se aplican automáticamente para empezar
                    más rápido.
                  </p>
                </div>

                <div className="mt-5 grid min-w-0 gap-3 sm:grid-cols-2">
                  <Field
                    label="Nombre de la empresa"
                    icon={Building2}
                    value={companyName}
                    onChange={setCompanyName}
                    placeholder="Ej. Farmacia Central"
                    disabled={busy}
                    autoFocus
                  />
                  <Field
                    label="Almacén principal"
                    icon={Warehouse}
                    value={warehouseName}
                    onChange={setWarehouseName}
                    placeholder="Almacén principal"
                    disabled={busy}
                  />
                </div>

                <div className="mt-4 flex items-center gap-2 rounded-xl border border-violet-100 bg-[#F8F6FC] px-3 py-2.5">
                  <LockKeyhole className="h-4 w-4 shrink-0 text-[#6535C5]" aria-hidden="true" />
                  <p className="text-[8px] leading-4 text-slate-500">
                    <b className="text-[#3B1B6E]">POS:</b> usa la misma contraseña de tu cuenta PALMYRA para entrar como Administrador.
                  </p>
                </div>

                <div className="mt-6 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-black text-[#2A1938]">
                        Elige tu plan
                      </p>
                      <p className="mt-0.5 text-[9px] text-slate-400">
                        Puedes cambiarlo después como propietario.
                      </p>
                    </div>
                    <span className="hidden shrink-0 items-center gap-1.5 rounded-lg bg-[#F7F3FF] px-2 py-1.5 text-[8px] font-black text-[#6535C5] sm:inline-flex">
                      <CreditCard className="h-3.5 w-3.5" />
                      Cuba
                    </span>
                  </div>

                  <div className="mt-3 grid min-w-0 gap-2.5 sm:grid-cols-3">
                    {PALMYRA_PLANS.map((plan) => {
                      const PIcon = planIcons[plan.code];
                      const selected = plan.code === planCode;

                      return (
                        <button
                          type="button"
                          key={plan.code}
                          onClick={() => {
                            setPlanCode(plan.code);
                            if (plan.code !== "starter") setSocialVerifyingUntil(null);
                          }}
                          disabled={busy}
                          aria-pressed={selected}
                          className={
                            "relative min-w-0 rounded-2xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
                            (selected
                              ? "border-[#7C4DDE] bg-[#F0E9FF]"
                              : "border-violet-100 bg-white hover:border-violet-200")
                          }
                        >
                          {selected && (
                            <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#6535C5] text-white">
                              <Check className="h-3 w-3" />
                            </span>
                          )}

                          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-violet-100 bg-white text-[#6535C5]">
                            <PIcon className="h-4 w-4" />
                          </div>

                          <div className="mt-2 flex items-end justify-between gap-2">
                            <span className="truncate text-sm font-black text-[#3B1B6E]">
                              {plan.name}
                            </span>
                            <span className="shrink-0 text-xs font-black text-[#4B1FA7]">
                              {plan.price}
                              <span className="text-[8px] font-semibold text-slate-400">
                                /mes
                              </span>
                            </span>
                          </div>

                          <div className="mt-2 grid gap-1 text-[8px] text-slate-500">
                            <span>
                              {plan.warehouses} almacén
                              {plan.warehouses === 1 ? "" : "es"}
                            </span>
                            <span>{plan.employees} empleados</span>
                            <span>{plan.products} productos</span>
                          </div>

                          <p
                            className={
                              "mt-3 text-[8px] font-black " +
                              (plan.code === "starter"
                                ? "text-emerald-600"
                                : "text-slate-400")
                            }
                          >
                            {plan.code === "starter"
                              ? "Verificar primero · 90 días gratis"
                              : "Activación manual"}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {selectedPlan.code === "starter" && (
                  <div className="mt-4 rounded-2xl border border-violet-100 bg-[#F8F6FC] p-3.5 sm:p-4">
                    <div className="flex items-start gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#EEE7FF] text-[#6535C5]">
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[8px] font-black uppercase tracking-[.16em] text-[#7C4DDE]">Promoción Oasis</p>
                            <p className="mt-1 text-[10px] font-black text-[#2A1938]">Verificar primero · 90 días gratis</p>
                            <p className="mt-1 text-[8px] leading-4 text-slate-500">Para recibir los 90 días gratis: <b>1)</b> sigue Facebook, <b>2)</b> únete al canal de WhatsApp y <b>3)</b> vuelve aquí para verificar. PALMYRA confía en tu confirmación y nunca recibe tus credenciales sociales.</p>
                          </div>
                          <span className={"shrink-0 rounded-full px-2 py-1 text-[7px] font-black uppercase tracking-wider " + (socialVerified ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>
                            {socialVerified ? "Verificado" : "Pendiente"}
                          </span>
                        </div>

                        {socialLoading ? (
                          <div className="mt-3 rounded-xl border border-violet-100 bg-white px-3 py-2.5 text-[8px] font-bold text-slate-400">Cargando canales oficiales…</div>
                        ) : (
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {socialLinks.facebook_url && (
                              <a
                                href={socialLinks.facebook_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => { setFacebookOpened(true); }}
                                className={"rounded-xl border p-2.5 transition " + (facebookOpened ? "border-emerald-200 bg-emerald-50" : "border-violet-100 bg-white hover:border-violet-200")}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[9px] font-black text-[#3B1B6E]">Facebook oficial</span>
                                  <span className="text-[8px] font-black text-[#6535C5]">{facebookOpened ? "✓ Listo" : "Abrir"}</span>
                                </div>
                              </a>
                            )}
                            {socialLinks.whatsapp_channel_url && (
                              <a
                                href={socialLinks.whatsapp_channel_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => { setWhatsappOpened(true); }}
                                className={"rounded-xl border p-2.5 transition " + (whatsappOpened ? "border-emerald-200 bg-emerald-50" : "border-violet-100 bg-white hover:border-violet-200")}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[9px] font-black text-[#3B1B6E]">Canal de WhatsApp</span>
                                  <span className="text-[8px] font-black text-[#6535C5]">{whatsappOpened ? "✓ Listo" : "Abrir"}</span>
                                </div>
                              </a>
                            )}
                          </div>
                        )}

                        {(!socialLinks.facebook_url || !socialLinks.whatsapp_channel_url) && !socialLoading && (
                          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[8px] font-bold leading-4 text-amber-800">
                            Falta configurar uno de los canales oficiales. La promoción no se podrá verificar todavía.
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={verifyStarterPromotion}
                          disabled={socialLoading || socialVerified || Boolean(socialVerifyingUntil) || !facebookOpened || !whatsappOpened || !socialLinks.facebook_url || !socialLinks.whatsapp_channel_url}
                          className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-[#6535C5] px-3 text-[9px] font-black text-white transition-colors hover:bg-[#4F249D] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          {socialVerified ? <Check className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                          {socialVerified
                            ? "Promoción verificada"
                            : socialVerifyingUntil
                              ? `Verificando… ${socialRemaining}s`
                              : "Verificar promoción (5 s)"}
                        </button>

                        {!socialVerified && (
                          <p className="mt-2 text-center text-[7px] font-bold text-slate-400">
                            {socialVerifyingUntil ? `PALMYRA está verificando tu promoción. No cierres esta página; faltan ${socialRemaining} s.` : socialVerified ? "Los dos pasos están listos. Puedes crear tu empresa." : "Completa los dos pasos y después pulsa Verificar promoción (5 s)."}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {selectedPlan.code !== "starter" && (
                  <div className="mt-4">
                    <p className="form-label">Método de pago</p>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setPaymentMethod("manual_cash")}
                        disabled={busy}
                        aria-pressed={paymentMethod === "manual_cash"}
                        className={
                          "min-w-0 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 " +
                          (paymentMethod === "manual_cash"
                            ? "border-[#7C4DDE] bg-[#F0E9FF]"
                            : "border-violet-100 bg-white")
                        }
                      >
                        <WalletCards className="h-4 w-4 text-[#6535C5]" />
                        <p className="mt-2 text-[10px] font-black text-[#3B1B6E]">
                          Efectivo
                        </p>
                        <p className="mt-0.5 text-[8px] leading-4 text-slate-400">
                          Pago manual en Cuba
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setPaymentMethod("manual_bank_transfer")
                        }
                        disabled={busy}
                        aria-pressed={
                          paymentMethod === "manual_bank_transfer"
                        }
                        className={
                          "min-w-0 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 " +
                          (paymentMethod === "manual_bank_transfer"
                            ? "border-[#7C4DDE] bg-[#F0E9FF]"
                            : "border-violet-100 bg-white")
                        }
                      >
                        <Landmark className="h-4 w-4 text-[#6535C5]" />
                        <p className="mt-2 text-[10px] font-black text-[#3B1B6E]">
                          Transferencia bancaria
                        </p>
                        <p className="mt-0.5 text-[8px] leading-4 text-slate-400">
                          Confirmación manual en Cuba
                        </p>
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-4 flex items-start gap-2 rounded-xl border border-violet-100 bg-[#F8F6FC] px-3 py-2.5 text-[9px] leading-4 text-slate-500">
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-[#6535C5]" />
                  <span>
                    {selectedPlan.code === "starter"
                      ? "Oasis incluye 90 días gratis. No se solicita pago durante la prueba."
                      : paymentMethod === "manual_bank_transfer"
                        ? "La transferencia queda pendiente hasta que se confirme el pago."
                        : "El pago en efectivo queda pendiente hasta su confirmación."}
                  </span>
                </div>

                {error && (
                  <div
                    role="alert"
                    className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] font-bold leading-4 text-rose-700"
                  >
                    {error}
                  </div>
                )}

                <div className="sticky bottom-0 z-20 mt-4 border-t border-violet-100 bg-white/95 pt-3 sm:static sm:border-0 sm:bg-transparent sm:pt-0">
                  <button
                    type="submit"
                    disabled={busy || (selectedPlan.code === "starter" && !socialVerified)}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#6535C5] px-4 text-xs font-black text-white shadow-sm transition-colors hover:bg-[#4F249D] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy
                      ? "Creando empresa..."
                      : selectedPlan.code === "starter"
                        ? (socialVerified ? "Crear empresa y comenzar" : "Verificar promoción primero")
                        : "Crear empresa y solicitar activación"}
                    {!busy && <ArrowRight className="h-4 w-4" />}
                  </button>
                </div>
              </form>

              <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[8px] text-slate-400">
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  Datos aislados
                </span>
                <span className="inline-flex items-center gap-1">
                  <Warehouse className="h-3 w-3" />
                  Primer almacén automático
                </span>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
