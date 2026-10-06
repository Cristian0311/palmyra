import React,{useEffect,useState} from "react";
import {Laptop,LogOut,RefreshCw,ShieldCheck,Smartphone,MonitorX,LockKeyhole,WifiOff,CheckCircle2} from "lucide-react";
import {loadSaaSContext,signOutSaaSAccount} from "../services/saas";
import {loadMyDevices,revokeMyDevice,revokeOtherDevices,type MyDevice} from "../services/security";
import {getCachedSaaSContext} from "../services/offlineAuthContext";
import {useStore} from "../store/useStore";
import {cn} from "../lib/utils";

export default function Security(){
 const {addNotification,currentUser}=useStore();
 const [devices,setDevices]=useState<MyDevice[]>([]);
 const [ctx,setCtx]=useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [online,setOnline]=useState(()=>typeof navigator==="undefined" ? true : navigator.onLine);
 const offline=!online;

 const refresh=async()=>{
  setLoading(true);setError("");
  try{
   const cached=currentUser?.id ? getCachedSaaSContext(currentUser.id) : null;
   const next=offline ? cached : await loadSaaSContext(true);
   setCtx(next);
   if(next?.companyId && !offline) setDevices(await loadMyDevices(next.companyId));
   else setDevices([]);
  }catch(e:any){setError(e?.message||"No se pudieron cargar las sesiones.")}
  finally{setLoading(false);}
 };
 useEffect(()=>{
  const onOnline=()=>setOnline(true);
  const onOffline=()=>setOnline(false);
  window.addEventListener("online",onOnline);
  window.addEventListener("offline",onOffline);
  void refresh();
  return()=>{window.removeEventListener("online",onOnline);window.removeEventListener("offline",onOffline)};
 },[online,currentUser?.id]);

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
   addNotification("Dispositivo revocado y registrado en auditoría.", "success");
   await refresh();
  }catch(e:any){setError(e?.message||"No se pudo revocar el dispositivo.");}
  finally{setBusy(false)}
 };

 const revokeOthers=async()=>{
  if(!ctx?.companyId||offline)return;
  setBusy(true);setError("");
  try{
   const result=await revokeOtherDevices(ctx.companyId);
   addNotification(`${Number(result?.revoked_count||0)} sesiones adicionales fueron revocadas.`, "success");
   await refresh();
  }catch(e:any){setError(e?.message||"No se pudieron revocar las demás sesiones.");}
  finally{setBusy(false)}
 };

 if(loading)return <div className="min-h-[50vh] flex items-center justify-center text-sm font-bold text-muted">Cargando seguridad...</div>;

 return <div className="space-y-5 max-w-5xl mx-auto pb-10">
  <header className="bg-secondary border border-base rounded-3xl p-5 flex items-start justify-between gap-3">
   <div><p className="text-[10px] font-black uppercase tracking-[.18em] text-emerald-600">Centro de atención · Seguridad</p><h1 className="text-2xl font-black text-primary mt-1">Cuenta protegida</h1><p className="text-xs text-muted mt-1">Gestiona dispositivos, sesiones y revocaciones de acceso desde un único lugar.</p></div>
   <button onClick={()=>void refresh()} disabled={busy} className="h-10 px-4 rounded-xl border border-base bg-primary text-primary text-xs font-black flex items-center gap-2"><RefreshCw className={cn("w-4 h-4",loading&&"animate-spin")}/>Actualizar</button>
  </header>

  {offline&&<div className="rounded-2xl border border-amber-200 bg-amber-50 text-amber-800 p-4 flex items-start gap-3"><WifiOff className="w-5 h-5 mt-0.5 shrink-0"/><div><p className="text-xs font-black">Modo offline</p><p className="text-[11px] leading-5 mt-1">La sesión local puede continuar trabajando, pero la consulta y revocación remota de dispositivos requieren conexión.</p></div></div>}
  {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold p-3">{error}</div>}

  <section className="grid md:grid-cols-3 gap-3">
   <div className="bg-secondary border border-base rounded-3xl p-5"><div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center"><ShieldCheck className="w-5 h-5"/></div><p className="text-[10px] uppercase tracking-wide font-black text-muted mt-4">Estado</p><p className="text-lg font-black text-primary mt-1">{ctx?"Sesión identificada":"Sin contexto"}</p><p className="text-[10px] text-muted mt-1">La cuenta sigue ligada al usuario autenticado.</p></div>
   <div className="bg-secondary border border-base rounded-3xl p-5"><div className="w-10 h-10 rounded-2xl bg-violet-50 text-violet-600 flex items-center justify-center"><LockKeyhole className="w-5 h-5"/></div><p className="text-[10px] uppercase tracking-wide font-black text-muted mt-4">Control remoto</p><p className="text-lg font-black text-primary mt-1">Revocación</p><p className="text-[10px] text-muted mt-1">Puedes cerrar las demás sesiones sin tocar la actual.</p></div>
   <div className="bg-secondary border border-base rounded-3xl p-5"><div className="w-10 h-10 rounded-2xl bg-slate-100 text-slate-700 flex items-center justify-center"><CheckCircle2 className="w-5 h-5"/></div><p className="text-[10px] uppercase tracking-wide font-black text-muted mt-4">Auditoría</p><p className="text-lg font-black text-primary mt-1">Trazable</p><p className="text-[10px] text-muted mt-1">Las revocaciones quedan registradas como eventos de seguridad.</p></div>
  </section>

  <section className="bg-secondary border border-base rounded-3xl overflow-hidden">
   <div className="p-5 border-b border-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
    <div><div className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-emerald-600"/><h2 className="text-sm font-black text-primary">Sesiones y dispositivos</h2></div><p className="text-[10px] text-muted mt-1">Cada acceso activo de tu usuario se controla por dispositivo y empresa.</p></div>
    <button onClick={()=>void revokeOthers()} disabled={busy||offline||devices.filter(d=>d.active&&!d.is_current).length===0} className="h-10 px-3 rounded-xl bg-slate-900 text-white text-xs font-black flex items-center justify-center gap-2 disabled:opacity-40"><LogOut className="w-4 h-4"/>Cerrar otras sesiones</button>
   </div>
   {devices.length?devices.map(device=><div key={device.id} className="p-5 border-b last:border-b-0 border-base flex flex-col md:flex-row md:items-center gap-4">
    <div className="w-11 h-11 rounded-2xl bg-subtle flex items-center justify-center text-primary">{/Android|iPhone|iPad/i.test(device.name)?<Smartphone className="w-5 h-5"/>:<Laptop className="w-5 h-5"/>}</div>
    <div className="flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-black text-primary">{device.name}</p>{device.is_current&&<span className="text-[9px] uppercase font-black bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full">Esta sesión</span>}{!device.active&&<span className="text-[9px] uppercase font-black bg-slate-100 text-slate-500 px-2 py-1 rounded-full">Revocado</span>}</div><p className="text-[10px] text-muted mt-1">Última actividad: {device.last_seen_at?new Date(device.last_seen_at).toLocaleString("es-CU"):"—"}</p><p className="text-[9px] text-muted mt-1">Huella: {device.fingerprint?device.fingerprint.slice(-8):"—"}</p></div>
    <button disabled={busy||!device.active} onClick={()=>void revoke(device)} className="h-10 px-3 rounded-xl border border-base text-xs font-black flex items-center justify-center gap-2 disabled:opacity-40">{device.is_current?<><LogOut className="w-4 h-4"/>Cerrar sesión</>:<><MonitorX className="w-4 h-4"/>Revocar</>}</button>
   </div>):<div className="p-10 text-center text-xs text-muted">{offline?"La lista de dispositivos se consulta al volver a estar online.":"No hay dispositivos registrados todavía."}</div>}
  </section>
 </div>;
}
