import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { landingModules, ProductScene } from "./ProductScene";

const storyIds = ["dashboard", "pos", "inventory", "purchases", "transfers", "customers", "reports", "settings"];

const storyModules = storyIds
  .map((id) => landingModules.find((module) => module.id === id))
  .filter((module): module is (typeof landingModules)[number] => Boolean(module));

export function ProductStory() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState("dashboard");
  const [progress, setProgress] = useState(0);
  const active = landingModules.find((module) => module.id === activeId) || landingModules[0];

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const anchors = Array.from(section.querySelectorAll<HTMLElement>("[data-story-id]"));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (visible) {
          const id = (visible.target as HTMLElement).dataset.storyId;
          if (id) setActiveId(id);
        }
      },
      { rootMargin: "-38% 0px -42% 0px", threshold: [0.15, 0.35, 0.6] },
    );

    anchors.forEach((anchor) => observer.observe(anchor));

    const updateProgress = () => {
      const rect = section.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      const distance = Math.max(section.offsetHeight - viewport, 1);
      setProgress(Math.max(0, Math.min(1, -rect.top / distance)));
    };

    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
    };
  }, []);

  const selectModule = (id: string) => {
    setActiveId(id);
    if (!storyIds.includes(id)) return;

    document
      .getElementById(`landing-story-anchor-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <section id="modulos" ref={sectionRef} className="landing-story">
      <div className="landing-shell landing-story__layout">
        <div className="landing-story__visual-column">
          <div className="landing-story__sticky">
            <div className="landing-story__sticky-label">
              <span>EXPLORA EL PRODUCTO</span>
              <b>{String(Math.max(1, storyIds.indexOf(active.id) + 1)).padStart(2, "0")} / {String(storyModules.length).padStart(2, "0")}</b>
            </div>

            <div className="landing-story__stage-frame">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={active.id}
                  className="landing-story__scene-transition"
                  initial={{ opacity: 0, y: 28, scale: 0.965, filter: "blur(8px)" }}
                  animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -22, scale: 1.02, filter: "blur(6px)" }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                >
                  <ProductScene module={active} />
                </motion.div>
              </AnimatePresence>

              <div className="landing-story__stage-glow" aria-hidden="true" />
            </div>

            <div className="landing-story__progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${progress})` }} />
            </div>
            <div className="landing-story__stage-caption">
              <span>{active.eyebrow}</span>
              <strong>{active.title}</strong>
            </div>
          </div>
        </div>

        <div className="landing-story__chapters">
          <div className="landing-story__intro">
            <div>
              <p className="landing-eyebrow">UN MENÚ. TODO TU NEGOCIO.</p>
              <h2>Conoce cada área.<br /><span>Mientras avanzas.</span></h2>
            </div>
            <p>Desplázate y PALMYRA va presentando cada parte del sistema. El escenario permanece contigo y cambia según el punto de la historia.</p>
          </div>

          <div className="landing-story__tabs" role="tablist" aria-label="Áreas de PALMYRA">
            {landingModules.map((module) => {
              const Icon = module.icon;
              const selected = module.id === active.id;
              return (
                <button
                  key={module.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={selected ? "is-active" : ""}
                  onClick={() => selectModule(module.id)}
                >
                  <Icon size={14} />
                  <span>{module.label}</span>
                </button>
              );
            })}
          </div>

          <div className="landing-story__chapter-list">
            {storyModules.map((module, index) => (
              <article
                key={module.id}
                id={`landing-story-anchor-${module.id}`}
                data-story-id={module.id}
                className={`landing-story__chapter${module.id === active.id ? " is-active" : ""}`}
              >
                <div className="landing-story__chapter-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="landing-story__chapter-copy">
                  <p className="landing-eyebrow">{module.eyebrow}</p>
                  <h3>{module.title}</h3>
                  <p>{module.description}</p>
                  <button type="button" onClick={() => selectModule(module.id)}>
                    Ver esta área <ArrowRight size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="landing-story__scroll-hint">
            <ArrowDown size={13} />
            <span>Continúa bajando para ver cómo cambia PALMYRA</span>
          </div>
        </div>
      </div>
    </section>
  );
}
