"""Characterization smoke tests: local boot, viewer, content, /api/tree.

A single server shared by the whole class (boot ≈ 1-2 s: copy, git init,
build.py, startup). The tests are read-only on the default mind.
"""
import unittest

from harness import AtlasServer, DEFAULT_MIND, TODO_REL


def _collect_file_paths(node, acc=None):
    """Flatten the /api/tree tree → list of file paths."""
    if acc is None:
        acc = []
    if node.get("type") == "file":
        acc.append(node["path"])
    for child in node.get("children", []):
        _collect_file_paths(child, acc)
    return acc


class TestSmoke(unittest.TestCase):
    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_healthz_public(self):
        status, headers, body = self.srv.get("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"ok")
        self.assertEqual(headers.get("Content-Type"), "text/plain; charset=utf-8")
        # Security headers set by end_headers() on ALL responses.
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("X-Frame-Options"), "SAMEORIGIN")
        self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")

    def test_root_serves_viewer(self):
        status, headers, body = self.srv.get("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "text/html; charset=utf-8")
        self.assertTrue(body.startswith(b"<!DOCTYPE html>"))
        text = body.decode("utf-8")
        # build.py injected the tree (__DATA__): the mind's docs are in there…
        self.assertIn("accueil.md", text)
        self.assertIn("projets/alpha.md", text)
        # …and the template placeholders were indeed replaced.
        self.assertNotIn("__DATA__", text)
        self.assertNotIn("__BUILD_TS__", text)

    def test_get_markdown_doc_returns_raw_content(self):
        resp = self.srv.get("/projets/alpha.md")
        self.assertEqual(resp.status, 200)
        # The static handler serves the raw .md from content/, UTF-8 intact
        # (accents); mimetype guessed by Python 3.14 = text/markdown without charset.
        self.assertEqual(resp.body, DEFAULT_MIND["projets/alpha.md"].encode("utf-8"))
        self.assertEqual(resp.headers.get("Content-Type"), "text/markdown")
        self.assertIn("déjà, café, hétérogène", resp.text)

    def test_get_missing_doc_404(self):
        status, _, _ = self.srv.get("/projets/inexistant.md")
        self.assertEqual(status, 404)

    def test_api_tree_lists_mind_docs(self):
        resp = self.srv.get("/api/tree")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        tree = resp.json()
        self.assertEqual(tree["type"], "dir")
        self.assertEqual(tree["name"], "content")
        paths = _collect_file_paths(tree)
        self.assertIn("accueil.md", paths)
        self.assertIn("projets/alpha.md", paths)
        self.assertIn("projets/beta.md", paths)
        # Characterization: quick.md (the to-do) is in build.py's EXCLUDED_NAMES
        # → never visible in the tree, even though it is served statically
        # and edited via /api/todos.
        self.assertNotIn(TODO_REL, paths)

    def test_quick_md_still_served_statically(self):
        # Excluded from the tree but NOT from static serving (not a dotfile).
        resp = self.srv.get("/" + TODO_REL)
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, DEFAULT_MIND[TODO_REL].encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
