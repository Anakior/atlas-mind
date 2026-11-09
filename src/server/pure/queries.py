"""Read-side aggregates over the doc corpus, shared by REST routes and MCP tools."""
import datetime
import math
import os
import posixpath
import re
import threading
import time

import server as _s
from server.pure import attestations, file_text, provenance


def _visible(rel, ctx):
    """Whether `ctx` may read `rel`. ctx=None → unfiltered (internal/local use,
    e.g. direct calls in tests)."""
    return ctx is None or _s.can_read(rel, ctx)


def _visible_at(rel, rev, ctx):
    """Whether `ctx` may read what `rel` named at commit `rev` (acl.level_at)."""
    return ctx is None or _s.can_read_at(rel, rev, ctx)


def _touched_visible(rel, sha, ctx):
    """Whether `ctx` may see that commit `sha` touched `rel`: the doc there just before and just
    after (a deletion is judged by the doc it removed)."""
    return _visible_at(rel, sha + "^", ctx) and _visible_at(rel, sha, ctx)


# What a reader sees of the mind, memoized: checking and reading every doc on each call took
# seconds on a few thousand. A memo holds while no file under content/ changes (one scandir walk,
# tens of ms), the ACL registry stays the same and none of the reader's grants expires. Texts are
# kept once for every reader and read again only when their file changes.
_MEMO_READERS = 8
_memos: dict = {}
_texts: dict = {}  # str(path) -> ((mtime_ns, size), text)
_memo_lock = threading.Lock()


def _content_stamp() -> dict:
    """{rel: (mtime_ns, size)} of every file under content/ outside dot folders."""
    root = _s.CONFIG.content_root
    stamp, folders = {}, [""]
    while folders:
        folder = folders.pop()
        try:
            entries = list(os.scandir(root / folder))
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith("."):
                continue
            rel = f"{folder}/{entry.name}" if folder else entry.name
            try:
                if entry.is_dir(follow_symlinks=False):
                    folders.append(rel)
                else:
                    st = entry.stat()
                    stamp[rel] = (st.st_mtime_ns, st.st_size)
            except OSError:
                continue
    return stamp


def _registry_stamp() -> tuple:
    """The ACL registry (its rights and share links) as it stands."""
    store, stamp = _s.get_store(), []
    for name in (store.ACL_FILE, store.SHARES_FILE):
        try:
            st = os.stat(store.base / name)
            stamp.append((st.st_mtime_ns, st.st_size))
        except OSError:
            stamp.append(None)
    return tuple(stamp)


def _reader_memo(ctx) -> dict:
    """The memo of what `ctx` may read, rebuilt when the content or the rights changed. Rights
    already checked are kept across a content change (an edit re-checks no other doc)."""
    files = _content_stamp()
    access = None if ctx is None else _registry_stamp()
    key = (str(_s.CONFIG.content_root),
           None if ctx is None else (ctx.principals, ctx.is_admin, ctx.superuser, ctx.api))
    memo = _memos.get(key)
    rights_hold = memo and memo["access"] == access and time.time() < memo["until"]
    if rights_hold and memo["files"] == files:
        return memo
    # A grant lives through the second it expires at (best_grant): the memo holds no longer.
    until = math.inf if ctx is None else min(
        (g["expires_at"] + 1 for g in _s.get_store().list_docs_shared_with(ctx.principals)
         if g["expires_at"]), default=math.inf)
    memo = {"files": files, "access": access, "until": until, "seen": memo["seen"] if rights_hold else {},
            "lists": {}, "corpus": None, "graph": None}
    with _memo_lock:
        _memos.pop(key, None)
        _memos[key] = memo
        while len(_memos) > _MEMO_READERS:
            _memos.pop(next(iter(_memos)))
    return memo


def _listing(memo, ctx, suffixes) -> list:
    """[(rel, Path)] of the files with one of `suffixes` that the reader of `memo` may read."""
    found = memo["lists"].get(suffixes)
    if found is None:
        seen = memo["seen"]
        found = []
        for rel, path in _s._iter_doc_files(suffixes):
            if rel not in seen:
                # The walk gives the spelling on disk: no canonical path to look up (seconds on Windows).
                seen[rel] = ctx is None or _s._acl_can_read(rel, ctx)
            if seen[rel]:
                found.append((rel, path))
        memo["lists"][suffixes] = found
    return found


def _readable(ctx=None, suffixes=(".md", ".html")) -> list:
    """[(rel, Path)] of the files with one of `suffixes` that `ctx` may read (_iter_doc_files' set)."""
    return list(_listing(_reader_memo(ctx), ctx, suffixes))


def _text(rel, path, files):
    """The text of doc `path`, read again only when its file changed. utf-8-sig tolerates a BOM."""
    stamp, key = files.get(rel), str(path)
    kept = _texts.get(key)
    if kept and stamp and kept[0] == stamp:
        return kept[1]
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        _texts.pop(key, None)
        return None
    _texts[key] = (stamp, text)
    return text


def _corpus(memo, ctx) -> list:
    """The corpus of the reader of `memo`, memoized with it."""
    if memo["corpus"] is None:
        files = memo["files"]
        memo["corpus"] = [(rel, path.name, text) for rel, path in _listing(memo, ctx, (".md", ".html"))
                          if (text := _text(rel, path, files)) is not None]
        live = {str(_s.CONFIG.content_root / rel) for rel in files}
        for key in [k for k in _texts if k not in live]:
            _texts.pop(key, None)
    return memo["corpus"]


def _doc_corpus(ctx=None):
    """[(rel, name, text)] for every doc readable by `ctx`.
    THE choke-point: search/topology/tags/links all iterate here, so filtering
    once propagates to every derived aggregate."""
    return list(_corpus(_reader_memo(ctx), ctx))


def _links_graph(ctx=None):
    """Wikilink graph {path: {"out": [...], "in": [...]}} over the docs readable by
    `ctx`. Built on the filtered corpus so the graph never exposes a private doc as
    a node; callers still scrub `out` edges that point at a private target. Shared
    between calls: read it, never change it."""
    memo = _reader_memo(ctx)
    if memo["graph"] is None:
        memo["graph"] = _s._import_build().build_links_index(
            [{"path": rel, "name": name, "body": text} for rel, name, text in _corpus(memo, ctx)])
    return memo["graph"]


def _tags_for(build, rel: str, text: str) -> list:
    """Folder-derived tags + frontmatter tags, merged and deduped — mirrors the
    tag computation of build.walk so the MCP tools never diverge from the viewer."""
    tags = list(build._folder_tags(rel))
    fm_tags, _ = build._parse_frontmatter(text)
    for t in fm_tags:
        if t not in tags:
            tags.append(t)
    return tags


def _history_path_included(content_rel: str, excluded, docs_only=True) -> bool:
    """Apply the iter_doc_files visibility rules to a HISTORICAL path (a string from
    git, not a current file): skip dot-folders/.trash, skip skill/tools/__pycache__,
    skip excluded basenames, keep only .md/.html (any file with docs_only=False: the
    activity feed shows a PDF dropped in too). iter_doc_files itself can't be used
    here — its set is current-files-only, so deleted/trashed docs in history are absent."""
    parts = content_rel.split("/")
    if any(p == ".git" or p.startswith(".") for p in parts):
        return False
    if parts and parts[0] in ("skill", "tools", "__pycache__"):
        return False
    if parts[-1] in excluded:
        return False
    return not docs_only or content_rel.endswith((".md", ".html"))


def _strip_content(p: str):
    """Strip the 'content/' repo prefix from a git path, or None if not under it."""
    return p[len("content/"):] if p.startswith("content/") else None


_BM25_K1 = 1.2
_BM25_B = 0.75
_NAME_WEIGHT = 3  # an occurrence in the filename weighs three in the body
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


def _headings(lines):
    """(0-based line index, level, title) of each Markdown heading, code fences skipped."""
    fenced = False
    for i, line in enumerate(lines):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        elif not fenced:
            m = _HEADING_RE.match(line)
            if m:
                yield i, len(m.group(1)), m.group(2)


def _snippet(content: str, content_n: str, tokens) -> str:
    """~180 characters around the earliest query-token occurrence (the doc start when only
    the filename matched), flattened to one line."""
    found = [(i, t) for t in tokens if (i := content_n.find(t)) >= 0]
    if not found:
        return content[:160].replace("\n", " ").strip() + ("…" if len(content) > 160 else "")
    idx, token = min(found)
    start = max(0, idx - 60)
    end = min(len(content), idx + len(token) + 120)
    return (("…" if start > 0 else "") + content[start:end].replace("\n", " ").strip()
            + ("…" if end < len(content) else ""))


def _locate(content: str, content_n: str, tokens) -> dict:
    """1-based line carrying the most query tokens and its heading path ("A > B"), so an
    agent can read just that section. Normalizing keeps line breaks, so the normalized
    lines index the raw ones."""
    best, best_n = None, 0
    for i, line in enumerate(content_n.splitlines()):
        n = sum(1 for t in tokens if t in line)
        if n > best_n:
            best, best_n = i, n
            if n == len(tokens):
                break
    if best is None:
        return {}
    path = []
    for i, level, title in _headings(content.splitlines()):
        if i > best:
            break
        path = [h for h in path if h[0] < level] + [(level, title)]
    out = {"line": best + 1}
    if path:
        out["section"] = " > ".join(title for _, title in path)
    return out


# The files search reads: the docs, and the text inside office, PDF and plain-text files.
SEARCHED = (".md", ".html", ".txt", ".csv", *file_text.EXTS)


def warm_search():
    """Every searched file read into the search cache, so the first search after a boot or a
    change doesn't read the PDFs and office files itself (seconds on a small instance)."""
    for rel, path in _s._iter_doc_files(SEARCHED):
        _s._doc_entry(rel, path)
    file_text.prune()  # every file seen: the texts kept for the others can go


def _api_search(q: str, limit: int, ctx=None, only=None) -> list:
    """BM25 ranking (an occurrence in the filename weighs three in the body), with typo
    tolerance (a token that can't be found is corrected to the closest word in the
    vocabulary). Tokens match as substrings, so 'auth' still finds 'authentication'.
    `only` (a set of paths) ranks those docs among themselves. Content read via the
    _doc_entry in-memory cache."""
    import difflib
    tokens = [t for t in _s._normalize_text(q).split() if t]
    if not tokens:
        return []
    entries = []
    for rel, path in _readable(ctx, SEARCHED):
        if only is not None and rel not in only:
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
    scored = []
    for rel, path, e in entries:
        tf = [e["name_n"].count(t) * _NAME_WEIGHT + e["content_n"].count(t) for t in tokens]
        if any(tf):
            scored.append((rel, path, e, tf))
    n = len(entries)
    avgdl = (sum(e["length"] for _, _, e in entries) / n if n else 0) or 1
    idf = [math.log(1 + (n - df + 0.5) / (df + 0.5))
           for df in (sum(1 for *_, tf in scored if tf[i]) for i in range(len(tokens)))]
    ranked = []
    for rel, path, e, tf in scored:
        norm = _BM25_K1 * (1 - _BM25_B + _BM25_B * e["length"] / avgdl)
        score = sum(w * f * (_BM25_K1 + 1) / (f + norm) for w, f in zip(idf, tf) if f)
        ranked.append((score, e["mtime"], rel, path, e))
    ranked.sort(key=lambda r: (-r[0], -r[1]))
    hits = []
    for score, mtime, rel, path, e in ranked[:limit]:
        content = _s._doc_text(rel, path) or ""
        hit = {"path": rel, "name": path.name, "score": round(score, 3),
               "snippet": _snippet(content, e["content_n"], tokens), "mtime": int(mtime)}
        # An .html is indexed as extracted text: its lines don't map back to the file.
        if not rel.lower().endswith(".html"):
            hit.update(_locate(content, e["content_n"], tokens))
        hits.append(hit)
    return hits


def _api_recent(days: int, limit: int, ctx=None) -> list:
    """Documents changed within the window, from most recent to oldest, dated by their last
    commit like _api_stale: a cloud clone's file dates are its boot time. A file git doesn't
    know yet goes by its mtime. A preview from outside the mind carries `untrusted`."""
    cutoff = time.time() - days * 86400
    dates = _s._import_build()._git_commit_dates(_s.CONFIG.root)
    recent = []
    for rel, path in _readable(ctx):
        ts = dates.get(rel)
        if ts is None:
            try:
                ts = path.stat().st_mtime
            except OSError:
                continue
        if ts >= cutoff:
            recent.append((-ts, rel, path))
    items = []
    for ts, rel, path in sorted(recent)[:limit]:
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
            "mtime": int(-ts),
            **provenance.mark(rel),
        })
    return items


_MONTH_SECONDS = 2629800  # 30.4375 days


def _api_stale(months: int, limit: int, ctx=None, prefix: str = "") -> list:
    """Docs nobody has looked at for `months`+ months (13c obsolescence), the longest overdue
    first. A look is an edit (dated by the doc's last git commit, which survives clone/pull
    unlike mtime, the fallback without git) or a confirmation that the doc still holds, each
    one in a row doubling the wait. A doc flagged outdated waits for an edit, not a review:
    _api_outdated lists it instead. A record (kinds) is never due. `prefix` keeps one folder.
    Deterministic, ACL-scrubbed per ctx."""
    from server.pure import kinds  # lazy: kinds → sessions → queries
    threshold, now = months * _MONTH_SECONDS, time.time()
    dates = _s._import_build()._git_commit_dates(_s.CONFIG.root)
    confirmed = attestations.load()
    items = []
    for rel, path in _readable(ctx):
        if not rel.startswith(prefix):
            continue
        ts = dates.get(rel)
        if ts is None:
            try:
                ts = int(path.stat().st_mtime)
            except OSError:
                continue
        due = ts + threshold
        entry = confirmed.get(rel)
        if entry:
            try:
                entry = attestations.current(entry, path.read_text(encoding="utf-8-sig"))
            except OSError:
                entry = None
        if entry and entry["verdict"] == "outdated":
            continue
        if entry:
            due = max(due, attestations.fresh_until(entry, threshold))
        if due >= now or kinds.doc_as_of(rel, path, ts, confirmed):
            continue
        item = {"path": rel, "name": path.name, "last_modified": int(ts),
                "months_ago": round((now - ts) / _MONTH_SECONDS, 1), **provenance.mark(rel)}
        if entry:
            item["confirmed"] = entry["at"]
        items.append((due, item))
    items.sort(key=lambda pair: pair[0])
    return [item for _, item in items[:limit]]


def _api_outdated(ctx=None) -> list:
    """Docs a reader flagged as outdated and nobody has edited since, the oldest flag first."""
    out = []
    for rel, entry in attestations.load().items():
        if entry.get("verdict") != "outdated" or not _visible(rel, ctx):
            continue
        try:
            text = (_s.CONFIG.content_root / rel).read_text(encoding="utf-8-sig")
        except OSError:
            continue
        if attestations.current(entry, text):
            out.append({"path": rel, "flagged": entry["at"], "by": entry.get("by"),
                        **({"note": entry["note"]} if entry.get("note") else {})})
    return sorted(out, key=lambda e: e["flagged"])


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
            "type": meta.get("type") or "note",
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
    # Inbox lifecycle (all frontmatter flips, so git would otherwise type them M=edit): a drop is
    # "received" (staged, not yet in the mind); a trash is a soft-delete; un-trash restores it; a
    # snooze postpones it. Kept items keep the rename signal (R -> move).
    "received": "receive", "trashed": "delete", "restored": "revert", "snoozed": "snooze",
    # Mental-node subscriptions (remotes/) get their own verbs so the feed reads
    # "added/removed the node X" instead of a generic create/delete of mirror files.
    "node_added": "node_add", "node_removed": "node_remove",
}
_ACTIVITY_STATUS_TYPE = {"A": "create", "M": "edit", "D": "delete", "R": "move", "C": "move"}


# Commits read per event asked for: the type filter and the ACL scrub drop some after git's -n.
_OVERFETCH = 4


def _activity_events(days, limit, author, type_filter, ctx):
    """The events of _activity_feed, or None on git failure."""
    feed = _activity_feed(days, limit, author, type_filter, ctx)
    return None if feed is None else feed[0]


def _activity_feed(days, limit, author, type_filter, ctx):
    """Corpus-wide activity feed: git log over content/ carrying the X-Atlas-Author
    trailer + author email, mapped to the CDC event model
    {sha, short_sha, author, email, ai, date (UTC), type, title, subject, paths, untrusted?}.
    ACL-scrubbed per `ctx` (None = unfiltered/internal). Returns (events, truncated), truncated
    when more events than `limit` may exist in the window, or None on git failure."""
    fmt = ("%x1e%H\x1f%an\x1f%ae\x1f%aI\x1f%s\x1f"
           "%(trailers:key=X-Atlas-Author,valueonly)")
    fetch = limit * _OVERFETCH
    opts = ["log", "--since=" + str(days) + ".days.ago", "-n", str(fetch),
            "--format=" + fmt, "--name-status", "-M", "-z"]
    if author:
        opts.append("--author=" + author)
    opts += ["--", "content"]
    result = _s.git(*opts)
    if result.returncode != 0:
        return None
    excluded = _s._import_build().EXCLUDED_NAMES
    records = [rec for rec in (r.strip("\n") for r in result.stdout.split("\x1e")) if rec]
    events = []
    for rec in records:
        if len(events) > limit:
            break
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
                rel = new_rel if (new_rel and _history_path_included(new_rel, excluded, False)) else old_rel
                if (rel is not None and _history_path_included(rel, excluded, False)
                        and _touched_visible(rel, sha, ctx)):
                    files.append({"status": status[:1], "path": rel})
                i += 3
            else:
                rel = _strip_content(tokens[i + 1]) if i + 1 < len(tokens) else None
                if (rel is not None and _history_path_included(rel, excluded, False)
                        and _touched_visible(rel, sha, ctx)):
                    files.append({"status": status[:1] or "?", "path": rel})
                i += 2
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
        paths = [f["path"] for f in files]
        events.append({
            "sha": sha, "short_sha": sha[:7], "author": an, "email": ae,
            "ai": ai, "date": date, "type": typ,
            "title": posixpath.splitext(posixpath.basename(paths[0]))[0],
            "subject": subj, "paths": paths,
            # File names written outside the mind (a mirror's) are its text too.
            **next(filter(None, map(provenance.mark, paths)), {}),
        })
    return events[:limit], len(events) > limit or len(records) >= fetch
