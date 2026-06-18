"""Document routes: file write/delete/move, directory rename, revert, and the
read-only git history / revision / diff endpoints, plus tree + search.

All mutating routes are guarded ADMIN_CSRF (PUT/DELETE keep the guard at the verb
level, so the functions here are pure bodies); the read endpoints are AUTH.
"""
import sys

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
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    _s.trigger_sync()
    handler._send_json(200, {"ok": True, "mtime": int(target.stat().st_mtime)})


def tree(handler):
    """GET /api/tree — the navigable document tree, filtered per-viewer (auth)."""
    try:
        tree = _s._import_build().walk(_s.CONFIG.content_root)
        ctx = handler._viewer_ctx()
        keep = None if ctx.superuser else (lambda p: _s.can_read(p, ctx))
        tree = _s._filter_tree(tree, keep)
        handler._send_json(200, tree)
    except Exception as e:
        handler._send_json(500, {"error": str(e)})


def search(handler):
    """GET /api/search?q=&limit= — server-side search (transfers O(results),
    not O(corpus)); filtered per-viewer (auth)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    query = _pqs(urlparse(handler.path).query)
    q = (query.get("q", [""])[0] or "").strip()
    if not q:
        handler._send_json(200, [])
        return
    try:
        limit = min(50, max(1, int(query.get("limit", ["50"])[0])))
    except ValueError:
        limit = 50
    ctx = handler._viewer_ctx()
    results = _s._api_search(q, limit, None if ctx.superuser else ctx)
    handler._send_json(200, results)


def history(handler):
    """GET /api/history?path= — a doc's git revisions, following renames/moves
    (auth). Every doc is versioned in git: `git` runs at CONFIG.root (repo
    root) while ?path= is relative to content/, so the pathspec is prefixed
    with "content/". Always `--` before the pathspec; revisions are
    regex-checked."""
    from urllib.parse import urlparse, parse_qs as _pqs
    rel = (_pqs(urlparse(handler.path).query).get("path", [""])[0] or "").strip()
    if _s._validate_doc_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    repo_rel = "content/" + rel
    # --follow tracks renames/moves so pre-move commits still load (revision/diff/
    # revert resolve the path-at-revision via _doc_path_at). -z + \x1f keep
    # records/fields unambiguous; -n 100 bounds payload.
    fmt = "%H%x1f%an%x1f%aI%x1f%s"
    result = _s.git("log", "--follow", "-n", "100", "--format=" + fmt, "-z",
                 "--", repo_rel)
    if result.returncode != 0:
        handler._send_json(500, {"error": result.stderr.strip() or "git log failed"})
        return
    revisions = []
    for record in result.stdout.split("\x00"):
        if not record:
            continue
        fields = (record.split("\x1f") + ["", "", "", ""])[:4]
        revisions.append({
            "sha": fields[0], "author": fields[1],
            "date": fields[2], "subject": fields[3],
        })
    handler._send_json(200, {"path": rel, "revisions": revisions})


def revision(handler):
    """GET /api/revision?path=&rev= — a doc's content at a past revision
    (auth)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    query = _pqs(urlparse(handler.path).query)
    rel = (query.get("path", [""])[0] or "").strip()
    rev = (query.get("rev", [""])[0] or "").strip()
    if _s._validate_doc_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
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
    from urllib.parse import urlparse, parse_qs as _pqs
    query = _pqs(urlparse(handler.path).query)
    rel = (query.get("path", [""])[0] or "").strip()
    rev_from = (query.get("from", [""])[0] or "").strip()
    rev_to = (query.get("to", [""])[0] or "").strip()
    if _s._validate_doc_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
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
    show = _s.git("show", rev + ":" + _s._doc_path_at("content/" + rel, rev))
    if show.returncode != 0:
        handler._send_json(404, {"error": "revision not found"})
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(show.stdout, encoding="utf-8")
    _s.trigger_sync()
    handler._send_json(200, {"ok": True})


def move(handler):
    """POST /api/file/move — move a doc AND rewrite the incoming wikilinks
    (shared with the MCP move_doc tool)."""
    data = handler._read_json()
    if _s._is_readonly_path(data.get("from") or "") or _s._is_readonly_path(data.get("to") or ""):
        handler._send_json(403, {"error": "remote mirror is read-only"})
        return
    status, payload = _s._move_md_with_relink(
        (data.get("from") or "").strip(), (data.get("to") or "").strip())
    if status != "ok":
        code = {"invalid": 400, "not_found": 404, "exists": 409}.get(status, 500)
        handler._send_json(code, {"error": payload})
        return
    _s.trigger_sync()
    # Keep share links of the moved doc alive. Best-effort: a registry hiccup
    # must not fail the move.
    try:
        _s.get_store().repoint_shares_by_path(payload["from"], payload["to"])
    except Exception as e:
        print(f"[share repoint] {e}", file=sys.stderr)
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
    # Prevent moving into a subfolder of itself
    try:
        dst.relative_to(src)
        handler._send_json(400, {"error": "destination is inside source"})
        return
    except ValueError:
        pass
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    _s.trigger_sync()
    # Re-point share links of every doc under the renamed folder (best-effort).
    try:
        _s.get_store().repoint_shares_under(src_rel, dst_rel)
    except Exception as e:
        print(f"[share repoint] {e}", file=sys.stderr)
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
    target.unlink()
    _s.trigger_sync()
    handler._send_json(200, {"ok": True})
