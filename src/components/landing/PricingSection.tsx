import { ArrowRight, Check, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PALMYRA_PLANS } from "../../config/saas";

export function PricingSection() {
  const navigate = useNavigate();
  return (
    <section id="planes" className="landing-pricing">
      <div className="landing-shell">
        <div className="landing-section-heading">
          <p className="landing-eyebrow">PLANES</p>
          <h2>Empieza pequeño.<br /><span>Crece sin cambiar de sistema.</span></h2>
          <p>Un plan claro, límites visibles y una arquitectura preparada para acompañar al negocio.</p>
        </div>
        <div className="landing-pricing__grid">
          {PALMYRA_PLANS.map((plan) => {
            const featured = plan.code === "growth";
            return (
              <article key={plan.code} className={"landing-plan" + (featured ? " is-featured" : "")}>
                {featured ? <span className="landing-plan__badge">MÁS ELEGIDO</span> : null}
                <div className="landing-plan__head"><div className="landing-plan__icon"><Sparkles size={17} /></div><div><span>{plan.description}</span><h3>{plan.name}</h3></div></div>
                <div className="landing-plan__price"><strong>{"$" + plan.price}</strong><span>USD / mes</span></div>
                <div className="landing-plan__limits"><div><strong>{plan.warehouses}</strong><span>almacenes</span></div><div><strong>{plan.employees}</strong><span>empleados</span></div><div><strong>{plan.products}</strong><span>productos</span></div></div>
                <div className="landing-plan__features">{plan.features.map((feature) => <div key={feature}><Check size={12} /><span>{feature}</span></div>)}</div>
                <button type="button" onClick={() => { sessionStorage.setItem("palmyra_signup_plan", plan.code); navigate("/auth?mode=signup"); }}>{plan.code === "starter" ? "Comenzar gratis" : "Elegir plan"} <ArrowRight size={14} /></button>
                <small>Cuba · efectivo o transferencia bancaria</small>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
