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
// PUT /api/file. The clicked box is the Nth rendered checkbox; to flip the right
// source line we must count markers EXACTLY as marked emits checkboxes — otherwise
// the Nth box maps to the wrong line. Two divergences to mirror:
//   • a `- [ ]` inside a fenced code block (``` / ~~~) renders NO checkbox → skip it;
//   • a blockquoted task (`> - [ ]`) DOES render a checkbox → count it (strip the
//     `>` prefix first). Note marked here does not honour a fence nested in a
//     blockquote, so fences are detected only OUTSIDE blockquotes.
// Window (per path) signaling we just wrote this doc ourselves (checkbox
// toggle): the live-reload SSE that follows the commit must then NOT re-render
// the doc (the viewer already reflects the change) — cf. softReload.
const _selfSaveUntil = {};
// In-flight checkbox writes (the PUT /api/file fired by a task toggle). The task
// rollup is computed LIVE from the files on disk, so opening the list right after
// ticking a box must wait for that write to land — otherwise the GET reads the
// pre-toggle file and the box shows back unchecked. loadTasksIndex awaits these.
const _taskWrites = new Set();
const TASK_MARK_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;
const _FENCE_RE = /^(?:`{3,}|~{3,})/;
const _BQ_RE = /^\s*>[ \t]?/;            // one blockquote level
// Strip every leading blockquote level → [content, wasQuoted].
function _stripBlockquote(line) {
  let s = line, quoted = false;
  while (_BQ_RE.test(s)) { s = s.replace(_BQ_RE, ''); quoted = true; }
  return [s, quoted];
}
function toggleNthTaskMarker(content, index, checked) {
  const lines = content.split('\n');
  let n = -1, inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const [unquoted, quoted] = _stripBlockquote(lines[i]);
    // Top-level fence toggles code mode (its tasks render no checkbox); a fence
    // inside a blockquote is not honoured by marked here, so we ignore it.
    if (!quoted && _FENCE_RE.test(lines[i].trimStart())) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!TASK_MARK_RE.test(unquoted)) continue;
    n++;
    if (n === index) {
      // Rewrite the marker on the unquoted body, preserving the `>` prefix.
      const prefix = lines[i].slice(0, lines[i].length - unquoted.length);
      lines[i] = prefix + unquoted.replace(TASK_MARK_RE, '$1' + (checked ? 'x' : ' ') + '$3');
      return lines.join('\n');
    }
  }
  return null;  // DOM/source out of sync: index not found
}
