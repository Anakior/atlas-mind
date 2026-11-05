"""Document-domain logic: path validation, traversal, move-with-relink, the tree
ACL, git-history path resolution, the live task rollup, and search-text normalization.

The first three take their deps (content root, build module) explicitly (unit-testable
without a built config; server/__init__ wraps them with CONFIG-injecting shims). The
rest read config/git/build through the `server` facade (`_s`) and are re-exported as
`server._*`.
"""
import json
import os
import re
import sys
import unicodedata
from functools import lru_cache
from pathlib import PurePosixPath

import server as _s


def hidden_segment(rel: str) -> bool:
    """Whether `rel` goes up ('..') or through a hidden folder (.trash, .notes…: the
    engine's own), which a doc path never does. A '.' segment is only a spelling."""
    return any(part.startswith(".") and part != "." for part in rel.split("/"))


def validate_doc_path(rel: str, content_root):
    """Returns the resolved Path inside content_root, or None if invalid.

    Rejects '..', absolute paths, paths outside content_root, a hidden segment (.trash,
    .notes…: the engine's own, which a doc path must never reach), and any extension
    other than .md or .html (both are first-class documents)."""
    if not rel or rel.startswith("/") or hidden_segment(rel):
        return None
    # No HTML-injection or control characters in a document path: the viewer inlines doc
    # names/paths into markup, so a name like `<img src=x onerror=...>.md` would be a
    # stored-XSS sink. These are never legitimate in a document filename anyway — the
    # authoritative defence is output-escaping at each sink, this is defence-in-depth.
    if any(c in rel for c in '<>"') or any(ord(c) < 0x20 or ord(c) == 0x7f for c in rel):
        return None
    if not rel.endswith((".md", ".html")):
        return None
    try:
        target = (content_root / rel).resolve()
        target.relative_to(content_root)
        return target
    except (ValueError, OSError):
        return None


def renamed(path: str, old: str, new: str):
    """`path` once `old` (a doc, or a folder and everything in it) is renamed `new`, or None
    when the rename leaves it where it is."""
    if path == old:
        return new
    if path.startswith(old + "/"):
        return new + path[len(old):]
    return None


def content_file(rel: str, content_root):
    """The existing file of any type at `rel` inside content_root, or None. Same path bar
    as an uploaded file (no hidden segment, nothing escaping the root)."""
    from server.pure.uploads import clean_path
    rel = clean_path(rel)
    if rel is None:
        return None
    try:
        target = (content_root / rel).resolve()
        target.relative_to(content_root)
    except (ValueError, OSError):
        return None
    return target if target.is_file() else None


def move_file(src_rel: str, dst_rel: str, content_root):
    """Move a file that is not a doc (a PDF, an image): no [[link]] names it, so it just
    moves, keeping its kind. Same (status, payload) as move_md_with_relink."""
    from server.pure.uploads import clean_path
    if clean_path(src_rel) is None:
        return ("invalid", "Invalid path (inside the mind, no '..')")
    src = content_file(src_rel, content_root)
    if src is None:
        return ("not_found", f"Source not found: {src_rel}")
    dst_rel = clean_path(dst_rel)
    if dst_rel is None or PurePosixPath(dst_rel).suffix.lower() != src.suffix.lower():
        return ("invalid", "Invalid destination (inside the mind, same kind of file)")
    dst = content_root / dst_rel
    if dst.exists():
        return ("exists", f"Target already exists: {dst_rel} (no overwrite)")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src_canon = src.relative_to(content_root.resolve()).as_posix()
    os.replace(src, dst)
    return ("ok", {"from": src_canon, "to": dst_rel, "rewrites": [], "links_updated": 0})


def iter_doc_files(content_root, excluded, suffixes=(".md", ".html")):
    """Yields (relative_path, Path) for each doc tracked by the viewer (.md + .html), or
    each file with one of `suffixes`.

    `excluded` is the set of filenames to skip (build.EXCLUDED_NAMES)."""
    for path in [p for suffix in suffixes for p in content_root.rglob("*" + suffix)]:
        if any(p == ".git" or p.startswith(".") for p in path.relative_to(content_root).parts):
            continue
        if path.name in excluded:
            continue
        # Skip reserved folders: skill/tools/__pycache__ (consistent with build.py) and
        # inbox/ (the agents' on-ramp: sealed from search/topology/contradictions until an
        # item is promoted out of it). Activity still sees inbox via _history_path_included,
        # which deliberately does NOT skip it (the ROI digest needs it).
        parts = path.relative_to(content_root).parts
        if parts and parts[0] in ("skill", "tools", "__pycache__", "inbox"):
            continue
        yield path.relative_to(content_root).as_posix(), path


# A doc written this long before the backlinks index was may still be missing from it (the
# build read it before the write): it is read like a newer one.
_INDEX_LAG_S = 300


def _link_index(content_root, build, index=None, moved=None):
    """The docs ({path, name, body}) whose links may reach a doc `moved(rel)` says moves, and
    the path and name indexes every [[link]] resolves against (names only, nothing read).
    Taken BEFORE a move, while every link still resolves to its old place."""
    files = list(iter_doc_files(content_root, build.EXCLUDED_NAMES))
    by_path = {rel.lower(): rel for rel, _ in files}
    by_stem: dict = {}
    for rel, path in files:
        by_stem.setdefault(re.sub(r"\.md$", "", path.name, flags=re.I).lower(), rel)
    wanted = _linking(index, moved, files)
    md_files = []
    for rel, path in files:
        if wanted is not None and rel not in wanted:
            continue
        try:
            md_files.append({"path": rel, "name": path.name,
                             "body": path.read_text(encoding="utf-8-sig")})
        except (OSError, UnicodeDecodeError):
            continue
    return md_files, by_path, by_stem


def _linking(index, moved, files):
    """The docs that may link to a moving doc: those the backlinks index (`index`, the
    build's _backlinks.json) lists, plus every doc written since it was built. None (read
    them all) without an index, or when a moving doc is newer than it."""
    if index is None or moved is None:
        return None
    try:
        since = index.stat().st_mtime - _INDEX_LAG_S
        graph = json.loads(index.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    wanted = set()
    for rel, path in files:
        if moved(rel):
            if rel not in graph:
                return None
            wanted.update(graph[rel].get("in", []))
        elif rel not in graph:  # a path the index has not seen (a folder renamed since): keeps its old mtime
            wanted.add(rel)
            continue
        try:
            if path.stat().st_mtime >= since:
                wanted.add(rel)
        except OSError:
            continue
    return wanted


def _relink(md_files, by_path, by_stem, build, moves: dict, skip=frozenset(),
            may_relink=None) -> list:
    """The new body of each doc whose [[links]] reach a moved doc: [(path, body, count)].
    `moves` maps a doc's old path (lowercase) to its new one. A link by path takes the new
    path; a link by name only changes when the name does. `may_relink(linking, old, new)`,
    when given, says whether that doc may show the moved doc's new name."""
    def replacer(counter, linking):
        def _replace(m):
            whole, inner = m.group(0), m.group(1)
            resolved = build._resolve_wikilink(inner, by_path, by_stem)
            new = moves.get(resolved.lower()) if resolved else None
            if not new or (may_relink and not may_relink(linking, resolved, new)):
                return whole
            target_part, sep, alias = inner.partition("|")
            t = target_part.strip()
            had_md = t.lower().endswith(".md")
            if "/" in t:
                new_target = new if had_md else re.sub(r"\.md$", "", new, flags=re.I)
            else:
                stem = re.sub(r"\.md$", "", new.rsplit("/", 1)[-1], flags=re.I)
                new_target = stem + (".md" if had_md else "")
            new_whole = f"[[{new_target}{sep}{alias}]]"
            if new_whole == whole:
                return whole
            counter[0] += 1
            return new_whole
        return _replace

    pending = []
    for f in md_files:
        if f["path"] in skip:
            continue
        counter = [0]
        body = build._WIKILINK_RE.sub(replacer(counter, f["path"]), f["body"])
        if counter[0]:
            pending.append((f["path"], body, counter[0]))
    return pending


def move_dir_with_relink(src, dst, content_root, build, index=None, may_relink=None) -> list:
    """Rename the folder `src` to `dst` (absolute, both checked by the caller) and rewrite
    every [[link]] that reaches a doc inside it by its path; a link by name still resolves.
    Links are read before the rename, and each rewritten body is written where its doc
    now lives. Returns the rewrites [{path, count}] at their new paths; raises OSError when
    the rename fails (nothing touched)."""
    old = src.relative_to(content_root).as_posix()
    new = dst.relative_to(content_root).as_posix()

    def moved(rel):
        return rel.lower().startswith(old.lower() + "/")

    md_files, by_path, by_stem = _link_index(content_root, build, index, moved)

    moves = {low: new + rel[len(old):] for low, rel in by_path.items() if moved(rel)}
    pending = _relink(md_files, by_path, by_stem, build, moves, may_relink=may_relink)
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    rewrites = []
    for rel, body, count in pending:
        rel = new + rel[len(old):] if moved(rel) else rel
        try:
            (content_root / rel).write_text(body, encoding="utf-8")
            rewrites.append({"path": rel, "count": count})
        except OSError as e:
            print(f"[move folder] relink write failed {rel}: {e}", file=sys.stderr)
    return rewrites


def move_md_with_relink(src_rel: str, dst_rel: str, content_root, build, dry_run=False,
                        index=None, may_relink=None):
    """Move/rename a .md AND rewrite the incoming [[wikilinks]] that target it.

    The disk rename is the priority operation; relinking is best-effort on top.
    Links to fix are detected BEFORE the move (source still resolves to its old
    path), new bodies computed in memory, then the move, then the rewrites.
    dry_run stops after that computation: same payload, nothing touched on disk.

    Returns (status, payload):
      "ok"  → payload = {"from","to","rewrites":[{path,count}],"links_updated":N}
      else  → payload = error message (status ∈ invalid/not_found/exists/error)."""
    src = validate_doc_path(src_rel, content_root)
    dst = validate_doc_path(dst_rel, content_root)
    if not src or not dst:
        return ("invalid", "Invalid path (from and to must be relative .md or .html, no '..')")
    if not src.exists():
        return ("not_found", f"Source not found: {src_rel}")
    if dst.exists():
        return ("exists", f"Target already exists: {dst_rel} (no overwrite)")
    src_canon = src.relative_to(content_root).as_posix()
    dst_canon = dst.relative_to(content_root).as_posix()
    # Index wikilinks BEFORE the move (the source still resolves to its old path); the
    # moved doc's own outgoing links don't change.
    pending = _relink(*_link_index(content_root, build, index, lambda rel: rel == src_canon),
                      build, {src_canon.lower(): dst_canon}, skip={src_canon},
                      may_relink=may_relink)
    if dry_run:
        rewrites = [{"path": rel, "count": count} for rel, _, count in pending]
        return ("ok", {"from": src_canon, "to": dst_canon, "rewrites": rewrites,
                       "links_updated": sum(r["count"] for r in rewrites)})

    # The move first (the requested operation), then the relinks (best-effort).
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        src.rename(dst)
    except OSError as e:
        print(f"[move_doc] rename failed {src_canon} -> {dst_canon}: {e}",
              file=sys.stderr)
        return ("error", "Move failed")
    rewrites = []
    for rel, new_body, count in pending:
        try:
            (content_root / rel).write_text(new_body, encoding="utf-8")
            rewrites.append({"path": rel, "count": count})
        except OSError as e:
            print(f"[move_doc] relink write failed {rel}: {e}", file=sys.stderr)
    return ("ok", {"from": src_canon, "to": dst_canon, "rewrites": rewrites,
                   "links_updated": sum(r["count"] for r in rewrites)})


# ─── Tree ACL · git-history path resolution · live tasks · search text ──────────


def _filter_tree(node, keep):
    """Prune the tree to entries kept by ``keep(path) -> bool``, dropping folders
    that become empty, unless they are kept on purpose (a .gitkeep this reader may see).
    ``keep=None`` → returned unchanged (no filtering). The model-B ``can_read``
    whitelist feeds it (HTTP, MCP, Bearer)."""
    if keep is None:
        return node
    kids = []
    for child in node.get("children", []):
        if child.get("type") == "file":
            if keep(child.get("path", "")):
                kids.append(child)
        else:
            filtered = _filter_tree(child, keep)
            if filtered.get("children") or (child.get("keep") and keep(child["keep"])):
                kids.append(filtered)
    return {**node, "children": kids}


def _valid_git_rev(rev: str) -> bool:
    return bool(rev) and _s._GIT_REV_RE.match(rev) is not None


def _doc_path_history(repo_rel: str) -> dict:
    """Map {full_sha: repo-relative path the doc had at that commit}, following
    renames/moves. Lets the history endpoints resolve a doc that lived under
    another path before a move_doc."""
    out = _s.git("log", "--follow", "--format=%H", "--name-only", "--", repo_rel)
    mapping = {}
    sha = None
    for raw in out.stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        if re.fullmatch(r"[0-9a-f]{40}", line):
            sha = line
        elif sha and sha not in mapping:
            mapping[sha] = line  # followed file's path in that commit's tree
    return mapping


def _doc_path_at(repo_rel: str, rev: str) -> str:
    """Repo-relative path the doc had at `rev`: the current path if the blob exists
    there, else resolved across renames (falls back to the current path)."""
    if _s.git("cat-file", "-e", rev + ":" + repo_rel).returncode == 0:
        return repo_rel
    full = _s.git("rev-parse", rev).stdout.strip()
    return _doc_path_history(repo_rel).get(full, repo_rel)


def _live_tasks_index():
    """Task rollup from the CURRENT files (not the build-time dist snapshot), so a
    ticked box shows right away — like /api/search and /api/tree. Only .md carry
    GFM checkboxes."""
    build = _s._import_build()
    md_files = []
    for rel, path in iter_doc_files(_s.CONFIG.content_root, build.EXCLUDED_NAMES):
        if path.suffix.lower() != ".md":
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            continue
        _, body = build._parse_frontmatter(text)
        md_files.append({"path": rel, "name": path.name, "body": body})
    return build.build_tasks_index(md_files)


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


# Words, cells and titles recur millions of times over a contradiction scan: memoized. Lines and
# whole docs are not: a scan walks more of them than the cache holds, so they missed every time,
# evicted the words, and pinned ~70 MB on a 512 MB instance.
_fold_short = lru_cache(maxsize=131072)(_fold)
_SHORT = 64


def _normalize_text(s: str) -> str:
    """Accent-fold + lowercase."""
    return _fold_short(s) if len(s) <= _SHORT else _fold(s)


_HTML_BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.S | re.I)


def _html_to_text(html_src: str) -> str:
    """Extracts the visible text from an .html for indexing/search.

    Without this, search_docs would index CSS/JS/markup and return unreadable
    snippets. Strip <script>/<style>, then all tags, then roughly clean entities."""
    s = _HTML_BLOCK_RE.sub(" ", html_src)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"&(?:nbsp|amp|lt|gt|quot|#\d+|[a-z]+);", " ", s)
    return re.sub(r"\s+", " ", s).strip()
