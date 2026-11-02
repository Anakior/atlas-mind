// The light / dark theme, chosen per browser: 'auto' follows the system. The head script of
// viewer.html applies the saved choice before the first paint; this module keeps it live (switch,
// system change) and tells whatever draws in code (the graph canvas, the orrery) through the
// `atlas:theme` event, since they cannot pick a CSS change up by themselves.

export type ThemeMode = 'light' | 'dark' | 'auto';

const KEY = 'atlas:theme';

class Theme {
  private readonly root = document.documentElement;
  private readonly system = window.matchMedia('(prefers-color-scheme: light)');

  constructor() {
    this.system.addEventListener('change', () => {
      if (this.mode === 'auto') this.apply();
    });
    this.apply();
  }

  get mode(): ThemeMode {
    let m: string | null = null;

    try { m = localStorage.getItem(KEY); } catch (_) {}

    return m === 'light' || m === 'auto' ? m : 'dark';
  }

  // The theme on screen now, 'auto' resolved.
  get current(): 'light' | 'dark' {
    const m = this.mode;

    return m === 'auto' ? (this.system.matches ? 'light' : 'dark') : m;
  }

  set(mode: ThemeMode): void {
    try { localStorage.setItem(KEY, mode); } catch (_) {}
    this.apply();
  }

  // A CSS colour token ("R G B") as a usable colour, for code that paints outside CSS.
  color(token: string, alpha = 1): string {
    const v = getComputedStyle(this.root).getPropertyValue('--' + token).trim();

    return `rgb(${v} / ${alpha})`;
  }

  private apply(): void {
    const t = this.current;
    const changed = this.root.dataset.theme !== t;

    this.root.dataset.themeMode = this.mode;
    this.root.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.color('page'));
    document.querySelectorAll<HTMLElement>('[data-theme-mode]').forEach((b) => {
      if (b !== this.root) b.setAttribute('aria-checked', String(b.dataset.themeMode === this.mode));
    });
    if (changed) window.dispatchEvent(new CustomEvent('atlas:theme', { detail: t }));
  }
}

export const theme = new Theme();

// The menu's switch: any [data-theme-mode] button sets that mode.
document.addEventListener('click', (e) => {
  const b = (e.target as Element | null)?.closest<HTMLElement>('button[data-theme-mode]');

  if (b) theme.set(b.dataset.themeMode as ThemeMode);
});
