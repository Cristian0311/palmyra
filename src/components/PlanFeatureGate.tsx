import React, { useEffect, useState } from 'react';
import { LockKeyhole, ArrowUpCircle, Loader2, Sparkles, Check, ShieldCheck, ArrowRight, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { loadSaaSContext } from '../services/saas';
import { canUsePlanFeature, getPlanDisplayName, getRequiredPlanCode, type PlanFeature } from '../services/planAccess';

const REQUIRED_NAMES: Record<string,string> = { growth: 'Caravana', pro: 'Ciudadela' };

export default function PlanFeatureGate({
  feature,
  title,
  description,
  children,
}: {
  feature: PlanFeature;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<{loading:boolean; allowed:boolean; plan:string; required:string}>({
    loading:true, allowed:false, plan:'', required:getRequiredPlanCode(feature)
  });

  useEffect(() => {
    let active = true;
    void loadSaaSContext().then(ctx => {
      if (!active) return;
      const plan = ctx?.subscription?.planCode || '';
      setState({loading:false, allowed:canUsePlanFeature(plan, feature), plan, required:getRequiredPlanCode(feature)});
    }).catch(() => {
      if (active) setState(s => ({...s, loading:false}));
    });
    return () => { active = false; };
  }, [feature]);

  if (state.loading) {
    return <div className="min-h-[45vh] flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-violet-600" /></div>;
  }

  if (state.allowed) return <>{children}</>;

  const requiredName = REQUIRED_NAMES[state.required] || state.required;
  const currentName = getPlanDisplayName(state.plan);

  if (dismissed) {
    return (
      <div className="min-h-[24vh] flex items-center justify-center p-4">
        <div className="w-full max-w-xl rounded-2xl border border-base bg-secondary p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <LockKeyhole className="w-4 h-4 text-violet-600 shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] font-black text-primary uppercase truncate">{title}</p>
              <p className="text-[9px] font-bold text-muted">Disponible desde {requiredName}.</p>
            </div>
          </div>
          <button type="button" onClick={() => setDismissed(false)} className="shrink-0 px-3 py-2 rounded-xl bg-violet-600 text-white text-[9px] font-black uppercase">
            Ver información
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4 sm:p-6">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-[30px] border border-violet-100/80 bg-white shadow-[0_24px_70px_-28px_rgba(91,33,182,0.35)]">
        <div className="absolute -right-20 -top-24 h-56 w-56 rounded-full bg-violet-200/45 blur-3xl" />
        <div className="absolute -left-20 bottom-0 h-48 w-48 rounded-full bg-indigo-100/55 blur-3xl" />

        <div className="relative p-5 sm:p-7">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="absolute right-4 top-4 h-8 w-8 rounded-xl border border-slate-200 bg-white text-slate-400 hover:text-slate-700 hover:bg-slate-50 flex items-center justify-center"
            aria-label="Cerrar aviso"
            title="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-600/25">
                <LockKeyhole className="h-6 w-6" />
                <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-white text-violet-600 shadow-sm">
                  <Sparkles className="h-3 w-3" />
                </span>
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[8px] font-black uppercase tracking-[.14em] text-violet-700">
                    Función premium
                  </span>
                  <span className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[8px] font-black uppercase tracking-[.12em] text-slate-600">
                    <ShieldCheck className="h-3 w-3" /> PALMYRA
                  </span>
                </div>
                <h1 className="mt-2 text-xl sm:text-2xl font-black tracking-tight text-slate-950">{title}</h1>
              </div>
            </div>
          </div>

          <p className="mt-5 max-w-xl text-sm leading-6 text-slate-500">{description}</p>

          <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50/90 via-white to-indigo-50/70 p-4 text-left">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[8px] font-black uppercase tracking-[.14em] text-slate-500">Desbloquea con</p>
                  <p className="mt-1 text-base font-black text-slate-950">{requiredName}</p>
                </div>
                <span className="rounded-xl bg-white px-3 py-2 text-[9px] font-black text-violet-700 shadow-sm ring-1 ring-violet-100">
                  Plan superior
                </span>
              </div>
              <div className="mt-3 space-y-1.5">
                {[
                  'Acceso a esta función',
                  'Herramientas preparadas para crecer',
                  'Todo queda integrado con tu operación PALMYRA'
                ].map((line) => (
                  <div key={line} className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                      <Check className="h-2.5 w-2.5" />
                    </span>
                    {line}
                  </div>
                ))}
              </div>
            </div>

            <div className="min-w-[150px] rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-left">
              <p className="text-[8px] font-black uppercase tracking-[.14em] text-slate-500">Tu plan actual</p>
              <p className="mt-1 text-sm font-black text-slate-900">{currentName}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-violet-500 to-indigo-500" />
              </div>
              <p className="mt-2 text-[9px] font-bold leading-4 text-slate-500">
                Esta sección permanece visible para que sepas qué puedes desbloquear.
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[9px] font-bold leading-4 text-slate-400">
              No es un error: esta función forma parte de un plan superior.
            </p>
            <button
              type="button"
              onClick={() => navigate('/subscription')}
              className="group inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 text-[10px] font-black uppercase tracking-[.08em] text-white shadow-lg shadow-violet-600/20 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-violet-600/25 active:translate-y-0"
            >
              <ArrowUpCircle className="h-4 w-4" />
              Ver planes y actualizar
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
