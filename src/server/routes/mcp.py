"""MCP streamable-HTTP transport route: /mcp with a Bearer token (OAuth or API), or the
legacy /mcp/<token> (token in the path)."""
import json
import sys

import server as _s
from server.pure import mcp_call, oauth


def _bearer_token(handler) -> str:
    scheme, _, token = handler.headers.get("Authorization", "").strip().partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def _deny(handler, status, payload, challenge):
    handler._send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json",
                        [("WWW-Authenticate", challenge)])


def handle(handler):
    """Streamable HTTP transport for the MCP protocol.

    URL: /mcp with `Authorization: Bearer <token>` (an OAuth access token, or an API
    token), or the legacy /mcp/<token>[/...].
    - POST JSON-RPC body → JSON-RPC response (or 202 if notification)
    - anything else → 405: no server→client stream (legacy revisions allow
      the 405, 2026-07-28 removed the GET endpoint altogether).
    """
    parts = handler.path.split("?", 1)[0].strip("/").split("/")
    if parts[0] != "mcp":
        handler._send_json(404, {"error": "not found"})
        return
    bearer = len(parts) == 1
    token = _bearer_token(handler) if bearer else parts[1]
    identity = _s.resolve_mcp_identity(token)
    base = handler._public_url()
    mcp_call.request_base.set(base)
    resource = (identity or {}).get("resource")
    # An OAuth token is bound to this endpoint (its audience) and never rides in a URL.
    if resource and (not bearer or not oauth.same_resource(resource, oauth.resource_url(base))):
        identity = None
    if not identity:
        if bearer:  # the challenge that starts a client's OAuth flow
            _deny(handler, 401, {"error": "invalid_token"}, oauth.challenge_header(base))
        else:
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

    # A tool beyond the token's scopes: over OAuth, a 403 the client can answer by asking
    # the person for more (step-up); the legacy URL keeps the in-band tool error.
    if bearer and isinstance(req, dict) and req.get("method") == "tools/call":
        need = _s._needed_scope(_params(req).get("name") or "")
        if need and ctx.scopes is not None and need not in ctx.scopes:
            _deny(handler, 403, {"error": "insufficient_scope"},
                  oauth.challenge_header(base, "insufficient_scope", need))
            return

    # A JSON-RPC batch is legacy-only (2025-03-26), so it always answers 200, but for an empty
    # one, which JSON-RPC answers with one Invalid Request.
    if req == []:
        handler._send_json(400, mcp_call._rpc_error(None, -32600, "Invalid request: an empty batch"))
        return
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
    _note_read(token, req, response)
    handler._send_json(_s._mcp_http_status(req, response), response)


def _params(req) -> dict:
    """A request's params, {} when it has none or they are not an object (the dispatch refuses them)."""
    params = req.get("params") if isinstance(req, dict) else None
    return params if isinstance(params, dict) else {}


def _note_read(token, req, response):
    """A read_doc that returned its doc: what the home's "connect your AI" step waits for, not a
    mere connection (initialize, tools/list) nor a refused read."""
    if not isinstance(req, dict) or req.get("method") != "tools/call":
        return
    params, result = _params(req), response.get("result") or {}
    if params.get("name") != "read_doc" or not result or result.get("isError"):
        return
    try:
        _s.get_store().touch_last_read(_s._hash_api_token(token),
                                       str((params.get("arguments") or {}).get("path") or ""))
    except Exception as e:  # the read went through: its trace is best-effort
        print(f"[mcp last_read] {e}", file=sys.stderr)


def _accepted(handler):
    """202 for a notification, as every Streamable HTTP revision requires."""
    handler.send_response(202)
    handler.send_header("Content-Length", "0")
    handler.end_headers()
