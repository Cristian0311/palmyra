import React, { useMemo, useState } from "react";
import { ArrowRight, Building2, Check, CreditCard, MapPin, Package, ShieldCheck, Sparkles, Users, Warehouse, WalletCards } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PALMYRA_PLANS, type PlanCode } from "../config/saas";
import { createCompanyOnboarding, loadSaaSContext } from "../services/saas";
import { useStore } from "../store/useStore";

const planIcons: Record<PlanCode, typeof Sparkles> = {
  starter: Sparkles,
  growth: Building2,
  pro: ShieldCheck
};

function getErrorMessage(error: any) {
  const raw = String(error?.message || error?.error_description || "");
  const map: Record<string,string> = {
    plan_warehouses_limit: "El primer almacén se crea automáticamente durante la configuración. Vuelve a intentarlo.",
    plan_warehouse_limit: "El primer almacén está incluido en tu plan.",
    plan_warehouse_limit_reached: "Has alcanzado el límite de almacenes de este plan.",
    company_already_exists: "Esta cuenta ya tiene una empresa. No puedes crear una segunda empresa.",
    company_slug_taken: "Ese nombre de empresa ya está siendo utilizado. Prueba con otro nombre.",
    invalid_company_name: "Escribe un nombre de empresa válido.",
    invalid_warehouse_name: "Escribe un nombre de almacén válido.",
    plan_not_available: "El plan seleccionado no está disponible en este momento."
  };
  const key = Object.keys(map).find(k => raw.includes(k));
  return key ? map[key] : raw || "No se pudo crear la empresa. Revisa los datos e inténtalo nuevamente.";
}

export default function SaaSOnboarding() {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [warehouseName, setWarehouseName] = useState("Almacén principal");
  const [planCode, setPlanCode] = useState<PlanCode>(() => {
    const stored = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("palmyra_signup_plan") : null;
    return stored === "growth" || stored === "pro" || stored === "starter" ? stored : "starter";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedPlan = useMemo(() => PALMYRA_PLANS.find(p => p.code === planCode) || PALMYRA_PLANS[0], [planCode]);
  const Icon = planIcons[selectedPlan.code];

  const createWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (companyName.trim().length < 2) return setError("Escribe el nombre de tu empresa.");
    if (warehouseName.trim().length < 2) return setError("Escribe el nombre del almacén principal.");

    setBusy(true);
    try {
      await createCompanyOnboarding({ name: companyName, warehouseName, planCode });
      sessionStorage.removeItem("palmyra_signup_plan");
      const ctx = await loadSaaSContext(true);
      if (!ctx?.companyId) throw new Error("La empresa se creó, pero no se pudo cargar el acceso.");
      useStore.setState({ currentUser: ctx.user, currentBranchId: ctx.warehouseIds[0] || "" });
      navigate(ctx.company?.account_status === "pending_payment" ? "/account-status" : "/", { replace: true });
    } catch (err: any) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#F7F5FC] flex items-center justify-center p-3 sm:p-5">
      <div className="w-full max-w-4xl">
        <div className="flex items-center justify-between mb-3 px-1">
          <button type="button" onClick={() => navigate("/")} className="flex items-center gap-2" aria-label="PALMYRA">
            <img src="/palmyra-logo.svg" alt="PALMYRA" className="w-[124px] h-8 object-contain object-left" />
          </button>
          <span className="text-[9px] font-black uppercase tracking-[.16em] text-[#8B63E6]">Configuración inicial</span>
        </div>

        <div className="grid lg:grid-cols-[.9fr_1.1fr] bg-white border border-violet-100 rounded-[26px] overflow-hidden shadow-[0_30px_80px_-48px_rgba(59,27,110,.5)]">
          <section className="relative p-5 sm:p-7 bg-[#3B1B6E] text-white overflow-hidden">
            <div className="absolute -top-24 -right-20 w-60 h-60 rounded-full bg-[#8B63E6]/35 blur-3xl" />
            <div className="relative z-10">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider">
                <Building2 className="w-3 h-3" /> Una cuenta = una empresa
              </span>
              <h1 className="text-3xl sm:text-4xl font-black tracking-[-.05em] leading-tight mt-6">Configura tu espacio de trabajo.</h1>
              <p className="text-xs sm:text-sm text-violet-100/75 mt-3 leading-6">Creamos tu empresa y el primer almacén. Después podrás agregar más almacenes y trabajadores según el plan elegido.</p>

              <div className="mt-7 rounded-2xl bg-white/8 border border-white/10 p-4">
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-violet-200" />
                  <div>
                    <p className="text-[8px] uppercase tracking-wider font-black text-violet-200">Plan seleccionado</p>
                    <p className="text-sm font-black mt-0.5">{selectedPlan.name}</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-4">
                  {[["Almacenes", selectedPlan.warehouses],["Empleados", selectedPlan.employees],["Productos", selectedPlan.products]].map(([label,value]) => (
                    <div key={label} className="rounded-xl bg-white/8 p-2.5 text-center">
                      <p className="text-[7px] text-violet-200">{label}</p>
                      <p className="text-sm font-black mt-0.5">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-2 mt-5 text-[9px] text-violet-100/80">
                <span className="inline-flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5 text-violet-200" /> Aislamiento de datos por empresa</span>
                <span className="inline-flex items-center gap-2"><Warehouse className="w-3.5 h-3.5 text-violet-200" /> Almacenes controlados por plan</span>
                <span className="inline-flex items-center gap-2"><Users className="w-3.5 h-3.5 text-violet-200" /> Trabajadores con acceso propio</span>
              </div>
            </div>
          </section>

          <section className="p-4 sm:p-6 md:p-7">
            <form onSubmit={createWorkspace}>
              <div>
                <p className="text-[9px] font-black uppercase tracking-[.18em] text-[#8B63E6]">Paso único</p>
                <h2 className="text-xl font-black text-[#2A1938] mt-1">Datos de tu empresa</h2>
              </div>

              <div className="grid sm:grid-cols-2 gap-3 mt-5">
                <label className="block">
                  <span className="block text-[9px] font-black uppercase tracking-wider text-slate-500 mb-1.5">Empresa</span>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B63E6]" />
                    <input value={companyName} onChange={e => setCompanyName(e.target.value)} disabled={busy} autoFocus className="w-full h-11 pl-10 pr-3 rounded-xl bg-[#F8F6FC] border border-violet-100 text-sm font-bold text-[#2A1938]" placeholder="Ej. Farmacia Central" />
                  </div>
                </label>

                <label className="block">
                  <span className="block text-[9px] font-black uppercase tracking-wider text-slate-500 mb-1.5">Primer almacén</span>
                  <div className="relative">
                    <Warehouse className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B63E6]" />
                    <input value={warehouseName} onChange={e => setWarehouseName(e.target.value)} disabled={busy} className="w-full h-11 pl-10 pr-3 rounded-xl bg-[#F8F6FC] border border-violet-100 text-sm font-bold text-[#2A1938]" placeholder="Almacén principal" />
                  </div>
                </label>
              </div>

              <div className="mt-6">
                <div className="flex items-end justify-between gap-3">
                  <div><p className="text-sm font-black text-[#2A1938]">Elige tu plan</p><p className="text-[9px] text-slate-400 mt-0.5">Puedes cambiarlo después como propietario.</p></div>
                  <span className="inline-flex items-center gap-1.5 text-[9px] font-black text-[#6535C5]"><WalletCards className="w-3.5 h-3.5" /> Cuba · efectivo</span>
                </div>

                <div className="grid sm:grid-cols-3 gap-2.5 mt-3">
                  {PALMYRA_PLANS.map(plan => {
                    const PIcon = planIcons[plan.code];
                    const selected = plan.code === planCode;
                    return (
                      <button type="button" key={plan.code} onClick={() => setPlanCode(plan.code)} className={"relative text-left rounded-2xl border p-3 transition-all " + (selected ? "border-[#7C4DDE] bg-[#EFE8FF] shadow-[0_12px_30px_-18px_rgba(101,53,197,.55)]" : "border-violet-100 bg-white hover:border-violet-200")}>
                        {selected && <span className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#6535C5] text-white flex items-center justify-center"><Check className="w-3 h-3"/></span>}
                        <div className="w-8 h-8 rounded-xl bg-white border border-violet-100 text-[#6535C5] flex items-center justify-center"><PIcon className="w-4 h-4"/></div>
                        <div className="mt-2 flex items-end justify-between gap-1"><span className="text-sm font-black text-[#3B1B6E]">{plan.name}</span><span className="text-xs font-black text-[#4B1FA7]">{plan.price}<span className="text-[8px] text-slate-400">/mes</span></span></div>
                        <div className="grid gap-1 mt-2 text-[8px] text-slate-500">
                          <span>{plan.warehouses} almacén{plan.warehouses===1?"":"es"}</span>
                          <span>{plan.employees} empleados</span>
                          <span>{plan.products} productos</span>
                        </div>
                        <p className={"text-[8px] font-black mt-3 " + (plan.code==="starter" ? "text-emerald-600" : "text-slate-400")}>{plan.code==="starter" ? "90 días gratis" : "Activación manual"}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2 rounded-xl bg-[#F8F6FC] border border-violet-100 px-3 py-2.5 text-[9px] text-slate-500">
                <CreditCard className="w-4 h-4 text-[#6535C5] shrink-0" />
                {selectedPlan.code === "starter" ? "Starter incluye 90 días gratis. No se solicita pago durante la prueba." : "En Cuba, la activación del plan se realiza mediante pago en efectivo. Los pagos internacionales quedan preparados para una etapa posterior."}
              </div>

              {error && <div className="mt-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[10px] font-bold p-3">{error}</div>}

              <button disabled={busy} className="w-full h-11 mt-4 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] text-white text-xs font-black flex items-center justify-center gap-2 disabled:opacity-50">
                {busy ? "Creando empresa..." : selectedPlan.code === "starter" ? "Crear empresa y comenzar" : "Crear empresa y solicitar activación"}
                {!busy && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>

            <div className="mt-4 flex items-center justify-center gap-4 text-[8px] text-slate-400">
              <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3"/> Datos aislados</span>
              <span className="inline-flex items-center gap-1"><Package className="w-3 h-3"/> Límites por plan</span>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
