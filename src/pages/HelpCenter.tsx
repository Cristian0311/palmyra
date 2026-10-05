import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, BookOpen, CheckCircle2, ChevronRight, FileText, Headphones,
  LockKeyhole, MessageCircle, Newspaper, PlayCircle, Send, ShieldCheck,
  Smartphone, Sparkles, TicketCheck, TriangleAlert, UserRound, WifiOff, X
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../store/useStore";
import { getAccessibleNumaTourSteps } from "../components/help/palmiGuideSteps";
import { buildWhatsAppUrl, createSupportRequest, loadPlatformSupportSettings, type PlatformSupportSettings } from "../services/platformSupport";
import Security from "./Security";
import "./helpCenter.css";

type CenterSection = "overview" | "tutorial" | "support" | "security" | "privacy";

const sections: Array<{id: CenterSection; label: string; icon: typeof Headphones; hint: string}> = [
  { id:"overview", label:"Inicio", icon: Headphones, hint:"Todo lo que necesitas para trabajar con PALMYRA" },
  { id:"tutorial", label:"Tutorial", icon: BookOpen, hint:"Aprende paso a paso y sin saltos" },
  { id:"support", label:"Atención al cliente", icon: MessageCircle, hint:"Envía una solicitud directamente al equipo PALMYRA" },
  { id:"security", label:"Seguridad", icon: ShieldCheck, hint:"Dispositivos y sesiones de tu cuenta" },
  { id:"privacy", label:"Política y privacidad", icon: LockKeyhole, hint:"Cómo protegemos y usamos la información" }
];

const requestTypes = [
  "Error detectado",
  "Problema de acceso",
  "Ayuda con una función",
  "Consulta de facturación",
  "Solicitud de mejora",
  "Otro"
];

export default function HelpCenter(){
  const navigate = useNavigate();
  const [params,setParams] = useSearchParams();
  const currentUser = useStore(s=>s.currentUser);
  const companyName = useStore(s=>s.storeConfig.storeName || s.currentUser?.companyName || "Mi empresa");
  const [support,setSupport] = useState<PlatformSupportSettings>({whatsapp_number:null,support_email:null,privacy_url:null});
  const [loading,setLoading] = useState(true);
  const [sending,setSending] = useState(false);
  const [sent,setSent] = useState(false);
  const [error,setError] = useState("");
  const [form,setForm] = useState({requestType:"Error detectado",subject:"",message:"",contactPhone:""});
  const section = (params.get("section") as CenterSection) || "overview";

  const tutorialSteps = useMemo(
    ()=>getAccessibleNumaTourSteps(currentUser, typeof window!=="undefined" && window.matchMedia("(max-width:720px)").matches)
      .filter(step=>step.id!=="welcome" && step.id!=="finish" && !step.mobileOnly),
    [currentUser]
  );

  useEffect(()=>{
    let active=true;
    loadPlatformSupportSettings()
      .then(value=>{if(active)setSupport(value)})
      .catch(()=>{if(active)setError("No se pudo cargar el canal de atención.")}
      .finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[]);

  useEffect(()=>{
    document.title = section==="overview" ? "Centro de atención · PALMYRA" : `${sections.find(s=>s.id===section)?.label || "Centro"} · PALMYRA`;
  },[section]);

  const changeSection=(next:CenterSection)=>{
    setSent(false);
    setError("");
    setParams({section:next});
  };

  const startNuma=()=>{
    window.dispatchEvent(new Event("palmyra:open-guide"));
  };

  const submitSupport=async(e:React.FormEvent)=>{
    e.preventDefault();
    setError("");
    setSent(false);
    if(form.subject.trim().length<3)return setError("Escribe un asunto breve para que podamos identificar tu solicitud.");
    if(form.message.trim().length<10)return setError("Describe el problema o la solicitud con un poco más de detalle.");
    if(!support.whatsapp_number)return setError("El canal de atención todavía no está configurado. El administrador debe definir el número de WhatsApp en PALMYRA Admin.");
    setSending(true);
    try{
      const saved=await createSupportRequest({
        requestType:form.requestType,
        subject:form.subject,
        message:form.message,
        contactPhone:form.contactPhone
      });
      const whatsappMessage=[
        "Hola PALMYRA, necesito atención.",
        "",
        "Empresa: "+companyName,
        "Tipo: "+form.requestType,
        "Asunto: "+form.subject.trim(),
        "Detalle: "+form.message.trim(),
        form.contactPhone.trim() ? "Teléfono: "+form.contactPhone.trim() : "",
        "Solicitud: "+saved.request_id,
        "",
        "Enviado desde el Centro de atención de PALMYRA."
      ].filter(Boolean).join("\n");
      const url=buildWhatsAppUrl(support.whatsapp_number,whatsappMessage);
      if(!url)throw new Error("El número de atención configurado no es válido.");
      setSent(true);
      setForm(prev=>({...prev,subject:"",message:""}));
      window.location.assign(url);
    }catch(e:any){
      setError(e?.message || "No se pudo enviar la solicitud.");
    }finally{
      setSending(false);
    }
  };

  return (
    <div data-palmi-content="help-center" className="help-center-page">
      <header className="help-center-hero">
        <div className="help-center-hero-copy">
          <div className="help-center-eyebrow"><Headphones className="w-3.5 h-3.5"/> PALMYRA CARE</div>
          <h1>Centro de atención</h1>
          <p>Aquí encuentras ayuda, tutoriales, seguridad y los canales oficiales de PALMYRA sin salir de tu empresa.</p>
          <div className="help-center-trust"><CheckCircle2 className="w-4 h-4"/><span>Ayuda contextual · Seguridad · Atención directa</span></div>
        </div>
        <div className="help-center-hero-art" aria-hidden="true">
          <div className="help-orbit orbit-one"/><div className="help-orbit orbit-two"/>
          <div className="help-hero-icon"><Headphones className="w-8 h-8"/></div>
          <span className="help-hero-dot dot-one"/><span className="help-hero-dot dot-two"/>
        </div>
      </header>

      <div className="help-center-nav">
        {sections.map(({id,label,icon:Icon,hint})=>(
          <button key={id} type="button" onClick={()=>changeSection(id)} className={section===id?"is-active":""}>
            <span className="help-center-nav-icon"><Icon className="w-4 h-4"/></span>
            <span className="min-w-0 text-left"><strong>{label}</strong><small>{hint}</small></span>
            <ChevronRight className="w-4 h-4 ml-auto opacity-50"/>
          </button>
        ))}
      </div>

      {loading ? <div className="help-center-loading">Preparando tu centro de atención…</div> : null}
      {error ? <div className="help-center-alert"><TriangleAlert className="w-4 h-4"/><span>{error}</span><button onClick={()=>setError("")} aria-label="Cerrar"><X className="w-4 h-4"/></button></div> : null}
      {sent ? <div className="help-center-success"><CheckCircle2 className="w-4 h-4"/><span>Solicitud registrada. Se abrirá el canal de atención configurado para continuar la conversación.</span></div> : null}

      {!loading && section==="overview" && (
        <section className="help-center-grid">
          <button type="button" className="help-feature-card help-feature-card--primary" onClick={()=>changeSection("tutorial")}>
            <span className="help-feature-icon"><BookOpen/></span><span className="help-feature-kicker">APRENDER</span><strong>Recorre PALMYRA paso a paso</strong><p>Aprende dónde está cada módulo, qué hace y qué debes revisar antes de operar.</p><span className="help-feature-cta">Ver tutorial <ArrowRight/></span>
          </button>
          <button type="button" className="help-feature-card" onClick={()=>changeSection("support")}>
            <span className="help-feature-icon"><TicketCheck/></span><span className="help-feature-kicker">SOPORTE</span><strong>Habla con atención al cliente</strong><p>Describe el problema o la solicitud y PALMYRA la registra antes de abrir el canal oficial.</p><span className="help-feature-cta">Crear solicitud <ArrowRight/></span>
          </button>
          <button type="button" className="help-feature-card" onClick={()=>changeSection("security")}>
            <span className="help-feature-icon"><ShieldCheck/></span><span className="help-feature-kicker">PROTECCIÓN</span><strong>Controla tus dispositivos</strong><p>Revisa las sesiones de tu cuenta y revoca dispositivos que ya no deban tener acceso.</p><span className="help-feature-cta">Ver seguridad <ArrowRight/></span>
          </button>
          <button type="button" className="help-feature-card" onClick={()=>changeSection("privacy")}>
            <span className="help-feature-icon"><FileText/></span><span className="help-feature-kicker">INFORMACIÓN</span><strong>Política y privacidad</strong><p>Consulta cómo se trata la información de tu empresa y cuáles son las reglas de uso del servicio.</p><span className="help-feature-cta">Leer política <ArrowRight/></span>
          </button>
          <section className="help-center-tip">
            <div className="help-center-tip-icon"><Sparkles/></div><div><strong>Consejo PALMYRA</strong><p>Primero aprende el camino. Después usa cada módulo con la seguridad de saber dónde está la información que necesitas.</p></div>
          </section>
        </section>
      )}

      {!loading && section==="tutorial" && (
        <section className="help-center-section">
          <div className="help-section-head"><div><span className="help-section-kicker">TUTORIAL OPERATIVO</span><h2>Aprende haciendo</h2><p>Este tutorial es informativo. Para el recorrido guiado interactivo, puedes abrir Numa y completar cada paso tú mismo.</p></div><button type="button" className="help-primary-btn" onClick={startNuma}><PlayCircle className="w-4 h-4"/> Abrir Numa</button></div>
          <div className="help-tutorial-list">
            {tutorialSteps.map((step,index)=>(
              <article key={step.id} className="help-tutorial-card">
                <div className="help-step-number">{String(index+1).padStart(2,"0")}</div>
                <div className="help-tutorial-card-body"><span>{step.eyebrow}</span><h3>{step.title}</h3><p>{step.message}</p>{step.tip&&<div className="help-tutorial-tip"><Sparkles className="w-3.5 h-3.5"/>{step.tip}</div>}</div>
              </article>
            ))}
          </div>
          <div className="help-install-note"><Smartphone className="w-5 h-5"/><div><strong>Después del tutorial</strong><p>Al terminar el recorrido guiado, PALMYRA puede ofrecer la instalación como aplicación PWA para tener acceso más rápido desde el teléfono.</p></div></div>
        </section>
      )}

      {!loading && section==="support" && (
        <section className="help-center-support">
          <div className="help-support-copy"><span className="help-section-kicker">ATENCIÓN AL CLIENTE</span><h2>Cuéntanos qué necesitas</h2><p>La solicitud queda registrada con tu empresa y se prepara un mensaje con el contexto necesario para que el equipo de PALMYRA pueda ayudarte más rápido.</p>
            <div className="help-contact-card"><MessageCircle/><div><strong>Canal oficial</strong><span>{support.whatsapp_number ? "WhatsApp configurado en PALMYRA Admin" : "Pendiente de configuración administrativa"}</span>{support.support_email&&<small>{support.support_email}</small>}</div></div>
          </div>
          <form className="help-support-form" onSubmit={submitSupport}>
            <label><span>Nombre de la empresa</span><div className="help-readonly"><BuildingIcon/><input value={companyName} readOnly/></div></label>
            <label><span>Tipo de solicitud</span><select value={form.requestType} onChange={e=>setForm({...form,requestType:e.target.value})}>{requestTypes.map(type=><option key={type}>{type}</option>)}</select></label>
            <label><span>Asunto</span><input value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})} placeholder="Ej. La venta no se registra offline"/></label>
            <label><span>Detalle</span><textarea value={form.message} onChange={e=>setForm({...form,message:e.target.value})} rows={6} placeholder="Describe lo que ocurrió, cuándo ocurrió y qué esperabas que pasara." /></label>
            <label><span>Teléfono para contacto (opcional)</span><div className="help-input-with-icon"><Smartphone/><input value={form.contactPhone} onChange={e=>setForm({...form,contactPhone:e.target.value})} placeholder="+53 …"/></div></label>
            <div className="help-support-footer"><small><ShieldCheck/> La solicitud se registra con tu empresa para mantener trazabilidad.</small><button className="help-primary-btn" disabled={sending}>{sending?<><Send className="w-4 h-4 animate-pulse"/> Enviando…</>:<><Send className="w-4 h-4"/> Enviar a atención</>}</button></div>
          </form>
        </section>
      )}

      {!loading && section==="security" && <section className="help-security-embedded"><Security/></section>}

      {!loading && section==="privacy" && (
        <section className="help-center-section help-policy">
          <div className="help-section-head"><div><span className="help-section-kicker">POLÍTICA Y PRIVACIDAD</span><h2>Información y confianza</h2><p>Usa esta sección como referencia dentro de la empresa. La URL oficial configurada por PALMYRA Admin tendrá prioridad cuando exista.</p></div></div>
          <article className="help-policy-card"><h3>Protección de la cuenta</h3><p>Las credenciales del propietario y de los trabajadores son independientes. Los permisos se asignan por rol y el acceso a almacenes se controla por empresa.</p></article>
          <article className="help-policy-card"><h3>Datos operativos</h3><p>PALMYRA utiliza información de ventas, inventario, caja, equipo y configuración para prestar el servicio. El acceso se limita según el usuario y sus permisos.</p></article>
          <article className="help-policy-card"><h3>Seguridad y sesiones</h3><p>Las sesiones y dispositivos se registran para permitir al usuario revisar y revocar accesos cuando sea necesario.</p></article>
          {support.privacy_url ? <a className="help-policy-link" href={support.privacy_url} target="_blank" rel="noreferrer"><FileText/> Abrir política oficial <ArrowRight/></a> : null}
        </section>
      )}
    </div>
  );
}

function BuildingIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 20h16v2H4zM6 18V5.5a1 1 0 0 1 .6-.9l4.8-2.1a1 1 0 0 1 .8 0L17 4.6a1 1 0 0 1 .6.9V18h-2V6.2l-4-1.7-3.6 1.6V18H6Zm3-8h2v2H9v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2H9v-2Zm4 0h2v2h-2v-2Z"/></svg>}
