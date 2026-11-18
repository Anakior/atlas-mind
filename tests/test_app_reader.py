"""The reader view (ui://atlas/reader on open_doc), rendered by the stand-in host on the plan of
test_reader: what changed while the reader was away, the ghosts, a passage's life, the wheel,
a confirmation, a link followed, and the move beside the conversation.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from appview import ViewTestCase  # noqa: E402
from test_reader import MIND, SEED_DATE, rework  # noqa: E402


class TestReaderView(ViewTestCase):
    MIND, VIEW, TOOL, SEED_DATE = MIND, "ui://atlas/reader", "open_doc", SEED_DATE

    def setUp(self):
        super().setUp()
        rework(self.srv)

    def test_served_whole(self):
        content = self.assert_served()
        self.assertIn("DOMPurify", content["text"])  # what a doc holds is shown, never run
        self.assertEqual(content["_meta"]["ui"]["preferredDisplayMode"], "fullscreen")

    def test_reading_with_the_history(self):
        report = self.host({"path": "notes/plan.md"})
        self.assertEqual(report["title"], "Plan")
        self.assertEqual(report["changed"], 2)
        self.assertEqual(report["ghosts"], 1)  # the one removed while away
        self.assertIn("Claude", report["banner"])
        self.assertIn("Risks", report["ghost_text"])
        self.assertGreaterEqual(report["all_ghosts"], report["ghosts"])
        self.assertEqual(len(report["life"]), 2)  # written with the plan, rewritten in place by Claude
        self.assertTrue(report["past"])
        self.assertGreater(report["struck"], 0)
        self.assertTrue(report["validated"])
        self.assertEqual(report["followed"], "Roadmap")
        self.assertEqual(report["expand"], 1)
        self.assertEqual(report["moved"], "full")
        sent = {m["method"] for m in report["log"]}
        self.assertTrue({"ui/message", "ui/update-model-context", "ui/request-display-mode"} <= sent)
        calls = [m["params"]["name"] for m in self.sent(report, "tools/call")]
        self.assertEqual(calls, ["confirm_doc", "open_doc"])
        confirm = self.sent(report, "tools/call")[0]["params"]["arguments"]
        self.assertNotIn("ai", confirm)  # the person's own decision

    def test_dark_and_narrow(self):
        report = self.host({"path": "notes/plan.md"}, theme="dark")
        self.assertEqual(report["changed"], 2)


if __name__ == "__main__":
    unittest.main()
