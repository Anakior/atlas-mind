// ─── Data injected by build.py ───────────────────────────────────────────
// Online mode: EMBED_CONTENT and EMBED_BACKLINKS are `null`, the contents
//   and the backlinks index are loaded on demand from the server.
// Offline mode: these variables contain the inline data (standalone HTML).
const TREE = __DATA__;
const EMBED_CONTENT = __EMBED_CONTENT__;
const EMBED_BACKLINKS = __EMBED_BACKLINKS__;
const EMBED_NOTES = __EMBED_NOTES__;
const EMBED_TASKS = __EMBED_TASKS__;
// New-document skeletons: {label: markdown content}, label = file name
// without extension. Discovered by build.py in templates/ (engine)
// merged with <mind>/templates/ (the mind adds or overrides its own).
const DOC_TEMPLATES = __TEMPLATES__;
const IS_OFFLINE_BUILD = EMBED_CONTENT !== null;
// Site name injected by build.py into <title>: captured BEFORE any mutation
// of the title by the todos badge (HTML entities already decoded by the parser,
// so they must be re-escaped via escapeHtml when displaying).
const SITE_NAME = document.title;
// Tagline and brand prefix injected as JSON constants (never a text
// placeholder in a JS string: a backtick or ${…} in atlas.toml
// must neither break the script nor evaluate code).
const TAGLINE = __TAGLINE_JSON__;
const SITE_PREFIX = __SITE_PREFIX_JSON__;

// ─── CSRF synchronizer (batch 2d) ───────────────────────────────────────────────
// In cloud mode, any authenticated MUTATING request (POST/PUT/PATCH/DELETE)
// requires the X-CSRF-Token header (HMAC tied to email|epoch). Rather than wiring
// the header on every scattered call (file, notes, todos, share, admin,
// account), we wrap window.fetch ONCE: any same-origin mutating request
// automatically receives the token. Token source, by priority:
//   1. the value read from /api/me (csrf_token) — authoritative after epoch rotation;
//   2. otherwise, the kb_csrf cookie (readable, NOT HttpOnly) — useful for the very
//      first call before /api/me has responded.
// The token is refreshed after every action that bumps the epoch (logout-all,
// enable/disable TOTP) via setCsrfToken().
let csrfToken = null;
let meState = null;       // latest /api/me (email, role, cloud, totp_enabled…)
let totpEnabled = false;  // 2FA state of the current account (cloud)
function readCsrfCookie() {
  const m = document.cookie.match(/(?:^|;\s*)kb_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function setCsrfToken(token) { if (token) csrfToken = token; }
function currentCsrfToken() { return csrfToken || readCsrfCookie(); }
(function installCsrfFetch() {
  const nativeFetch = window.fetch.bind(window);
  const MUTATING = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  window.fetch = function(input, init) {
    init = init || {};
    const method = (init.method || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
    // We touch ONLY mutating requests to a relative URL (same origin).
    // Absolute URLs (CDN, external) must never receive our token.
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const sameOrigin = url && !/^https?:\/\//i.test(url);
    if (MUTATING[method] && sameOrigin) {
      const token = currentCsrfToken();
      if (token) {
        const headers = new Headers(init.headers || (typeof input !== 'string' && input && input.headers) || {});
        if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
        init = Object.assign({}, init, { headers });
      }
    }
    return nativeFetch(input, init);
  };
})();

// ─── i18n (fr/en dictionary — the language comes from atlas.toml, set by build.py) ────
// build.py sets the language on <html lang>. All UI labels go through
// t(key, ...args); technical values (CSS classes, API keys, todo
// categories that are data) are NOT translated. The generated content
// templates (document models) remain content.
