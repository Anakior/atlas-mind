"""Asset discovery and inlining for the build pipeline.

Inline annotations (.notes sidecars), new-document skeletons (templates/), the
mind's viewer extensions (.atlas/extensions/*.css|*.js) and the offline vendor
inlining (the file:// monolith). The build facade re-exports load_extension_assets
and _escape_closing_tag / the _CLOSING_* patterns (server.py reaches them via
_import_build to neutralise extension closing tags the same way build does)."""
from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

from build.paths import WEB_DIR


def load_all_notes(notes_dir: Path) -> dict:
    """Read all sidecars .notes/**/*.json → {doc_rel: [notes...]}.

    Aggregates the per-file durable data into the disposable index (counters) and
    the offline embed. Empty/unreadable sidecars are ignored; the key is the doc
    path (trailing `.json` stripped)."""
    out: dict[str, list] = {}
    if not notes_dir.is_dir():
        return out
    for p in notes_dir.rglob("*.json"):
        rel_doc = p.relative_to(notes_dir).as_posix()
        if rel_doc.endswith(".json"):
            rel_doc = rel_doc[:-5]
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        notes = data.get("notes") if isinstance(data, dict) else data
        if isinstance(notes, list) and notes:
            out[rel_doc] = notes
    return out


def load_doc_templates(*template_dirs) -> dict:
    """Discover the new-document skeletons: {label: md content},
    label = file name without extension (note.md → "note").

    Folders merged IN ORDER (a later same-name skeleton overrides) — main()
    passes (engine, mind), so the mind adds/overrides the engine's skeletons.
    Missing folder or unreadable skeleton ignored: the build never fails on a
    template."""
    templates: dict[str, str] = {}
    for directory in template_dirs:
        if directory is None or not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            if not path.is_file():
                continue
            try:
                # utf-8-sig: same BOM tolerance as the reading of contents.
                templates[path.stem] = path.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError) as e:
                print(f"[build] skip template {path.name}: {e}", file=sys.stderr)
    return templates


def load_extension_assets(extensions_dir: Path) -> tuple:
    """Discover the mind's extension assets → (css, js).

    Concatenates the *.css then the *.js from <mind>/.atlas/extensions/ in
    alphabetical order, each chunk prefixed with a file-name comment. Missing
    folder → ("", ""); an unreadable file is skipped with a warning — the build
    never fails on an extension."""
    if not extensions_dir.is_dir():
        return "", ""
    css_parts: list[str] = []
    js_parts: list[str] = []
    for path in sorted(extensions_dir.iterdir(), key=lambda p: p.name):
        suffix = path.suffix.lower()
        if suffix not in (".css", ".js") or not path.is_file():
            continue
        try:
            # utf-8-sig: same BOM tolerance as the reading of contents.
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as e:
            print(f"[build] skip extension {path.name}: {e}", file=sys.stderr)
            continue
        if suffix == ".css":
            css_parts.append(f"/* extension: {path.name} */\n{text}")
        else:
            js_parts.append(f"// extension: {path.name}\n{text}")
    return "\n".join(css_parts), "\n".join(js_parts)


def concat_sources(directory: Path, suffixes: tuple) -> str:
    """Concatenate the files of `directory` whose suffix is in `suffixes`, sorted
    BY NAME (the NN- numeric prefix fixes the order), joined with '\\n'.

    Recollates the split viewer sources (styles/, partials/, js/) into the shell
    viewer.html at build time. Missing directory → "" (an unextracted concern is a
    no-op); an unreadable fragment is skipped with a warning. Closing-tag
    neutralisation is the caller's job."""
    if directory is None or not directory.is_dir():
        return ""
    parts: list[str] = []
    for path in sorted(directory.iterdir(), key=lambda p: p.name):
        if path.suffix.lower() not in suffixes or not path.is_file():
            continue
        try:
            parts.append(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError) as e:
            print(f"[build] skip source {path.name}: {e}", file=sys.stderr)
    return "\n".join(parts)


_CLOSING_SCRIPT_RE = re.compile(r"</(script)", re.I)
_CLOSING_STYLE_RE = re.compile(r"</(style)", re.I)
_CLOSING_HEAD_RE = re.compile(r"</(head)", re.I)


def _escape_closing_tag(text: str, closing_re: re.Pattern) -> str:
    """`</script` → `<\\/script` (same for `</style`): same protection as the
    JSON placeholders, targeted at the closing tag.

    A `</script>` inside an extension JS string would close the viewer's inline
    <script> and inject raw HTML. `<\\/` is equivalent inside a JS string and a
    valid escape in CSS — nothing else is touched."""
    return closing_re.sub(r"<\\/\1", text)


_VENDOR_SCRIPT_RE = re.compile(r'<script src="/vendor/([^"]+)"></script>')
_VENDOR_LINK_RE = re.compile(r'<link rel="stylesheet" href="/vendor/([^"]+)">')
_VENDOR_CSS_URL_RE = re.compile(r"url\((/vendor/[^)]+)\)")
# Icon <link> (favicon + apple-touch-icon): in file:// the absolute href
# /icon.svg would resolve to file:///icon.svg (not found) — rewritten as a data: URI.
_ICON_LINK_RE = re.compile(r'(<link\b[^>]*href=")/icon\.svg(")')


def inline_vendor_assets(html_text: str, web_dir: Path | None = None) -> str:
    """Inline the /vendor/ assets (JS libs, CSS, fonts) into the offline HTML.

    The index-offline.html monolith must work in file:// WITHOUT network or
    server: the template's <script src="/vendor/…"> and <link href="/vendor/…">
    would not resolve. So we replace each reference with its content (closing
    tags neutralized as for the extensions), the CSS's url(/vendor/fonts/…)
    becoming base64 data: URIs, and the icon <link>s (/icon.svg) SVG data: URIs
    (otherwise: ERR_FILE_NOT_FOUND in the file:// console). MiniSearch, lazily
    loaded by the viewer (offline search), is hard-injected before </head> —
    its loader short-circuits via `typeof MiniSearch`."""
    if web_dir is None:
        web_dir = WEB_DIR
    vendor_dir = web_dir / "vendor"

    def _inline_css(match: re.Match) -> str:
        css = (vendor_dir / match.group(1)).read_text(encoding="utf-8")

        def _data_uri(url_match: re.Match) -> str:
            asset = web_dir / url_match.group(1).lstrip("/")
            mime = "font/woff2" if asset.suffix == ".woff2" else "application/octet-stream"
            payload = base64.b64encode(asset.read_bytes()).decode("ascii")
            return f"url(data:{mime};base64,{payload})"

        css = _VENDOR_CSS_URL_RE.sub(_data_uri, css)
        css = _escape_closing_tag(css, _CLOSING_STYLE_RE)
        return f"<style>/* vendor: {match.group(1)} */\n{css}</style>"

    def _inline_js(rel: str) -> str:
        js = (vendor_dir / rel).read_text(encoding="utf-8")
        js = _escape_closing_tag(js, _CLOSING_SCRIPT_RE)
        return f"<script>/* vendor: {rel} */\n{js}</script>"

    # MiniSearch injected BEFORE any inlining: once libs are inlined, `</head>`
    # may appear inside one of their code strings (e.g. DOMPurify embeds
    # '<head></head><body>') and a late replace would corrupt the script. At this
    # point the FIRST `</head>` is the template's — every other source (JSON
    # placeholders, extension CSS/JS) has its `</head` neutralized upstream.
    minisearch_tag = '<script src="/vendor/minisearch.min.js"></script>'
    if (vendor_dir / "minisearch.min.js").is_file() and minisearch_tag not in html_text:
        html_text = html_text.replace("</head>", minisearch_tag + "\n</head>", 1)
    html_text = _VENDOR_SCRIPT_RE.sub(lambda m: _inline_js(m.group(1)), html_text)
    html_text = _VENDOR_LINK_RE.sub(_inline_css, html_text)
    icon_path = web_dir / "icon.svg"
    if icon_path.is_file():
        icon_b64 = base64.b64encode(icon_path.read_bytes()).decode("ascii")
        html_text = _ICON_LINK_RE.sub(
            lambda m: f"{m.group(1)}data:image/svg+xml;base64,{icon_b64}{m.group(2)}",
            html_text)
    return html_text

