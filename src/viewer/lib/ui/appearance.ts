// The instance's look, picked by an admin in Settings › Apparence and the same for every account:
// the accent (the --brand token, Atlas gold by default) and whether the site prefix and the tagline
// show. The head
// script of viewer.html replays the cached copy before the first paint; this module fetches the
// instance's own on boot and applies a change live.

import { IS_OFFLINE_BUILD } from '../core/data-csrf';

export interface Appearance { brand?: string; show_prefix?: boolean; show_tagline?: boolean }

const KEY = 'atlas:appearance';
const VARS = ['--brand-dark', '--brand-light', '--on-brand-dark', '--on-brand-light'];
const LIGHT_PAGE: Rgb = [246, 245, 242];

type Rgb = [number, number, number];

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;

    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi + 0.05) / (lo + 0.05);
};
const triple = (rgb: Rgb): string => rgb.join(' ');

class AppearanceSettings {
  current: Appearance = {};

  constructor() {
    if (!IS_OFFLINE_BUILD) this.load();
  }

  async load(): Promise<void> {
    try {
      const res = await fetch('/api/appearance');

      if (res.ok) this.apply(await res.json());
    } catch (_) { /* the cached copy stays */ }
  }

  // The accent as the four tokens it drives. On the light page it darkens until it reads (3:1, the
  // bar for UI and large text). What sits on it is white, dark only on a very light accent.
  vars(hex: string): Record<string, string> {
    const dark = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
    let light = dark;

    while (contrast(light, LIGHT_PAGE) < 3) light = light.map((c) => Math.round(c * 0.92)) as Rgb;
    const on = (rgb: Rgb) => (luminance(rgb) > 0.45 ? '28 18 6' : '255 255 255');

    return { '--brand-dark': triple(dark), '--brand-light': triple(light), '--on-brand-dark': on(dark), '--on-brand-light': on(light) };
  }

  apply(a: Appearance): void {
    const root = document.documentElement;
    const vars = a.brand ? this.vars(a.brand) : {};

    this.current = a;
    for (const k of VARS) root.style.removeProperty(k);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    if (a.show_prefix === false) root.dataset.prefix = 'off';
    else delete root.dataset.prefix;
    if (a.show_tagline === false) root.dataset.tagline = 'off';
    else delete root.dataset.tagline;

    try {
      localStorage.setItem(KEY, JSON.stringify({ vars, showPrefix: a.show_prefix !== false, showTagline: a.show_tagline !== false }));
    } catch (_) {}
  }
}

export const appearance = new AppearanceSettings();
