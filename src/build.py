#!/usr/bin/env python3
"""Generate the knowledge-base viewer from viewer.html template.

Two modes:

  python build.py              → online mode (default)
    - index.html       : lightweight shell (tree metadata only, ~120 KB stable)
    - _backlinks.json   : index path → [{path, name, term, snippet}, ...]
    Contents are loaded on demand from the server (server.py).
    Online search is served by /api/search (server.py), not by a client-side
    index: the viewer only sends the query and receives the results.

  python build.py --offline    → offline mode (self-contained monolith)
    - index-offline.html : everything embedded (contents + search data + backlinks).
    For file:// troubleshooting / travel. Not rebuilt by the auto push.

The viewer.html template defines the placeholders:
  __DATA__              : tree JSON (metadata)
  __EMBED_CONTENT__     : null (online) | {path: content} (offline)
  __EMBED_BACKLINKS__   : null (online) | backlinks index (offline)
  __BUILD_TS__          : ISO timestamp
  __SITE_NAME__         : full name derived as "<prefix> Atlas" (raw text of the
                          <title>; "Atlas" alone without a prefix)
  __SITE_PREFIX__       : the prefix alone, HTML-escaped (styled span before the
                          "Atlas" wordmark of the sidebar H1)
  __SITE_PREFIX_JSON__  : the same, JSON-encoded (viewer JS constant for the
                          home page — never raw text inside a template
                          literal)
  __SITE_SHORT_NAME__   : short variant (PWA icon / iOS home screen) — the
                          "Atlas" brand, always
  __TAGLINE__           : home-page baseline, HTML-escaped (HTML context)
  __TAGLINE_JSON__      : the same, JSON-encoded (viewer JS constant)
  __LANG__              : interface language (<html lang>), "fr" or "en"
  __TEMPLATES__         : new-document skeletons {label: md content},
                          discovered in templates/ (engine) merged with
                          <mind>/templates/ — see load_doc_templates.
  __EXTENSIONS_CSS__    : CSS of the mind's extensions (concatenation of
                          <mind>/.atlas/extensions/*.css, alphabetical order),
                          inlined in a <style> of the viewer — both online AND
                          offline modes. See load_extension_assets.
  __EXTENSIONS_JS__     : same for the *.js, inlined in a <script> at the end of
                          <body>. `</script` is escaped there to `<\\/script`
                          (same protection as the JSON placeholders) so that
                          an extension JS string can never close the tag.
                          `</head` is neutralized the same way in both the CSS
                          AND the JS of extensions: the offline build injects
                          MiniSearch by replacing the template's `</head>`,
                          which must stay the FIRST one in the document (see
                          inline_vendor_assets).

dist/manifest.json (PWA) is GENERATED from the config (name/short_name): there
is no longer a static manifest in web/. The server serves it from dist/.

Paths and exclusions: main() resolves them via AtlasConfig (src/config.py) —
ATLAS_MIND mind (or historical default), optional atlas.toml, env takes priority.
The module constants below remain the DEFAULTS (standalone script, and a
contract consumed by server.py: walk, EXCLUDED_NAMES, _WIKILINK_RE,
_resolve_wikilink).
"""
from __future__ import annotations

import argparse
import base64
import datetime as _dt
import html as _html
import json
import re
import subprocess
import sys
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent
REPO_ROOT = SRC_DIR.parent
CONTENT_ROOT = REPO_ROOT / "content"
# Engine assets (viewer + doc skeletons) ship INSIDE the package (src/) so a
# pip-installed wheel is self-contained; content/dist stay relative to the mind.
WEB_DIR = SRC_DIR / "web"
DIST_DIR = REPO_ROOT / "dist"
TEMPLATE = WEB_DIR / "viewer.html"
TEMPLATES_DIR = SRC_DIR / "templates"
OUT_ONLINE = DIST_DIR / "index.html"
OUT_OFFLINE = DIST_DIR / "index-offline.html"
BACKLINKS_DATA = DIST_DIR / "_backlinks.json"
NOTES_DIR = REPO_ROOT / ".notes"
NOTES_INDEX = DIST_DIR / "_notes-index.json"
# Default of the extensions hook (standalone script without config.py) — mirror
# of AtlasConfig.extensions_dir: FIXED location relative to the mind.
EXTENSIONS_DIR = REPO_ROOT / ".atlas" / "extensions"

# We only walk content/: by default the only thing to hide in there is quick.md
# (the to-do, edited via the widget). Add your own names via
# [build].excluded_names in atlas.toml. EXCLUDED_PREFIXES also keeps dotfiles
# (.notes/, etc.) out of the tree.
EXCLUDED_NAMES = {"quick.md"}
EXCLUDED_PREFIXES = (".",)

# Default identity (mirror of the defaults in src/config.py, so that the script
# stays runnable on its own without config.py alongside — see _load_config).
# "Atlas" is THE BRAND, fixed: only the optional prefix comes from the config.
SITE_WORDMARK = "Atlas Mind"
DEFAULT_SITE_PREFIX = ""
DEFAULT_TAGLINE = "Personal knowledge base."
DEFAULT_LANG = "en"
# Todo categories injected into the viewer (tabs + filter). Mirror of the
# defaults in src/config.py; replaced by the categories configured in
# atlas.toml ([todo].categories). Shape: [{"cat": <key>, "label": <header>}].
DEFAULT_TODO_CATEGORIES = [
    {"cat": "work", "label": "Work"},
    {"cat": "personal", "label": "Personal"},
]

# ─── Tree walk ────────────────────────────────────────────────────────────────


def _count_words(text: str) -> int:
    return len(text.split())


def _git_commit_dates(repo_root: Path | None = None) -> dict[str, int]:
    """Map posix relative path → unix ts of the last commit that touches the file.

    `repo_root` is the git repo root of the MIND (default: REPO_ROOT, the
    historical behavior of the in-place script).

    The activity heatmap must reflect when docs were actually written, not their
    disk mtime: git does not preserve mtime (clone/pull/checkout/reset reset it
    to the time of the operation), so on the Fly server all files inherit the
    date of the last deployment. We read the commit date instead.

    `git log` outputs in reverse-chronological order → the 1st occurrence of a
    path is its most recent commit. Returns {} if git is unavailable (fallback
    on st_mtime).

    NB: recomputed on every walk() call (via _accum), and most definitely NOT
    cached at the module level — the server is a long-lived process that calls
    walk() again on /api/tree after each pull; a cache would freeze the dates
    until restart.
    """
    if repo_root is None:
        repo_root = REPO_ROOT
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotePath=false", "log",
             "--format=__C__%ct", "--name-only", "--no-renames", "--", "content"],
            cwd=str(repo_root), capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if out.returncode != 0:
        return {}
    dates: dict[str, int] = {}
    ts = 0
    for line in out.stdout.splitlines():
        if line.startswith("__C__"):
            ts = int(line[5:])
        elif line and ts:
            # Repo-relative paths (content/projets/x.md); we strip the content/
            # prefix to match the doc identity (rel = relative_to content/).
            key = line[8:] if line.startswith("content/") else line
            if key not in dates:
                dates[key] = ts
    return dates


def walk(path: Path, *, content_root: Path | None = None,
         embed_content: bool = False, _accum: dict | None = None,
         excluded_names=None, excluded_prefixes=None) -> dict:
    """Recursively walk the knowledge-base content folder.

    `content_root` is the content root: doc paths (`rel`) are computed relative
    to it (default = `path`, the starting folder). Keeps doc identity stable
    (`projets/x.md`) regardless of the physical location.

    `excluded_names` / `excluded_prefixes`: tree exclusions, default = the module
    constants (read AT CALL TIME: server.py injects CONFIG.excluded_names there
    via _import_build).

    `_accum` collects flat list of .md files for downstream indexing (search,
    backlinks). When embed_content=True, each .md node also carries `content`
    inline — used by the offline build.
    """
    if content_root is None:
        content_root = path
    if excluded_names is None:
        excluded_names = EXCLUDED_NAMES
    if excluded_prefixes is None:
        excluded_prefixes = EXCLUDED_PREFIXES
    if _accum is None:
        _accum = {"md_files": []}
    # Computed once per top-level walk() (recursive calls find it already
    # present), never cached at the module level — see _git_commit_dates. The
    # git repo root of the mind = parent of content/ (identical to REPO_ROOT
    # when the script runs in place, also correct for a decoupled mind).
    if "git_dates" not in _accum:
        _accum["git_dates"] = _git_commit_dates(content_root.parent)
    node = {"name": path.name, "type": "dir", "children": []}
    entries = []
    for child in path.iterdir():
        if child.name in excluded_names:
            continue
        if any(child.name.startswith(p) for p in excluded_prefixes):
            continue
        entries.append(child)
    entries.sort(key=lambda p: (not p.is_dir(), p.name.lower()))
    for child in entries:
        if child.is_dir():
            sub = walk(child, content_root=content_root,
                       embed_content=embed_content, _accum=_accum,
                       excluded_names=excluded_names,
                       excluded_prefixes=excluded_prefixes)
            if sub["children"]:
                node["children"].append(sub)
            continue
        ext = child.suffix.lower()
        rel = child.relative_to(content_root).as_posix()
        file_node = {
            "name": child.name,
            "type": "file",
            "path": rel,
            "ext": ext,
            # Git commit date (true writing activity); st_mtime fallback for
            # unversioned files or files outside the git repo. See _git_commit_dates.
            "mtime": _accum["git_dates"].get(rel, int(child.stat().st_mtime)),
        }
        if ext == ".md":
            try:
                # utf-8-sig absorbs the BOM (Windows editors: Notepad,
                # PowerShell Out-File) which would otherwise break the
                # frontmatter match (_FM_RE anchored on ^---) and display the
                # tags block in plain text.
                text = child.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError) as e:
                # A single unreadable .md must not fail the WHOLE rebuild (the
                # webhook would stay stuck on the old version). We keep the node
                # in the tree but without metadata, just as load_all_notes
                # tolerates a faulty sidecar.
                print(f"[build] skip metadata for {rel}: {e}", file=sys.stderr)
                text = None
            if text is not None:
                tags_fm, body = _parse_frontmatter(text)
                # Tags = parent folders (always) ∪ frontmatter (custom). Folder
                # tags remain even if the doc has explicit tags.
                tags = _folder_tags(rel)
                for t in tags_fm:
                    if t not in tags:
                        tags.append(t)
                file_node["words"] = _count_words(body)
                if tags:
                    file_node["tags"] = tags
                _accum["md_files"].append(
                    {"path": rel, "name": child.name, "content": text, "body": body, "tags": tags})
                if embed_content:
                    file_node["content"] = text
        elif ext == ".html":
            # Self-contained HTML document (deck, dashboard): no frontmatter nor
            # wikilinks to parse. We count the words of the visible text (tags
            # stripped) for the reading time, and embed it as-is in the offline
            # build. body="" → ignored by the wikilink scan; still a possible
            # [[link]] target via by_path/by_stem.
            try:
                text = child.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError) as e:
                print(f"[build] skip metadata for {rel}: {e}", file=sys.stderr)
                text = None
            if text is not None:
                tags = _folder_tags(rel)
                file_node["words"] = _count_words(re.sub(r"<[^>]+>", " ", text))
                if tags:
                    file_node["tags"] = tags
                _accum["md_files"].append(
                    {"path": rel, "name": child.name, "content": text, "body": "", "tags": tags})
                if embed_content:
                    file_node["content"] = text
        node["children"].append(file_node)
    return node


# ─── Frontmatter (tags) + wikilinks graph ──────────────────────────────────────

_FM_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)


def _parse_frontmatter(text: str) -> tuple[list[str], str]:
    """Separate the leading YAML frontmatter (--- ... ---) from the body.

    Returns (tags, body). Without frontmatter: ([], text)."""
    m = _FM_RE.match(text)
    if not m:
        return [], text
    return _parse_tags(m.group(1)), text[m.end():]


def _parse_tags(block: str) -> list[str]:
    """Parse the `tags:` key of a frontmatter block. Supports `tags: [a, b]`,
    `tags: a, b` and the indented list (`- a`). Normalizes to lowercase, dedupes."""
    lines = block.splitlines()
    raw: list[str] = []
    for i, line in enumerate(lines):
        m = re.match(r"^tags[ \t]*:[ \t]*(.*)$", line, re.I)
        if not m:
            continue
        val = m.group(1).strip()
        if val.startswith("[") and val.endswith("]"):
            raw = val[1:-1].split(",")
        elif val:
            raw = val.split(",")
        else:  # indented list on the following lines
            for ln in lines[i + 1:]:
                lm = re.match(r"^[ \t]*-[ \t]+(.*)$", ln)
                if lm:
                    raw.append(lm.group(1))
                elif ln.strip():
                    break
        break
    seen: set[str] = set()
    out: list[str] = []
    for t in raw:
        t = t.strip().strip('"\'').lower()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _folder_tags(rel: str) -> list[str]:
    """Tags derived from parent folders (fallback when no explicit tag).

    `projets/alpha/doc.md` → ['projets', 'alpha']. Doc at the root → []."""
    parts = rel.split("/")[:-1]  # excludes the file name
    # Mirrors of remote nodes (remotes/<source>/…) don't pollute the tag space:
    # they already have their dedicated region in the Mind (#10).
    if parts and parts[0] == "remotes":
        return []
    return [p.strip().lower() for p in parts if p.strip()]


_WIKILINK_RE = re.compile(r"\[\[([^\[\]\n]+?)\]\]")


def _resolve_wikilink(target: str, by_path: dict, by_stem: dict):
    """Resolve a [[...]] target (optional alias `target|text`) to a path, or None."""
    t = target.split("|", 1)[0].strip().lower()
    if not t:
        return None
    for cand in (t, t + ".md"):
        if cand in by_path:
            return by_path[cand]
    stem = t.rsplit("/", 1)[-1]
    if stem.endswith(".md"):
        stem = stem[:-3]
    return by_stem.get(stem)


def build_links_index(md_files: list[dict]) -> dict:
    """Graph of [[wikilinks]]: {path: {"out": [...], "in": [...]}}.

    Replaces the old index based on matching file names within the content
    (noisy): only explicit references between docs count now."""
    by_path = {f["path"].lower(): f["path"] for f in md_files}
    by_stem: dict[str, str] = {}
    for f in md_files:
        stem = re.sub(r"\.md$", "", f["name"], flags=re.I).lower()
        by_stem.setdefault(stem, f["path"])  # first wins on name ambiguity
    out_map: dict[str, set] = {f["path"]: set() for f in md_files}
    for f in md_files:
        for m in _WIKILINK_RE.finditer(f["body"]):
            tgt = _resolve_wikilink(m.group(1), by_path, by_stem)
            if tgt and tgt != f["path"]:
                out_map[f["path"]].add(tgt)
    in_map: dict[str, set] = {f["path"]: set() for f in md_files}
    for src, outs in out_map.items():
        for dst in outs:
            in_map[dst].add(src)
    index = {}
    for f in md_files:
        p = f["path"]
        o, i = sorted(out_map[p]), sorted(in_map[p])
        if o or i:
            index[p] = {"out": o, "in": i}
    return index


# ─── Inline annotations (sidecars .notes/<rel>.json) ────────────────────────────


def load_all_notes(notes_dir: Path | None = None) -> dict:
    """Read all sidecars .notes/**/*.json → {doc_rel: [notes...]}.

    The durable data lives per file (small, committed). Here we only aggregate
    to produce the disposable index (counters) and the offline embed. Empty or
    unreadable sidecars are ignored. The key is the doc path (we strip the
    trailing `.json`)."""
    if notes_dir is None:
        notes_dir = NOTES_DIR
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


# ─── New-document skeletons (templates/*.md) ────────────────────────────────────


def load_doc_templates(*template_dirs) -> dict:
    """Discover the new-document skeletons: {label: md content},
    label = file name without extension (note.md → "note").

    The folders are merged IN ORDER: a skeleton with the same name from a later
    folder overrides the previous one — main() passes (engine, mind), so the
    mind freely adds or overrides the engine's skeletons. Missing folder or
    unreadable skeleton: ignored (the build must never fail because of a
    template), just as walk() tolerates an unreadable .md."""
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


# ─── Extensions (viewer assets: <mind>/.atlas/extensions/*.css|*.js) ──────────


def load_extension_assets(extensions_dir: Path | None = None) -> tuple:
    """Discover the mind's extension assets → (css, js).

    Concatenates the *.css then the *.js from <mind>/.atlas/extensions/ in
    alphabetical order (auto-discovery, each chunk prefixed with a comment
    holding the file name). Missing folder = ("", ""): a mind without
    extensions keeps a strictly identical viewer. Unreadable file: stderr
    warning and we continue — the build must never fail because of an
    extension, like load_doc_templates."""
    if extensions_dir is None:
        extensions_dir = EXTENSIONS_DIR
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


_CLOSING_SCRIPT_RE = re.compile(r"</(script)", re.I)
_CLOSING_STYLE_RE = re.compile(r"</(style)", re.I)
_CLOSING_HEAD_RE = re.compile(r"</(head)", re.I)


def _escape_closing_tag(text: str, closing_re: re.Pattern) -> str:
    """`</script` → `<\\/script` (same for `</style`): same protection as the
    JSON placeholders (`</` → `<\\/`), targeted at the closing tag.

    A `</script>` inside an extension JS string would close the viewer's inline
    <script> and inject raw HTML into the page. `<\\/` is equivalent to `</`
    inside a JS string and remains a valid escape in CSS — we touch nothing
    else (the extension code is injected as-is)."""
    return closing_re.sub(r"<\\/\1", text)


# ─── Inlining of vendored assets (offline build: file:// monolith) ─────────────

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

    # MiniSearch first, as a tag BEFORE any inlining: once the libs are
    # inlined, `</head>` may appear inside one of their code strings (real
    # case: DOMPurify embeds '<head></head><body>') and a late replace would
    # corrupt the script. Here the FIRST `</head>` is indeed the template's:
    # the JSON placeholders all have their `</` neutralized, and the extension
    # CSS/JS has its `</head` neutralized on top of `</style` / `</script`
    # (render_template) — without which a literal `</head>` in an extension
    # would receive the injection in the middle of its code.
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


# ─── Template rendering ───────────────────────────────────────────────────────


def _derive_site_name(site_prefix: str) -> str:
    """Full name derived from the prefix (mirror of AtlasConfig.site_name, so
    the script stays runnable on its own): "<prefix> Atlas", or "Atlas" alone."""
    if not site_prefix:
        return SITE_WORDMARK
    return f"{site_prefix} {SITE_WORDMARK}"


def render_template(*, tree: dict, embed_content: dict | None,
                    embed_backlinks: dict | None, embed_notes: dict | None,
                    build_ts: str, template_path: Path | None = None,
                    site_prefix: str = DEFAULT_SITE_PREFIX,
                    tagline: str = DEFAULT_TAGLINE,
                    lang: str = DEFAULT_LANG,
                    todo_categories: list | None = None,
                    doc_templates: dict | None = None,
                    extensions_css: str = "",
                    extensions_js: str = "") -> str:
    template = (template_path or TEMPLATE).read_text(encoding="utf-8")
    # JSON encode and protect </script> termination.
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


# ─── Main ─────────────────────────────────────────────────────────────────────


def _load_config():
    """AtlasConfig of the current mind (ATLAS_MIND, atlas.toml, env), or None if
    config.py is not shipped alongside (script copied alone somewhere) — we then
    fall back on the historical module constants."""
    if str(SRC_DIR) not in sys.path:
        sys.path.insert(0, str(SRC_DIR))
    try:
        from config import AtlasConfig, AtlasConfigError
    except ImportError:
        return None
    try:
        return AtlasConfig.load()
    except AtlasConfigError as e:
        # Explicit config error (malformed atlas.toml…): a readable fatal exit
        # rather than a traceback.
        sys.exit(f"FATAL: {e}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--offline", action="store_true",
                        help="Generate the monolithic index-offline.html (file://-ready).")
    args = parser.parse_args()

    cfg = _load_config()
    if cfg is None:
        content_root, dist_dir, notes_dir = CONTENT_ROOT, DIST_DIR, NOTES_DIR
        template_path, excluded_names = TEMPLATE, EXCLUDED_NAMES
        site_prefix, tagline, lang = DEFAULT_SITE_PREFIX, DEFAULT_TAGLINE, DEFAULT_LANG
        extensions_dir, web_dir = EXTENSIONS_DIR, WEB_DIR
        todo_cats = DEFAULT_TODO_CATEGORIES
    else:
        content_root, dist_dir, notes_dir = cfg.content_root, cfg.dist_dir, cfg.notes_dir
        template_path = cfg.web_dir / "viewer.html"
        excluded_names = cfg.excluded_names
        site_prefix, tagline, lang = cfg.prefix, cfg.tagline, cfg.lang
        extensions_dir, web_dir = cfg.extensions_dir, cfg.web_dir
        todo_cats = [{"cat": c, "label": cfg.todo_cat_headers.get(c, c.capitalize())}
                     for c in cfg.todo_categories]
    out_online = dist_dir / "index.html"
    out_offline = dist_dir / "index-offline.html"
    backlinks_data = dist_dir / "_backlinks.json"
    notes_index_path = dist_dir / "_notes-index.json"
    manifest_path = dist_dir / "manifest.json"
    # Skeletons: those of the engine (TEMPLATES_DIR, next to src/) then those of
    # the mind (<mind>/templates, sibling of content/) which add/override.
    # Mind co-located with the engine: both paths coincide, idempotent merge.
    doc_templates = load_doc_templates(TEMPLATES_DIR,
                                       content_root.parent / "templates")
    # Viewer-side extensions hook: the mind's CSS/JS inlined in both modes
    # (online and offline).
    extensions_css, extensions_js = load_extension_assets(extensions_dir)

    build_ts = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    dist_dir.mkdir(parents=True, exist_ok=True)

    # PWA manifest generated from the config — written in both modes (the
    # server serves dist/manifest.json, no longer the static web/ one).
    manifest_path.write_text(
        json.dumps(render_manifest(site_prefix=site_prefix, tagline=tagline,
                                   lang=lang),
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")

    if args.offline:
        accum = {"md_files": []}
        tree = walk(content_root, embed_content=True, _accum=accum,
                    excluded_names=excluded_names)
        embed_content = {f["path"]: f["content"] for f in accum["md_files"]}
        backlinks = build_links_index(accum["md_files"])
        html = render_template(
            tree=tree,
            embed_content=embed_content,
            embed_backlinks=backlinks,
            embed_notes=load_all_notes(notes_dir),
            build_ts=build_ts,
            template_path=template_path,
            site_prefix=site_prefix,
            tagline=tagline,
            lang=lang,
            todo_categories=todo_cats,
            doc_templates=doc_templates,
            extensions_css=extensions_css,
            extensions_js=extensions_js,
        )
        # Self-contained monolith: the /vendor/ assets (libs, CSS, fonts) are
        # inlined — index-offline.html works in file:// without network.
        html = inline_vendor_assets(html, web_dir)
        out_offline.write_text(html, encoding="utf-8")
        size = out_offline.stat().st_size
        print(f"Generated {out_offline.name} ({size:,} bytes, {len(accum['md_files'])} .md inline)")
        return 0

    # Online mode (default)
    accum = {"md_files": []}
    tree = walk(content_root, embed_content=False, _accum=accum,
                excluded_names=excluded_names)
    html = render_template(
        tree=tree,
        embed_content=None,
        embed_backlinks=None,
        embed_notes=None,
        build_ts=build_ts,
        template_path=template_path,
        site_prefix=site_prefix,
        tagline=tagline,
        lang=lang,
        todo_categories=todo_cats,
        doc_templates=doc_templates,
        extensions_css=extensions_css,
        extensions_js=extensions_js,
    )
    out_online.write_text(html, encoding="utf-8")

    # No more _search-data.json: online search is served by /api/search
    # (server.py) — O(results) transfer, not the whole corpus on the client side.
    backlinks = build_links_index(accum["md_files"])
    backlinks_data.write_text(json.dumps(backlinks, ensure_ascii=False), encoding="utf-8")

    # Aggregated annotations index (disposable, gitignored): {rel_doc: nb_notes}.
    # Used only for the tree's "📝 n" badges; the data lives in .notes/.
    notes_index = {rel: len(ns) for rel, ns in load_all_notes(notes_dir).items()}
    notes_index_path.write_text(json.dumps(notes_index, ensure_ascii=False), encoding="utf-8")

    html_size = out_online.stat().st_size
    backlinks_size = backlinks_data.stat().st_size
    print(
        f"Generated:\n"
        f"  {out_online.name:24} {html_size:>10,} bytes  (shell + tree metadata)\n"
        f"  {backlinks_data.name:24} {backlinks_size:>10,} bytes  ({len(backlinks)} entries)\n"
        f"  {notes_index_path.name:24} {notes_index_path.stat().st_size:>10,} bytes  ({len(notes_index)} annotated docs)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
