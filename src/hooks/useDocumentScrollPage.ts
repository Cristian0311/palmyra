import { useEffect } from "react";

const SCROLL_CLASS = "palmyra-scroll-page";

/**
 * Public routes (landing, auth, onboarding...) are document-length pages.
 * The app shell keeps #root fixed at 100dvh for the POS; this hook opts the
 * document root back into normal vertical scrolling and restores it on exit.
 */
export function useDocumentScrollPage() {
  useEffect(() => {
    const elements = [document.documentElement, document.body, document.getElementById("root")]
      .filter((el): el is HTMLElement => Boolean(el));
    const previous = elements.map((el) => ({
      el,
      overflow: el.style.overflow,
      overflowY: el.style.overflowY,
      height: el.style.height,
      touchAction: el.style.touchAction,
    }));

    elements.forEach((el) => el.classList.add(SCROLL_CLASS));

    const [html, body, root] = elements as [HTMLElement, HTMLElement, HTMLElement | undefined];
    html.style.overflow = "auto";
    html.style.height = "auto";
    body.style.overflow = "visible";
    body.style.overflowY = "auto";
    body.style.height = "auto";
    body.style.touchAction = "pan-y";
    if (root) {
      root.style.overflow = "visible";
      root.style.overflowY = "auto";
      root.style.height = "auto";
    }

    return () => {
      elements.forEach((el) => el.classList.remove(SCROLL_CLASS));
      previous.forEach(({ el, overflow, overflowY, height, touchAction }) => {
        el.style.overflow = overflow;
        el.style.overflowY = overflowY;
        el.style.height = height;
        el.style.touchAction = touchAction;
      });
    };
  }, []);
}
