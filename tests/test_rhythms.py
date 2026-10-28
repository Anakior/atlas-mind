"""Tests of the periodic documents (server/pure/rhythms.py): the period read from a file name, the
series it builds, and the periods missed since the last one. No server: the doc list is given."""
import datetime as dt
import sys
import unittest
from pathlib import Path
from unittest import mock

_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from server.pure import rhythms  # noqa: E402

TODAY = dt.date(2026, 10, 28)


def missed(*paths):
    with mock.patch.object(rhythms._s, "_iter_doc_files", lambda: iter((p, None) for p in paths)), \
            mock.patch.object(rhythms, "_visible", lambda rel, ctx: True):
        return {s["series"]: s for s in rhythms.missed(today=TODAY)}


class TestPeriods(unittest.TestCase):
    def test_read_from_the_name(self):
        def read(stem):
            found = rhythms._period(stem)
            return found and rhythms.label(found[0], found[1])
        self.assertEqual(read("bilan-activite-juin-2026"), "2026-06")
        self.assertEqual(read("bilan-sept-2026"), "2026-09")
        self.assertEqual(read("report-december-2025"), "2025-12")
        self.assertEqual(read("bilan-activite-q3-2025"), "2025-Q3")
        self.assertEqual(read("revue-t1-2026"), "2026-Q1")
        self.assertEqual(read("2026-q2-review"), "2026-Q2")
        self.assertEqual(read("2026-04-notes"), "2026-04")
        for stem in ("grammar-2026", "plan-lot-3", "2026-04-12-journal", "summary"):
            self.assertFalse(read(stem), stem)


class TestMissed(unittest.TestCase):
    def test_a_monthly_series_stopped_in_june(self):
        late = missed("bilans/bilan-mars-2026-final.md", "bilans/bilan-avril-2026.md",
                      "bilans/bilan-mai-2026.md", "bilans/bilan-juin-2026.md")
        self.assertEqual(late["bilans/bilan"]["missed"], ["2026-07", "2026-08", "2026-09"])  # October is not due yet
        self.assertEqual(late["bilans/bilan"]["last"], {"period": "2026-06", "path": "bilans/bilan-juin-2026.md"})

    def test_quarters(self):
        late = missed(*(f"revues/bilan-q{q}-2025.md" for q in (1, 2, 3, 4)), "revues/bilan-q1-2026.md")
        self.assertEqual(late["revues/bilan"]["missed"], ["2026-Q2", "2026-Q3"])
        self.assertEqual(late["revues/bilan"]["every"], "quarter")

    def test_what_is_not_late(self):
        late = missed("a/report-july-2026.md", "a/report-august-2026.md", "a/report-september-2026.md",  # on time
                      "b/bilan-janvier-2025.md", "b/bilan-fevrier-2025.md", "b/bilan-mars-2025.md",  # long stopped
                      "c/bilan-mai-2026.md", "c/bilan-juin-2026.md")  # two are not a series
        self.assertEqual(late, {})


if __name__ == "__main__":
    unittest.main()
