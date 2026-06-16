"""Template rendering for the build pipeline.

Substitutes the viewer.html placeholders (__DATA__, __EMBED_*, __SITE_*, the
extension CSS/JS, ...) in one pass, and generates the PWA manifest. The build
facade re-exports render_template / render_manifest (imported by the tests)."""
from __future__ import annotations

import html as _html
import json
import re
from pathlib import Path

from build.assets import (
    _escape_closing_tag, _CLOSING_SCRIPT_RE, _CLOSING_STYLE_RE, _CLOSING_HEAD_RE,
    concat_sources,
)
from build.paths import (
    SITE_WORDMARK, DEFAULT_SITE_PREFIX, DEFAULT_TAGLINE, DEFAULT_LANG,
    DEFAULT_TODO_CATEGORIES, TEMPLATE, STYLES_DIR, PARTIALS_DIR, JS_DIR,
)

# ─── Template rendering ───────────────────────────────────────────────────────


def _derive_site_name(site_prefix: str) -> str:
    """Full name derived from the prefix (mirror of AtlasConfig.site_name):
    "<prefix> Atlas", or "Atlas" alone."""
    if not site_prefix:
        return SITE_WORDMARK
    return f"{site_prefix} {SITE_WORDMARK}"


def _engine_version() -> str:
    """Running atlas-mind version, shown in the sidebar footer. Installed →
    package metadata; source run → parse __version__ from the sibling
    __init__.py. Empty string if neither is available (footer just omits it)."""
    try:
        from importlib.metadata import version
        return version("atlas-mind")
    except Exception:
        pass
    try:
        # The atlas_mind package __init__ (src/__init__.py) holds __version__;
        # from this sub-package that is two levels up.
        init = (Path(__file__).resolve().parent.parent / "__init__.py").read_text(encoding="utf-8")
        match = re.search(r'__version__\s*=\s*"([^"]+)"', init)
        if match:
            return match.group(1)
    except OSError:
        pass
    return ""


def render_template(*, tree: dict, embed_content: dict | None,
                    embed_backlinks: dict | None, embed_notes: dict | None,
                    embed_tasks=None,
                    build_ts: str, template_path: Path | None = None,
                    site_prefix: str = DEFAULT_SITE_PREFIX,
                    tagline: str = DEFAULT_TAGLINE,
                    lang: str = DEFAULT_LANG,
                    todo_categories: list | None = None,
                    doc_templates: dict | None = None,
                    extensions_css: str = "",
                    extensions_js: str = "") -> str:
    template = (template_path or TEMPLATE).read_text(encoding="utf-8")
    # Phase 1 — inline the split viewer sources back into the shell, BEFORE the
    # placeholder pass: the fragments are the viewer's own trusted source (CSS /
    # HTML markup / app JS, byte-moved from the former monolith), so their own
    # injection placeholders (__DATA__, __VERSION__, __SITE_PREFIX__, …) must JOIN
    # the single substitution pass below, exactly as when everything was one file.
    # Distinct tokens, replacement values never contain these three → safe. Until a
    # concern is extracted its directory is absent (concat_sources → "") → no-op.
    template = template.replace("__STYLES__", concat_sources(STYLES_DIR, (".css",)))
    template = template.replace("__BODY__", concat_sources(PARTIALS_DIR, (".html",)))
    template = template.replace("__APP_JS__", concat_sources(JS_DIR, (".js",)))
    # Phase 2 — JSON encode and protect </script> termination.
    def _enc(obj) -> str:
        return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")
    # Escaped identity (quote=True): injected into HTML text and attributes
    # (title, meta content="…", H1 span). On the JS side, the viewer re-reads
    # the name from document.title and receives prefix and tagline as
    # JSON-encoded constants (__SITE_PREFIX_JSON__ / __TAGLINE_JSON__) — no text
    # placeholder ends up inside a template literal, so neither a backtick nor a
    # ${…} coming from atlas.toml can break the script or inject code into it.
    site_name = _derive_site_name(site_prefix)
    replacements = {
        "__BUILD_TS__": build_ts,
        "__VERSION__": _html.escape(_engine_version(), quote=True),
        "__SITE_NAME__": _html.escape(site_name, quote=True),
        "__SITE_SHORT_NAME__": _html.escape(SITE_WORDMARK, quote=True),
        "__SITE_PREFIX_JSON__": _enc(site_prefix),
        "__SITE_PREFIX__": _html.escape(site_prefix, quote=True),
        "__TAGLINE_JSON__": _enc(tagline),
        "__TAGLINE__": _html.escape(tagline, quote=True),
        "__LANG__": _html.escape(lang, quote=True),
        "__TODO_CATEGORIES_JSON__": _enc(
            todo_categories if todo_categories is not None else DEFAULT_TODO_CATEGORIES),
        "__DATA__": _enc(tree),
        "__EMBED_CONTENT__": _enc(embed_content) if embed_content is not None else "null",
        "__EMBED_BACKLINKS__": _enc(embed_backlinks) if embed_backlinks is not None else "null",
        "__EMBED_NOTES__": _enc(embed_notes) if embed_notes is not None else "null",
        "__EMBED_TASKS__": _enc(embed_tasks) if embed_tasks is not None else "null",
        "__TEMPLATES__": _enc(doc_templates if doc_templates is not None else {}),
        # Extension code injected AS-IS (not JSON) into a <style> / <script> of
        # the viewer; the container's closing tag is neutralized so the content
        # cannot escape it, and `</head` too: the extensions' <style> lives
        # INSIDE the template's <head>, yet the offline build injects MiniSearch
        # by replacing the document's first `</head>` (inline_vendor_assets) — a
        # literal `</head>` in an extension would hijack that injection in the
        # middle of the CSS.
        "__EXTENSIONS_CSS__": _escape_closing_tag(
            _escape_closing_tag(extensions_css, _CLOSING_STYLE_RE),
            _CLOSING_HEAD_RE),
        "__EXTENSIONS_JS__": _escape_closing_tag(
            _escape_closing_tag(extensions_js, _CLOSING_SCRIPT_RE),
            _CLOSING_HEAD_RE),
    }
    # Substitution in ONE pass over the template: the injected values are never
    # re-scanned, so a mind document that literally contains "__SITE_NAME__",
    # "__BUILD_TS__" or "__TEMPLATES__" is never rewritten (a chain of
    # successive .replace would re-read the result of the previous ones).
    # Sorted by decreasing length: __TAGLINE_JSON__ wins over __TAGLINE__,
    # __SITE_PREFIX_JSON__ over __SITE_PREFIX__.
    pattern = re.compile("|".join(
        re.escape(placeholder)
        for placeholder in sorted(replacements, key=len, reverse=True)))
    return pattern.sub(lambda match: replacements[match.group(0)], template)


def render_manifest(*, site_prefix: str = DEFAULT_SITE_PREFIX,
                    tagline: str = DEFAULT_TAGLINE,
                    lang: str = DEFAULT_LANG) -> dict:
    """PWA manifest generated from the config (no more static manifest in
    web/): name = derived "<prefix> Atlas", short_name = the brand alone."""
    return {
        "name": _derive_site_name(site_prefix),
        "short_name": SITE_WORDMARK,
        "description": tagline,
        "lang": lang,
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "portrait-primary",
        "background_color": "#0f0e14",
        "theme_color": "#23222a",
        "icons": [
            {
                "src": "/icon.svg",
                "sizes": "any",
                "type": "image/svg+xml",
                "purpose": "any maskable",
            }
        ],
    }

