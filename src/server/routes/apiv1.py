"""Public REST API v1 (bearer-token) routes: search, file read/create, tree, recent."""
import server as _s


def get(handler):
    sess = handler._require_api_bearer()
    if not sess:
        return
    from urllib.parse import urlparse, parse_qs as _pqs
    parsed = urlparse(handler.path)
    query = _pqs(parsed.query)
    endpoint = parsed.path
    if endpoint == "/api/v1/search":
        q = (query.get("q", [""])[0] or "").strip()
        if not q:
            handler._send_json(400, {"error": "missing query parameter 'q'"})
            return
        try:
            limit = min(50, max(1, int(query.get("limit", ["10"])[0])))
        except ValueError:
            limit = 10
        handler._send_json(200, _s._api_search(q, limit))
        return
    if endpoint == "/api/v1/file":
        rel = (query.get("path", [""])[0] or "").strip()
        target = _s._validate_doc_path(rel)
        if not target or not target.exists():
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
        return
    if endpoint == "/api/v1/tree":
        try:
            tree = _s._import_build().walk(_s.CONFIG.content_root)
            handler._send_json(200, tree)
        except Exception as e:
            handler._send_json(500, {"error": str(e)})
        return
    if endpoint == "/api/v1/recent":
        try:
            days = max(1, int(query.get("days", ["7"])[0]))
            limit = min(100, max(1, int(query.get("limit", ["20"])[0])))
        except ValueError:
            days, limit = 7, 20
        handler._send_json(200, _s._api_recent(days, limit))
        return
    handler._send_json(404, {"error": "unknown endpoint"})


def post(handler):
    sess = handler._require_api_bearer()
    if not sess:
        return
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
    if target.exists():
        handler._send_json(409, {"error": "document already exists (create-only token)"})
        return
    if not isinstance(content, str):
        handler._send_json(400, {"error": "content must be a string"})
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    _s.trigger_sync()
    handler._send_json(201, {"ok": True, "path": rel, "mtime": int(target.stat().st_mtime)})
