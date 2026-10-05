import React,{useEffect,useMemo,useState} from "react";
import {Laptop,LogOut,RefreshCw,ShieldCheck,Smartphone,MonitorX,CheckCircle2,AlertTriangle,X,Clock3,Building2} from "lucide-react";
import {loadSaaSContext,signOutSaaSAccount} from "../services/saas";
import {loadMyDevices,revokeMyDevice,type MyDevice} from "../services/security";
import {useStore} from "../store/useStore";
import {cn} from "../lib/utils";
import "./security.css";

export default function Security(){
 const {addNotification}=useStore();
 const [devices,setDevices]=useState<MyDevice[]>([]);
 const [ctx,setCtx]=useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [pendingRevoke,setPendingRevoke]=useState<MyDevice|null>(null);

 const refresh=async()=>{
  setLoading(true);setError("");
  try{
   const next=await loadSaaSContext(true);
   setCtx(next);
   if(next?.companyId) setDevices(await loadMyDevices(next.companyId));
  }catch(e:any){setError(e?.message||"No se pudieron cargar las sesiones.")}
  finally{setLoading(false)}
 };
 useEffect(()=>{void refresh()},[]);

 const activeDevices=useMemo(()=>devices.filter(device=>device.active),[devices]);
 const currentDevice=useMemo(()=>devices.find(device=>device.is_current&&device.active)||null,[devices]);
 const otherDevices=useMemo(()=>activeDevices.filter(device=>!device.is_current),[activeDevices]);

 const confirmRevoke=async()=>{
  const device=pendingRevoke;
  if(!device||!ctx?.companyId)return;
  setPendingRevoke(null);setBusy(true);setError("");
  try{
   await revokeMyDevice(ctx.companyId,device.id);
   if(device.is_current){
    await signOutSaaSAccount();
    window.location.href="/auth";
    return;
   }
   addNotification("Dispositivo revocado correctamente.","success");
   await refresh();
  }catch(e:any){setError(e?.message||"No se pudo revocar el dispositivo.")}
  finally{setBusy(false)}
 };

 const iconFor=(name:string)=>{
  return /Android|iPhone|iPad|Mobile/i.test(name)?Smartphone:Laptop;
 };

 if(loading)return <div className="security-page"><div className="security-loading"><RefreshCw className="animate-spin"/><span>Preparando seguridad…</span></div></div>;

 return <div className="security-page">
  <header className="security-hero">
   <div className="security-hero-copy">
    <div className="security-eyebrow"><ShieldCheck/> Centro de protección</div>
    <h1 data-palmi-content="security">Dispositivos y sesiones</h1>
    <p>Controla desde dónde se utiliza tu cuenta en esta empresa y corta accesos que ya no reconozcas.</p>
   </div>
   <button onClick={()=>void refresh()} disabled={busy||loading} className="security-refresh"><RefreshCw className={cn("w-4 h-4",loading&&"animate-spin")}/>Actualizar</button>
  </header>

  {error&&<div className="security-alert"><AlertTriangle/><span>{error}</span><button onClick={()=>setError("")} aria-label="Cerrar"><X/></button></div>}

  <section className="security-status-grid">
   <article className="security-status-card"><span className="security-status-icon security-good"><CheckCircle2/></span><div><strong>Protección activa</strong><p>La sesión se valida de nuevo al usar la cuenta.</p></div></article>
   <article className="security-status-card"><span className="security-status-icon"><Smartphone/></span><div><strong>{activeDevices.length} dispositivo{activeDevices.length===1?"":"s"} activo{activeDevices.length===1?"":"s"}</strong><p>{otherDevices.length?otherDevices.length+" adicional"+(otherDevices.length===1?"":"es")+" aparte de este":"Solo este dispositivo está activo"}</p></div></article>
   <article className="security-status-card"><span className="security-status-icon"><Clock3/></span><div><strong>Sesiones revisables</strong><p>Revoca dispositivos sin cerrar toda la empresa.</p></div></article>
  </section>

  <section className="security-panel">
   <div className="security-panel-head"><div><span>SESIÓN ACTUAL</span><h2>Este dispositivo</h2><p>Es el acceso que estás usando ahora mismo.</p></div><span className="security-current-badge"><span/>Activo</span></div>
   {currentDevice ? (()=>{const Icon=iconFor(currentDevice.name);return <div className="security-device-main">
    <div className="security-device-icon"><Icon/></div>
    <div className="security-device-info"><strong>{currentDevice.name||"Dispositivo actual"}</strong><span>{currentDevice.warehouse_id?"Almacén operativo asignado":"Sin almacén específico"}</span><small>Última actividad: {currentDevice.last_seen_at?new Date(currentDevice.last_seen_at).toLocaleString("es-CU"):"Ahora"}</small></div>
    <button disabled={busy} onClick={()=>setPendingRevoke(currentDevice)} className="security-outline-danger"><LogOut/>Cerrar sesión</button>
   </div> : <div className="security-empty">No se ha identificado una sesión activa en este dispositivo.</div>}
  </section>

  <section className="security-panel">
   <div className="security-panel-head"><div><span>OTROS DISPOSITIVOS</span><h2>Accesos autorizados</h2><p>Revisa los dispositivos que siguen vinculados a tu cuenta.</p></div><span className="security-count">{otherDevices.length}</span></div>
   {otherDevices.length?otherDevices.map(device=>{const Icon=iconFor(device.name);return <div key={device.id} className="security-device-row">
    <div className="security-device-icon"><Icon/></div>
    <div className="security-device-info"><div className="security-device-title"><strong>{device.name||"Dispositivo"}</strong><span className="security-neutral-badge"><Building2/>{device.warehouse_id?"Acceso de empresa":"Acceso general"}</span></div><small>Última actividad: {device.last_seen_at?new Date(device.last_seen_at).toLocaleString("es-CU"):"—"}</small></div>
    <button disabled={busy||!device.active} onClick={()=>setPendingRevoke(device)} className="security-revoke"><MonitorX/>Revocar</button>
   </div>}) : <div className="security-empty"><ShieldCheck/><span>No hay otros dispositivos activos vinculados a tu cuenta.</span></div>}
  </section>

  <section className="security-note"><ShieldCheck/><div><strong>Regla de seguridad PALMYRA</strong><p>Las credenciales son personales. Revocar un dispositivo no modifica los permisos del trabajador ni borra los datos de la empresa.</p></div></section>

  {pendingRevoke&&<div className="security-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Confirmar revocación de dispositivo">
   <div className="security-confirm">
    <div className="security-confirm-icon"><MonitorX/></div>
    <span>CONTROL DE ACCESO</span><h3>{pendingRevoke.is_current?"Cerrar sesión":"Revocar dispositivo"}</h3>
    <p>{pendingRevoke.is_current?"Se cerrará la sesión en este dispositivo. Los datos de la empresa permanecerán intactos.":"Este dispositivo perderá su acceso cuando PALMYRA vuelva a validar la sesión."}</p>
    <div className="security-confirm-actions"><button onClick={()=>setPendingRevoke(null)} className="security-confirm-secondary">Cancelar</button><button onClick={()=>void confirmRevoke()} className="security-confirm-danger" disabled={busy}>{busy?"Procesando…":"Confirmar"}</button></div>
   </div>
  </div>}
 </div>;
}
