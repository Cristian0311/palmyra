import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheck, RotateCcw, Sparkles, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useStore } from "../../store/useStore";
import { getAccessibleNumaTourSteps, type NumaTourStep } from "./palmiGuideSteps";
import { PalmiMascot } from "./PalmiMascot";
import "./palmiGuide.css";
import PWAInstallPrompt from "./PWAInstallPrompt";

type Phase = "action" | "explain";
type Position = { top: number; left: number; width: number };

const GUIDE_KEY = "palmyra-numa-guide-v6";
const SAFE = 14;
const GAP = 14;

function compactViewport() {
  return typeof window !== "undefined" && window.innerWidth < 1024;
}

function storageKey(userId: string, suffix: string) {
  return `${GUIDE_KEY}:${userId}:${suffix}`;
}

function wasDismissed(userId: string) {
  try {
    return localStorage.getItem(storageKey(userId, "dismissed")) === "1" || Boolean(localStorage.getItem(storageKey(userId, "completed")));
  } catch {
    return false;
  }
}

function findTarget(selectors?: string[]) {
  if (!selectors?.length) return null;
  for (const selector of selectors) {
    try {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) return target;
    } catch {
      // Ignore invalid selectors and continue with the next candidate.
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function getPanelWidth() {
  if (typeof window === "undefined") return 360;
  return Math.min(compactViewport() ? 350 : 430, Math.max(280, window.innerWidth - SAFE * 2));
}

export default function PalmiGuide() {
  const currentUser = useStore((state) => state.currentUser);
  const darkMode = useStore((state) => state.storeConfig.darkMode);
  const location = useLocation();
  const [isCompact, setIsCompact] = useState(compactViewport);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("explain");
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [panelPosition, setPanelPosition] = useState<Position>({ top: SAFE, left: SAFE, width: getPanelWidth() });
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const dragRef = useRef({ active: false, moved: false, pointerId: -1, offsetX: 0, offsetY: 0 });

  const steps = useMemo(() => getAccessibleNumaTourSteps(currentUser), [currentUser]);
  const step: NumaTourStep | undefined = steps[index];
  const isActionStep = Boolean(step?.navTarget && phase === "action");
  const progress = steps.length > 1 ? ((index + 1) / steps.length) * 100 : 100;
  const isLast = index === steps.length - 1;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const onChange = () => setIsCompact(media.matches);
    onChange();
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  const setSafePanelPosition = useCallback((rect: DOMRect | null) => {
    if (typeof window === "undefined") return;

    const width = getPanelWidth();
    const panel = panelRef.current;
    const measuredHeight = panel?.getBoundingClientRect().height || (isCompact ? Math.min(320, window.innerHeight * 0.42) : 340);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (!rect) {
      setPanelPosition({
        width,
        left: clamp(viewportWidth - width - SAFE, SAFE, viewportWidth - width - SAFE),
        top: clamp(viewportHeight - measuredHeight - SAFE, SAFE, viewportHeight - measuredHeight - SAFE)
      });
      return;
    }

    const candidates: Position[] = [
      { width, left: rect.left + rect.width / 2 - width / 2, top: rect.top - measuredHeight - GAP },
      { width, left: rect.left + rect.width / 2 - width / 2, top: rect.bottom + GAP },
      { width, left: rect.right + GAP, top: rect.top + rect.height / 2 - measuredHeight / 2 },
      { width, left: rect.left - width - GAP, top: rect.top + rect.height / 2 - measuredHeight / 2 }
    ];

    const fits = candidates.find(candidate =>
      candidate.left >= SAFE &&
      candidate.top >= SAFE &&
      candidate.left + width <= viewportWidth - SAFE &&
      candidate.top + measuredHeight <= viewportHeight - SAFE
    );

    const fallback = candidates
      .map(candidate => ({
        ...candidate,
        overflow:
          Math.max(0, SAFE - candidate.left) +
          Math.max(0, SAFE - candidate.top) +
          Math.max(0, candidate.left + width - (viewportWidth - SAFE)) +
          Math.max(0, candidate.top + measuredHeight - (viewportHeight - SAFE))
      }))
      .sort((a, b) => a.overflow - b.overflow)[0];

    const chosen = fits || fallback;
    setPanelPosition({
      width,
      left: clamp(chosen.left, SAFE, Math.max(SAFE, viewportWidth - width - SAFE)),
      top: clamp(chosen.top, SAFE, Math.max(SAFE, viewportHeight - measuredHeight - SAFE))
    });
  }, [isCompact]);

  const locate = useCallback(() => {
    if (!open || !step) {
      setTargetRect(null);
      return;
    }

    if (step.navTarget && isCompact) {
      window.dispatchEvent(new Event("palmyra:open-sidebar"));
    }

    let attempts = 0;
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      const selectors = isActionStep ? step.target : (step.contentTarget || step.target);
      const target = findTarget(selectors);
      if (target) {
        target.scrollIntoView({
          behavior: "smooth",
          block: step.navTarget && isCompact ? "nearest" : "center",
          inline: "nearest"
        });

        window.setTimeout(() => {
          if (cancelled) return;
          const latest = findTarget(step.target);
          const nextRect = latest?.getBoundingClientRect() || null;
          setTargetRect(nextRect);
          setSafePanelPosition(nextRect);
        }, 180);
        return;
      }

      if (++attempts < 35) {
        window.setTimeout(poll, 90);
      } else {
        setTargetRect(null);
        setSafePanelPosition(null);
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [open, step, isCompact, isActionStep, setSafePanelPosition]);

  useEffect(() => locate(), [locate, location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;

    const refresh = () => {
      const selectors = isActionStep ? step?.target : (step?.contentTarget || step?.target);
      const target = findTarget(selectors);
      const nextRect = target?.getBoundingClientRect() || null;
      setTargetRect(nextRect);
      setSafePanelPosition(nextRect);
    };

    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [open, step, isActionStep, setSafePanelPosition]);

  useEffect(() => {
    if (!currentUser || steps.length < 2 || wasDismissed(currentUser.id)) return;

    const timer = window.setTimeout(() => {
      setIndex(0);
      setPhase("explain");
      setOpen(true);
    }, 900);

    return () => window.clearTimeout(timer);
  }, [currentUser?.id, steps.length]);

  useEffect(() => {
    const onOpen = () => {
      setIndex(0);
      setPhase("explain");
      setOpen(true);
    };
    window.addEventListener("palmyra:open-guide", onOpen);
    return () => window.removeEventListener("palmyra:open-guide", onOpen);
  }, []);

  useEffect(() => {
    if (!open || !isActionStep || !step?.target?.length) return;

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const hit = step.target?.some(selector => {
        try {
          return Boolean(target.closest(selector));
        } catch {
          return false;
        }
      });
      if (!hit) return;

      window.setTimeout(() => {
        setPhase("explain");
        setTargetRect(null);
      }, 280);
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [open, isActionStep, step?.id, step?.target]);

  const prepareStep = (nextIndex: number) => {
    const next = steps[nextIndex];
    setIndex(nextIndex);
    setPhase(next?.navTarget ? "action" : "explain");
    setTargetRect(null);
  };

  const goNext = () => {
    if (isActionStep) return;
    const next = Math.min(index + 1, steps.length - 1);
    const nextStep = steps[next];

    prepareStep(next);
  };

  const goPrevious = () => {
    if (index === 0) return;
    const prev = index - 1;
    const prevStep = steps[prev];

    prepareStep(prev);
  };

  const close = () => {
    if (currentUser) {
      try {
        localStorage.setItem(storageKey(currentUser.id, "dismissed"), "1");
      } catch {
        // Ignore local storage errors.
      }
    }
    setOpen(false);
    setTargetRect(null);
  };

  const finish = () => {
    if (currentUser) {
      try {
        localStorage.setItem(storageKey(currentUser.id, "completed"), new Date().toISOString());
      } catch {
        // Ignore local storage errors.
      }
    }
    setOpen(false);
    setTargetRect(null);
    setShowInstallPrompt(true);
    window.dispatchEvent(new Event("palmyra:tutorial-finished"));
  };

  const reset = () => {
    if (currentUser) {
      try {
        localStorage.removeItem(storageKey(currentUser.id, "dismissed"));
        localStorage.removeItem(storageKey(currentUser.id, "completed"));
      } catch {
        // Ignore local storage errors.
      }
    }
    setIndex(0);
    setPhase("explain");
    setOpen(true);
  };

  const onMascotDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onMascotMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.movementX) + Math.abs(event.movementY) > 1) drag.moved = true;
    // Deliberately keep the mascot dock fixed: dragging is no longer used to
    // reposition the help panel and therefore cannot create off-screen layouts.
  };

  const onMascotUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    drag.active = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Ignore pointer release errors.
    }
    if (!drag.moved) setOpen(true);
  };

  if (!currentUser || steps.length === 0) return null;

  const title = isActionStep ? "Encuentra esta opción" : step?.title || "NUMA";
  const instruction = isActionStep
    ? `Está resaltada en el menú. Pulsa esa opción para que te lleve allí.`
    : step?.message || "";
  const isSpotlightVisible = Boolean(open && targetRect);
  const mascotMood = !open ? "idle" : isActionStep ? "waiting" : isLast ? "success" : step?.id === "offline" ? "alert" : "thinking";

  return (
    <div className="palmi-guide-root">
      {isSpotlightVisible ? (
        <div
          className={`palmi-guide-spotlight ${isActionStep ? "is-command" : "is-content"}`}
          style={{
            top: Math.max(4, targetRect!.top - 7),
            left: Math.max(4, targetRect!.left - 7),
            width: Math.min(window.innerWidth - 8, targetRect!.width + 14),
            height: Math.min(window.innerHeight - 8, targetRect!.height + 14)
          }}
          aria-hidden="true"
        />
      ) : null}

      {isActionStep && targetRect ? (
        <div
          className="palmi-action-cue"
          style={{
            top: Math.max(SAFE, targetRect.top - 38),
            left: clamp(targetRect.left, SAFE, Math.max(SAFE, window.innerWidth - 175))
          }}
          aria-hidden="true"
        >
          <span className="palmi-action-cue-label">PULSA AQUÍ</span>
          <span className="palmi-action-cue-arrow">↓</span>
        </div>
      ) : null}

      {open ? (
        <div
          ref={panelRef}
          className={`palmi-guide-panel ${darkMode ? "dark " : ""}${isActionStep ? "is-command" : "is-explain"}`}
          style={{ top: panelPosition.top, left: panelPosition.left, width: panelPosition.width }}
          role="dialog"
          aria-modal="false"
          aria-label="NUMA, guía contextual de PALMYRA"
          aria-live="polite"
        >
          <div className="palmi-guide-brandbar">
            <div className="palmi-guide-brand">
              <div className="palmi-guide-brand-orb"><Sparkles className="w-3.5 h-3.5" /></div>
              <div>
                <p>PALMYRA · NUMA</p>
                <span>Asistente contextual</span>
              </div>
            </div>
            <button type="button" className="palmi-guide-close" onClick={close} aria-label="Cerrar NUMA">
              <X size={16} />
            </button>
          </div>

          <div className="palmi-guide-hero">
            <div className="palmi-guide-mini-mascot">
              <PalmiMascot className="palmi-guide-mascot-small" mood={mascotMood} />
            </div>
            <div className="min-w-0">
              <p className="palmi-guide-eyebrow">{step?.eyebrow}</p>
              <h2 className="palmi-guide-title">{title}</h2>
              <p className="palmi-guide-current">{isActionStep ? "Acción guiada" : `Paso ${index + 1} de ${steps.length}`}</p>
            </div>
            <div className="palmi-guide-step-pill">{index + 1}<span>/</span>{steps.length}</div>
          </div>

          <div className="palmi-guide-progress">
            <div className="palmi-guide-progress-track">
              <div className="palmi-guide-progress-fill" style={{ width: progress + "%" }} />
            </div>
          </div>

          {isActionStep ? (
            <div className="palmi-guide-command">
              <div className="palmi-command-badge"><Sparkles className="w-3.5 h-3.5" /> ENCUÉNTRALO</div>
              <div className="palmi-command-title">{instruction}</div>
              <div className="palmi-command-status"><span className="palmi-pulse-dot" /> NUMA está esperando tu acción</div>
            </div>
          ) : (
            <div className="palmi-guide-body">
              {index === 0 ? <div className="palmi-welcome-line">NUMA te acompaña. Tú sigues teniendo el control.</div> : null}
              <div className="palmi-guide-message">{instruction}</div>
              {step?.tip ? <div className="palmi-guide-tip"><strong>Consejo</strong><span>{step.tip}</span></div> : null}
            </div>
          )}

          <div className="palmi-guide-footer">
            <button type="button" className="palmi-guide-secondary" onClick={close}>Cerrar</button>
            <div className="palmi-guide-actions">
              <button type="button" className="palmi-guide-back" onClick={goPrevious} disabled={index === 0} aria-label="Paso anterior">
                <ChevronLeft size={15} /> Atrás
              </button>
              {isLast ? (
                <button type="button" className="palmi-guide-primary" onClick={finish}>
                  <CircleCheck className="w-4 h-4" /> Terminar
                </button>
              ) : (
                <button type="button" className={`palmi-guide-primary ${isActionStep ? "is-disabled" : ""}`} onClick={goNext} disabled={isActionStep}>
                  Entendido <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="palmi-guide-mascot-dock" onPointerDown={onMascotDown} onPointerMove={onMascotMove} onPointerUp={onMascotUp} onPointerCancel={onMascotUp} aria-label="Abrir NUMA" role="button" tabIndex={0} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpen(true);
        }
      }}>
        <span className="palmi-aura palmi-aura-1" />
        <span className="palmi-aura palmi-aura-2" />
        <span className="palmi-spark palmi-spark-1">✦</span>
        <span className="palmi-spark palmi-spark-2">✦</span>
        <span className="palmi-mascot-stage">
          <PalmiMascot className="palmi-guide-mascot" mood={mascotMood} />
        </span>
        <span className="palmi-guide-name">NUMA</span>
      </div>

      {open ? (
        <button type="button" className="palmi-guide-reset" onClick={reset} aria-label="Reiniciar guía" title="Reiniciar guía">
          <RotateCcw size={13} />
        </button>
      ) : null}

      <PWAInstallPrompt visible={showInstallPrompt} onClose={() => setShowInstallPrompt(false)} />
    </div>
  );
}
