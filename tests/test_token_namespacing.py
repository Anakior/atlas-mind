"""Per-owner token namespacing + binding: create_api_identity binds a token to its
owner (acts_as) and derives a per-owner identity email — so two people can each label a
token "claude" without colliding, and nobody can regenerate/hijack another's by reusing
the label."""
import sys
import tempfile
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import store  # noqa: E402


class TestTokenNamespacing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fs = store.FileStore(self.tmp.name)

    def test_owner_bound_token_is_namespaced(self):
        meta, _ = self.fs.create_api_identity("claude", acts_as="alice@x")
        self.assertEqual(meta["acts_as"], "alice@x")
        self.assertNotEqual(meta["email"], "claude@api.local")
        self.assertTrue(meta["email"].endswith(".api.local"))

    def test_two_owners_same_label_dont_collide(self):
        a, _ = self.fs.create_api_identity("claude", acts_as="alice@x")
        b, _ = self.fs.create_api_identity("claude", acts_as="bob@x")
        self.assertNotEqual(a["email"], b["email"])
        self.assertEqual(self.fs.get_user_by_email(a["email"]).get("acts_as"), "alice@x")
        self.assertEqual(self.fs.get_user_by_email(b["email"]).get("acts_as"), "bob@x")

    def test_unbound_token_keeps_legacy_email(self):
        meta, _ = self.fs.create_api_identity("claude")
        self.assertEqual(meta["email"], "claude@api.local")
        self.assertIsNone(meta.get("acts_as"))


if __name__ == "__main__":
    unittest.main()
