"""MCP tool dispatch (read-side queries live in pure/queries.py, git parsing in pure/git_history.py)."""
import json
import posixpath
import sys
from pathlib import Path

import server as _s
from server.pure.queries import (
    _visible, _doc_corpus, _links_graph, _tags_for, _api_search, _api_recent,
    _api_stale, _contradiction_candidates, _activity_events,
)
from server.pure.git_history import (
    _capped, _fmt_commit, _git_doc_records, _safe_path_prefix, _parse_namestatus_log,
    _scrub_commits, _doc_diff_between, _parse_blame, _EMPTY_TREE, _MAX_BLAME_LINES,
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
    days = clamp_int(args.get("days"), 7, 1)
    limit = clamp_int(args.get("limit"), 20, 1, 100)
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
    _s.commit_change(ctx, f"created: {target.stem}", target, ai=args.get("ai"))
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
    subject = _s._clean_subject(args.get("commit_message")) or f"edited: {target.stem}"
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
        _s.commit_change(ctx, subject, target, ai=args.get("ai"))
        return text_result(f"Document edited (targeted replacement): {rel}")
    if content is not None:
        if not isinstance(content, str):
            return text_result("'content' must be a string", is_error=True)
        target.write_text(content, encoding="utf-8")
        _s.commit_change(ctx, subject, target, ai=args.get("ai"))
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
    subject = (f"moved: {posixpath.splitext(payload['from'])[0]}"
               f" → {posixpath.splitext(payload['to'])[0]}")
    _s.commit_change(ctx, subject,
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
    if not commits:
        return text_result(f"No commit where '{query}' entered or left the history"
                           + (f" under {prefix}" if prefix else ""))
    return text_result(json.dumps({"query": query, "regex": regex, "matches": commits},
                                  ensure_ascii=False, indent=2))


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
    if not commits:
        return text_result(f"No document changes in the last {days} days"
                           + (f" under {prefix}" if prefix else ""))
    return text_result(json.dumps({"since_days": days, "commits": commits},
                                  ensure_ascii=False, indent=2))


def _tool_activity(args, ctx):
    days = clamp_int(args.get("days"), 14, 1, 365)
    limit = clamp_int(args.get("limit"), 50, 1, 200)
    author = (args.get("author") or "").strip() or None
    type_filter = (args.get("type") or "").strip() or None
    events = _activity_events(days, limit, author, type_filter, ctx)
    if events is None:
        return text_result("git log failed", is_error=True)
    if not events:
        return text_result(f"No activity in the last {days} days")
    return text_result(json.dumps({"since_days": days, "events": events},
                                  ensure_ascii=False, indent=2))


def _tool_stale(args, ctx):
    months = clamp_int(args.get("months"), 6, 1, 24)
    limit = clamp_int(args.get("limit"), 30, 1, 100)
    items = _api_stale(months, limit, ctx)
    if not items:
        return text_result(f"No document untouched for {months}+ months")
    return text_result(json.dumps({"months": months, "stale": items},
                                  ensure_ascii=False, indent=2))


def _tool_contradictions(args, ctx):
    limit = clamp_int(args.get("limit"), 15, 1, 50)
    items = _contradiction_candidates(ctx, limit)
    if not items:
        return text_result("No contradiction candidates (no docs share tags or links)")
    return text_result(json.dumps({"candidates": items}, ensure_ascii=False, indent=2))


def _tool_doc_blame(args, ctx):
    rel = (args.get("path") or "").strip()
    target = _s._validate_doc_path(rel)
    if target is None:
        return text_result(f"Invalid path: {rel}", is_error=True)
    if not target.exists() or not _visible(rel, ctx):
        return text_result(f"Document not found: {rel}", is_error=True)
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
    short = _s.git("rev-parse", "--short", rev).stdout.strip() or rev[:8]
    _s.commit_change(ctx, f"reverted: {target.stem} @ {short}", target, ai=args.get("ai"))
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
    "activity": _tool_activity,
    "stale": _tool_stale,
    "contradictions": _tool_contradictions,
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
