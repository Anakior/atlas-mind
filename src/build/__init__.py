"""build — the viewer build pipeline (public facade).

`python -m build` is the entrypoint (see __main__); the logic lives in the
submodules: paths, parse, assets, render. Re-exports the public surface that
server.py reaches via _import_build and that the tests import, and owns the tree
walk + EXCLUDED_NAMES (server.py monkey-patches it at runtime; walk reads it at
call time, so the override takes effect)."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# Same self-bootstrap as src/server/__init__.py: the FLAT intra-package imports
# below ("from build.X import …") must resolve under BOTH "python -m build" and
# "python -m atlas_mind.build" (installed package, whose dir is NOT on sys.path).
# Put the package's parent on the path and alias this module as "build", so a
# "from build.X import" binds to THIS module instead of double-executing it.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("build", sys.modules[__name__])

from build.paths import (  # noqa: F401  (re-exported as build.*)
    SRC_DIR, WEB_DIR, TEMPLATE, TEMPLATES_DIR, STYLES_DIR, PARTIALS_DIR, JS_DIR,
    SITE_WORDMARK, DEFAULT_SITE_PREFIX, DEFAULT_TAGLINE, DEFAULT_LANG,
    DEFAULT_TODO_CATEGORIES,
)
from build.parse import (  # noqa: F401
    _parse_frontmatter, _inbox_meta, _rewrite_inbox_fm, _folder_tags, _resolve_wikilink, _doc_title,
    _WIKILINK_RE, build_links_index, build_tasks_index,
)
from build.assets import (  # noqa: F401
    load_all_notes, load_doc_templates, load_extension_assets,
    _escape_closing_tag, _CLOSING_SCRIPT_RE, _CLOSING_STYLE_RE, _CLOSING_HEAD_RE,
    inline_vendor_assets, concat_sources,
)
from build.render import render_template, render_manifest  # noqa: F401

# Tree exclusions. server.py overrides EXCLUDED_NAMES from CONFIG.excluded_names
# at runtime (_import_build); walk() reads it AT CALL TIME. EXCLUDED_PREFIXES
# keeps dotfiles (.notes/, etc.) out of the tree.
EXCLUDED_NAMES = {"quick.md"}
EXCLUDED_PREFIXES = (".",)


def _count_words(text: str) -> int:
    return len(text.split())


# The last read of the dates, for the (mind, HEAD) it was made at. See _git_commit_dates.
_DATES_AT_HEAD: dict = {}


def _git_commit_dates(repo_root: Path) -> dict[str, int]:
    """Map posix relative path → unix ts of the last commit that touches the file.

    `repo_root` is the git repo root of the MIND (the parent of content/).

    The activity heatmap must reflect when docs were actually written, not disk
    mtime: git does not preserve mtime (clone/pull/checkout reset it), so on Fly
    all files would inherit the last deployment date. We use the commit date.

    `git log` outputs reverse-chronological → the 1st occurrence of a path is its
    most recent commit. Returns {} if git is unavailable (st_mtime fallback).

    The full log is the slow part of a /api/tree (seconds on a mind with a long
    history), so the map is kept for the HEAD it was read at: a commit or a pull
    moves HEAD and the next call reads it again, so the dates never go stale.
    Callers only read the map.
    """
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo_root),
                              capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return {}
    if not head:
        return {}  # not a repo, or no commit yet
    key = (str(repo_root), head)
    if _DATES_AT_HEAD.get("key") == key:
        return _DATES_AT_HEAD["dates"]
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
            # Strip the content/ prefix to match the doc identity (rel).
            rel = line[8:] if line.startswith("content/") else line
            if rel not in dates:
                dates[rel] = ts
    _DATES_AT_HEAD.update(key=key, dates=dates)
    return dates


def walk(path: Path, *, content_root: Path | None = None,
         embed_content: bool = False, _accum: dict | None = None,
         excluded_names=None, excluded_prefixes=None, keep=None) -> dict:
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

    `keep`: optional predicate ``keep(rel) -> bool`` over content-relative doc
    paths. When set, a file is included ONLY if it passes; the offline build
    passes its ACL filter here, so an excluded doc lands in NO embed (tree,
    content, search, backlinks, tasks, notes) and its empty folders are pruned.
    Default None = no filtering (online build — the server filters /api/tree).
    """
    if content_root is None:
        content_root = path
    if excluded_names is None:
        excluded_names = EXCLUDED_NAMES
    if excluded_prefixes is None:
        excluded_prefixes = EXCLUDED_PREFIXES
    if _accum is None:
        _accum = {"md_files": []}
    # Read once per top-level walk() (recursive calls reuse it), again only once
    # HEAD moves — see _git_commit_dates. The mind's git root = parent of content/.
    if "git_dates" not in _accum:
        _accum["git_dates"] = _git_commit_dates(content_root.parent)
    node = {"name": path.name, "type": "dir", "children": []}
    entries = []
    for child in path.iterdir():
        # Symlinks are skipped before any recursion/read: a symlinked dir can form
        # a cycle (infinite walk → crash) and a symlinked file can pull an
        # out-of-repo target into the static index.
        if child.is_symlink():
            continue
        if child.name in excluded_names:
            continue
        if any(child.name.startswith(p) for p in excluded_prefixes):
            continue
        # Seal the inbox from the build tree (search, backlinks, embed), like iter_doc_files at runtime,
        # so an inbox write never changes the static site (the dev md5 live-reload won't fire on it).
        # The build's activity snapshot is sealed separately; the runtime activity feed keeps inbox.
        if path == content_root and child.is_dir() and child.name == "inbox":
            continue
        entries.append(child)
    for child in entries:
        if child.is_dir():
            sub = walk(child, content_root=content_root,
                       embed_content=embed_content, _accum=_accum,
                       excluded_names=excluded_names,
                       excluded_prefixes=excluded_prefixes, keep=keep)
            # A folder made on purpose (its .gitkeep) stays even empty, carrying the keep's
            # path: its ACL says who sees the folder when nothing in it is theirs to see.
            keep_rel = (child / ".gitkeep").relative_to(content_root).as_posix()
            if (child / ".gitkeep").is_file() and (keep is None or keep(keep_rel)):
                sub["keep"] = keep_rel
            if sub["children"] or "keep" in sub:
                node["children"].append(sub)
            continue
        ext = child.suffix.lower()
        rel = child.relative_to(content_root).as_posix()
        if keep is not None and not keep(rel):
            # ACL (offline build): this doc is outside the export's visible
            # set (a private doc, or invisible to --as <email>). Skip it BEFORE
            # reading its content, so its name/path/text leak into no embed.
            continue
        file_node = {
            "name": child.name,
            "type": "file",
            "path": rel,
            "ext": ext,
            # Git commit date (true writing activity); st_mtime fallback for
            # unversioned files. See _git_commit_dates.
            "mtime": _accum["git_dates"].get(rel, int(child.stat().st_mtime)),
        }
        # Folder-derived tags apply to EVERY file (md, html, pdf, docx, …) so
        # that non-Markdown documents also surface as nodes — clustered by zone
        # and tag — in The Mind graph, not just Markdown.
        tags = _folder_tags(rel)
        if ext == ".md":
            try:
                # utf-8-sig absorbs the BOM (Windows editors) which would
                # otherwise break the frontmatter match (_FM_RE anchored on ^---).
                text = child.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError) as e:
                # A single unreadable .md must not fail the WHOLE rebuild (the
                # webhook would stay stuck on the old version): keep the node
                # without metadata.
                print(f"[build] skip metadata for {rel}: {e}", file=sys.stderr)
                text = None
            if text is not None:
                if title := _doc_title(text, ext):
                    file_node["title"] = title
                tags_fm, body = _parse_frontmatter(text)
                # Tags = parent folders (always) ∪ frontmatter (custom).
                for t in tags_fm:
                    if t not in tags:
                        tags.append(t)
                file_node["words"] = _count_words(body)
                _accum["md_files"].append(
                    {"path": rel, "name": child.name, "content": text, "body": body, "tags": tags})
                if embed_content:
                    file_node["content"] = text
        elif ext == ".html":
            # Self-contained HTML doc (deck, dashboard): no frontmatter/wikilinks.
            # Count the visible text (tags stripped) for the reading time and
            # embed it as-is offline. body="" → skipped by the wikilink scan, but
            # still a possible [[link]] target via by_path/by_stem.
            try:
                text = child.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError) as e:
                print(f"[build] skip metadata for {rel}: {e}", file=sys.stderr)
                text = None
            if text is not None:
                if title := _doc_title(text, ext):
                    file_node["title"] = title
                file_node["words"] = _count_words(re.sub(r"<[^>]+>", " ", text))
                _accum["md_files"].append(
                    {"path": rel, "name": child.name, "content": text, "body": "", "tags": tags})
                if embed_content:
                    file_node["content"] = text
        # PDFs, Word docs and other previewable files carry no indexable text,
        # but still get their folder tags (attached below) so they are nodes too.
        if tags:
            file_node["tags"] = tags
        node["children"].append(file_node)
    # Folders first, then the files in the order their names are shown: their titles.
    node["children"].sort(key=lambda n: (n["type"] == "file", (n.get("title") or n["name"]).lower()))
    return node

