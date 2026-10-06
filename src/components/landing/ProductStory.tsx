import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { landingModules, ProductScene } from "./ProductScene";

const storyIds = ["menu", "dashboard", "cash", "inventory", "suppliers", "customers", "reports", "settings", "team", "plan"];
const storyModules = storyIds.map((id) => landingModules.find((module) => module.id === id)).filter((module): module is (typeof landingModules)[number] => Boolean(module));

export function ProductStory() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sectionProgress, setSectionProgress] = useState(0);
  const active = storyModules[activeIndex] || storyModules[0];

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const anchors = Array.from(section.querySelectorAll<HTMLElement>("[data-story-id]"));
    if (!anchors.length) return;

    let frame = 0;
    const updateProgress = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = section.getBoundingClientRect();
        const total = Math.max(section.offsetHeight - window.innerHeight, 1);
        setSectionProgress(Math.max(0, Math.min(1, -rect.top / total)));
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top - window.innerHeight * 0.5) - Math.abs(b.boundingClientRect.top - window.innerHeight * 0.5));

        if (!visible.length) return;
        const id = (visible[0].target as HTMLElement).dataset.storyId;
        const index = storyModules.findIndex((module) => module.id === id);
        if (index >= 0) setActiveIndex(index);
      },
      { rootMargin: "-42% 0px -42% 0px", threshold: 0 },
    );

    anchors.forEach((anchor) => observer.observe(anchor));
    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
    };
  }, []);

  return (
    <section id="modulos" ref={sectionRef} className="landing-story">
      <div className="landing-story__intro-shell landing-shell">
        <div>
          <p className="landing-eyebrow">UN MENÚ. TODO TU NEGOCIO.</p>
          <h2>Conoce el producto<br /><span>mientras avanzas.</span></h2>
        </div>
        <p>Esta vez no hay una galería separada ni un texto que repite las pantallas. Cada escena aparece dentro del recorrido y cambia sola mientras haces scroll.</p>
      </div>

      <div className="landing-shell landing-story__layout">
        <div className="landing-story__visual-column">
          <div className="landing-story__sticky">
            <div className="landing-story__sticky-label"><span>ESCENA ACTIVA</span><b>{String(activeIndex + 1).padStart(2, "0")} / {String(storyModules.length).padStart(2, "0")}</b></div>
            <div className="landing-story__stage-frame">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={active.id} className="landing-story__scene-transition"
                  initial={{ opacity: 0, scale: 0.84, y: 80, rotateX: 9, rotateY: -8, filter: "blur(10px)" }}
                  animate={{ opacity: 1, scale: 1, y: 0, rotateX: 0, rotateY: -2, filter: "blur(0px)" }}
                  exit={{ opacity: 0, scale: 1.06, y: -55, rotateX: -7, rotateY: 7, filter: "blur(7px)" }}
                  transition={{ duration: 0.68, ease: [0.16, 1, 0.3, 1] }}>
                  <ProductScene module={active} />
                </motion.div>
              </AnimatePresence>
              <div className="landing-story__stage-depth" style={{ transform: "scale(" + (0.88 + sectionProgress * 0.12) + ")", opacity: 0.28 + sectionProgress * 0.42 }} />
            </div>
            <div className="landing-story__progress"><span style={{ transform: "scaleX(" + sectionProgress + ")" }} /></div>
            <div className="landing-story__stage-caption"><span>{active.screenLabel}</span><strong>{active.label}</strong><p>{active.description}</p></div>
          </div>
        </div>

        <div className="landing-story__chapters">
          {storyModules.map((module, index) => {
            const selected = index === activeIndex;
            return (
              <article key={module.id} id={"landing-story-anchor-" + module.id} data-story-id={module.id} className={"landing-story__chapter" + (selected ? " is-active" : "")}>
                <div className="landing-story__chapter-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="landing-story__chapter-copy">
                  <p className="landing-eyebrow">{module.eyebrow}</p>
                  <h3>{module.title}</h3>
                  <p>{module.description}</p>
                  <div className="landing-story__chapter-meta"><span><span className="landing-live-dot" /> Pantalla real</span><button type="button" onClick={() => document.getElementById("landing-story-anchor-" + module.id)?.scrollIntoView({ behavior: "smooth", block: "center" })}>Ver escena <ArrowRight size={13} /></button></div>
                </div>
              </article>
            );
          })}

          <div className="landing-story__scroll-hint"><ArrowDown size={15} /><span>Sigue bajando. La escena cambia automáticamente.</span></div>
        </div>
      </div>
    </section>
  );
}