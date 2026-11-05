import { t } from './i18n';

// ─── Data injected by render.py ───────────────────────────────────────────
// Online: EMBED_* are null, loaded on demand from the server.
// Offline: they hold the inline data (standalone HTML).
// The __NAME__ barewords are JSON literals pasted by render.py (single regex pass); esbuild
// strips the types but never touches them, so the Python substitution still lands. They are
// exported as module bindings the rest of the viewer imports.
declare const __DATA__: DirNode;
declare const __EMBED_CONTENT__: Record<string, string> | null;
declare const __EMBED_BACKLINKS__: any;
declare const __EMBED_NOTES__: any;
declare const __EMBED_TASKS__: any;
declare const __EMBED_ACTIVITY__: any;
declare const __TEMPLATES__: Record<string, string>;
declare const __TAGLINE_JSON__: string;
declare const __SITE_PREFIX_JSON__: string;
declare const __BASE_PATH_JSON__: string;

export const TREE = __DATA__;
export const EMBED_CONTENT = __EMBED_CONTENT__;
export const EMBED_BACKLINKS = __EMBED_BACKLINKS__;
export const EMBED_NOTES = __EMBED_NOTES__;
export const EMBED_TASKS = __EMBED_TASKS__;
// Frozen activity-layer snapshot {events, stale, contradictions} for the offline
// build (public minds); null online → the home fetches /api/activity live.
export const EMBED_ACTIVITY = __EMBED_ACTIVITY__;
// New-document skeletons {label: markdown}, label = file name without extension.
// Engine templates/ merged with <mind>/templates/ (mind overrides).
export const DOC_TEMPLATES = __TEMPLATES__;
export const IS_OFFLINE_BUILD = EMBED_CONTENT !== null;
// Captured from <title> BEFORE the todos badge mutates it. Entities are already
// decoded by the parser, so re-escape via escapeHtml when displaying.
export const SITE_NAME = document.title;
// Injected as JSON constants, not raw text placeholders: a backtick or ${…} in
// atlas.toml must neither break the script nor evaluate code. Settings › Apparence changes
// them live (setIdentity).
export let TAGLINE: string = __TAGLINE_JSON__;
export let SITE_PREFIX: string = __SITE_PREFIX_JSON__;
// The path Atlas is served under ("" at the root of its address, "/notes/atlas" below it): every
// URL the page makes starts with it. fetch() gets it from the wrapper below; href, src, EventSource
// and the like call url().
export const BASE: string = IS_OFFLINE_BUILD ? '' : __BASE_PATH_JSON__;
export const url = (path: string): string => BASE + path;
// A doc's address inside Atlas, for fetch(); docUrl is the full one, for an href or a src.
export const docPath = (path: string): string => '/' + path.split('/').map(encodeURIComponent).join('/');
export const docUrl = (path: string): string => url(docPath(path));
export function setIdentity(prefix: string, tagline: string): void {
  SITE_PREFIX = prefix;
  TAGLINE = tagline;
}

// ─── CSRF synchronizer ───────────────────────────────────────────────────────
// In cloud mode every authenticated MUTATING request needs the X-CSRF-Token
// header (HMAC of email|epoch). We wrap window.fetch ONCE so any same-origin
// mutating request gets it automatically. Token source, by priority:
//   1. /api/me csrf_token — authoritative after epoch rotation;
//   2. else the kb_csrf cookie (readable, not HttpOnly) — for the first call
//      before /api/me responds.
// Refreshed via setCsrfToken() after any epoch bump (logout-all, TOTP enable/disable).
export let csrfToken: string | null = null;
export let meState: MeResponse | null = null; // latest /api/me (email, role, cloud, totp_enabled…)

export function setMeState(v: MeResponse | null): void {
  meState = v;
}

export let totpEnabled = false; // 2FA state of the current account (cloud)

export function setTotpEnabled(v: boolean): void {
  totpEnabled = v;
}

export function readCsrfCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)kb_csrf=([^;]+)/);

  return m ? decodeURIComponent(m[1]) : null;
}

export function setCsrfToken(token: string | null): void {
  if (token) csrfToken = token;
}

export function currentCsrfToken(): string | null {
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

    // A path from the root of the address ("/api/…", docPath()) is Atlas's own: the base path goes in
    // front of it, always — never guessed from the path, which a folder named like the base would fool.
    if (typeof input === 'string' && input.startsWith('/') && !input.startsWith('//')) input = BASE + input;

    // A request that never reached Atlas says so in the page's language, not "Failed to fetch".
    return nativeFetch(input, init).catch((e: unknown) => {
      throw e instanceof TypeError ? new TypeError(t('errNetwork')) : e;
    });
  };
})();
