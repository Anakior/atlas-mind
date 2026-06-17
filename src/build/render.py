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
        # The atlas_mind package __init__ (src/__init__.py) holds __version__.
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
    # Phase 1 — inline the split viewer sources (trusted CSS/HTML/JS fragments)
    # back into the shell BEFORE the placeholder pass, so their own placeholders
    # (__DATA__, __VERSION__, …) join the single substitution below. An
    # unextracted concern's dir is absent (concat_sources → "") → no-op.
    template = template.replace("__STYLES__", concat_sources(STYLES_DIR, (".css",)))
    template = template.replace("__BODY__", concat_sources(PARTIALS_DIR, (".html",)))
    template = template.replace("__APP_JS__", concat_sources(JS_DIR, (".js",)))
    # Phase 2 — JSON encode and protect </script> termination.
    def _enc(obj) -> str:
        return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")
    # Identity is HTML-escaped (injected into title/meta/H1). The JS side gets
    # prefix and tagline as JSON-encoded constants — no text placeholder lands in
    # a template literal, so a backtick or ${…} from atlas.toml can't break out.
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
        # Extension code injected AS-IS into a <style>/<script>; the container's
        # closing tag is neutralized so it can't escape, and `</head` too: the
        # offline build injects MiniSearch at the document's first `</head>`, so a
        # literal `</head>` in an extension would hijack that injection.
        "__EXTENSIONS_CSS__": _escape_closing_tag(
            _escape_closing_tag(extensions_css, _CLOSING_STYLE_RE),
            _CLOSING_HEAD_RE),
        "__EXTENSIONS_JS__": _escape_closing_tag(
            _escape_closing_tag(extensions_js, _CLOSING_SCRIPT_RE),
            _CLOSING_HEAD_RE),
    }
    # ONE pass over the template (injected values never re-scanned), so a mind
    # doc that literally contains "__SITE_NAME__" etc. is never rewritten. Sorted
    # by decreasing length so __TAGLINE_JSON__ wins over __TAGLINE__.
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

