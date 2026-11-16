"""CLI token kill switch: `atlas token revoke-all --acts-as <email>` revokes EVERY
token bound to a human at once (matched by acts_as, whatever the token's email scheme)."""
import sys
import tempfile
import time
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

    def test_revoke_all_also_kills_an_oauth_grants_refresh_tokens(self):
        # Before 2.9.3 it only cleared the access token: the client refreshed its way back.
        _, _, refresh = self.fs.save_oauth_grant("https://claude.ai/client", "Claude", "alice@test.local",
                                                 ["read"], "https://mind/mcp", 3600, 86400)
        cli.cmd_token_revoke_all(SimpleNamespace(dir=".", acts_as="alice@test.local"))
        self.assertIsNone(self.fs.rotate_oauth_refresh(store.hash_api_token(refresh),
                                                       "https://claude.ai/client", 3600, 86400))

    def test_oauth_sessions_are_capped(self):
        def connect():
            return self.fs.save_oauth_grant("https://claude.ai/client", "Claude", "bob@test.local",
                                            ["read"], "https://mind/mcp", 3600, 86400)[1]
        first = connect()
        time.sleep(1.1)  # sessions are ordered by the second they were last used
        for _ in range(store.MAX_OAUTH_SESSIONS):
            last = connect()
        self.assertIsNone(self.fs.find_api_identity(store.hash_api_token(first)))
        self.assertIsNotNone(self.fs.find_api_identity(store.hash_api_token(last)))

    def test_argparse_wires_the_command(self):
        ns = cli.build_parser().parse_args(
            ["token", "revoke-all", ".", "--acts-as", "x@y.z"])
        self.assertIs(ns.func, cli.cmd_token_revoke_all)
        self.assertEqual(ns.acts_as, "x@y.z")


if __name__ == "__main__":
    unittest.main()
