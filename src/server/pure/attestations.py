"""Confirmations: a reader's word that a document still holds, so that a doc nobody needed to
touch stops reading as outdated. A git-tracked JSON at ROOT/.attestations.json, like the
contradiction verdicts: an entry binds to the text it confirmed and falls when that text
changes. 'holds' counts as a fresh look for the stale audit, and each confirmation in a row
doubles the time before the next one; 'outdated' flags the doc for an update until it is edited.
Pure IO; CONFIG read at call time."""
import json
import time

import server as _s

VERDICTS = ("holds", "outdated")
_MAX_STREAK = 4  # at stale's 6 months: then 1, 2 and at most 4 years between reviews


def _file():
    return _s.CONFIG.root / ".attestations.json"


def load() -> dict:
    """{doc path: its latest confirmation} (empty on a missing or unreadable file)."""
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = data.get("attestations") if isinstance(data, dict) else None
    return {e["path"]: e for e in entries or [] if isinstance(e, dict) and e.get("path")}


def current(entry, text: str):
    """The entry while the doc still reads as it did when confirmed, else None."""
    return entry if entry and entry.get("hash") == _s.doc_hash(text) else None


def record(path: str, text: str, verdict: str, by: str, note: str = ""):
    """Store a verdict on the doc's current text and return the file, for the caller to commit."""
    entries = load()
    previous = current(entries.get(path), text)
    streak = 0
    if verdict == "holds":
        held = previous and previous.get("verdict") == "holds"
        streak = min((previous.get("streak", 1) if held else 0) + 1, _MAX_STREAK)
    entries[path] = {"path": path, "verdict": verdict, "hash": _s.doc_hash(text), "by": by,
                     "note": (note or "")[:500], "at": int(time.time()), "streak": streak}
    _file().write_text(json.dumps({"version": 1, "attestations": [entries[p] for p in sorted(entries)]},
                                  ensure_ascii=False, indent=1), encoding="utf-8")
    return _file()


def fresh_until(entry, threshold: int) -> int:
    """When a confirmed doc is due for another look: the threshold (seconds) after the
    confirmation, doubled for each one in a row before it."""
    return entry["at"] + threshold * 2 ** (max(entry.get("streak", 1), 1) - 1)
