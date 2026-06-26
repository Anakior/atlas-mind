"""Read-side aggregates over the doc corpus, shared by REST routes and MCP tools."""
import datetime
import posixpath
import time

import server as _s


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


def _tags_for(build, rel: str, text: str) -> list:
    """Folder-derived tags + frontmatter tags, merged and deduped — mirrors the
    tag computation of build.walk so the MCP tools never diverge from the viewer."""
    tags = list(build._folder_tags(rel))
    fm_tags, _ = build._parse_frontmatter(text)
    for t in fm_tags:
        if t not in tags:
            tags.append(t)
    return tags


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


_MONTH_SECONDS = 2629800  # 30.4375 days


def _api_stale(months: int, limit: int, ctx=None) -> list:
    """Docs untouched for `months`+ months (13c obsolescence), oldest first. Dates come
    from the last git commit per doc (survives clone/pull, unlike mtime); mtime is a
    fallback when git is unavailable. Deterministic, ACL-scrubbed per ctx."""
    cutoff = time.time() - months * _MONTH_SECONDS
    dates = _s._import_build()._git_commit_dates(_s.CONFIG.root)
    items = []
    for rel, path in _s._iter_doc_files():
        if not _visible(rel, ctx):
            continue
        ts = dates.get(rel)
        if ts is None:
            try:
                ts = int(path.stat().st_mtime)
            except OSError:
                continue
        if ts >= cutoff:
            continue
        items.append({
            "path": rel, "name": path.name, "last_modified": int(ts),
            "months_ago": round((time.time() - ts) / _MONTH_SECONDS, 1),
        })
    items.sort(key=lambda h: h["last_modified"])
    return items[:limit]


def _api_inbox_list(limit: int = 50, ctx=None) -> list:
    """Pending inbox items (the agents' on-ramp), highest confidence first.

    The inbox is sealed from the corpus (iter_doc_files skips it), so this rglobs inbox/
    DIRECTLY instead of going through _iter_doc_files. ACL-scrubbed per ctx; the inbox is
    private, so the route gates on primary/superuser before calling. Trashed items and
    snoozed items not yet due are hidden. A malformed item is skipped, never crashes the
    list. Dates come from the last git commit (mtime fallback), like _api_stale."""
    root = _s.CONFIG.content_root / "inbox"
    if not root.is_dir():
        return []
    build = _s._import_build()
    dates = build._git_commit_dates(_s.CONFIG.root)
    today = time.strftime("%Y-%m-%d", time.localtime())
    items = []
    for path in sorted(root.rglob("*.md")):
        rel = path.relative_to(_s.CONFIG.content_root).as_posix()
        if not _visible(rel, ctx):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta = build._inbox_meta(text)
        if meta.get("inbox_status") == "trashed":
            continue
        snooze = str(meta.get("snooze_until") or "")[:10]
        if snooze and snooze > today:
            continue
        ts = dates.get(rel)
        if ts is None:
            try:
                ts = int(path.stat().st_mtime)
            except OSError:
                ts = 0
        _tags, body = build._parse_frontmatter(text)
        blines = body.strip().splitlines()
        title, rest = path.stem, blines
        for i, ln in enumerate(blines):
            if ln.startswith("# "):
                title, rest = ln[2:].strip(), blines[i + 1:]
                break
        parts = rel.split("/")
        items.append({
            "path": rel, "title": title,
            "preview": " ".join(" ".join(rest).split())[:240],
            # source from the frontmatter; fallback to the immediate parent folder (inbox/<user>/
            # <source>/file or the legacy inbox/<source>/file -> parts[-2] is the source either way)
            "source": meta.get("source") or (parts[-2] if len(parts) >= 3 else "manual"),
            "confidence": meta.get("confidence", 0.0),
            "suggest_dest": meta.get("suggest_dest", ""),
            "suggest_tags": meta.get("suggest_tags", []),
            "neighbors": meta.get("neighbors", []),
            "status": meta.get("inbox_status", "pending"),
            "captured_at": int(ts),
        })
    items.sort(key=lambda h: (-h["confidence"], -h["captured_at"]))
    return items[:limit]


# Read side of the attribution layer (the timeline / brick 13a): map a commit to one
# normalized event TYPE. The targeted subject prefix is the richest signal (it tells
# check from edit, revert/folder-move from a plain M/R); git status is the fallback for
# legacy commits that predate the attribution work.
_ACTIVITY_VERB_TYPE = {
    "created": "create", "edited": "edit", "moved": "move", "folder": "move",
    "deleted": "delete", "checked": "check", "unchecked": "check",
    "reverted": "revert", "annotated": "edit", "annotation": "edit",
    # Mental-node subscriptions (remotes/) get their own verbs so the feed reads
    # "added/removed the node X" instead of a generic create/delete of mirror files.
    "node_added": "node_add", "node_removed": "node_remove",
}
_ACTIVITY_STATUS_TYPE = {"A": "create", "M": "edit", "D": "delete", "R": "move", "C": "move"}


def _activity_events(days, limit, author, type_filter, ctx):
    """Corpus-wide activity feed: git log over content/ carrying the X-Atlas-Author
    trailer + author email, mapped to the CDC event model
    {sha, short_sha, author, email, ai, date (UTC), type, title, subject, paths}.
    ACL-scrubbed per `ctx` (None = unfiltered/internal). Returns None on git failure."""
    fmt = ("%x1e%H\x1f%an\x1f%ae\x1f%aI\x1f%s\x1f"
           "%(trailers:key=X-Atlas-Author,valueonly)")
    opts = ["log", "--since=" + str(days) + ".days.ago", "-n", str(limit),
            "--format=" + fmt, "--name-status", "-M", "-z"]
    if author:
        opts.append("--author=" + author)
    opts += ["--", "content"]
    result = _s.git(*opts)
    if result.returncode != 0:
        return None
    excluded = _s._import_build().EXCLUDED_NAMES
    events = []
    for rec in result.stdout.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        head, _, rest = rec.partition("\x00")
        sha, an, ae, aI, subj, trailer = (head.split("\x1f") + [""] * 6)[:6]
        if not sha:
            continue
        tokens = [t for t in (x.lstrip("\n") for x in rest.split("\x00")) if t]
        files = []
        i = 0
        while i < len(tokens):
            status = tokens[i]
            if status[:1] in ("R", "C") and i + 2 < len(tokens):
                new_rel = _strip_content(tokens[i + 2])
                old_rel = _strip_content(tokens[i + 1])
                # A soft-delete is a rename INTO .trash (excluded); keep the visible side
                # so the event isn't dropped — its "deleted:" subject still types it.
                rel = new_rel if (new_rel and _history_path_included(new_rel, excluded)) else old_rel
                if rel is not None and _history_path_included(rel, excluded):
                    files.append({"status": status[:1], "path": rel})
                i += 3
            else:
                rel = _strip_content(tokens[i + 1]) if i + 1 < len(tokens) else None
                if rel is not None and _history_path_included(rel, excluded):
                    files.append({"status": status[:1] or "?", "path": rel})
                i += 2
        files = [f for f in files if _visible(f["path"], ctx)]
        if not files:
            continue
        verb = subj.split(":", 1)[0].strip().split(" ")[0].lower() if ":" in subj else ""
        typ = _ACTIVITY_VERB_TYPE.get(verb) or _ACTIVITY_STATUS_TYPE.get(files[0]["status"], "edit")
        if type_filter and typ != type_filter:
            continue
        ai = _s.parse_ai_trailer(trailer)
        try:
            date = datetime.datetime.fromisoformat(aI).astimezone(datetime.timezone.utc).isoformat()
        except (ValueError, TypeError):
            date = aI
        events.append({
            "sha": sha, "short_sha": sha[:7], "author": an, "email": ae,
            "ai": ai, "date": date, "type": typ,
            "title": posixpath.splitext(posixpath.basename(files[0]["path"]))[0],
            "subject": subj, "paths": [f["path"] for f in files],
        })
    return events
