"""Tests of the git time-travel MCP tools (the time axis over the mind):

- doc_history   — a doc's revisions newest-first + created/last_modified lifecycle
- doc_at        — full content at a past revision (by SHA) or date (by 'at')
- doc_diff      — what a commit changed (default base = the doc's previous version)
- search_history— pickaxe across ALL history (finds since-deleted text)
- changelog     — corpus-wide recent commit activity with the doc files touched
- doc_blame     — per-line last-change attribution (+ pattern filter)
- doc_revert    — restore a doc to a past revision (write), refused on remotes/

These tools shell out to `git`, so the security guards matter:
- path traversal (../, non-.md/.html) is rejected;
- agent-supplied revs are regex-validated (a flag/injection-looking rev is refused);
- dates go through 'at' and are resolved server-side, never through the rev validator.

MCP needs an 'api'-role Bearer token -> cloud-mode harness, like test_mcp_tools.
History is per-repo shared state: the read-only class makes its commits once in
setUpClass and shares one server; doc_revert mutates, so it gets a fresh server.
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

_DOC = "projets/alpha.md"


def _seed_api_token(srv):
    token = secrets.token_hex(32)
    fs = file_store_of(srv)
    # Model B: the token acts as the admin (acts_as) so doc_revert (a write) is
    # authorized — an unbound token only reads the commons.
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


def _commit(srv, rel, content, message):
    srv.path(rel).write_text(content, encoding="utf-8")
    srv.git("add", "-A")
    srv.git("commit", "-q", "-m", message)


class TestTimeTravelReadTools(unittest.TestCase):
    """Read-only history tools over a doc with a known commit sequence."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.token = _seed_api_token(cls.srv)
        # A 2-step evolution: ZETAMARKER is introduced then deleted (proves the
        # across-time tools see content the present-state index no longer has).
        _commit(cls.srv, _DOC, "# Alpha\n\nintro\nZETAMARKER line\n", "edit: alpha add zeta")
        _commit(cls.srv, _DOC, "# Alpha\n\nintro\nOMEGAMARKER line\n", "edit: alpha zeta->omega")

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _call(self, tool, args=None):
        return _call(self.srv, self.token, tool, args)

    def test_tools_list_advertises_time_travel_tools(self):
        resp = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        names = {t["name"] for t in resp.json()["result"]["tools"]}
        for tool in ("doc_history", "doc_at", "doc_diff", "search_history",
                     "changelog", "doc_blame", "doc_revert"):
            self.assertIn(tool, names)

    def test_doc_history_lists_revisions_newest_first_with_lifecycle(self):
        err, data = self._call("doc_history", {"path": _DOC})
        self.assertFalse(err)
        self.assertEqual(data["path"], _DOC)
        revs = data["revisions"]
        self.assertGreaterEqual(len(revs), 3)  # initial mind + 2 edits
        self.assertEqual(revs[0]["subject"], "edit: alpha zeta->omega")
        self.assertEqual(revs[1]["subject"], "edit: alpha add zeta")
        self.assertTrue(any(r["is_current"] for r in revs))
        # Lifecycle header is present and consistent.
        self.assertIsNotNone(data["created"])
        self.assertIsNotNone(data["last_modified"])
        self.assertEqual(data["last_modified"]["subject"], "edit: alpha zeta->omega")

    def test_doc_history_unknown_doc_is_empty_not_error(self):
        err, data = self._call("doc_history", {"path": "does/not/exist.md"})
        self.assertFalse(err)
        self.assertEqual(data["revisions"], [])
        self.assertIsNone(data["created"])

    def test_doc_at_by_rev_returns_old_content(self):
        revs = self._call("doc_history", {"path": _DOC})[1]["revisions"]
        zeta_sha = next(r["sha"] for r in revs if r["subject"] == "edit: alpha add zeta")
        err, text = self._call("doc_at", {"path": _DOC, "rev": zeta_sha})
        self.assertFalse(err)
        self.assertIn("ZETAMARKER", text)        # the deleted content, as it was then
        self.assertNotIn("OMEGAMARKER", text)

    def test_doc_at_by_date(self):
        # A far-future date resolves to the latest revision...
        err, text = self._call("doc_at", {"path": _DOC, "at": "2099-01-01"})
        self.assertFalse(err)
        self.assertIn("OMEGAMARKER", text)
        # ...a date before the repo existed yields a clean error, not HEAD.
        err, text = self._call("doc_at", {"path": _DOC, "at": "2000-01-01"})
        self.assertTrue(err)
        self.assertIn("No revision", text)

    def test_doc_at_rejects_traversal_and_bad_rev(self):
        err, _ = self._call("doc_at", {"path": "../escape.md", "rev": "HEAD"})
        self.assertTrue(err)
        err, text = self._call("doc_at", {"path": _DOC, "rev": "$(whoami)"})
        self.assertTrue(err)
        self.assertIn("Invalid", text)

    def test_doc_diff_default_base_is_this_commits_change(self):
        # doc_diff(path, rev=HEAD) with no base = what the latest commit changed.
        err, text = self._call("doc_diff", {"path": _DOC})
        self.assertFalse(err)
        self.assertIn("+", text)
        self.assertIn("OMEGAMARKER", text)   # added
        self.assertIn("ZETAMARKER", text)    # removed
        self.assertNotIn("(no changes", text)

    def test_doc_diff_explicit_base(self):
        revs = self._call("doc_history", {"path": _DOC})[1]["revisions"]
        head, parent = revs[0]["sha"], revs[1]["sha"]
        err, text = self._call("doc_diff", {"path": _DOC, "rev": head, "base": parent})
        self.assertFalse(err)
        self.assertIn("OMEGAMARKER", text)

    def test_doc_diff_rejects_bad_rev(self):
        err, text = self._call("doc_diff", {"path": _DOC, "rev": "--output=/tmp/x"})
        self.assertTrue(err)
        self.assertIn("Invalid", text)

    def test_search_history_finds_since_deleted_text(self):
        # ZETAMARKER no longer exists in the current corpus, but pickaxe finds the
        # commits where it entered/left history. This has no present-state equivalent.
        err, data = self._call("search_history", {"query": "ZETAMARKER"})
        self.assertFalse(err)
        self.assertGreaterEqual(len(data["matches"]), 1)
        paths = {f["path"] for m in data["matches"] for f in m["files"]}
        self.assertIn(_DOC, paths)

    def test_search_history_missing_query_is_error(self):
        err, _ = self._call("search_history", {"query": ""})
        self.assertTrue(err)

    def test_search_history_rejects_bad_prefix(self):
        err, text = self._call("search_history", {"query": "x", "path_prefix": "../etc"})
        self.assertTrue(err)
        self.assertIn("Invalid", text)

    def test_changelog_lists_recent_doc_changes(self):
        err, data = self._call("changelog", {"days": 365})
        self.assertFalse(err)
        subjects = [c["subject"] for c in data["commits"]]
        self.assertIn("edit: alpha zeta->omega", subjects)
        omega = next(c for c in data["commits"] if c["subject"] == "edit: alpha zeta->omega")
        edited = next(f for f in omega["files"] if f["path"] == _DOC)
        self.assertEqual(edited["status"], "M")  # parsed status, not a stray '\n'

    def test_doc_blame_attributes_lines_and_pattern_filters(self):
        err, data = self._call("doc_blame", {"path": _DOC, "pattern": "OMEGAMARKER"})
        self.assertFalse(err)
        self.assertTrue(data["lines"])
        line = data["lines"][0]
        self.assertIn("OMEGAMARKER", line["text"])
        self.assertTrue(line["sha"])
        self.assertEqual(line["subject"], "edit: alpha zeta->omega")  # the commit that wrote it

    def test_doc_blame_rejects_traversal(self):
        err, text = self._call("doc_blame", {"path": "../escape.md"})
        self.assertTrue(err)
        self.assertIn("Invalid", text)


class TestDocRevert(unittest.TestCase):
    """doc_revert mutates the mind -> a FRESH server per test."""

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.token = _seed_api_token(self.srv)

    def tearDown(self):
        self.srv.stop()

    def test_revert_restores_a_past_revision(self):
        _commit(self.srv, _DOC, "# Alpha\n\nORIGINAL_REVERT_MARK\n", "rv: base")
        _commit(self.srv, _DOC, "# Alpha\n\nCHANGED_REVERT_MARK\n", "rv: change")
        revs = _call(self.srv, self.token, "doc_history", {"path": _DOC})[1]["revisions"]
        base_sha = next(r["sha"] for r in revs if r["subject"] == "rv: base")
        err, text = _call(self.srv, self.token, "doc_revert", {"path": _DOC, "rev": base_sha})
        self.assertFalse(err)
        self.assertIn("Reverted", text)
        restored = self.srv.path(_DOC).read_text(encoding="utf-8")
        self.assertIn("ORIGINAL_REVERT_MARK", restored)
        self.assertNotIn("CHANGED_REVERT_MARK", restored)

    def test_revert_refuses_remote_mirror(self):
        err, text = _call(self.srv, self.token, "doc_revert",
                          {"path": "remotes/x/foo.md", "rev": "HEAD"})
        self.assertTrue(err)
        self.assertIn("Read-only", text)

    def test_revert_rejects_bad_rev(self):
        err, text = _call(self.srv, self.token, "doc_revert",
                          {"path": _DOC, "rev": "$(whoami)"})
        self.assertTrue(err)
        self.assertIn("Invalid revision", text)


class TestHistoryRenameParsing(unittest.TestCase):
    """A rename emits a 2-path (R) name-status record under -z; the parser must pair
    old+new without corrupting the rest of the commit (the verdict's top risk)."""

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.token = _seed_api_token(self.srv)

    def tearDown(self):
        self.srv.stop()

    def test_changelog_surfaces_a_rename_as_one_record(self):
        _commit(self.srv, "projets/before.md", "# Before\n\nRENAMEMARK\n", "rn: add before")
        self.srv.git("mv", "content/projets/before.md", "content/projets/after.md")
        self.srv.git("commit", "-q", "-m", "rn: move before to after")
        err, data = _call(self.srv, self.token, "changelog", {"days": 365})
        self.assertFalse(err)
        move = next((c for c in data["commits"] if c["subject"] == "rn: move before to after"), None)
        self.assertIsNotNone(move)
        renamed = move["files"][0]
        self.assertEqual(renamed["status"], "R")
        self.assertEqual(renamed["path"], "projets/after.md")
        self.assertEqual(renamed["old_path"], "projets/before.md")


if __name__ == "__main__":
    unittest.main()
