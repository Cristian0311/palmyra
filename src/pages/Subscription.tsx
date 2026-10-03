import React,{useEffect,useState} from "react";
import {CheckCircle2,Clock3,CreditCard,RefreshCw,ShieldCheck} from "lucide-react";
import {loadSubscriptionOverview,selectSubscriptionPlan,type SubscriptionPlan} from "../services/subscription";
import {useStore} from "../store/useStore";
import {cn} from "../lib/utils";

function money(v:number){return v.toLocaleString("es-CU",{minimumFractionDigits:2,maximumFractionDigits:2});}

export default function Subscription(){
  const {addNotification}=useStore();
  const [data,setData]=useState<any>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  const refresh=async()=>{
    setLoading(true);setError("");
    try{setData(await loadSubscriptionOverview());}
    catch(e:any){setError(e?.message||"No se pudo cargar la suscripción.");}
    finally{setLoading(false);}
  };
  useEffect(()=>{void refresh();},[]);

  const choose=async(plan:SubscriptionPlan)=>{
    if(!data?.ctx?.companyId)return;
    setBusy(true);setError("");
    try{
      const result=await selectSubscriptionPlan(plan.id);
      await refresh();
      addNotification(result?.status==="pending_payment" ? "Solicitud de plan enviada." : "Plan actualizado.", "success");
    }catch(e:any){setError(e?.message||"No se pudo solicitar el plan.");}
    finally{setBusy(false);}
  };

  if(loading)return <div className="min-h-[50vh] flex items-center justify-center text-sm font-bold text-muted">Cargando suscripción...</div>;
  if(data && !data.ctx.isOwner) return <div className="min-h-[50vh] flex items-center justify-center"><div className="max-w-md bg-secondary border border-base rounded-3xl p-8 text-center"><ShieldCheck className="w-10 h-10 mx-auto text-rose-500"/><h2 className="text-xl font-black text-primary mt-3">Solo el propietario puede cambiar el plan</h2><p className="text-xs text-muted mt-2">Puedes consultar otras áreas permitidas de la empresa, pero la suscripción pertenece al propietario.</p></div></div>;

  const subPlan=data?.subscription?.plans;
  const currentCode=subPlan?.code||data?.ctx?.subscription?.planCode||"starter";
  const request=data?.request;

  return <div className="space-y-5 max-w-6xl mx-auto pb-10">
    <header className="bg-secondary border border-base rounded-3xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
      <div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-rose-500">Cuenta</p><h1 className="text-2xl font-black text-primary mt-1">Plan y suscripción</h1><p className="text-xs text-muted mt-1">Consulta el estado de tu plan y solicita cambios sin afectar tus datos.</p></div>
      <button onClick={()=>void refresh()} disabled={busy} className="h-10 px-4 rounded-xl border border-base bg-primary text-primary text-xs font-black flex items-center gap-2"><RefreshCw className={cn("w-4 h-4",loading&&"animate-spin")}/>Actualizar</button>
    </header>

    {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold p-3">{error}</div>}

    <section className="grid md:grid-cols-3 gap-3">
      <div className="bg-secondary border border-base rounded-2xl p-4"><p className="text-[9px] uppercase tracking-wider text-muted font-black">Plan actual</p><p className="text-xl font-black text-primary mt-1">{subPlan?.name||"Starter"}</p><p className="text-[10px] text-muted mt-1 uppercase">{currentCode}</p></div>
      <div className="bg-secondary border border-base rounded-2xl p-4"><p className="text-[9px] uppercase tracking-wider text-muted font-black">Estado</p><p className="text-xl font-black text-primary mt-1 capitalize">{data?.ctx?.company?.account_status||data?.subscription?.status||"activo"}</p><p className="text-[10px] text-muted mt-1">{data?.subscription?.trial_ends_at ? "Prueba configurada" : "Ciclo de servicio"}</p></div>
      <div className="bg-secondary border border-base rounded-2xl p-4"><p className="text-[9px] uppercase tracking-wider text-muted font-black">Próximo vencimiento</p><p className="text-xl font-black text-primary mt-1">{data?.subscription?.trial_ends_at||data?.subscription?.current_period_end ? new Date(data.subscription.trial_ends_at||data.subscription.current_period_end).toLocaleDateString("es-CU") : "—"}</p></div>
    </section>

    {request&&<section className="bg-amber-50 border border-amber-200 rounded-2xl p-4"><div className="flex items-start gap-3"><Clock3 className="w-5 h-5 text-amber-700 mt-0.5"/><div><p className="text-sm font-black text-amber-900">Solicitud {request.status}</p><p className="text-xs text-amber-800 mt-1">Plan solicitado: {request.plan_name||request.plan_code} · {new Date(request.requested_at).toLocaleDateString("es-CU")}</p>{request.note&&<p className="text-[10px] text-amber-800 mt-1">{request.note}</p>}</div></div></section>}

    <section className="grid md:grid-cols-3 gap-4">
      {data?.plans?.map((plan:SubscriptionPlan)=>{
        const current=plan.code===currentCode;
        return <article key={plan.id} className={cn("bg-secondary border rounded-3xl p-5 flex flex-col",current?"border-rose-300 ring-1 ring-rose-200":"border-base")}>
          <div className="flex items-center justify-between gap-2"><div><p className="text-lg font-black text-primary">{plan.name}</p><p className="text-[10px] uppercase text-muted font-black">{plan.code}</p></div>{current&&<span className="text-[9px] px-2 py-1 rounded-full bg-rose-100 text-rose-700 font-black">Actual</span>}</div>
          <p className="text-2xl font-black text-primary mt-5">{money(Number(plan.monthly_price)||0)}<span className="text-xs text-muted font-bold"> / mes</span></p>
          <div className="mt-5 space-y-2 text-[10px] text-muted flex-1">
            <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5"/>{String(plan.limits?.employees||"Ilimitados")} empleados</div>
            <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5"/>{String(plan.limits?.warehouses||"Ilimitados")} almacenes</div>
            <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5"/>{String(plan.limits?.products||"Ilimitados")} productos</div>
          </div>
          <button disabled={busy||current} onClick={()=>void choose(plan)} className={cn("h-11 mt-6 rounded-xl font-black text-xs flex items-center justify-center gap-2",current?"bg-subtle text-muted":"bg-slate-950 text-white disabled:opacity-50")}>{current?<><ShieldCheck className="w-4 h-4"/>Plan actual</>:<><CreditCard className="w-4 h-4"/>Solicitar {plan.name}</>}</button>
        </article>;
      })}
    </section>

    <p className="text-[10px] text-muted text-center">Las solicitudes Growth/Pro quedan pendientes de activación. La integración de cobro automático todavía se mantiene separada del núcleo operativo.</p>
  </div>;
}
