// [[wikilink]] autocomplete for the document editor. Triggered by typing `[[`: suggests docs from
// fileMap (filtered by name/path), keyboard-navigable, and inserts an always-resolvable target (name
// only when unique, full path otherwise). Owns a body-level popup, its outside-click listener, and a
// blur timer — all torn down between edit sessions so nothing leaks. Operates on the global
// editTextarea (set by the Editor when it builds the split view); it shares no state with the Editor
// beyond that handle, so it stays a standalone class the Editor composes.
//
// Concatenated before 09-editor (09-autocomplete sorts first) so the class exists when the Editor's
// field initializer runs `new WikilinkAutocomplete()` — class declarations do not hoist.
import { fileMap } from '../core/tree';
import { WL_TARGET_EXTS } from '../content/content-tree';
import { editTextarea } from '../core/state';
import { escapeHtml } from '../core/utils';

export class WikilinkAutocomplete {
  // The textarea computed-style props mirrored onto the caret-measuring div.
  private static readonly STYLE_KEYS = [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
    'wordSpacing',
    'textIndent',
    'tabSize',
  ] as const;

  private isOpen = false;
  private items: WlCandidate[] = [];
  private active = 0;
  private start = -1;
  private cands: WlCandidate[] | null = null;
  private menuEl: HTMLElement | null = null;
  // Held so the body popup, its document-level outside-click, and the pending blur timer are torn
  // down on exit (no leak across edit sessions).
  private docMousedown: ((e: MouseEvent) => void) | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;

  // Drop the cached candidates so they recompute on the next keystroke (catches any new docs).
  resetCandidates(): void {
    this.cands = null;
  }

  // Deferred close on textarea blur, so a mousedown on a popup option is handled first.
  scheduleClose(): void {
    this.blurTimer = setTimeout(() => this.close(), 150);
  }

  // ---- popup ----
  private menu(): HTMLElement {
    if (this.menuEl) return this.menuEl;

    const el = document.createElement('div');

    el.id = 'wl-autocomplete';
    el.className =
      'fixed z-50 hidden w-80 max-h-64 overflow-y-auto rounded-md border subtle-border bg-navy-800 shadow-xl scrollbar-thin text-sm';
    document.body.appendChild(el);
    el.addEventListener('mousedown', (e) => {
      const opt = (e.target as Element).closest('.wl-opt');

      if (!opt) return;
      e.preventDefault(); // keeps the textarea focus
      this.insert(+(opt as HTMLElement).dataset.i!);
    });
    this.docMousedown = (e: MouseEvent) => {
      if (this.isOpen && this.menuEl && !this.menuEl.contains(e.target as Node) && e.target !== editTextarea)
        this.close();
    };
    document.addEventListener('mousedown', this.docMousedown);
    this.menuEl = el;

    return el;
  }

  private close(): void {
    this.isOpen = false;
    this.start = -1;
    this.items = [];

    if (this.menuEl) {
      this.menuEl.classList.add('hidden');
      this.menuEl.innerHTML = '';
    }
  }

  // Remove the body popup + its document-level mousedown and clear the blur timer, so nothing
  // survives into the next edit session.
  teardown(): void {
    this.close();

    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    if (this.docMousedown) {
      document.removeEventListener('mousedown', this.docMousedown);
      this.docMousedown = null;
    }
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }
  }

  private buildCands(): WlCandidate[] {
    const out: WlCandidate[] = [];

    for (const f of Object.values(fileMap)) {
      if (!WL_TARGET_EXTS.includes(f.ext)) continue;
      const stem = f.name.replace(/\.[^.]+$/, '');

      out.push({
        path: f.path,
        label: stem,
        sub: f.path,
        mtime: f.mtime || 0,
        _name: stem.toLowerCase(),
        _hay: (stem + ' ' + f.path).toLowerCase(),
      });
    }

    return out;
  }

  private queryAtCursor(ta: HTMLTextAreaElement): { start: number; query: string } | null {
    const v = ta.value,
      cur = ta.selectionStart;
    const open = v.lastIndexOf('[[', cur - 2);

    if (open === -1 || open + 2 > cur) return null;
    const between = v.slice(open + 2, cur);

    if (/[\]\n]/.test(between)) return null;

    return { start: open, query: between };
  }

  private filter(query: string): WlCandidate[] {
    if (!this.cands) this.cands = this.buildCands();
    const q = query.trim().toLowerCase();
    let res: WlCandidate[];

    if (q) {
      res = this.cands.filter((c) => c._hay.includes(q));
      const rank = (c: WlCandidate) => (c._name.startsWith(q) ? 0 : c._name.includes(q) ? 1 : 2);

      res.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
    } else {
      res = this.cands.slice().sort((a, b) => b.mtime - a.mtime);
    }

    return res.slice(0, 8);
  }

  private render(): void {
    const m = this.menu();

    m.innerHTML = this.items
      .map(
        (c, i) =>
          '<div class="wl-opt px-3 py-1.5 cursor-pointer ' +
          (i === this.active ? 'bg-white/10' : '') +
          '" data-i="' +
          i +
          '">' +
          '<div class="text-ink-100 truncate">' +
          escapeHtml(c.label) +
          '</div>' +
          '<div class="text-[11px] text-ink-400 truncate">' +
          escapeHtml(c.sub) +
          '</div>' +
          '</div>',
      )
      .join('');
    m.classList.remove('hidden');

    const active = m.children[this.active];

    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  private caretCoords(ta: HTMLTextAreaElement): { top: number; left: number; lineHeight: number } {
    const pos = ta.selectionStart,
      s = getComputedStyle(ta);
    const div = document.createElement('div');

    for (const p of WikilinkAutocomplete.STYLE_KEYS) div.style[p] = s[p];
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordWrap = 'break-word';
    div.style.overflow = 'hidden';
    div.textContent = ta.value.slice(0, pos);
    const span = document.createElement('span');

    span.textContent = ta.value.slice(pos) || '.';
    div.appendChild(span);
    document.body.appendChild(div);
    const lh = parseInt(s.lineHeight, 10) || parseInt(s.fontSize, 10) || 16;
    const rect = ta.getBoundingClientRect();
    const top = rect.top + span.offsetTop - ta.scrollTop + lh;
    const left = rect.left + span.offsetLeft - ta.scrollLeft;

    document.body.removeChild(div);

    return { top, left, lineHeight: lh };
  }

  private position(ta: HTMLTextAreaElement): void {
    const m = this.menu();
    const c = this.caretCoords(ta);
    let top = c.top + 4,
      left = c.left;
    const mh = m.offsetHeight || 200,
      mw = m.offsetWidth || 320;

    if (top + mh > window.innerHeight - 8) top = c.top - c.lineHeight - mh - 4;

    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    m.style.top = Math.max(8, top) + 'px';
    m.style.left = Math.max(8, left) + 'px';
  }

  private targetFor(path: string): string {
    const stem = fileMap[path].name.replace(/\.[^.]+$/, '');
    const stemLc = stem.toLowerCase();
    let count = 0;

    for (const f of Object.values(fileMap)) {
      if (WL_TARGET_EXTS.includes(f.ext) && f.name.replace(/\.[^.]+$/, '').toLowerCase() === stemLc)
        count++;
    }

    return count <= 1 ? stem : path.replace(/\.[^.]+$/, '');
  }

  update(): void {
    const ta = editTextarea;

    if (!ta) return;
    const q = this.queryAtCursor(ta);

    if (!q) {
      this.close();

      return;
    }

    this.start = q.start;
    this.items = this.filter(q.query);

    if (!this.items.length) {
      this.close();

      return;
    }

    this.active = 0;
    this.isOpen = true;
    this.render();
    this.position(ta);
  }

  private insert(i: number): void {
    const ta = editTextarea;
    const c = this.items[i];

    if (!ta || !c || this.start < 0) {
      this.close();

      return;
    }

    const cur = ta.selectionStart;

    ta.setRangeText('[[' + this.targetFor(c.path) + ']]', this.start, cur, 'end');
    this.close();
    ta.focus();
    ta.dispatchEvent(new Event('input'));
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.isOpen) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active = (this.active + 1) % this.items.length;
      this.render();

      return true;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.render();

      return true;
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.insert(this.active);

      return true;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();

      return true;
    }

    return false;
  }
}
