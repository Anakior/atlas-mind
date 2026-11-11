"""Search document cache: a per-doc {content_n, name_n, tokens, length, mtime}
reloaded only when the file's mtime changes. Avoids re-reading + normalizing the
whole corpus on every /api/search request. Module-level, mtime-self-invalidating,
NO lock (a stale read at worst re-reads one file)."""
import re
import sys

import server as _s
from server.pure import file_text

_DOC_CACHE: dict = {}


def _doc_text(rel: str, path):
    """The text a doc is searched in, or None if unreadable. For an .html, its visible text
    (not the markup): search and snippets stay readable. read_doc / GET file themselves
    return the raw HTML. For an office file or a PDF, the text inside it."""
    if path.suffix.lower() in file_text.EXTS:
        # A scan has no text: kept as empty (found by its name only) rather than read again.
        return file_text.extract(path) or ""
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    if rel.lower().endswith(".html"):
        return _s._html_to_text(content)
    # A big .csv is searched in its head only: the cache holds it for good.
    return content if rel.lower().endswith(".md") else content[:file_text.MAX_CHARS]


def _doc_entry(rel: str, path, stamp=None):
    """Returns a cached {content_n, name_n, tokens, length, mtime}, reloaded only if the
    file changed. `stamp` is its (mtime_ns, size) when the caller already has it from the walk
    of the content: a stat per file per search was most of a search's time on Windows. None if
    the file cannot be read. The text itself is not kept: it was a third of the cache, and
    only the few hits of a search read it (_doc_text)."""
    if stamp is None:
        try:
            st = path.stat()
        except OSError:
            return None
        stamp = (st.st_mtime_ns, st.st_size)
    ent = _DOC_CACHE.get(rel)
    if ent is not None and ent["stamp"] == stamp:
        return ent
    content = _doc_text(rel, path)
    if content is None:
        return None
    content_n = _s._normalize_text(content)
    ent = {
        "stamp": stamp,
        "mtime": stamp[0] / 1e9,
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
