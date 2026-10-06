import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheck, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useStore } from "../../store/useStore";
import { getAccessibleNumaTourSteps, type NumaTourStep } from "./palmiGuideSteps";
import { PalmiMascot } from "./PalmiMascot";
import "./palmiGuide.css";
import PwaInstallPrompt from "./PwaInstallPrompt";

type Phase = "action" | "explain";
type Position = { top: number; left: number; width: number };

const GUIDE_KEY = "palmyra-numa-guide-v8";
const SAFE = 14;
const TOP_SAFE = 68;
const BOTTOM_SAFE = 22;
const GAP = 14;
const SIDEBAR_GAP = 18;

function compactViewport() {
  return typeof window !== "undefined" && window.innerWidth < 1024;
}

function storageKey(userId: string, suffix: string) {
  return `${GUIDE_KEY}:${userId}:${suffix}`;
}

function wasDismissed(userId: string) {
  try {
    return Boolean(
      localStorage.getItem(storageKey(userId, "dismissed")) ||
      localStorage.getItem(storageKey(userId, "completed"))
    );
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

function findContentTarget(step: NumaTourStep) {
  return (
    findTarget(step.contentTarget) ||
    findTarget([
      '[data-palmi-page-title]',
      "main h1",
      'main [role="heading"][aria-level="1"]',
      'main [role="heading"]'
    ])
  );
}

function findSidebarRect() {
  return document.querySelector<HTMLElement>("[data-palmy-sidebar]")?.getBoundingClientRect() || null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function getPanelWidth() {
  if (typeof window === "undefined") return 360;

  return Math.min(
    compactViewport() ? 360 : 430,
    Math.max(282, window.innerWidth - SAFE * 2)
  );
}

function isCurrentRoute(route?: string, pathname = "") {
  if (!route) return true;
  if (route === "/") return pathname === "/";
  return pathname === route || pathname.startsWith(`${route}/`);
}

export default function PalmiGuide() {
  const currentUser = useStore((state) => state.currentUser);
  const darkMode = useStore((state) => state.storeConfig.darkMode);
  const location = useLocation();
  const navigate = useNavigate();

  const [isCompact, setIsCompact] = useState(compactViewport);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("explain");
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [panelPosition, setPanelPosition] = useState<Position>({
    top: TOP_SAFE,
    left: SAFE,
    width: getPanelWidth()
  });
  const [posGateOpen, setPosGateOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const steps = useMemo(
    () => getAccessibleNumaTourSteps(currentUser),
    [currentUser]
  );
  const step: NumaTourStep | undefined = steps[index];
  const isActionStep = Boolean(step?.navTarget && phase === "action");
  const progress = steps.length > 1 ? ((index + 1) / steps.length) * 100 : 100;
  const isLast = index === steps.length - 1;
  const routeAlreadyOpen = isCurrentRoute(step?.route, location.pathname);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const onChange = () => setIsCompact(media.matches);

    onChange();
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (!open || step?.id !== "pos") {
      setPosGateOpen(false);
      return;
    }

    const refresh = () => {
      setPosGateOpen(Boolean(document.querySelector('[data-palmi-pos-gate="open"]')));
    };

    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, step?.id]);

  const setSafePanelPosition = useCallback(
    (rect: DOMRect | null) => {
      if (typeof window === "undefined") return;

      const width = getPanelWidth();
      const panel = panelRef.current;
      const measuredHeight =
        panel?.getBoundingClientRect().height ||
        (isCompact ? Math.min(440, window.innerHeight * 0.55) : 360);
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const topLimit = Math.max(TOP_SAFE, viewportHeight - measuredHeight - BOTTOM_SAFE);

      if (!rect) {
        setPanelPosition({
          width,
          left: clamp(
            viewportWidth - width - SAFE,
            SAFE,
            Math.max(SAFE, viewportWidth - width - SAFE)
          ),
          top: clamp(
            TOP_SAFE,
            TOP_SAFE,
            topLimit
          )
        });
        return;
      }

      const candidates: Position[] = [
        {
          width,
          left: rect.left + rect.width / 2 - width / 2,
          top: rect.top - measuredHeight - GAP
        },
        {
          width,
          left: rect.left + rect.width / 2 - width / 2,
          top: rect.bottom + GAP
        },
        {
          width,
          left: rect.right + GAP,
          top: rect.top + rect.height / 2 - measuredHeight / 2
        },
        {
          width,
          left: rect.left - width - GAP,
          top: rect.top + rect.height / 2 - measuredHeight / 2
        },
        {
          width,
          left: viewportWidth - width - SAFE,
          top: TOP_SAFE
        }
      ];

      const usable = candidates.map((candidate) => {
        const clampedTop = clamp(candidate.top, TOP_SAFE, topLimit);
        const clampedLeft = clamp(
          candidate.left,
          SAFE,
          Math.max(SAFE, viewportWidth - width - SAFE)
        );

        const overlapX =
          Math.max(0, Math.min(candidate.left + width, rect.right) - Math.max(candidate.left, rect.left));
        const overlapY =
          Math.max(0, Math.min(candidate.top + measuredHeight, rect.bottom) - Math.max(candidate.top, rect.top));

        const overflow =
          Math.max(0, SAFE - candidate.left) +
          Math.max(0, SAFE - candidate.top) +
          Math.max(0, candidate.left + width - (viewportWidth - SAFE)) +
          Math.max(0, candidate.top + measuredHeight - (viewportHeight - BOTTOM_SAFE)) +
          overlapX * overlapY * 0.25;

        return { ...candidate, left: clampedLeft, top: clampedTop, overflow };
      });

      const chosen = usable.sort((a, b) => a.overflow - b.overflow)[0];

      setPanelPosition({
        width,
        left: chosen.left,
        top: chosen.top
      });
    },
    [isCompact]
  );

  const locate = useCallback(() => {
    if (!open || !step) {
      setTargetRect(null);
      return;
    }

    if (!isActionStep && step.id === "pos" && posGateOpen) {
      setTargetRect(null);
      return;
    }

    if (isActionStep && isCompact) {
      window.dispatchEvent(new Event("palmyra:open-sidebar"));
    }

    let attempts = 0;
    let cancelled = false;

    const poll = () => {
      if (cancelled) return;

      const target = isActionStep
        ? findTarget(step.target)
        : findContentTarget(step);

      if (target) {
        if (!isActionStep) {
          target.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest"
          });
        }

        window.setTimeout(() => {
          if (cancelled) return;
          const latest = isActionStep
            ? findTarget(step.target)
            : findContentTarget(step);
          const nextRect = latest?.getBoundingClientRect() || null;

          setTargetRect(nextRect);
          if (!isActionStep) {
            setSafePanelPosition(nextRect);
          }
        }, 180);

        return;
      }

      if (++attempts < 40) {
        window.setTimeout(poll, 90);
      } else {
        setTargetRect(null);
        if (!isActionStep) setSafePanelPosition(null);
      }
    };

    poll();

    return () => {
      cancelled = true;
    };
  }, [open, step, isCompact, isActionStep, posGateOpen, setSafePanelPosition]);

  useEffect(() => locate(), [locate, location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;

    const refresh = () => {
      const target = isActionStep
        ? findTarget(step?.target)
        : step
          ? findContentTarget(step)
          : null;
      const nextRect = target?.getBoundingClientRect() || null;

      setTargetRect(nextRect);
      if (!isActionStep) setSafePanelPosition(nextRect);
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
      const firstStep = steps[0];
      setIndex(0);
      setPhase(firstStep?.navTarget && !isCurrentRoute(firstStep.route, location.pathname) ? "action" : "explain");
      setOpen(true);
    }, 900);

    return () => window.clearTimeout(timer);
  }, [currentUser?.id, steps.length]);

  useEffect(() => {
    const onOpen = () => {
      const firstStep = steps[0];
      setIndex(0);
      setPhase(firstStep?.navTarget && !isCurrentRoute(firstStep.route, location.pathname) ? "action" : "explain");
      setOpen(true);
    };

    window.addEventListener("palmyra:open-guide", onOpen);
    return () => window.removeEventListener("palmyra:open-guide", onOpen);
  }, [steps, location.pathname]);

  useEffect(() => {
    if (!open || !isActionStep || !step?.target?.length) return;

    let cancelled = false;
    let phaseTimer: number | null = null;
    let fallbackTimer: number | null = null;
    let retryTimer: number | null = null;

    const handleTargetClick = () => {
      if (cancelled) return;

      // El menú mantiene su navegación nativa. NUMA solo observa el clic.
      phaseTimer = window.setTimeout(() => {
        if (cancelled) return;
        setPhase("explain");
        setTargetRect(null);
      }, 120);

      if (step.route) {
        fallbackTimer = window.setTimeout(() => {
          if (!cancelled && !isCurrentRoute(step.route, window.location.pathname)) {
            navigate(step.route);
          }
        }, 900);
      }
    };

    const matchesTarget = (element: Element | null) => {
      if (!element || !step.target?.length) return false;
      return step.target.some((selector) => {
        try {
          return Boolean(element.closest(selector));
        } catch {
          return false;
        }
      });
    };

    const handleDocumentClick = (event: MouseEvent) => {
      if (cancelled) return;
      const target = event.target instanceof Element ? event.target : null;
      if (matchesTarget(target)) handleTargetClick();
    };

    const bind = () => {
      if (cancelled) return;
      const target = findTarget(step.target);
      if (!target) {
        retryTimer = window.setTimeout(bind, 100);
        return;
      }
      // Delegación a document: sobrevive a los rerenders del sidebar
      // cuando React cambia la clase activa o cierra el drawer móvil.
      document.addEventListener("click", handleDocumentClick, true);
    };

    bind();

    return () => {
      cancelled = true;
      document.removeEventListener("click", handleDocumentClick, true);
      if (phaseTimer !== null) window.clearTimeout(phaseTimer);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [open, isActionStep, step?.id, step?.route, step?.target, navigate]);

  const prepareStep = (nextIndex: number) => {
    const next = steps[nextIndex];
    const needsAction = Boolean(
      next?.navTarget && !isCurrentRoute(next.route, location.pathname)
    );

    setIndex(nextIndex);
    setPhase(needsAction ? "action" : "explain");
    setTargetRect(null);
  };

  const goNext = () => {
    if (isActionStep || isLast) return;
    prepareStep(Math.min(index + 1, steps.length - 1));
  };

  const goPrevious = () => {
    if (index === 0) return;
    prepareStep(index - 1);
  };

  const close = () => {
    if (currentUser) {
      try {
        localStorage.setItem(storageKey(currentUser.id, "dismissed"), new Date().toISOString());
      } catch {
        // Ignore local storage failures.
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
        // Ignore local storage failures.
      }
    }

    setOpen(false);
    setTargetRect(null);
    window.dispatchEvent(new Event("palmyra:tutorial-finished"));
  };

  if (!currentUser || steps.length === 0) return null;

  const actionText =
    step?.action || `Toca “${step?.title || "esta opción"}” en el menú lateral.`;
  const title = isActionStep
    ? `Toca ${step?.title || "esta opción"}`
    : step?.title || "NUMA";
  const instruction = step?.message || "";
  const isSpotlightVisible = Boolean(open && targetRect);
  const mascotMood = !open
    ? "idle"
    : isActionStep
      ? "waiting"
      : isLast
        ? "success"
        : step?.id === "offline"
          ? "alert"
          : "thinking";

  const baseActionWidth = Math.min(
    isCompact ? 200 : 252,
    Math.max(isCompact ? 118 : 198, window.innerWidth - SAFE * 2)
  );
  const actionHintHeight = isCompact ? 112 : 104;
  const sidebarRect = isActionStep ? findSidebarRect() : null;

  const actionPlacement = (() => {
    if (!targetRect) {
      return {
        width: baseActionWidth,
        left: SAFE,
        top: TOP_SAFE,
        side: "top" as const
      };
    }

    if (sidebarRect) {
      const availableWidth = Math.max(
        118,
        Math.min(baseActionWidth, window.innerWidth - sidebarRect.right - SAFE - SIDEBAR_GAP)
      );

      return {
        width: availableWidth,
        left: clamp(
          sidebarRect.right + SIDEBAR_GAP,
          SAFE,
          Math.max(SAFE, window.innerWidth - availableWidth - SAFE)
        ),
        top: clamp(
          targetRect.top + targetRect.height / 2 - actionHintHeight / 2,
          TOP_SAFE,
          Math.max(TOP_SAFE, window.innerHeight - actionHintHeight - BOTTOM_SAFE)
        ),
        side: "right" as const
      };
    }

    const below = {
      width: baseActionWidth,
      left: targetRect.left,
      top: targetRect.bottom + GAP,
      side: "below" as const
    };
    const above = {
      width: baseActionWidth,
      left: targetRect.left,
      top: targetRect.top - actionHintHeight - GAP,
      side: "above" as const
    };
    const right = {
      width: baseActionWidth,
      left: targetRect.right + GAP,
      top: targetRect.top + targetRect.height / 2 - actionHintHeight / 2,
      side: "right" as const
    };

    const candidates = isCompact ? [below, above, right] : [right, below, above];

    return candidates
      .map(candidate => ({
        ...candidate,
        left: clamp(
          candidate.left,
          SAFE,
          Math.max(SAFE, window.innerWidth - candidate.width - SAFE)
        ),
        top: clamp(
          candidate.top,
          TOP_SAFE,
          Math.max(TOP_SAFE, window.innerHeight - actionHintHeight - BOTTOM_SAFE)
        )
      }))
      .sort((a, b) => {
        const overlap = (candidate: typeof a) => {
          const overlapX = Math.max(
            0,
            Math.min(candidate.left + candidate.width, targetRect!.right) -
              Math.max(candidate.left, targetRect!.left)
          );
          const overlapY = Math.max(
            0,
            Math.min(candidate.top + actionHintHeight, targetRect!.bottom) -
              Math.max(candidate.top, targetRect!.top)
          );
          return overlapX * overlapY;
        };
        return overlap(a) - overlap(b);
      })[0];
  })();


  const actionHintLeft = actionPlacement.left;
  const actionHintTop = actionPlacement.top;
  const actionHintWidth = actionPlacement.width;
  const actionHintArrow =
    actionPlacement.side === "right"
      ? "←"
      : actionPlacement.side === "below"
        ? "↑"
        : "↓";

  const onMascotOpen = () => setOpen(true);

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

      {open && isActionStep ? (
        <div
          className="palmi-guide-action-card"
          style={{
            top: actionHintTop,
            left: actionHintLeft,
            width: actionHintWidth
          }}
          aria-live="polite"
          role="status"
        >
          <div className="palmi-action-card-top">
            <span className="palmi-action-card-step">Paso {index + 1} de {steps.length}</span>
            <span className="palmi-action-card-badge">TOCA AQUÍ</span>
          </div>
          <strong>{title}</strong>
          <p>{actionText}</p>
          <span className={`palmi-action-card-arrow ${actionPlacement.side === "right" ? "is-side" : ""}`} aria-hidden="true">{actionHintArrow}</span>
        </div>
      ) : null}

      {open && !isActionStep && !posGateOpen ? (
        <div
          ref={panelRef}
          className={`palmi-guide-panel ${darkMode ? "dark " : ""}${isLast ? "is-finish" : ""}`}
          style={{
            top: panelPosition.top,
            left: panelPosition.left,
            width: panelPosition.width
          }}
          role="dialog"
          aria-modal="false"
          aria-label="NUMA, guía de PALMYRA"
          aria-live="polite"
        >
          <div className="palmi-guide-brandbar">
            <div className="palmi-guide-brand">
              <div className="palmi-guide-brand-mascot">
                <PalmiMascot className="palmi-guide-mascot-small" mood={mascotMood} />
              </div>
              <div>
                <p>PALMYRA · NUMA</p>
                <span>Guía paso a paso</span>
              </div>
            </div>

            <button
              type="button"
              className="palmi-guide-close"
              onClick={close}
              aria-label="Cerrar NUMA"
              title="Cerrar NUMA"
            >
              <X size={16} />
            </button>
          </div>

          <div className="palmi-guide-hero">
            <div className="min-w-0">
              <p className="palmi-guide-eyebrow">{step?.eyebrow}</p>
              <h2 className="palmi-guide-title">{title}</h2>
              <p className="palmi-guide-current">
                {step?.navTarget && !routeAlreadyOpen
                  ? "Preparando la siguiente sección"
                  : index === 0
                    ? "Comencemos"
                    : `Paso ${index + 1} de ${steps.length}`}
              </p>
            </div>

            <div className="palmi-guide-step-pill">
              {index + 1}<span>/</span>{steps.length}
            </div>
          </div>

          <div className="palmi-guide-progress" aria-label={`Progreso: ${Math.round(progress)}%`}>
            <div className="palmi-guide-progress-track">
              <div className="palmi-guide-progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>

          {index > 0 && step?.navTarget ? (
            <div className="palmi-guide-arrival">
              <CircleCheck size={16} />
              <div>
                <strong>Ya estás aquí</strong>
                <span>Ahora te explico qué encontrarás y para qué sirve.</span>
              </div>
            </div>
          ) : null}

          <div className="palmi-guide-body">
            {index === 0 ? (
              <div className="palmi-welcome-line">
                NUMA te acompaña; tú decides qué abrir, tocar y hacer.
              </div>
            ) : null}
            <div className="palmi-guide-message">{instruction}</div>
            {step?.tip ? (
              <div className="palmi-guide-tip">
                <strong>Consejo</strong>
                <span>{step.tip}</span>
              </div>
            ) : null}
          </div>

          <div className="palmi-guide-footer">
            <button type="button" className="palmi-guide-secondary" onClick={close}>
              Cerrar
            </button>

            <div className="palmi-guide-actions">
              <button
                type="button"
                className="palmi-guide-back"
                onClick={goPrevious}
                disabled={index === 0}
                aria-label="Paso anterior"
              >
                <ChevronLeft size={15} />
                Atrás
              </button>

              {isLast ? (
                <button type="button" className="palmi-guide-primary" onClick={finish}>
                  <CircleCheck className="w-4 h-4" />
                  Terminar
                </button>
              ) : (
                <button type="button" className="palmi-guide-primary" onClick={goNext}>
                  Siguiente
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {!open && !posGateOpen ? (
        <button
          type="button"
          className="palmi-guide-mascot-dock"
          onClick={onMascotOpen}
          aria-label="Abrir NUMA"
          title="Abrir NUMA"
        >
          <span className="palmi-aura palmi-aura-1" />
          <span className="palmi-aura palmi-aura-2" />
          <span className="palmi-mascot-stage">
            <PalmiMascot className="palmi-guide-mascot" mood="idle" />
          </span>
          <span className="palmi-guide-name">NUMA</span>
        </button>
      ) : null}

      <PwaInstallPrompt />
    </div>
  );
}
