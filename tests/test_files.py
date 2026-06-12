"""Characterization tests of the Atlas server's file endpoints.

Scope:
- PUT    /api/file        (.md/.html creation with parent mkdir, rewrite,
                           refusal of other extensions, path traversal)
- DELETE /api/file        (deletion, path guards, extension)
- POST   /api/file/move   (move + rewrite of incoming [[wikilinks]],
                           overwrite refusal)
- POST   /api/dir/rename  (reserved-directory guards, no relink)

These tests encode the CURRENT behavior, bugs and quirks included (see the
"Characterization" comments throughout the tests). Local mode: no auth,
_session() fabricates an admin → all write endpoints are open.

Server organization:
- TestPutFile / TestDeleteFile: one server shared per class (each test works on
  distinct paths, no interference).
- TestMoveFile / TestDirRename: a FRESH server per test (move rewrites the body
  of other docs, rename moves whole directories → isolation).
"""
import sys
import unittest
from pathlib import Path

# Allows `python3 -m unittest tests.test_files` in addition to `discover -s tests`
# (no __init__.py: tests/ is on sys.path only in discover mode).
_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer, DEFAULT_MIND  # noqa: E402


class TestPutFile(unittest.TestCase):
    """PUT /api/file — document creation/rewrite."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_put_creates_md_with_parent_dirs(self):
        resp = self.srv.put("/api/file", json_body={
            "path": "nouveau/sous/dossier/note.md",
            "content": "# Note\n\nCréée via l'API, avec accents : déjà.\n",
        })
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        payload = resp.json()
        self.assertIs(payload["ok"], True)
        # mtime = int(st_mtime) of the freshly written file.
        self.assertIsInstance(payload["mtime"], int)
        target = self.srv.path("nouveau/sous/dossier/note.md")
        self.assertTrue(target.exists())
        self.assertEqual(target.read_text(encoding="utf-8"),
                         "# Note\n\nCréée via l'API, avec accents : déjà.\n")

    def test_put_overwrites_existing_doc(self):
        resp = self.srv.put("/api/file", json_body={
            "path": "accueil.md", "content": "# Réécrit\n"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.srv.path("accueil.md").read_text(encoding="utf-8"),
                         "# Réécrit\n")

    def test_put_accepts_html_and_defaults_to_empty_content(self):
        # .html is a first-class document (deck, dashboard…).
        # Characterization: without a "content" key, the server writes an EMPTY
        # file (content = data.get("content", "")), no error.
        resp = self.srv.put("/api/file", json_body={"path": "deck.html"})
        self.assertEqual(resp.status, 200)
        self.assertIs(resp.json()["ok"], True)
        self.assertEqual(self.srv.path("deck.html").read_text(encoding="utf-8"), "")

    def test_put_rejects_other_extensions(self):
        for rel in ("notes.txt", "script.py", "sans-extension"):
            resp = self.srv.put("/api/file",
                                json_body={"path": rel, "content": "x"})
            self.assertEqual(resp.status, 400, rel)
            self.assertEqual(resp.json(), {"error": "only .md or .html"})
            self.assertFalse(self.srv.path(rel).exists())
        # Characterization: PUT validates the extension via suffix.lower() →
        # "NOTE.MD" passes (whereas /api/file/move refuses it, case-sensitive
        # endswith in _validate_doc_path).
        resp = self.srv.put("/api/file",
                            json_body={"path": "MAJUSCULE.MD", "content": "x"})
        self.assertEqual(resp.status, 200)

    def test_put_rejects_dotdot_traversal(self):
        resp = self.srv.put("/api/file", json_body={
            "path": "../evasion.md", "content": "pwned"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})
        self.assertFalse((self.srv.root / "evasion.md").exists())
        # Characterization: the guard is purely lexical — a ".." that STAYS
        # inside content/ after resolution is refused anyway.
        resp = self.srv.put("/api/file", json_body={
            "path": "projets/../reste-dedans.md", "content": "x"})
        self.assertEqual(resp.status, 400)
        self.assertFalse(self.srv.path("reste-dedans.md").exists())

    def test_put_absolute_path_returns_403_outside_root(self):
        # Characterization: unlike DELETE, PUT has NO startswith("/") guard — an
        # absolute path passes the first check, then CONTENT_ROOT / "/abs" gives
        # "/abs" (pathlib) and it is relative_to(CONTENT_ROOT) that catches it →
        # 403 (not 400).
        evil = f"/tmp/atlas-test-files-{self.srv.port}.md"
        try:
            resp = self.srv.put("/api/file",
                                json_body={"path": evil, "content": "pwned"})
            self.assertEqual(resp.status, 403)
            self.assertEqual(resp.json(), {"error": "outside root"})
            self.assertFalse(Path(evil).exists())
        finally:
            Path(evil).unlink(missing_ok=True)

    def test_put_missing_path_rejected(self):
        resp = self.srv.put("/api/file", json_body={"content": "orphelin"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})


class TestDeleteFile(unittest.TestCase):
    """DELETE /api/file — document deletion."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_delete_removes_md(self):
        target = self.srv.path("projets/beta.md")
        self.assertTrue(target.exists())
        resp = self.srv.delete("/api/file",
                               json_body={"path": "projets/beta.md"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {"ok": True})
        self.assertFalse(target.exists())

    def test_delete_missing_doc_404(self):
        resp = self.srv.delete("/api/file", json_body={"path": "fantome.md"})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "document not found"})

    def test_delete_existing_txt_is_404_and_file_kept(self):
        # Characterization: the extension guard is merged with the existence
        # check (`not exists or suffix not in (.md, .html)`) → a .txt that is
        # actually present on disk answers "document not found" and is NOT
        # deleted. Indistinguishable from a missing file on the client side.
        target = self.srv.path("brouillon.txt")
        target.write_text("à garder", encoding="utf-8")
        resp = self.srv.delete("/api/file", json_body={"path": "brouillon.txt"})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "document not found"})
        self.assertTrue(target.exists())

    def test_delete_rejects_traversal_and_absolute(self):
        resp = self.srv.delete("/api/file", json_body={"path": "../accueil.md"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})
        # Characterization: DELETE has an explicit startswith("/") guard →
        # 400 (where PUT lets it slip through to relative_to → 403).
        resp = self.srv.delete("/api/file", json_body={"path": "/etc/passwd"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})
        # And the mind's doc has not moved.
        self.assertTrue(self.srv.path("accueil.md").exists())


class TestMoveFile(unittest.TestCase):
    """POST /api/file/move — move + rewrite of incoming wikilinks.

    DEFAULT_MIND provides the wikilinks fixture:
    - accueil.md       → [[projets/alpha]] + [[beta|le projet Bêta]] (stem+alias)
    - projets/alpha.md → [[accueil]] + [[projets/beta.md]] (by path, with .md)
    - projets/beta.md  → no outgoing link (backlinks target).
    Fresh server per test: the move mangles the body of the other documents.
    """

    def setUp(self):
        self.srv = AtlasServer()
        self.srv.start()
        self.addCleanup(self.srv.stop)

    def test_move_rename_rewrites_incoming_wikilinks(self):
        resp = self.srv.post("/api/file/move", json_body={
            "from": "projets/beta.md", "to": "projets/gamma.md"})
        self.assertEqual(resp.status, 200)
        payload = resp.json()
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["from"], "projets/beta.md")
        self.assertEqual(payload["to"], "projets/gamma.md")
        self.assertEqual(payload["links_updated"], 2)
        rewrites = {r["path"]: r["count"] for r in payload["rewrites"]}
        self.assertEqual(rewrites, {"accueil.md": 1, "projets/alpha.md": 1})

        # The file has moved, content intact.
        self.assertFalse(self.srv.path("projets/beta.md").exists())
        self.assertEqual(
            self.srv.path("projets/gamma.md").read_text(encoding="utf-8"),
            DEFAULT_MIND["projets/beta.md"])

        # Stem+alias link: only the target changes, the alias is preserved.
        accueil = self.srv.path("accueil.md").read_text(encoding="utf-8")
        self.assertIn("[[gamma|le projet Bêta]]", accueil)
        self.assertNotIn("[[beta|", accueil)
        self.assertIn("[[projets/alpha]]", accueil)  # third-party link unchanged

        # Path link with .md: rewritten as a full path, .md preserved.
        alpha = self.srv.path("projets/alpha.md").read_text(encoding="utf-8")
        self.assertIn("[[projets/gamma.md]]", alpha)
        self.assertIn("[[accueil]]", alpha)  # third-party link unchanged

    def test_move_to_other_dir_keeps_stem_links_untouched(self):
        # Characterization: "pure move" (the stem does not change). Short-name
        # links ([[beta|…]]) still resolve after the move → the replacer
        # produces identical text and does NOT count it in links_updated. Only
        # path links are rewritten.
        resp = self.srv.post("/api/file/move", json_body={
            "from": "projets/beta.md", "to": "archive/beta.md"})
        self.assertEqual(resp.status, 200)
        payload = resp.json()
        self.assertEqual(payload["links_updated"], 1)
        self.assertEqual(payload["rewrites"],
                         [{"path": "projets/alpha.md", "count": 1}])

        # archive/ did not exist: created by the move (mkdir parents).
        self.assertTrue(self.srv.path("archive/beta.md").exists())
        # accueil.md (stem link) is strictly intact.
        self.assertEqual(
            self.srv.path("accueil.md").read_text(encoding="utf-8"),
            DEFAULT_MIND["accueil.md"])
        alpha = self.srv.path("projets/alpha.md").read_text(encoding="utf-8")
        self.assertIn("[[archive/beta.md]]", alpha)

    def test_move_refuses_overwrite_409(self):
        resp = self.srv.post("/api/file/move", json_body={
            "from": "projets/alpha.md", "to": "projets/beta.md"})
        self.assertEqual(resp.status, 409)
        self.assertIn("existe déjà", resp.json()["error"])
        # Nothing has moved.
        self.assertEqual(
            self.srv.path("projets/alpha.md").read_text(encoding="utf-8"),
            DEFAULT_MIND["projets/alpha.md"])
        self.assertEqual(
            self.srv.path("projets/beta.md").read_text(encoding="utf-8"),
            DEFAULT_MIND["projets/beta.md"])

    def test_move_missing_source_404(self):
        resp = self.srv.post("/api/file/move", json_body={
            "from": "fantome.md", "to": "ailleurs.md"})
        self.assertEqual(resp.status, 404)
        self.assertIn("Source introuvable", resp.json()["error"])

    def test_move_invalid_paths_400(self):
        cases = [
            # Traversal on from.
            {"from": "../projets/beta.md", "to": "beta.md"},
            # Traversal on to.
            {"from": "projets/beta.md", "to": "../evasion.md"},
            # Forbidden extension on the destination side.
            {"from": "projets/beta.md", "to": "notes.txt"},
            # Characterization: _validate_doc_path uses case-SENSITIVE
            # endswith((".md", ".html")) → "GAMMA.MD" is refused here while
            # PUT /api/file accepts it (suffix.lower()).
            {"from": "projets/beta.md", "to": "GAMMA.MD"},
            # Absolute path refused with 400 (startswith("/") in the validator).
            {"from": "/etc/passwd.md", "to": "beta.md"},
        ]
        for body in cases:
            resp = self.srv.post("/api/file/move", json_body=body)
            self.assertEqual(resp.status, 400, body)
            self.assertIn("Path invalide", resp.json()["error"])
        # The source has never moved.
        self.assertTrue(self.srv.path("projets/beta.md").exists())


class TestDirRename(unittest.TestCase):
    """POST /api/dir/rename — moving whole directories."""

    def setUp(self):
        self.srv = AtlasServer()
        self.srv.start()
        self.addCleanup(self.srv.stop)

    def test_dir_rename_moves_directory_without_rewriting_wikilinks(self):
        resp = self.srv.post("/api/dir/rename", json_body={
            "from": "projets", "to": "archives/anciens-projets"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {
            "ok": True, "from": "projets", "to": "archives/anciens-projets"})
        self.assertFalse(self.srv.path("projets").exists())
        # archives/ did not exist: created (mkdir parents on dst.parent).
        self.assertTrue(
            self.srv.path("archives/anciens-projets/alpha.md").exists())
        self.assertTrue(
            self.srv.path("archives/anciens-projets/beta.md").exists())
        # Characterization: unlike /api/file/move, the directory rename rewrites
        # NO wikilink — [[projets/alpha]] in accueil.md now points to nothing.
        self.assertEqual(
            self.srv.path("accueil.md").read_text(encoding="utf-8"),
            DEFAULT_MIND["accueil.md"])

    def test_dir_rename_blocks_reserved_and_dot_dirs(self):
        # The "reserved" guard runs BEFORE the existence check: skill/ does not
        # even exist in the mind and still answers 403.
        cases = [
            ({"from": "skill", "to": "autre"}, "protected dir: skill"),
            ({"from": "projets", "to": "node_modules/lib"},
             "protected dir: node_modules"),
            ({"from": ".notes", "to": "notes"}, "protected dir: .notes"),
            ({"from": "projets", "to": "tools"}, "protected dir: tools"),
        ]
        for body, error in cases:
            resp = self.srv.post("/api/dir/rename", json_body=body)
            self.assertEqual(resp.status, 403, body)
            self.assertEqual(resp.json(), {"error": error})
        # projets/ is still there.
        self.assertTrue(self.srv.path("projets/alpha.md").exists())

    def test_dir_rename_destination_exists_409(self):
        # notes/ exists in the default mind (it carries the quick.md to-do).
        resp = self.srv.post("/api/dir/rename", json_body={
            "from": "projets", "to": "notes"})
        self.assertEqual(resp.status, 409)
        self.assertEqual(resp.json(), {"error": "destination exists"})
        self.assertTrue(self.srv.path("projets").is_dir())

    def test_dir_rename_source_missing_or_file_404(self):
        resp = self.srv.post("/api/dir/rename", json_body={
            "from": "fantome", "to": "ailleurs"})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "source dir not found"})
        # A file is not a directory: same 404 (is_dir() guard).
        resp = self.srv.post("/api/dir/rename", json_body={
            "from": "accueil.md", "to": "ailleurs"})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "source dir not found"})
        self.assertTrue(self.srv.path("accueil.md").exists())

    def test_dir_rename_into_own_subdir_400(self):
        resp = self.srv.post("/api/dir/rename", json_body={
            "from": "projets", "to": "projets/archive"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "destination is inside source"})
        self.assertTrue(self.srv.path("projets/alpha.md").exists())

    def test_dir_rename_traversal_rejected_but_absolute_relativized(self):
        for body in ({"from": "../projets", "to": "x"},
                     {"from": "projets", "to": "../evasion"}):
            resp = self.srv.post("/api/dir/rename", json_body=body)
            self.assertEqual(resp.status, 400, body)
            self.assertEqual(resp.json(), {"error": "invalid path"})
        # Characterization: from/to undergo .strip("/") BEFORE the startswith("/")
        # guard → an absolute path is silently relativized. "/projets" becomes
        # "projets" and the rename SUCCEEDS.
        resp = self.srv.post("/api/dir/rename", json_body={
            "from": "/projets", "to": "renomme"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(),
                         {"ok": True, "from": "projets", "to": "renomme"})
        self.assertTrue(self.srv.path("renomme/alpha.md").exists())


if __name__ == "__main__":
    unittest.main()
