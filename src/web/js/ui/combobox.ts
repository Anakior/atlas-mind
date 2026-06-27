// AtlasCombobox — the reusable "search + create" field (folders, tags, ACL principals, group members).
// One <body>-level fixed popup per instance, anchored once from the input's rect; there is no scroll/
// resize re-position listener, so the input must not move while the popup is open (golden D). The
// factory entry AtlasCombobox(input, opts) -> ComboboxController is a bareword global the still-.js
// modules call. CSS lives in styles/03-panels.css. Opts/controller shapes: interface/Combobox*.ts.

class Combobox implements ComboboxController {
  private readonly input: HTMLInputElement;
  private readonly opts: ComboboxOptions;
  private readonly pop: HTMLDivElement;
  private readonly norm: (v: string) => string;
  private readonly fmt: (v: string) => string;

  private all: string[] = [];
  private items: Array<string | { __create: string }> = []; // strings, plus an optional create sentinel at the end
  private active = 0;
  private isOpen = false;
  private chipBox: HTMLDivElement | null = null;
  private values: string[] = []; // multi mode

  constructor(input: HTMLElement, opts: ComboboxOptions) {
    // Consumers hand the field over as HTMLElement (getElementById); it is always a text input.
    this.input = input as HTMLInputElement;
    this.opts = opts;
    this.norm = opts.normalize || ((v) => v);
    this.fmt = opts.format || ((v) => escapeHtml(v));

    this.input.removeAttribute('list'); // kill the native datalist
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'false');

    this.pop = document.createElement('div');
    this.pop.className =
      'atlas-cb-pop fixed hidden max-h-64 overflow-y-auto scrollbar-thin ' +
      'rounded-md border subtle-border shadow-2xl shadow-black/70 text-sm';
    // z-index inline: an arbitrary Tailwind z-[..] in a JS string isn't compiled (see 03-panels.css).
    this.pop.style.zIndex = '80';
    document.body.appendChild(this.pop);

    this.wire();
  }

  private wire(): void {
    this.input.addEventListener('focus', async () => {
      await this.load();
      this.active = 0;
      this.render();
    });
    this.input.addEventListener('input', () => {
      this.active = 0;
      this.render();
    });
    this.input.addEventListener('keydown', (e) => this.onKeydown(e));
    this.pop.addEventListener('mousedown', (e) => this.onPopMousedown(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 120));
  }

  private async load(): Promise<void> {
    try {
      this.all = (await this.opts.source()) || [];
    } catch (_) {
      this.all = [];
    }
  }

  private compute(): { res: string[]; create: string | null } {
    const raw = this.input.value.trim();
    const q = raw.toLowerCase();
    let res = q ? this.all.filter((v) => String(v).toLowerCase().includes(q)) : this.all.slice();

    if (q) {
      const rk = (v: string): number => (String(v).toLowerCase().startsWith(q) ? 0 : 1);

      res.sort((a, b) => rk(a) - rk(b));
    }
    res = res.slice(0, this.opts.maxItems || 50).filter((v) => !(this.opts.multi && this.values.includes(v)));

    const exact = this.all.some((v) => String(v).toLowerCase() === q);

    return { res, create: this.opts.creatable && raw && !exact ? raw : null };
  }

  private render(): void {
    const { res, create } = this.compute();

    this.items = res.slice();

    let html = res
      .map(
        (v, i) =>
          '<div class="atlas-cb-opt px-3 py-1.5 cursor-pointer hover:bg-white/5 ' +
          (i === this.active ? 'bg-white/10' : '') +
          '" data-i="' + i + '">' + this.fmt(v) + '</div>',
      )
      .join('');

    if (create) {
      const ci = res.length;

      html +=
        '<div class="atlas-cb-create px-3 py-1.5 cursor-pointer hover:bg-white/5 text-accent ' +
        'flex items-center gap-2 ' + (this.active === ci ? 'bg-white/10' : '') +
        '" data-create="1"><span class="text-base leading-none">+</span>' +
        escapeHtml(t('comboCreate', create)) + '</div>';
      this.items.push({ __create: create });
    }
    if (!this.items.length) {
      this.pop.innerHTML = '<div class="px-3 py-1.5 text-ink-500">' + escapeHtml(t('comboNoResults')) + '</div>';
    } else {
      this.pop.innerHTML = html;
    }

    const r = this.input.getBoundingClientRect();

    this.pop.style.left = r.left + 'px';
    this.pop.style.top = r.bottom + 4 + 'px';
    this.pop.style.width = r.width + 'px';
    this.pop.classList.remove('hidden');
    this.isOpen = true;
    this.input.setAttribute('aria-expanded', 'true');

    const a = this.pop.children[this.active];

    if (a) a.scrollIntoView({ block: 'nearest' });
  }

  private choose(it: string | { __create: string } | null | undefined): void {
    if (it == null) return;

    const val = this.norm(typeof it === 'string' ? it : it.__create);

    if (this.opts.multi) {
      this.addChip(val);
      this.input.value = '';
    } else {
      this.input.value = val;
    }
    this.close();
    if (this.opts.onSelect) this.opts.onSelect(val);
  }

  // chips (multi) — reuse the existing .doc-tag / .doc-tag-x styling.
  private ensureChipBox(): void {
    if (this.opts.multi && !this.chipBox) {
      this.chipBox = document.createElement('div');
      this.chipBox.className = 'flex flex-wrap gap-1.5 mb-1.5 empty:hidden';
      this.input.parentNode!.insertBefore(this.chipBox, this.input); // chips-mode inputs are always mounted
      this.chipBox.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('[data-rm]') as HTMLElement | null;

        if (b) {
          this.values = this.values.filter((x) => x !== b.dataset.rm);
          this.renderChips();
        }
      });
    }
  }

  private renderChips(): void {
    if (!this.chipBox) return;
    this.chipBox.innerHTML = this.values
      .map(
        (v) =>
          '<span class="doc-tag">' + escapeHtml(v) +
          '<button type="button" class="doc-tag-x ml-1" data-rm="' + escapeHtml(v) + '">×</button></span>',
      )
      .join('');
  }

  private addChip(v: string): void {
    this.ensureChipBox();
    if (!v || this.values.includes(v)) return;
    this.values.push(v);
    this.renderChips();
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Backspace' && this.opts.multi && !this.input.value && this.values.length) {
      this.values.pop();
      this.renderChips();

      return;
    }
    if (!this.isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active = Math.min(this.active + 1, this.items.length - 1);
      this.render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active = Math.max(this.active - 1, 0);
      this.render();
    } else if (e.key === 'Enter') {
      if (this.items[this.active] != null) {
        e.preventDefault();
        this.choose(this.items[this.active]);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // close the dropdown, NOT the dialog
      this.close();
    }
  }

  private onPopMousedown(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest('[data-i],[data-create]') as HTMLElement | null;

    if (!el) return;
    e.preventDefault(); // keep focus on the input
    this.choose(el.dataset.create ? this.items[this.items.length - 1] : this.items[+el.dataset.i!]);
  }

  getValue(): string {
    // multi mode returns the chips array at runtime; typed string so single-mode callers read it directly.
    return this.opts.multi ? (this.values.slice() as unknown as string) : this.input.value.trim();
  }

  setValue(value: string): void {
    if (this.opts.multi) {
      this.values = String(value || '').split(this.opts.separator || ',').map((s) => s.trim()).filter(Boolean);
      this.ensureChipBox();
      this.renderChips();
    } else {
      this.input.value = value || '';
    }
  }

  async refresh(): Promise<void> {
    await this.load();
    if (this.isOpen) this.render();
  }

  clear(): void {
    if (this.opts.multi) {
      this.values = [];
      this.renderChips();
    } else {
      this.input.value = '';
    }
  }

  focus(): void {
    this.input.focus();
  }

  open(): void {
    this.render();
  }

  close(): void {
    this.pop.classList.add('hidden');
    this.isOpen = false;
    this.input.setAttribute('aria-expanded', 'false');
  }

  destroy(): void {
    this.pop.remove();
    if (this.chipBox) this.chipBox.remove();
  }
}

// Factory (the viewer is concatenated scripts, not ES modules): the bareword every consumer calls.
function AtlasCombobox(input: HTMLElement, opts: ComboboxOptions): ComboboxController {
  return new Combobox(input, opts);
}
