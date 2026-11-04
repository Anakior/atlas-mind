// Settings › Apparence (admin): the accent, the name before "Atlas" and the line under the logo, the
// same for every account. Applied at once; a refused save puts the previous look back.

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { SITE_PREFIX, TAGLINE } from '../../core/data-csrf';
import { appearance, type Appearance } from '../../ui/appearance';
import { SettingsContext } from './settings-shared';

const DEFAULT_BRAND = '#e8941c';
const PRESETS = ['#e5624b', '#d9488f', '#8b5cf6', '#3b82f6', '#0ea5c6', '#10b981', '#84cc16'];

// What a save sends: a null brand puts Atlas gold back.
type Change = { brand?: string | null; show_prefix?: boolean; show_tagline?: boolean; prefix?: string; tagline?: string };
// The two texts, each with its field (#appearance-<id>-text) and its switch (#appearance-<id>).
const TEXTS = [
  { id: 'prefix', show: 'show_prefix' },
  { id: 'tagline', show: 'show_tagline' },
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
      for (const text of TEXTS) {
        const btn = document.getElementById('appearance-' + text.id)!;
        const field = document.getElementById(`appearance-${text.id}-text`) as HTMLInputElement;

        btn.addEventListener('click', () => this.save({ [text.show]: btn.getAttribute('aria-checked') !== 'true' }));
        // Hiding the line is the switch's job, not an empty field's.
        field.addEventListener('change', () => {
          if (text.id === 'tagline' && !field.value.trim()) this.render();
          else if (field.value.trim() !== this.text(text.id)) this.save({ [text.id]: field.value });
        });
      }
    }

    try {
      appearance.apply(await this.ctx.fetch<Appearance>('/api/appearance'));
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
    this.render();
  }

  private text(id: 'prefix' | 'tagline'): string {
    return appearance.current[id] ?? (id === 'prefix' ? SITE_PREFIX : TAGLINE);
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
    for (const text of TEXTS) {
      const btn = document.getElementById('appearance-' + text.id) as HTMLButtonElement;

      (document.getElementById(`appearance-${text.id}-text`) as HTMLInputElement).value = this.text(text.id);
      btn.setAttribute('aria-checked', String(appearance.current[text.show] !== false));
      btn.disabled = !this.text(text.id); // no name: nothing to show or hide
    }
  }

  private async save(fields: Change): Promise<void> {
    const before = appearance.current;
    const next: Appearance = { ...before };

    if ('brand' in fields) {
      if (fields.brand) next.brand = fields.brand;
      else delete next.brand;
    }
    for (const text of TEXTS) {
      if (text.show in fields) next[text.show] = fields[text.show];
      if (text.id in fields) next[text.id] = fields[text.id]!.trim();
    }
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
