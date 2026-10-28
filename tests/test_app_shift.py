"""Tests of the then-and-now view (MCP Apps): show_shift names it, the server serves it, and the
stand-in host renders it on a live result: each claim then and now with what happened to it, the
days the topic moved, the docs still saying the old; then the user asks why they thought so,
has the lagging docs updated and compares with another day. See appview.py.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from appview import ViewTestCase  # noqa: E402
from test_then_and_now import LAGGING, MIND, SEED_DATE, SHIFTS, change_of_mind  # noqa: E402


class TestShiftView(ViewTestCase):
    MIND, VIEW, TOOL, SEED_DATE = MIND, "ui://atlas/shift", "show_shift", SEED_DATE

    def setUp(self):
        super().setUp()
        change_of_mind(self.srv)

    def test_the_tool_names_its_view(self):
        self.assert_served()

    def test_then_and_now(self):
        report = self.host({"topic": "embeddings", "at": "2025-02-01", "shifts": SHIFTS, "lagging": LAGGING},
                           theme="dark")
        self.assertEqual(report["title"], "embeddings, then and now")
        self.assertEqual(report["badges"], ["Reversed", "Dropped", "New", "Held"])
        self.assertEqual(len(report["quotes"]), 6)  # nothing now for the dropped one, nothing then for the new
        self.assertEqual(report["empty"], 2)
        self.assertEqual(report["moments"], 2)
        self.assertEqual(report["lagging"], ["Embeddings: an opt-in extension."])
        why, update, compare = [m["params"]["content"][0]["text"] for m in self.sent(report, "ui/message")]
        self.assertIn("Why did I think that on 2025-02-01?", why)
        self.assertIn("The embeddings come as an opt-in extension", why)
        self.assertNotIn("never embeddings", why)  # what the mind says now stays out of it
        self.assertIn("notes/roadmap.md", update)
        self.assertIn("2025-01-15", compare)


if __name__ == "__main__":
    unittest.main()
