"""Served-asset rendering + cached resource loaders. Per the plan these stay
module-level (idempotent / mtime-self-invalidating caches, no lock, no service):
i18n strings, HTML page templates + share-extension assets, MCP tool defs, and the
search document cache.
"""
