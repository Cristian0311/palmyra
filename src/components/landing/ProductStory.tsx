import { useState } from "react";
import { motion } from "motion/react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { landingModules, ProductScene } from "./ProductScene";

export function ProductStory() {
  const [activeId, setActiveId] = useState("pos");
  const active = landingModules.find((module) => module.id === activeId) || landingModules[0];

  return (
    <section id="modulos" className="landing-story">
      <div className="landing-shell">
        <div className="landing-story__intro">
          <div><p className="landing-eyebrow">EXPLORA EL PRODUCTO</p><h2>Un menú.<br /><span>Todo tu negocio.</span></h2></div>
          <p>La experiencia cambia de área sin sacarte del contexto. Cada módulo tiene su propia función, pero todos hablan el mismo idioma.</p>
        </div>

        <div className="landing-story__tabs" role="tablist" aria-label="Áreas de PALMYRA">
          {landingModules.map((module) => {
            const Icon = module.icon;
            const selected = module.id === active.id;
            return <button key={module.id} type="button" role="tab" aria-selected={selected} className={selected ? "is-active" : ""} onClick={() => setActiveId(module.id)}><Icon size={14} /><span>{module.label}</span></button>;
          })}
        </div>

        <div className="landing-story__stage">
          <div className="landing-story__copy">
            <motion.div key={active.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .2 }}>
              <span className="landing-story__number">{String(landingModules.findIndex((m) => m.id === active.id) + 1).padStart(2, "0")}</span>
              <p className="landing-eyebrow">{active.eyebrow}</p>
              <h3>{active.title}</h3>
              <p>{active.description}</p>
              <a href="#planes">Conocer el sistema <ArrowRight size={15} /></a>
            </motion.div>
            <div className="landing-story__scroll-hint"><ArrowDown size={13} /> Selecciona un área para explorarla</div>
          </div>
          <div className="landing-story__visual"><ProductScene key={active.id} module={active} /></div>
        </div>
      </div>
    </section>
  );
}
