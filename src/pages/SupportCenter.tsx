import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, BookOpen, CheckCircle2, ChevronRight, FileText, Headphones,
  MessageCircle, PlayCircle, ShieldCheck, Smartphone, Sparkles, TicketCheck,
  TriangleAlert, X
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useStore } from "../store/useStore";
import { getAccessibleNumaTourSteps } from "../components/help/palmiGuideSteps";
import { buildWhatsAppUrl, createSupportRequest, loadPlatformSupportSettings, type PlatformSupportSettings } from "../services/platformSupport";
import Security from "./Security";
import "./helpCenter.css";

type CenterSection = "overview" | "tutorial" | "support" | "security" | "privacy";
const sections: Array<{id: CenterSection; label: string; icon: typeof Headphones; hint: string}> = [
  { id:"overview", label:"Inicio", icon: Headphones, hint:"Ayuda y orientación" },
  { id:"tutorial", label:"Tutorial", icon: BookOpen, hint:"Aprende paso a paso" },
  { id:"support", label:"Atención al cliente", icon: MessageCircle, hint:"Solicitudes y soporte" },
  { id:"security", label:"Seguridad", icon: ShieldCheck, hint:"Dispositivos y sesiones" },
  { id:"privacy", label:"Política y privacidad", icon: FileText, hint:"Información y confianza" }
];
const requestTypes=["Error detectado","Problema de acceso","Ayuda con una función","Consulta de facturación","Solicitud de mejora","Otro"];

export default function SupportCenter(){
  const [params,setParams]=useSearchParams();
  const currentUser=useStore(s=>s.currentUser);
  const companyName=useStore(s=>s.storeConfig.storeName||"Mi empresa");
  const [support,setSupport]=useState<PlatformSupportSettings>({whatsapp_number:null,support_email:null,privacy_url:null});
  const [loading,setLoading]=useState(true),[sending,setSending]=useState(false),[sent,setSent]=useState(false),[error,setError]=useState("");
  const [form,setForm]=useState({requestType:"Error detectado",subject:"",message:"",contactPhone:""});
  const section=((params.get("section") as CenterSection)||"overview");

  const tutorialSteps=useMemo(()=>getAccessibleNumaTourSteps(currentUser)
    .filter(step=>!["welcome","finish"].includes(step.id)),[currentUser]);

  useEffect(()=>{
    let active=true;
    void loadPlatformSupportSettings()
      .then(value=>{if(active)setSupport(value)})
      .catch(()=>{if(active)setError("No se pudo cargar el canal de atención.")})
      .finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[]);

  const changeSection=(next:CenterSection)=>{setSent(false);setError("");setParams({section:next});};
  const startNuma=()=>window.dispatchEvent(new Event("palmyra:open-guide"));

  const submitSupport=async(e:React.FormEvent)=>{
    e.preventDefault();setError("");setSent(false);
    if(form.subject.trim().length<3)return setError("Escribe un asunto breve.");
    if(form.message.trim().length<10)return setError("Describe la solicitud con un poco más de detalle.");
    if(!support.whatsapp_number)return setError("El canal de atención no está configurado. Un administrador debe definirlo en PALMYRA Admin.");
    setSending(true);
    try{
      const saved=await createSupportRequest({requestType:form.requestType,subject:form.subject,message:form.message,contactPhone:form.contactPhone});
      const url=buildWhatsAppUrl(support.whatsapp_number,[
        "Hola PALMYRA, necesito atención.","","Empresa: "+companyName,"Tipo: "+form.requestType,
        "Asunto: "+form.subject.trim(),"Detalle: "+form.message.trim(),
        form.contactPhone.trim()?"Teléfono: "+form.contactPhone.trim():"",
        "Solicitud: "+saved.request_id,"","Enviado desde el Centro de atención de PALMYRA."
      ].filter(Boolean).join("\n"));
      if(!url)throw new Error("El número de atención configurado no es válido.");
      setSent(true);setForm(prev=>({...prev,subject:"",message:""}));window.location.assign(url);
    }catch(e:any){setError(e?.message||"No se pudo enviar la solicitud.");}
    finally{setSending(false);}
  };

  return <div data-palmi-content="help-center" className="help-center-page">
    <header className="help-center-hero">
      <div className="help-center-hero-copy">
        <div className="help-center-eyebrow"><Headphones/> PALMYRA CARE</div>
        <h1>Centro de atención</h1>
        <p>Ayuda, tutoriales, seguridad y atención oficial de PALMYRA, reunidos en un solo lugar para que tu equipo pueda seguir trabajando sin salir de la empresa.</p>
        <div className="help-center-trust"><CheckCircle2/> Canal oficial · Seguridad · Tutoriales</div>
      </div>
      <div className="help-center-hero-art" aria-hidden="true"><div className="help-orbit orbit-one"/><div className="help-orbit orbit-two"/><div className="help-hero-icon"><Headphones/></div></div>
    </header>

    <nav className="help-center-nav" aria-label="Secciones del Centro de atención">
      {sections.map(({id,label,icon:Icon,hint})=><button key={id} data-help-tab={id} type="button" onClick={()=>changeSection(id)} className={section===id?"is-active":""}>
        <span className="help-center-nav-icon"><Icon/></span><span className="min-w-0 text-left"><strong>{label}</strong><small>{hint}</small></span><ChevronRight className="ml-auto"/>
      </button>)}
    </nav>

    {loading?<div className="help-center-loading">Preparando tu centro de atención…</div>:null}
    {error?<div className="help-center-alert"><TriangleAlert/><span>{error}</span><button onClick={()=>setError("")} aria-label="Cerrar"><X/></button></div>:null}
    {sent?<div className="help-center-success"><CheckCircle2/><span>Solicitud registrada. Se abrirá el canal oficial configurado por PALMYRA.</span></div>:null}

    {!loading&&section==="overview"&&<section className="help-center-grid">
      <button type="button" className="help-feature-card help-feature-card--primary" onClick={()=>changeSection("tutorial")}><span className="help-feature-icon"><BookOpen/></span><span className="help-feature-kicker">APRENDER</span><strong>Aprende haciendo</strong><p>Conoce cada módulo y deja que Numa te indique dónde pulsar para que seas tú quien realice el recorrido.</p><span className="help-feature-cta">Ver tutorial <ArrowRight/></span></button>
      <button type="button" className="help-feature-card" onClick={()=>changeSection("support")}><span className="help-feature-icon"><TicketCheck/></span><span className="help-feature-kicker">SOPORTE</span><strong>Atención al cliente</strong><p>Describe el problema o la solicitud. PALMYRA la registra y te dirige al WhatsApp oficial configurado por el administrador.</p><span className="help-feature-cta">Crear solicitud <ArrowRight/></span></button>
      <button type="button" className="help-feature-card" onClick={()=>changeSection("security")}><span className="help-feature-icon"><ShieldCheck/></span><span className="help-feature-kicker">PROTECCIÓN</span><strong>Seguridad de la cuenta</strong><p>Revisa sesiones, dispositivos y accesos desde el mismo centro.</p><span className="help-feature-cta">Ver seguridad <ArrowRight/></span></button>
      <button type="button" className="help-feature-card" onClick={()=>changeSection("privacy")}><span className="help-feature-icon"><FileText/></span><span className="help-feature-kicker">INFORMACIÓN</span><strong>Política y privacidad</strong><p>Consulta las reglas de uso y cómo PALMYRA trata la información de la empresa.</p><span className="help-feature-cta">Leer política <ArrowRight/></span></button>
      <div className="help-center-tip"><div className="help-center-tip-icon"><Sparkles/></div><div><strong>Consejo PALMYRA</strong><p>Aprende el camino primero. Después, cada módulo te resultará más simple y el equipo podrá trabajar con menos errores.</p></div></div>
    </section>}

    {!loading&&section==="tutorial"&&<section className="help-center-section">
      <div className="help-section-head"><div><span className="help-section-kicker">TUTORIAL OPERATIVO</span><h2>Aprende paso a paso</h2><p>El tutorial de esta pantalla es de consulta. Numa es el recorrido interactivo: te pedirá localizar cada área y esperar a que tú la abras.</p></div><button type="button" className="help-primary-btn" onClick={startNuma}><PlayCircle/> Abrir recorrido Numa</button></div>
      <div className="help-tutorial-list">{tutorialSteps.map((step,i)=><article key={step.id} className="help-tutorial-card"><div className="help-step-number">{String(i+1).padStart(2,"0")}</div><div className="help-tutorial-card-body"><span>{step.eyebrow}</span><h3>{step.title}</h3><p>{step.message}</p>{step.tip&&<div className="help-tutorial-tip"><Sparkles/>{step.tip}</div>}</div></article>)}</div>
      <div className="help-install-note"><Smartphone/><div><strong>Después del recorrido</strong><p>Numa muestra la opción de instalar PALMYRA como aplicación PWA cuando el navegador lo permite. La cuenta se conserva para que el siguiente arranque pueda entrar directamente con tu sesión.</p></div></div>
    </section>}

    {!loading&&section==="support"&&<section className="help-center-support">
      <div className="help-support-copy"><span className="help-section-kicker">ATENCIÓN AL CLIENTE</span><h2>¿Qué necesitas resolver?</h2><p>Selecciona el tipo de solicitud, cuéntanos qué ocurrió y continuaremos por el canal oficial. La solicitud queda registrada para conservar trazabilidad.</p><div className="help-contact-card"><MessageCircle/><div><strong>Canal oficial</strong><span>{support.whatsapp_number?"WhatsApp disponible":"Canal pendiente de configurar"}</span>{support.support_email&&<small>{support.support_email}</small>}</div></div></div>
      <form className="help-support-form" onSubmit={submitSupport}>
        <label><span>Nombre de la empresa</span><div className="help-readonly"><input value={companyName} readOnly/></div></label>
        <label><span>Tipo de solicitud</span><select value={form.requestType} onChange={e=>setForm({...form,requestType:e.target.value})}>{requestTypes.map(type=><option key={type}>{type}</option>)}</select></label>
        <label><span>Asunto</span><input value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})} placeholder="Ej. La venta no se registra offline"/></label>
        <label><span>Detalle</span><textarea value={form.message} onChange={e=>setForm({...form,message:e.target.value})} rows={6} placeholder="Qué ocurrió, cuándo ocurrió y qué esperabas que pasara." /></label>
        <label><span>Teléfono para contacto (opcional)</span><div className="help-input-with-icon"><Smartphone/><input value={form.contactPhone} onChange={e=>setForm({...form,contactPhone:e.target.value})} placeholder="+53 …"/></div></label>
        <div className="help-support-footer"><small><ShieldCheck/> Trazabilidad registrada en PALMYRA</small><button className="help-primary-btn" disabled={sending}>{sending?<><MessageCircle/> Enviando…</>:<><ArrowRight/> Enviar a atención</>}</button></div>
      </form>
    </section>}

    {!loading&&section==="security"&&<section className="help-security-embedded"><Security/></section>}

    {!loading&&section==="privacy"&&<section className="help-center-section help-policy">
      <div className="help-section-head"><div><span className="help-section-kicker">POLÍTICA Y PRIVACIDAD</span><h2>Información y confianza</h2><p>Estas son las reglas de referencia dentro de PALMYRA. La URL oficial configurada en PALMYRA Admin tendrá prioridad.</p></div></div>
      <article className="help-policy-card"><h3>Protección de la cuenta</h3><p>El propietario y los trabajadores usan credenciales independientes. Los permisos se asignan por rol y el acceso por almacén se controla dentro de la empresa.</p></article>
      <article className="help-policy-card"><h3>Datos operativos</h3><p>PALMYRA utiliza la información necesaria para ofrecer ventas, caja, inventario, equipo, reportes y configuración, aplicando el acceso según el usuario y sus permisos.</p></article>
      <article className="help-policy-card"><h3>Seguridad y sesiones</h3><p>Los dispositivos autorizados se pueden revisar y revocar desde el Centro de atención para reducir el riesgo de accesos no deseados.</p></article>
      {support.privacy_url?<a className="help-policy-link" href={support.privacy_url} target="_blank" rel="noreferrer"><FileText/> Abrir política oficial <ArrowRight/></a>:null}
    </section>}
  </div>;
}
