"""Periodic documents (a monthly report, a quarterly review…) and the periods that went missing
since the last one. The period is read from the file name: git dates can't tell, since a mind
gets imported and reorganised in batches. A series is three periods or more of one kind under
one name in one folder; one that has missed too many in a row is taken as stopped, not late."""
import datetime as dt
import re
from collections import defaultdict

import server as _s
from server.pure.queries import _visible

_MONTHS = {
    "janvier": 1, "january": 1, "jan": 1, "fevrier": 2, "février": 2, "february": 2, "feb": 2, "fev": 2,
    "fév": 2, "mars": 3, "march": 3, "mar": 3, "avril": 4, "april": 4, "apr": 4, "avr": 4, "mai": 5,
    "may": 5, "juin": 6, "june": 6, "jun": 6, "juillet": 7, "july": 7, "jul": 7, "juil": 7, "aout": 8,
    "août": 8, "august": 8, "aug": 8, "septembre": 9, "september": 9, "sept": 9, "sep": 9,
    "octobre": 10, "october": 10, "oct": 10, "novembre": 11, "november": 11, "nov": 11,
    "decembre": 12, "décembre": 12, "december": 12, "dec": 12, "déc": 12,
}
_NAME = "|".join(sorted(_MONTHS, key=len, reverse=True))
_PERIODS = (  # (kind, pattern): quarter before month, so "q3-2026" isn't read as a month
    ("quarter", re.compile(r"(?<![a-z0-9])[qt]([1-4])[-_ ]?(\d{4})(?!\d)")),
    ("quarter", re.compile(r"(?<!\d)(\d{4})[-_ ]?[qt]([1-4])(?![a-z0-9])")),
    ("month", re.compile(rf"(?<![a-zé])({_NAME})[-_ ]?(\d{{4}})(?!\d)")),
    ("month", re.compile(r"(?<!\d)(\d{4})[-_](0[1-9]|1[0-2])(?![-_]?\d)")),
)
_SPAN = {"month": 1, "quarter": 3}  # months per period
_GRACE_DAYS = {"month": 10, "quarter": 20}  # a report is written after its period ends
_STOPPED_AFTER = {"month": 6, "quarter": 4}  # missed in a row: the rhythm is over, not late


def _period(stem: str):
    """(kind, index in months since year 0, the stem around it) for the period a name carries."""
    for kind, pattern in _PERIODS:
        m = pattern.search(stem)
        if not m:
            continue
        a, b = m.groups()
        if kind == "quarter":
            year, q = (int(b), int(a)) if len(a) == 1 else (int(a), int(b))
            index = year * 12 + (q - 1) * 3
        elif a.isdigit():
            index = int(a) * 12 + int(b) - 1
        else:
            index = int(b) * 12 + _MONTHS[a] - 1
        return kind, index, stem[:m.start()], stem[m.end():]
    return None


def label(kind: str, index: int) -> str:
    year, month = divmod(index, 12)
    return f"{year}-Q{month // 3 + 1}" if kind == "quarter" else f"{year}-{month + 1:02d}"


def _end(index: int, kind: str) -> dt.date:
    """The day after the period."""
    year, month = divmod(index + _SPAN[kind], 12)
    return dt.date(year, month + 1, 1)


def missed(ctx=None, today=None) -> list:
    """The late series, most periods missed first: [{series, every, last: {period, path}, missed: [period…]}]."""
    today = today or dt.date.today()
    groups = defaultdict(dict)
    for rel, _ in _s._iter_doc_files():
        if not rel.endswith(".md") or not _visible(rel, ctx):
            continue
        folder, _, name = rel.rpartition("/")
        found = _period(name[:-3].lower())
        if found:
            kind, index, before, after = found
            # Variants of one period ("…-mars-2026-final") stay in the series, under its first name.
            groups[(folder, kind, before.strip("-_ ") or after.strip("-_ "))].setdefault(index, rel)
    out = []
    for (folder, kind, name), periods in groups.items():
        if len(periods) < 3:
            continue
        last = max(periods)
        late = []
        index = last + _SPAN[kind]
        while _end(index, kind) + dt.timedelta(days=_GRACE_DAYS[kind]) <= today:
            late.append(index)
            index += _SPAN[kind]
        if late and len(late) <= _STOPPED_AFTER[kind]:
            out.append({"series": f"{folder}/{name}" if folder else name, "every": kind, "count": len(periods),
                        "last": {"period": label(kind, last), "path": periods[last]},
                        "missed": [label(kind, i) for i in late]})
    return sorted(out, key=lambda s: (-len(s["missed"]), s["series"]))
