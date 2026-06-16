"""Declarative HTTP routing for the Handler.

A `Route` binds a path matcher (`RouteKind` + pattern) to a route function and a
`Guard`. `Router.dispatch` walks a verb's ordered table; the first route whose
pattern matches (and whose `when` predicate passes) has its `Guard` applied —
delegating to the Handler's unchanged `_require_*` / `_check_csrf_*` methods — and,
if the guard passes, its function is called with the live Handler. ORDER IS
SEMANTIC: the table reproduces the legacy if/elif fall-through (first match wins).

Route functions live in `server/routes/*.py` and DO NOT self-guard — the `Guard`
declared in the table is the single auth point. The verbs whose every route shares
one guard (PATCH/PUT/DELETE: admin + CSRF) keep that guard at the verb level in
do_<VERB> (so an unknown path still yields 403-before-404), and declare their
routes `PUBLIC`.
"""
import enum
import re


class RouteKind(enum.Enum):
    EXACT = "exact"                    # path == pattern
    EXACT_NOQUERY = "exact_noquery"    # path before '?' == pattern
    PREFIX = "prefix"                  # path.startswith(pattern)
    PREFIX_NOQUERY = "prefix_noquery"  # path before '?' startswith pattern
    ANY_OF = "any_of"                  # path in pattern (a tuple of exact paths)
    REGEX = "regex"                    # compiled pattern .match(path)


class Guard(enum.Enum):
    PUBLIC = "public"          # no guard (or the route self-verifies, e.g. a page)
    AUTH = "auth"              # _require_auth_or_401
    CSRF_BASE = "csrf_base"    # _require_auth_or_401 + _check_csrf_or_403
    ADMIN = "admin"            # _require_admin_or_403
    ADMIN_CSRF = "admin_csrf"  # _require_admin_or_403 + _check_csrf_or_403
    BEARER = "bearer"          # no cookie guard; the route self-verifies a Bearer token
    PAGE_AUTH = "page_auth"    # _require_auth_or_redirect (navigable page → 303 login)


def _compile_matcher(kind, pattern):
    if kind is RouteKind.EXACT:
        return lambda p: p == pattern
    if kind is RouteKind.EXACT_NOQUERY:
        return lambda p: p.split("?", 1)[0] == pattern
    if kind is RouteKind.PREFIX:
        return lambda p: p.startswith(pattern)
    if kind is RouteKind.PREFIX_NOQUERY:
        return lambda p: p.split("?", 1)[0].startswith(pattern)
    if kind is RouteKind.ANY_OF:
        return lambda p: p in pattern
    if kind is RouteKind.REGEX:
        compiled = re.compile(pattern)
        return lambda p: compiled.match(p) is not None
    raise ValueError(f"unknown RouteKind: {kind!r}")


class Route:
    """One declarative route. `handler(h)` is a function in server/routes/*.py that
    takes the live Handler and self-guards NOTHING. `when(h)` optionally gates the
    route on a runtime predicate (e.g. cloud mode); a route whose `when` returns
    False is skipped, falling through like the legacy `if CONFIG.auth_enabled and …`."""

    __slots__ = ("kind", "pattern", "handler", "guard", "when", "_match")

    def __init__(self, kind, pattern, handler, guard=Guard.PUBLIC, when=None):
        self.kind = kind
        self.pattern = pattern
        self.handler = handler
        self.guard = guard
        self.when = when
        self._match = _compile_matcher(kind, pattern)

    def matches(self, path) -> bool:
        return self._match(path)


def _apply_guard(handler, guard) -> bool:
    """Run the guard for `guard` against the live Handler. Returns True to proceed,
    False if the guard already sent the 401/403/redirect (dispatch then stops).
    The `and` short-circuits exactly like the legacy two-line guard sequence."""
    if guard is Guard.PUBLIC or guard is Guard.BEARER:
        return True
    if guard is Guard.AUTH:
        return handler._require_auth_or_401()
    if guard is Guard.CSRF_BASE:
        return handler._require_auth_or_401() and handler._check_csrf_or_403()
    if guard is Guard.ADMIN:
        return handler._require_admin_or_403()
    if guard is Guard.ADMIN_CSRF:
        return handler._require_admin_or_403() and handler._check_csrf_or_403()
    if guard is Guard.PAGE_AUTH:
        return handler._require_auth_or_redirect()
    raise ValueError(f"unknown Guard: {guard!r}")


def dispatch(handler, routes) -> bool:
    """Walk `routes` in order; the FIRST route that matches (and whose `when`
    passes) handles the request: its guard is applied, then — if the guard passed —
    its handler is called. Returns True if a route handled it (including when the
    guard sent a 401/403), False to let the caller fall through (extension dispatch,
    navigable serving or a 404)."""
    path = handler.path
    for route in routes:
        if route.when is not None and not route.when(handler):
            continue
        if route.matches(path):
            if _apply_guard(handler, route.guard):
                route.handler(handler)
            return True
    return False
