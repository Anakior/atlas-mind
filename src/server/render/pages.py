"""Served HTML page templates (web/pages/<name>.html, marker substitution) + the
share page's extension assets. Both caches are module-level (read once; the pages
ship with the package, the extension assets only change on a redeploy)."""
import re
import sys

import server as _s

_PAGE_CACHE = {}
_SHARE_EXTENSION_ASSETS = None


def _load_page(name: str) -> str:
    """Read (and cache) a served HTML page template from web/pages/<name>.html.

    The engine's login / setup / share pages are real HTML files shipped with the
    package (web/**), not Python string constants."""
    if name not in _PAGE_CACHE:
        _PAGE_CACHE[name] = (
            _s.CONFIG.web_dir / "pages" / f"{name}.html"
        ).read_text(encoding="utf-8")
    return _PAGE_CACHE[name]


def render_page(name: str, **fields) -> str:
    """Fill web/pages/<name>.html: each kwarg foo=val replaces the __FOO__ marker.

    ONE pass (injected values are never re-scanned), so a field value that itself
    contains a __MARKER__ is safe — same guarantee as the viewer build."""
    template = _load_page(name)
    if not fields:
        return template
    repl = {f"__{k.upper()}__": v for k, v in fields.items()}
    pattern = re.compile("|".join(re.escape(p) for p in sorted(repl, key=len, reverse=True)))
    return pattern.sub(lambda m: repl[m.group(0)], template)


def share_extension_assets():
    """CSS and JS of the mind's extensions for the share page: same source as the
    viewer (<mind>/.atlas/extensions/*.css|*.js), with closing tags neutralized the
    same way. Cached (read once — extensions only change on a redeploy)."""
    global _SHARE_EXTENSION_ASSETS
    if _SHARE_EXTENSION_ASSETS is not None:
        return _SHARE_EXTENSION_ASSETS
    try:
        build = _s._import_build()
        css, js = build.load_extension_assets(_s.CONFIG.extensions_dir)
        _SHARE_EXTENSION_ASSETS = (
            build._escape_closing_tag(css, build._CLOSING_STYLE_RE),
            build._escape_closing_tag(js, build._CLOSING_SCRIPT_RE),
        )
    except Exception as e:
        print(f"[share extensions] {e}", file=sys.stderr)
        _SHARE_EXTENSION_ASSETS = ("", "")
    return _SHARE_EXTENSION_ASSETS
