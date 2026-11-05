"""Document routes: file write/delete/move, the trash (list + restore), the notes
export, directory rename, revert, and the read-only git history / revision / diff
endpoints, plus tree + search.

All mutating routes are guarded ADMIN_CSRF (PUT/DELETE keep the guard at the verb
level, so the functions here are pure bodies); the read endpoints are AUTH.
"""
import posixpath
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath
from urllib.parse import quote

import server as _s
import store
from server.pure import docs, export
from server.pure.docs import move_file
from server.pure.queries import _touched_visible
from server.pure.uploads import clean_path
from server.render import share_page


def file_put(handler):
    """PUT /api/file — write a .md/.html doc (CSRF enforced at the verb level in
    do_PUT, per-document rights below). 409 when `base_content` no longer matches."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    content = data.get("content", "")
    if not rel or ".." in rel.split("/"):
        handler._send_json(400, {"error": "invalid path"})
        return
    rel = posixpath.normpath(rel)  # canonical ACL key (matches effective_level)
    if _s._is_readonly_path(rel):
        handler._send_json(403, {"error": "remote mirror is read-only"})
        return
    target = (_s.CONFIG.content_root / rel).resolve()
    try:
        target.relative_to(_s.CONFIG.content_root)
    except ValueError:
        handler._send_json(403, {"error": "outside root"})
        return
    if target.suffix.lower() not in (".md", ".html"):
        handler._send_json(400, {"error": "only .md or .html"})
        return
    ctx = handler._viewer_ctx()
    existed = target.exists()
    # Authorization (model B). Edit an existing doc → need `edit` (404 first if it is
    # not even readable: no-existence-oracle). Create a new one → must be allowed to
    # create here (commons is member-writable; a private space needs edit).
    if not ctx.superuser:
        if existed:
            if not _s.can_read(rel, ctx):
                handler._send_json(404, {"error": "not found"})
                return
            if not _s.can_write(rel, ctx, "edit"):
                handler._send_json(403, {"error": "insufficient permission (need edit on this document)"})
                return
        elif not _s.can_create(rel, ctx):
            handler._send_json(403, {"error": "insufficient permission to create at this location"})
            return
    # The editor sends the text it started from: if the doc moved on meanwhile (an AI
    # edit, another tab), refuse rather than silently overwrite it. read_text already
    # turns CRLF into LF, the browser's copy may not have.
    base = data.get("base_content")
    if existed and isinstance(base, str):
        current = target.read_text(encoding="utf-8")
        if base.replace("\r\n", "\n") != current:
            handler._send_json(409, {"error": "changed since it was opened", "current": current})
            return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    if not existed and ctx.primary:  # new doc → stamp creator + default visibility
        try:
            # Clean ACL slate first, so a path recycled after a delete can't inherit a
            # stale owner/grants. Then stamp creator + default visibility — the
            # `private` flag (New-Document toggle) overrides the default.
            _s.get_store().delete_acl(rel)
            _s._stamp_new_doc(rel, ctx, private=data.get("private"))
        except Exception as e:
            print(f"[file_put creator] {e}", file=sys.stderr)
    task = data.get("task")  # the viewer sends this on a checkbox toggle (04-toc-tasks.js)
    if not existed:
        subject = f"created: {target.stem}"
    elif isinstance(task, dict) and "checked" in task:
        label = _s._clean_subject(task.get("text") or "") or target.stem
        subject = f"{'checked' if task.get('checked') else 'unchecked'}: {label}"
    else:
        subject = f"edited: {target.stem}"
    _s.commit_change(ctx, subject, target)
    handler._send_json(200, {"ok": True, "mtime": int(target.stat().st_mtime)})


def _annotate_vis(node, store, principals=None):
    """Tag each FILE node with its sharing state for the tree badge,
    relative to the VIEWER: `private` (you own it, no grant), `shared` (you own it
    AND shared it out), `granted` (someone else owns it and shared it WITH you);
    commons → nothing. `principals` None (superuser/local) keeps the legacy
    owner-centric view. The access dialog shows the precise state."""
    now = int(time.time())
    for child in node.get("children", []):
        if child.get("type") == "file":
            entry = store.get_acl(child.get("path", ""))
            if entry and entry.get("owner"):
                if principals is None or entry["owner"] in principals:
                    child["vis"] = "shared" if entry.get("grants") else "private"
                elif any(g.get("principal") in principals
                         and not ((g.get("expires_at") or 0) and now > g["expires_at"])
                         for g in entry.get("grants", [])):
                    child["vis"] = "granted"   # shared WITH me by its owner (live grant)
        else:
            _annotate_vis(child, store, principals)


def tree(handler):
    """GET /api/tree — the navigable document tree, filtered per-viewer (auth),
    each file tagged with its sharing state (private/shared/commons)."""
    try:
        tree = _s._import_build().walk(_s.CONFIG.content_root)
        ctx = handler._viewer_ctx()
        keep = None if ctx.superuser else (lambda p: _s.can_read(p, ctx))
        tree = _s._filter_tree(tree, keep)
        _annotate_vis(tree, _s.get_store(),
                      None if ctx.superuser else ctx.principals)
        handler._send_json(200, tree)
    except Exception as e:
        _s.registry_503(handler, "[tree]", e)


def search(handler):
    """GET /api/search?q=&limit= — server-side search (transfers O(results),
    not O(corpus)); filtered per-viewer (auth)."""
    query = handler._query()
    q = (query.get("q", [""])[0] or "").strip()
    if not q:
        handler._send_json(200, [])
        return
    limit = _s.clamp_int(query.get("limit", [None])[0], 50, 1, 50)
    ctx = handler._viewer_ctx()
    results = _s._api_search(q, limit, None if ctx.superuser else ctx)
    handler._send_json(200, results)


def history(handler):
    """GET /api/history?path= — a doc's git revisions, following renames/moves
    (auth). Every doc is versioned in git: `git` runs at CONFIG.root (repo
    root) while ?path= is relative to content/, so the pathspec is prefixed
    with "content/". Always `--` before the pathspec; revisions are
    regex-checked."""
    rel = (handler._query().get("path", [""])[0] or "").strip()
    if _s._validate_doc_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    ctx = handler._viewer_ctx()  # ACL gate: an unreadable doc is "not found" (no-existence-oracle)
    if not ctx.superuser and not _s.can_read(rel, ctx):
        handler._send_json(404, {"error": "not found"})
        return
    repo_rel = "content/" + rel
    # --follow tracks renames/moves so pre-move commits still load (revision/diff/
    # revert resolve the path-at-revision via _doc_path_at). -z + \x1f keep
    # records/fields unambiguous; -n 100 bounds payload.
    fmt = "%H%x1f%an%x1f%aI%x1f%s%x1f%(trailers:key=X-Atlas-Author,valueonly)"
    result = _s.git("log", "--follow", "-n", "100", "--format=" + fmt, "-z",
                 "--", repo_rel)
    if result.returncode != 0:
        handler._send_json(500, {"error": result.stderr.strip() or "git log failed"})
        return
    revisions = []
    for record in result.stdout.split("\x00"):
        if not record:
            continue
        fields = (record.split("\x1f") + ["", "", "", "", ""])[:5]
        if not ctx.superuser and not _touched_visible(rel, fields[0], ctx):
            continue
        ai = _s.parse_ai_trailer(fields[4])  # X-Atlas-Author trailer → AI family (13d filter)
        revisions.append({
            "sha": fields[0], "author": fields[1],
            "date": fields[2], "subject": fields[3], "ai": ai,
        })
    handler._send_json(200, {"path": rel, "revisions": revisions})


def revision(handler):
    """GET /api/revision?path=&rev= — a doc's content at a past revision
    (auth)."""
    query = handler._query()
    rel = (query.get("path", [""])[0] or "").strip()
    rev = (query.get("rev", [""])[0] or "").strip()
    if _s._validate_doc_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    ctx = handler._viewer_ctx()  # ACL gate (no-existence-oracle)
    if not ctx.superuser and not _s.can_read(rel, ctx):
        handler._send_json(404, {"error": "not found"})
        return
    if not _s._valid_git_rev(rev):
        handler._send_json(400, {"error": "invalid rev"})
        return
    if not ctx.superuser and not _s.can_read_at(rel, rev, ctx):
        handler._send_json(404, {"error": "not found"})
        return
    result = _s.git("show", rev + ":" + _s._doc_path_at("content/" + rel, rev))
    if result.returncode != 0:
        handler._send_json(404, {"error": "revision not found"})
        return
    handler._send_json(200, {"path": rel, "rev": rev, "content": result.stdout})


def diff(handler):
    """GET /api/diff?path=&from=&to= — diff a doc between two revisions, across
    a rename if needed (auth)."""
    query = handler._query()
    rel = (query.get("path", [""])[0] or "").strip()
    rev_from = (query.get("from", [""])[0] or "").strip()
    rev_to = (query.get("to", [""])[0] or "").strip()
    if _s._validate_doc_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    ctx = handler._viewer_ctx()  # ACL gate (no-existence-oracle)
    if not ctx.superuser and not _s.can_read(rel, ctx):
        handler._send_json(404, {"error": "not found"})
        return
    if not _s._valid_git_rev(rev_from) or not _s._valid_git_rev(rev_to):
        handler._send_json(400, {"error": "invalid rev"})
        return
    if not ctx.superuser and not (_s.can_read_at(rel, rev_from, ctx) and _s.can_read_at(rel, rev_to, ctx)):
        handler._send_json(404, {"error": "not found"})
        return
    repo_rel = "content/" + rel
    from_path = _s._doc_path_at(repo_rel, rev_from)
    to_path = _s._doc_path_at(repo_rel, rev_to)
    if from_path == to_path:
        result = _s.git("diff", rev_from, rev_to, "--", from_path)
    else:  # moved/renamed between the two revisions → diff the blobs
        result = _s.git("diff", rev_from + ":" + from_path, rev_to + ":" + to_path)
    if result.returncode != 0:
        handler._send_json(500, {"error": result.stderr.strip() or "git diff failed"})
        return
    handler._send_json(200, {
        "path": rel, "from": rev_from, "to": rev_to, "diff": result.stdout,
    })


def activity(handler):
    """GET /api/activity?since=&author=&type=&limit= — corpus-wide activity feed (the
    read side of the attribution layer). AUTH only; never anonymous (a share link can't
    reach /api/*), and each event is ACL-scrubbed to the viewer."""
    query = handler._query()
    ctx = handler._viewer_ctx()
    if not ctx.superuser and not ctx.primary:
        handler._send_json(403, {"error": "forbidden"})
        return
    days = _s.clamp_int(query.get("since", [None])[0], 30, 1, 365)
    limit = _s.clamp_int(query.get("limit", [None])[0], 60, 1, 200)
    author = (query.get("author", [""])[0] or "").strip() or None
    type_filter = (query.get("type", [""])[0] or "").strip() or None
    events = _s._activity_events(days, limit, author, type_filter,
                                 None if ctx.superuser else ctx)
    if events is None:
        handler._send_json(500, {"error": "git log failed"})
        return
    handler._send_json(200, {"events": events})


def run(handler):
    """GET /api/run?sha= — the run (one writer's burst of commits) a feed event belongs to,
    for the Activity undo button: its docs, and whether the viewer may undo it."""
    ctx = handler._viewer_ctx()
    if not ctx.superuser and not ctx.primary:
        handler._send_json(403, {"error": "forbidden"})
        return
    sha = (handler._query().get("sha", [""])[0] or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        handler._send_json(400, {"error": "invalid sha"})
        return
    found = _s.run_of(sha, ctx)
    if found is None:
        handler._send_json(404, {"error": "no recent run holds this change"})
        return
    handler._send_json(200, found)


def run_undo(handler):
    """POST /api/run/undo — undo a run, whole or for some of its docs (`paths`), in one
    commit in the viewer's name, as the undo_run tool does."""
    data = handler._read_json()
    try:
        message = _s.undo_run({"run": data.get("run"), "paths": data.get("paths")},
                              handler._viewer_ctx())
    except LookupError as e:  # the run moved on (its writer kept going) or the docs left it
        handler._send_json(404, {"error": str(e)})
    except PermissionError as e:
        handler._send_json(403, {"error": str(e)})
    except ValueError as e:  # a later change touches the same lines: nothing was changed
        handler._send_json(409, {"error": str(e)})
    else:
        handler._send_json(200, {"ok": True, "message": message})


def stale(handler):
    """GET /api/stale?months=&limit= — docs untouched for N months (13c obsolescence).
    Deterministic, AUTH only (never anonymous), ACL-scrubbed per viewer."""
    query = handler._query()
    ctx = handler._viewer_ctx()
    if not ctx.superuser and not ctx.primary:
        handler._send_json(403, {"error": "forbidden"})
        return
    months = _s.clamp_int(query.get("months", [None])[0], 6, 1, 24)
    limit = _s.clamp_int(query.get("limit", [None])[0], 40, 1, 100)
    items = _s._api_stale(months, limit, None if ctx.superuser else ctx)
    handler._send_json(200, {"months": months, "stale": items})


def inbox_list(handler):
    """GET /api/inbox?limit=: pending inbox items (the agents' on-ramp), highest
    confidence first. AUTH and private: only the owner (primary/superuser) sees the inbox,
    so a non-primary viewer gets 403 (never a leak)."""
    query = handler._query()
    ctx = handler._viewer_ctx()
    if not ctx.superuser and not ctx.primary:
        handler._send_json(403, {"error": "forbidden"})
        return
    limit = _s.clamp_int(query.get("limit", [None])[0], 50, 1, 200)
    items = _s._api_inbox_list(limit, None if ctx.superuser else ctx)
    handler._send_json(200, {"inbox": items})


def inbox_action(handler):
    """POST /api/inbox/action: triage an inbox item. Owner-gated (the inbox is private,
    so only the owner acts), one attributed commit per action. Body:
    {action: keep|trash|untrash|snooze, path, dest?, until?}. Keep promotes into the graph;
    Trash/Snooze flip the frontmatter in place (reversible, no hard delete)."""
    data = handler._read_json()
    action = (data.get("action") or "").strip()
    src_rel = (data.get("path") or "").strip()
    ctx = handler._viewer_ctx()
    if action == "keep":
        tags = data.get("tags") if isinstance(data.get("tags"), list) else None
        ok, res = _s._promote_inbox_item(src_rel, data.get("dest") or "", ctx, tags=tags)
    elif action == "trash":
        ok, res = _s._set_inbox_status(src_rel, {"inbox_status": "trashed"}, ctx,
                                       f"trashed: {src_rel}")
    elif action == "untrash":
        ok, res = _s._set_inbox_status(src_rel, {"inbox_status": "pending", "snooze_until": None},
                                       ctx, f"restored: {src_rel}")
    elif action == "snooze":
        until = (data.get("until") or "").strip()
        # Must be a real ISO date: the list filter compares snooze_until as a STRING, so a non-date
        # ("tomorrow") sorts above any YYYY-... and would hide the item forever, while "" is a silent
        # no-op (snoozed flag set but the item stays visible).
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", until):
            handler._send_json(400, {"error": "snooze requires a valid YYYY-MM-DD date"})
            return
        ok, res = _s._set_inbox_status(src_rel, {"inbox_status": "snoozed", "snooze_until": until},
                                       ctx, f"snoozed: {src_rel}")
    else:
        handler._send_json(400, {"error": "unknown action"})
        return
    if not ok:
        code = 404 if "not found" in res.lower() else 403 if "permission" in res.lower() else 400
        handler._send_json(code, {"error": res})
        return
    handler._send_json(200, {"ok": True, "result": res})


def contradictions(handler):
    """GET /api/contradictions?limit=. Candidate contradictions for the HUMAN viewer (13c):
    the precise table-row drift detector plus any cluster already confirmed 'real'. Raw cosine
    clusters and the polarity / intra-doc-status leads are NOT a permanent feed here; they are
    the AI's on-demand substrate via the MCP `contradictions` tool. AUTH, ACL-scrubbed."""
    query = handler._query()
    ctx = handler._viewer_ctx()
    if not ctx.superuser and not ctx.primary:
        handler._send_json(403, {"error": "forbidden"})
        return
    limit = _s.clamp_int(query.get("limit", [None])[0], 15, 1, 50)
    include = query.get("include_dismissed", ["0"])[0] in ("1", "true")
    items = _s.find_contradictions(None if ctx.superuser else ctx, limit, include,
                                   solid_only=True)
    handler._send_json(200, {"candidates": items})


def contradiction_verdict(handler):
    """POST /api/contradiction — record a human verdict on a candidate pair (13c feedback
    loop). Body {a, b, verdict, note?, a_line?, b_line?} with verdict ∈ {real, none}; 'none' =
    "pas une contradiction" (the dismiss button). AUTH + CSRF (verb guard). The actor must be
    able to read BOTH docs. Stores the doc hashes plus, when the judged line numbers are given,
    their span hashes so the verdict survives edits ELSEWHERE in the doc (F1, span-bound); it
    falls back to whole-doc binding otherwise. Then commits the cache. No LLM — the human (or an
    MCP client) is the judge."""
    data = handler._read_json()
    a = (data.get("a") or "").strip()
    b = (data.get("b") or "").strip()
    verdict = (data.get("verdict") or "").strip()
    if verdict not in _s.VERDICTS:
        handler._send_json(400, {"error": "invalid verdict"})
        return
    ta, tb = _s._validate_doc_path(a), _s._validate_doc_path(b)
    if ta is None or tb is None or (a == b and _s.clamp_int(data.get("a_line"), 0, 0) == _s.clamp_int(data.get("b_line"), 0, 0)):
        handler._send_json(400, {"error": "invalid pair"})
        return
    ctx = handler._viewer_ctx()
    if not (_s.can_read(a, ctx) and _s.can_read(b, ctx)):
        handler._send_json(403, {"error": "forbidden"})
        return
    try:  # utf-8-sig to match the hash computed over _doc_corpus in the candidates pass
        ta_text = ta.read_text(encoding="utf-8-sig")
        tb_text = tb.read_text(encoding="utf-8-sig")
    except OSError:
        handler._send_json(404, {"error": "doc unreadable"})
        return
    ha, hb = _s.doc_hash(ta_text), _s.doc_hash(tb_text)
    sa = _s._span_hash(ta_text, _s.clamp_int(data.get("a_line"), 0, 0))
    sb = _s._span_hash(tb_text, _s.clamp_int(data.get("b_line"), 0, 0))
    by = (handler._session() or {}).get("email") if _s.CONFIG.auth_enabled else "local"
    path = _s.set_verdict(a, b, verdict, ha, hb, by or "local", data.get("note") or "",
                          a_span=sa, b_span=sb)
    _s.commit_change(ctx, f"contradiction {verdict}: "
                     f"{posixpath.splitext(posixpath.basename(a))[0]} ⇄ "
                     f"{posixpath.splitext(posixpath.basename(b))[0]}", path)
    handler._send_json(200, {"ok": True, "verdict": verdict})


def revert(handler):
    """POST /api/revert — restore a doc to a past revision (write that
    revision's content back as the current file). Mutating → admin + CSRF,
    like the other writes."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    rev = (data.get("rev") or "").strip()
    target = _s._validate_doc_path(rel)
    if target is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    if not _s._valid_git_rev(rev):
        handler._send_json(400, {"error": "invalid rev"})
        return
    if _s._is_readonly_path(rel):
        handler._send_json(403, {"error": "remote mirror is read-only"})
        return
    ctx = handler._viewer_ctx()
    if not ctx.superuser:
        if not _s.can_read(rel, ctx):
            handler._send_json(404, {"error": "not found"})
            return
        if not _s.can_write(rel, ctx, "edit"):
            handler._send_json(403, {"error": "insufficient permission (need edit on this document)"})
            return
        if not _s.can_read_at(rel, rev, ctx):
            handler._send_json(404, {"error": "revision not found"})
            return
    show = _s.git("show", rev + ":" + _s._doc_path_at("content/" + rel, rev))
    if show.returncode != 0:
        handler._send_json(404, {"error": "revision not found"})
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(show.stdout, encoding="utf-8")
    short = _s.git("rev-parse", "--short", rev).stdout.strip() or rev[:8]
    _s.commit_change(ctx, f"reverted: {target.stem} @ {short}", target)
    handler._send_json(200, {"ok": True})


def move(handler):
    """POST /api/file/move — move a doc AND rewrite the incoming wikilinks (shared with
    the MCP move_doc tool), or any other file of the mind as it is."""
    data = handler._read_json()
    src_rel = (data.get("from") or "").strip()
    dst_rel = (data.get("to") or "").strip()
    if _s._is_readonly_path(src_rel) or _s._is_readonly_path(dst_rel):
        handler._send_json(403, {"error": "remote mirror is read-only"})
        return
    ctx = handler._viewer_ctx()
    if not ctx.superuser:
        if not _s.can_read(src_rel, ctx):
            handler._send_json(404, {"error": "not found"})
            return
        if not _s.can_write(src_rel, ctx, "owner"):
            handler._send_json(403, {"error": "insufficient permission (need owner to move this document)"})
            return
        if not _s.can_create(dst_rel, ctx):
            handler._send_json(403, {"error": "insufficient permission for the destination"})
            return
    # Canonicalize the source to its on-disk spelling so the ACL/share repoint below
    # keys by the same path the entry was stored under (case-insensitive FS).
    src_rel = _s._canonical_rel(src_rel)
    if _s._validate_doc_path(src_rel):
        status, payload = _s._move_md_with_relink(src_rel, dst_rel)
    else:  # a PDF, an image: nothing to relink
        status, payload = move_file(src_rel, dst_rel, _s.CONFIG.content_root)
    if status != "ok":
        code = {"invalid": 400, "not_found": 404, "exists": 409}.get(status, 500)
        handler._send_json(code, {"error": payload})
        return
    # Keep the doc's privacy + share links with it (ACL repointed before the git sync;
    # a registry hiccup must not fail the move — the doctor reconciles any orphan).
    _s._repoint_doc(payload["from"], payload["to"])
    touched = [payload["from"], payload["to"], *(r["path"] for r in payload["rewrites"])]
    subject = (f"moved: {posixpath.splitext(payload['from'])[0]}"
               f" → {posixpath.splitext(payload['to'])[0]}")
    _s.commit_change(ctx, subject, *(_s.CONFIG.content_root / p for p in touched))
    handler._send_json(200, {"ok": True, **payload})


def dir_rename(handler):
    """POST /api/dir/rename {from, to} — move or rename a folder with all it holds (its
    privacy and share links follow, [[links]] by path are rewritten)."""
    data = handler._read_json()
    status, payload = _s.move_dir(data.get("from"), data.get("to"), handler._viewer_ctx())
    handler._send_json(status, payload)


def dir_create(handler):
    """POST /api/dir {path, private?} — a new folder, kept even while empty."""
    data = handler._read_json()
    private = data.get("private")
    status, payload = _s.create_dir(data.get("path"), handler._viewer_ctx(),
                                    private=private if isinstance(private, bool) else None)
    handler._send_json(status, payload)


def dir_delete(handler):
    """DELETE /api/dir {path} — remove a folder that holds nothing."""
    status, payload = _s.delete_empty_dir(handler._read_json().get("path"), handler._viewer_ctx())
    handler._send_json(status, payload)


def delete(handler):
    """DELETE /api/file — move a doc or any file (a PDF, an image) to .trash/, restorable
    (CSRF enforced by the verb-level guard in do_DELETE, owner right checked here)."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    if clean_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    if _s._is_readonly_path(rel):
        handler._send_json(403, {"error": "remote mirror is read-only"})
        return
    target = docs.content_file(rel, _s.CONFIG.content_root)
    if target is None:
        handler._send_json(404, {"error": "document not found"})
        return
    ctx = handler._viewer_ctx()
    if not ctx.superuser:
        if not _s.can_read(rel, ctx):
            handler._send_json(404, {"error": "document not found"})
            return
        if not _s.can_write(rel, ctx, "owner"):
            handler._send_json(403, {"error": "insufficient permission (need owner to delete this document)"})
            return
    handler._send_json(200, {"ok": True, "trashed": _s.trash_doc(target, ctx)})


def export_notes(handler):
    """GET /api/export — "leave with your notes": a zip of every file this person may
    read; the whole history too when the mind is entirely theirs (local mode, or the
    only account) — a shared mind's history holds the others' private docs."""
    ctx = handler._viewer_ctx()
    root = _s.CONFIG.content_root
    rels = export.exportable(root, (lambda rel: True) if ctx.superuser
                             else (lambda rel: _s.can_read(rel, ctx)))
    owner = _s.whole_mind_owner()
    whole = ctx.superuser or (owner is not None and ctx.primary == "user:" + owner)
    _send_export(handler, f"{_s.CONFIG.site_slug}-notes.zip", rels, _s.CONFIG.root if whole else None)


def backup(handler):
    """POST /api/admin/backup {password, code} — the whole Atlas in one zip: the notes and
    their history, and its registry (the account and its 2FA, the AI accesses, the Claude
    connection, the rights, the tasks, the settings, the GitHub key). Those are secrets: the
    password, and the 2FA code when on, are asked again, so an open session alone can't take
    them away; a wrong one counts like a failed sign-in. For the owner of a mind that is
    theirs alone: a shared mind's registry and history hold the others' private notes."""
    me = (handler._session() or {}).get("email")
    if not me or _s.whole_mind_owner() != me:
        handler._send_json(403, {"error": "shared"})
        return
    data = handler._read_json()
    if not handler._reauthenticate(me, data.get("password"), data.get("code")):
        return
    root = _s.CONFIG.content_root
    _send_export(handler, f"{_s.CONFIG.site_slug}-backup.zip", export.exportable(root, lambda rel: True),
                 _s.CONFIG.root, registry=Path(_s.CONFIG.store_dir))


def _send_export(handler, name, rels, repo_root, registry=None):
    with tempfile.SpooledTemporaryFile(max_size=32 << 20) as buf:
        export.write_export(buf, _s.CONFIG.content_root, rels, _s.CONFIG.site_slug, _s.CONFIG.lang,
                            repo_root, registry)
        size = buf.tell()
        buf.seek(0)
        handler.send_response(200)
        handler.send_header("Content-Type", "application/zip")
        handler.send_header("Content-Disposition", f'attachment; filename="{name}"')
        handler.send_header("Content-Length", str(size))
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        shutil.copyfileobj(buf, handler.wfile)


def export_page(handler):
    """GET /api/export/page?path= — one note as a page to send: a file that opens anywhere,
    with no Atlas to reach (what a mind on this computer offers instead of a share link). A
    page (.html) is already one and goes as it is."""
    rel = (handler._query().get("path") or [""])[0]
    target = _s._validate_doc_path(rel)
    ctx = handler._viewer_ctx()
    if target is None or not target.is_file() or not (ctx.superuser or _s.can_read(rel, ctx)):
        handler._send_json(404, {"error": "not found"})
        return
    body = target.read_bytes() if target.suffix == ".html" else share_page.render(rel, target, sender=ctx)
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Disposition",
                        f"attachment; filename*=UTF-8''{quote(target.stem)}.html")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


_TRASH = ".trash/"
_TRASH_SHOWN = 200


def _trashed(ctx):
    """The trashed files `ctx` may restore (or delete for good): [(Path, rel)]."""
    root = _s.CONFIG.content_root / ".trash"
    out = []
    for path in root.rglob("*") if root.is_dir() else ():
        if not path.is_file():
            continue
        rel = path.relative_to(_s.CONFIG.content_root).as_posix()
        if ctx.superuser or _s.can_write(rel, ctx, "owner"):
            out.append((path, rel))
    return out


def trash_list(handler):
    """GET /api/trash — the trashed docs and files this person may restore, newest
    deletion first."""
    ctx = handler._viewer_ctx()
    items = []
    for path, rel in _trashed(ctx):
        repo_rel = path.relative_to(_s.CONFIG.root).as_posix()
        stamp = _s.git("log", "-1", "--format=%ct", "--", repo_rel).stdout.strip()
        items.append({"path": rel, "original": rel[len(_TRASH):], "name": path.name,
                      "deleted_at": int(stamp) if stamp.isdigit() else int(path.stat().st_mtime)})
    items.sort(key=lambda i: i["deleted_at"], reverse=True)
    handler._send_json(200, {"items": items[:_TRASH_SHOWN], "total": len(items)})


def trash_purge(handler):
    """DELETE /api/trash {path: ".trash/…"} or {all: true} — delete for good what this person
    may restore: it leaves the bin and the files (git history still holds it)."""
    data = handler._read_json()
    ctx = handler._viewer_ctx()
    mine = _trashed(ctx)
    if data.get("all") is True:
        doomed = mine
    else:
        rel = posixpath.normpath((data.get("path") or "").strip())
        doomed = [(p, r) for p, r in mine if r == rel]
        if not doomed:
            handler._send_json(404, {"error": "not in the trash"})
            return
    store = _s.get_store()
    for path, rel in doomed:
        path.unlink()
        try:
            store.delete_acl(rel)
        except Exception as e:
            print(f"[trash purge acl] {e}", file=sys.stderr)
    trash_root = _s.CONFIG.content_root / ".trash"
    for folder in sorted((p.parent for p, _ in doomed), key=lambda p: len(p.parts), reverse=True):
        while folder != trash_root and folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()
            folder = folder.parent
    if doomed:
        subject = (f"purged: {doomed[0][0].stem}" if len(doomed) == 1
                   else f"trash emptied: {len(doomed)} items")
        _s.commit_change(ctx, subject, *(p for p, _ in doomed))
    handler._send_json(200, {"ok": True, "deleted": len(doomed)})


def trash_restore(handler):
    """POST /api/trash/restore {path: ".trash/…"} — put a trashed doc or file back where it was
    (beside it, renamed, when that place is taken again), its ACL with it. Needs the
    same right as the delete: owner."""
    rel = posixpath.normpath((handler._read_json().get("path") or "").strip())
    target = (_s.CONFIG.content_root / rel).resolve()
    trash_root = (_s.CONFIG.content_root / ".trash").resolve()
    if not rel.startswith(_TRASH) or trash_root not in target.parents or not target.is_file():
        handler._send_json(404, {"error": "not in the trash"})
        return
    ctx = handler._viewer_ctx()
    if not ctx.superuser and not _s.can_write(rel, ctx, "owner"):
        handler._send_json(404, {"error": "not in the trash"})
        return
    original = PurePosixPath(rel[len(_TRASH):])
    dest = _s.CONFIG.content_root / original
    n = 1
    while dest.exists():
        dest = dest.with_name(f"{original.stem}-restored{'' if n == 1 else f'-{n}'}{original.suffix}")
        n += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    target.replace(dest)
    restored = dest.relative_to(_s.CONFIG.content_root).as_posix()
    try:
        _s.get_store().repoint_acl_by_path(rel, restored)
    except Exception as e:
        print(f"[restore acl] {e}", file=sys.stderr)
    _s.commit_change(ctx, f"restored: {dest.stem}", target, dest)
    handler._send_json(200, {"ok": True, "path": restored})
