"""Tests of the read-only git-history endpoints.

Scope:
- GET /api/history?path=            (revisions of a doc, newest-first)
- GET /api/revision?path=&rev=      (full content of a doc at a revision)
- GET /api/diff?path=&from=&to=     (unified diff of a doc between two revisions)

Security (mandatory before merge — these endpoints shell out to `git`):
- path traversal (`../`, `..%2f`, non-.md/.html) is rejected on all three;
- git refs (rev/from/to) are regex-validated, so a flag/injection-looking ref
  is rejected before reaching git.

Local mode: no auth, _session() fabricates an admin → the endpoints are open.

Server organization:
- TestHistoryPathEscape: read-only guards → one server shared per class.
- TestHistoryEndpoints: each test makes its own commits → a FRESH server per
  test (history is per-repo shared state).
"""
import sys
import unittest
from pathlib import Path

# Allows `python3 -m unittest tests.test_history` in addition to `discover -s tests`.
_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402

_DOC = "projets/alpha.md"


def _commit(srv, rel, content, message):
    """Overwrite a doc on disk and commit it in the test mind."""
    srv.path(rel).write_text(content, encoding="utf-8")
    srv.git("add", "-A")
    srv.git("commit", "-q", "-m", message)


class TestHistoryEndpoints(unittest.TestCase):
    """Happy-path behaviour of /api/history|revision|diff."""

    def test_history_lists_revisions_newest_first(self):
        with AtlasServer() as srv:
            _commit(srv, _DOC, "# Projet Alpha\n\nv2\n", "edit: alpha v2")
            _commit(srv, _DOC, "# Projet Alpha\n\nv3\n", "edit: alpha v3")
            resp = srv.get("/api/history?path=" + _DOC)
            self.assertEqual(resp.status, 200)
            data = resp.json()
            self.assertEqual(data["path"], _DOC)
            revs = data["revisions"]
            # initial mind commit + the two edits
            self.assertGreaterEqual(len(revs), 3)
            self.assertEqual(revs[0]["subject"], "edit: alpha v3")
            self.assertEqual(revs[1]["subject"], "edit: alpha v2")
            for rev in revs:
                self.assertTrue(rev["sha"])
                self.assertTrue(rev["date"])

    def test_history_of_unchanged_doc_has_one_revision(self):
        with AtlasServer() as srv:
            data = srv.get("/api/history?path=" + _DOC).json()
            self.assertEqual(len(data["revisions"]), 1)

    def test_history_of_unknown_doc_is_empty_not_error(self):
        # A valid-but-absent path yields a clean empty history, not a 404/500.
        with AtlasServer() as srv:
            resp = srv.get("/api/history?path=does/not/exist.md")
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.json()["revisions"], [])

    def test_revision_returns_old_content(self):
        with AtlasServer() as srv:
            _commit(srv, _DOC, "REWRITTEN CONTENT\n", "edit: rewrite")
            revs = srv.get("/api/history?path=" + _DOC).json()["revisions"]
            oldest = revs[-1]["sha"]
            resp = srv.get("/api/revision?path=" + _DOC + "&rev=" + oldest)
            self.assertEqual(resp.status, 200)
            content = resp.json()["content"]
            self.assertIn("Projet Alpha", content)         # original content
            self.assertNotIn("REWRITTEN CONTENT", content)  # not the new one

    def test_revision_unknown_sha_returns_404(self):
        with AtlasServer() as srv:
            resp = srv.get("/api/revision?path=" + _DOC + "&rev=deadbeef")
            self.assertEqual(resp.status, 404)

    def test_diff_between_two_revisions(self):
        with AtlasServer() as srv:
            _commit(srv, _DOC, "# Projet Alpha\n\nNEW DISTINCTIVE LINE\n", "edit: add line")
            revs = srv.get("/api/history?path=" + _DOC).json()["revisions"]
            newest, parent = revs[0]["sha"], revs[1]["sha"]
            resp = srv.get("/api/diff?path=" + _DOC + "&from=" + parent + "&to=" + newest)
            self.assertEqual(resp.status, 200)
            diff = resp.json()["diff"]
            self.assertIn("NEW DISTINCTIVE LINE", diff)
            self.assertIn("+", diff)

    def test_history_path_is_content_relative_not_repo_relative(self):
        # Regression guard for the repo-root vs content-root gotcha: ?path= is
        # content/-relative but git runs at the repo root, so the pathspec must
        # be prefixed with content/. A wrong prefix returns an EMPTY history.
        with AtlasServer() as srv:
            data = srv.get("/api/history?path=" + _DOC).json()
            self.assertTrue(data["revisions"], "history empty → content/ prefix is wrong")

    def test_revert_restores_a_past_revision(self):
        with AtlasServer() as srv:
            _commit(srv, _DOC, "# Projet Alpha\n\nDISTINCT V2 CONTENT\n", "edit: v2")
            initial = srv.get("/api/history?path=" + _DOC).json()["revisions"][-1]["sha"]
            resp = srv.post("/api/revert", json_body={"path": _DOC, "rev": initial})
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.json(), {"ok": True})
            restored = srv.path(_DOC).read_text(encoding="utf-8")
            self.assertIn("Document avec accents", restored)   # original content back
            self.assertNotIn("DISTINCT V2 CONTENT", restored)

    def test_revert_rejects_traversal_and_bad_rev(self):
        with AtlasServer() as srv:
            resp = srv.post("/api/revert", json_body={"path": "../x.md", "rev": "HEAD"})
            self.assertEqual(resp.status, 400)
            self.assertEqual(resp.json(), {"error": "invalid path"})
            resp = srv.post("/api/revert", json_body={"path": _DOC, "rev": "$(whoami)"})
            self.assertEqual(resp.status, 400)
            self.assertEqual(resp.json(), {"error": "invalid rev"})

    def test_history_follows_move_and_pre_move_revisions_still_load(self):
        # A doc edited then moved: --follow lists its pre-move commits, AND
        # /api/revision resolves the path it had then (git show <sha>:<old-path>),
        # so they load instead of failing ("Impossible de charger").
        with AtlasServer() as srv:
            srv.path("projets/before.md").write_text(
                "# Before\n\nORIGINAL CONTENT\n", encoding="utf-8")
            srv.git("add", "-A"); srv.git("commit", "-q", "-m", "add before")
            srv.path("projets/before.md").write_text(
                "# Before\n\nEDITED CONTENT\n", encoding="utf-8")
            srv.git("add", "-A"); srv.git("commit", "-q", "-m", "edit before")
            srv.git("mv", "content/projets/before.md", "content/projets/after.md")
            srv.git("commit", "-q", "-m", "move before to after")

            revs = srv.get("/api/history?path=projets/after.md").json()["revisions"]
            subjects = [r["subject"] for r in revs]
            self.assertIn("add before", subjects)   # pre-move commit still listed
            self.assertIn("edit before", subjects)
            # a pre-move revision loads its OLD-path content (rename resolved)
            add_sha = next(r["sha"] for r in revs if r["subject"] == "add before")
            rev = srv.get("/api/revision?path=projets/after.md&rev=" + add_sha)
            self.assertEqual(rev.status, 200)
            self.assertIn("ORIGINAL CONTENT", rev.json()["content"])
            # a diff between two pre-move revisions loads too
            edit_sha = next(r["sha"] for r in revs if r["subject"] == "edit before")
            diff = srv.get("/api/diff?path=projets/after.md&from=" + add_sha + "&to=" + edit_sha)
            self.assertEqual(diff.status, 200)
            self.assertIn("EDITED CONTENT", diff.json()["diff"])


class TestHistoryPathEscape(unittest.TestCase):
    """Path-traversal and ref-injection rejection on the three endpoints."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_history_rejects_traversal(self):
        for bad in ("../evasion.md", "projets/../../escape.md", "..%2fevasion.md"):
            resp = self.srv.get("/api/history?path=" + bad)
            self.assertEqual(resp.status, 400, bad)
            self.assertEqual(resp.json(), {"error": "invalid path"}, bad)

    def test_history_rejects_non_doc_extension(self):
        resp = self.srv.get("/api/history?path=projets/alpha.txt")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})

    def test_history_rejects_absolute_path(self):
        resp = self.srv.get("/api/history?path=/etc/passwd")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})

    def test_revision_rejects_traversal_then_bad_rev(self):
        # Path is validated first.
        resp = self.srv.get("/api/revision?path=../x.md&rev=HEAD")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})
        # A flag-looking ref must never reach git.
        resp = self.srv.get("/api/revision?path=" + _DOC + "&rev=--output%3D/tmp/x")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid rev"})

    def test_diff_rejects_traversal_then_bad_rev(self):
        resp = self.srv.get("/api/diff?path=../x.md&from=HEAD&to=HEAD")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})
        resp = self.srv.get("/api/diff?path=" + _DOC + "&from=HEAD&to=$(whoami)")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid rev"})

    def test_valid_head_rev_is_accepted(self):
        # HEAD / HEAD~N are explicitly allowed by the validator.
        resp = self.srv.get("/api/revision?path=" + _DOC + "&rev=HEAD")
        self.assertEqual(resp.status, 200)
        self.assertIn("content", resp.json())


if __name__ == "__main__":
    unittest.main()
