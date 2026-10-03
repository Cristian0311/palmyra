import React,{useEffect,useState} from "react";
import {Laptop,LogOut,RefreshCw,ShieldCheck,Smartphone,MonitorX} from "lucide-react";
import {loadSaaSContext,signOutSaaSAccount} from "../services/saas";
import {loadMyDevices,revokeMyDevice,type MyDevice} from "../services/security";
import {useStore} from "../store/useStore";
import {cn} from "../lib/utils";

export default function Security(){
 const {addNotification}=useStore();
 const [devices,setDevices]=useState<MyDevice[]>([]);
 const [ctx,setCtx]=useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const refresh=async()=>{
  setLoading(true);setError("");
  try{
   const next=await loadSaaSContext(true);
   setCtx(next);
   if(next?.companyId) setDevices(await loadMyDevices(next.companyId));
  }catch(e){setError(e?.message||"No se pudieron cargar las sesiones.")}
  finally{setLoading(false)}
 };
 useEffect(()=>{void refresh()},[]);
 const revoke=async(device:MyDevice)=>{
  if(!ctx?.companyId)return;
  setBusy(true);setError("");
  try{
   await revokeMyDevice(ctx.companyId,device.id);
   if(device.is_current){
    await signOutSaaSAccount();
    window.location.href="/auth";
    return;
   }
   addNotification("Dispositivo revocado.", "success");
   await refresh();
  }catch(e){setError(e?.message||"No se pudo revocar el dispositivo.");}
  finally{setBusy(false)}
 };
 if(loading)return <div className="min-h-[50vh] flex items-center justify-center text-sm font-bold text-muted">Cargando seguridad...</div>;
 return <div className="space-y-5 max-w-5xl mx-auto pb-10">
  <header className="bg-secondary border border-base rounded-3xl p-5 flex items-center justify-between gap-3">
   <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-rose-500">Seguridad</p><h1 className="text-2xl font-black text-primary mt-1">Dispositivos y sesiones</h1><p className="text-xs text-muted mt-1">Controla desde qué dispositivos puede utilizarse tu cuenta en esta empresa.</p></div>
   <button onClick={()=>void refresh()} disabled={busy} className="h-10 px-4 rounded-xl border border-base bg-primary text-primary text-xs font-black flex items-center gap-2"><RefreshCw className={cn("w-4 h-4",loading&&"animate-spin")}/>Actualizar</button>
  </header>
  {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold p-3">{error}</div>}
  <section className="bg-secondary border border-base rounded-3xl overflow-hidden">
   <div className="p-5 border-b border-base"><div className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-emerald-600"/><h2 className="text-sm font-black text-primary">Sesiones activas</h2></div><p className="text-[10px] text-muted mt-1">Revocar un dispositivo impide que esa sesión vuelva a entrar cuando PALMYRA revalide su acceso.</p></div>
   {devices.length?devices.map(device=><div key={device.id} className="p-5 border-b last:border-b-0 border-base flex flex-col md:flex-row md:items-center gap-4">
    <div className="w-11 h-11 rounded-2xl bg-subtle flex items-center justify-center text-primary">{/Android|iPhone|iPad/i.test(device.name)?<Smartphone className="w-5 h-5"/>:<Laptop className="w-5 h-5"/>}</div>
    <div className="flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-black text-primary">{device.name}</p>{device.is_current&&<span className="text-[9px] uppercase font-black bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full">Esta sesión</span>}{!device.active&&<span className="text-[9px] uppercase font-black bg-slate-100 text-slate-500 px-2 py-1 rounded-full">Revocado</span>}</div><p className="text-[10px] text-muted mt-1">Última actividad: {device.last_seen_at?new Date(device.last_seen_at).toLocaleString("es-CU"):"—"}</p></div>
    <button disabled={busy||!device.active} onClick={()=>void revoke(device)} className="h-10 px-3 rounded-xl border border-base text-xs font-black flex items-center justify-center gap-2 disabled:opacity-40">{device.is_current?<><LogOut className="w-4 h-4"/>Cerrar sesión</>:<><MonitorX className="w-4 h-4"/>Revocar</>}</button>
   </div>):<div className="p-10 text-center text-xs text-muted">No hay dispositivos registrados todavía.</div>}
  </section>
 </div>;
}
