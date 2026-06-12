"""Per-user visibility permissions (#14, viewer ACL).

A viewer can have `hidden_folders` (prefixes relative to content/) that they must
NEITHER see in the tree, NOR find in search, NOR open directly, NOR see leak via
the backlinks index (the Mind). The admin sees everything. The filtering is
ALWAYS server-side (never a mere client-side masking).
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

ADMIN_EMAIL, ADMIN_PW = "admin@acl.local", "admin-pw-0123456789"
VIEWER_EMAIL, VIEWER_PW = "viewer@acl.local", "viewer-pw-0123456789"

MIND = {
    "public/note.md": "# Public\n\nterme-public visible. Voir [[secret/private]].\n",
    "secret/private.md": "# Secret\n\nterme-secret-prive caché. Voir [[public/note]].\n",
    TODO_REL: DEFAULT_QUICK_MD,
}

CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "acl-test-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",   # bypasses the git clone at boot
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}


def _cookie(srv, email, pw):
    resp = srv.post("/login", json_body={"email": email, "password": pw})
    assert resp.status == 303, f"login {email} → {resp.status}"  # 303 = success
    return resp.headers.get("Set-Cookie", "").split(";", 1)[0]


class TestViewerACL(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=MIND, extra_env=CLOUD_ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        fs.upsert_user(ADMIN_EMAIL, {
            "password_hash": store.hash_password(ADMIN_PW), "role": "admin"})
        fs.upsert_user(VIEWER_EMAIL, {
            "password_hash": store.hash_password(VIEWER_PW), "role": "viewer",
            "hidden_folders": ["secret"]})
        cls.admin = _cookie(cls.srv, ADMIN_EMAIL, ADMIN_PW)
        cls.viewer = _cookie(cls.srv, VIEWER_EMAIL, VIEWER_PW)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _tree_paths(self, cookie):
        tree = self.srv.get("/api/tree", headers={"Cookie": cookie}).json()
        out = []

        def walk(node):
            for child in node.get("children", []):
                if child.get("type") == "file":
                    out.append(child["path"])
                else:
                    walk(child)
        walk(tree)
        return out

    def test_tree_hides_secret_from_viewer_only(self):
        admin_paths = self._tree_paths(self.admin)
        viewer_paths = self._tree_paths(self.viewer)
        self.assertIn("secret/private.md", admin_paths)
        self.assertIn("public/note.md", admin_paths)
        self.assertNotIn("secret/private.md", viewer_paths)   # hidden from the viewer
        self.assertIn("public/note.md", viewer_paths)         # the public one stays

    def test_file_serve_404_for_viewer(self):
        self.assertEqual(self.srv.get("/secret/private.md",
                         headers={"Cookie": self.admin}).status, 200)
        self.assertEqual(self.srv.get("/secret/private.md",
                         headers={"Cookie": self.viewer}).status, 404)
        self.assertEqual(self.srv.get("/public/note.md",
                         headers={"Cookie": self.viewer}).status, 200)

    def test_search_filtered_for_viewer(self):
        admin = self.srv.get("/api/search?q=terme-secret-prive",
                             headers={"Cookie": self.admin}).json()
        viewer = self.srv.get("/api/search?q=terme-secret-prive",
                              headers={"Cookie": self.viewer}).json()
        self.assertTrue(any(r.get("path") == "secret/private.md" for r in admin))
        self.assertFalse(any(r.get("path") == "secret/private.md" for r in viewer))

    def test_admin_endpoint_sets_hidden_and_list_reflects(self):
        csrf = self.srv.get("/api/me", headers={"Cookie": self.admin}).json().get("csrf_token", "")
        hdr = {"Cookie": self.admin, "X-CSRF-Token": csrf}
        # The admin changes the viewer's hidden folders via the API.
        r = self.srv.post("/api/admin/users/hidden",
                          json_body={"email": VIEWER_EMAIL, "folders": ["public"]},
                          headers=hdr)
        self.assertEqual(r.status, 200)
        # The admin list reflects the change (hidden_folders exposed).
        users = self.srv.get("/api/admin/users", headers={"Cookie": self.admin}).json()
        viewer = next(u for u in users if u["email"] == VIEWER_EMAIL)
        self.assertEqual(viewer["hidden_folders"], ["public"])
        # Enforcement follows live: the viewer now hides 'public'.
        self.assertNotIn("public/note.md", self._tree_paths(self.viewer))
        # Restore the state for the independence of the other tests.
        self.srv.post("/api/admin/users/hidden",
                      json_body={"email": VIEWER_EMAIL, "folders": ["secret"]},
                      headers=hdr)

    def test_backlinks_index_filtered_for_viewer(self):
        # The Mind/the backlinks must not leak the name of the hidden doc.
        admin = self.srv.get("/_backlinks.json",
                             headers={"Cookie": self.admin}).json()
        viewer = self.srv.get("/_backlinks.json",
                              headers={"Cookie": self.viewer}).json()
        self.assertIn("secret/private.md", admin)
        self.assertNotIn("secret/private.md", viewer)


if __name__ == "__main__":
    unittest.main()
