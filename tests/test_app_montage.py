"""Tests of the editing room view (MCP Apps): agent_runs names it, the server serves it, and the
stand-in host renders it on a live result: the runs of the last days, an AI's run opened commit
by commit with its diffs, cut from its second commit (a dry run, then the undo), and the save of
what is left asked of Claude. See appview.py.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from appview import ViewTestCase  # noqa: E402
from test_mcp_sessions import ALPHA, MIND  # noqa: E402
from test_mcp_tools import _call  # noqa: E402


class TestMontageView(ViewTestCase):
    MIND, VIEW, TOOL = MIND, "ui://atlas/montage", "agent_runs"

    def setUp(self):
        super().setUp()
        for tool, args in (("edit_doc", {"path": "projets/alpha.md", "old_string": "49", "new_string": "45"}),
                           ("create_doc", {"path": "notes/new.md", "content": "# New\n\nA draft."}),
                           ("move_doc", {"from": "projets/beta.md", "to": "projets/gamma.md"}),
                           ("delete_doc", {"path": "notes/old.md"})):
            _call(self.srv, self.token, tool, dict(args, ai="claude"))

    def test_the_tool_names_its_view(self):
        self.assert_served()

    def test_cut_a_run_from_a_commit(self):
        report = self.host({})
        self.assertEqual(report["title"], "What was written")
        self.assertIn("Claude", report["scenes"])
        self.assertEqual(len(report["scenes"]), 2)  # and the mind's first commit, a person's name
        self.assertIn("without an AI mark", report["lead"][0])  # said once, not on every run
        self.assertEqual(report["scene"], "Claude, " + report["scene"].split(", ", 1)[1])
        self.assertEqual(report["ticks"], 4)
        self.assertIn("+# New", report["diff"])
        self.assertEqual(set(report["confirm"]), {"new", "gamma", "old"})  # the moved doc once, where it is now
        self.assertRegex(report["notice"], r"^Undone in one commit \([0-9a-f]{7,}\)\.$")
        self.assertEqual(set(report["undone"]), {"new", "gamma", "old"})

        # Cut from the second commit: the first one stays, the rest is undone.
        self.assertIn("45 euros", self.srv.path("projets/alpha.md").read_text(encoding="utf-8"))
        self.assertNotEqual(self.srv.path("projets/alpha.md").read_text(encoding="utf-8"), ALPHA)
        self.assertFalse(self.srv.path("notes/new.md").exists())
        self.assertTrue(self.srv.path("projets/beta.md").exists())
        self.assertTrue(self.srv.path("notes/old.md").exists())

        calls = [m["params"] for m in self.sent(report, "tools/call") if m["params"]["name"] == "undo_run"]
        self.assertEqual([c["arguments"].get("dry_run") for c in calls], [True, None])
        self.assertNotIn("ai", calls[1]["arguments"])  # the user's click: the undo is theirs
        context = self.sent(report, "ui/update-model-context")[0]["params"]["content"][0]["text"]
        self.assertIn("From the view, the user undid", context)
        save = self.sent(report, "ui/message")[0]["params"]["content"][0]["text"]
        kept, _, undone = save.partition("Undone from the view")
        self.assertIn("projets/alpha.md", kept)
        self.assertNotIn("notes/new.md", kept)
        self.assertIn("notes/new.md", undone)


if __name__ == "__main__":
    unittest.main()
