// Markdown rendering: secure HTML via marked + DOMPurify, plus the [[wikilink]] resolution. The base
// marked config + the wikilink path maps live in 02-content-tree.ts (load order); this class adds the
// wikilink inline extension and the render behaviour. The task-checkbox source toggle lives in
// 03b-task-markers.ts.

import { escapeHtml } from '../core/utils';
import { t } from '../core/i18n';
import { wlMaps, WL_TARGET_EXTS } from './content-tree';

export class Markdown {
  constructor() {
    marked.use({ extensions: [this.wikilinkExtension()] });
  }

  // marked leaves raw HTML intact — a doc with <script>/<img onerror> would run in the innerHTML.
  // The output goes through DOMPurify (vendored, inlined in the offline build); if it is missing
  // that is a build bug, so show an error and NEVER render unsanitised HTML.
  render(md: string): string {
    if (typeof DOMPurify === 'undefined') {
      console.error('DOMPurify absent : asset /vendor/purify.min.js manquant (bug de build).');

      return '<p class="text-red-400 font-sans">' + escapeHtml(t('sanitizerMissing')) + '</p>';
    }

    return DOMPurify.sanitize(marked.parse(md || ''));
  }

  // [[target]] / [[target|text]] → a navigable link (.broken when unresolved). Inline token, so it
  // is ignored inside code blocks.
  private wikilinkExtension() {
    return {
      name: 'wikilink',
      level: 'inline',
      start: (src: string) => src.indexOf('[['),
      tokenizer: (src: string) => {
        const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);

        return m ? { type: 'wikilink', raw: m[0], target: m[1].trim() } : undefined;
      },
      renderer: (token: { target: string }) => {
        const parts = token.target.split('|');
        const label = (parts[1] || parts[0]).trim();
        const path = this.resolveWikilink(parts[0].trim());

        if (path) return '<a class="wikilink" data-path="' + escapeHtml(path) + '">' + escapeHtml(label) + '</a>';

        return '<a class="wikilink broken" title="' + escapeHtml(t('brokenLink', parts[0].trim())) + '">' + escapeHtml(label) + '</a>';
      },
    };
  }

  private resolveWikilink(target: string): string | null {
    const { byPath, byStem } = wlMaps();
    const norm = target.split('|')[0].trim().toLowerCase();

    if (!norm) return null;

    // Exact path, with or without one of the known extensions.
    for (const ext of ['', ...WL_TARGET_EXTS]) {
      if (byPath[norm + ext]) return byPath[norm + ext];
    }

    // Fallback: the file stem (last segment, extension stripped).
    const stem = norm.split('/').pop()!.replace(/\.[^.]+$/, '');

    return byStem[stem] || null;
  }
}

export const markdown = new Markdown();
