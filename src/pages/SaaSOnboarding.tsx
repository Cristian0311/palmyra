import React, { useState } from "react";
import { Building2, Check, ChevronRight, Package, Sparkles, Warehouse } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PALMYRA_PLANS, type PlanCode } from "../config/saas";
import { createCompanyOnboarding, loadSaaSContext } from "../services/saas";
import { useStore } from "../store/useStore";

export default function SaaSOnboarding() {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [warehouseName, setWarehouseName] = useState("Almacén principal");
  const [planCode, setPlanCode] = useState<PlanCode>("starter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedPlan = PALMYRA_PLANS.find(plan => plan.code === planCode) || PALMYRA_PLANS[0];

  const createWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (companyName.trim().length < 2) {
      setError("Escribe el nombre de tu empresa.");
      return;
    }
    if (warehouseName.trim().length < 2) {
      setError("Escribe el nombre del almacén principal.");
      return;
    }

    setBusy(true);
    try {
      await createCompanyOnboarding({
        name: companyName,
        warehouseName,
        planCode,
      });

      const ctx = await loadSaaSContext();
      if (!ctx?.companyId) {
        throw new Error("La empresa se creó, pero todavía no se pudo cargar el contexto.");
      }

      useStore.setState({
        currentUser: ctx.user,
        currentBranchId: ctx.warehouseIds[0] || "",
        branches: useStore.getState().branches
      });

      if (ctx.company?.account_status === "pending_payment") {
        navigate("/account-status", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    } catch (err: any) {
      setError(err?.message || "No se pudo crear la empresa.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 flex items-center justify-center">
      <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-[2rem] shadow-xl overflow-hidden">
        <div className="p-6 sm:p-8 border-b border-slate-200">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-rose-500">Paso 1 de 1</p>
          <h1 className="text-3xl font-black text-slate-950 mt-2">Configura tu empresa</h1>
          <p className="text-sm text-slate-500 mt-2">Creamos tu empresa, el primer almacén y la suscripción dentro de PALMYRA. En Cuba, los planes se pagan actualmente en efectivo.</p>
        </div>

        <div className="p-6 sm:p-8 grid lg:grid-cols-[1fr_1.05fr] gap-8">
          <form onSubmit={createWorkspace} className="space-y-5">
            <label className="block">
              <span className="block text-xs font-bold text-slate-600 mb-2">Nombre de la empresa</span>
              <div className="relative">
                <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input value={companyName} onChange={e => setCompanyName(e.target.value)} disabled={busy}
                  className="w-full h-12 pl-10 pr-4 rounded-xl border border-slate-200 bg-slate-50 outline-none focus:bg-white focus:border-rose-400"
                  placeholder="Mi empresa" />
              </div>
            </label>

            <label className="block">
              <span className="block text-xs font-bold text-slate-600 mb-2">Almacén principal</span>
              <div className="relative">
                <Warehouse className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input value={warehouseName} onChange={e => setWarehouseName(e.target.value)} disabled={busy}
                  className="w-full h-12 pl-10 pr-4 rounded-xl border border-slate-200 bg-slate-50 outline-none focus:bg-white focus:border-rose-400"
                  placeholder="Almacén principal" />
              </div>
            </label>

            <button disabled={busy} className="w-full h-12 rounded-xl bg-slate-950 text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50">
              {busy ? "Creando empresa..." : selectedPlan.code === "starter" ? "Crear empresa y comenzar" : "Crear empresa y solicitar plan"}
              {!busy && <ChevronRight className="w-4 h-4" />}
            </button>

            {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}
          </form>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-rose-500" />
              <h2 className="text-sm font-black text-slate-900">Elige tu plan</h2>
            </div>

            <div className="space-y-3">
              {PALMYRA_PLANS.map(plan => {
                const selected = plan.code === planCode;
                return (
                  <button type="button" key={plan.code} onClick={() => setPlanCode(plan.code)}
                    className={`w-full text-left rounded-2xl border p-4 transition ${selected ? "border-rose-400 bg-rose-50/60" : "border-slate-200 bg-white hover:border-slate-300"}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-black text-slate-950">{plan.name}</span>
                          {plan.code === "starter" && <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">90 días gratis</span>}
                        </div>
                        <p className="text-xs text-slate-500 mt-1">{plan.description}</p>
                      </div>
                      <span className="font-black text-slate-950 whitespace-nowrap">US${plan.price}/mes</span>
                    </div>
                    <div className="grid sm:grid-cols-3 gap-2 mt-3 text-[11px] font-bold text-slate-600">
                      <span className="inline-flex items-center gap-1.5"><Package className="w-3.5 h-3.5" />{plan.products} productos</span>
                      <span>{plan.warehouses} almacén{plan.warehouses === 1 ? "" : "es"}</span>
                      <span>{plan.employees} empleados</span>
                    </div>
                    {selected && (
                      <div className="mt-3 flex items-center gap-2 text-[11px] font-black text-rose-700">
                        <Check className="w-3.5 h-3.5" />
                        Plan seleccionado
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
