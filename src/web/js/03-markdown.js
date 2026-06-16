function resolveWikilink(target) {
  const { byPath, byStem } = wlMaps();
  const t = target.split('|')[0].trim().toLowerCase();
  if (!t) return null;
  // Exact path, with or without one of the known extensions.
  for (const ext of ['', ...WL_TARGET_EXTS]) {
    if (byPath[t + ext]) return byPath[t + ext];
  }
  // Fallback: match on the file stem (last segment, extension stripped).
  const stem = t.split('/').pop().replace(/\.[^.]+$/, '');
  return byStem[stem] || null;
}
// marked extension: [[target]] or [[target|text]] → navigable link (or .broken if
// unresolved). Handled as an inline token → ignored inside code blocks.
marked.use({ extensions: [{
  name: 'wikilink',
  level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);
    if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim() };
  },
  renderer(token) {
    const parts = token.target.split('|');
    const label = (parts[1] || parts[0]).trim();
    const path = resolveWikilink(parts[0].trim());
    if (path) return '<a class="wikilink" data-path="' + escapeHtml(path) + '">' + escapeHtml(label) + '</a>';
    return '<a class="wikilink broken" title="' + escapeHtml(t('brokenLink', parts[0].trim())) + '">' + escapeHtml(label) + '</a>';
  },
}] });

// Markdown → secure HTML rendering. marked doesn't neutralize raw HTML: a doc
// containing <script>/<img onerror> would run in the innerHTML. We pass the
// output through DOMPurify — a local lib (/vendor/, inlined in the offline build):
// if it's missing that's a build bug, we show an error and NEVER render
// unsanitized HTML.
function renderMd(md) {
  if (typeof DOMPurify === 'undefined') {
    console.error('DOMPurify absent : asset /vendor/purify.min.js manquant (bug de build).');
    return '<p class="text-red-400 font-sans">' + escapeHtml(t('sanitizerMissing')) + '</p>';
  }
  return DOMPurify.sanitize(marked.parse(md || ''));
}

// Interactive Markdown checkboxes: clicking a task-list checkbox
// (`- [ ]` / `- [x]`) toggles the state AND rewrites the line in the .md file via
// PUT /api/file. The order of checkboxes in the DOM follows the order of markers
// in the source (marked renders in document order), so the DOM index = the Nth
// markdown marker — we flip that very marker.
// Window (per path) signaling we just wrote this doc ourselves (checkbox
// toggle): the live-reload SSE that follows the commit must then NOT re-render
// the doc (the viewer already reflects the change) — cf. softReload.
const _selfSaveUntil = {};
const TASK_MARK_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;
function toggleNthTaskMarker(content, index, checked) {
  const lines = content.split('\n');
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!TASK_MARK_RE.test(lines[i])) continue;
    n++;
    if (n === index) {
      lines[i] = lines[i].replace(TASK_MARK_RE, '$1' + (checked ? 'x' : ' ') + '$3');
      return lines.join('\n');
    }
  }
  return null;  // DOM/source out of sync: index not found
}
