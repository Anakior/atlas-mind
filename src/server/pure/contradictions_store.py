"""Verdict cache for contradiction pairs (13c feedback loop). A single git-tracked
JSON at ROOT/.contradictions.json — NOT under .atlas/ (that dir is git-excluded as it
holds the secret registry). A verdict is valid only while BOTH docs' content hashes are
unchanged: edit either doc and its pairs resurface for re-judgment. Verdict ∈ {real, none}
('contenu périmé' is a separate axis → the stale tool). Pure IO; CONFIG read at call time."""
import hashlib
import json
import time

import server as _s

VERDICTS = ("real", "none")


def _cache_path():
    return _s.CONFIG.root / ".contradictions.json"


def doc_hash(text: str) -> str:
    """Short content fingerprint: a doc edit changes it → the pair's verdict invalidates."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _pair(a: str, b: str):
    """Normalized pair key (order-independent): (a, b) and (b, a) are the same pair."""
    return (a, b) if a < b else (b, a)


def load_verdicts() -> list:
    """All cached verdict entries (empty on missing/unreadable file)."""
    p = _cache_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entries = data.get("verdicts") if isinstance(data, dict) else data
    return entries if isinstance(entries, list) else []


def verdict_index(entries=None) -> dict:
    """{(a, b): entry} for O(1) lookup, keyed by the normalized pair."""
    return {_pair(e["a"], e["b"]): e for e in (entries or load_verdicts())
            if e.get("a") and e.get("b")}


def valid_verdict(entry: dict, a_hash: str, b_hash: str):
    """The cached verdict string if both hashes still match, else None (stale → resurface)."""
    if not entry:
        return None
    want = _pair(entry["a"], entry["b"])
    got_a, got_b = (a_hash, b_hash) if entry["a"] == want[0] else (b_hash, a_hash)
    if entry.get("a_hash") == got_a and entry.get("b_hash") == got_b:
        return entry.get("verdict")
    return None


def line_hashes(text: str) -> set:
    """Content hashes of the non-blank lines of a doc, for span-bound verdict checks."""
    return {doc_hash(line.strip()) for line in text.splitlines() if line.strip()}


def set_verdict(a, b, verdict, a_hash, b_hash, by, note="", a_span="", b_span=""):
    """Upsert a pair's verdict (keyed normalized) and persist. Returns the cache file path
    so the caller can commit it. Stores the doc hashes; if the judged line spans are given,
    stores their content hashes too so the verdict survives edits ELSEWHERE in the doc."""
    na, nb = _pair(a, b)
    if a == na:
        ha, hb, sa, sb = a_hash, b_hash, a_span, b_span
    else:
        ha, hb, sa, sb = b_hash, a_hash, b_span, a_span
    entries = [e for e in load_verdicts() if _pair(e.get("a"), e.get("b")) != (na, nb)]
    entry = {"a": na, "b": nb, "verdict": verdict, "a_hash": ha, "b_hash": hb,
             "by": by, "note": (note or "")[:500], "at": int(time.time())}
    if sa and sb:
        entry["a_span"], entry["b_span"] = sa, sb
    entries.append(entry)
    _cache_path().write_text(
        json.dumps({"version": 1, "verdicts": entries}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    return _cache_path()


def verdict_holds(entry, a_doc_hash, b_doc_hash, a_line_hashes=frozenset(), b_line_hashes=frozenset()):
    """The cached verdict if it still applies, else None. When the entry recorded the judged
    spans, it holds as long as those line contents still exist in each doc — an edit ELSEWHERE
    no longer resurfaces the pair; otherwise it falls back to whole-doc hash equality. The
    caller passes the (a, b) doc data in the entry's normalized order (a < b)."""
    if not entry:
        return None
    sa, sb = entry.get("a_span"), entry.get("b_span")
    if sa and sb:
        return entry.get("verdict") if sa in a_line_hashes and sb in b_line_hashes else None
    if entry.get("a_hash") == a_doc_hash and entry.get("b_hash") == b_doc_hash:
        return entry.get("verdict")
    return None
