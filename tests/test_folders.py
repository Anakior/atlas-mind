"""Folders from the viewer and from MCP: POST /api/dir makes one that stays while empty (a
hidden .gitkeep, private to a member like a note), DELETE /api/dir removes it while empty,
and a folder moves whole (POST /api/dir/rename, or move_doc on a folder) with its privacy
and with the [[links]] that reach its docs by path rewritten."""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
    csrf_token_for, file_store_of, seed_admin_and_viewer, session_cookie)
from test_mcp_tools import _call, _seed_api_token  # noqa: E402


def _dirs(tree, prefix=""):
    """Every folder path of a /api/tree answer."""
    out = []
    for child in tree.get("children", []):
        if child.get("type") == "dir":
            path = prefix + child["name"]
            out.append(path)
            out += _dirs(child, path + "/")
    return out


class TestFolders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.admin = cls._headers(ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.member = cls._headers(VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    @classmethod
    def _headers(cls, email, password):
        cookie = session_cookie(cls.srv, email, password)
        return {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(cls.srv, cookie)}

    def _tree_dirs(self, who):
        return _dirs(self.srv.get("/api/tree", headers=who).json())

    def _mkdir(self, path, who, **extra):
        return self.srv.post("/api/dir", headers=who, json_body={"path": path, **extra})

    def _put(self, rel, text):
        resp = self.srv.request("PUT", "/api/file", headers=self.admin,
                                json_body={"path": rel, "content": text})
        self.assertEqual(resp.status, 200, resp.body)

    def test_an_empty_folder_stays_and_shows(self):
        self.assertEqual(self._mkdir("Projets clients/Acme", self.admin).status, 200)
        self.assertTrue((self.srv.content_root / "Projets clients/Acme/.gitkeep").is_file())
        dirs = self._tree_dirs(self.admin)
        self.assertIn("Projets clients/Acme", dirs)
        self.assertIn("Projets clients/Acme", self._tree_dirs(self.member))  # the admin's: commons
        self.assertEqual(self._mkdir("Projets clients/Acme", self.admin).status, 409)

    def test_a_members_empty_folder_is_theirs(self):
        self.assertEqual(self._mkdir("brouillons", self.member).status, 200)
        self.assertIn("brouillons", self._tree_dirs(self.member))
        self.assertNotIn("brouillons", self._tree_dirs(self.admin))

    def test_hidden_reserved_and_escaping_names_are_refused(self):
        for bad, status in ((".cache", 403), ("notes/.x", 403), ("remotes/x", 403), ("skill", 403),
                            ("../out", 400), ("a:b", 400), ("", 400)):
            with self.subTest(bad=bad):
                self.assertEqual(self._mkdir(bad, self.admin).status, status)

    def test_only_an_empty_folder_is_deleted(self):
        self._mkdir("vide", self.admin)
        self._mkdir("plein", self.admin)
        self._put("plein/note.md", "# Note\n")
        delete = lambda path: self.srv.request("DELETE", "/api/dir", headers=self.admin,  # noqa: E731
                                               json_body={"path": path})
        self.assertEqual(delete("plein").status, 409)
        self.assertEqual(delete("vide").status, 200)
        self.assertFalse((self.srv.content_root / "vide").exists())
        self.assertNotIn("vide", self._tree_dirs(self.admin))

    def test_a_folder_moves_with_its_links_and_privacy(self):
        self._put("chantier/plan.md", "# Plan\nVoir [[chantier/budget]].\n")
        self._put("chantier/budget.md", "# Budget\n")
        self._put("index.md", "# Index\n[[chantier/plan]] et [[budget]].\n")
        self.fs.set_owner("chantier/budget.md", "user:" + ADMIN_EMAIL)
        resp = self.srv.post("/api/dir/rename", headers=self.admin,
                             json_body={"from": "chantier", "to": "archives/chantier-2025"})
        self.assertEqual(resp.status, 200, resp.body)
        root = self.srv.content_root
        self.assertFalse((root / "chantier").exists())
        self.assertIn("[[archives/chantier-2025/plan]] et [[budget]]",
                      (root / "index.md").read_text(encoding="utf-8"))
        self.assertIn("[[archives/chantier-2025/budget]]",
                      (root / "archives/chantier-2025/plan.md").read_text(encoding="utf-8"))
        self.assertEqual(self.fs.get_acl("archives/chantier-2025/budget.md").get("owner"),
                         "user:" + ADMIN_EMAIL)
        self.assertEqual(resp.json()["links_updated"], 2)

    def test_a_folder_never_moves_into_itself(self):
        self._mkdir("boucle", self.admin)
        resp = self.srv.post("/api/dir/rename", headers=self.admin,
                             json_body={"from": "boucle", "to": "boucle/dedans"})
        self.assertEqual(resp.status, 400)


class TestMoveDocFolders(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.token = _seed_api_token(self.srv)

    def tearDown(self):
        self.srv.stop()

    def test_move_doc_moves_a_folder(self):
        err, text = _call(self.srv, self.token, "move_doc",
                          {"from": "projets", "to": "archives/projets", "ai": "claude"})
        self.assertFalse(err, text)
        self.assertIn("Moved folder", text)
        self.assertFalse(self.srv.path("projets").exists())
        self.assertTrue(self.srv.path("archives/projets/beta.md").exists())

    def test_move_doc_moves_a_pdf(self):
        self.srv.path("projets/scan.pdf").write_bytes(b"%PDF-1.4 scan")
        err, text = _call(self.srv, self.token, "move_doc",
                          {"from": "projets/scan.pdf", "to": "archives/scan.pdf", "ai": "claude"})
        self.assertFalse(err, text)
        self.assertTrue(self.srv.path("archives/scan.pdf").exists())


if __name__ == "__main__":
    unittest.main()
