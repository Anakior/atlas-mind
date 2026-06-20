"""Server extensions (<mind>/.atlas/extensions/*.py).

Minimal extension hook (spec decision: two hooks, not a plugin system). At boot,
load_server_extensions(config, routes) loads every Python module from the mind's
extensions folder; each module exposes register(context) and registers its routes
via context.add_route(...). A broken extension = stderr warning and we carry on,
never a crash at boot. The registered routes live on the AppContext
(_CTX.extension_routes) and are read by Handler._dispatch_extension.
"""
import re
import sys

import server as _s

EXTENSION_ROLES = ("public", "auth", "admin")


class ExtensionContext:
    """Object passed to register(context) of each server extension.

    - context.config: the server's AtlasConfig (paths, identity, port…).
    - context.add_route(method, pattern, handler, role=None): registers an HTTP
      route. `method` is "GET" or "POST"; `pattern` is a regex matched (re.match)
      against the path WITHOUT the query string; `handler` is called as
      handler(http_handler, match) with the request's HTTP Handler
      (http_handler._read_json(), http_handler._send_json(status, payload)…)
      and the regex match (captured groups). `role`: "public" (no auth), "auth"
      (any logged-in session) or "admin" (admin session). Default: "auth" for
      GET, "admin" for POST. In local mode (auth disabled), the simulated session
      is admin: everything passes.

      CSRF (T4): a mutating POST route with role "auth"/"admin" is CSRF-checked in
      cloud mode, exactly like the core POST routes — the client must send the
      X-CSRF-Token header. The viewer's global fetch wrapper injects it
      automatically, so an extension using `fetch()` needs no special handling; a
      raw XHR must add it (read the readable kb_csrf cookie). A "public" route is
      not CSRF-checked (it self-protects, e.g. a webhook verifying a signature).
    """

    def __init__(self, config, routes):
        self.config = config
        self._routes = routes

    def add_route(self, method, pattern, handler, role=None):
        method = (method or "").upper()
        if method not in ("GET", "POST"):
            raise ValueError(f"unsupported method: {method!r} (GET or POST)")
        if role is None:
            role = "admin" if method == "POST" else "auth"
        if role not in EXTENSION_ROLES:
            raise ValueError(
                f"unknown role: {role!r} (public, auth or admin)")
        self._routes.append((method, re.compile(pattern), handler, role))


def load_server_extensions(config, routes=None):
    """Load the Python modules in <mind>/.atlas/extensions/*.py (alphabetical
    order) and call their register(context).

    Any failure (import, missing or faulty register) = stderr warning and we move
    on to the next extension: a broken extension NEVER kills the boot. Missing
    folder = no extensions, behavior strictly unchanged."""
    import importlib.util
    if routes is None:
        routes = _s._CTX.extension_routes
    extensions_dir = config.extensions_dir
    if not extensions_dir.is_dir():
        return routes
    for path in sorted(extensions_dir.glob("*.py")):
        try:
            spec = importlib.util.spec_from_file_location(
                f"atlas_extension_{path.stem}", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            register = getattr(module, "register", None)
            if not callable(register):
                print(f"[extensions] {path.name} skipped: no register(context) "
                      "function", file=sys.stderr)
                continue
            register(ExtensionContext(config, routes))
            print(f"[extensions] {path.name} loaded", file=sys.stderr)
        except Exception as e:
            print(f"[extensions] {path.name} skipped: {e}", file=sys.stderr)
    return routes
