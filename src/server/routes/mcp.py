"""MCP streamable-HTTP transport route (token in the path; self-verified bearer)."""
import json
import server as _s


def handle(handler):
    """Streamable HTTP transport for the MCP protocol. Token in the path.

    URL: /mcp/<token>[/...].
    - POST JSON-RPC body → JSON-RPC response (or 202 if notification)
    - anything else → 405: no server→client stream (legacy revisions allow
      the 405, 2026-07-28 removed the GET endpoint altogether).
    """
    parts = handler.path.split("?", 1)[0].strip("/").split("/")
    if len(parts) < 2 or parts[0] != "mcp":
        handler._send_json(404, {"error": "not found"})
        return
    token = parts[1]
    identity = _s.resolve_mcp_identity(token)
    if not identity:
        handler._send_json(401, {"error": "invalid mcp token"})
        return
    # Per-document ACL context, derived from the TOKEN (never from a tool
    # argument → no identity spoofing). Threaded into the dispatch below.
    ctx = _s.viewer_ctx(identity)
    # Rate limit shared with the REST API.
    if not _s.api_rate_limit_ok(_s._hash_api_token(token)):
        handler._send_json(429, {"error": "rate limit exceeded"})
        return

    if handler.command != "POST":
        handler._send_json(405, {"error": "method not allowed"})
        return

    try:
        raw = handler._read_body() or b"{}"
        req = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        handler._send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
        return

    # A JSON-RPC batch is legacy-only (2025-03-26), so it always answers 200.
    if isinstance(req, list):
        responses = [r for r in (_s._mcp_jsonrpc(item, ctx, handler.headers) for item in req)
                     if r is not None]
        if not responses:
            _accepted(handler)
            return
        handler._send_json(200, responses)
        return

    response = _s._mcp_jsonrpc(req, ctx, handler.headers)
    if response is None:
        _accepted(handler)
        return
    handler._send_json(_s._mcp_http_status(req, response), response)


def _accepted(handler):
    """202 for a notification, as every Streamable HTTP revision requires."""
    handler.send_response(202)
    handler.send_header("Content-Length", "0")
    handler.end_headers()
