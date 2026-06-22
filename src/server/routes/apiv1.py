"""Public REST API v1 (bearer-token) routes: search, file read/create, tree, recent."""
import posixpath

import server as _s


def _v1_search(handler, ctx, query):
    q = (query.get("q", [""])[0] or "").strip()
    if not q:
        handler._send_json(400, {"error": "missing query parameter 'q'"})
        return
    try:
        limit = min(50, max(1, int(query.get("limit", ["10"])[0])))
    except ValueError:
        limit = 10
    handler._send_json(200, _s._api_search(q, limit, ctx))


def _v1_file(handler, ctx, query):
    rel = (query.get("path", [""])[0] or "").strip()
    target = _s._validate_doc_path(rel)
    if not target or not target.exists() or not _s.can_read(rel, ctx):
        handler._send_json(404, {"error": "document not found"})
        return
    text = target.read_text(encoding="utf-8")
    handler._send_json(200, {
        "path": rel,
        "name": target.name,
        "content": text,
        "mtime": int(target.stat().st_mtime),
        "words": len(text.split()),
    })


def _v1_tree(handler, ctx, query):
    try:
        tree = _s._import_build().walk(_s.CONFIG.content_root)
        tree = _s._filter_tree(tree, lambda p: _s.can_read(p, ctx))
        handler._send_json(200, tree)
    except Exception as e:
        handler._send_json(500, {"error": str(e)})


def _v1_recent(handler, ctx, query):
    try:
        days = max(1, int(query.get("days", ["7"])[0]))
        limit = min(100, max(1, int(query.get("limit", ["20"])[0])))
    except ValueError:
        days, limit = 7, 20
    handler._send_json(200, _s._api_recent(days, limit, ctx))


_GET = {
    "/api/v1/search": _v1_search,
    "/api/v1/file": _v1_file,
    "/api/v1/tree": _v1_tree,
    "/api/v1/recent": _v1_recent,
}


def get(handler):
    sess = handler._require_api_bearer()
    if not sess:
        return
    ctx = _s.viewer_ctx(sess)  # per-document ACL context (model B)
    from urllib.parse import urlparse, parse_qs as _pqs
    parsed = urlparse(handler.path)
    fn = _GET.get(parsed.path)
    if not fn:
        handler._send_json(404, {"error": "unknown endpoint"})
        return
    fn(handler, ctx, _pqs(parsed.query))


def post(handler):
    sess = handler._require_api_bearer()
    if not sess:
        return
    ctx = _s.viewer_ctx(sess)
    if handler.path != "/api/v1/file":
        handler._send_json(404, {"error": "unknown endpoint"})
        return
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    content = data.get("content", "")
    target = _s._validate_doc_path(rel)
    if not target:
        handler._send_json(400, {"error": "invalid path (must be a .md or .html inside root, no '..')"})
        return
    rel = posixpath.normpath(rel)  # canonical ACL key (matches effective_level)
    if not _s.can_create(rel, ctx):  # commons is member-writable; a private space needs edit
        handler._send_json(403, {"error": "insufficient permission to create at this location"})
        return
    if target.exists():
        handler._send_json(409, {"error": "document already exists (create-only token)"})
        return
    if not isinstance(content, str):
        handler._send_json(400, {"error": "content must be a string"})
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    if ctx.primary:  # stamp creator + default visibility (member → private, admin/api → commons)
        try:
            _s._stamp_new_doc(rel, ctx)
        except Exception:
            pass
    _s.commit_change(ctx, f"created: {target.stem}", target)
    handler._send_json(201, {"ok": True, "path": rel, "mtime": int(target.stat().st_mtime)})
