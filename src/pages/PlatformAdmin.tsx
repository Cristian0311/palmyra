import React,{useEffect,useState} from "react";
import {Check,Clock3,RefreshCw,ShieldAlert,Building2,Ban,XCircle,Headphones,Save,MessageCircle,Link2,Activity,DatabaseZap} from "lucide-react";
import {loadPlatformAdminSnapshot,loadPlatformUsage,approvePlanRequest,rejectPlanRequest,setPlatformCompanyStatus,setPlatformSupportSettings,type PlatformSupportSettings} from "../services/platformAdmin";
import {useStore} from "../store/useStore";
import {DEFAULT_FACEBOOK_URL} from "../services/platformSupport";

const EMPTY_SUPPORT:PlatformSupportSettings={
  whatsapp_number:null,
  support_email:null,
  privacy_url:null,
  facebook_url:DEFAULT_FACEBOOK_URL,
  whatsapp_channel_url:null
};

function FacebookMark({className=""}:{className?:string}){
 return <svg viewBox="0 0 24 24" aria-hidden="true" className={className}><path fill="currentColor" d="M13.7 21v-7h2.4l.4-2.8h-2.8V9.4c0-.8.2-1.4 1.5-1.4h1.6V5.5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.4-3.7 3.8v2H8.5V14H11v7h2.7Z"/></svg>;
}

function WhatsAppMark({className=""}:{className?:string}){
 return <svg viewBox="0 0 24 24" aria-hidden="true" className={className}><path fill="currentColor" d="M12 3.1a8.8 8.8 0 0 0-7.6 13.3L3.1 21l4.8-1.2A8.9 8.9 0 1 0 12 3.1Zm0 1.8a7.1 7.1 0 0 1 6.1 10.8 7 7 0 0 1-8.1 3.1l-.5-.2-2.8.7.8-2.7-.3-.5A7.1 7.1 0 0 1 12 4.9Zm-3.2 2.9c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2 0 1.2.8 2.3.9 2.5.1.2 1.7 2.8 4.3 3.8 2.1.8 2.5.6 2.9.6.4 0 1.3-.5 1.5-1 .2-.5.2-.9.1-1-.1-.1-.3-.2-.7-.4l-.9-.4c-.4-.1-.6-.2-.8.2-.2.3-.6.8-.7 1-.1.2-.3.2-.6.1-.3-.1-1.1-.4-2-1.2-.7-.6-1.2-1.4-1.3-1.6-.1-.2 0-.3.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.7-1.6c-.2-.4-.5-.5-.8-.5Z"/></svg>;
}

export default function PlatformAdmin(){
 const {addNotification}=useStore();
 const [data,setData]=useState<any>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [supportForm,setSupportForm]=useState<PlatformSupportSettings>(EMPTY_SUPPORT);\n const [usage,setUsage]=useState<any>(null);
 const refresh=async()=>{
  setLoading(true);setError("");
  try{
   const [snapshot,usageSnapshot]=await Promise.all([
    loadPlatformAdminSnapshot(),
    loadPlatformUsage().catch(()=>null)
   ]);
   setData(snapshot);
   setUsage(usageSnapshot);
   setSupportForm({...EMPTY_SUPPORT,...snapshot.supportSettings});
  }catch(e:any){
   setError(String(e?.message||"No tienes acceso a la consola de plataforma."));
  }finally{setLoading(false);}
 };
 useEffect(()=>{void refresh()},[]);
 const action=async(fn:()=>Promise<any>,msg:string)=>{
  setBusy(true);setError("");
  try{await fn();await refresh();addNotification(msg,"success")}
  catch(e:any){setError(e?.message||"No se pudo completar la operación.")}
  finally{setBusy(false)}
 };
 const saveSupport=async(e:React.FormEvent)=>{
  e.preventDefault();
  await action(
   ()=>setPlatformSupportSettings(supportForm),
   "Configuración de atención y privacidad guardada."
  );
 };
 if(loading)return <div className="min-h-screen flex items-center justify-center text-sm font-bold text-muted">Cargando administración de PALMYRA...</div>;
 if(error&&!data)return <div className="min-h-screen flex items-center justify-center p-5"><div className="max-w-md text-center bg-secondary border border-base rounded-3xl p-8"><ShieldAlert className="w-10 h-10 mx-auto text-rose-500"/><h1 className="text-xl font-black text-primary mt-3">Acceso restringido</h1><p className="text-xs text-muted mt-2">{error}</p></div></div>;
 return <div className="min-h-screen bg-primary p-5 md:p-8">
  <div className="max-w-6xl mx-auto space-y-5">
   <header className="bg-secondary border border-base rounded-3xl p-5 flex items-center justify-between gap-3">
    <div><p className="text-[10px] uppercase tracking-[.18em] font-black text-rose-500">Plataforma</p><h1 className="text-2xl font-black text-primary mt-1">Administración PALMYRA</h1><p className="text-xs text-muted mt-1">Empresas, planes, atención y seguridad de plataforma.</p></div>
    <button onClick={()=>void refresh()} disabled={busy} className="h-10 px-4 rounded-xl border border-base font-black text-xs flex items-center gap-2"><RefreshCw className="w-4 h-4"/>Actualizar</button>
   </header>
   {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold p-3">{error}</div>}

   <section className="bg-secondary border border-base rounded-3xl p-5">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Activity className="w-5 h-5 text-emerald-600"/>
        <div><h2 className="text-sm font-black text-primary">Consumo de API e infraestructura</h2><p className="text-[11px] text-muted mt-0.5">Vigila Render y Supabase antes de que el crecimiento de PALMYRA obligue a ampliar infraestructura.</p></div>
      </div>
      <button type="button" onClick={()=>void refresh()} disabled={loading||busy} className="h-9 px-3 rounded-xl border border-base text-[9px] font-black uppercase flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5"/>Actualizar</button>
    </div>
    {!usage ? (
      <div className="mt-4 rounded-2xl border border-dashed border-base p-4 text-center text-[10px] font-bold text-muted">
        Configura las credenciales de servidor de Render/Supabase para activar la lectura automática de consumo.
      </div>
    ) : (
      <div className="mt-4 grid md:grid-cols-2 gap-3">
        {(() => {
          const renderGb=Number(usage.render?.bandwidthGb);
          const renderPct=Number.isFinite(renderGb)?Math.min(100,(renderGb/Number(usage.limits.renderFreeBandwidthGb||5))*100):null;
          const dbMb=Number(usage.supabase?.databaseMb);
          const dbPct=Number.isFinite(dbMb)?Math.min(100,(dbMb/Number(usage.limits.supabaseFreeDatabaseMb||500))*100):null;
          const renderWarn=renderPct!==null&&renderPct>=80;
          const dbWarn=dbPct!==null&&dbPct>=80;
          return <>
            <div className={`rounded-2xl border p-4 ${renderWarn?'border-amber-200 bg-amber-50/60':'border-base bg-primary'}`}>
              <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Activity className="w-4 h-4 text-rose-500"/><span className="text-[10px] font-black uppercase text-primary">Render · ancho de banda</span></div><span className="text-[9px] font-black text-muted">Free: 5 GB/mes</span></div>
              <p className="mt-3 text-2xl font-black text-primary">{renderPct!==null?`${renderGb.toFixed(2)} GB`:"No disponible"}</p>
              {renderPct!==null&&<div className="mt-2 h-2 rounded-full bg-slate-200 overflow-hidden"><div className={`h-full rounded-full ${renderWarn?'bg-amber-500':'bg-emerald-500'}`} style={{width:`${renderPct}%`}}/></div>}
              <p className={`mt-2 text-[9px] font-bold ${renderWarn?'text-amber-700':'text-muted'}`}>{renderWarn?"Alerta: consumo cercano al límite configurado.":"Seguimiento mensual activo."}</p>
              <p className="mt-1 text-[8px] font-bold text-muted">{usage.render?.requests!==null?Number(usage.render.requests).toLocaleString("es-CU")+" solicitudes HTTP":""}</p>
            </div>
            <div className={`rounded-2xl border p-4 ${dbWarn?'border-amber-200 bg-amber-50/60':'border-base bg-primary'}`}>
              <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><DatabaseZap className="w-4 h-4 text-violet-600"/><span className="text-[10px] font-black uppercase text-primary">Supabase · base de datos</span></div><span className="text-[9px] font-black text-muted">Free: 500 MB</span></div>
              <p className="mt-3 text-2xl font-black text-primary">{dbPct!==null?`${dbMb.toFixed(1)} MB`:"No disponible"}</p>
              {dbPct!==null&&<div className="mt-2 h-2 rounded-full bg-slate-200 overflow-hidden"><div className={`h-full rounded-full ${dbWarn?'bg-amber-500':'bg-violet-500'}`} style={{width:`${dbPct}%`}}/></div>}
              <p className={`mt-2 text-[9px] font-bold ${dbWarn?'text-amber-700':'text-muted'}`}>{dbWarn?"Alerta: la base se acerca al límite Free.":"Seguimiento del tamaño real de PostgreSQL."}</p>
              <p className="mt-1 text-[8px] font-bold text-muted">{usage.supabase?.apiRequests!==null?Number(usage.supabase.apiRequests).toLocaleString("es-CU")+" solicitudes API (muestra disponible)":""}</p>
            </div>
          </>;
        })()}
      </div>
    )}
    <p className="mt-3 text-[8px] leading-4 font-bold text-muted">Las alertas se muestran al alcanzar aproximadamente el 80 % del límite configurado. Render también controla horas de instancia y minutos de build; esos valores no se estiman a partir de solicitudes HTTP. Supabase mantiene API requests ilimitadas en Free, por lo que el panel prioriza tamaño de base y otros recursos reales.</p>
   </section>

   <section className="bg-secondary border border-base rounded-3xl p-5">
    <div className="flex items-center gap-2"><Headphones className="w-5 h-5 text-violet-600"/><div><h2 className="text-sm font-black text-primary">Centro de atención y canales oficiales</h2><p className="text-[11px] text-muted mt-0.5">Configura los canales que utilizarán las empresas desde el CRM y durante el registro gratuito.</p></div></div>
    <form onSubmit={saveSupport} className="mt-5 grid lg:grid-cols-3 gap-4">
     <label className="block"><span className="text-[10px] font-black uppercase tracking-wide text-muted">WhatsApp de atención</span><div className="mt-1 flex items-center gap-2 border border-base rounded-2xl bg-primary px-3 h-12"><MessageCircle className="w-4 h-4 text-violet-500 shrink-0"/><input value={supportForm.whatsapp_number||""} onChange={e=>setSupportForm({...supportForm,whatsapp_number:e.target.value})} placeholder="+53..." className="min-w-0 w-full bg-transparent outline-none text-sm font-bold text-primary"/></div></label>
     <label className="block"><span className="text-[10px] font-black uppercase tracking-wide text-muted">Correo de soporte</span><div className="mt-1 flex items-center gap-2 border border-base rounded-2xl bg-primary px-3 h-12"><MessageCircle className="w-4 h-4 text-violet-500 shrink-0"/><input type="email" value={supportForm.support_email||""} onChange={e=>setSupportForm({...supportForm,support_email:e.target.value})} placeholder="soporte@palmyra..." className="min-w-0 w-full bg-transparent outline-none text-sm font-bold text-primary"/></div></label>
     <label className="block"><span className="text-[10px] font-black uppercase tracking-wide text-muted">Política y privacidad</span><div className="mt-1 flex items-center gap-2 border border-base rounded-2xl bg-primary px-3 h-12"><Link2 className="w-4 h-4 text-violet-500 shrink-0"/><input type="url" value={supportForm.privacy_url||""} onChange={e=>setSupportForm({...supportForm,privacy_url:e.target.value})} placeholder="https://..." className="min-w-0 w-full bg-transparent outline-none text-sm font-bold text-primary"/></div></label>
     <div className="lg:col-span-3 grid md:grid-cols-2 gap-4">
      <label className="block"><span className="text-[10px] font-black uppercase tracking-wide text-muted">Facebook oficial</span><div className="mt-1 flex items-center gap-2 border border-base rounded-2xl bg-primary px-3 h-12"><FacebookMark className="w-4 h-4 text-violet-500 shrink-0"/><input type="url" value={supportForm.facebook_url||""} onChange={e=>setSupportForm({...supportForm,facebook_url:e.target.value})} placeholder="https://facebook.com/..." className="min-w-0 w-full bg-transparent outline-none text-sm font-bold text-primary"/></div></label>
      <label className="block"><span className="text-[10px] font-black uppercase tracking-wide text-muted">Canal oficial de WhatsApp</span><div className="mt-1 flex items-center gap-2 border border-base rounded-2xl bg-primary px-3 h-12"><WhatsAppMark className="w-4 h-4 text-violet-500 shrink-0"/><input type="url" value={supportForm.whatsapp_channel_url||""} onChange={e=>setSupportForm({...supportForm,whatsapp_channel_url:e.target.value})} placeholder="https://whatsapp.com/channel/..." className="min-w-0 w-full bg-transparent outline-none text-sm font-bold text-primary"/></div></label>
     </div>
     <div className="lg:col-span-3 flex flex-col sm:flex-row sm:items-center gap-3"><button disabled={busy} className="h-11 px-5 rounded-xl bg-violet-600 text-white font-black text-xs flex items-center justify-center gap-2 disabled:opacity-60"><Save className="w-4 h-4"/>Guardar configuración</button><p className="text-[10px] text-muted">WhatsApp atiende solicitudes; Facebook y el canal de WhatsApp se mostrarán en el registro gratuito y en el Centro de atención.</p></div>
    </form>
   </section>

   <section className="bg-secondary border border-base rounded-3xl p-5">
    <div className="flex items-center gap-2"><Clock3 className="w-5 h-5 text-amber-600"/><h2 className="text-sm font-black text-primary">Solicitudes de plan pendientes</h2></div>
    <div className="mt-4 space-y-2">{data.requests.length?data.requests.map((r:any)=><div key={r.id} className="p-4 rounded-2xl bg-subtle border border-base flex flex-col md:flex-row md:items-center gap-3"><div className="flex-1"><p className="text-sm font-black text-primary">{r.company_name}</p><p className="text-xs text-muted mt-1">{r.plan_name} · {Number(r.monthly_price||0).toFixed(2)} / mes</p><p className="text-[10px] text-muted mt-1">{new Date(r.requested_at).toLocaleString("es-CU")}</p></div><div className="flex gap-2"><button disabled={busy} onClick={()=>void action(()=>approvePlanRequest(r.id),"Solicitud aprobada y empresa activada.")} className="h-10 px-3 rounded-xl bg-emerald-600 text-white font-black text-xs flex items-center gap-2"><Check className="w-4 h-4"/>Confirmar efectivo y activar</button><button disabled={busy} onClick={()=>void action(()=>rejectPlanRequest(r.id,"Solicitud rechazada desde plataforma"),"Solicitud rechazada.")} className="h-10 px-3 rounded-xl bg-slate-200 text-slate-700 font-black text-xs flex items-center gap-2"><XCircle className="w-4 h-4"/>Rechazar</button></div></div>):<p className="text-xs text-muted py-5 text-center">No hay solicitudes pendientes.</p>}</div>
   </section>

   <section className="bg-secondary border border-base rounded-3xl p-5">
    <div className="flex items-center gap-2"><MessageCircle className="w-5 h-5 text-violet-600"/><h2 className="text-sm font-black text-primary">Últimas solicitudes de atención</h2></div>
    <div className="mt-4 space-y-2">{data.supportRequests?.length?data.supportRequests.map((r:any)=><div key={r.id} className="rounded-2xl border border-base bg-primary p-4"><div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2"><div><p className="text-sm font-black text-primary">{r.company_name}</p><p className="text-xs text-muted mt-1">{r.request_type} · {r.subject}</p></div><span className="text-[9px] uppercase font-black px-2 py-1 rounded-full bg-subtle text-muted">{r.status}</span></div><p className="mt-3 text-xs leading-5 text-secondary">{r.message}</p><p className="mt-3 text-[10px] text-muted">{new Date(r.created_at).toLocaleString("es-CU")}{r.contact_phone?" · "+r.contact_phone:""}</p></div>):<p className="text-xs text-muted py-5 text-center">Todavía no hay solicitudes de atención.</p>}</div>
   </section>

   <section className="bg-secondary border border-base rounded-3xl p-5">
    <div className="flex items-center gap-2"><Building2 className="w-5 h-5 text-rose-500"/><h2 className="text-sm font-black text-primary">Empresas</h2></div>
    <div className="grid md:grid-cols-2 gap-3 mt-4">{data.companies.map((c:any)=><div key={c.id} className="p-4 rounded-2xl border border-base bg-primary"><div className="flex justify-between gap-3"><div><p className="text-sm font-black text-primary">{c.name}</p><p className="text-[10px] text-muted mt-1">{c.slug}</p></div><span className="text-[9px] uppercase font-black px-2 py-1 rounded-full bg-subtle text-muted">{c.account_status}</span></div><div className="grid grid-cols-3 gap-2 mt-4 text-center"><div><p className="text-lg font-black text-primary">{c.products}</p><p className="text-[9px] text-muted">Productos</p></div><div><p className="text-lg font-black text-primary">{c.employees}</p><p className="text-[9px] text-muted">Empleados</p></div><div><p className="text-lg font-black text-primary">{c.warehouses}</p><p className="text-[9px] text-muted">Almacenes</p></div></div><div className="flex gap-2 mt-4"><button disabled={busy} onClick={()=>void action(()=>setPlatformCompanyStatus(c.id,c.account_status==="suspended"?"active":"suspended"),c.account_status==="suspended"?"Empresa reactivada.":"Empresa suspendida.")} className="h-9 px-3 rounded-xl border border-base text-xs font-black flex items-center gap-2">{c.account_status==="suspended"?<Check className="w-3.5 h-3.5"/>:<Ban className="w-3.5 h-3.5"/>}{c.account_status==="suspended"?"Reactivar":"Suspender"}</button></div></div>)}</div>
   </section>
  </div>
 </div>
}
