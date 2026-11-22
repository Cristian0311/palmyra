import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Copy, FileText,
  Headphones, HelpCircle, LockKeyhole, Mail, MessageCircle, Search, Send,
  ShieldCheck, Smartphone, Sparkles, TicketCheck, TriangleAlert, Wifi, WifiOff, X
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useStore } from "../store/useStore";
import { loadSaaSContext } from "../services/saas";
import { buildWhatsAppUrl, createSupportRequest, loadPlatformSupportSettings, type PlatformSupportSettings } from "../services/platformSupport";
import { getOfflineQueueCount } from "../services/offlineQueue";
import Security from "./Security";
import { PRODUCT_VERSION } from "../lib/productVersion";
import "./helpCenter.css";

type CenterSection = "overview" | "tutorial" | "support" | "security" | "privacy";

const sections: Array<{id: CenterSection; label: string; icon: typeof Headphones; hint: string}> = [
  { id:"overview", label:"Ayuda", icon:Headphones, hint:"Preguntas y contactos" },
  { id:"tutorial", label:"Tutorial", icon:BookOpen, hint:"Aprende paso a paso" },
  { id:"support", label:"Atención al cliente", icon:MessageCircle, hint:"Habla con el equipo" },
  { id:"security", label:"Seguridad", icon:ShieldCheck, hint:"Dispositivos y sesiones" },
  { id:"privacy", label:"Privacidad", icon:LockKeyhole, hint:"Política de uso" }
];

const requestTypes = [
  "Error detectado",
  "Problema de acceso",
  "Ayuda con una función",
  "Consulta de facturación",
  "Solicitud de mejora",
  "Otro"
];

const faqs: Array<{ question: string; answer: string; tag: string; to?: string }> = [
  { tag:"Sin conexión", question:"No tengo internet. ¿Puedo seguir vendiendo?", answer:"Sí. PALMYRA guarda cada venta, traslado o cierre en este dispositivo y lo envía cuando vuelve la conexión. La barra superior muestra cuántas operaciones quedan pendientes; no cierres la aplicación ni borres los datos del navegador mientras haya pendientes." },
  { tag:"Caja", question:"El turno de caja no me deja cerrar", answer:"Revisa que el arqueo esté completo y que cada diferencia tenga su explicación. El cierre compara el efectivo contado con el esperado; si falta o sobra dinero debes justificarlo antes de confirmar." },
  { tag:"Ventas", question:"Eliminé una venta por error", answer:"Las ventas no se borran sin rastro: al confirmar la eliminación se devuelve el stock al almacén de la venta, se revierte el cobro en banco y queda registrado el motivo y el usuario. Puedes comprobarlo en Reportes → Ventas.", to:"/reports" },
  { tag:"Inventario", question:"El stock no coincide con lo que tengo", answer:"No edites cantidades a mano. Crea una auditoría de inventario en la sección Auditoría del menú, registra la diferencia con su motivo y el sistema ajusta el almacén correcto dejando historial." },
  { tag:"Impresora", question:"La impresora no imprime el ticket", answer:"Verifica que esté encendida, con papel del ancho configurado (58 mm u 80 mm) y conectada al mismo equipo. En Configuración → Impresora y comprobantes puedes imprimir una prueba y revisar la impresora predeterminada." },
  { tag:"Equipo", question:"¿Cómo agrego un trabajador?", answer:"Entra en Equipo → Invitar trabajador. El trabajador crea su propio acceso y recibe permisos por rol. Nunca compartas la contraseña del propietario; cada venta debe quedar asociada a quien la realizó." },
  { tag:"Acceso", question:"No puedo iniciar sesión", answer:"Comprueba el correo y la contraseña, que tu usuario esté activo y que la conexión funcione. Si el problema continúa, crea una solicitud de «Problema de acceso»: el diagnóstico se adjunta automáticamente." },
  { tag:"Tasas", question:"¿Cómo cambio la tasa de cambio de mi negocio?", answer:"En Configuración → Monedas y tasas defines la tasa con la que vendes. La referencia de elTOQUE que muestra PALMYRA es informativa y no modifica tus precios automáticamente.", to:"/settings" },
  { tag:"Plan", question:"¿Qué incluye el plan Gratis y vence?", answer:"El plan Gratis es permanente: 1 almacén, 1 empleado más el propietario y 25 tipos de productos. Incluye modo offline y respaldo comercial en la nube, igual que los planes de pago; no se vence ni pasa a modo lectura." },
  { tag:"Plan", question:"¿Cómo se paga un plan?", answer:"En Cuba se paga en CUP en efectivo o por transferencia bancaria, o en USD en efectivo. Cada pago se confirma manualmente y el plan se activa o renueva por el periodo elegido.", to:"/subscription" },
  { tag:"Bancos", question:"¿Cómo registro un cobro o pago bancario?", answer:"En Bancos registra ingresos y egresos con su moneda y comprobante. Puedes filtrar por turno y conciliar el efectivo esperado de la caja con lo que realmente entró al banco.", to:"/banks" },
  { tag:"Compras", question:"¿Cómo recibo mercancía de un proveedor?", answer:"En Proveedores crea la orden de compra y, cuando llegue la mercancía, recíbela desde el mismo panel: el stock se suma al almacén indicado y la orden queda marcada como recibida.", to:"/suppliers" },
  { tag:"Transferencias", question:"¿Cómo muevo stock entre almacenes?", answer:"En Transferencias crea un traslado con origen y destino; queda en tránsito hasta que el almacén destino lo reciba. También puedes enviar varias órdenes a la vez y cancelar un traslado antes de recibirlo.", to:"/transfers" },
  { tag:"Cotizaciones", question:"¿Cómo convierto una cotización en venta?", answer:"En Cotizaciones toca «Cobrar en POS»: los productos pasan al ticket con el cliente. Si eliminas la cotización antes de cobrar, el POS vacía el ticket al abrirse.", to:"/quotes" },
  { tag:"Descargas", question:"¿Cómo instalo PALMYRA en la PC o en el Android?", answer:"En la página de descargas encuentras el instalador de Windows y el APK de Android. Para las estaciones de la red local, Configuración → Red local genera un QR con la dirección del equipo principal.", to:"/landing" },
  { tag:"Reportes", question:"¿Dónde veo las ventas de cada turno?", answer:"En Reportes → Ventas encuentras las operaciones por fecha, turno y cajero. Desde la misma tabla puedes ver el detalle, ocultar la fila en tu vista o anular la venta con motivo.", to:"/reports" },
  { tag:"Seguridad", question:"¿Cómo cierro la sesión en otro dispositivo?", answer:"En Seguridad verás los dispositivos con acceso. Revoca cualquier sesión que no reconozcas y cambia la contraseña si sospechas que alguien más la conoce.", to:"/help-center?section=security" }
];

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

export default function HelpCenter(){
  const [params,setParams] = useSearchParams();
  const currentUser = useStore(s=>s.currentUser);
  const fallbackCompanyName = useStore(s=>s.storeConfig.storeName || "Mi empresa");
  const [companyName,setCompanyName] = useState(fallbackCompanyName);
  const [support,setSupport] = useState<PlatformSupportSettings>({
    whatsapp_number:null, support_email:null, privacy_url:null, facebook_url:null, whatsapp_channel_url:null
  });
  const [settingsLoaded,setSettingsLoaded] = useState(false);
  const [loading,setLoading] = useState(true);
  const [sending,setSending] = useState(false);
  const [sent,setSent] = useState("");
  const [error,setError] = useState("");
  const [query,setQuery] = useState("");
  const [copied,setCopied] = useState(false);
  const [form,setForm] = useState({requestType:"Error detectado",subject:"",message:"",contactPhone:""});
  const section = (params.get("section") as CenterSection) || "overview";
  const online = useOnline();
  const pending = getOfflineQueueCount();
  const version = PRODUCT_VERSION;

  useEffect(()=>{
    let active = true;
    setCompanyName(fallbackCompanyName);
    void loadSaaSContext(true)
      .then(ctx=>{ if(active && ctx?.company?.name) setCompanyName(ctx.company.name); })
      .catch(()=>{})
      .finally(()=>{ if(active) setLoading(false); });
    return ()=>{active=false};
  },[currentUser?.id,fallbackCompanyName]);

  useEffect(()=>{
    let active=true;
    void loadPlatformSupportSettings()
      .then(value=>{if(active)setSupport(value)})
      .catch(()=>{})
      .finally(()=>{if(active)setSettingsLoaded(true)});
    return()=>{active=false};
  },[]);

  useEffect(()=>{
    document.title = section==="overview" ? "Ayuda · PALMYRA" : `${sections.find(s=>s.id===section)?.label || "Ayuda"} · PALMYRA`;
  },[section]);

  const diagnosis = `Empresa: ${companyName}\nVersión: ${version}\nConexión: ${online ? "En línea" : "Sin conexión"}\nOperaciones pendientes: ${pending}`;
  const whatsappUrl = support.whatsapp_number
    ? buildWhatsAppUrl(support.whatsapp_number, `Hola PALMYRA, necesito ayuda.\n\n${diagnosis}`)
    : null;
  const emailUrl = support.support_email
    ? `mailto:${support.support_email}?subject=${encodeURIComponent(`Ayuda PALMYRA · ${companyName}`)}&body=${encodeURIComponent(`Hola PALMYRA, necesito ayuda.\n\n${diagnosis}\n\nDetalle:\n`)}`
    : null;

  const filteredFaqs = useMemo(()=>{
    const needle = query.trim().toLowerCase();
    if(!needle) return faqs;
    return faqs.filter(item => `${item.question} ${item.answer} ${item.tag}`.toLowerCase().includes(needle));
  },[query]);

  const changeSection=(next:CenterSection)=>{
    setSent("");
    setError("");
    setParams({section:next});
  };

  const copyDiagnosis=async()=>{
    try {
      await navigator.clipboard.writeText(diagnosis);
      setCopied(true);
      window.setTimeout(()=>setCopied(false), 2200);
    } catch {
      setError("No se pudo copiar el diagnóstico en este dispositivo.");
    }
  };

  const submitSupport=async(e:React.FormEvent)=>{
    e.preventDefault();
    setError("");
    setSent("");
    if(form.subject.trim().length<3)return setError("Escribe un asunto breve para que podamos identificar tu solicitud.");
    if(form.message.trim().length<10)return setError("Describe el problema o la solicitud con un poco más de detalle.");
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
        diagnosis,
        "",
        "Enviado desde el Centro de atención de PALMYRA."
      ].filter(Boolean).join("\n");
      const url=whatsappUrl ? buildWhatsAppUrl(support.whatsapp_number!, whatsappMessage) : null;
      setForm(prev=>({...prev,subject:"",message:""}));
      if(url){
        setSent("Solicitud "+saved.request_id+" registrada. Abriendo WhatsApp para continuar la conversación…");
        window.location.assign(url);
      } else {
        setSent("Solicitud "+saved.request_id+" registrada. El equipo la recibirá aunque el canal de WhatsApp todavía no esté configurado; puedes usar el correo de soporte mientras tanto.");
      }
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
          <h1>¿En qué te ayudamos?</h1>
          <p>Respuestas directas, guías y contacto con el equipo PALMYRA. Sin buscar entre documentos: elige un canal o escribe tu caso y el diagnóstico del dispositivo se adjunta solo.</p>
          <div className="help-center-meta">
            <span className={'is-'+(online?"online":"offline")}>{online?<Wifi/>:<WifiOff/>}{online?"En línea":"Sin conexión"}</span>
            <span>V {version}</span>
            <span>{pending>0?`${pending} operación${pending===1?"":"es"} pendiente${pending===1?"":"s"}`:"Todo sincronizado"}</span>
          </div>
        </div>
        <div className="help-center-hero-art" aria-hidden="true">
          <div className="help-orbit orbit-one"/><div className="help-orbit orbit-two"/>
          <div className="help-hero-icon"><Headphones className="w-8 h-8"/></div>
          <span className="help-hero-dot dot-one"/><span className="help-hero-dot dot-two"/>
        </div>
      </header>

      <section className="help-contact-actions" aria-label="Contacto directo">
        {whatsappUrl ? (
          <a className="help-contact-action help-contact-action--primary" href={whatsappUrl} target="_blank" rel="noopener noreferrer">
            <span className="help-contact-action-icon"><WhatsAppMark/></span>
            <span className="help-contact-action-copy"><strong>Escribir por WhatsApp</strong><small>Atención directa con tu empresa y versión incluidas</small></span>
            <ArrowRight className="help-contact-action-arrow"/>
          </a>
        ) : (
          <button type="button" className="help-contact-action help-contact-action--primary" onClick={()=>changeSection("support")}>
            <span className="help-contact-action-icon"><TicketCheck/></span>
            <span className="help-contact-action-copy"><strong>Crear solicitud</strong><small>WhatsApp aún sin configurar · usa el formulario</small></span>
            <ArrowRight className="help-contact-action-arrow"/>
          </button>
        )}
        {emailUrl ? (
          <a className="help-contact-action" href={emailUrl}>
            <span className="help-contact-action-icon"><Mail/></span>
            <span className="help-contact-action-copy"><strong>Enviar un correo</strong><small>{support.support_email}</small></span>
            <ArrowRight className="help-contact-action-arrow"/>
          </a>
        ) : (
          <button type="button" className="help-contact-action" onClick={()=>changeSection("support")}>
            <span className="help-contact-action-icon"><Mail/></span>
            <span className="help-contact-action-copy"><strong>Enviar un correo</strong><small>El correo de soporte aún no está publicado</small></span>
            <ArrowRight className="help-contact-action-arrow"/>
          </button>
        )}
        <button type="button" className="help-contact-action" onClick={()=>changeSection("support")} disabled={!settingsLoaded && !support.whatsapp_number && !support.support_email}>
          <span className="help-contact-action-icon"><TicketCheck/></span>
          <span className="help-contact-action-copy"><strong>Detallar mi caso</strong><small>Formulario con diagnóstico automático</small></span>
          <ArrowRight className="help-contact-action-arrow"/>
        </button>
      </section>

      <nav className="help-center-nav" aria-label="Secciones de ayuda">
        {sections.map(({id,label,icon:Icon,hint})=>(
          <button key={id} type="button" onClick={()=>changeSection(id)} className={section===id?"is-active":""} aria-current={section===id?"page":undefined}>
            <span className="help-center-nav-icon"><Icon className="w-4 h-4"/></span>
            <span className="min-w-0 text-left"><strong>{label}</strong><small>{hint}</small></span>
            <ChevronRight className="w-4 h-4 ml-auto opacity-50"/>
          </button>
        ))}
      </nav>

      {loading ? <div className="help-center-loading">Preparando tu centro de atención…</div> : null}
      {error ? <div className="help-center-alert" role="alert"><TriangleAlert className="w-4 h-4"/><span>{error}</span><button onClick={()=>setError("")} aria-label="Cerrar"><X className="w-4 h-4"/></button></div> : null}
      {sent ? <div className="help-center-success" role="status"><CheckCircle2 className="w-4 h-4"/><span>{sent}</span></div> : null}

      {!loading && section==="overview" && (
        <section className="help-overview">
          <div className="help-faq">
            <header className="help-faq-head">
              <div>
                <span className="help-section-kicker">RESPUESTAS RÁPIDAS</span>
                <h2>Preguntas frecuentes</h2>
                <p>Busca por palabra: caja, stock, impresora, venta, acceso…</p>
              </div>
              <label className="help-faq-search">
                <Search aria-hidden="true"/>
                <span className="sr-only">Buscar en preguntas frecuentes</span>
                <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar solución…" type="search"/>
                {query && <button type="button" onClick={()=>setQuery("")} aria-label="Borrar búsqueda"><X/></button>}
              </label>
            </header>
            <div className="help-faq-list">
              {filteredFaqs.map(item=>(
                <details key={item.question} className="help-faq-item">
                  <summary><span className="help-faq-tag">{item.tag}</span><span className="help-faq-question">{item.question}</span><ChevronDown className="help-faq-chevron" aria-hidden="true"/></summary>
                  <div className="help-faq-answer">
                    <p>{item.answer}</p>
                    {item.to && <Link to={item.to}>Abrir la sección relacionada <ArrowRight/></Link>}
                  </div>
                </details>
              ))}
              {!filteredFaqs.length && (
                <div className="help-faq-empty">
                  <HelpCircle aria-hidden="true"/>
                  <p>No encontramos una respuesta para «{query}». Crea una solicitud y el equipo te responde con el diagnóstico del dispositivo.</p>
                  <button type="button" onClick={()=>changeSection("support")}>Crear solicitud</button>
                </div>
              )}
            </div>
          </div>

          <div className="help-resources">
            <button type="button" className="help-resource-card is-primary" onClick={()=>changeSection("tutorial")}>
              <span className="help-resource-icon"><BookOpen/></span>
              <strong>Aprende PALMYRA paso a paso</strong>
              <p>24 lecciones con pantallas: POS, caja, inventario, auditoría, proveedores, tasa de cambio, equipo, reportes y trabajo sin conexión.</p>
              <span className="help-resource-cta">Abrir tutorial <ArrowRight/></span>
            </button>
            <button type="button" className="help-resource-card" onClick={()=>changeSection("security")}>
              <span className="help-resource-icon"><ShieldCheck/></span>
              <strong>Dispositivos y sesiones</strong>
              <p>Revisa quién tiene acceso y revoca dispositivos que ya no deban entrar.</p>
              <span className="help-resource-cta">Ver seguridad <ArrowRight/></span>
            </button>
            <button type="button" className="help-resource-card" onClick={()=>changeSection("privacy")}>
              <span className="help-resource-icon"><FileText/></span>
              <strong>Política y privacidad</strong>
              <p>Cómo protegemos la información de tu empresa y las reglas del servicio.</p>
              <span className="help-resource-cta">Leer política <ArrowRight/></span>
            </button>
          </div>

          {(support.facebook_url || support.whatsapp_channel_url) && (
            <section className="help-social-card" aria-label="Canales oficiales de PALMYRA">
              <div>
                <span className="help-section-kicker">CANALES OFICIALES</span>
                <h3>Comunidad PALMYRA</h3>
                <p>Novedades, avisos y recursos. La atención de casos va por WhatsApp o correo.</p>
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
          <article className="help-feature-card help-feature-card--primary">
            <span className="help-feature-icon"><BookOpen/></span>
            <span className="help-feature-kicker">ESCUELA PALMYRA</span>
            <strong>Aprende el sistema paso a paso</strong>
            <p>24 lecciones con pantallas ilustradas, funciones marcadas y puntos numerados que conectan cada paso. Incluye apertura y cierre de turno, POS, inventario, auditoría, transferencias, proveedores, cotizaciones, devoluciones, bancos, tasa de cambio, reportes, equipo, soporte, descargas LAN, offline y planes.</p>
            <Link className="help-feature-cta" to="/tutorial">Entrar a la escuela <ArrowRight/></Link>
          </article>
          {[
            { title:"Quiero vender", description:"Abre el turno, cobra, imprime el ticket y cierra la caja con el arqueo correcto.", lesson:"pos-apertura" },
            { title:"Quiero controlar inventario", description:"Productos, variantes, transferencias, auditoría, compras y stock por almacén.", lesson:"inventario" },
            { title:"Quiero administrar", description:"Configuración, equipo y permisos, reportes, cierre desde Reportes y plan contratado.", lesson:"inicio" }
          ].map(item=>(
            <article key={item.title} className="help-feature-card">
              <span className="help-feature-icon"><BookOpen/></span>
              <span className="help-feature-kicker">RUTA POR ROL</span>
              <strong>{item.title}</strong>
              <p>{item.description}</p>
              <Link className="help-feature-cta" to={`/tutorial?lesson=${item.lesson}`}>Empezar esta ruta <ArrowRight/></Link>
            </article>
          ))}
          <section className="help-center-tip">
            <div className="help-center-tip-icon"><Sparkles/></div>
            <div><strong>Tu progreso se guarda</strong><p>La escuela recuerda las lecciones completadas en este dispositivo. Puedes buscar por palabra y volver donde te quedaste.</p></div>
          </section>
        </section>
      )}

      {!loading && section==="support" && (
        <section className="help-support">
          <aside className="help-support-side">
            <span className="help-section-kicker">ATENCIÓN AL CLIENTE</span>
            <h2>Cuéntanos qué necesitas</h2>
            <p>La solicitud queda registrada con tu empresa y el diagnóstico del dispositivo se adjunta automáticamente. Así el equipo no tiene que preguntarte la versión ni el estado de la conexión.</p>
            <div className="help-support-context">
              <div className="help-support-context-head"><MonitorIcon/><strong>Contexto que se adjuntará</strong><button type="button" onClick={()=>void copyDiagnosis()} className="help-copy-btn">{copied?<><CheckCircle2/> Copiado</>:<><Copy/> Copiar</>}</button></div>
              <dl>
                <div><dt>Empresa</dt><dd>{companyName}</dd></div>
                <div><dt>Versión</dt><dd>{version}</dd></div>
                <div><dt>Conexión</dt><dd className={online?"is-online":"is-offline"}>{online?"En línea":"Sin conexión"}</dd></div>
                <div><dt>Pendientes</dt><dd>{pending}</dd></div>
              </dl>
            </div>
            <div className="help-support-channels">
              {whatsappUrl && <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="help-support-channel"><WhatsAppMark/><span><strong>WhatsApp</strong><small>Hablar sin llenar el formulario</small></span><ArrowRight/></a>}
              {emailUrl && <a href={emailUrl} className="help-support-channel"><Mail/><span><strong>Correo</strong><small>{support.support_email}</small></span><ArrowRight/></a>}
              {!whatsappUrl && !emailUrl && <div className="help-support-channel is-muted"><TriangleAlert/><span><strong>Canal en configuración</strong><small>El administrador debe publicar WhatsApp o correo en PALMYRA Admin. Tu solicitud igual queda registrada.</small></span></div>}
            </div>
            <p className="help-support-note"><ShieldCheck/> Nunca compartas contraseñas por estos canales. El equipo PALMYRA no las solicita.</p>
          </aside>

          <form className="help-support-form" onSubmit={submitSupport}>
            <label className="help-field help-field--full"><span>Empresa</span><div className="help-readonly"><BuildingIcon/><input value={companyName} readOnly aria-describedby="registered-company-help"/></div><small id="registered-company-help" className="help-form-hint">Nombre real registrado en tu cuenta PALMYRA.</small></label>
            <label className="help-field"><span>Tipo de solicitud</span><select value={form.requestType} onChange={e=>setForm({...form,requestType:e.target.value})}>{requestTypes.map(type=><option key={type}>{type}</option>)}</select></label>
            <label className="help-field"><span>Teléfono de contacto (opcional)</span><div className="help-input-with-icon"><Smartphone/><input value={form.contactPhone} onChange={e=>setForm({...form,contactPhone:e.target.value})} placeholder="+53 …" autoComplete="tel"/></div></label>
            <label className="help-field help-field--full"><span>Asunto</span><input value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})} placeholder="Ej. La venta no se registra sin conexión"/></label>
            <label className="help-field help-field--full"><span>¿Qué ocurrió?</span><textarea value={form.message} onChange={e=>setForm({...form,message:e.target.value})} rows={6} placeholder="Cuenta qué intentabas hacer, qué mensaje apareció y qué esperabas que pasara."/></label>
            <div className="help-support-footer">
              <small><ShieldCheck/> Se guarda la empresa, la versión y el estado de conexión para dar seguimiento.</small>
              <button className="help-primary-btn" disabled={sending}>{sending?<><Send className="w-4 h-4 animate-pulse"/> Enviando…</>:<><Send className="w-4 h-4"/> Enviar a atención</>}</button>
            </div>
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
          <article className="help-policy-card"><h3>Diagnóstico de soporte</h3><p>Cuando creas una solicitud se adjuntan la empresa, la versión de la aplicación, el estado de conexión y el conteo de operaciones pendientes. No se envían contraseñas ni datos de tarjetas.</p></article>
          {support.privacy_url ? <a className="help-policy-link" href={support.privacy_url} target="_blank" rel="noreferrer"><FileText/> Abrir política oficial <ArrowRight/></a> : null}
        </section>
      )}
    </div>
  );
}

function BuildingIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 20h16v2H4zM6 18V5.5a1 1 0 0 1 .6-.9l4.8-2.1a1 1 0 0 1 .8 0L17 4.6a1 1 0 0 1 .6.9V18h-2V6.2l-4-1.7-3.6 1.6V18H6Zm3-8h2v2H9v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2H9v-2Zm4 0h2v2h-2v-2Z"/></svg>}
function MonitorIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>}

function FacebookMark({className=""}:{className?:string}){
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={className}><path fill="currentColor" d="M13.7 21v-7h2.4l.4-2.8h-2.8V9.4c0-.8.2-1.4 1.5-1.4h1.6V5.5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.4-3.7 3.8v2H8.5V14H11v7h2.7Z"/></svg>;
}

function WhatsAppMark({className=""}:{className?:string}){
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={className}><path fill="currentColor" d="M12 3.1a8.8 8.8 0 0 0-7.6 13.3L3.1 21l4.8-1.2A8.9 8.9 0 1 0 12 3.1Zm0 1.8a7.1 7.1 0 0 1 6.1 10.8 7 7 0 0 1-8.1 3.1l-.5-.2-2.8.7.8-2.7-.3-.5A7.1 7.1 0 0 1 12 4.9Zm-3.2 2.9c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2 0 1.2.8 2.3.9 2.5.1.2 1.7 2.8 4.3 3.8 2.1.8 2.5.6 2.9.6.4 0 1.3-.5 1.5-1 .2-.5.2-.9.1-1-.1-.1-.3-.2-.7-.4l-.9-.4c-.4-.1-.6-.2-.8.2-.2.3-.6.8-.7 1-.1.2-.3.2-.6.1-.3-.1-1.1-.4-2-1.2-.7-.6-1.2-1.4-1.3-1.6-.1-.2 0-.3.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.7-1.6c-.2-.4-.5-.5-.8-.5Z"/></svg>;
}
