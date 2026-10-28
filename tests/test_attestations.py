"""Tests of confirmations (confirm_doc): a reviewed doc leaves the stale audit, for twice as long
each time it is confirmed in a row, until its text changes; one flagged outdated waits in
stale's `outdated` list for an edit. The mind's first commit is dated 2025 so its docs are stale.
"""
import json
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_mcp_tools import _call  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402

MIND = {
    "accueil.md": "# Accueil\n",
    "specs/relances.md": "# Relances\n\nTrois relances, à J+1, J+3 et J+7.\n",
    "specs/tarifs.md": "# Tarifs\n\nLe plan Pro est à 29 €.\n",
}


class TestConfirmations(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND, seed_date="2025-01-15T12:00:00")
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def call(self, tool, **args):
        return _call(self.srv, self.token, tool, args)

    def stale(self):
        _, data = self.call("stale")
        return [s["path"] for s in data["stale"]], [o["path"] for o in data["outdated"]]

    def test_a_confirmed_doc_leaves_the_audit(self):
        self.assertIn("specs/relances.md", self.stale()[0])
        err, data = self.call("confirm_doc", path="specs/relances.md", verdict="holds", ai="claude")
        self.assertFalse(err, data)
        self.assertEqual(data["in_a_row"], 1)
        again = self.call("confirm_doc", path="specs/relances.md", verdict="holds", ai="claude")[1]
        self.assertEqual(again["in_a_row"], 2)  # confirmed again: twice as long before the next look
        self.assertGreater(again["next_review"], data["next_review"])
        stale, _ = self.stale()
        self.assertNotIn("specs/relances.md", stale)
        self.assertIn("specs/tarifs.md", stale)

    def test_an_edit_clears_the_confirmation(self):
        self.call("confirm_doc", path="specs/relances.md", verdict="holds", ai="claude")
        err, _ = self.call("edit_doc", path="specs/relances.md", old_string="J+7", new_string="J+10", ai="claude")
        self.assertFalse(err)
        data = self.call("confirm_doc", path="specs/relances.md", verdict="holds", ai="claude")[1]
        self.assertEqual(data["in_a_row"], 1)  # a new text starts a new run

    def test_an_outdated_doc_waits_for_an_edit(self):
        err, _ = self.call("confirm_doc", path="specs/tarifs.md", verdict="outdated", note="le Pro est passé à 35 €")
        self.assertFalse(err)
        stale, outdated = self.stale()
        self.assertNotIn("specs/tarifs.md", stale)
        self.assertEqual(outdated, ["specs/tarifs.md"])
        self.call("edit_doc", path="specs/tarifs.md", old_string="29 €", new_string="35 €", ai="claude")
        self.assertEqual(self.stale()[1], [])

    def test_who_confirmed(self):
        self.call("confirm_doc", path="specs/relances.md", verdict="holds", ai="claude")
        self.call("confirm_doc", path="specs/tarifs.md", verdict="holds")  # a click relayed by a view
        stored = json.loads((Path(self.srv.root) / ".attestations.json").read_text(encoding="utf-8"))
        self.assertEqual({e["path"]: e["by"] for e in stored["attestations"]},
                         {"specs/relances.md": "claude", "specs/tarifs.md": "human"})
        log = self.srv.git("log", "-1", "--format=%s%n%(trailers:key=X-Atlas-Author,valueonly)").stdout
        self.assertIn("confirmed: tarifs", log)
        self.assertNotIn("ai/", log)  # the user's own click is not an AI's

    def test_errors(self):
        self.assertTrue(self.call("confirm_doc", path="specs/relances.md", verdict="maybe")[0])
        self.assertTrue(self.call("confirm_doc", path="specs/absent.md", verdict="holds")[0])


if __name__ == "__main__":
    unittest.main()
