"""Living docs and records. A record tells a moment (a session save, a monthly report, an archived
doc): it never goes out of date, it speaks for a date. So it stays out of the stale audit, the
weather's fog and the contradiction scan, and an agent reading it is told "as of <date>" instead
of taking it for the current state. Sorted without asking, from signals that are sure: a period
in the name, a resume section, an archive folder. A reader's confirm_doc verdict settles it
either way, edits or not: 'record', or 'holds' / 'outdated' for a doc meant to stay true."""
import time

from server.pure import attestations, rhythms, sessions

RECORD = "record"
_ARCHIVES = {"archive", "archives"}


def _day(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def as_of(rel: str, text: str, ts: float = 0, confirmed: dict | None = None) -> str | None:
    """The date a record speaks for ('2026-06', '2026-Q2', '2026-07-24'), or None for a living
    doc. `ts` is its last commit, the date when the doc names none; `confirmed` is
    attestations.load(), passed by a caller that sorts many docs."""
    entry = (attestations.load() if confirmed is None else confirmed).get(rel)
    if entry and entry.get("verdict") != RECORD:
        return None
    folders, _, name = rel.lower().rpartition("/")
    period = rhythms._period(name.rsplit(".", 1)[0])
    if period:
        return rhythms.label(period[0], period[1])
    if sessions._is_save(rel, text):
        footers = sessions._FOOTER_RE.findall(text)
        return footers[-1][0] if footers else _day(ts)
    if entry or _ARCHIVES & set(folders.split("/")):
        return _day(ts)
    return None


def doc_as_of(rel: str, path, ts: float, confirmed: dict | None = None) -> str | None:
    """as_of for a doc on disk, read only when the search cache says it may be a save."""
    try:
        text = path.read_text(encoding="utf-8-sig") if sessions._may_be_save(rel, path) else ""
    except (OSError, UnicodeDecodeError):
        text = ""
    return as_of(rel, text, ts, confirmed)
