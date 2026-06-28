// Passage-annotation geometry: maps a live text selection (or a stored anchor) to global character
// offsets inside #content, and paints a resolved range as <mark> highlights. Pure DOM-text math — no
// network, no popover, no panel state. The <mark>s are injected AFTER DOMPurify (so the note text
// never goes through markdown rendering) and live inside #content rather than the keyed runtime, so
// callers re-apply them after each content render.

import { contentEl } from '../../core/dom-refs';

// The locator subset of a note, built from a live selection and POSTed verbatim as the note's
// anchor fields. Single-file, so not promoted to interface/.
export type TextQuoteAnchor = Pick<NotePersisted, 'exact' | 'prefix' | 'suffix' | 'pos'>;

// Text-quote anchoring (exact + prefix/suffix context + approximate pos), W3C Web Annotation style:
// resilient to text shifts; if the passage disappears the note becomes orphaned.
export class NoteAnchor {
  private static readonly CTX_LEN = 60; // captured prefix/suffix context length

  // Global text offset of a (node, offset) within contentEl, by walking the text nodes. -1 if the
  // node isn't under contentEl.
  private textOffsetOf(node: Node, offset: number): number {
    if (!contentEl.contains(node)) return -1;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let n: Node | null;

    while ((n = walker.nextNode())) {
      if (n === node) return acc + offset;
      acc += n.nodeValue!.length;
    }

    return -1;
  }

  // Builds a text-quote anchor from the current selection.
  selectionToAnchor(): TextQuoteAnchor | null {
    const sel = window.getSelection();

    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);

    if (!contentEl.contains(r.commonAncestorContainer)) return null;
    const start = this.textOffsetOf(r.startContainer, r.startOffset);
    const end = this.textOffsetOf(r.endContainer, r.endOffset);

    if (start < 0 || end < 0 || end <= start) return null;
    const full = contentEl.textContent || '';
    const exact = full.slice(start, end);

    if (!exact.trim()) return null;

    return {
      exact,
      prefix: full.slice(Math.max(0, start - NoteAnchor.CTX_LEN), start),
      suffix: full.slice(end, end + NoteAnchor.CTX_LEN),
      pos: start,
    };
  }

  // Re-locates an anchor in the current text → {start, end} or null (orphan). Searches all
  // occurrences of `exact`, scores by prefix/suffix context and proximity to `pos`, keeps the best.
  locateAnchor(a: TextQuoteAnchor): { start: number; end: number } | null {
    const full = contentEl.textContent || '';

    if (!a.exact) return null;
    const idxs: number[] = [];
    let i = full.indexOf(a.exact);

    while (i !== -1) {
      idxs.push(i);
      i = full.indexOf(a.exact, i + 1);
    }

    if (!idxs.length) return null;
    let best = idxs[0];
    let bestScore = -Infinity;

    for (const s of idxs) {
      let score = 0;
      const before = full.slice(Math.max(0, s - NoteAnchor.CTX_LEN), s);
      const after = full.slice(s + a.exact.length, s + a.exact.length + NoteAnchor.CTX_LEN);

      if (a.prefix && before.endsWith(a.prefix)) score += 100;
      else if (a.prefix) {
        let k = 0;

        while (
          k < a.prefix.length &&
          before[before.length - 1 - k] === a.prefix[a.prefix.length - 1 - k]
        )
          k++;
        score += k;
      }

      if (a.suffix && after.startsWith(a.suffix)) score += 100;
      else if (a.suffix) {
        let k = 0;

        while (k < a.suffix.length && after[k] === a.suffix[k]) k++;
        score += k;
      }

      score -= Math.abs(s - (a.pos || 0)) / 1000;

      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }

    return { start: best, end: best + a.exact.length };
  }

  // Wraps the global text range [start,end) in <mark> (one per traversed text node), with data-* +
  // click handler. Injected AFTER DOMPurify, so the note text never goes through markdown rendering.
  // onMarkClick fires when a painted <mark> is clicked; the panel routes it to the popover.
  highlightRange(
    start: number,
    end: number,
    note: NoteResolved,
    onMarkClick: (note: NoteResolved, mark: Element) => void,
  ): boolean {
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let n: Node | null;
    const todo: Array<{ node: Text; from: number; to: number }> = [];

    while ((n = walker.nextNode())) {
      const len = n.nodeValue!.length;
      const ns = acc;
      const ne = acc + len;

      if (ne > start && ns < end) {
        todo.push({ node: n as Text, from: Math.max(0, start - ns), to: Math.min(len, end - ns) });
      }

      acc = ne;

      if (ns >= end) break;
    }

    for (const seg of todo) {
      let node = seg.node;

      if (seg.to < node.nodeValue!.length) node.splitText(seg.to);

      if (seg.from > 0) node = node.splitText(seg.from);
      const mark = document.createElement('mark');

      mark.className = 'kb-annot';
      mark.dataset.noteId = note.id;
      node.parentNode!.insertBefore(mark, node);
      mark.appendChild(node);
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        onMarkClick(note, mark);
      });
    }

    return todo.length > 0;
  }
}

export const noteAnchor = new NoteAnchor();
