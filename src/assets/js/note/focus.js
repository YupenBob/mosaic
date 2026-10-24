/**
 * Focus management + scroll locking for full-screen overlays.
 *
 * The note modal uses a native <dialog> (which already makes the page inert),
 * but we still cycle Tab inside the panel explicitly: it keeps behaviour
 * identical in browsers/testing environments where focus escaping the top layer
 * is possible, and it documents the a11y contract.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function focusableElements(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null,
  );
}

/**
 * Keep Tab/Shift+Tab inside `container`.
 * @param {HTMLElement} container
 * @returns {() => void} cleanup
 */
export function trapFocus(container) {
  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusableElements(container);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeydown);
  return () => container.removeEventListener('keydown', onKeydown);
}

/**
 * Lock page scroll while an overlay is open (keeps the scroll position; the
 * scrollbar width is compensated so the layout does not shift).
 * @returns {() => void} unlock
 */
export function lockScroll() {
  const y = window.scrollY;
  const root = document.documentElement;
  const body = document.body;
  const scrollbar = window.innerWidth - root.clientWidth;
  const previous = {
    rootOverflow: root.style.overflow,
    bodyOverflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
  };
  root.classList.add('overlay-scroll-locked');
  root.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
  return () => {
    root.classList.remove('overlay-scroll-locked');
    root.style.overflow = previous.rootOverflow;
    body.style.overflow = previous.bodyOverflow;
    body.style.paddingRight = previous.paddingRight;
    window.scrollTo(0, y);
  };
}

/**
 * Focus the first interesting control, preferring `[data-autofocus]`.
 * @param {HTMLElement} container
 */
export function focusInitial(container) {
  const preferred = container.querySelector('[data-autofocus]');
  const target = preferred || focusableElements(container)[0] || container;
  try {
    target.focus({ preventScroll: true });
  } catch {
    /* focus is best-effort */
  }
}
