const FORM_CONTROL_SELECTOR = 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
const KEYBOARD_THRESHOLD_PX = 120;
const EDGE_MARGIN_PX = 18;

function isFormControl(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.matches(FORM_CONTROL_SELECTOR);
}

function isNativeKeyboardViewport(element: Element | null) {
  return element instanceof HTMLElement && Boolean(element.closest('[data-keyboard-viewport="native"]'));
}

function isScrollable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
}

function getVisualViewportMetrics() {
  const viewport = window.visualViewport;
  if (!viewport) {
    return {
      top: 0,
      height: window.innerHeight,
      keyboardInset: 0,
    };
  }

  const keyboardInset = Math.max(
    0,
    Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
  );

  return {
    top: viewport.offsetTop,
    height: viewport.height,
    keyboardInset: keyboardInset >= KEYBOARD_THRESHOLD_PX ? keyboardInset : 0,
  };
}

function getFixedOverlay(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;

  while (current) {
    const style = window.getComputedStyle(current);
    const rect = current.getBoundingClientRect();

    if (
      style.position === 'fixed' &&
      rect.top <= 2 &&
      rect.left <= 2 &&
      rect.width >= window.innerWidth * 0.9 &&
      rect.height >= window.innerHeight * 0.9
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function getModalSurface(element: HTMLElement, overlay: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;

  while (current && current.parentElement && current.parentElement !== overlay) {
    current = current.parentElement;
  }

  return current && current.parentElement === overlay ? current : null;
}

function scrollControlIntoViewport(control: HTMLElement) {
  const { top: viewportTop, height: viewportHeight } = getVisualViewportMetrics();
  const viewportBottom = viewportTop + viewportHeight - EDGE_MARGIN_PX;
  const viewportTopSafe = viewportTop + EDGE_MARGIN_PX;

  let ancestor = control.parentElement;
  let foundScrollableAncestor = false;

  while (ancestor) {
    if (isScrollable(ancestor)) {
      foundScrollableAncestor = true;
      const rect = control.getBoundingClientRect();

      let delta = 0;
      if (rect.bottom > viewportBottom) {
        delta = rect.bottom - viewportBottom;
      } else if (rect.top < viewportTopSafe) {
        delta = rect.top - viewportTopSafe;
      }

      if (Math.abs(delta) > 1) {
        const maxScrollTop = Math.max(0, ancestor.scrollHeight - ancestor.clientHeight);
        const nextScrollTop = Math.min(
          maxScrollTop,
          Math.max(0, ancestor.scrollTop + delta),
        );
        ancestor.scrollTop = nextScrollTop;
      }

      const nextRect = control.getBoundingClientRect();
      if (nextRect.top >= viewportTopSafe && nextRect.bottom <= viewportBottom) {
        return;
      }
    }

    ancestor = ancestor.parentElement;
  }

  if (!foundScrollableAncestor) {
    control.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'auto',
    });
  }
}

export function initKeyboardViewport() {
  let scheduled = false;
  let activeModalSurface: HTMLElement | null = null;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let delayedRuns: ReturnType<typeof setTimeout>[] = [];
  const touchedScrollContainers = new Map<HTMLElement, string>();

  const restoreScrollContainers = () => {
    for (const [element, previousValue] of touchedScrollContainers) {
      element.style.scrollPaddingBottom = previousValue;
    }
    touchedScrollContainers.clear();
  };

  const applyViewportState = () => {
    scheduled = false;

    const metrics = getVisualViewportMetrics();
    document.documentElement.style.setProperty(
      '--keyboard-inset',
      `${metrics.keyboardInset}px`,
    );
    document.documentElement.style.setProperty(
      '--keyboard-viewport-height',
      `${Math.max(1, Math.round(metrics.height))}px`,
    );

    const control = document.activeElement;
    const validControl = isFormControl(control) ? control : null;

    if (!validControl) {
      document.body.classList.remove('keyboard-open');
      restoreScrollContainers();
      if (activeModalSurface) {
        activeModalSurface.classList.remove('keyboard-modal-surface');
        activeModalSurface = null;
      }
      return;
    }

    document.body.classList.toggle('keyboard-open', metrics.keyboardInset > 0);

    if (isNativeKeyboardViewport(validControl)) {
      restoreScrollContainers();
      if (activeModalSurface) {
        activeModalSurface.classList.remove('keyboard-modal-surface');
        activeModalSurface = null;
      }
      return;
    }

    restoreScrollContainers();

    let scrollContainer = validControl.parentElement;
    const scrollPadding = `${metrics.keyboardInset + 28}px`;

    while (scrollContainer) {
      if (isScrollable(scrollContainer)) {
        touchedScrollContainers.set(
          scrollContainer,
          scrollContainer.style.scrollPaddingBottom,
        );
        scrollContainer.style.scrollPaddingBottom = scrollPadding;
      }
      scrollContainer = scrollContainer.parentElement;
    }

    const overlay = getFixedOverlay(validControl);
    const modalSurface = overlay ? getModalSurface(validControl, overlay) : null;

    if (activeModalSurface && activeModalSurface !== modalSurface) {
      activeModalSurface.classList.remove('keyboard-modal-surface');
    }

    activeModalSurface = modalSurface;
    activeModalSurface?.classList.add('keyboard-modal-surface');

    scrollControlIntoViewport(validControl);
  };

  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(applyViewportState);
    }
  };

  const clearDelayedRuns = () => {
    for (const timer of delayedRuns) clearTimeout(timer);
    delayedRuns = [];
  };

  const scheduleKeyboardSettle = () => {
    schedule();
    clearDelayedRuns();

    delayedRuns = [
      setTimeout(schedule, 60),
      setTimeout(schedule, 180),
      setTimeout(schedule, 360),
    ];
  };

  const handleFocusIn = (event: FocusEvent) => {
    if (isFormControl(event.target as Element | null)) {
      scheduleKeyboardSettle();
    }
  };

  const handleFocusOut = () => {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      if (!isFormControl(document.activeElement)) {
        document.body.classList.remove('keyboard-open');
        restoreScrollContainers();
        if (activeModalSurface) {
          activeModalSurface.classList.remove('keyboard-modal-surface');
          activeModalSurface = null;
        }
      } else {
        scheduleKeyboardSettle();
      }
    }, 80);
  };

  const handleViewportResize = () => {
    scheduleKeyboardSettle();
  };

  const handleViewportScroll = () => {
    schedule();
  };

  document.addEventListener('focusin', handleFocusIn);
  document.addEventListener('focusout', handleFocusOut);
  window.visualViewport?.addEventListener('resize', handleViewportResize);
  window.visualViewport?.addEventListener('scroll', handleViewportScroll);

  schedule();

  return () => {
    document.removeEventListener('focusin', handleFocusIn);
    document.removeEventListener('focusout', handleFocusOut);
    window.visualViewport?.removeEventListener('resize', handleViewportResize);
    window.visualViewport?.removeEventListener('scroll', handleViewportScroll);
    clearDelayedRuns();
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (activeModalSurface) activeModalSurface.classList.remove('keyboard-modal-surface');
    document.body.classList.remove('keyboard-open');
    document.documentElement.style.removeProperty('--keyboard-inset');
    document.documentElement.style.removeProperty('--keyboard-viewport-height');
    restoreScrollContainers();
  };
}
