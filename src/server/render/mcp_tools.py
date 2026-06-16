"""MCP tool definitions, loaded once from web/mcp-tools.json (served by the
tools/list method). Kept as data — the handler dispatch maps each tool name to its
implementation. Cache is module-level (read once)."""
import json

import server as _s

_MCP_TOOLS_CACHE = None


def _mcp_tools() -> list:
    global _MCP_TOOLS_CACHE
    if _MCP_TOOLS_CACHE is None:
        _MCP_TOOLS_CACHE = json.loads(
            (_s.CONFIG.web_dir / "mcp-tools.json").read_text(encoding="utf-8"))
    return _MCP_TOOLS_CACHE
