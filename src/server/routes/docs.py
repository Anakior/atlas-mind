"""Document routes: file write/delete/move, directory rename, revert, and the
read-only git history / revision / diff endpoints, plus tree + search.

All mutating routes are guarded ADMIN_CSRF (PUT/DELETE keep the guard at the verb
level, so the functions here are pure bodies); the read endpoints are AUTH.
"""
import posixpath
import sys
import time

import server as _s


def file_put(handler):
    """PUT /api/file — write a .md/.html doc (admin + CSRF enforced at the verb
    level in do_PUT)."""
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
        handler._send_json(500, {"error": str(e)})


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


def contradictions(handler):
    """GET /api/contradictions?limit= — candidate doc PAIRS (shared tags/links) for the AI
    to judge (13c). Server pre-filter only; AUTH, never anonymous, ACL-scrubbed."""
    query = handler._query()
    ctx = handler._viewer_ctx()
    if not ctx.superuser and not ctx.primary:
        handler._send_json(403, {"error": "forbidden"})
        return
    limit = _s.clamp_int(query.get("limit", [None])[0], 15, 1, 50)
    items = _s._contradiction_candidates(None if ctx.superuser else ctx, limit)
    handler._send_json(200, {"candidates": items})


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
    """POST /api/file/move — move a doc AND rewrite the incoming wikilinks
    (shared with the MCP move_doc tool)."""
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
    status, payload = _s._move_md_with_relink(src_rel, dst_rel)
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
    """POST /api/dir/rename — move/rename a folder (reserved/technical folders
    blocked)."""
    data = handler._read_json()
    src_rel = (data.get("from") or "").strip().strip("/")
    dst_rel = (data.get("to") or "").strip().strip("/")
    for rel in (src_rel, dst_rel):
        if not rel or ".." in rel.split("/") or rel.startswith("/"):
            handler._send_json(400, {"error": "invalid path"})
            return
    # Reserved/technical folders (remotes/ = read-only remote mirrors, sync-managed).
    reserved = {"skill", "tools", ".git", "__pycache__", "node_modules", _s.REMOTES_DIR}
    for part in src_rel.split("/") + dst_rel.split("/"):
        if part in reserved or part.startswith("."):
            handler._send_json(403, {"error": f"protected dir: {part}"})
            return
    src = (_s.CONFIG.content_root / src_rel).resolve()
    dst = (_s.CONFIG.content_root / dst_rel).resolve()
    try:
        src.relative_to(_s.CONFIG.content_root)
        dst.relative_to(_s.CONFIG.content_root)
    except ValueError:
        handler._send_json(403, {"error": "outside root"})
        return
    if not src.exists() or not src.is_dir():
        handler._send_json(404, {"error": "source dir not found"})
        return
    if dst.exists():
        handler._send_json(409, {"error": "destination exists"})
        return
    try:
        dst.relative_to(src)
        handler._send_json(400, {"error": "destination is inside source"})
        return
    except ValueError:
        pass
    # Owner-or-admin of the folder may rename it (members rename folders they own).
    ctx = handler._viewer_ctx()
    if not ctx.superuser:
        if not _s.can_read(src_rel, ctx):
            handler._send_json(404, {"error": "source dir not found"})
            return
        if not _s.can_manage(src_rel, ctx):
            handler._send_json(403, {"error": "insufficient permission (need owner to rename this folder)"})
            return
        if not _s.can_create(dst_rel, ctx):
            handler._send_json(403, {"error": "insufficient permission for the destination"})
            return
    dst.parent.mkdir(parents=True, exist_ok=True)
    store = _s.get_store()
    # Canonicalize the source folder to its on-disk spelling so the ACL/share keys
    # (stored under that spelling) are found on a case-insensitive FS.
    csrc = src.relative_to(_s.CONFIG.content_root).as_posix()
    # Place the destination ACL BEFORE moving the folder on disk, so no doc is ever
    # reachable at its new path without its ACL (which would read as commons — a
    # transient privacy leak on a threaded server, the window the old order left
    # open across the rename + git sync). Source keys dropped AFTER, then shares,
    # then git last of all.
    try:
        store.copy_acl_under(csrc, dst_rel)
    except Exception as e:
        print(f"[dir rename copy_acl] {e}", file=sys.stderr)
    try:
        src.rename(dst)
    except Exception:
        try:
            store.drop_acl_under(dst_rel)  # roll back the speculative ACL copy
        except Exception:
            pass
        raise
    try:
        store.drop_acl_under(csrc)  # private docs stay private after a folder rename
        store.repoint_shares_under(csrc, dst_rel)
    except Exception as e:
        print(f"[dir rename repoint] {e}", file=sys.stderr)
    _s.commit_change(ctx, f"folder moved: {src_rel} → {dst_rel}", src, dst)
    handler._send_json(200, {"ok": True, "from": src_rel, "to": dst_rel})


def delete(handler):
    """DELETE /api/file — delete a .md/.html doc (admin + CSRF already enforced
    by the verb-level guard in do_DELETE)."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    if not rel or ".." in rel.split("/") or rel.startswith("/"):
        handler._send_json(400, {"error": "invalid path"})
        return
    if _s._is_readonly_path(rel):
        handler._send_json(403, {"error": "remote mirror is read-only"})
        return
    target = (_s.CONFIG.content_root / rel).resolve()
    try:
        target.relative_to(_s.CONFIG.content_root)
    except ValueError:
        handler._send_json(403, {"error": "outside root"})
        return
    if not target.exists() or target.suffix.lower() not in (".md", ".html"):
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
    target.unlink()
    # Drop the freed path's ACL entry AND revoke its share links, so a future doc
    # created there can't inherit a stale owner/grants or anonymous access
    # (best-effort: a registry hiccup must not fail the delete). The resolved target
    # gives the on-disk spelling, so the keys match on a case-insensitive FS.
    crel = target.relative_to(_s.CONFIG.content_root).as_posix()
    try:
        store = _s.get_store()
        store.delete_acl(crel)
        store.delete_shares_for_path(crel)
    except Exception as e:
        print(f"[delete cleanup] {e}", file=sys.stderr)
    _s.commit_change(ctx, f"deleted: {target.stem}", target)
    handler._send_json(200, {"ok": True})
