// The new-file dialog's template <select>: the built-in DOC_TEMPLATES skeleton options, the
// extension-registered providers, the per-template extras block, and the {{title}}/{{date}}/{{isoDate}}
// content fill. NewFileModal owns one instance and delegates here; window.Atlas.registerTemplate routes
// through registerTemplate(). Concatenated before 19-newfile.ts so the class exists when NewFileModal
// is constructed at module init.

import { DOC_TEMPLATES } from '../core/data-csrf';
import { LANG, t } from '../core/i18n';

export class TemplateRegistry {
  private readonly extArea = document.getElementById('new-file-ext-area') as HTMLElement;
  // Extension templates, keyed by select value. Null prototype: `for..in` yields only real entries.
  private readonly providers: Record<string, TemplateProvider> = Object.create(null);

  constructor(
    private readonly template: HTMLSelectElement,
    private readonly name: HTMLInputElement,
    private readonly dir: HTMLInputElement,
  ) {
    this.populateOptions();
  }

  // Fills a DOC_TEMPLATES skeleton: tokens {{title}}, {{date}} (UI-locale long form), {{isoDate}}
  // (YYYY-MM-DD). Unknown kind (incl. 'blank') → title only.
  static buildContent(kind: string, title: string): string {
    const template = DOC_TEMPLATES[kind];

    if (!template) return '# ' + title + '\n\n';

    const locale = LANG === 'en' ? 'en-GB' : 'fr-FR';
    const today = new Date().toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    const isoDate = new Date().toISOString().slice(0, 10);

    return template
      .replaceAll('{{title}}', title)
      .replaceAll('{{date}}', today)
      .replaceAll('{{isoDate}}', isoDate);
  }

  // The provider bound to the current select value, or null for a built-in skeleton / 'blank'.
  activeProvider(): TemplateProvider | null {
    return this.providers[this.template.value] || null;
  }

  // Run every registered provider's onOpen() hook (NewFileModal.open). A thrown hook is logged, never fatal.
  runOpenHooks(): void {
    for (const value in this.providers) {
      const provider = this.providers[value];

      if (provider.onOpen) {
        try {
          provider.onOpen();
        } catch (err) {
          console.warn('[extension] onOpen', value, err);
        }
      }
    }
  }

  updateExtras(): void {
    const active = this.activeProvider();

    for (const value in this.providers) {
      const provider = this.providers[value];

      if (provider.block) provider.block.classList.toggle('hidden', provider !== active);
    }

    this.name.placeholder = (active && active.namePlaceholder) || t('docNamePlaceholder');

    if (active && active.defaultDir && !this.dir.value.trim()) {
      this.dir.value = active.defaultDir;
    }
  }

  // "Blank" stays the reserved first option; skeleton names cannot override it.
  private populateOptions(): void {
    for (const skelName of Object.keys(DOC_TEMPLATES).sort()) {
      if (skelName === 'blank') continue;
      const option = document.createElement('option');

      option.value = skelName;
      option.textContent = skelName;
      this.template.appendChild(option);
    }
  }

  // window.Atlas.registerTemplate. Rejected: a falsy value/provider or one without generate(),
  // 'blank', a DOC_TEMPLATES skeleton of the same name, or an already-registered value.
  registerTemplate(value: string, provider: TemplateProvider): boolean {
    if (!value || !provider || typeof provider.generate !== 'function') return false;
    if (value === 'blank' || this.providers[value] || DOC_TEMPLATES[value]) return false;

    this.providers[value] = provider;
    const option = document.createElement('option');

    option.value = value;
    option.textContent = provider.label || value;
    this.template.appendChild(option);

    if (provider.block) {
      provider.block.classList.add('hidden');
      this.extArea.appendChild(provider.block);
    }

    return true;
  }
}
