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
        const viewportHeight = window.innerHeight || 1;
        const viewportCenter = viewportHeight * 0.52;
        const sectionRect = section.getBoundingClientRect();
        const sectionDistance = Math.max(section.offsetHeight - viewportHeight, 1);

        setSectionProgress(
          Math.max(0, Math.min(1, -sectionRect.top / sectionDistance)),
        );

        const anchors = Array.from(section.querySelectorAll<HTMLElement>("[data-story-id]"));
        if (!anchors.length) return;

        let nextIndex = 0;
        let smallestDistance = Number.POSITIVE_INFINITY;

        anchors.forEach((anchor, index) => {
          const rect = anchor.getBoundingClientRect();
          const anchorCenter = rect.top + rect.height / 2;
          const distance = Math.abs(anchorCenter - viewportCenter);

          // Once a chapter occupies the center band, it becomes the scene.
          const centerBand = rect.top <= viewportCenter && rect.bottom >= viewportCenter;
          const weightedDistance = centerBand ? distance * 0.2 : distance;

          if (weightedDistance < smallestDistance) {
            smallestDistance = weightedDistance;
            nextIndex = index;
          }
        });

        if (nextIndex !== lastIndex) {
          lastIndex = nextIndex;
          setActiveIndex(nextIndex);
        }
      });
    };

    updateFromScroll();
    window.addEventListener("scroll", updateFromScroll, { passive: true });
    window.addEventListener("resize", updateFromScroll);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateFromScroll);
      window.removeEventListener("resize", updateFromScroll);
    };
  }, []);

  const selectModule = (index: number) => {
    setActiveIndex(index);
    document
      .getElementById(`landing-story-anchor-${storyModules[index]?.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <section id="modulos" ref={sectionRef} className="landing-story">
      <div className="landing-shell landing-story__layout">
        <div className="landing-story__visual-column">
          <div className="landing-story__sticky">
            <div className="landing-story__sticky-label">
              <span>ESCENA ACTIVA · PALMYRA</span>
              <b>{String(activeIndex + 1).padStart(2, "0")} / {String(storyModules.length).padStart(2, "0")}</b>
            </div>

            <div className="landing-story__stage-frame" aria-live="polite">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={active.id}
                  className="landing-story__scene-transition"
                  initial={{
                    opacity: 0,
                    y: 70,
                    scale: 0.86,
                    rotateX: 8,
                    rotateY: -7,
                    filter: "blur(10px)",
                  }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    scale: 1,
                    rotateX: 0,
                    rotateY: -2,
                    filter: "blur(0px)",
                  }}
                  exit={{
                    opacity: 0,
                    y: -55,
                    scale: 1.045,
                    rotateX: -4,
                    rotateY: 6,
                    filter: "blur(8px)",
                  }}
                  transition={{
                    duration: 0.62,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                >
                  <ProductScene module={active} />
                </motion.div>
              </AnimatePresence>

              <div
                className="landing-story__stage-glow"
                style={{ opacity: 0.55 + sectionProgress * 0.3 }}
                aria-hidden="true"
              />
            </div>

            <div className="landing-story__progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${sectionProgress})` }} />
            </div>

            <div className="landing-story__stage-caption">
              <span>{active.eyebrow}</span>
              <strong>{active.label} · {active.title}</strong>
            </div>
          </div>
        </div>

        <div className="landing-story__chapters">
          <div className="landing-story__intro">
            <div>
              <p className="landing-eyebrow">UN MENÚ. TODO TU NEGOCIO.</p>
              <h2>Conoce cada área.<br /><span>Mientras avanzas.</span></h2>
            </div>
            <p>
              No tienes que pulsar para ver el producto. Sigue bajando y cada capítulo toma el escenario,
              cambia la pantalla y continúa la historia de PALMYRA.
            </p>
          </div>

          <div className="landing-story__tabs" role="tablist" aria-label="Áreas de PALMYRA">
            {landingModules.map((module) => {
              const storyIndex = storyModules.findIndex((item) => item.id === module.id);
              const Icon = module.icon;
              const selected = module.id === active.id;

              return (
                <button
                  key={module.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={selected ? "is-active" : ""}
                  onClick={() => storyIndex >= 0 ? selectModule(storyIndex) : undefined}
                >
                  <Icon size={14} />
                  <span>{module.label}</span>
                </button>
              );
            })}
          </div>

          <div className="landing-story__chapter-list">
            {storyModules.map((module, index) => {
              const selected = index === activeIndex;

              return (
                <article
                  key={module.id}
                  id={`landing-story-anchor-${module.id}`}
                  data-story-id={module.id}
                  data-story-index={index}
                  className={`landing-story__chapter${selected ? " is-active" : ""}`}
                >
                  <div className="landing-story__chapter-index">{String(index + 1).padStart(2, "0")}</div>
                  <div className="landing-story__chapter-copy">
                    <p className="landing-eyebrow">{module.eyebrow}</p>
                    <h3>{module.title}</h3>
                    <p>{module.description}</p>
                    <button type="button" onClick={() => selectModule(index)}>
                      Ver esta pantalla <ArrowRight size={14} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="landing-story__scroll-hint">
            <ArrowDown size={13} />
            <span>Continúa bajando: las pantallas cambian automáticamente</span>
          </div>
        </div>
      </div>
    </section>
  );
}
