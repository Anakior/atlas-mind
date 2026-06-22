"""Request-parameter helpers shared by REST routes and MCP tools."""


def clamp_int(raw, default, lo=1, hi=None):
    """Parse `raw` (str/int/None) to an int clamped to [lo, hi]; `default` on any
    parse failure."""
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    if v < lo:
        return lo
    return v if hi is None else min(v, hi)
