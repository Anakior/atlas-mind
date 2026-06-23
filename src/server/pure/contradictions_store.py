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


def set_verdict(a, b, verdict, a_hash, b_hash, by, note=""):
    """Upsert a pair's verdict (keyed normalized) and persist. Returns the cache file path
    so the caller can commit it. Stores hashes so the entry self-invalidates on doc edits."""
    na, nb = _pair(a, b)
    ha, hb = (a_hash, b_hash) if a == na else (b_hash, a_hash)
    entries = [e for e in load_verdicts() if _pair(e.get("a"), e.get("b")) != (na, nb)]
    entries.append({"a": na, "b": nb, "verdict": verdict, "a_hash": ha, "b_hash": hb,
                    "by": by, "note": (note or "")[:500], "at": int(time.time())})
    _cache_path().write_text(
        json.dumps({"version": 1, "verdicts": entries}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    return _cache_path()
