import { useEffect, useState } from "react";
import { ArrowRight, Check, CloudOff, LockKeyhole, Menu, MonitorSmartphone, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ImmersiveBackdrop } from "../components/landing/ImmersiveBackdrop";
import { landingModules, ProductScene } from "../components/landing/ProductScene";
import { ProductStory } from "../components/landing/ProductStory";
import { PricingSection } from "../components/landing/PricingSection";
import "../components/landing/landing.css";

function Brand({ footer = false }: { footer?: boolean }) {
  return <img src="/palmyra-logo-exact.svg" alt="PALMYRA" className={footer ? "landing-footer-logo" : ""} />;
}

const highlights = [
  ["01", "Vista general", "Todo el negocio en una lectura."],
  ["02", "Operación", "Caja, inventario y ventas conectados."],
  ["03", "Control", "Reportes para decidir con contexto."],
];

export default function LandingPage() {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const goSignup = () => navigate("/auth?mode=signup");

  useEffect(() => {
    const html = document.documentElement;
    const root = document.getElementById("root");
    const elements = [html, document.body, root].filter((element): element is HTMLElement => Boolean(element));
    const previous = elements.map((element) => ({
      element,
      overflow: element.style.overflow,
      overflowY: element.style.overflowY,
      overflowX: element.style.overflowX,
      touchAction: element.style.touchAction,
      height: element.style.height,
    }));

    elements.forEach((element) => {
      element.style.overflow = "visible";
      element.style.overflowY = "auto";
      element.style.overflowX = "hidden";
      element.style.touchAction = "pan-y";
      element.style.height = "auto";
    });

    html.classList.add("palmyra-landing-active");
    document.body.classList.add("palmyra-landing-active");
    root?.classList.add("palmyra-landing-active");

    return () => {
      html.classList.remove("palmyra-landing-active");
      document.body.classList.remove("palmyra-landing-active");
      root?.classList.remove("palmyra-landing-active");
      previous.forEach(({ element, overflow, overflowY, overflowX, touchAction, height }) => {
        element.style.overflow = overflow;
        element.style.overflowY = overflowY;
        element.style.overflowX = overflowX;
        element.style.touchAction = touchAction;
        element.style.height = height;
      });
    };
  }, []);

  return (
    <div className="landing-page">
      <header className="landing-header">
        <a href="#producto" className="landing-header__brand" aria-label="PALMYRA, inicio"><Brand /></a>
        <nav className="landing-nav" aria-label="Navegación principal">
          <a href="#producto">Producto</a>
          <a href="#modulos">Módulos</a>
          <a href="#conexion">Cómo funciona</a>
          <a href="#planes">Planes</a>
        </nav>
        <div className="landing-header__actions">
          <button type="button" className="landing-btn landing-btn--light" onClick={() => navigate("/auth")}>Entrar</button>
          <button type="button" className="landing-btn landing-btn--primary" onClick={goSignup}>Crear cuenta <ArrowRight size={15} /></button>
          <button type="button" className="landing-menu" aria-expanded={mobileOpen} aria-label={mobileOpen ? "Cerrar menú" : "Abrir menú"} onClick={() => setMobileOpen((value) => !value)}>
            {mobileOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
        {mobileOpen ? (
          <div className="landing-mobile-nav">
            <a href="#producto" onClick={() => setMobileOpen(false)}>Producto</a>
            <a href="#modulos" onClick={() => setMobileOpen(false)}>Módulos</a>
            <a href="#conexion" onClick={() => setMobileOpen(false)}>Cómo funciona</a>
            <a href="#planes" onClick={() => setMobileOpen(false)}>Planes</a>
            <button type="button" onClick={goSignup}>Crear cuenta <ArrowRight size={15} /></button>
          </div>
        ) : null}
      </header>

      <main>
        <section id="producto" className="landing-hero">
          <ImmersiveBackdrop />
          <div className="landing-shell landing-hero__inner">
            <div className="landing-hero__copy">
              <p className="landing-eyebrow">BUSINESS OS · PALMYRA</p>
              <h1>Tu negocio.<br /><span>En un solo lugar.</span></h1>
              <p className="landing-hero__lead">Ventas, inventario, cajas, compras, clientes, almacenes, equipo y reportes conectados en una sola experiencia de trabajo.</p>
              <div className="landing-hero__actions">
                <button type="button" className="landing-btn landing-btn--primary landing-btn--large" onClick={goSignup}>Empezar con PALMYRA <ArrowRight size={16} /></button>
                <a className="landing-btn landing-btn--light landing-btn--large" href="#modulos">Ver el producto <Sparkles size={15} /></a>
              </div>
              <div className="landing-hero__highlights">
                {highlights.map(([index, title, copy]) => (
                  <div key={index} className="landing-hero__highlight">
                    <span>{index}</span><div><strong>{title}</strong><small>{copy}</small></div>
                  </div>
                ))}
              </div>
            </div>

            <div className="landing-hero__visual">
              <div className="landing-hero__visual-label"><span>CAPTURA REAL · CRM PALMYRA</span><b>01</b></div>
              <ProductScene module={landingModules.find((module) => module.id === "dashboard") || landingModules[0]} />
              <div className="landing-hero__visual-note">
                <span className="landing-live-dot" /> La pantalla que ves es una captura real del CRM.
              </div>
            </div>
          </div>
          <div className="landing-scroll-cue"><span>Desliza para entrar al producto</span><i /></div>
        </section>

        <ProductStory />

        <section id="conexion" className="landing-connection">
          <ImmersiveBackdrop dark />
          <div className="landing-shell">
            <div className="landing-section-heading landing-section-heading--light">
              <p className="landing-eyebrow">TODO CONECTADO</p>
              <h2>Una operación que se <span>mueve como una sola.</span></h2>
              <p>El mismo negocio alimenta POS, inventario, compras, clientes, caja y reportes. Menos pantallas aisladas; más contexto compartido.</p>
            </div>
            <div className="landing-network" aria-label="Módulos conectados de PALMYRA">
              <div className="landing-network__orbit landing-network__orbit--one" />
              <div className="landing-network__orbit landing-network__orbit--two" />
              <div className="landing-network__core"><img src="/palmyra-mark-exact.svg" alt="" /><strong>PALMYRA</strong><span>BUSINESS OS</span></div>
              {[["POS", "9%", "23%"], ["Inventario", "72%", "18%"], ["Compras", "78%", "62%"], ["Clientes", "8%", "65%"], ["Equipo", "42%", "82%"], ["Reportes", "69%", "83%"]].map(([label, left, top], index) => (
                <div key={label} className="landing-network__node" style={{ left, top, animationDelay: String(index * 0.18) + "s" }}><span className="landing-network__pulse" />{label}</div>
              ))}
              {[1,2,3,4,5,6].map((number) => <span key={number} className={"landing-network__line landing-network__line--" + number} />)}
            </div>
            <div className="landing-connection__footer"><strong>Una fuente de verdad.</strong><span>Empresa → almacenes → operaciones → reportes</span></div>
          </div>
        </section>

        <section className="landing-offline">
          <div className="landing-shell landing-offline__grid">
            <div className="landing-offline__copy">
              <p className="landing-eyebrow">OFFLINE DE VERDAD</p>
              <h2>La conexión puede fallar.<br /><span>El negocio no.</span></h2>
              <p>PALMYRA mantiene la operación local, conserva el contexto y sincroniza cuando la red vuelve. Para quien trabaja, el proceso sigue siendo simple.</p>
              <div className="landing-offline__steps">
                {["Trabaja normalmente", "Guarda la operación localmente", "Recupera la conexión", "Sincroniza y continúa"].map((item, index) => (
                  <div key={item}><b>{"0" + (index + 1)}</b><span>{item}</span></div>
                ))}
              </div>
            </div>
            <div className="landing-sync-scene">
              <div className="landing-sync-scene__floor" />
              <div className="landing-sync-card">
                <div className="landing-sync-card__top"><span className="landing-live-dot" /> SINCRONIZACIÓN ACTIVA</div>
                <div className="landing-sync-card__route">
                  <div className="landing-sync-device landing-sync-device--local"><strong>POS</strong><span>Operación local</span><i /></div>
                  <div className="landing-sync-card__beam"><i /><i /><i /></div>
                  <div className="landing-sync-device landing-sync-device--cloud"><strong>NUBE</strong><span>Datos sincronizados</span><i /></div>
                </div>
                <div className="landing-sync-card__footer"><CloudOff size={15} /><span>Sincronizar sin interrumpir el trabajo.</span></div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="landing-shell">
            <div className="landing-section-heading">
              <p className="landing-eyebrow">HECHO PARA EL TRABAJO REAL</p>
              <h2>Simple para quien trabaja.<br /><span>Potente para quien decide.</span></h2>
              <p>La complejidad vive detrás. La interfaz enseña exactamente lo que cada persona necesita para hacer su trabajo.</p>
            </div>
            <div className="landing-system-grid">
              {[
                [MonitorSmartphone, "Desde cualquier dispositivo", "Misma empresa, mismo contexto y permisos adaptados a móvil, tablet y PC."],
                [Users, "Equipo con roles claros", "Cada persona entra con su identidad y usa solo las funciones que necesita."],
                [LockKeyhole, "Aislamiento por empresa", "Los datos quedan dentro de la empresa y los almacenes autorizados."],
                [ShieldCheck, "Trazabilidad", "Cajas, movimientos y decisiones importantes conservan contexto para revisar lo ocurrido."],
                [CloudOff, "Operación resistente", "El trabajo no depende de que la conexión sea perfecta en cada momento."],
                [Check, "Diseño que no estorba", "Acciones cortas, jerarquía clara y superficies pensadas para jornadas largas."],
              ].map(([Icon, title, copy]) => {
                const I = Icon as typeof MonitorSmartphone;
                return <article key={String(title)} className="landing-system-card"><div className="landing-system-card__icon"><I size={20} /></div><h3>{title as string}</h3><p>{copy as string}</p></article>;
              })}
            </div>
          </div>
        </section>

        <PricingSection />

        <section className="landing-heritage">
          <div className="landing-heritage__backdrop" aria-hidden="true" />
          <div className="landing-shell landing-heritage__grid">
            <div className="landing-heritage__visual">
              <div className="landing-heritage__image-card">
                <div className="landing-heritage__image-label"><span>PALMYRA · SIRIA</span><b>RUTAS ANTIGUAS</b></div>
                <img src="/landing/palmyra-city.svg" alt="Ilustración editorial de la antigua ciudad de Palmyra" />
                <div className="landing-heritage__image-caption"><strong>Una ciudad construida alrededor del movimiento.</strong><span>Comercio, encuentro y rutas.</span></div>
              </div>
            </div>
            <div className="landing-heritage__copy">
              <p className="landing-eyebrow">HISTORIA DE PALMYRA</p>
              <h2>Un nombre que nació de una ciudad de encuentro.</h2>
              <p>Palmyra fue un cruce histórico de rutas comerciales entre territorios. Nuestra identidad toma esa idea y la convierte en producto: conectar las partes del negocio para que la información pueda moverse con ellas.</p>
              <div className="landing-heritage__facts">
                <div><strong>Conexión</strong><span>Un mismo contexto.</span></div>
                <div><strong>Comercio</strong><span>Movimiento que crea valor.</span></div>
                <div><strong>Resiliencia</strong><span>Seguir avanzando.</span></div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-cta">
          <div className="landing-shell landing-cta__inner">
            <div><p className="landing-eyebrow">PALMYRA</p><h2>Menos piezas sueltas.<br /><span>Más negocio bajo control.</span></h2><p>Empieza con lo esencial y deja que PALMYRA crezca contigo.</p></div>
            <div className="landing-cta__actions"><button type="button" className="landing-btn landing-btn--primary" onClick={goSignup}>Crear cuenta <ArrowRight size={15} /></button><a className="landing-btn landing-btn--dark" href="#modulos">Volver al producto</a></div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-shell landing-footer__inner">
          <Brand footer />
          <p>PALMYRA · Business OS · Gestión empresarial simple y profesional</p>
          <p>© {new Date().getFullYear()} PALMYRA</p>
        </div>
      </footer>
    </div>
  );
}