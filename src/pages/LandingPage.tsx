import { useEffect, useState } from "react";
import { ArrowRight, Check, ChevronDown, CloudOff, LockKeyhole, MonitorSmartphone, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ImmersiveBackdrop } from "../components/landing/ImmersiveBackdrop";
import { landingModules, ProductScene } from "../components/landing/ProductScene";
import { ProductStory } from "../components/landing/ProductStory";
import { PricingSection } from "../components/landing/PricingSection";
import "../components/landing/landing.css";

function Brand({ footer = false }: { footer?: boolean }) {
  return <img src="/palmyra-logo-exact.svg" alt="PALMYRA" className={footer ? "landing-footer-logo" : ""} />;
}

export default function LandingPage() {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const goSignup = () => navigate("/auth?mode=signup");

  useEffect(() => {
    // El resto del ERP utiliza un shell con overflow:hidden. La landing es un
    // documento largo y debe tomar control vertical también en html y #root.
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
          <button type="button" className="landing-btn landing-btn--primary" onClick={goSignup}>Crear cuenta <ArrowRight size={13} /></button>
          <button type="button" className="landing-menu" aria-expanded={mobileOpen} aria-label={mobileOpen ? "Cerrar menú" : "Abrir menú"} onClick={() => setMobileOpen((value) => !value)}>
            {mobileOpen ? <X size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
        {mobileOpen ? (
          <div className="landing-mobile-nav">
            <a href="#producto" onClick={() => setMobileOpen(false)}>Producto</a>
            <a href="#modulos" onClick={() => setMobileOpen(false)}>Módulos</a>
            <a href="#conexion" onClick={() => setMobileOpen(false)}>Cómo funciona</a>
            <a href="#planes" onClick={() => setMobileOpen(false)}>Planes</a>
            <button type="button" onClick={goSignup}>Crear cuenta <ArrowRight size={13} /></button>
          </div>
        ) : null}
      </header>

      <main>
        <section id="producto" className="landing-hero">
          <ImmersiveBackdrop />
          <div className="landing-hero__inner">
            <div className="landing-hero__copy">
              <p className="landing-eyebrow">BUSINESS OS · PALMYRA</p>
              <h1>Tu negocio.<span>En un solo lugar.</span></h1>
              <p className="landing-hero__lead">Ventas, inventario, cajas, compras, clientes, almacenes, equipo y reportes, conectados en un sistema pensado para trabajar todos los días.</p>
              <div className="landing-hero__actions">
                <button type="button" className="landing-btn landing-btn--primary" onClick={goSignup}>Empezar con PALMYRA <ArrowRight size={14} /></button>
                <a className="landing-btn landing-btn--light" href="#modulos">Explorar producto</a>
              </div>
              <div className="landing-hero__proof">
                <span><i />Una cuenta · una empresa</span><span><i />Almacenes por plan</span><span><i />Operación offline</span>
              </div>
            </div>
            <div className="landing-visual-wrap">
              <ProductScene module={landingModules.find((module) => module.id === "pos") || landingModules[0]} />
              <div className="landing-hero__caption"><Sparkles size={12} /><span>Una interfaz que <b>cuenta la historia del negocio</b>.</span></div>
            </div>
          </div>
        </section>

        <ProductStory />

        <section id="conexion" className="landing-connection">
          <ImmersiveBackdrop dark />
          <div className="landing-shell">
            <p className="landing-eyebrow">TODO CONECTADO</p>
            <h2>Un mismo negocio. Una misma fuente. Menos piezas sueltas.</h2>
            <p className="landing-connection__lead">PALMYRA organiza el trabajo alrededor de la empresa y sus almacenes. POS, inventario, compras, clientes, caja y reportes comparten contexto para que el equipo no tenga que reconstruir la información.</p>
            <div className="landing-network" aria-label="Módulos conectados de PALMYRA">
              <div className="landing-network__core">PALMYRA</div>
              {[["POS", "12%", "22%"], ["Inventario", "70%", "18%"], ["Compras", "78%", "61%"], ["Clientes", "11%", "67%"], ["Equipo", "42%", "82%"], ["Caja", "78%", "82%"]].map(([label, left, top]) => <div key={label} className="landing-network__node" style={{ left, top }}>{label}</div>)}
              {[1, 2, 3, 4, 5, 6].map((number) => <span key={number} className={"landing-network__line landing-network__line--" + number} />)}
            </div>
          </div>
        </section>

        <section className="landing-offline">
          <div className="landing-shell landing-offline__grid">
            <div className="landing-offline__copy">
              <p className="landing-eyebrow">OFFLINE DE VERDAD</p>
              <h2>La conexión puede fallar. El negocio no debería parar.</h2>
              <p>PALMYRA está diseñado para que la operación local pueda continuar y después sincronizar los cambios, manteniendo el contexto del negocio.</p>
              <div className="landing-offline__steps">{["Trabaja normalmente", "Guarda la operación localmente", "Recupera la conexión", "Sincroniza y continúa"].map((item, index) => <div key={item}><b>{"0" + (index + 1)}</b><span>{item}</span></div>)}</div>
            </div>
            <div className="landing-sync-card">
              <div className="landing-sync-card__grid" />
              <div className="landing-sync-card__content">
                <div className="landing-sync-state"><i /> Estado de sincronización</div>
                <div className="landing-sync-route">
                  <div className="landing-sync-node"><strong>POS</strong><span>Operación local</span></div>
                  <div className="landing-sync-arrow">↔</div>
                  <div className="landing-sync-node"><strong>NUBE</strong><span>Datos sincronizados</span></div>
                </div>
                <p className="landing-sync-note">La recuperación se resuelve como parte de la arquitectura, no como un mensaje de error al trabajador.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="landing-shell">
            <div className="landing-section-heading">
              <p className="landing-eyebrow">HECHO PARA EL TRABAJO REAL</p>
              <h2>Simple para quien trabaja.<br /><span>Potente para quien decide.</span></h2>
              <p>La complejidad vive detrás. La interfaz muestra lo que cada persona necesita para hacer su trabajo.</p>
            </div>
            <div className="landing-system-grid">
              {[
                [MonitorSmartphone, "Desde cualquier dispositivo", "Misma empresa, mismo contexto y permisos adaptados a móvil, tablet y PC."],
                [Users, "Equipo con roles claros", "Cada trabajador entra con su identidad y ve solamente las funciones que necesita."],
                [LockKeyhole, "Aislamiento por empresa", "La cuenta trabaja dentro de su propia empresa y sus almacenes autorizados."],
                [ShieldCheck, "Trazabilidad", "Cajas, movimientos y decisiones importantes mantienen contexto para revisar lo ocurrido."],
                [CloudOff, "Operación resistente", "El trabajo no depende de que la conexión sea perfecta en cada momento."],
                [Check, "Diseño que no estorba", "Acciones cortas, jerarquía clara y superficies pensadas para jornadas largas."],
              ].map(([Icon, title, text]) => {
                const I = Icon as typeof MonitorSmartphone;
                return <article key={String(title)} className="landing-system-card"><div className="landing-system-card__icon"><I size={16} /></div><h3>{title as string}</h3><p>{text as string}</p></article>;
              })}
            </div>
          </div>
        </section>

        <PricingSection />

        <section className="landing-heritage">
          <div className="landing-shell landing-heritage__grid">
            <div className="landing-heritage__stage" aria-hidden="true">
              <div className="landing-heritage__ring" />
              <div className="landing-heritage__mark">✦</div>
              <div className="landing-heritage__route" />
            </div>
            <div>
              <p className="landing-eyebrow">POR QUÉ PALMYRA</p>
              <h2>Un nombre que habla de conexión, comercio y movimiento.</h2>
              <p>Palmyra fue durante siglos un punto de encuentro de rutas comerciales. Ese concepto inspira nuestro producto: conectar las partes del negocio para que la información se mueva con ellas.</p>
              <div className="landing-heritage__facts">
                <div><strong>Conexión</strong><span>Un mismo contexto</span></div>
                <div><strong>Comercio</strong><span>Movimiento que crea valor</span></div>
                <div><strong>Resiliencia</strong><span>Seguir avanzando</span></div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-cta">
          <div className="landing-shell landing-cta__inner">
            <div>
              <p className="landing-eyebrow">PALMYRA</p>
              <h2>Menos piezas sueltas. Más negocio bajo control.</h2>
              <p>Empieza con lo esencial y deja que PALMYRA crezca contigo.</p>
            </div>
            <div className="landing-cta__actions">
              <button type="button" className="landing-btn landing-btn--primary" onClick={goSignup}>Crear cuenta <ArrowRight size={13} /></button>
              <a className="landing-btn landing-btn--light" href="#modulos">Volver al producto</a>
            </div>
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
