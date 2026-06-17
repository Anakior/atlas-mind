"""MCP streamable-HTTP transport route (token in the path; self-verified bearer)."""
import time
import json
import server as _s


def handle(handler):
    """Streamable HTTP transport for the MCP protocol. Token in the path.

    URL: /mcp/<token>[/...].
    - POST JSON-RPC body → JSON-RPC response (or 204 if notification)
    - GET with Accept: text/event-stream → SSE stream (keep-alive, for
      server→client notifications); otherwise 405.
    """
    parts = handler.path.split("?", 1)[0].strip("/").split("/")
    if len(parts) < 2 or parts[0] != "mcp":
        handler._send_json(404, {"error": "not found"})
        return
    token = parts[1]
    if not _s._verify_mcp_token(token):
        handler._send_json(401, {"error": "invalid mcp token"})
        return
    # Rate limit shared with the REST API.
    if not _s.api_rate_limit_ok(_s._hash_api_token(token)):
        handler._send_json(429, {"error": "rate limit exceeded"})
        return

    if handler.command == "GET":
        # SSE keep-alive stream (server→client notifications are not used
        # by our tools, but Claude.ai may open the connection for
        # discovery). We keep it open with a ping every 30s.
        accept = handler.headers.get("Accept", "")
        if "text/event-stream" not in accept:
            handler._send_json(405, {"error": "method not allowed (use Accept: text/event-stream)"})
            return
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Connection", "keep-alive")
        handler.end_headers()
        try:
            handler.wfile.write(b": connected\n\n")
            handler.wfile.flush()
            while True:
                time.sleep(30)
                try:
                    handler.wfile.write(b": ping\n\n")
                    handler.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    break
        except Exception:
            pass
        return

    if handler.command == "POST":
        try:
            raw = handler._read_body() or b"{}"
            req = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            handler._send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            return

        if isinstance(req, list):
            responses = [r for r in (_s._mcp_jsonrpc(item) for item in req) if r is not None]
            if not responses:
                handler.send_response(204)
                handler.end_headers()
                return
            handler._send_json(200, responses)
            return

        response = _s._mcp_jsonrpc(req)
        if response is None:
            # Notification → 204 No Content
            handler.send_response(204)
            handler.end_headers()
            return
        handler._send_json(200, response)
        return

    handler._send_json(405, {"error": "method not allowed"})
