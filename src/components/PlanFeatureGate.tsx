import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpCircle, Check, Loader2, LockKeyhole, Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { loadSaaSContext } from '../services/saas';
import { canUsePlanFeature, getPlanDisplayName, getRequiredPlanCode, type PlanFeature } from '../services/planAccess';
import { getPlan } from '../config/saas';
import { PalmyraWordmark } from './PalmyraWordmark';

const DEFAULT_HIGHLIGHTS = [
  'Sección incluida en este plan',
  'Datos integrados con el resto de tu operación',
  'Funciona también cuando el equipo trabaja offline'
];

function planLimitLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default function PlanFeatureGate({
  feature,
  title,
  description,
  highlights,
  children,
}: {
  feature: PlanFeature;
  title: string;
  description: string;
  highlights?: string[];
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

  const requiredPlan = getPlan(state.required);
  const requiredName = requiredPlan.name;
  const currentName = getPlanDisplayName(state.plan);
  const benefits = (highlights && highlights.length ? highlights : DEFAULT_HIGHLIGHTS)
    .filter((line): line is string => Boolean(line && line.trim()))
    .slice(0, 3);
  const limits = [
    planLimitLabel(requiredPlan.warehouses, 'almacén', 'almacenes'),
    planLimitLabel(requiredPlan.employees, 'empleado', 'empleados'),
    `${requiredPlan.products} tipos de producto`
  ].join(' · ');
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  if (dismissed) {
    return (
      <div className="flex min-h-[24vh] items-center justify-center p-3 sm:p-4">
        <div className="flex w-full max-w-xl flex-col gap-3 rounded-2xl border border-base bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <LockKeyhole className="w-4 h-4 text-violet-600 dark:text-violet-300 shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] font-black text-primary uppercase truncate">{title}</p>
              <p className="text-[9px] font-bold text-muted">Disponible desde {requiredName}.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(false)}
            className="shrink-0 px-3 py-2 rounded-xl bg-violet-600 text-white text-[9px] font-black uppercase hover:bg-violet-700"
          >
            Ver información
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center px-3 py-5 sm:px-6 sm:py-8">
      <div className="relative w-full max-w-2xl min-w-0 overflow-hidden rounded-3xl border border-violet-100/80 bg-white shadow-[0_24px_70px_-28px_rgba(91,33,182,0.35)] dark:border-slate-800 dark:bg-slate-900">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-violet-200/45 blur-3xl dark:bg-violet-900/20" />
        <div className="pointer-events-none absolute -left-20 bottom-0 h-48 w-48 rounded-full bg-indigo-100/55 blur-3xl dark:bg-indigo-900/20" />

        <div className="relative p-4 sm:p-7">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="absolute right-3 top-3 h-8 w-8 rounded-xl border border-slate-200 bg-white text-slate-400 hover:text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white flex items-center justify-center"
            aria-label="Cerrar aviso"
            title="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex min-w-0 items-start gap-3 pr-9">
            <div className="relative flex h-12 w-12 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-600/25">
              <LockKeyhole className="h-5 w-5 sm:h-6 sm:w-6" />
              <span className="absolute -bottom-1 -right-1 flex h-5 w-5 sm:h-6 sm:w-6 items-center justify-center rounded-full border-2 border-white bg-white text-violet-600 shadow-sm dark:border-slate-900 dark:bg-slate-900 dark:text-violet-300">
                <Sparkles className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
              </span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[8px] font-black uppercase tracking-[.14em] text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                  Función premium
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 dark:border-slate-700 dark:bg-slate-800">
                  <PalmyraWordmark className="h-4 w-auto shrink-0" />
                </span>
              </div>
              <h1 className="mt-2 text-lg font-black leading-tight tracking-tight text-slate-950 dark:text-white break-words sm:text-2xl">
                {title}
              </h1>
            </div>
          </div>

          <p className="mt-4 text-sm font-medium leading-6 text-slate-500 dark:text-slate-300 break-words">
            {description}
          </p>

          <div className="mt-4 min-w-0 rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50/90 via-white to-indigo-50/70 p-3.5 dark:border-slate-800 dark:from-violet-950/40 dark:via-slate-900 dark:to-indigo-950/40 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[8px] font-black uppercase tracking-[.14em] text-slate-500 dark:text-slate-400">Se desbloquea con</p>
                <p className="mt-1 text-base font-black text-slate-950 dark:text-white">{requiredName}</p>
              </div>
              <span className="shrink-0 rounded-xl bg-white px-2.5 py-1.5 text-[9px] font-black text-violet-700 shadow-sm ring-1 ring-violet-100 dark:bg-slate-800 dark:text-violet-300 dark:ring-slate-700">
                US${requiredPlan.price}/mes
              </span>
            </div>
            <p className="mt-2 text-[10px] font-bold leading-5 text-slate-600 dark:text-slate-300 break-words">{limits}</p>
            <ul className="mt-3 space-y-1.5">
              {benefits.map((line) => (
                <li key={line} className="flex items-start gap-2 text-[10px] font-bold leading-5 text-slate-600 dark:text-slate-300">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                  <span className="min-w-0 break-words">{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3 min-w-0 rounded-2xl border border-slate-200 bg-slate-50/80 p-3.5 dark:border-slate-800 dark:bg-slate-800/50">
            <p className="text-[8px] font-black uppercase tracking-[.14em] text-slate-500 dark:text-slate-400">Tu plan actual</p>
            <p className="mt-0.5 text-sm font-black text-slate-900 dark:text-white truncate">{currentName}</p>
            <p className="mt-1 text-[10px] font-bold leading-5 text-slate-500 dark:text-slate-300">
              Esta sección queda visible para que sepas qué puedes desbloquear. No es un error: forma parte de un plan superior.
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => navigate('/subscription')}
              className="group order-1 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 text-[10px] font-black uppercase tracking-[.08em] text-white shadow-lg shadow-violet-600/20 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-violet-600/25 active:translate-y-0 sm:order-2 sm:w-auto sm:px-5"
            >
              <ArrowUpCircle className="h-4 w-4 shrink-0" />
              <span className="truncate">Ver planes y actualizar</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={goBack}
              className="order-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-[10px] font-black uppercase tracking-[.08em] text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 sm:order-1 sm:w-auto"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              Volver
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
