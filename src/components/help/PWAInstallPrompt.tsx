import { useEffect, useState } from "react";
import { Download, X, Smartphone } from "lucide-react";

type BeforeInstallPromptEvent = Event & { prompt:()=>Promise<void>; userChoice:Promise<{outcome:"accepted"|"dismissed"}> };

export default function PWAInstallPrompt({ onClose }: { onClose?:()=>void }) {
  const [event,setEvent]=useState<BeforeInstallPromptEvent|null>(null);
  const [installed,setInstalled]=useState(false);
  useEffect(()=>{
    const media=window.matchMedia?.("(display-mode: standalone)");
    const standalone=media?.matches || (navigator as Navigator & {standalone?:boolean}).standalone === true;
    if(standalone){setInstalled(true);return;}
    const handler=(e:Event)=>{e.preventDefault();setEvent(e as BeforeInstallPromptEvent)};
    window.addEventListener("beforeinstallprompt",handler);
    const done=()=>setInstalled(true);
    window.addEventListener("appinstalled",done);
    return()=>{window.removeEventListener("beforeinstallprompt",handler);window.removeEventListener("appinstalled",done)};
  },[]);
  if(installed)return null;
  const install=async()=>{if(!event)return;await event.prompt();const choice=await event.userChoice;if(choice.outcome==="accepted"){setEvent(null);setInstalled(true)}};
  const canInstall=Boolean(event);
  return <div className="pwa-install-backdrop" role="dialog" aria-modal="true" aria-label="Instalar PALMYRA">
    <div className="pwa-install-card">
      <button className="pwa-install-close" onClick={onClose} aria-label="Cerrar"><X size={17}/></button>
      <div className="pwa-install-icon"><Smartphone size={25}/></div>
      <span className="pwa-install-kicker">PALMYRA · LISTO</span>
      <h2>Ten PALMYRA siempre contigo</h2>
      <p>Instala PALMYRA como una aplicación en tu dispositivo. Se abrirá en una ventana propia, ocupará menos espacio visual y será más cómodo volver a tu negocio.</p>
      {canInstall ? <button className="pwa-install-primary" onClick={install}><Download size={17}/> Instalar PALMYRA</button> : <div className="pwa-install-manual"><strong>Instalación rápida</strong><span>Si tu navegador no muestra el botón automático, abre el menú del navegador y selecciona <b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.</span></div>}
      <button className="pwa-install-later" onClick={onClose}>Ahora no</button>
    </div>
  </div>
}