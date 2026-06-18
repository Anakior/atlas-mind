"""Integration: the MCP + Bearer channels honor the per-document ACL (model B).

The hole this closes: before, ANY api/MCP token read the entire mind. Now a token
sees the commons and what it is granted, but NEVER a private (owned) doc — unless
the token is bound (`acts_as`) to the owner. Run: python tests/test_acl_mcp.py
"""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer, TODO_REL, DEFAULT_QUICK_MD  # noqa: E402
import store  # noqa: E402

OWNER_EMAIL = "owner@acl.local"

MIND = {
    "public/note.md": "# Public\n\nterme-public visible de tous.\n",
    "secret/private.md": "# Secret\n\nterme-secret-prive a cacher.\n",
    TODO_REL: DEFAULT_QUICK_MD,
}

CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "acl-mcp-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}


class TestMcpBearerAcl(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=MIND, extra_env=CLOUD_ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        # The owner of the private doc (exists so acts_as can resolve to it).
        fs.upsert_user(OWNER_EMAIL, {"role": "viewer"})
        # secret/private.md is private to OWNER (model B: an owned path is private).
        fs.set_owner("secret/private.md", "user:" + OWNER_EMAIL)
        # A bare api token (unbound → commons member, no private access).
        _, cls.bare_token = fs.create_api_identity("bare-bot")
        # A token bound to the owner via acts_as → inherits the owner's view.
        meta, cls.bound_token = fs.create_api_identity("owner-bot")
        fs.upsert_user(meta["email"], {"acts_as": OWNER_EMAIL})

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    # ── helpers ───────────────────────────────────────────────────────────
    def _mcp_text(self, token, name, args):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": args}}
        resp = self.srv.post(f"/mcp/{token}", json_body=body)
        self.assertEqual(resp.status, 200, f"{name} -> HTTP {resp.status}")
        return resp.json()["result"]["content"][0]["text"]

    def _bearer(self, token):
        return {"Authorization": "Bearer " + token}

    # ── read_doc (no-existence-oracle) ────────────────────────────────────
    def test_bare_token_reads_commons_not_private(self):
        ok = self._mcp_text(self.bare_token, "read_doc", {"path": "public/note.md"})
        self.assertIn("terme-public", ok)
        out = self._mcp_text(self.bare_token, "read_doc", {"path": "secret/private.md"})
        self.assertNotIn("terme-secret-prive", out)      # content never leaks
        self.assertIn("not found", out.lower())          # same as a missing doc

    def test_bound_token_reads_private(self):
        txt = self._mcp_text(self.bound_token, "read_doc", {"path": "secret/private.md"})
        self.assertIn("terme-secret-prive", txt)

    # ── search_docs ───────────────────────────────────────────────────────
    def test_search_hides_private_from_bare_token(self):
        out = self._mcp_text(self.bare_token, "search_docs", {"q": "terme-secret-prive"})
        self.assertNotIn("secret/private.md", out)

    def test_search_finds_private_for_bound_token(self):
        out = self._mcp_text(self.bound_token, "search_docs", {"q": "terme-secret-prive"})
        self.assertIn("secret/private.md", out)

    # ── list_tree ─────────────────────────────────────────────────────────
    def test_list_tree_prunes_private_for_bare_token(self):
        out = self._mcp_text(self.bare_token, "list_tree", {})
        self.assertIn("public/note.md", out)
        self.assertNotIn("secret/private.md", out)

    # ── Bearer REST parity (same hole, same fix) ──────────────────────────
    def test_bearer_file_404_on_private_for_bare(self):
        self.assertEqual(self.srv.get(
            "/api/v1/file?path=secret/private.md", headers=self._bearer(self.bare_token)).status, 404)
        self.assertEqual(self.srv.get(
            "/api/v1/file?path=public/note.md", headers=self._bearer(self.bare_token)).status, 200)

    def test_bearer_file_ok_on_private_for_bound(self):
        self.assertEqual(self.srv.get(
            "/api/v1/file?path=secret/private.md", headers=self._bearer(self.bound_token)).status, 200)

    def test_bearer_search_hides_private_from_bare(self):
        res = self.srv.get("/api/v1/search?q=terme-secret-prive",
                           headers=self._bearer(self.bare_token)).json()
        self.assertFalse(any(r.get("path") == "secret/private.md" for r in res))

    # ── invalid token still rejected ──────────────────────────────────────
    def test_invalid_mcp_token_401(self):
        resp = self.srv.post("/mcp/" + "0" * 40,
                             json_body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual(resp.status, 401)


if __name__ == "__main__":
    unittest.main()
