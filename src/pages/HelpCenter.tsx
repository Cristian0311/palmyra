import React, { useEffect, useState } from "react";
import {
  ArrowRight, CheckCircle2, ChevronRight, FileText, Headphones,
  LockKeyhole, MessageCircle, Send, ShieldCheck, Smartphone, Sparkles,
  TicketCheck, TriangleAlert, X, BookOpen
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useStore } from "../store/useStore";
import { loadSaaSContext } from "../services/saas";
import { buildWhatsAppUrl, createSupportRequest, loadPlatformSupportSettings, type PlatformSupportSettings } from "../services/platformSupport";
import Security from "./Security";
import "./helpCenter.css";

type CenterSection = "overview" | "tutorial" | "support" | "security" | "privacy";

const sections: Array<{id: CenterSection; label: string; icon: typeof Headphones; hint: string}> = [
  { id:"overview", label:"Inicio", icon:Headphones, hint:"Ayuda y recursos para trabajar con PALMYRA" },
  { id:"tutorial", label:"Tutorial", icon:BookOpen, hint:"Guías simples para las funciones nuevas" },
  { id:"support", label:"Atención al cliente", icon:MessageCircle, hint:"Envía una solicitud al equipo PALMYRA" },
  { id:"security", label:"Seguridad", icon:ShieldCheck, hint:"Dispositivos y sesiones de tu cuenta" },
  { id:"privacy", label:"Política y privacidad", icon:LockKeyhole, hint:"Cómo protegemos y usamos la información" }
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
  const [params,setParams] = useSearchParams();
  const currentUser = useStore(s=>s.currentUser);
  const fallbackCompanyName = useStore(s=>s.storeConfig.storeName || "Mi empresa");
  const [companyName,setCompanyName] = useState(fallbackCompanyName);
  const [support,setSupport] = useState<PlatformSupportSettings>({
    whatsapp_number:null,
    support_email:null,
    privacy_url:null,
    facebook_url:null,
    whatsapp_channel_url:null
  });
  const [loading,setLoading] = useState(true);
  const [sending,setSending] = useState(false);
  const [sent,setSent] = useState(false);
  const [error,setError] = useState("");
  const [form,setForm] = useState({requestType:"Error detectado",subject:"",message:"",contactPhone:""});
  const section = (params.get("section") as CenterSection) || "overview";

  useEffect(()=>{
    let active = true;
    setCompanyName(fallbackCompanyName);
    void loadSaaSContext(true)
      .then(ctx=>{
        if(active && ctx?.company?.name) setCompanyName(ctx.company.name);
      })
      .catch(()=>{})
      .finally(()=>{
        if(active) setLoading(false);
      });
    return ()=>{active=false};
  },[currentUser?.id,fallbackCompanyName]);

  useEffect(()=>{
    let active=true;
    void loadPlatformSupportSettings()
      .then(value=>{if(active)setSupport(value)})
      .catch(()=>{if(active)setError("No se pudo cargar el canal de atención.")});
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
    <div className="help-center-page">
      <header className="help-center-hero">
        <div className="help-center-hero-copy">
          <div className="help-center-eyebrow"><Headphones className="w-3.5 h-3.5"/> PALMYRA CARE</div>
          <h1>Centro de atención</h1>
          <p>Soporte, seguridad, política y canales oficiales de PALMYRA, reunidos en un solo lugar para que tu equipo pueda continuar trabajando.</p>
          <div className="help-center-trust"><CheckCircle2 className="w-4 h-4"/><span>Soporte directo · Seguridad · Atención oficial</span></div>
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
          <button type="button" className="help-feature-card help-feature-card--primary" onClick={()=>changeSection("support")}>
            <span className="help-feature-icon"><TicketCheck/></span><span className="help-feature-kicker">ATENCIÓN</span><strong>Habla con atención al cliente</strong><p>Describe el problema o la solicitud y PALMYRA la registra antes de abrir el canal oficial.</p><span className="help-feature-cta">Crear solicitud <ArrowRight/></span>
          </button>
          <button type="button" className="help-feature-card" onClick={()=>changeSection("tutorial")}>
            <span className="help-feature-icon"><BookOpen/></span><span className="help-feature-kicker">TUTORIAL</span><strong>Aprende PALMYRA paso a paso</strong><p>POS, inventario, equipo, trabajo offline, caja, reportes e impresoras explicados sin lenguaje técnico.</p><span className="help-feature-cta">Abrir tutorial <ArrowRight/></span>
          </button>
          <button type="button" className="help-feature-card" onClick={()=>changeSection("security")}>
            <span className="help-feature-icon"><ShieldCheck/></span><span className="help-feature-kicker">PROTECCIÓN</span><strong>Controla tus dispositivos</strong><p>Revisa las sesiones de tu cuenta y revoca dispositivos que ya no deban tener acceso.</p><span className="help-feature-cta">Ver seguridad <ArrowRight/></span>
          </button>
          <button type="button" className="help-feature-card" onClick={()=>changeSection("privacy")}>
            <span className="help-feature-icon"><FileText/></span><span className="help-feature-kicker">INFORMACIÓN</span><strong>Política y privacidad</strong><p>Consulta cómo se trata la información de tu empresa y cuáles son las reglas de uso del servicio.</p><span className="help-feature-cta">Leer política <ArrowRight/></span>
          </button>
          <section className="help-center-tip">
            <div className="help-center-tip-icon"><Sparkles/></div><div><strong>PALMYRA</strong><p>Tu Centro de atención conserva la empresa registrada en tu cuenta y mantiene la trazabilidad de cada solicitud.</p></div>
          </section>
          {(support.facebook_url || support.whatsapp_channel_url) && (
            <section className="help-social-card" aria-label="Canales oficiales de PALMYRA">
              <div>
                <span className="help-section-kicker">CANALES OFICIALES</span>
                <h3>Únete a la comunidad PALMYRA</h3>
                <p>Sigue nuestra página de Facebook y únete al canal oficial de WhatsApp para recibir novedades, avisos y recursos.</p>
              </div>
              <div className="help-social-links">
                {support.facebook_url && <a href={support.facebook_url} target="_blank" rel="noopener noreferrer" className="help-social-link"><FacebookMark/><span><strong>Facebook</strong><small>Seguir página</small></span><ArrowRight/></a>}
                {support.whatsapp_channel_url && <a href={support.whatsapp_channel_url} target="_blank" rel="noopener noreferrer" className="help-social-link"><WhatsAppMark/><span><strong>WhatsApp</strong><small>Unirse al canal</small></span><ArrowRight/></a>}
              </div>
            </section>
          )}
        </section>
      )}

      {!loading && section==="tutorial" && (
        <section className="help-center-grid">
          {[
            ["POS y caja","Abre el turno, selecciona vendedor, cobra en efectivo o transferencia y utiliza Venta de turno para revisar Tickets, Productos y Egreso y gasto."],
            ["Egresos, gastos e ingresos","Registra cada movimiento desde Cerrar caja. Cada movimiento conserva su comprobante independiente y no se mezcla con los productos vendidos."],
            ["Inventario y variantes","Crea productos, define tallas/colores y consulta el stock. PALMYRA identifica los productos que tienen variantes."],
            ["Equipo e invitaciones","Crea empleados, asigna permisos e invita por correo. El enlace de Gmail lleva al usuario a la empresa invitada, no a una empresa nueva."],
            ["Trabajo sin conexión","PALMYRA conserva el contexto de empresa, operaciones y cola local para continuar trabajando sin Internet y sincronizar cuando vuelva la conexión."],
            ["Impresora térmica","Vincula Bluetooth o cable USB/Serie y activa Siempre conectar. PALMYRA intentará reconectar una impresora autorizada cuando el navegador lo permita."],
            ["Reportes","Consulta ventas por turno, productos, movimientos de caja, descuadres y comprobantes desde las secciones correspondientes."],
            ["Planes","Las funciones premium muestran el plan necesario. Al vencer un período existe un período de gracia de 2 días; después PALMYRA pasa a modo lectura."]
          ].map(([title,description])=>(
            <article key={title} className="help-feature-card">
              <span className="help-feature-icon"><BookOpen/></span>
              <span className="help-feature-kicker">GUÍA PALMYRA</span>
              <strong>{title}</strong>
              <p>{description}</p>
            </article>
          ))}
        </section>
      )}

      {!loading && section==="support" && (
        <section className="help-center-support">
          <div className="help-support-copy"><span className="help-section-kicker">ATENCIÓN AL CLIENTE</span><h2>Cuéntanos qué necesitas</h2><p>La solicitud queda registrada con tu empresa y se prepara un mensaje con el contexto necesario para que el equipo de PALMYRA pueda ayudarte más rápido.</p>
            <div className="help-contact-card"><MessageCircle/><div><strong>Canal oficial</strong><span>{support.whatsapp_number ? "WhatsApp configurado en PALMYRA Admin" : "Pendiente de configuración administrativa"}</span>{support.support_email&&<small>{support.support_email}</small>}</div></div>
            {(support.facebook_url || support.whatsapp_channel_url) && (
              <div className="help-social-links help-social-links--compact">
                {support.facebook_url && <a href={support.facebook_url} target="_blank" rel="noopener noreferrer" className="help-social-link"><FacebookMark/><span><strong>Facebook</strong><small>Seguir página</small></span></a>}
                {support.whatsapp_channel_url && <a href={support.whatsapp_channel_url} target="_blank" rel="noopener noreferrer" className="help-social-link"><WhatsAppMark/><span><strong>WhatsApp</strong><small>Unirse al canal</small></span></a>}
              </div>
            )}
          </div>
          <form className="help-support-form" onSubmit={submitSupport}>
            <label><span>Nombre de la empresa</span><div className="help-readonly"><BuildingIcon/><input value={companyName} readOnly aria-describedby="registered-company-help"/></div><small id="registered-company-help" className="help-form-hint">Nombre real registrado en tu cuenta PALMYRA.</small></label>
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
          <article className="help-policy-card"><h3>Protección de la cuenta</h3><p>El propietario y los trabajadores usan credenciales independientes. Los permisos se asignan por rol y el acceso a almacenes se controla dentro de la empresa.</p></article>
          <article className="help-policy-card"><h3>Datos operativos</h3><p>PALMYRA utiliza información de ventas, inventario, caja, equipo y configuración para prestar el servicio. El acceso se limita según el usuario y sus permisos.</p></article>
          <article className="help-policy-card"><h3>Seguridad y sesiones</h3><p>Las sesiones y dispositivos se registran para permitir al usuario revisar y revocar accesos cuando sea necesario.</p></article>
          {support.privacy_url ? <a className="help-policy-link" href={support.privacy_url} target="_blank" rel="noreferrer"><FileText/> Abrir política oficial <ArrowRight/></a> : null}
        </section>
      )}
    </div>
  );
}

function BuildingIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 20h16v2H4zM6 18V5.5a1 1 0 0 1 .6-.9l4.8-2.1a1 1 0 0 1 .8 0L17 4.6a1 1 0 0 1 .6.9V18h-2V6.2l-4-1.7-3.6 1.6V18H6Zm3-8h2v2H9v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2H9v-2Zm4 0h2v2h-2v-2Z"/></svg>}

function FacebookMark({className=""}:{className?:string}){
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={className}><path fill="currentColor" d="M13.7 21v-7h2.4l.4-2.8h-2.8V9.4c0-.8.2-1.4 1.5-1.4h1.6V5.5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.4-3.7 3.8v2H8.5V14H11v7h2.7Z"/></svg>;
}

function WhatsAppMark({className=""}:{className?:string}){
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={className}><path fill="currentColor" d="M12 3.1a8.8 8.8 0 0 0-7.6 13.3L3.1 21l4.8-1.2A8.9 8.9 0 1 0 12 3.1Zm0 1.8a7.1 7.1 0 0 1 6.1 10.8 7 7 0 0 1-8.1 3.1l-.5-.2-2.8.7.8-2.7-.3-.5A7.1 7.1 0 0 1 12 4.9Zm-3.2 2.9c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2 0 1.2.8 2.3.9 2.5.1.2 1.7 2.8 4.3 3.8 2.1.8 2.5.6 2.9.6.4 0 1.3-.5 1.5-1 .2-.5.2-.9.1-1-.1-.1-.3-.2-.7-.4l-.9-.4c-.4-.1-.6-.2-.8.2-.2.3-.6.8-.7 1-.1.2-.3.2-.6.1-.3-.1-1.1-.4-2-1.2-.7-.6-1.2-1.4-1.3-1.6-.1-.2 0-.3.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.7-1.6c-.2-.4-.5-.5-.8-.5Z"/></svg>;
}
