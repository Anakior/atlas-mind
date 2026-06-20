"""Hive node bearer routes: manifest listing and individual file download.

Both routes self-verify the node bearer token in their own body via
verify_node_bearer; they are NOT table-guarded.
"""
import hashlib
import server as _s


def manifest(handler):
    node = _s.verify_node_bearer(handler.headers.get("Authorization", ""))
    if not node:
        handler._send_json(401, {"error": "invalid node token"})
        return
    # Rate-limit per node (manifest hashes the whole subtree per call): parity with
    # the apiv1/MCP Bearer channels, which are throttled — this one was not (DoS).
    if not _s.api_rate_limit_ok("node:" + node["name"]):
        handler._send_json(429, {"error": "rate limit exceeded (120/min)"})
        return
    files = []
    for rel, path in _s._iter_node_files(node["path"]):
        try:
            body = path.read_bytes()
        except OSError:
            continue
        files.append({
            "path": rel,
            "sha256": hashlib.sha256(body).hexdigest(),
            "size": len(body),
        })
    files.sort(key=lambda f: f["path"])
    handler._send_json(200, {
        "name": node["name"],
        "path": node["path"],
        "files": files,
    })


def file(handler):
    node = _s.verify_node_bearer(handler.headers.get("Authorization", ""))
    if not node:
        handler._send_json(401, {"error": "invalid node token"})
        return
    if not _s.api_rate_limit_ok("node:" + node["name"]):
        handler._send_json(429, {"error": "rate limit exceeded (120/min)"})
        return
    from urllib.parse import urlparse, parse_qs as _pqs
    rel = (_pqs(urlparse(handler.path).query).get("path", [""])[0] or "").strip()
    for node_rel, path in _s._iter_node_files(node["path"]):
        if node_rel != rel:
            continue
        try:
            body = path.read_bytes()
        except OSError:
            break
        ctype = ("text/html; charset=utf-8" if path.name.endswith(".html")
                 else "text/markdown; charset=utf-8")
        handler._send_bytes(200, body, ctype, [("Cache-Control", "no-store")])
        return
    handler._send_json(404, {"error": "file not found in node"})
