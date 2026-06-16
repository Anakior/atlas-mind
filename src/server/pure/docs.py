"""Document-domain logic: path validation, traversal, move-with-relink, the tree
ACL, git-history path resolution, the live task rollup, and search-text
normalization.

The first three take their dependencies (content root, build module) explicitly
(unit-testable without a built config; server/__init__ wraps them with CONFIG-
injecting shims). The rest read config / git / build through the `server` facade
(`_s`), like the other pure modules, and are re-exported as `server._*`.
"""
import re
import sys

import server as _s


def validate_doc_path(rel: str, content_root):
    """Returns the resolved Path inside content_root, or None if invalid.

    Rejects '..', absolute paths, paths outside content_root, and any extension
    other than .md (prose) or .html (standalone styled document: deck, dashboard…).
    Both are first-class documents: created/read/edited/moved/shared.
    """
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    if not rel.endswith((".md", ".html")):
        return None
    try:
        target = (content_root / rel).resolve()
        target.relative_to(content_root)
        return target
    except (ValueError, OSError):
        return None


def iter_doc_files(content_root, excluded):
    """Yields (relative_path, Path) for each doc tracked by the viewer (.md + .html).

    `excluded` is the set of filenames to skip (build.EXCLUDED_NAMES)."""
    for path in [*content_root.rglob("*.md"), *content_root.rglob("*.html")]:
        if any(p == ".git" or p.startswith(".") for p in path.relative_to(content_root).parts):
            continue
        if path.name in excluded:
            continue
        # Skip skill/ (consistent with build.py)
        parts = path.relative_to(content_root).parts
        if parts and parts[0] in ("skill", "tools", "__pycache__"):
            continue
        yield path.relative_to(content_root).as_posix(), path


def move_md_with_relink(src_rel: str, dst_rel: str, content_root, build):
    """Move/rename a .md AND rewrite the incoming [[wikilinks]] that target it.

    The move (disk rename) is the priority operation; rewriting the links is
    best-effort on top of it. We detect the links to fix BEFORE the move (while
    the source still resolves to its old path), compute the new bodies in memory,
    perform the move, then apply the rewrites.

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
    dst_stem = re.sub(r"\.md$", "", dst.name, flags=re.I)

    # Index wikilinks BEFORE the move (the source still resolves to its old path).
    md_files = []
    for rel, path in iter_doc_files(content_root, build.EXCLUDED_NAMES):
        try:
            md_files.append({"path": rel, "name": path.name,
                             "body": path.read_text(encoding="utf-8-sig")})
        except (OSError, UnicodeDecodeError):
            continue
    by_path = {f["path"].lower(): f["path"] for f in md_files}
    by_stem: dict = {}
    for f in md_files:
        stem = re.sub(r"\.md$", "", f["name"], flags=re.I).lower()
        by_stem.setdefault(stem, f["path"])

    def _make_replacer(counter):
        def _replace(m):
            whole, inner = m.group(0), m.group(1)
            resolved = build._resolve_wikilink(inner, by_path, by_stem)
            if not resolved or resolved.lower() != src_canon.lower():
                return whole  # doesn't target the moved doc → unchanged
            target_part, sep, alias = inner.partition("|")
            t = target_part.strip()
            had_md = t.lower().endswith(".md")
            if "/" in t:  # reference by path → new path
                new_target = dst_canon if had_md else dst_canon[:-3]
            else:         # reference by short name (stem) → new stem
                new_target = dst_stem + (".md" if had_md else "")
            new_whole = f"[[{new_target}{sep}{alias}]]"
            if new_whole == whole:
                return whole  # e.g. pure move, stem unchanged → nothing to rewrite
            counter[0] += 1
            return new_whole
        return _replace

    # In-memory computation (nothing written until the move succeeds).
    pending = []
    for f in md_files:
        if f["path"] == src_canon:
            continue  # the moved doc: its OUTGOING links don't change
        counter = [0]
        new_body = build._WIKILINK_RE.sub(_make_replacer(counter), f["body"])
        if counter[0]:
            pending.append((f["path"], new_body, counter[0]))

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


def _path_hidden(rel, hidden):
    """True if the doc `rel` (relative to content/) falls under a hidden folder."""
    return any(rel == f or rel.startswith(f + "/") for f in hidden)


def _filter_tree(node, hidden):
    """Prunes the tree: removes hidden files (by path) and folders that became
    empty. Returns the node unchanged if there is no hidden folder."""
    if not hidden:
        return node
    kids = []
    for child in node.get("children", []):
        if child.get("type") == "file":
            if not _path_hidden(child.get("path", ""), hidden):
                kids.append(child)
        else:
            filtered = _filter_tree(child, hidden)
            if filtered.get("children"):
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
            mapping[sha] = line  # the followed file's path in that commit's tree
    return mapping


def _doc_path_at(repo_rel: str, rev: str) -> str:
    """Repo-relative path the doc had at `rev`: the current path if the blob exists
    there, else resolved across renames (falls back to the current path)."""
    if _s.git("cat-file", "-e", rev + ":" + repo_rel).returncode == 0:
        return repo_rel
    full = _s.git("rev-parse", rev).stdout.strip()
    return _doc_path_history(repo_rel).get(full, repo_rel)


def _live_tasks_index():
    """The task rollup computed from the CURRENT files (not the build-time dist
    snapshot), so a box ticked in a document is reflected right away — the same way
    /api/search and /api/tree are live. Only .md carry GFM checkboxes."""
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


def _normalize_text(s: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


_HTML_BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.S | re.I)


def _html_to_text(html_src: str) -> str:
    """Extracts the visible text from an .html for indexing/search.

    Without this, search_docs would index all the CSS/JS/markup and return
    unreadable snippets (`<div style=...>`). We first strip <script>/<style>
    entirely, then all tags, then roughly clean up the entities."""
    s = _HTML_BLOCK_RE.sub(" ", html_src)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"&(?:nbsp|amp|lt|gt|quot|#\d+|[a-z]+);", " ", s)
    return re.sub(r"\s+", " ", s).strip()
