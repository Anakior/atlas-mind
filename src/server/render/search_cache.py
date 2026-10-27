"""Search document cache: a per-doc {content_n, name_n, tokens, length, mtime}
reloaded only when the file's mtime changes. Avoids re-reading + normalizing the
whole corpus on every /api/search request. Module-level, mtime-self-invalidating,
NO lock (a stale read at worst re-reads one file)."""
import re
import sys

import server as _s

_DOC_CACHE: dict = {}


def _doc_text(rel: str, path):
    """The text a doc is searched in, or None if unreadable. For an .html, its visible text
    (not the markup): search and snippets stay readable. read_doc / GET file themselves
    return the raw HTML."""
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    return _s._html_to_text(content) if rel.lower().endswith(".html") else content


def _doc_entry(rel: str, path):
    """Returns a cached {content_n, name_n, tokens, length, mtime}, reloaded only if the
    file's mtime has changed. None if the file cannot be read. The text itself is not kept:
    it was a third of the cache, and only the few hits of a search read it (_doc_text)."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    ent = _DOC_CACHE.get(rel)
    if ent is not None and ent["mtime"] == mtime:
        return ent
    content = _doc_text(rel, path)
    if content is None:
        return None
    content_n = _s._normalize_text(content)
    ent = {
        "mtime": mtime,
        "content_n": content_n,
        "name_n": _s._normalize_text(path.name),
        # The typo-correction vocabulary. A word is stored once for all docs (interned), and
        # 2-letter ones are left out: they can neither hold nor come within 0.78 of a query
        # token of 4+ letters, the only ones corrected.
        "tokens": frozenset(sys.intern(t) for t in re.findall(r"[a-z0-9]{3,}", content_n)),
        "length": len(content_n.split()),  # BM25 length normalization
    }
    _DOC_CACHE[rel] = ent
    return ent
