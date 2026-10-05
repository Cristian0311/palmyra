import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown } from "lucide-react";
import { landingModules, ProductScene } from "./ProductScene";

const storyIds = ["dashboard", "cash", "customers", "inventory", "suppliers", "audit", "bank", "reports", "settings", "team", "plan"];
const storyModules = storyIds.map((id) => landingModules.find((module) => module.id === id)).filter((module): module is (typeof landingModules)[number] => Boolean(module));
const gallery = storyModules.slice(0, 8);

export function ProductStory() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sectionProgress, setSectionProgress] = useState(0);
  const active = storyModules[activeIndex] || storyModules[0];

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let frame = 0;
    let lastIndex = -1;

    const updateFromScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const vh = window.innerHeight || 1;
        const center = vh * 0.53;
        const rect = section.getBoundingClientRect();
        const distance = Math.max(section.offsetHeight - vh, 1);
        setSectionProgress(Math.max(0, Math.min(1, -rect.top / distance)));

        const anchors = Array.from(section.querySelectorAll<HTMLElement>("[data-story-id]"));
        let nextIndex = 0;
        let best = Number.POSITIVE_INFINITY;
        anchors.forEach((anchor, index) => {
          const r = anchor.getBoundingClientRect();
          const centerPoint = r.top + r.height / 2;
          const inside = r.top <= center && r.bottom >= center;
          const score = inside ? Math.abs(centerPoint - center) * 0.2 : Math.abs(centerPoint - center);
          if (score < best) { best = score; nextIndex = index; }
        });
        if (nextIndex !== lastIndex) { lastIndex = nextIndex; setActiveIndex(nextIndex); }
      });
    };

    updateFromScroll();
    window.addEventListener("scroll", updateFromScroll, { passive: true });
    window.addEventListener("resize", updateFromScroll);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", updateFromScroll); window.removeEventListener("resize", updateFromScroll); };
  }, []);

  return (
    <section id="modulos" ref={sectionRef} className="landing-story">
      <div className="landing-shell landing-story__layout">
        <div className="landing-story__visual-column">
          <div className="landing-story__sticky">
            <div className="landing-story__sticky-label"><span>CAPTURA EN ESCENA</span><b>{String(activeIndex + 1).padStart(2, "0")} / {String(storyModules.length).padStart(2, "0")}</b></div>
            <div className="landing-story__stage-frame">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={active.id} className="landing-story__scene-transition"
                  initial={{ opacity: 0, scale: 0.84, y: 70, rotateX: 10, rotateY: -9, filter: "blur(10px)" }}
                  animate={{ opacity: 1, scale: 1, y: 0, rotateX: 0, rotateY: -2, filter: "blur(0px)" }}
                  exit={{ opacity: 0, scale: 1.08, y: -55, rotateX: -8, rotateY: 8, filter: "blur(8px)" }}
                  transition={{ duration: 0.66, ease: [0.16, 1, 0.3, 1] }}>
                  <ProductScene module={active} />
                </motion.div>
              </AnimatePresence>
              <div className="landing-story__stage-depth" style={{ opacity: 0.35 + sectionProgress * 0.5 }} />
            </div>
            <div className="landing-story__progress"><span style={{ transform: "scaleX(" + sectionProgress + ")" }} /></div>
            <div className="landing-story__stage-caption"><span>{active.screenLabel}</span><strong>{active.label}</strong><p>{active.description}</p></div>
          </div>
        </div>

        <div className="landing-story__chapters">
          <div className="landing-story__intro">
            <div><p className="landing-eyebrow">UN MENÚ. TODO TU NEGOCIO.</p><h2>Conoce cada área.<br /><span>Mientras avanzas.</span></h2></div>
            <p>Las capturas reales del CRM toman el escenario automáticamente. No tienes que pulsar para cambiar de producto: <strong>sigue bajando</strong> y la pantalla cambia contigo.</p>
          </div>

          <div className="landing-story__gallery" aria-label="Capturas reales de PALMYRA">
            {gallery.map((module, index) => (
              <div key={module.id} className="landing-story__gallery-card">
                <img src={module.screenSrc} alt={"Captura real de " + module.label} loading="lazy" />
                <span>{module.label}</span>
              </div>
            ))}
          </div>

          <div className="landing-story__chapter-list">
            {storyModules.map((module, index) => {
              const selected = index === activeIndex;
              return (
                <article key={module.id} id={"landing-story-anchor-" + module.id} data-story-id={module.id} className={"landing-story__chapter" + (selected ? " is-active" : "")}>
                  <div className="landing-story__chapter-index">{String(index + 1).padStart(2, "0")}</div>
                  <div className="landing-story__chapter-copy"><p className="landing-eyebrow">{module.eyebrow}</p><h3>{module.title}</h3><p>{module.description}</p></div>
                </article>
              );
            })}
          </div>

          <div className="landing-story__scroll-hint"><ArrowDown size={15} /><span>Continúa bajando. Las capturas cambian solas.</span></div>
        </div>
      </div>
    </section>
  );
}