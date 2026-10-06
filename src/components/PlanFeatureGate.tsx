import React, { useEffect, useState } from 'react';
import { LockKeyhole, ArrowUpCircle, Loader2 } from 'lucide-react';
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

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-5">
      <div className="w-full max-w-xl rounded-3xl border border-violet-100 bg-white p-7 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
          <LockKeyhole className="h-6 w-6" />
        </div>
        <p className="mt-4 text-[9px] font-black uppercase tracking-[.16em] text-violet-600">Función de plan</p>
        <h1 className="mt-2 text-xl font-black text-slate-900">{title}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</p>
        <div className="mt-5 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-left">
          <p className="text-xs font-black text-amber-900">Disponible desde {requiredName}</p>
          <p className="mt-1 text-[11px] text-amber-800">
            Tu plan actual es <b>{currentName}</b>. Puedes conocer esta función, pero para utilizarla necesitas actualizar el plan.
          </p>
        </div>
        <button type="button" onClick={() => navigate('/subscription')} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-violet-600 px-5 text-xs font-black text-white hover:bg-violet-700">
          <ArrowUpCircle className="h-4 w-4" /> Ver planes y actualizar
        </button>
      </div>
    </div>
  );
}
