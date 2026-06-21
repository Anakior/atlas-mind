"""CLI token kill switch: `atlas token revoke-all --acts-as <email>` revokes EVERY
token bound to a human at once (matched by acts_as, whatever the token's email scheme)."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import cli      # noqa: E402
import store    # noqa: E402


class TestTokenRevokeAll(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fs = store.FileStore(self.tmp.name)
        self.fs.upsert_user("alice@test.local", {"role": "admin", "password_hash": "x"})
        self.fs.upsert_user("bob@test.local", {"role": "viewer", "password_hash": "x"})
        self.fs.create_api_identity("claude", acts_as="alice@test.local")
        self.fs.create_api_identity("gpt", acts_as="alice@test.local")
        self.fs.create_api_identity("claude", acts_as="bob@test.local")
        # Route the command's mind wrappers to our temp store.
        self._orig = (cli._require_mind, cli._load_config, cli._file_store)
        cli._require_mind = lambda d: d
        cli._load_config = lambda m: None
        cli._file_store = lambda c: self.fs

    def tearDown(self):
        cli._require_mind, cli._load_config, cli._file_store = self._orig

    def _active(self, owner):
        return [u for u in self.fs.list_users()
                if u.get("role") == store.API_ROLE
                and u.get("acts_as") == owner and u.get("api_token_hash")]

    def test_revoke_all_kills_only_that_users_tokens(self):
        rc = cli.cmd_token_revoke_all(
            SimpleNamespace(dir=".", acts_as="alice@test.local"))
        self.assertEqual(rc, 0)
        self.assertEqual(self._active("alice@test.local"), [])    # both gone
        self.assertEqual(len(self._active("bob@test.local")), 1)  # bob untouched

    def test_argparse_wires_the_command(self):
        ns = cli.build_parser().parse_args(
            ["token", "revoke-all", ".", "--acts-as", "x@y.z"])
        self.assertIs(ns.func, cli.cmd_token_revoke_all)
        self.assertEqual(ns.acts_as, "x@y.z")


if __name__ == "__main__":
    unittest.main()
