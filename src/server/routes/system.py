"""System routes: healthcheck, public static assets, service worker, OpenAPI
spec, GitHub webhook, and the SSE live-reload stream."""
import hashlib
import hmac
import http.server
import json
import threading
import time
import server as _s


def healthz(handler):
    """GET /healthz — Fly healthcheck (public, no auth or registry, so an Atlas
    outage doesn't fail the check and trigger a needless machine restart)."""
    handler._send_bytes(200, b"ok", "text/plain; charset=utf-8")


def static_get(handler):
    """Public static assets (PWA manifest/icon/favicon + vendored libs/fonts):
    served by the stdlib static handler, no auth (the /login and /share pages
    depend on them outside a session). translate_path maps /vendor/ to
    web/vendor/ with an anti-traversal guard."""
    http.server.SimpleHTTPRequestHandler.do_GET(handler)


def sw(handler):
    """Serves sw.js: no-cache (browser detects a new SW version fast) and explicit
    root scope.

    __ENGINE_VERSION__ is stamped into CACHE_VERSION so each release uses a fresh
    cache name: `activate` purges the old cache, so unversioned vendored assets
    (tailwind.css, fonts) are re-fetched instead of served stale after a deploy."""
    target = (_s.CONFIG.web_dir / "sw.js")
    if not target.is_file():
        handler.send_error(404)
        return
    source = target.read_text(encoding="utf-8")
    stamped = source.replace("__ENGINE_VERSION__", _s.current_version() or "dev")
    handler._send_bytes(
        200, stamped.encode("utf-8"), "application/javascript; charset=utf-8",
        [("Cache-Control", "no-cache"), ("Service-Worker-Allowed", "/")],
    )


def openapi(handler):
    """Public OpenAPI 3.1 spec (no auth) for discovery by Claude.ai."""
    scheme = "https" if _s.CONFIG.auth_enabled else "http"
    host = handler.headers.get("Host", f"localhost:{_s.CONFIG.port}")
    spec = {
        "openapi": "3.1.0",
        "info": {
            "title": _s.CONFIG.site_name,
            "description": f"{_s.CONFIG.tagline} Search, read and create markdown documents (read-only + create-only).",
            "version": "1.0.0",
        },
        "servers": [{"url": f"{scheme}://{host}"}],
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer"}
            },
            "schemas": {
                "SearchHit": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "name": {"type": "string"},
                        "score": {"type": "number"},
                        "snippet": {"type": "string"},
                        "mtime": {"type": "integer", "description": "Unix epoch seconds"},
                    },
                },
                "FileContent": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "name": {"type": "string"},
                        "content": {"type": "string"},
                        "mtime": {"type": "integer"},
                        "words": {"type": "integer"},
                    },
                },
            },
        },
        "security": [{"bearerAuth": []}],
        "paths": {
            "/api/v1/search": {
                "get": {
                    "operationId": "searchDocs",
                    "summary": "Full-text search across all .md in the base",
                    "description": "Returns the documents matching the query, ranked by score. Use terms in the language of the indexed content.",
                    "parameters": [
                        {"name": "q", "in": "query", "required": True, "schema": {"type": "string"}, "description": "Search term(s)"},
                        {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 10, "maximum": 50}},
                    ],
                    "responses": {
                        "200": {
                            "description": "Results ranked by relevance",
                            "content": {"application/json": {"schema": {"type": "array", "items": {"$ref": "#/components/schemas/SearchHit"}}}},
                        }
                    },
                }
            },
            "/api/v1/file": {
                "get": {
                    "operationId": "readDoc",
                    "summary": "Read the full content of a markdown document",
                    "parameters": [{"name": "path", "in": "query", "required": True, "schema": {"type": "string"}, "description": "Relative path (e.g. notes/example.md)"}],
                    "responses": {
                        "200": {"description": "Document content", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/FileContent"}}}},
                        "404": {"description": "Document not found"},
                    },
                },
                "post": {
                    "operationId": "createDoc",
                    "summary": "Create a new markdown document (refuses overwrite)",
                    "description": "Returns 409 if a document already exists at this path. The content must be valid markdown.",
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": {
                            "type": "object",
                            "required": ["path", "content"],
                            "properties": {
                                "path": {"type": "string", "description": "Relative path ending in .md (e.g. inbox/note.md)"},
                                "content": {"type": "string", "description": "Full markdown body"},
                            },
                        }}},
                    },
                    "responses": {
                        "201": {"description": "Document created"},
                        "409": {"description": "Already exists — no overwrite allowed for this token"},
                    },
                },
            },
            "/api/v1/tree": {
                "get": {
                    "operationId": "listTree",
                    "summary": "List the full document tree (metadata without content)",
                    "responses": {"200": {"description": "Knowledge base tree", "content": {"application/json": {"schema": {"type": "object"}}}}},
                }
            },
            "/api/v1/recent": {
                "get": {
                    "operationId": "recentDocs",
                    "summary": "Recently modified documents, newest first",
                    "parameters": [
                        {"name": "days", "in": "query", "schema": {"type": "integer", "default": 7}, "description": "Window in days"},
                        {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 20, "maximum": 100}},
                    ],
                    "responses": {"200": {"description": "List of documents", "content": {"application/json": {"schema": {"type": "array", "items": {"$ref": "#/components/schemas/SearchHit"}}}}}},
                }
            },
        },
    }
    body = json.dumps(spec, ensure_ascii=False).encode("utf-8")
    handler._send_bytes(200, body, "application/json; charset=utf-8",
                        [("Cache-Control", "public, max-age=300")])


def webhook(handler):
    """GitHub push webhook: pull + rebuild if the HMAC signature is valid."""
    if not _s.CONFIG.github_webhook_secret:
        handler.send_response(503)
        handler.end_headers()
        return
    body = handler._read_body()
    received = handler.headers.get("X-Hub-Signature-256", "")
    expected = "sha256=" + hmac.new(
        _s.CONFIG.github_webhook_secret, body, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(received, expected):
        handler.send_response(401)
        handler.end_headers()
        return
    event = handler.headers.get("X-GitHub-Event", "")
    if event == "push":
        threading.Thread(target=_s.pull_and_rebuild, daemon=True).start()
    handler.send_response(200)
    handler.send_header("Content-Type", "text/plain")
    handler.end_headers()
    handler.wfile.write(b"ok")


def events(handler):
    """GET /api/events — SSE live-reload stream (auth). Registers the live
    Handler with the ReloadHub; pings every 20 s until the client drops."""
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "keep-alive")
    handler.end_headers()
    try:
        handler.wfile.write(b": connected\n\n")
        handler.wfile.flush()
        _s._CTX.reload_hub.register(handler)
        while True:
            time.sleep(20)
            try:
                handler.wfile.write(b": ping\n\n")
                handler.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                break
    finally:
        _s._CTX.reload_hub.unregister(handler)
