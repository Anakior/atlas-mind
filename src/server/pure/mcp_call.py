"""MCP tool dispatch + graph/tag/trash/search helpers backing the AI-native tools."""
import datetime
import json
import posixpath
import re
import sys
import time
from pathlib import Path

import server as _s

# The well-known empty-tree object: lets doc_diff express "this doc's first
# appearance" as a normal two-tree diff (empty -> rev) instead of a special case.
_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
# Output caps: a real .html deck in a mind can be ~2 MB; an uncapped diff/content/
# blame would blow the model's context. The HTTP endpoints have no cap (a browser
# doesn't care) — the MCP tools must.
_MAX_OUTPUT_CHARS = 60000
_MAX_BLAME_LINES = 600
_BLAME_HEAD_RE = re.compile(r"^[0-9a-f]{40} \d+ \d+")


def _visible(rel, ctx):
    """Whether `ctx` may read `rel`. ctx=None → unfiltered (internal/local use,
    e.g. direct calls in tests)."""
    return ctx is None or _s.can_read(rel, ctx)


def _doc_corpus(ctx=None):
    """[(rel, name, text)] for every doc readable by `ctx`, each file read once.
    THE choke-point: search/topology/tags/links all iterate here, so filtering
    once propagates to every derived aggregate. utf-8-sig tolerates a BOM."""
    out = []
    for rel, path in _s._iter_doc_files():
        if not _visible(rel, ctx):
            continue
        try:
            out.append((rel, path.name, path.read_text(encoding="utf-8-sig")))
        except (OSError, UnicodeDecodeError):
            continue
    return out


def _links_graph(ctx=None):
    """Wikilink graph {path: {"out": [...], "in": [...]}} over the docs readable by
    `ctx`. Built on the filtered corpus so the graph never exposes a private doc as
    a node; callers still scrub `out` edges that point at a private target."""
    return _s._import_build().build_links_index(
        [{"path": rel, "name": name, "body": text} for rel, name, text in _doc_corpus(ctx)])


def _scrub_commits(commits, ctx):
    """Drop, from each commit, the changed files `ctx` can't read; drop commits
    left with no visible file. Keeps history tools from leaking private doc paths."""
    if ctx is None:
        return commits
    out = []
    for c in commits:
        files = [f for f in c.get("files", []) if _visible(f.get("path", ""), ctx)]
        if files:
            out.append({**c, "files": files})
    return out


def _tags_for(build, rel: str, text: str) -> list:
    """Folder-derived tags + frontmatter tags, merged and deduped — mirrors the
    tag computation of build.walk so the MCP tools never diverge from the viewer."""
    tags = list(build._folder_tags(rel))
    fm_tags, _ = build._parse_frontmatter(text)
    for t in fm_tags:
        if t not in tags:
            tags.append(t)
    return tags


def _soft_delete(target: Path) -> str:
    """Move a doc into content_root/.trash/ (reversible) instead of erasing it.

    delete_doc is called by an AI with no confirmation box, so a wrong call must
    stay recoverable. '.trash' is dot-prefixed → auto-hidden from tree/search/links
    (build and _iter_doc_files both skip dot-prefixed parts). Returns the
    trash-relative path."""
    content_root = _s.CONFIG.content_root
    rel = target.relative_to(content_root)
    dest = content_root / ".trash" / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Don't clobber an earlier trashed copy: suffix -2, -3, …
    n = 2
    while dest.exists():
        dest = dest.with_name(f"{rel.stem}-{n}{rel.suffix}")
        n += 1
    target.replace(dest)
    return ".trash/" + rel.as_posix()


def _api_search(q: str, limit: int, ctx=None) -> list:
    """Scoring: weighted occurrences (name x3, content x1), with typo tolerance
    (a token that can't be found is corrected to the closest word in the
    vocabulary). Content read via the _doc_entry in-memory cache."""
    import difflib
    tokens = [t for t in _s._normalize_text(q).split() if t]
    if not tokens:
        return []
    entries = []
    for rel, path in _s._iter_doc_files():
        if not _visible(rel, ctx):
            continue
        e = _s._doc_entry(rel, path)
        if e is not None:
            entries.append((rel, path, e))
    # Typo tolerance: a 4+-letter token absent from the vocabulary (as a substring)
    # is replaced by the closest known word — restores MiniSearch's client-side fuzz.
    vocab = set()
    for _, _, e in entries:
        vocab |= e["tokens"]
    corrected = []
    for t in tokens:
        if len(t) < 4 or any(t in w for w in vocab):
            corrected.append(t)
        else:
            near = difflib.get_close_matches(t, vocab, n=1, cutoff=0.78)
            corrected.append(near[0] if near else t)
    tokens = corrected
    hits = []
    for rel, path, e in entries:
        name_n = e["name_n"]
        content_n = e["content_n"]
        content = e["content"]
        score = 0
        first_idx = -1
        first_token = None
        for t in tokens:
            n_name = name_n.count(t)
            n_content = content_n.count(t)
            score += n_name * 3 + n_content
            if n_content:
                idx = content_n.find(t)
                if first_idx == -1 or (idx >= 0 and idx < first_idx):
                    first_idx = idx
                    first_token = t
        if score == 0:
            continue
        if first_idx >= 0 and first_token:
            start = max(0, first_idx - 60)
            end = min(len(content), first_idx + len(first_token) + 120)
            snippet = (("…" if start > 0 else "")
                       + content[start:end].replace("\n", " ").strip()
                       + ("…" if end < len(content) else ""))
        else:
            snippet = content[:160].replace("\n", " ").strip() + ("…" if len(content) > 160 else "")
        hits.append({
            "path": rel,
            "name": path.name,
            "score": score,
            "snippet": snippet,
            "mtime": int(e["mtime"]),
        })
    hits.sort(key=lambda h: (-h["score"], -h["mtime"]))
    return hits[:limit]


def _api_recent(days: int, limit: int, ctx=None) -> list:
    """Documents modified within the window, from most recent to oldest."""
    cutoff = time.time() - days * 86400
    items = []
    for rel, path in _s._iter_doc_files():
        if not _visible(rel, ctx):
            continue
        st = path.stat()
        if st.st_mtime < cutoff:
            continue
        try:
            content = path.read_text(encoding="utf-8")
            preview = content[:160].replace("\n", " ").strip()
            if len(content) > 160:
                preview += "…"
        except (OSError, UnicodeDecodeError):
            preview = ""
        items.append({
            "path": rel,
            "name": path.name,
            "score": 0,
            "snippet": preview,
            "mtime": int(st.st_mtime),
        })
    items.sort(key=lambda h: -h["mtime"])
    return items[:limit]


# ─── Git time-travel helpers (back the doc_history/at/diff/blame/changelog/revert
#     and search_history MCP tools) ────────────────────────────────────────────
# Every git call goes through _s.git (subprocess arg-list, NO shell). Doc paths are
# content/-relative on the MCP side; git runs at the repo root, so the pathspec is
# prefixed with "content/". Revs the AGENT supplies are gated by _s._valid_git_rev
# (SHA or HEAD~N only) — dates and relative bases are resolved to a SHA server-side
# (the validator rejects them by design), and filter flags (--since/--grep/--author)
# are passed as fused argv tokens, never through the rev validator.


def _capped(text):
    """Truncate a payload to protect the model context; returns (text, truncated)."""
    if not text:
        return text or "", False
    if len(text) <= _MAX_OUTPUT_CHARS:
        return text, False
    return text[:_MAX_OUTPUT_CHARS], True


def _fmt_commit(record: str) -> dict:
    """Parse a '%H\\x1f%an\\x1f%aI\\x1f%s' record into a revision dict."""
    f = (record.split("\x1f") + ["", "", "", ""])[:4]
    return {"sha": f[0], "short_sha": f[0][:7], "author": f[1], "date": f[2], "subject": f[3]}


def _git_doc_records(repo_rel: str, *opts):
    """git log --follow over one doc, returning the raw '\\x1f'-field records
    (newest-first) or None on failure. --follow keeps pre-rename commits."""
    r = _s.git("log", "--follow", *opts, "--format=%H\x1f%an\x1f%aI\x1f%s", "-z", "--", repo_rel)
    if r.returncode != 0:
        return None
    return [x for x in r.stdout.split("\x00") if x]


def _safe_path_prefix(prefix: str):
    """Validate a directory/file prefix for the history-search tools (which can't
    reuse _validate_doc_path — it requires a .md/.html suffix). Returns the cleaned
    prefix ('' = whole tree) or None if it tries to escape content/."""
    prefix = (prefix or "").strip()
    if not prefix:
        return ""
    if prefix.startswith("/") or ".." in prefix.split("/"):
        return None
    return prefix.strip("/")


def _history_path_included(content_rel: str, excluded) -> bool:
    """Apply the iter_doc_files visibility rules to a HISTORICAL path (a string from
    git, not a current file): skip dot-folders/.trash, skip skill/tools/__pycache__,
    skip excluded basenames, keep only .md/.html. iter_doc_files itself can't be used
    here — its set is current-files-only, so deleted/trashed docs in history are absent."""
    parts = content_rel.split("/")
    if any(p == ".git" or p.startswith(".") for p in parts):
        return False
    if parts and parts[0] in ("skill", "tools", "__pycache__"):
        return False
    if parts[-1] in excluded:
        return False
    return content_rel.endswith((".md", ".html"))


def _strip_content(p: str):
    """Strip the 'content/' repo prefix from a git path, or None if not under it."""
    return p[len("content/"):] if p.startswith("content/") else None


def _parse_namestatus_log(stdout: str, excluded) -> list:
    """Parse `git log --format=%x1e… --name-status -z` into commit dicts with their
    changed DOC files. The leading \\x1e (record separator) delimits commits so the
    flat -z stream is unambiguous; R/C statuses carry two paths (old + new). Commits
    whose changed files are all excluded/non-doc are dropped."""
    out = []
    for rec in stdout.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        head, _, rest = rec.partition("\x00")
        sha, an, aI, subj = (head.split("\x1f") + ["", "", "", ""])[:4]
        if not sha:
            continue
        # git inserts a '\n' between the format's \x00 terminator and the name-status
        # block, so the first status token arrives as '\nM' / '\nR100' — strip it.
        tokens = [t for t in (x.lstrip("\n") for x in rest.split("\x00")) if t]
        files = []
        i = 0
        while i < len(tokens):
            status = tokens[i]
            if status[:1] in ("R", "C") and i + 2 < len(tokens):
                new_rel = _strip_content(tokens[i + 2])
                if new_rel is not None and _history_path_included(new_rel, excluded):
                    files.append({"status": status[:1], "path": new_rel,
                                  "old_path": _strip_content(tokens[i + 1])})
                i += 3
            else:
                path = tokens[i + 1] if i + 1 < len(tokens) else ""
                rel = _strip_content(path)
                if rel is not None and _history_path_included(rel, excluded):
                    files.append({"status": status[:1] or "?", "path": rel})
                i += 2
        if files:
            out.append({"sha": sha, "short_sha": sha[:7], "author": an,
                        "date": aI, "subject": subj, "files": files})
    return out


def _numstat_first(stdout: str):
    """(added, removed) from the first `git diff --numstat` line; '-' (binary) -> 0."""
    for line in stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            added = 0 if parts[0] == "-" else int(parts[0] or 0)
            removed = 0 if parts[1] == "-" else int(parts[1] or 0)
            return added, removed
    return 0, 0


def _doc_diff_between(repo_rel: str, base_sha: str, rev_sha: str):
    """Unified diff + (added, removed) for a doc between two resolved SHAs. Mirrors
    /api/diff: same-path -> pathspec diff; renamed-between-revs -> blob:blob diff;
    base == empty tree -> the doc's introduction. Returns (diff_text|None, +, -)."""
    to_path = _s._doc_path_at(repo_rel, rev_sha)
    if base_sha == _EMPTY_TREE:
        diff = _s.git("diff", base_sha, rev_sha, "--", to_path)
        num = _s.git("diff", "--numstat", base_sha, rev_sha, "--", to_path)
    else:
        from_path = _s._doc_path_at(repo_rel, base_sha)
        if from_path == to_path:
            diff = _s.git("diff", base_sha, rev_sha, "--", from_path)
            num = _s.git("diff", "--numstat", base_sha, rev_sha, "--", from_path)
        else:
            a, b = base_sha + ":" + from_path, rev_sha + ":" + to_path
            diff = _s.git("diff", a, b)
            num = _s.git("diff", "--numstat", a, b)
    if diff.returncode != 0:
        return None, 0, 0
    added, removed = _numstat_first(num.stdout)
    return diff.stdout, added, removed


def _parse_blame(stdout: str) -> list:
    """Parse `git blame --line-porcelain` into per-line attribution. --line-porcelain
    repeats every header for every line, so each line carries author/time/summary."""
    lines = []
    cur = {}
    for raw in stdout.split("\n"):
        if _BLAME_HEAD_RE.match(raw):
            p = raw.split(" ")
            cur = {"sha": p[0], "short_sha": p[0][:7], "line_no": int(p[2])}
        elif raw.startswith("author "):
            cur["author"] = raw[len("author "):]
        elif raw.startswith("author-time "):
            cur["_epoch"] = raw[len("author-time "):]
        elif raw.startswith("summary "):
            cur["subject"] = raw[len("summary "):]
        elif raw.startswith("\t"):
            try:
                date = datetime.datetime.fromtimestamp(
                    int(cur.get("_epoch", "")), datetime.timezone.utc).isoformat()
            except (ValueError, TypeError):
                date = ""
            lines.append({"line_no": cur.get("line_no"), "text": raw[1:],
                          "sha": cur.get("sha"), "short_sha": cur.get("short_sha"),
                          "author": cur.get("author", ""), "date": date,
                          "subject": cur.get("subject", "")})
            cur = {}
    return lines


def text_result(s: str, is_error: bool = False) -> dict:
    """Wrap a string as an MCP CallToolResult (with isError set when it's an error)."""
    out = {"content": [{"type": "text", "text": s}]}
    if is_error:
        out["isError"] = True
    return out


def _tool_search_docs(args, ctx):
    q = (args.get("q") or "").strip()
    if not q:
        return text_result("Error: missing 'q' parameter", is_error=True)
    try:
        limit = min(50, max(1, int(args.get("limit", 10))))
    except (ValueError, TypeError):
        limit = 10
    tag = (args.get("tag") or "").strip().lower()
    # Tag filter is additive: over-fetch then keep only hits that carry the tag.
    hits = _api_search(q, 50 if tag else limit, ctx)
    if tag:
        build = _s._import_build()
        kept = []
        for h in hits:
            fp = _s.CONFIG.content_root / h.get("path", "")
            try:
                if tag in _tags_for(build, h.get("path", ""), fp.read_text(encoding="utf-8-sig")):
                    kept.append(h)
            except (OSError, UnicodeDecodeError):
                continue
            if len(kept) >= limit:
                break
        hits = kept
    if not hits:
        return text_result(f"No results for: {q}" + (f" (tag: {tag})" if tag else ""))
    return text_result(json.dumps(hits, ensure_ascii=False, indent=2))


def _tool_read_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target or not target.exists() or not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    text = target.read_text(encoding="utf-8")
    return text_result(text)


def _tool_list_tree(args, ctx):
    try:
        tree = _s._import_build().walk(_s.CONFIG.content_root)
        if ctx is not None:
            tree = _s._filter_tree(tree, lambda p: _s.can_read(p, ctx))
        return text_result(json.dumps(tree, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"[mcp] list_tree failed: {e}", file=sys.stderr)
        return text_result("Error listing the tree", is_error=True)


def _tool_recent_docs(args, ctx):
    try:
        days = max(1, int(args.get("days", 7)))
        limit = min(100, max(1, int(args.get("limit", 20))))
    except (ValueError, TypeError):
        days, limit = 7, 20
    hits = _api_recent(days, limit, ctx)
    if not hits:
        return text_result(f"No document modified in the last {days} days")
    return text_result(json.dumps(hits, ensure_ascii=False, indent=2))


def _tool_create_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    content = args.get("content", "")
    target = _s._validate_doc_path(rel)
    if not target:
        return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
    rel = posixpath.normpath(rel)  # canonical ACL key (matches effective_level)
    if _s._is_readonly_path(rel):
        return text_result("Read-only location (remote node mirror) — choose another path.", is_error=True)
    if ctx is not None and not _s.can_create(rel, ctx):
        return text_result("Insufficient permission to create at this location.", is_error=True)
    if target.exists():
        return text_result(f"Document already exists: {rel} (cannot overwrite with this token)", is_error=True)
    if not isinstance(content, str):
        return text_result("'content' must be a string", is_error=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    # On create: stamp the creator + default visibility (a human member's doc is
    # private; an admin's or an API token's stays in the commons).
    if ctx is not None and ctx.primary:
        try:
            _s._stamp_new_doc(rel, ctx)
        except Exception as e:
            print(f"[create_doc owner] {e}", file=sys.stderr)
    _s.commit_change(ctx, f"docs: create {rel}", target, ai=args.get("ai"))
    return text_result(f"Document created: {rel}")


def _tool_edit_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target:
        return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
    if _s._is_readonly_path(rel):
        return text_result("Read-only document (remote node mirror). Use \"Appropriate\" to make an editable copy.", is_error=True)
    if not target.exists() or not _visible(rel, ctx):
        return text_result(f"Document not found: {rel} (use create_doc to create a new one)", is_error=True)
    if ctx is not None and not _s.can_write(rel, ctx, "edit"):
        return text_result("Insufficient permission (need edit on this document).", is_error=True)
    old_string = args.get("old_string")
    new_string = args.get("new_string")
    content = args.get("content")
    # Patch mode: targeted replacement, takes priority over full rewrite.
    if old_string is not None:
        if not isinstance(old_string, str) or not isinstance(new_string, str):
            return text_result("'old_string' and 'new_string' must be strings", is_error=True)
        if old_string == "":
            return text_result("'old_string' cannot be empty", is_error=True)
        current = target.read_text(encoding="utf-8")
        count = current.count(old_string)
        if count == 0:
            return text_result("'old_string' not found in the document (check it with read_doc)", is_error=True)
        if count > 1:
            return text_result(f"'old_string' appears {count} times — it must be unique. Add surrounding context to make it unique.", is_error=True)
        target.write_text(current.replace(old_string, new_string, 1), encoding="utf-8")
        _s.commit_change(ctx, f"docs: edit {rel}", target, ai=args.get("ai"))
        return text_result(f"Document edited (targeted replacement): {rel}")
    if content is not None:
        if not isinstance(content, str):
            return text_result("'content' must be a string", is_error=True)
        target.write_text(content, encoding="utf-8")
        _s.commit_change(ctx, f"docs: edit {rel}", target, ai=args.get("ai"))
        return text_result(f"Document rewritten: {rel}")
    return text_result("Provide either 'old_string'+'new_string' (patch) or 'content' (rewrite)", is_error=True)


def _tool_move_doc(args, ctx):
    src_rel = (args.get("from") or "").strip()
    dst_rel = (args.get("to") or "").strip()
    if not src_rel or not dst_rel:
        return text_result("'from' and 'to' are required", is_error=True)
    if _s._is_readonly_path(src_rel) or _s._is_readonly_path(dst_rel):
        return text_result("Read-only location (remote node mirror) — \"Appropriate\" it first to get an editable copy.", is_error=True)
    if ctx is not None and not _visible(src_rel, ctx):
        return text_result(f"Document not found: {src_rel}", is_error=True)
    if ctx is not None and not _s.can_write(src_rel, ctx, "owner"):
        return text_result("Insufficient permission (need owner to move this document).", is_error=True)
    # Gate the DESTINATION too: you can't plant a doc into a space you can't
    # see (e.g. another user's private folder). Mirrors create_doc's check.
    if ctx is not None and not _s.can_create(dst_rel, ctx):
        return text_result("Insufficient permission to move to this destination.", is_error=True)
    src_rel = _s._canonical_rel(src_rel)  # match the on-disk ACL key
    status, payload = _s._move_md_with_relink(src_rel, dst_rel)
    if status != "ok":
        return text_result(payload, is_error=True)
    # Repoint the ACL + shares BEFORE the git sync (privacy travels with the doc).
    _s._repoint_doc(payload["from"], payload["to"])
    touched = [payload["from"], payload["to"], *(r["path"] for r in payload["rewrites"])]
    _s.commit_change(ctx, f"docs: move {payload['from']} -> {payload['to']}",
                     *(_s.CONFIG.content_root / p for p in touched), ai=args.get("ai"))
    n, files = payload["links_updated"], len(payload["rewrites"])
    msg = f"Moved: {payload['from']} -> {payload['to']}."
    msg += (f" {n} incoming wikilink(s) rewritten in {files} doc(s)."
            if n else " No incoming wikilink to fix.")
    return text_result(msg)


def _tool_get_links(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target or not target.exists() or not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    entry = _links_graph(ctx).get(rel) or {"out": [], "in": []}
    out = [p for p in entry["out"] if _visible(p, ctx)]
    return text_result(json.dumps({"path": rel, "links": out},
                                  ensure_ascii=False, indent=2))


def _tool_get_backlinks(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target or not target.exists() or not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    entry = _links_graph(ctx).get(rel) or {"out": [], "in": []}
    ins = [p for p in entry["in"] if _visible(p, ctx)]
    return text_result(json.dumps({"path": rel, "backlinks": ins},
                                  ensure_ascii=False, indent=2))


def _tool_get_mind_topology(args, ctx):
    build = _s._import_build()
    corpus = _doc_corpus(ctx)
    graph = build.build_links_index(
        [{"path": rel, "name": name_, "body": text} for rel, name_, text in corpus])
    all_paths = [rel for rel, _, _ in corpus]
    edges = sum(len(v["out"]) for v in graph.values())
    hubs = sorted(
        ({"path": p, "in_degree": len(v["in"])} for p, v in graph.items() if v["in"]),
        key=lambda h: (-h["in_degree"], h["path"]))[:10]
    linked = set(graph)
    orphans = [p for p in all_paths if p not in linked]
    tag_counts: dict = {}
    for rel, _, text in corpus:
        for t in _tags_for(build, rel, text):
            tag_counts[t] = tag_counts.get(t, 0) + 1
    top_tags = sorted(({"tag": t, "count": c} for t, c in tag_counts.items()),
                      key=lambda x: (-x["count"], x["tag"]))[:15]
    n = len(all_paths)
    payload = {
        "counts": {"docs": n, "edges": edges},
        "density": round(edges / n, 4) if n else 0,
        "hubs": hubs,
        "orphans": orphans[:50],
        "orphans_total": len(orphans),
        "top_tags": top_tags,
    }
    return text_result(json.dumps(payload, ensure_ascii=False, indent=2))


def _tool_list_by_tag(args, ctx):
    tag = (args.get("tag") or "").strip().lower()
    if not tag:
        return text_result("Error: missing 'tag' parameter", is_error=True)
    build = _s._import_build()
    matches = sorted(rel for rel, _, text in _doc_corpus(ctx)
                     if tag in _tags_for(build, rel, text))
    if not matches:
        return text_result(f"No document tagged: {tag}")
    return text_result(json.dumps({"tag": tag, "documents": matches},
                                  ensure_ascii=False, indent=2))


def _tool_delete_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target:
        return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
    if _s._is_readonly_path(rel):
        return text_result("Read-only location (remote node mirror) — cannot delete.", is_error=True)
    if not target.exists() or not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    if ctx is not None and not _s.can_write(rel, ctx, "owner"):
        return text_result("Insufficient permission (need owner to delete this document).", is_error=True)
    trashed = _soft_delete(target)
    # The ACL follows the doc into .trash so the freed path keeps no stale
    # entry a future doc created there would inherit; its share links are
    # revoked (a trashed doc must stop serving public links).
    try:
        _store = _s.get_store()
        _store.repoint_acl_by_path(rel, trashed)
        _store.delete_shares_for_path(rel)
    except Exception as e:
        print(f"[delete cleanup] {e}", file=sys.stderr)
    _s.commit_change(ctx, f"docs: delete {rel}", target, _s.CONFIG.content_root / trashed,
                     ai=args.get("ai"))
    return text_result(f"Document moved to trash (reversible): {rel} -> {trashed}")


def _tool_doc_history(args, ctx):
    rel = (args.get("path") or "").strip()
    if _s._validate_doc_path(rel) is None:
        return text_result(f"Invalid path (relative .md or .html, no '..'): {rel}", is_error=True)
    if not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    try:
        limit = min(100, max(1, int(args.get("limit", 30))))
    except (ValueError, TypeError):
        limit = 30
    since = (args.get("since") or "").strip()
    until = (args.get("until") or "").strip()
    grep = (args.get("grep") or "").strip()
    repo_rel = "content/" + rel
    # since/until/grep are git-native FILTERS (dates/text), never revs — passed as
    # fused argv tokens, deliberately NOT through _valid_git_rev (which rejects them).
    opts = ["-n", str(limit)]
    if since:
        opts.append("--since=" + since)
    if until:
        opts.append("--until=" + until)
    if grep:
        opts.append("--grep=" + grep)
    records = _git_doc_records(repo_rel, *opts)
    if records is None:
        return text_result("git log failed", is_error=True)
    head = _s.git("rev-parse", "HEAD").stdout.strip()
    revisions = []
    for record in records:
        commit = _fmt_commit(record)
        commit["is_current"] = commit["sha"] == head
        revisions.append(commit)
    # Lifecycle header (absorbs the would-be doc_first_seen): --diff-filter=A gives
    # the true birth even past the -n cap; take the OLDEST add (delete+re-add -> >1).
    adds = _git_doc_records(repo_rel, "--diff-filter=A")
    created = _fmt_commit(adds[-1]) if adds else None
    if since or until or grep:
        newest = _git_doc_records(repo_rel, "-n", "1")
        last_modified = _fmt_commit(newest[0]) if newest else None
    else:
        last_modified = revisions[0] if revisions else None
    payload = {"path": rel, "created": created,
               "last_modified": last_modified, "revisions": revisions}
    return text_result(json.dumps(payload, ensure_ascii=False, indent=2))


def _tool_doc_at(args, ctx):
    rel = (args.get("path") or "").strip()
    if _s._validate_doc_path(rel) is None:
        return text_result(f"Invalid path: {rel}", is_error=True)
    if not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    rev = (args.get("rev") or "").strip()
    at = (args.get("at") or "").strip()
    repo_rel = "content/" + rel
    if at and not rev:
        # Resolve a date to a SHA server-side. --until=<date> is a fused token and a
        # trailing -- precedes the pathspec, so a leading-dash date can't become a flag.
        resolved = _s.git("log", "--follow", "-n", "1", "--format=%H",
                          "--until=" + at, "--", repo_rel).stdout.strip()
        if not resolved:
            return text_result(f"No revision of {rel} on or before '{at}'", is_error=True)
        rev = resolved
    elif rev:
        if not _s._valid_git_rev(rev):
            return text_result("Invalid 'rev' (a commit SHA or HEAD~N; put a date in 'at')", is_error=True)
    else:
        rev = "HEAD"
    rev_sha = _s.git("rev-parse", rev).stdout.strip() or rev
    show = _s.git("show", rev_sha + ":" + _s._doc_path_at(repo_rel, rev_sha))
    if show.returncode != 0:
        return text_result(f"Revision not found: {rev}", is_error=True)
    date = _s.git("show", "-s", "--format=%aI", rev_sha).stdout.strip()
    content, truncated = _capped(show.stdout)
    header = (f"[doc_at] {rel} @ {rev_sha[:8]} ({date})"
              + ("  [truncated — see /api/revision for the full blob]" if truncated else ""))
    return text_result(header + "\n\n" + content)


def _tool_doc_diff(args, ctx):
    rel = (args.get("path") or "").strip()
    if _s._validate_doc_path(rel) is None:
        return text_result(f"Invalid path: {rel}", is_error=True)
    if not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    rev = (args.get("rev") or "HEAD").strip() or "HEAD"
    base = (args.get("base") or "").strip()
    if not _s._valid_git_rev(rev):
        return text_result("Invalid 'rev' (a commit SHA or HEAD~N)", is_error=True)
    if base and not _s._valid_git_rev(base):
        return text_result("Invalid 'base' (a commit SHA or HEAD~N)", is_error=True)
    repo_rel = "content/" + rel
    rev_sha = _s.git("rev-parse", rev).stdout.strip()
    if not rev_sha:
        return text_result(f"Revision not found: {rev}", is_error=True)
    if base:
        base_sha = _s.git("rev-parse", base).stdout.strip()
        if not base_sha:
            return text_result(f"Revision not found: {base}", is_error=True)
    else:
        # Default base = the doc's PREVIOUS touch (not literal rev~1, which may not
        # have changed this doc). Empty -> rev is the doc's first appearance.
        prev = _s.git("log", "--follow", "--format=%H", "-n", "1",
                      rev_sha + "~1", "--", repo_rel)
        base_sha = prev.stdout.strip() if prev.returncode == 0 else ""
        if not base_sha:
            base_sha = _EMPTY_TREE
    diff_text, added, removed = _doc_diff_between(repo_rel, base_sha, rev_sha)
    if diff_text is None:
        return text_result("git diff failed", is_error=True)
    base_label = "(initial)" if base_sha == _EMPTY_TREE else base_sha[:8]
    body, truncated = _capped(diff_text)
    header = (f"[doc_diff] {rel}  {base_label} → {rev_sha[:8]}  (+{added} −{removed})"
              + ("  [truncated]" if truncated else ""))
    if not diff_text.strip():
        return text_result(header + "\n\n(no changes to this document between these revisions)")
    return text_result(header + "\n\n" + body)


def _tool_search_history(args, ctx):
    query = (args.get("query") or "").strip()
    if not query:
        return text_result("Error: missing 'query' parameter", is_error=True)
    regex = bool(args.get("regex"))
    prefix = _safe_path_prefix(args.get("path_prefix") or "")
    if prefix is None:
        return text_result("Invalid 'path_prefix'", is_error=True)
    try:
        limit = min(50, max(1, int(args.get("limit", 20))))
    except (ValueError, TypeError):
        limit = 20
    pathspec = "content/" + prefix if prefix else "content"
    # Pickaxe: -S<str> finds commits where the OCCURRENCE COUNT of the term changed
    # (it entered or left history); -G<regex> matches added/removed lines. Fused
    # token so a leading-dash query is read as a value, not a flag.
    pick = ("-G" if regex else "-S") + query
    result = _s.git("log", pick, "-n", str(limit),
                    "--format=%x1e%H\x1f%an\x1f%aI\x1f%s", "--name-status", "-z",
                    "--", pathspec)
    if result.returncode != 0:
        return text_result("git history search failed (check the regex)" if regex
                           else "git history search failed", is_error=True)
    commits = _scrub_commits(
        _parse_namestatus_log(result.stdout, _s._import_build().EXCLUDED_NAMES), ctx)
    if not commits:
        return text_result(f"No commit where '{query}' entered or left the history"
                           + (f" under {prefix}" if prefix else ""))
    return text_result(json.dumps({"query": query, "regex": regex, "matches": commits},
                                  ensure_ascii=False, indent=2))


def _tool_changelog(args, ctx):
    try:
        days = min(365, max(1, int(args.get("days", 14))))
    except (ValueError, TypeError):
        days = 14
    try:
        limit = min(200, max(1, int(args.get("limit", 50))))
    except (ValueError, TypeError):
        limit = 50
    author = (args.get("author") or "").strip()
    prefix = _safe_path_prefix(args.get("path") or "")
    if prefix is None:
        return text_result("Invalid 'path'", is_error=True)
    pathspec = "content/" + prefix if prefix else "content"
    # -M: detect renames so a moved doc shows as one R record (old+new path)
    # rather than a delete+add pair; the -z parser pairs the two paths.
    opts = ["log", "--since=" + str(days) + ".days.ago", "-n", str(limit),
            "--format=%x1e%H\x1f%an\x1f%aI\x1f%s", "--name-status", "-M", "-z"]
    if author:
        opts.append("--author=" + author)
    opts += ["--", pathspec]
    result = _s.git(*opts)
    if result.returncode != 0:
        return text_result("git log failed", is_error=True)
    commits = _scrub_commits(
        _parse_namestatus_log(result.stdout, _s._import_build().EXCLUDED_NAMES), ctx)
    if not commits:
        return text_result(f"No document changes in the last {days} days"
                           + (f" under {prefix}" if prefix else ""))
    return text_result(json.dumps({"since_days": days, "commits": commits},
                                  ensure_ascii=False, indent=2))


def _tool_doc_blame(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if target is None:
        return text_result(f"Invalid path: {rel}", is_error=True)
    if not target.exists() or not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    pattern = (args.get("pattern") or "").strip()
    try:
        start = max(0, int(args.get("start", 0)))
    except (ValueError, TypeError):
        start = 0
    try:
        end = max(0, int(args.get("end", 0)))
    except (ValueError, TypeError):
        end = 0
    blame_args = ["blame", "--line-porcelain"]
    if start > 0:
        blame_args += ["-L", f"{start},{end}" if end >= start and end > 0 else f"{start},"]
    blame_args += ["--", "content/" + rel]
    result = _s.git(*blame_args)
    if result.returncode != 0:
        return text_result("git blame failed", is_error=True)
    lines = _parse_blame(result.stdout)
    if pattern:
        low = pattern.lower()
        lines = [ln for ln in lines if low in ln["text"].lower()]
    truncated = False
    if not pattern and start == 0 and len(lines) > _MAX_BLAME_LINES:
        lines = lines[:_MAX_BLAME_LINES]
        truncated = True
    return text_result(json.dumps({"path": rel, "truncated": truncated, "lines": lines},
                                  ensure_ascii=False, indent=2))


def _tool_doc_revert(args, ctx):
    rel = (args.get("path") or "").strip()
    rev = (args.get("rev") or "").strip()
    target = _s._validate_doc_path(rel)
    if target is None:
        return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
    if not _s._valid_git_rev(rev):
        return text_result("Invalid revision (a commit SHA or HEAD~N)", is_error=True)
    if _s._is_readonly_path(rel):
        return text_result("Read-only location (remote node mirror) — cannot revert.", is_error=True)
    if ctx is not None and not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    if ctx is not None and not _s.can_write(rel, ctx, "edit"):
        return text_result("Insufficient permission (need edit on this document).", is_error=True)
    show = _s.git("show", rev + ":" + _s._doc_path_at("content/" + rel, rev))
    if show.returncode != 0:
        return text_result(f"Revision not found: {rev}", is_error=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(show.stdout, encoding="utf-8")
    _s.commit_change(ctx, f"docs: revert {rel}", target, ai=args.get("ai"))
    return text_result(f"Reverted {rel} to revision {rev[:8]} "
                       "(written as a forward-moving change; the prior version stays in history).")


# name → handler. _mcp_call_tool looks the tool up here; an unknown name 404s below.
_TOOLS = {
    "search_docs": _tool_search_docs,
    "read_doc": _tool_read_doc,
    "list_tree": _tool_list_tree,
    "recent_docs": _tool_recent_docs,
    "create_doc": _tool_create_doc,
    "edit_doc": _tool_edit_doc,
    "move_doc": _tool_move_doc,
    "get_links": _tool_get_links,
    "get_backlinks": _tool_get_backlinks,
    "get_mind_topology": _tool_get_mind_topology,
    "list_by_tag": _tool_list_by_tag,
    "delete_doc": _tool_delete_doc,
    "doc_history": _tool_doc_history,
    "doc_at": _tool_doc_at,
    "doc_diff": _tool_doc_diff,
    "search_history": _tool_search_history,
    "changelog": _tool_changelog,
    "doc_blame": _tool_doc_blame,
    "doc_revert": _tool_doc_revert,
}


def _mcp_call_tool(name: str, args: dict, ctx=None) -> dict:
    """Dispatch an MCP tool to its handler. Returns MCP CallToolResult."""
    fn = _TOOLS.get(name)
    if fn is None:
        return text_result(f"Unknown tool: {name}", is_error=True)
    return fn(args, ctx)


def _mcp_jsonrpc(req: dict, ctx=None):
    """Process an MCP JSON-RPC message. Returns response dict, or None for notifications."""
    method = req.get("method")
    params = req.get("params") or {}
    req_id = req.get("id")

    # Notifications have no id → no response, just log
    if req_id is None:
        sys.stderr.write(f"[mcp] notification: {method}\n")
        sys.stderr.flush()
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def err(code, message):
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    try:
        if method == "initialize":
            return ok({
                "protocolVersion": _s.MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": _s.CONFIG.site_slug, "version": "1.0.0"},
            })
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": _s._mcp_tools()})
        if method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments") or {}
            sys.stderr.write(f"[mcp] tools/call name={tool_name}\n")
            sys.stderr.flush()
            return ok(_mcp_call_tool(tool_name, arguments, ctx))
        return err(-32601, f"method not found: {method}")
    except Exception as e:
        # Detail (may carry server paths) to stderr only; client gets a generic message.
        sys.stderr.write(f"[mcp] error in {method}: {e}\n")
        sys.stderr.flush()
        return err(-32603, "internal error")
