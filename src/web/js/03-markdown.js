function resolveWikilink(target) {
  const { byPath, byStem } = wlMaps();
  const t = target.split('|')[0].trim().toLowerCase();

  if (!t) return null;

  // Exact path, with or without one of the known extensions.
  for (const ext of ['', ...WL_TARGET_EXTS]) {
    if (byPath[t + ext]) return byPath[t + ext];
  }

  // Fallback: match on the file stem (last segment, extension stripped).
  const stem = t
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '');

  return byStem[stem] || null;
}

// marked extension: [[target]] or [[target|text]] → navigable link (or .broken if
// unresolved). Handled as an inline token → ignored inside code blocks.
marked.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start(src) {
        return src.indexOf('[[');
      },
      tokenizer(src) {
        const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);

        if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim() };
      },
      renderer(token) {
        const parts = token.target.split('|');
        const label = (parts[1] || parts[0]).trim();
        const path = resolveWikilink(parts[0].trim());

        if (path)
          return (
            '<a class="wikilink" data-path="' + escapeHtml(path) + '">' + escapeHtml(label) + '</a>'
          );

        return (
          '<a class="wikilink broken" title="' +
          escapeHtml(t('brokenLink', parts[0].trim())) +
          '">' +
          escapeHtml(label) +
          '</a>'
        );
      },
    },
  ],
});

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

// Live-reload suppression window (per path): after we write a doc ourselves (a
// checkbox toggle), the SSE that follows the commit must NOT re-render it — cf.
// softReload.
const _selfSaveUntil = {};
// In-flight checkbox PUTs. The rollup is computed live from disk, so
// loadTasksIndex awaits these before fetching — else it reads the pre-toggle file.
const _taskWrites = new Set();
// Flipping the Nth rendered checkbox flips the Nth source marker, so the count
// must mirror marked exactly: skip fenced-code tasks (no checkbox), count
// blockquoted ones (marked renders them) — and a fence nested in a blockquote is
// not honoured here, so detect fences only outside blockquotes.
const TASK_MARK_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;
const _FENCE_RE = /^(?:`{3,}|~{3,})/;
const _BQ_RE = /^\s*>[ \t]?/;

function _stripBlockquote(line) {
  let s = line,
    quoted = false;

  while (_BQ_RE.test(s)) {
    s = s.replace(_BQ_RE, '');
    quoted = true;
  }

  return [s, quoted];
}

function toggleNthTaskMarker(content, index, checked) {
  const lines = content.split('\n');
  let n = -1,
    inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const [unquoted, quoted] = _stripBlockquote(lines[i]);

    if (!quoted && _FENCE_RE.test(lines[i].trimStart())) {
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    if (!TASK_MARK_RE.test(unquoted)) continue;
    n++;

    if (n === index) {
      const prefix = lines[i].slice(0, lines[i].length - unquoted.length); // keep the `>`

      lines[i] = prefix + unquoted.replace(TASK_MARK_RE, '$1' + (checked ? 'x' : ' ') + '$3');

      return lines.join('\n');
    }
  }

  return null;
}
