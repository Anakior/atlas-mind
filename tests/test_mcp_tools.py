"""Tests of the AI-native MCP graph / tag / trash tools.

Tools added on top of the original 7:
- get_links / get_backlinks  — wikilink graph traversal
- get_mind_topology          — aggregate bird's-eye overview
- list_by_tag                — browse by tag (+ a tag filter on search_docs)
- delete_doc                 — SOFT delete to .trash/ (reversible, never erased)

MCP requires an 'api'-role Bearer token, so these run under the cloud-mode
harness (KB_AUTH_ENABLED=1 + ATLAS_STORE=file), like test_cloud_filestore.

DEFAULT_MIND wikilink graph (what the assertions rely on):
  accueil.md      → [[projets/alpha]] , [[beta|…]]      (out: alpha, beta)
  projets/alpha.md→ [[accueil]] , [[projets/beta.md]]   (out: accueil, beta)
  projets/beta.md → (none)                               (in: accueil, alpha)
Folder tags: projets/* → ['projets']; accueil.md → [].
"""
import hashlib
import json
import secrets
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, file_store_of, API_EMAIL, ADMIN_EMAIL  # noqa: E402


def _seed_api_token(srv):
    token = secrets.token_hex(32)
    fs = file_store_of(srv)
    # Model B: a token is bound to a human via acts_as. Here it acts as the admin
    # so the write tools (delete_doc, doc_revert, move_doc) are authorized.
    fs.upsert_user(ADMIN_EMAIL, {"role": "admin"})
    fs.upsert_user(API_EMAIL, {
        "role": "api",
        "api_token_hash": hashlib.sha256(token.encode()).hexdigest(),
        "password_hash": "$2b$12$" + "x" * 53,  # unusable sentinel
        "acts_as": ADMIN_EMAIL,
    })
    return token


def _call(srv, token, tool, arguments=None):
    """Call an MCP tool. Returns (is_error, parsed_json_or_raw_text)."""
    resp = srv.post(f"/mcp/{token}", json_body={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments or {}},
    })
    assert resp.status == 200, f"HTTP {resp.status}"
    result = resp.json()["result"]
    text = result["content"][0]["text"]
    is_error = bool(result.get("isError"))
    try:
        return is_error, json.loads(text)
    except (ValueError, TypeError):
        return is_error, text


class TestMcpGraphAndTags(unittest.TestCase):
    """Read-only tools → one server shared per class."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.token = _seed_api_token(cls.srv)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_tools_list_advertises_new_tools(self):
        resp = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        names = {t["name"] for t in resp.json()["result"]["tools"]}
        for tool in ("get_links", "get_backlinks", "get_mind_topology",
                     "list_by_tag", "delete_doc"):
            self.assertIn(tool, names)

    def test_get_links_returns_outgoing(self):
        err, data = _call(self.srv, self.token, "get_links", {"path": "accueil.md"})
        self.assertFalse(err)
        self.assertEqual(set(data["links"]), {"projets/alpha.md", "projets/beta.md"})

    def test_get_backlinks_returns_incoming(self):
        err, data = _call(self.srv, self.token, "get_backlinks", {"path": "projets/beta.md"})
        self.assertFalse(err)
        self.assertEqual(set(data["backlinks"]), {"accueil.md", "projets/alpha.md"})

    def test_get_links_unknown_doc_is_error(self):
        err, _ = _call(self.srv, self.token, "get_links", {"path": "nope/missing.md"})
        self.assertTrue(err)

    def test_get_links_isolated_doc_returns_empty(self):
        # beta has no OUTGOING links → clean empty list, not an error.
        err, data = _call(self.srv, self.token, "get_links", {"path": "projets/beta.md"})
        self.assertFalse(err)
        self.assertEqual(data["links"], [])

    def test_list_by_tag(self):
        err, data = _call(self.srv, self.token, "list_by_tag", {"tag": "projets"})
        self.assertFalse(err)
        self.assertEqual(set(data["documents"]), {"projets/alpha.md", "projets/beta.md"})

    def test_list_by_tag_unknown_returns_none(self):
        err, text = _call(self.srv, self.token, "list_by_tag", {"tag": "does-not-exist"})
        self.assertFalse(err)
        self.assertIn("No document tagged", text)

    def test_mind_topology_overview(self):
        err, data = _call(self.srv, self.token, "get_mind_topology")
        self.assertFalse(err)
        self.assertGreaterEqual(data["counts"]["docs"], 3)
        self.assertGreater(data["counts"]["edges"], 0)
        self.assertIn("projets/beta.md", [h["path"] for h in data["hubs"]])  # most referenced
        self.assertIn({"tag": "projets", "count": 2}, data["top_tags"])

    def test_search_docs_tag_filter_is_additive(self):
        # 'accueil' matches accueil.md (untagged) AND projets/alpha.md (tag projets).
        _, unfiltered = _call(self.srv, self.token, "search_docs", {"q": "accueil"})
        self.assertIn("accueil.md", [h["path"] for h in unfiltered])
        _, filtered = _call(self.srv, self.token, "search_docs",
                            {"q": "accueil", "tag": "projets"})
        paths = [h["path"] for h in filtered]
        self.assertNotIn("accueil.md", paths)        # untagged doc filtered out
        self.assertIn("projets/alpha.md", paths)     # tagged doc kept


class TestMcpDeleteDoc(unittest.TestCase):
    """delete_doc mutates the mind → a FRESH server per test."""

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.token = _seed_api_token(self.srv)

    def tearDown(self):
        self.srv.stop()

    def test_delete_moves_to_trash_not_erased(self):
        rel = "projets/beta.md"
        self.assertTrue(self.srv.path(rel).exists())
        err, text = _call(self.srv, self.token, "delete_doc", {"path": rel})
        self.assertFalse(err)
        self.assertIn("trash", text.lower())
        # Gone from its place, but recoverable under .trash/ (NOT erased).
        self.assertFalse(self.srv.path(rel).exists())
        self.assertTrue(self.srv.path(".trash/" + rel).exists())
        self.assertIn("Projet B", self.srv.path(".trash/" + rel).read_text(encoding="utf-8"))

    def test_delete_remote_mirror_is_refused(self):
        err, text = _call(self.srv, self.token, "delete_doc", {"path": "remotes/x/foo.md"})
        self.assertTrue(err)
        self.assertIn("Read-only", text)

    def test_delete_unknown_is_error(self):
        err, _ = _call(self.srv, self.token, "delete_doc", {"path": "nope/missing.md"})
        self.assertTrue(err)

    def test_delete_rejects_traversal(self):
        err, text = _call(self.srv, self.token, "delete_doc", {"path": "../evasion.md"})
        self.assertTrue(err)
        self.assertIn("Invalid path", text)


if __name__ == "__main__":
    unittest.main()
