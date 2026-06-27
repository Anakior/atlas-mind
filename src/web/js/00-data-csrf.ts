// ─── Data injected by build.py ───────────────────────────────────────────
// Online: EMBED_* are null, loaded on demand from the server.
// Offline: they hold the inline data (standalone HTML).
// The __NAME__ barewords are JSON literals pasted by render.py (single regex pass); esbuild
// strips the types but never touches them, so the Python substitution still lands. Foundation
// layer: NOT wrapped in an IIFE — these are the shared globals the rest of the viewer reads.
const TREE = __DATA__;
const EMBED_CONTENT = __EMBED_CONTENT__;
const EMBED_BACKLINKS = __EMBED_BACKLINKS__;
const EMBED_NOTES = __EMBED_NOTES__;
const EMBED_TASKS = __EMBED_TASKS__;
// Frozen activity-layer snapshot {events, stale, contradictions} for the offline
// build (public minds); null online → the home fetches /api/activity live.
const EMBED_ACTIVITY = __EMBED_ACTIVITY__;
// New-document skeletons {label: markdown}, label = file name without extension.
// Engine templates/ merged with <mind>/templates/ (mind overrides).
const DOC_TEMPLATES = __TEMPLATES__;
const IS_OFFLINE_BUILD = EMBED_CONTENT !== null;
// Captured from <title> BEFORE the todos badge mutates it. Entities are already
// decoded by the parser, so re-escape via escapeHtml when displaying.
const SITE_NAME = document.title;
// Injected as JSON constants, not raw text placeholders: a backtick or ${…} in
// atlas.toml must neither break the script nor evaluate code.
const TAGLINE = __TAGLINE_JSON__;
const SITE_PREFIX = __SITE_PREFIX_JSON__;

// ─── CSRF synchronizer ───────────────────────────────────────────────────────
// In cloud mode every authenticated MUTATING request needs the X-CSRF-Token
// header (HMAC of email|epoch). We wrap window.fetch ONCE so any same-origin
// mutating request gets it automatically. Token source, by priority:
//   1. /api/me csrf_token — authoritative after epoch rotation;
//   2. else the kb_csrf cookie (readable, not HttpOnly) — for the first call
//      before /api/me responds.
// Refreshed via setCsrfToken() after any epoch bump (logout-all, TOTP enable/disable).
let csrfToken: string | null = null;
let meState: MeResponse | null = null; // latest /api/me (email, role, cloud, totp_enabled…)
let totpEnabled = false; // 2FA state of the current account (cloud)

function readCsrfCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)kb_csrf=([^;]+)/);

  return m ? decodeURIComponent(m[1]) : null;
}

function setCsrfToken(token: string | null): void {
  if (token) csrfToken = token;
}

function currentCsrfToken(): string | null {
  return csrfToken || readCsrfCookie();
}

(function installCsrfFetch(): void {
  const nativeFetch = window.fetch.bind(window);
  const MUTATING: Record<string, number> = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    init = init || {};
    // A non-string input is a Request (or URL, which has no method/headers — read as undefined).
    const req = typeof input === 'string' ? null : (input as Request);
    const method = (init.method || (req && req.method) || 'GET').toUpperCase();
    // Only mutating requests to a relative (same-origin) URL: an absolute URL
    // (CDN, external) must never receive our token.
    const url = typeof input === 'string' ? input : (req && req.url) || '';
    const sameOrigin = url && !/^https?:\/\//i.test(url);

    if (MUTATING[method] && sameOrigin) {
      const token = currentCsrfToken();

      if (token) {
        const headers = new Headers(init.headers || (req ? req.headers : undefined) || {});

        if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
        init = Object.assign({}, init, { headers });
      }
    }

    return nativeFetch(input, init);
  };
})();
