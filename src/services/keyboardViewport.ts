const FORM_CONTROL_SELECTOR = 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
const KEYBOARD_THRESHOLD_PX = 120;
const SAFE_MARGIN_PX = 16;

function isFormControl(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.matches(FORM_CONTROL_SELECTOR);
}

function isScrollable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
}

function metrics() {
  const viewport = window.visualViewport;
  if (!viewport) return { top: 0, height: window.innerHeight, inset: 0 };
  const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
  return {
    top: Math.max(0, Math.round(viewport.offsetTop)),
    height: Math.max(1, Math.round(viewport.height)),
    inset: inset >= KEYBOARD_THRESHOLD_PX ? inset : 0,
  };
}

function clearState() {
  document.body.classList.remove('keyboard-open');
  document.documentElement.classList.remove('pos-keyboard-open');
  document.documentElement.style.removeProperty('--keyboard-inset');
  document.documentElement.style.removeProperty('--keyboard-viewport-height');
  document.documentElement.style.removeProperty('--keyboard-viewport-top');
}

function findScrollableAncestor(control: HTMLElement): HTMLElement | null {
  let current = control.parentElement;
  while (current) {
    if (isScrollable(current)) return current;
    current = current.parentElement;
  }
  return null;
}

function ensureVisible(control: HTMLElement, current: ReturnType<typeof metrics>) {
  if (!document.contains(control)) return;

  const scroller = findScrollableAncestor(control);
  const viewportBottom = current.top + current.height - SAFE_MARGIN_PX;
  const viewportTop = current.top + SAFE_MARGIN_PX;
  const rect = control.getBoundingClientRect();

  if (scroller) {
    const delta =
      rect.bottom > viewportBottom ? rect.bottom - viewportBottom :
      rect.top < viewportTop ? rect.top - viewportTop : 0;

    if (Math.abs(delta) > 2) {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.max(0, Math.min(max, scroller.scrollTop + delta));
    }
    return;
  }

  // Never call scrollIntoView on every viewport event: it can move the document
  // and trigger another viewport event, producing the "vibrating" mobile UI.
  const pageScroller = document.scrollingElement;
  if (!pageScroller) return;

  const after = control.getBoundingClientRect();
  let delta =
    after.bottom > viewportBottom ? after.bottom - viewportBottom :
    after.top < viewportTop ? after.top - viewportTop : 0;

  if (Math.abs(delta) > 2) {
    pageScroller.scrollTop += delta;
  }
}

export function initKeyboardViewport() {
  let frame = 0;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;
  let lastControl: HTMLElement | null = null;
  let lastInset = -1;
  let lastHeight = -1;
  let lastTop = -1;

  const apply = () => {
    frame = 0;
    const current = metrics();
    const previousInset = lastInset;

    // Avoid React/layout feedback loops caused by writing the same CSS values.
    if (current.inset !== lastInset) {
      document.documentElement.style.setProperty('--keyboard-inset', current.inset + 'px');
      lastInset = current.inset;
    }
    if (current.height !== lastHeight) {
      document.documentElement.style.setProperty('--keyboard-viewport-height', current.height + 'px');
      document.documentElement.style.setProperty('--pos-visual-height', current.height + 'px');
      document.documentElement.style.setProperty('--pos-viewport-height', current.height + 'px');
      lastHeight = current.height;
    }
    if (current.top !== lastTop) {
      document.documentElement.style.setProperty('--keyboard-viewport-top', current.top + 'px');
      document.documentElement.style.setProperty('--pos-viewport-top', current.top + 'px');
      lastTop = current.top;
    }

    const control = isFormControl(document.activeElement) ? document.activeElement : null;
    if (!control) {
      clearState();
      lastControl = null;
      return;
    }

    const keyboardOpen = current.inset > 0;
    document.body.classList.toggle('keyboard-open', keyboardOpen);
    document.documentElement.classList.toggle(
      'pos-keyboard-open',
      keyboardOpen && Boolean(control.closest('.pos-page'))
    );

    const changed = control !== lastControl;
    lastControl = control;

    // Only reposition once for a new focus or when the keyboard first appears.
    if (changed || (keyboardOpen && previousInset === 0)) {
      ensureVisible(control, current);
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  const onFocusIn = (event: FocusEvent) => {
    if (!isFormControl(event.target as Element | null)) return;
    if (focusTimer) clearTimeout(focusTimer);
    schedule();
    // One settling pass after Android/iOS reports the final viewport. No
    // repeated 80/180/350/600ms loop.
    focusTimer = setTimeout(schedule, 140);
  };

  const onFocusOut = () => {
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (!isFormControl(document.activeElement)) {
        clearState();
        lastControl = null;
      }
    }, 80);
  };

  const onViewportChange = () => schedule();

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('scroll', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  schedule();

  return () => {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.visualViewport?.removeEventListener('resize', onViewportChange);
    window.visualViewport?.removeEventListener('scroll', onViewportChange);
    window.removeEventListener('orientationchange', onViewportChange);
    if (frame) cancelAnimationFrame(frame);
    if (focusTimer) clearTimeout(focusTimer);
    clearState();
    document.documentElement.style.removeProperty('--pos-visual-height');
    document.documentElement.style.removeProperty('--pos-viewport-height');
    document.documentElement.style.removeProperty('--pos-viewport-top');
  };
}
