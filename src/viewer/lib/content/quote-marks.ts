// The huissier's marks: once a note is rendered, each of its quotations gets a dot saying whether a
// file of the mind holds it word for word (found), says nearly the same (altered) or holds nothing
// like it (missing: marked only in a note that quotes files, where it means something). Clicking a
// dot tells where, and for an altered quote what the file really says. Empty buttons, so the text
// offsets the notes anchor on are left as they were.

import { contentEl } from '../core/dom-refs';
import { t } from '../core/i18n';
import { api } from '../core/net';
import { currentFile, isServerMode } from '../core/state';
import { docLabelAt, fileMap } from '../core/tree';
import { escapeHtml } from '../core/utils';
import { docRenderer } from './doc-renderer';

type CiteState = 'found' | 'altered' | 'missing';

interface Checked {
  line: number;
  text: string;
  state: CiteState;
  source?: { path: string; line: number; section?: string; says?: string };
}

const LABEL: Record<CiteState, string> = { found: 'citeFound', altered: 'citeAltered', missing: 'citeMissing' };
const CLOSERS = '»”"';

// A quotation as the page shows it: a link as its label, then its words, in order, whatever the
// marks and the punctuation between them.
function wordsPattern(text: string): RegExp | null {
  const shown = text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const words = shown.match(/[\p{L}\p{N}]+/gu);

  if (!words) return null;

  return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+'), 'iu');
}

function locate(full: string, text: string, from: number): { start: number; end: number } | null {
  const re = wordsPattern(text);
  const m = re && re.exec(full.slice(from));

  return m ? { start: from + m.index, end: from + m.index + m[0].length } : null;
}

// The text node holding the global offset `at` of #content, and the offset inside it.
function nodeAt(at: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n: Node | null;

  while ((n = walker.nextNode())) {
    const len = n.nodeValue!.length;

    if (at <= acc + len) return { node: n as Text, offset: at - acc };
    acc += len;
  }

  return null;
}

class QuoteMarks {
  private pop: HTMLElement | null = null;

  async decorate(file: FileNode): Promise<void> {
    this.close();
    if ('highlights' in CSS) CSS.highlights.delete('kb-cite');
    if (!isServerMode || file.ext !== '.md') return;
    let data: { quotes: Checked[]; cites_files: boolean };

    try {
      data = await api('GET', '/api/quotes?path=' + encodeURIComponent(file.path));
    } catch (e) {
      return; // the marks are a plus: a failed check leaves the note as it reads
    }

    if (currentFile?.path !== file.path) return;
    const full = contentEl.textContent || '';
    let from = 0;

    for (const quote of data.quotes) {
      const found = locate(full, quote.text, from);

      if (!found) continue;
      from = found.end;
      // After its closing mark, past the spaces and the punctuation before it (« … fin. »).
      let k = found.end;

      while (k < found.end + 4 && k < full.length && !CLOSERS.includes(full[k]) && !/[\p{L}\p{N}]/u.test(full[k])) k++;
      const at = k < full.length && CLOSERS.includes(full[k]) ? k + 1 : found.end;

      if (quote.state !== 'missing' || data.cites_files) this.mark(at, quote);
    }
  }

  private mark(at: number, quote: Checked): void {
    const spot = nodeAt(at);

    if (!spot) return;
    const dot = document.createElement('button');

    dot.type = 'button';
    dot.className = 'kb-cite-dot kb-cite-' + quote.state;
    dot.setAttribute('aria-label', t(LABEL[quote.state]));
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      this.open(quote, dot);
    });
    const rest = spot.offset < spot.node.length ? spot.node.splitText(spot.offset) : spot.node.nextSibling;

    spot.node.parentNode!.insertBefore(dot, rest);
  }

  private open(quote: Checked, dot: HTMLElement): void {
    this.close();
    const src = quote.source;
    const where = src ? [src.section, t('citeLine', src.line)].filter(Boolean).join(' · ') : '';
    const pop = document.createElement('div');

    pop.id = 'kb-cite-pop';
    pop.innerHTML =
      '<div class="kb-cite-head"><i class="kb-cite-dot kb-cite-' + quote.state + '"></i>' +
      escapeHtml(t(LABEL[quote.state])) + '</div>' +
      (src && src.says
        ? '<div class="kb-cite-label">' + escapeHtml(t('citeSays')) + '</div><blockquote>' +
          escapeHtml(src.says) + '</blockquote>'
        : '') +
      (src
        ? '<button type="button" class="kb-cite-src">' + escapeHtml(docLabelAt(src.path)) +
          '</button><div class="kb-cite-where">' + escapeHtml(where) + '</div>'
        : '<p>' + escapeHtml(t('citeMissingHint')) + '</p>');
    document.body.appendChild(pop);
    const rect = dot.getBoundingClientRect();
    const left = Math.min(window.scrollX + rect.left - 12, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8);
    // Under the dot, or above it when the screen ends first.
    const below = rect.bottom + 8 + pop.offsetHeight <= document.documentElement.clientHeight;

    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = window.scrollY + (below ? rect.bottom + 8 : Math.max(8, rect.top - 8 - pop.offsetHeight)) + 'px';
    this.pop = pop;
    const button = pop.querySelector('.kb-cite-src');

    if (button && src) button.addEventListener('click', () => this.goTo(src.path, src.says || quote.text));
    setTimeout(() => document.addEventListener('mousedown', this.outside), 0);
    document.addEventListener('keydown', this.escape);
  }

  // The source opened on the passage: highlighted and brought into view (a note; a file shows whole).
  private async goTo(path: string, passage: string): Promise<void> {
    this.close();
    const file = fileMap[path];

    if (!file) return;
    await docRenderer.open(file);

    if (currentFile?.path !== path) return;
    const found = locate(contentEl.textContent || '', passage.replace(/^…|…$/g, ''), 0);
    const start = found && nodeAt(found.start);
    const end = found && nodeAt(found.end);

    if (!start || !end) return;
    const range = document.createRange();

    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    // A highlight, not a <mark>: the passage may cross bold or a link, and the DOM stays as rendered.
    if ('highlights' in CSS) CSS.highlights.set('kb-cite', new Highlight(range));
    start.node.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private outside = (e: MouseEvent): void => {
    if (this.pop && !this.pop.contains(e.target as Node)) this.close();
  };

  private escape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  close(): void {
    this.pop?.remove();
    this.pop = null;
    document.removeEventListener('mousedown', this.outside);
    document.removeEventListener('keydown', this.escape);
  }
}

export const quoteMarks = new QuoteMarks();
