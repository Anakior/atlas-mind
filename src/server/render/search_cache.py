"""Search document cache: a per-doc {content, content_n, name_n, tokens, mtime}
reloaded only when the file's mtime changes. Avoids re-reading + normalizing the
whole corpus on every /api/search request. Module-level, mtime-self-invalidating,
NO lock (a stale read at worst re-reads one file)."""
import re

import server as _s

_DOC_CACHE: dict = {}


def _doc_entry(rel: str, path):
    """Returns a cached {content, content_n, name_n, tokens, mtime}, reloaded only
    if the file's mtime has changed. None if the file cannot be read."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    ent = _DOC_CACHE.get(rel)
    if ent is not None and ent["mtime"] == mtime:
        return ent
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    # For an .html we index the visible text (not the markup): search and
    # snippets stay readable. read_doc / GET file themselves return the raw HTML.
    if rel.lower().endswith(".html"):
        content = _s._html_to_text(content)
    content_n = _s._normalize_text(content)
    ent = {
        "mtime": mtime,
        "content": content,
        "content_n": content_n,
        "name_n": _s._normalize_text(path.name),
        "tokens": set(re.findall(r"[a-z0-9]{2,}", content_n)),
    }
    _DOC_CACHE[rel] = ent
    return ent
