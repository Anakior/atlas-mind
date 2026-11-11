"""MCP stdio transport (`atlas mcp <dir>`): one JSON-RPC message per line on stdin, one answer
per line on stdout, for a client that launches the server itself (Claude Desktop, Cursor, the
config an MCP directory generates). No token: whoever can launch it can already open the
mind's folder, so it gets the local viewer's full rights; its writes still carry the AI
trailer (api) and their own run name (source)."""
import json

import server as _s
from server.pure import mcp_call

_LOCAL_AGENT = _s.ViewerCtx(set(), True, None, superuser=True, api=True, source="stdio")


def answer(line: bytes):
    """The answer to one line (a message or a legacy batch), or None when there is none to send."""
    try:
        req = json.loads(line)
    except ValueError:
        return mcp_call._rpc_error(None, -32700, "parse error")
    if req == []:
        return mcp_call._rpc_error(None, -32600, "Invalid request: an empty batch")
    if isinstance(req, list):
        return [r for r in (_s._mcp_jsonrpc(item, _LOCAL_AGENT) for item in req)
                if r is not None] or None
    return _s._mcp_jsonrpc(req, _LOCAL_AGENT)


def serve(stdin, stdout) -> None:
    """Answer stdin until the client closes it. stdout is binary and carries nothing else."""
    for line in stdin:
        if not line.strip():
            continue
        response = answer(line)
        if response is not None:
            stdout.write(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
            stdout.flush()
