// The shell's overlays (every .overlay-backdrop of the partials, and the Mind graph) are shown and
// hidden through their `hidden` class, each by its own module. Watching that class gives all of them
// what a keyboard user needs, without touching each owner: Tab stays inside the open one, and closing
// it puts the focus back where it was. openOverlay() also tells the one-key shortcuts to stand down.

const OVERLAYS = Array.from(document.querySelectorAll<HTMLElement>('.overlay-backdrop, #graph-overlay'));
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const opener = new Map<HTMLElement, Element | null>();

const isOpen = (el: HTMLElement): boolean => !el.classList.contains('hidden');

// The topmost open overlay: the highest z-index (a confirm sits over the panel that asked it), then
// the last in the page.
export function openOverlay(): HTMLElement | null {
  let top: HTMLElement | null = null;
  let topZ = -Infinity;

  for (const el of OVERLAYS) {
    if (!isOpen(el)) continue;
    const z = parseInt(getComputedStyle(el).zIndex, 10) || 0;

    if (z >= topZ) {
      top = el;
      topZ = z;
    }
  }

  return top;
}

const watcher = new MutationObserver((records) => {
  for (const r of records) {
    const el = r.target as HTMLElement;
    const wasOpen = !(r.oldValue || '').split(/\s+/).includes('hidden');

    if (wasOpen === isOpen(el)) continue;
    if (isOpen(el)) {
      opener.set(el, document.activeElement);
      continue;
    }
    const back = opener.get(el);
    const now = document.activeElement;

    opener.delete(el);
    // Unless the closing action already put the focus somewhere on purpose.
    if (back instanceof HTMLElement && back.isConnected && (!now || now === document.body || el.contains(now))) back.focus();
  }
});

OVERLAYS.forEach((el) => watcher.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const top = openOverlay();

  if (!top) return;
  const items = Array.from(top.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.getClientRects().length > 0);
  const active = document.activeElement;

  if (!items.length) {
    e.preventDefault();

    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const inside = !!active && top.contains(active);

  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
});
