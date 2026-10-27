"""MCP tool dispatch (read-side queries live in pure/queries.py, git parsing in pure/git_history.py)."""
import base64
import datetime
import difflib
import functools
import json
import posixpath
import re
import sys
import time
from pathlib import Path

import server as _s
from store import slugify_token_label, slugify_title
from server.pure.queries import (
    _visible, _doc_corpus, _links_graph, _tags_for, _api_search, _api_recent,
    _api_stale, _activity_events, _headings, _strip_content, _MONTH_SECONDS,
)
from server.pure import contradictions, provenance, resources
from server.pure.git_history import (
    _capped, _fmt_commit, _git_doc_records, _safe_path_prefix, _parse_namestatus_log,
    _scrub_commits, _doc_diff_between, _parse_blame, _EMPTY_TREE, _MAX_BLAME_LINES,
    _attributed_log, _name_status,
)
from server.pure.params import clamp_int


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


def text_result(s: str, is_error: bool = False) -> dict:
    """Wrap a string as an MCP CallToolResult (with isError set when it's an error)."""
    out = {"content": [{"type": "text", "text": s}]}
    if is_error:
        out["isError"] = True
    return out


def json_result(payload: dict) -> dict:
    """A JSON tool result: compact text for the model, the same object as structuredContent
    for clients that consume it programmatically."""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return {"content": [{"type": "text", "text": text}], "structuredContent": payload}


def _version(text: str) -> str:
    """The content fingerprint read_doc reports and edit_doc's base_version is checked against."""
    return _s.doc_hash(text)


def _near_paths(rel: str, ctx, n: int = 3) -> list:
    """Visible doc paths closest to `rel`: the same filename in another folder first, then
    near spellings of the whole path."""
    by_path, by_name = {}, {}
    for p, _ in _s._iter_doc_files():
        if _visible(p, ctx):
            by_path[p.lower()] = p
            by_name.setdefault(posixpath.basename(p).lower(), []).append(p)
    rel = rel.lower()
    near = [p for m in difflib.get_close_matches(posixpath.basename(rel), by_name, n, 0.6)
            for p in by_name[m]]
    near += [by_path[m] for m in difflib.get_close_matches(rel, by_path, n, 0.6)]
    return list(dict.fromkeys(near))[:n]


def _not_found(rel: str, ctx, hint: str = "") -> dict:
    """'Document not found' plus the likeliest intended paths: agents misremember a folder
    or a slug far more often than they ask for a doc that doesn't exist."""
    near = _near_paths(rel, ctx)
    tip = (f" Did you mean: {', '.join(near)}?" if near
           else " Use search_docs or list_tree to find the right path.")
    return text_result(f"Document not found: {rel}{hint}.{tip}", is_error=True)


_PASSAGE_MAX_LINES = 15
_DIFF_MAX_LINES = 60


def _closest_passage(text: str, needle: str) -> str:
    """Where `needle` most likely sits in `text` (its first line fuzzily matched), quoted
    verbatim so the agent can copy the real text instead of re-reading the whole doc."""
    first = next((ln.strip() for ln in needle.splitlines() if ln.strip()), "")
    lines = text.splitlines()
    stripped = [ln.strip() for ln in lines]
    match = difflib.get_close_matches(first, stripped, 1, 0.6) if first else []
    if not match:
        return " No similar passage either: read_doc it to see the current text."
    lo = stripped.index(match[0])
    hi = min(len(lines), lo + min(max(1, len(needle.splitlines())), _PASSAGE_MAX_LINES))
    return f" Closest passage (lines {lo + 1}-{hi}):\n" + "\n".join(lines[lo:hi])


def _occurrence_lines(text: str, needle: str, cap: int = 10) -> list:
    """1-based lines where `needle` starts, to point at what makes an old_string ambiguous."""
    out, i = [], text.find(needle)
    while i != -1 and len(out) < cap:
        out.append(text.count("\n", 0, i) + 1)
        i = text.find(needle, i + 1)
    return out


def _diff(old: str, new: str) -> str:
    """Unified diff of an edit (one line of context), capped: enough for the agent to check
    its change without reading the doc back."""
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(), n=1, lineterm=""))[2:]
    if len(lines) > _DIFF_MAX_LINES:
        lines = lines[:_DIFF_MAX_LINES] + [f"… ({len(lines) - _DIFF_MAX_LINES} more diff lines)"]
    return "\n".join(lines)


_STALE_MONTHS = 6  # the stale tool's default threshold


def _last_commits(rels) -> dict:
    """{rel: (unix ts, author, AI family or None)} of the latest commit touching each doc,
    from a single git log."""
    if not rels:
        return {}
    # One doc (read_doc): the first commit listed is the one, and walking on costs ~1 s on a
    # mind with a few thousand commits.
    limit = ["-n", "1"] if len(rels) == 1 else []
    result = _s.git("--literal-pathspecs", "log", *limit, "--no-renames", "--name-only", "-z",
                    "--format=%x1e%ct%x1f%an%x1f%(trailers:key=X-Atlas-Author,valueonly)",
                    "--", *("content/" + r for r in rels))
    last = {}
    if result.returncode != 0:
        return last
    for rec in result.stdout.split("\x1e"):
        head, _, files = rec.partition("\x00")
        ts, author, trailer = (head.split("\x1f") + ["", ""])[:3]
        if not ts.strip().isdigit():
            continue
        for f in files.split("\x00"):
            rel = _strip_content(f.strip("\n"))
            if rel and rel not in last:
                last[rel] = (int(ts), author, _s.parse_ai_trailer(trailer))
    return last


def _contested(paths: set, ctx) -> dict:
    """{path: [docs it was judged to contradict]} for 'real' verdicts that still hold and
    whose two sides ctx can see."""
    out = {}
    for e in _s.load_verdicts():
        a, b = e.get("a") or "", e.get("b") or ""
        if e.get("verdict") != "real" or (a not in paths and b not in paths):
            continue
        ta, tb = _s._validate_doc_path(a), _s._validate_doc_path(b)
        if not (ta and tb and _visible(a, ctx) and _visible(b, ctx)):
            continue
        try:
            xa, xb = ta.read_text(encoding="utf-8-sig"), tb.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            continue
        if not _s.verdict_holds(e, _s.doc_hash(xa), _s.doc_hash(xb),
                                _s.line_hashes(xa), _s.line_hashes(xb)):
            continue
        for doc, other in ((a, b), (b, a)):
            if doc in paths and other not in out.setdefault(doc, []):
                out[doc].append(other)
    return out


def _add_trust_signals(hits: list, ctx) -> None:
    """What an agent needs to weigh each hit: date and author of its last edit (and the AI
    behind it, if any), staleness, the docs it was judged to contradict, and where it came
    from when written outside the mind. Replaces mtime, which is the boot time on a cloud
    clone."""
    paths = [h["path"] for h in hits]
    last, contested = _last_commits(paths), _contested(set(paths), ctx)
    stale_before = time.time() - _STALE_MONTHS * _MONTH_SECONDS
    for h in hits:
        ts, author, ai = last.get(h["path"], (h["mtime"], None, None))
        del h["mtime"]
        h["last_modified"] = time.strftime("%Y-%m-%d", time.gmtime(ts))
        if author:
            h["last_editor"] = author
        if ai:
            h["ai"] = ai
        if ts < stale_before:
            h["stale"] = True
        if h["path"] in contested:
            h["contested_with"] = contested[h["path"]]
        h.update(provenance.mark(h["path"]))


def _signal_notes(hit: dict) -> list:
    """A hit's trust signals as short phrases, for a text result's footer."""
    edited = f"last edited {hit['last_modified']}"
    if "last_editor" in hit:
        edited += f" by {hit['last_editor']}"
    if "ai" in hit:
        edited += f" (AI {hit['ai']})"
    notes = [edited]
    if hit.get("stale"):
        notes.append(f"untouched for {_STALE_MONTHS}+ months")
    if "contested_with" in hit:
        notes.append("contested with " + ", ".join(hit["contested_with"]))
    return notes


def _section_span(lines: list, query: str):
    """1-based (start, end) of the first heading containing `query` (case and accent
    insensitive), down to the next heading of the same or a higher level."""
    want = _s._normalize_text(query)
    heads = list(_headings(lines))
    for k, (i, level, title) in enumerate(heads):
        if want in _s._normalize_text(title):
            end = next((j for j, lv, _ in heads[k + 1:] if lv <= level), len(lines))
            return i + 1, end
    return None


def _tool_search_docs(args, ctx):
    q = (args.get("q") or "").strip()
    if not q:
        return text_result("Error: missing 'q' parameter", is_error=True)
    limit = clamp_int(args.get("limit"), 10, 1, 50)
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
    _add_trust_signals(hits, ctx)
    payload = {"query": q, "hits": hits}
    if tag:
        payload["tag"] = tag
    result = json_result(payload)
    result["content"] += [resources.link(h["path"]) for h in hits]  # attachable as resources
    return result


_GREP_LINE_MAX = 1000  # matched per line: bounds what a pathological regex can backtrack over


def _tool_grep_docs(args, ctx):
    pattern = args.get("pattern")
    if not isinstance(pattern, str) or not pattern.strip():
        return text_result("Error: missing 'pattern' parameter", is_error=True)
    prefix = _safe_path_prefix(args.get("path_prefix") or "")
    if prefix is None:
        return text_result("Invalid 'path_prefix'", is_error=True)
    limit = clamp_int(args.get("limit"), 50, 1, 200)
    flags = 0 if args.get("case_sensitive") else re.IGNORECASE
    try:
        rx = re.compile(pattern if args.get("regex") else re.escape(pattern), flags)
    except re.error as e:
        return text_result(f"Invalid regex: {e}", is_error=True)
    matches = []
    for rel, _name, text in sorted(_doc_corpus(ctx)):
        if prefix and rel != prefix and not rel.startswith(prefix + "/"):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if rx.search(line[:_GREP_LINE_MAX]):
                if len(matches) == limit:
                    return json_result({"pattern": pattern, "matches": matches, "truncated": True})
                matches.append({"path": rel, **provenance.mark(rel), "line": n,
                                "text": line.strip()[:240]})
    return json_result({"pattern": pattern, "matches": matches, "truncated": False})


def _tool_read_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target or not target.exists() or not _visible(rel, ctx):
        return _not_found(rel, ctx)
    text = target.read_text(encoding="utf-8")
    lines = text.splitlines()
    start = clamp_int(args.get("start_line"), 0, 0)
    end = clamp_int(args.get("end_line"), 0, 0)
    section = (args.get("section") or "").strip()
    if section:
        span = _section_span(lines, section)
        if span is None:
            titles = [title for _, _, title in _headings(lines)][:30]
            return text_result(f"No section matching '{section}' in {rel}. Its headings: "
                               + ("; ".join(titles) if titles else "none"), is_error=True)
        start, end = span
    if start or end:
        start, end = max(start, 1), min(end or len(lines), len(lines))
        if start > end:
            return text_result(f"Line range out of bounds: {rel} has {len(lines)} lines.",
                               is_error=True)
        body, scope = "\n".join(lines[start - 1:end]), f"lines {start}-{end} of {len(lines)}"
    else:
        body, scope = text, f"{len(lines)} lines"
    hit = {"path": rel, "mtime": target.stat().st_mtime}
    _add_trust_signals([hit], ctx)
    footer = " · ".join([rel, scope, *_signal_notes(hit), f"version {_version(text)}"])
    # Its own block, so the version never gets copied into an edit along with the text.
    return {"content": [{"type": "text", "text": provenance.fence(body, rel)},
                        {"type": "text", "text": f"[{footer}]"}]}


def _tool_list_tree(args, ctx):
    try:
        tree = _s._import_build().walk(_s.CONFIG.content_root)
        if ctx is not None:
            tree = _s._filter_tree(tree, lambda p: _s.can_read(p, ctx))
        return json_result(tree or {})
    except Exception as e:
        print(f"[mcp] list_tree failed: {e}", file=sys.stderr)
        return text_result("Error listing the tree", is_error=True)


def _tool_recent_docs(args, ctx):
    days = clamp_int(args.get("days"), 7, 1)
    limit = clamp_int(args.get("limit"), 20, 1, 100)
    return json_result({"days": days, "documents": _api_recent(days, limit, ctx)})


def _create_doc_impl(rel, content, ai, ctx, subject=None):
    """Write + ACL-stamp + commit a new doc. The shared core of create_doc and
    create_inbox_item (the inbox guard lives in the public create_doc wrapper, not here).
    `subject` overrides the commit subject: create_inbox_item passes a `received:` verb so the
    activity feed reads "a reçu" — the item is staged, not yet a doc in the mind."""
    target = _s._validate_doc_path(rel)
    if not target:
        return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
    rel = posixpath.normpath(rel)  # canonical ACL key (matches effective_level)
    if _s._is_readonly_path(rel):
        return text_result("Read-only location (remote node mirror) — choose another path.", is_error=True)
    if ctx is not None and not _s.can_create(rel, ctx):
        return text_result("Insufficient permission to create at this location.", is_error=True)
    if target.exists():
        return text_result(f"Document already exists: {rel} (create never overwrites: "
                           "use edit_doc to change it)", is_error=True)
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
    _s.commit_change(ctx, subject or f"created: {target.stem}", target, ai=ai)
    return text_result(f"Document created: {rel} (version {_version(target.read_text(encoding='utf-8'))})")


def _tool_create_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    # The inbox is managed (per-person, owned lanes): it must be filled via create_inbox_item,
    # never planted directly here. A direct create under inbox/ would stamp NO owner (api =>
    # commons), leaving the item readable by every authenticated user via the activity feed.
    if posixpath.normpath(rel).split("/")[0] == "inbox":
        return text_result("The inbox is managed: use create_inbox_item, not create_doc, to drop "
                           "an item there.", is_error=True)
    return _create_doc_impl(rel, args.get("content", ""), args.get("ai"), ctx)


def _inbox_dupe(user, dk):
    """First non-trashed item in inbox/<user>/ already carrying this dedupe_key, or None. Best-effort
    (a scan failure must never block a drop): honours the idempotency the tool promises agents, so a
    re-run with the same key returns the existing item instead of creating a duplicate."""
    try:
        base = _s.CONFIG.content_root / "inbox" / user
        if not base.is_dir():
            return None
        inbox_meta = _s._import_build()._inbox_meta
        for p in base.rglob("*.md"):
            try:
                m = inbox_meta(p.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError):
                continue
            if m.get("dedupe_key") == dk and m.get("inbox_status") != "trashed":
                return p.relative_to(_s.CONFIG.content_root).as_posix()
    except Exception:
        pass
    return None


def _tool_create_inbox_item(args, ctx):
    """Drop an item into your USER's inbox (the on-ramp to the mind).

    Multi-user: the item lands in inbox/<user>/<source>/ where <user> is the PERSON the token
    acts for (acts_as) and <source> is the token's own label. Both come from the token, never an
    argument, so an agent can neither pick another person's inbox nor impersonate another source.
    The owning person triages it later (Keep/Trash/Snooze); it stays sealed from the corpus
    (search/topology/contradictions) until kept. A token NOT bound to a person has no inbox.
    Reuses create_doc for path validation, ACL and the attributed commit.

    args: title (required), content, type?, confidence?, suggest_dest?, suggest_tags?, dedupe_key?.
    `type` is the optional KIND of item (note/task/idea/question/reference/alert…), used by the human
    to sort their inbox; it is normalized to a lowercase slug and defaults to "note" when absent."""
    title = (args.get("title") or "").strip()
    if not title:
        return text_result("'title' is required", is_error=True)
    content = args.get("content", "")
    if not isinstance(content, str):
        return text_result("'content' must be a string", is_error=True)
    # The owning person = the acts_as principal. An unbound API token carries only its own
    # <slug>@<hash>.api.local identity (no person), so it has no inbox.
    owner = getattr(ctx, "primary", None)
    email = owner[5:] if owner and owner.startswith("user:") else ""
    domain = email.rsplit("@", 1)[-1] if "@" in email else ""
    is_token_identity = domain == "api.local" or domain.endswith(".api.local")  # not a real person
    if ctx is not None and ctx.api and (not email or is_token_identity):
        return text_result("This token is not bound to a person, so it has no inbox. Create it "
                           "with `atlas token create --acts-as <email>`.", is_error=True)
    try:
        user = slugify_token_label(email) if email else "shared"
    except ValueError:
        user = "shared"
    source = getattr(ctx, "source", None) or "manual"
    try:
        source = slugify_token_label(source)
    except ValueError:
        source = "agent"
    # Human title -> a readable filename slug: fold accents (idée -> idee) and cut on a word
    # boundary. slugify_token_label is for ASCII token identities and would mangle accents into
    # dashes and truncate mid-word, leaking an ugly "id-e-...-d-mo" stem into the activity feed.
    slug = slugify_title(title)
    # Optional item KIND (what the human sorts on), NOT the source. Free vocabulary, normalized to a
    # lowercase slug; anything empty/unusable falls back to "note" so an item always carries a type.
    raw_type = args.get("type")
    try:
        item_type = slugify_token_label(raw_type) if isinstance(raw_type, str) and raw_type.strip() else "note"
    except ValueError:
        item_type = "note"
    try:
        conf = max(0.0, min(1.0, float(args.get("confidence"))))
    except (TypeError, ValueError):
        conf = 0.5
    lines = ["---", "origin: inbox", f"source: {source}", f"type: {item_type}",
             f"captured_at: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
             f"confidence: {conf}"]
    dest = (args.get("suggest_dest") or "").strip()
    if dest:
        lines.append(f"suggest_dest: {dest}")
    tags = args.get("suggest_tags")
    if isinstance(tags, list):
        clean = [str(t).strip() for t in tags if str(t).strip()]
        if clean:
            lines.append("suggest_tags: [" + ", ".join(clean) + "]")
    dk = (args.get("dedupe_key") or "").strip()
    if dk:
        existing = _inbox_dupe(user, dk)  # idempotent: a re-run with the same key returns the existing item
        if existing:
            return text_result(f"Already in your inbox (dedupe_key match): {existing}")
        lines.append(f"dedupe_key: {dk}")
    lines.append("inbox_status: pending")
    # No date in the filename: the capture instant already lives in `captured_at` + the git log,
    # and the date prefix only made the staging stem (and the activity feed) noisier. Collisions
    # fall back to a -N suffix.
    folder = f"inbox/{user}"
    rel = f"{folder}/{source}/{slug}.md"
    n = 2
    while (_s.CONFIG.content_root / rel).exists():
        rel = f"{folder}/{source}/{slug}-{n}.md"
        n += 1
    # Pre-compute same-subject neighbors at ingestion and freeze them in the frontmatter, so triage
    # reads them without re-scanning the corpus. Best-effort: never fail the drop on a scan error.
    try:
        rels = [nb["rel"] for nb in _s.find_doc_neighbors(rel, f"# {title}\n{content}", ctx, top=3)]
        if rels:
            lines.append("neighbors: [" + ", ".join(rels) + "]")
    except Exception as e:
        print(f"[create_inbox_item neighbors] {e}", file=sys.stderr)
    lines += ["---", "", f"# {title}", "", content]
    # Fail-closed multi-user privacy: own the person's lane BEFORE writing the item, so it is
    # never even momentarily commons (no race window), and ABORT if the ACL cannot be set (never
    # an unprotected drop). set_owner is idempotent and keeps grants, so re-running per drop is safe.
    if email:
        try:
            _s.get_store().set_owner(folder, owner)  # "user:<email>" -> lane private to that person
        except Exception as e:
            print(f"[create_inbox_item owner] {e}", file=sys.stderr)
            return text_result("Could not secure your inbox lane; nothing was created.", is_error=True)
    return _create_doc_impl(rel, "\n".join(lines), args.get("ai"), ctx, subject=f"received: {slug}")


def _tool_edit_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target:
        return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
    if _s._is_readonly_path(rel):
        return text_result("Read-only document (remote node mirror). Use \"Appropriate\" to make an editable copy.", is_error=True)
    if not target.exists() or not _visible(rel, ctx):
        return _not_found(rel, ctx, " (use create_doc to create a new one)")
    if ctx is not None and not _s.can_write(rel, ctx, "edit"):
        return text_result("Insufficient permission (need edit on this document).", is_error=True)
    current = target.read_text(encoding="utf-8")
    base = (args.get("base_version") or "").strip()
    if base and base != _version(current):
        return text_result(f"{rel} changed since you read it (now version {_version(current)}, "
                           f"you edited {base}): read_doc it again and redo the edit on the "
                           "current text.", is_error=True)
    old_string = args.get("old_string")
    new_string = args.get("new_string")
    content = args.get("content")
    # Patch mode: targeted replacement, takes priority over full rewrite.
    if old_string is not None:
        if not isinstance(old_string, str) or not isinstance(new_string, str):
            return text_result("'old_string' and 'new_string' must be strings", is_error=True)
        if old_string == "":
            return text_result("'old_string' cannot be empty", is_error=True)
        count = current.count(old_string)
        if count == 0:
            return text_result("'old_string' not found in the document."
                               + _closest_passage(current, old_string), is_error=True)
        if count > 1:
            where = ", ".join(map(str, _occurrence_lines(current, old_string)))
            return text_result(f"'old_string' appears {count} times (lines {where}): it must be "
                               "unique. Add surrounding context to make it unique.", is_error=True)
        new, done = current.replace(old_string, new_string, 1), "Document edited (targeted replacement)"
    elif content is not None:
        if not isinstance(content, str):
            return text_result("'content' must be a string", is_error=True)
        new, done = content, "Document rewritten"
    else:
        return text_result("Provide either 'old_string'+'new_string' (patch) or 'content' (rewrite)", is_error=True)
    if new == current:
        return text_result(f"No change: {rel} already reads like that (version {_version(current)}).")
    if args.get("dry_run"):
        return text_result(f"Dry run, nothing written. {rel} would change like this:\n"
                           + _diff(current, new))
    target.write_text(new, encoding="utf-8")
    subject = _s._clean_subject(args.get("commit_message")) or f"edited: {target.stem}"
    _s.commit_change(ctx, subject, target, ai=args.get("ai"))
    # Versioned as read_doc will read it back (newlines normalized).
    now = target.read_text(encoding="utf-8")
    return text_result(f"{done}: {rel} (now version {_version(now)})\n" + _diff(current, now))


def _tool_move_doc(args, ctx):
    src_rel = (args.get("from") or "").strip()
    dst_rel = (args.get("to") or "").strip()
    if not src_rel or not dst_rel:
        return text_result("'from' and 'to' are required", is_error=True)
    if _s._is_readonly_path(src_rel) or _s._is_readonly_path(dst_rel):
        return text_result("Read-only location (remote node mirror) — \"Appropriate\" it first to get an editable copy.", is_error=True)
    if ctx is not None and not _visible(src_rel, ctx):
        return _not_found(src_rel, ctx)
    if ctx is not None and not _s.can_write(src_rel, ctx, "owner"):
        return text_result("Insufficient permission (need owner to move this document).", is_error=True)
    # Gate the DESTINATION too: you can't plant a doc into a space you can't
    # see (e.g. another user's private folder). Mirrors create_doc's check.
    if ctx is not None and not _s.can_create(dst_rel, ctx):
        return text_result("Insufficient permission to move to this destination.", is_error=True)
    src_rel = _s._canonical_rel(src_rel)  # match the on-disk ACL key
    dry_run = bool(args.get("dry_run"))
    status, payload = _s._move_md_with_relink(src_rel, dst_rel, dry_run)
    if status == "not_found":
        return _not_found(src_rel, ctx)
    if status != "ok":
        return text_result(payload, is_error=True)
    rewrites = payload["rewrites"]
    relinked = ", ".join(f"{r['path']} ({r['count']})" for r in rewrites[:20])
    if dry_run:
        return text_result(f"Dry run, nothing moved. {payload['from']} -> {payload['to']} would "
                           + (f"rewrite {payload['links_updated']} incoming wikilink(s) in: {relinked}."
                              if rewrites else "need no wikilink fix."))
    # Repoint the ACL + shares BEFORE the git sync (privacy travels with the doc).
    _s._repoint_doc(payload["from"], payload["to"])
    touched = [payload["from"], payload["to"], *(r["path"] for r in rewrites)]
    subject = (f"moved: {posixpath.splitext(payload['from'])[0]}"
               f" → {posixpath.splitext(payload['to'])[0]}")
    _s.commit_change(ctx, subject,
                     *(_s.CONFIG.content_root / p for p in touched), ai=args.get("ai"))
    msg = f"Moved: {payload['from']} -> {payload['to']}."
    msg += (f" {payload['links_updated']} incoming wikilink(s) rewritten in: {relinked}."
            if rewrites else " No incoming wikilink to fix.")
    return text_result(msg)


def _tool_get_links(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target or not target.exists() or not _visible(rel, ctx):
        return _not_found(rel, ctx)
    entry = _links_graph(ctx).get(rel) or {"out": [], "in": []}
    return json_result({"path": rel, "links": [p for p in entry["out"] if _visible(p, ctx)]})


def _tool_get_backlinks(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target or not target.exists() or not _visible(rel, ctx):
        return _not_found(rel, ctx)
    entry = _links_graph(ctx).get(rel) or {"out": [], "in": []}
    return json_result({"path": rel, "backlinks": [p for p in entry["in"] if _visible(p, ctx)]})


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
    return json_result(payload)


def _tool_list_by_tag(args, ctx):
    tag = (args.get("tag") or "").strip().lower()
    if not tag:
        return text_result("Error: missing 'tag' parameter", is_error=True)
    build = _s._import_build()
    matches = sorted(rel for rel, _, text in _doc_corpus(ctx)
                     if tag in _tags_for(build, rel, text))
    return json_result({"tag": tag, "documents": matches})


def _tool_delete_doc(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if not target:
        return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
    if _s._is_readonly_path(rel):
        return text_result("Read-only location (remote node mirror) — cannot delete.", is_error=True)
    if not target.exists() or not _visible(rel, ctx):
        return _not_found(rel, ctx)
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
    _s.commit_change(ctx, f"deleted: {target.stem}", target, _s.CONFIG.content_root / trashed,
                     ai=args.get("ai"))
    return text_result(f"Document moved to trash (reversible): {rel} -> {trashed}")


def _tool_doc_history(args, ctx):
    rel = (args.get("path") or "").strip()
    if _s._validate_doc_path(rel) is None:
        return text_result(f"Invalid path (relative .md or .html, no '..'): {rel}", is_error=True)
    if not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
    limit = clamp_int(args.get("limit"), 30, 1, 100)
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
    return json_result({"path": rel, "created": created,
                        "last_modified": last_modified, "revisions": revisions})


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
    return text_result(header + "\n\n" + provenance.fence(content, rel))


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
    return text_result(header + "\n\n" + provenance.fence(body, rel))


def _tool_search_history(args, ctx):
    query = (args.get("query") or "").strip()
    if not query:
        return text_result("Error: missing 'query' parameter", is_error=True)
    regex = bool(args.get("regex"))
    prefix = _safe_path_prefix(args.get("path_prefix") or "")
    if prefix is None:
        return text_result("Invalid 'path_prefix'", is_error=True)
    limit = clamp_int(args.get("limit"), 20, 1, 50)
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
    return json_result({"query": query, "regex": regex, "matches": commits})


def _tool_changelog(args, ctx):
    days = clamp_int(args.get("days"), 14, 1, 365)
    limit = clamp_int(args.get("limit"), 50, 1, 200)
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
    return json_result({"since_days": days, "commits": commits})


def _tool_activity(args, ctx):
    days = clamp_int(args.get("days"), 14, 1, 365)
    limit = clamp_int(args.get("limit"), 50, 1, 200)
    author = (args.get("author") or "").strip() or None
    type_filter = (args.get("type") or "").strip() or None
    events = _activity_events(days, limit, author, type_filter, ctx)
    if events is None:
        return text_result("git log failed", is_error=True)
    return json_result({"since_days": days, "events": events})


def _tool_stale(args, ctx):
    months = clamp_int(args.get("months"), _STALE_MONTHS, 1, 24)
    limit = clamp_int(args.get("limit"), 30, 1, 100)
    return json_result({"months": months, "stale": _api_stale(months, limit, ctx)})


def _tool_contradictions(args, ctx):
    limit = clamp_int(args.get("limit"), 15, 1, 50)
    items = contradictions.find_contradictions(ctx, limit, bool(args.get("include_dismissed")))
    for c in items:  # a pair quotes both docs (values, evidence lines)
        for side in ("a", "b"):
            if source := provenance.origin(c[side]):
                c[side + "_untrusted"] = source
    return json_result({"candidates": items})


def _span_hash(text: str, line: int) -> str:
    """Content hash of a 1-based line, to bind a verdict to the judged span (empty if out of range)."""
    rows = text.splitlines()
    return _s.doc_hash(rows[line - 1].strip()) if 1 <= line <= len(rows) else ""


def _tool_judge_contradiction(args, ctx):
    """Record a verdict on a candidate pair (13c feedback loop): real | none. 'none' clears a
    false positive so it stops resurfacing. The verdict holds until either doc is edited (it
    is content-hash bound). Writes the cache and commits it. 'contenu périmé' is NOT a verdict
    here — that is the stale tool's axis; this only judges whether the two docs conflict."""
    a = (args.get("a") or "").strip()
    b = (args.get("b") or "").strip()
    verdict = (args.get("verdict") or "").strip()
    if verdict not in _s.VERDICTS:
        return text_result(f"verdict must be one of {list(_s.VERDICTS)}", is_error=True)
    ta, tb = _s._validate_doc_path(a), _s._validate_doc_path(b)
    if ta is None or tb is None or (a == b and clamp_int(args.get("a_line"), 0, 0) == clamp_int(args.get("b_line"), 0, 0)):
        return text_result("invalid pair (need two distinct docs, or one doc with distinct lines)", is_error=True)
    if not (ta.exists() and tb.exists() and _visible(a, ctx) and _visible(b, ctx)):
        return text_result("one or both docs not found / not visible", is_error=True)
    try:
        ta_text = ta.read_text(encoding="utf-8-sig")
        tb_text = tb.read_text(encoding="utf-8-sig")
    except OSError:
        return text_result("doc unreadable", is_error=True)
    ha, hb = _s.doc_hash(ta_text), _s.doc_hash(tb_text)
    sa = _span_hash(ta_text, clamp_int(args.get("a_line"), 0, 0))
    sb = _span_hash(tb_text, clamp_int(args.get("b_line"), 0, 0))
    path = _s.set_verdict(a, b, verdict, ha, hb, (args.get("ai") or "ai"),
                          args.get("note") or "", a_span=sa, b_span=sb)
    _s.commit_change(ctx, f"contradiction {verdict}: {ta.stem} ⇄ {tb.stem}", path, ai=args.get("ai"))
    return text_result(f"Recorded verdict '{verdict}' for {a} ⇄ {b}. "
                       "It holds until either doc is edited.")


def _tool_doc_blame(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if target is None:
        return text_result(f"Invalid path: {rel}", is_error=True)
    if not target.exists() or not _visible(rel, ctx):
        return _not_found(rel, ctx)
    pattern = (args.get("pattern") or "").strip()
    start = clamp_int(args.get("start"), 0, 0)
    end = clamp_int(args.get("end"), 0, 0)
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
    return json_result({"path": rel, **provenance.mark(rel), "truncated": truncated, "lines": lines})


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
    short = _s.git("rev-parse", "--short", rev).stdout.strip() or rev[:8]
    _s.commit_change(ctx, f"reverted: {target.stem} @ {short}", target, ai=args.get("ai"))
    return text_result(f"Reverted {rel} to revision {rev[:8]} "
                       "(written as a forward-moving change; the prior version stays in history).")


_BRIEF_DOCS = 6
_BRIEF_MIN_ROOM = 200  # characters: below this, a further source would be a stub


def _enclosing_section(lines: list, line: int):
    """1-based (start, end) of the innermost section holding `line`, or a window around
    it when no heading precedes it."""
    heads = list(_headings(lines))
    above = [k for k, (i, _, _) in enumerate(heads) if i < line]
    if not above:
        return max(1, line - 10), min(len(lines), line + 20)
    k = above[-1]
    i, level, _ = heads[k]
    end = next((j for j, lv, _ in heads[k + 1:] if lv <= level), len(lines))
    return i + 1, end


def _tool_brief(args, ctx):
    """A context pack on a topic in one call: the best-matching section of each relevant
    doc, best first, within a token budget, with the trust signals of search_docs and the
    docs linked around the top ones."""
    topic = (args.get("topic") or "").strip()
    if not topic:
        return text_result("Error: missing 'topic' parameter", is_error=True)
    budget = clamp_int(args.get("budget_tokens"), 2000, 300, 8000)
    hits = _api_search(topic, _BRIEF_DOCS, ctx)
    _add_trust_signals(hits, ctx)
    room = budget * 4  # characters, at ~4 per token
    sources, omitted = [], []
    for h in hits:
        if room < _BRIEF_MIN_ROOM:
            omitted.append(h["path"])
            continue
        source = {k: h[k] for k in ("path", "untrusted", "section", "last_modified",
                                    "last_editor", "ai", "stale", "contested_with") if k in h}
        if "line" in h:
            try:
                lines = (_s.CONFIG.content_root / h["path"]).read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            start, end = _enclosing_section(lines, h["line"])
            source["lines"] = f"{start}-{end}"
            text = "\n".join(lines[start - 1:end]).strip()
        else:  # .html: indexed as extracted text, so only its snippet maps back
            text = h["snippet"]
        share = max(_BRIEF_MIN_ROOM * 2, room // 2)  # the best source may take half the room
        if len(text) > share:
            text = text[:share].rsplit("\n", 1)[0] + "\n…"
        source["text"] = text
        room -= len(text)
        sources.append(source)
    graph = _links_graph(ctx)
    seen = {h["path"] for h in hits}
    related = []
    for s in sources[:3]:
        entry = graph.get(s["path"]) or {"out": [], "in": []}
        for p in entry["out"] + entry["in"]:
            if p not in seen and _visible(p, ctx):
                seen.add(p)
                related.append(p)
    return json_result({"topic": topic, "budget_tokens": budget, "sources": sources,
                        "related": related[:8], "omitted": omitted})


def _doc_changes(commits: list) -> list:
    """Net effect per doc of `commits` (newest first, as git log lists them): added,
    modified, moved (from its original path) or deleted, with the last edit's date, editor
    and AI, and how many commits touched it. A doc added then deleted cancels out."""
    docs = {}
    for c in reversed(commits):
        for f in c["files"]:
            path, status = f["path"], f["status"]
            if status == "R":
                entry = docs.pop(f["old_path"], None) or {"change": "moved", "from": f["old_path"]}
                if entry["change"] == "modified":
                    entry = {**entry, "change": "moved", "from": f["old_path"]}
            elif status == "D":
                entry = docs.pop(path, None) or {}
                if entry.get("change") == "added":
                    continue
                entry = {**entry, "change": "deleted"}
            else:
                entry = docs.pop(path, None) or {"change": "added" if status in ("A", "C") else "modified"}
            entry["commits"] = entry.get("commits", 0) + 1
            entry.update(date=c["date"], last_editor=c["author"])
            entry.pop("ai", None)
            if c.get("ai"):
                entry["ai"] = c["ai"]
            docs[path] = entry
    return [{"path": p, **e} for p, e in sorted(docs.items(), key=lambda d: d[1]["date"], reverse=True)]


def _tool_changes_since(args, ctx):
    cursor = (args.get("cursor") or "").strip()
    head = _s.git("rev-parse", "HEAD").stdout.strip()
    if cursor:
        if not (_s._valid_git_rev(cursor)
                and _s.git("merge-base", "--is-ancestor", cursor, "HEAD").returncode == 0):
            return text_result("Unknown cursor (not from this mind, or its history was rewritten): "
                               "call changes_since without one to get a fresh cursor.", is_error=True)
        commits, since = _attributed_log(f"{cursor}..HEAD"), cursor
    else:
        days = clamp_int(args.get("days"), 7, 1, 365)
        commits, since = _attributed_log(f"--since={days}.days.ago"), f"{days} days"
    if commits is None:
        return text_result("git log failed", is_error=True)
    limit = clamp_int(args.get("limit"), 50, 1, 200)
    docs = _doc_changes(_scrub_commits(commits, ctx))
    return json_result({"cursor": head, "since": since, "documents": docs[:limit],
                        "truncated": len(docs) > limit})


_RUN_GAP_SECONDS = 30 * 60  # an agent silent this long has finished its run
_RUN_WINDOW_DAYS = 30       # runs are computed over this window, so their ids stay stable


def _agent_runs() -> list:
    """AI commits grouped into runs: consecutive commits by one agent (AI family + token +
    the person it acts for) with no silence over _RUN_GAP_SECONDS. Newest first, each with
    its commits newest first. Not ACL-scrubbed: callers filter for their ctx."""
    runs, open_runs = [], {}
    for c in reversed(_attributed_log(f"--since={_RUN_WINDOW_DAYS}.days.ago") or []):
        if not c.get("ai"):
            continue
        key = (c["email"], c["ai"], c["token"])
        ts = datetime.datetime.fromisoformat(c["date"]).timestamp()
        run = open_runs.get(key)
        if run is None or ts - run["end_ts"] > _RUN_GAP_SECONDS:
            run = open_runs[key] = {"commits": []}
            runs.append(run)
        run["commits"].insert(0, c)
        run["end_ts"] = ts
    for run in runs:
        first, last = run["commits"][-1], run["commits"][0]
        run.update(id=f"{first['sha'][:12]}-{last['sha'][:12]}", ai=last["ai"],
                   token=last["token"], author=last["author"], email=last["email"],
                   start=first["date"], end=last["date"])
    return runs[::-1]


def _tool_agent_runs(args, ctx):
    days = clamp_int(args.get("days"), 7, 1, _RUN_WINDOW_DAYS)
    limit = clamp_int(args.get("limit"), 20, 1, 100)
    cutoff = time.time() - days * 86400
    out = []
    for run in _agent_runs():
        docs = _doc_changes(_scrub_commits(run["commits"], ctx))
        if run["end_ts"] >= cutoff and docs:
            out.append({k: run[k] for k in ("id", "ai", "token", "author", "start", "end")}
                       | {"commits": len(run["commits"]), "documents": docs})
    return json_result({"days": days, "runs": out[:limit]})


def _may_undo(run: dict, ctx) -> bool:
    """The person the agent acted for may undo its run; an admin too, but only when they
    can see every doc it touched (never blind changes inside someone's private space)."""
    if ctx is None or ctx.superuser or ctx.primary == "user:" + run["email"]:
        return True
    if not ctx.is_admin:
        return False
    visible = _scrub_commits(run["commits"], ctx)
    return sum(len(c["files"]) for c in visible) == sum(len(c["files"]) for c in run["commits"])


def _tool_undo_run(args, ctx):
    run_id = (args.get("run") or "").strip()
    run = next((r for r in _agent_runs() if r["id"] == run_id), None)
    if run is None:
        return text_result(f"No agent run '{run_id}' in the last {_RUN_WINDOW_DAYS} days: list them "
                           "with agent_runs (a run's id changes while the agent keeps going).",
                           is_error=True)
    if not _may_undo(run, ctx):
        return text_result("Only the person this agent acted for, or an admin who can see every "
                           "doc it touched, can undo its run.", is_error=True)
    docs = _doc_changes(run["commits"])
    summary = ", ".join(f"{d['path']} ({d['change']})" for d in docs[:20])
    shas = [c["sha"] for c in run["commits"]]
    if args.get("dry_run"):
        return text_result(f"Dry run, nothing undone. Run {run_id} ({len(shas)} commit(s) by "
                           f"{run['ai']}) would be reverted for: {summary}.")
    # Docs the revert moves back (incl. out of .trash/) take their ACL along BEFORE git
    # writes them, so none is ever readable as commons at its restored path. Only the run's
    # own docs: the range also spans other people's commits made in between.
    touched = {p for c in run["commits"] for f in c["files"] for p in (f["path"], f.get("old_path"))}
    moves = [(old, new) for status, old, new in _name_status(shas[0], shas[-1] + "^")
             if status == "R" and (old in touched or new in touched)]
    for frm, to in moves:
        _s._repoint_doc(frm, to)
    sha, why = _s.revert_commits(ctx, f"undid: {run['ai']} run of {len(shas)} change(s)", shas,
                                 ai=args.get("ai"))
    if sha is None:
        for frm, to in reversed(moves):
            _s._repoint_doc(to, frm)
        return text_result(f"Could not undo run {run_id} cleanly ({why}): a later change touches "
                           "the same lines. Nothing was changed; restore docs one by one with "
                           "doc_revert instead.", is_error=True)
    store = _s.get_store()
    for status, path, _ in _name_status(sha + "^", sha):
        if status == "D":  # a doc the run created: drop its ACL and share links with it
            store.delete_acl(path)
            store.delete_shares_for_path(path)
    return text_result(f"Undid run {run_id} in one commit ({sha[:8]}): {summary}. Nothing is lost: "
                       "doc_history / doc_revert bring any of it back.")


# name → handler. _mcp_call_tool looks the tool up here; an unknown name 404s below.
_TOOLS = {
    "search_docs": _tool_search_docs,
    "grep_docs": _tool_grep_docs,
    "read_doc": _tool_read_doc,
    "list_tree": _tool_list_tree,
    "recent_docs": _tool_recent_docs,
    "create_doc": _tool_create_doc,
    "create_inbox_item": _tool_create_inbox_item,
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
    "activity": _tool_activity,
    "stale": _tool_stale,
    "contradictions": _tool_contradictions,
    "judge_contradiction": _tool_judge_contradiction,
    "doc_blame": _tool_doc_blame,
    "doc_revert": _tool_doc_revert,
    "brief": _tool_brief,
    "changes_since": _tool_changes_since,
    "agent_runs": _tool_agent_runs,
    "undo_run": _tool_undo_run,
}


def _tool_scope(tool: dict) -> str:
    """The scope a tool needs: read for the read-only ones, inbox for the inbox drop (so a
    triage agent can stage items without writing the mind), write for the rest."""
    if tool["name"] == "create_inbox_item":
        return "inbox"
    return "read" if tool.get("annotations", {}).get("readOnlyHint") else "write"


def _needed_scope(name: str):
    """The scope tool `name` needs, or None for an unknown tool."""
    tool = next((t for t in _s._mcp_tools() if t["name"] == name), None)
    return _tool_scope(tool) if tool else None


def _allowed_tools(ctx) -> list:
    """The tools ctx's token may call: a scoped token never even sees the others."""
    scopes = getattr(ctx, "scopes", None)
    tools = _s._mcp_tools()
    return tools if scopes is None else [t for t in tools if _tool_scope(t) in scopes]


def _mcp_call_tool(name: str, args: dict, ctx=None) -> dict:
    """Dispatch an MCP tool to its handler. Returns MCP CallToolResult."""
    fn = _TOOLS.get(name)
    if fn is None:
        return text_result(f"Unknown tool: {name}", is_error=True)
    if not any(t["name"] == name for t in _allowed_tools(ctx)):
        return text_result(f"This token is limited to {', '.join(sorted(ctx.scopes))}: {name} "
                           "is outside its scopes.", is_error=True)
    return fn(args, ctx)


# 2026-07-28 _meta keys, and the error codes it reserves for the protocol.
_META_VERSION = "io.modelcontextprotocol/protocolVersion"
_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"
_HEADER_MISMATCH = -32020
_UNSUPPORTED_VERSION = -32022
_CAPABILITIES = {"tools": {}, "prompts": {}, "resources": {}}
_TTL_MS = 3_600_000
_MIND_TTL_MS = 60_000  # documents and the mind's prompts are edited from the viewer
# Clients inject the instructions into every conversation: keep them a primer, not a manual.
_INSTRUCTIONS_MAX = 8000
_DEFAULT_INSTRUCTIONS = (
    "This is the user's Atlas Mind: a git-versioned knowledge base they share with you. "
    "Treat it as the source of truth: before answering on a topic it may cover, use "
    "search_docs and read_doc instead of guessing. Write durable output (decisions, recaps, "
    "analyses) back with create_doc or edit_doc; use create_inbox_item instead when the "
    "human should triage it first. On first contact, get_mind_topology or list_tree shows "
    "how the mind is organised. Paths are relative to the mind (e.g. notes/example.md)."
)


def _instructions() -> str:
    """The mind's AGENTS.md (its owner's rules for AIs), else a built-in primer; then the
    engine's rule on text from outside the mind, which an AGENTS.md cannot leave out."""
    room = _INSTRUCTIONS_MAX - len(provenance.RULE) - 2
    try:
        text = (_s.CONFIG.root / "AGENTS.md").read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeDecodeError):
        text = ""
    if len(text) > room:
        text = text[:room].rsplit("\n", 1)[0]
    return (text or _DEFAULT_INSTRUCTIONS) + "\n\n" + provenance.RULE


@functools.cache
def _server_info() -> dict:
    return {"name": _s.CONFIG.site_slug, "version": _s.current_version() or "unknown"}


def _modern(result: dict, cache_scope: str | None = None, ttl_ms: int = _TTL_MS) -> dict:
    """Stamp a result the 2026-07-28 way; list/discover results also carry caching hints."""
    result = {**result, "resultType": "complete",
              "_meta": {_META_SERVER_INFO: _server_info()}}
    if cache_scope:
        result.update(ttlMs=ttl_ms, cacheScope=cache_scope)
    return result


def _request_version(req) -> str | None:
    """Version a modern (2026-07-28+) request declares in its _meta; None means legacy."""
    params = req.get("params") if isinstance(req, dict) else None
    meta = params.get("_meta") if isinstance(params, dict) else None
    return meta.get(_META_VERSION) if isinstance(meta, dict) else None


def _header_value(raw):
    """A mirrored header value, with the spec's =?base64?…?= sentinel decoded."""
    if raw and raw.startswith("=?base64?") and raw.endswith("?="):
        try:
            return base64.b64decode(raw[9:-2], validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    return raw


def _header_mismatch(req: dict, headers) -> str | None:
    """Why the mirrored HTTP headers disagree with the body, or None. Checked so a proxy
    routing on the headers can't be handed a different body."""
    expected = {"MCP-Protocol-Version": _request_version(req), "Mcp-Method": req.get("method")}
    params = req.get("params") or {}
    if req.get("method") in ("tools/call", "prompts/get"):
        expected["Mcp-Name"] = params.get("name")
    elif req.get("method") == "resources/read":
        expected["Mcp-Name"] = params.get("uri")
    for name, want in expected.items():
        got = _header_value(headers.get(name))
        if got != want:
            return f"{name} header {got!r} does not match the body ({want!r})"
    return None


def _mcp_http_status(req, response: dict) -> int:
    """2026-07-28 mirrors protocol errors into the HTTP status; legacy answers stay 200."""
    code = (response.get("error") or {}).get("code")
    if code in (_HEADER_MISMATCH, _UNSUPPORTED_VERSION):
        return 400
    if code == -32601 and _request_version(req) is not None:
        return 404
    return 200


def _mcp_jsonrpc(req: dict, ctx=None, headers=None):
    """Process an MCP JSON-RPC message. Returns response dict, or None for notifications.

    Dual-era: a request declaring its version in _meta is served statelessly per
    2026-07-28; anything else gets the legacy, initialize-based behavior."""
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

    def err(code, message, data=None):
        error = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {"jsonrpc": "2.0", "id": req_id, "error": error}

    version = _request_version(req)
    supported = [*_s.MCP_MODERN_VERSIONS, *_s.MCP_LEGACY_VERSIONS]
    try:
        if version is not None:
            if version not in _s.MCP_MODERN_VERSIONS:
                return err(_UNSUPPORTED_VERSION, "Unsupported protocol version",
                           {"supported": supported, "requested": version})
            mismatch = headers is not None and _header_mismatch(req, headers)
            if mismatch:
                return err(_HEADER_MISMATCH, f"Header mismatch: {mismatch}")
        if method == "server/discover":
            # Private: the instructions are this mind's own AGENTS.md.
            return ok(_modern({
                "supportedVersions": supported,
                "capabilities": _CAPABILITIES,
                "instructions": _instructions(),
            }, "private"))
        if method == "tools/list":
            # Private: a scoped token gets a narrower list.
            result = {"tools": _allowed_tools(ctx)}
            return ok(_modern(result, "private") if version else result)
        if method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments") or {}
            sys.stderr.write(f"[mcp] tools/call name={tool_name}\n")
            sys.stderr.flush()
            result = _mcp_call_tool(tool_name, arguments, ctx)
            return ok(_modern(result) if version else result)
        # Prompts and resources read the mind: a token without the read scope gets none.
        readable = getattr(ctx, "scopes", None) is None or "read" in ctx.scopes
        if method in ("prompts/list", "prompts/get"):
            from server.pure import prompts  # lazy: prompts reuses this module's helpers
            if method == "prompts/list":
                result = {"prompts": prompts.list_prompts(ctx) if readable else []}
                return ok(_modern(result, "private", _MIND_TTL_MS) if version else result)
            if not readable:
                return err(-32602, "this token has no read scope")
            try:
                result = prompts.get_prompt(params.get("name", ""), params.get("arguments"), ctx)
            except prompts.PromptError as e:
                return err(-32602, str(e))
            return ok(_modern(result) if version else result)
        if method == "resources/list":
            result = (resources.list_resources(ctx, str(params.get("cursor") or ""))
                      if readable else {"resources": []})
            return ok(_modern(result, "private", _MIND_TTL_MS) if version else result)
        if method == "resources/templates/list":
            result = {"resourceTemplates": [resources.TEMPLATE] if readable else []}
            return ok(_modern(result, "private", _MIND_TTL_MS) if version else result)
        if method == "resources/read":
            try:
                if not readable:
                    raise resources.ResourceError("this token has no read scope")
                result = resources.read_resource(params.get("uri", ""), ctx)
            except resources.ResourceError as e:
                # 2026-07-28 moved "resource not found" from -32002 to Invalid Params.
                return err(-32602 if version else -32002, str(e))
            return ok(_modern(result, "private", _MIND_TTL_MS) if version else result)
        if version is None:  # 2026-07-28 dropped the handshake and ping
            if method == "initialize":
                # Echo the client's revision when we serve it (claude.ai drops the session
                # if a revision it asked for is downgraded), else offer our newest one.
                asked = params.get("protocolVersion")
                return ok({
                    "protocolVersion": (asked if asked in _s.MCP_LEGACY_VERSIONS
                                        else _s.MCP_LEGACY_VERSIONS[0]),
                    "capabilities": _CAPABILITIES,
                    "serverInfo": _server_info(),
                    "instructions": _instructions(),
                })
            if method == "ping":
                return ok({})
        return err(-32601, f"method not found: {method}")
    except Exception as e:
        # Detail (may carry server paths) to stderr only; client gets a generic message.
        sys.stderr.write(f"[mcp] error in {method}: {e}\n")
        sys.stderr.flush()
        return err(-32603, "internal error")
