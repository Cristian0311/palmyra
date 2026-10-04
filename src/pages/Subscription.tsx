import React,{useEffect,useState} from "react";
import {CheckCircle2,Clock3,CreditCard,RefreshCw,ShieldCheck,WalletCards,Globe2,Landmark} from "lucide-react";
import {loadSubscriptionOverview,selectSubscriptionPlan,type SubscriptionPlan} from "../services/subscription";
import {useStore} from "../store/useStore";
import {cn} from "../lib/utils";
import {getSupabase} from "../lib/supabase";
import {goToWhatsAppPayment} from "../utils/whatsapp";

function money(v:number){return v.toLocaleString("es-CU",{minimumFractionDigits:2,maximumFractionDigits:2});}

export default function Subscription(){
  const {addNotification}=useStore();
  const [data,setData]=useState<any>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [paymentMethod,setPaymentMethod]=useState<'manual_cash'|'manual_bank_transfer'>('manual_cash');

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
      const result=await selectSubscriptionPlan(plan.id,paymentMethod);
      if(result?.status==="pending_payment"){
        let ownerName="";
        let ownerEmail="";
        let warehouseName="";
        try{
          const supabase=getSupabase();
          if(supabase){
            const [{data:authData},{data:warehouse}]=await Promise.all([
              supabase.auth.getUser(),
              supabase.from("warehouses").select("name").eq("company_id",data.ctx.companyId).eq("active",true).order("created_at",{ascending:true}).limit(1).maybeSingle()
            ]);
            ownerEmail=authData.user?.email||"";
            ownerName=authData.user?.user_metadata?.full_name||authData.user?.user_metadata?.name||"";
            warehouseName=warehouse?.name||"";
          }
        }catch(authError){console.warn("[PALMYRA] No se pudieron preparar todos los datos de WhatsApp:",authError);}
        goToWhatsAppPayment({
          ownerName,
          ownerEmail,
          companyName:data?.ctx?.company?.name||"",
          warehouseName,
          planName:plan.name,
          planCode:plan.code,
          amount:Number(plan.monthly_price)||undefined,
          currency:plan.billing_currency_code||"USD",
          paymentMethod,
          requestId:result?.request_id||undefined
        });
        return;
      }
      await refresh();
      addNotification("Plan actualizado.", "success");
    }catch(e:any){setError(e?.message||"No se pudo solicitar el plan.");}
    finally{setBusy(false);}
  };

  if(loading)return <div className="min-h-[50vh] flex items-center justify-center text-sm font-bold text-muted">Cargando suscripción...</div>;
  if(data && !data.ctx.isOwner) return <div className="min-h-[50vh] flex items-center justify-center"><div className="max-w-md bg-secondary border border-base rounded-3xl p-8 text-center"><ShieldCheck className="w-10 h-10 mx-auto text-[#6535C5]"/><h2 className="text-xl font-black text-primary mt-3">Solo el propietario puede cambiar el plan</h2><p className="text-xs text-muted mt-2">Puedes consultar otras áreas permitidas de la empresa, pero la suscripción pertenece al propietario.</p></div></div>;

  const subPlan=data?.subscription?.plans;
  const currentCode=subPlan?.code||data?.ctx?.subscription?.planCode||"starter";
  const request=data?.request;
    return <div className="space-y-4 sm:space-y-5 w-full min-w-0 max-w-6xl mx-auto pb-10 overflow-x-hidden">
    <header className="bg-secondary border border-base rounded-3xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
      <div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#6535C5]">Cuenta</p><h1 className="text-2xl font-black text-primary mt-1">Facturación y plan</h1><p className="text-xs text-muted mt-1">En Cuba puedes solicitar el plan mediante efectivo o transferencia bancaria. La activación se realiza después de confirmar el pago.</p></div>
      <button onClick={()=>void refresh()} disabled={busy} className="h-10 px-4 rounded-xl border border-base bg-primary text-primary text-xs font-black flex items-center gap-2"><RefreshCw className={cn("w-4 h-4",loading&&"animate-spin")}/>Actualizar</button>
    </header>

    {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold p-3">{error}</div>}

    <section className="grid md:grid-cols-3 gap-3">
      <div className="bg-secondary border border-base rounded-2xl p-4"><p className="text-[9px] uppercase tracking-wider text-muted font-black">Plan actual</p><p className="text-xl font-black text-primary mt-1">{subPlan?.name||"Oasis"}</p><p className="text-[10px] text-muted mt-1 uppercase">{currentCode}</p></div>
      <div className="bg-secondary border border-base rounded-2xl p-4"><p className="text-[9px] uppercase tracking-wider text-muted font-black">Estado</p><p className="text-xl font-black text-primary mt-1 capitalize">{data?.ctx?.company?.account_status||data?.subscription?.status||"activo"}</p><p className="text-[10px] text-muted mt-1">{data?.subscription?.trial_ends_at ? "Prueba configurada" : "Ciclo de servicio"}</p></div>
      <div className="bg-secondary border border-base rounded-2xl p-4"><p className="text-[9px] uppercase tracking-wider text-muted font-black">Próximo vencimiento</p><p className="text-xl font-black text-primary mt-1">{data?.subscription?.trial_ends_at||data?.subscription?.current_period_end ? new Date(data.subscription.trial_ends_at||data.subscription.current_period_end).toLocaleDateString("es-CU") : "—"}</p></div>
    </section>

    {data?.invoices?.length>0&&<section className="bg-secondary border border-base rounded-3xl overflow-hidden"><div className="p-5 border-b border-base"><div className="flex items-center gap-2"><CreditCard className="w-5 h-5 text-[#6535C5]"/><h2 className="text-sm font-black text-primary">Facturas</h2></div><p className="text-[10px] text-muted mt-1">Historial de los períodos facturados de esta empresa.</p></div>{data.invoices.map((invoice:any)=><div key={invoice.id} className="p-4 border-b last:border-b-0 border-base flex flex-col sm:flex-row sm:items-center gap-3"><div className="flex-1"><p className="text-xs font-black text-primary">{invoice.invoice_number}</p><p className="text-[10px] text-muted mt-1">{new Date(invoice.period_start).toLocaleDateString("es-CU")} — {new Date(invoice.period_end).toLocaleDateString("es-CU")}</p></div><div className="text-right"><p className="text-sm font-black text-primary">{Number(invoice.amount||0).toLocaleString("es-CU",{minimumFractionDigits:2,maximumFractionDigits:2})} {invoice.currency_code}</p><span className={cn("text-[9px] uppercase font-black",invoice.status==="paid"?"text-emerald-600":invoice.status==="void"?"text-slate-500":"text-amber-600")}>{invoice.status}</span></div></div>)}</section>}

    {request&&<section className="bg-amber-50 border border-amber-200 rounded-2xl p-4"><div className="flex items-start gap-3"><Clock3 className="w-5 h-5 text-amber-700 mt-0.5"/><div className="min-w-0"><p className="text-sm font-black text-amber-900">Solicitud {request.status}</p><p className="text-xs text-amber-800 mt-1">Plan solicitado: {request.plan_name||request.plan_code} · {new Date(request.requested_at).toLocaleDateString("es-CU")}</p>{request.status==="pending"&&<><p className="text-[10px] text-emerald-700 mt-2 font-black">Tu empresa NO se bloquea por solicitar un plan mayor.</p><p className="text-[10px] text-amber-800 mt-1">Seguirás usando tu plan actual con normalidad hasta que PALMYRA apruebe la solicitud. Al aprobarse, el nuevo plan se aplica automáticamente sin cerrar sesión ni crear otra empresa.</p></>}{request.note&&<p className="text-[10px] text-amber-800 mt-1">{request.note}</p>}</div></div></section>}

    <section className="bg-secondary border border-base rounded-3xl p-5">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-[9px] uppercase tracking-wider text-muted font-black">Método para solicitar el plan</p><p className="text-sm font-black text-primary mt-1">Selecciona cómo realizarás el pago en Cuba.</p></div>
        <CreditCard className="w-5 h-5 text-[#6535C5]"/>
      </div>
      <div className="grid sm:grid-cols-2 gap-2 mt-4">
        <button type="button" onClick={()=>setPaymentMethod('manual_cash')} className={cn("rounded-2xl border p-4 text-left",paymentMethod==='manual_cash'?"border-[#8B63E6] bg-[#EFE8FF]":"border-base bg-secondary")}>
          <WalletCards className="w-5 h-5 text-[#6535C5]"/><p className="text-xs font-black text-primary mt-2">Efectivo</p><p className="text-[10px] text-muted mt-1">Pago manual y activación después de confirmar.</p>
        </button>
        <button type="button" onClick={()=>setPaymentMethod('manual_bank_transfer')} className={cn("rounded-2xl border p-4 text-left",paymentMethod==='manual_bank_transfer'?"border-[#8B63E6] bg-[#EFE8FF]":"border-base bg-secondary")}>
          <Landmark className="w-5 h-5 text-[#6535C5]"/><p className="text-xs font-black text-primary mt-2">Transferencia bancaria</p><p className="text-[10px] text-muted mt-1">Transferencia en Cuba y confirmación manual.</p>
        </button>
      </div>
    </section>

    <section className="grid md:grid-cols-2 gap-3">
      <div className="bg-violet-50 border border-violet-200 rounded-2xl p-4">
        <div className="flex items-center gap-2"><WalletCards className="w-5 h-5 text-violet-700"/><p className="text-sm font-black text-violet-900">Método activo · Cuba</p></div>
        <p className="text-xs text-violet-800 mt-1">{paymentMethod==='manual_bank_transfer' ? 'Transferencia bancaria seleccionada. La activación se realiza después de confirmar el pago.' : 'Efectivo seleccionado. La activación se realiza después de confirmar el pago.'}</p>
      </div>
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
        <div className="flex items-center gap-2"><Globe2 className="w-5 h-5 text-slate-600"/><p className="text-sm font-black text-slate-800">Internacional · preparado</p></div>
        <p className="text-xs text-slate-500 mt-1">Stripe, PayPal, Mercado Pago u otro proveedor podrán conectarse sin cambiar la cuenta ni los historiales.</p>
      </div>
    </section>

    {request?.status==="pending" && (
      <section className="bg-violet-50 border border-violet-200 rounded-2xl p-4">
        <div className="flex items-start gap-3">
          <CreditCard className="w-5 h-5 text-violet-700 mt-0.5 shrink-0"/>
          <div className="min-w-0">
            <p className="text-sm font-black text-violet-900">
              {request.payment_method==="manual_bank_transfer" ? "Transferencia bancaria · Cuba" : "Pago en efectivo · Cuba"}
            </p>
            <p className="text-xs text-violet-800 mt-1">
              {request.payment_method==="manual_bank_transfer"
                ? "La solicitud queda pendiente de confirmación. Coordina la transferencia con PALMYRA usando la vía indicada; tu plan actual sigue operativo mientras revisamos el cambio."
                : "La solicitud queda pendiente de confirmación. Coordina el efectivo con PALMYRA usando la vía indicada; tu plan actual sigue operativo mientras revisamos el cambio."}
            </p>
            {request.whatsapp_phone&&<a className="inline-flex mt-2 text-[11px] font-black text-violet-700 underline" href={"https://wa.me/"+String(request.whatsapp_phone).replace(/[^0-9]/g,"")} target="_blank" rel="noreferrer">Contactar para pago</a>}
          </div>
        </div>
      </section>
    )}

    <section className="grid md:grid-cols-3 gap-4">
      {data?.plans?.map((plan:SubscriptionPlan)=>{
        const current=plan.code===currentCode;
        return <article key={plan.id} className={cn("bg-secondary border rounded-3xl p-5 flex flex-col",current?"border-[#8B63E6] ring-1 ring-[#DCCBFF]":"border-base")}>
          <div className="flex items-center justify-between gap-2"><div><p className="text-lg font-black text-primary">{plan.name}</p><p className="text-[10px] uppercase text-muted font-black">{plan.code}</p></div>{current&&<span className="text-[9px] px-2 py-1 rounded-full bg-[#EFE8FF] text-[#6535C5] font-black">Actual</span>}</div>
          <p className="text-2xl font-black text-primary mt-5">{money(Number(plan.monthly_price)||0)} <span className="text-base font-black text-primary">{plan.billing_currency_code || "USD"}</span><span className="text-xs text-muted font-bold"> / mes</span></p>
          <div className="mt-5 space-y-2 text-[10px] text-muted flex-1">
            <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5"/>{String(plan.limits?.employees||"Ilimitados")} empleados</div>
            <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5"/>{String(plan.limits?.warehouses||"Ilimitados")} almacenes</div>
            <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5"/>{String(plan.limits?.products||"Ilimitados")} productos</div>
          </div>
          <button disabled={busy||current} onClick={()=>void choose(plan)} className={cn("h-11 mt-6 rounded-xl font-black text-xs flex items-center justify-center gap-2",current?"bg-subtle text-muted":"bg-slate-950 text-white disabled:opacity-50")}>{current?<><ShieldCheck className="w-4 h-4"/>Plan actual</>:<><CreditCard className="w-4 h-4"/>Solicitar {plan.name}</>}</button>
        </article>;
      })}
    </section>

    <p className="text-[10px] text-muted text-center">Solicitar un plan mayor no bloquea tu empresa: el plan actual continúa operativo hasta la aprobación. Una vez aprobada la solicitud, PALMYRA actualiza la suscripción automáticamente.</p>
  </div>;
}
