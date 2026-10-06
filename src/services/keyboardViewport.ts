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
      rect.width >= window.innerWidth * 0.9
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

function moveModalIntoVisualViewport(surface: HTMLElement, viewportTop: number, viewportHeight: number) {
  const rect = surface.getBoundingClientRect();
  const safeTop = viewportTop + EDGE_MARGIN_PX;
  const safeBottom = viewportTop + viewportHeight - EDGE_MARGIN_PX;
  let offset = 0;

  if (rect.bottom > safeBottom) offset = safeBottom - rect.bottom;
  if (rect.top + offset < safeTop) offset += safeTop - (rect.top + offset);

  const previousOffset = Number(surface.dataset.keyboardOffset || '0');
  if (Math.abs(offset - previousOffset) > 1) {
    surface.style.transform = `translate3d(0, ${Math.round(offset)}px, 0)`;
    surface.dataset.keyboardOffset = String(Math.round(offset));
  }
  surface.style.transition = 'none';
  surface.style.willChange = 'transform';
}

function clearModalPlacement(surface: HTMLElement | null) {
  if (!surface) return;
  surface.style.removeProperty('transform');
  surface.style.removeProperty('transition');
  surface.style.removeProperty('will-change');
  delete surface.dataset.keyboardOffset;
}

function scrollControlIntoViewport(control: HTMLElement) {
  const { top: viewportTop, height: viewportHeight } = getVisualViewportMetrics();
  const viewportBottom = viewportTop + viewportHeight - EDGE_MARGIN_PX;
  const viewportTopSafe = viewportTop + EDGE_MARGIN_PX;

  let ancestor = control.parentElement;
  while (ancestor) {
    if (isScrollable(ancestor)) {
      const rect = control.getBoundingClientRect();
      let delta = 0;
      if (rect.bottom > viewportBottom) delta = rect.bottom - viewportBottom;
      else if (rect.top < viewportTopSafe) delta = rect.top - viewportTopSafe;

      if (Math.abs(delta) > 1) {
        const maxScrollTop = Math.max(0, ancestor.scrollHeight - ancestor.clientHeight);
        ancestor.scrollTop = Math.min(
          maxScrollTop,
          Math.max(0, ancestor.scrollTop + delta),
        );
      }

      const nextRect = control.getBoundingClientRect();
      if (nextRect.top >= viewportTopSafe && nextRect.bottom <= viewportBottom) return;
    }
    ancestor = ancestor.parentElement;
  }

  control.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
}

export function initKeyboardViewport() {
  let scheduled = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let activeModalSurface: HTMLElement | null = null;
  let lastFocusedControl: HTMLElement | null = null;
  let keyboardWasOpen = false;
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
    document.documentElement.style.setProperty('--keyboard-inset', `${metrics.keyboardInset}px`);
    document.documentElement.style.setProperty('--keyboard-viewport-height', `${Math.max(1, Math.round(metrics.height))}px`);
    document.documentElement.style.setProperty('--keyboard-viewport-top', `${Math.max(0, Math.round(metrics.top))}px`);
    document.documentElement.style.setProperty('--pos-visual-height', `${Math.max(1, Math.round(metrics.height))}px`);
    document.documentElement.style.setProperty('--pos-viewport-top', `${Math.max(0, Math.round(metrics.top))}px`);

    const control = document.activeElement;
    const validControl = isFormControl(control) ? control : null;

    if (!validControl) {
      document.body.classList.remove('keyboard-open');
      document.documentElement.classList.remove('pos-keyboard-open');
      restoreScrollContainers();
      clearModalPlacement(activeModalSurface);
      activeModalSurface?.classList.remove('keyboard-modal-surface');
      activeModalSurface = null;
      lastFocusedControl = null;
      keyboardWasOpen = false;
      return;
    }

    const keyboardOpen = metrics.keyboardInset > 0;
    const focusChanged = validControl !== lastFocusedControl;
    const keyboardJustOpened = keyboardOpen && !keyboardWasOpen;

    document.body.classList.toggle('keyboard-open', keyboardOpen);
    document.documentElement.classList.toggle(
      'pos-keyboard-open',
      keyboardOpen && Boolean(validControl?.closest('.pos-page')),
    );

    if (activeModalSurface) {
      activeModalSurface.classList.remove('keyboard-modal-surface');
      clearModalPlacement(activeModalSurface);
      activeModalSurface = null;
    }

    if (isNativeKeyboardViewport(validControl)) {
      restoreScrollContainers();
      return;
    }

    restoreScrollContainers();

    let scrollContainer = validControl.parentElement;
    const scrollPadding = `${metrics.keyboardInset + 24}px`;
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
    activeModalSurface = modalSurface;

    if (modalSurface) {
      modalSurface.classList.add('keyboard-modal-surface');
      if (metrics.keyboardInset > 0) {
        moveModalIntoVisualViewport(modalSurface, metrics.top, metrics.height);
      }
    }

    if (focusChanged || keyboardJustOpened) {
      scrollControlIntoViewport(validControl);
    }

    lastFocusedControl = validControl;
    keyboardWasOpen = keyboardOpen;
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(applyViewportState);
  };

  const settle = () => {
    schedule();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(schedule, 180);
  };

  const clearDelayedRuns = () => {
    for (const timer of delayedRuns) clearTimeout(timer);
    delayedRuns = [];
  };

  const handleFocusIn = (event: FocusEvent) => {
    if (isFormControl(event.target as Element | null)) settle();
  };

  const handleFocusOut = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!isFormControl(document.activeElement)) {
        document.body.classList.remove('keyboard-open');
        document.documentElement.classList.remove('pos-keyboard-open');
        restoreScrollContainers();
        clearModalPlacement(activeModalSurface);
        activeModalSurface?.classList.remove('keyboard-modal-surface');
        activeModalSurface = null;
        lastFocusedControl = null;
        keyboardWasOpen = false;
      }
    }, 120);
  };

  const handleViewportResize = () => settle();

  document.addEventListener('focusin', handleFocusIn);
  document.addEventListener('focusout', handleFocusOut);
  window.visualViewport?.addEventListener('resize', handleViewportResize);

  schedule();

  return () => {
    document.removeEventListener('focusin', handleFocusIn);
    document.removeEventListener('focusout', handleFocusOut);
    window.visualViewport?.removeEventListener('resize', handleViewportResize);
    clearDelayedRuns();
    if (settleTimer) clearTimeout(settleTimer);
    clearModalPlacement(activeModalSurface);
    activeModalSurface?.classList.remove('keyboard-modal-surface');
    document.body.classList.remove('keyboard-open');
    document.documentElement.classList.remove('pos-keyboard-open');
    document.documentElement.style.removeProperty('--keyboard-inset');
    document.documentElement.style.removeProperty('--keyboard-viewport-height');
    document.documentElement.style.removeProperty('--keyboard-viewport-top');
    document.documentElement.style.removeProperty('--pos-visual-height');
    document.documentElement.style.removeProperty('--pos-viewport-top');
    restoreScrollContainers();
  };
}
