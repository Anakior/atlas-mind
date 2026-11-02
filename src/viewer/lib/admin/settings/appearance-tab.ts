// Settings › Apparence tab (admin): the instance accent and whether the site prefix and the tagline
// show, the same for every account. A pick applies at once and is saved; a refused save puts the previous look back.

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { SITE_PREFIX, TAGLINE } from '../../core/data-csrf';
import { appearance, type Appearance } from '../../ui/appearance';
import { SettingsContext } from './settings-shared';

const DEFAULT_BRAND = '#e8941c';
const PRESETS = ['#e5624b', '#d9488f', '#8b5cf6', '#3b82f6', '#0ea5c6', '#10b981', '#84cc16'];

// What a save sends: a null brand puts Atlas gold back.
type Change = { brand?: string | null; show_prefix?: boolean; show_tagline?: boolean };
// The texts an admin may hide, each with its switch (#appearance-<id>) in 05-settings.html.
const SWITCHES = [
  { id: 'prefix', field: 'show_prefix', text: SITE_PREFIX },
  { id: 'tagline', field: 'show_tagline', text: TAGLINE },
] as const;

export class SettingsAppearance {
  constructor(private readonly ctx: SettingsContext) {}

  async load(): Promise<void> {
    const swatches = document.getElementById('appearance-swatches')!;

    if (!swatches.dataset.wired) {
      swatches.dataset.wired = '1';
      swatches.addEventListener('click', (e) => {
        const sw = (e.target as HTMLElement).closest<HTMLElement>('[data-brand]');

        if (sw) this.save({ brand: sw.dataset.brand || null });
      });
      swatches.addEventListener('change', (e) => this.save({ brand: (e.target as HTMLInputElement).value }));
      for (const sw of SWITCHES) {
        const btn = document.getElementById('appearance-' + sw.id)!;

        btn.addEventListener('click', () => this.save({ [sw.field]: btn.getAttribute('aria-checked') !== 'true' }));
      }
    }
    for (const sw of SWITCHES) {
      document.getElementById(`appearance-${sw.id}-card`)!.classList.toggle('hidden', !sw.text);
      document.getElementById(`appearance-${sw.id}-title`)!.textContent = t('appearanceShow', sw.text);
    }

    try {
      appearance.apply(await this.ctx.fetch<Appearance>('/api/appearance'));
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
    this.render();
  }

  private render(): void {
    const brand = appearance.current.brand || '';
    const custom = brand && !PRESETS.includes(brand) ? brand : '';
    const swatch = (hex: string, tip: string, value = hex) =>
      `<button type="button" class="appearance-swatch" style="--sw:${hex}" data-brand="${value}" data-tip="${escapeHtml(tip)}" aria-pressed="${brand === value}"></button>`;

    document.getElementById('appearance-swatches')!.innerHTML =
      swatch(DEFAULT_BRAND, t('appearanceDefault'), '') +
      PRESETS.map((hex) => swatch(hex, hex)).join('') +
      `<label class="appearance-swatch appearance-custom${custom ? ' is-on' : ''}" data-tip="${escapeHtml(t('appearanceCustom'))}"${custom ? ` style="--sw:${custom}"` : ''}><input type="color" value="${custom || DEFAULT_BRAND}"></label>`;
    for (const sw of SWITCHES) {
      document.getElementById('appearance-' + sw.id)!.setAttribute('aria-checked', String(appearance.current[sw.field] !== false));
    }
  }

  private async save(fields: Change): Promise<void> {
    const before = appearance.current;
    const next: Appearance = { ...before };

    if ('brand' in fields) {
      if (fields.brand) next.brand = fields.brand;
      else delete next.brand;
    }
    for (const sw of SWITCHES) if (sw.field in fields) next[sw.field] = fields[sw.field];
    this.ctx.clearError();
    appearance.apply(next);
    this.render();
    try {
      appearance.apply(await this.ctx.fetch<Appearance>('/api/appearance', { method: 'POST', body: JSON.stringify(fields) }));
    } catch (e) {
      appearance.apply(before);
      this.ctx.showError((e as Error).message);
    }
    this.render();
  }
}
