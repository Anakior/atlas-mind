"""Per-document ACL (model B) over the BROWSER (cookie session).

The browser honors the central acl.json: a viewer sees the commons + what it is
granted, but NEVER a private (owned) doc — across the tree, the file serve (404,
no-existence-oracle), search, and the Mind/backlinks index. The admin bypasses
everything. Filtering is ALWAYS server-side (never a client-side mask).

Replaces the previous `hidden_folders` blacklist suite (that mechanism is retired
in favor of model B — see atlas-mind/cdc-commons-repo-partage.md §8).
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
    "secret/private.md": "# Secret\n\nterme-secret-prive cache. Voir [[public/note]].\n",
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


class TestViewerAcl(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=MIND, extra_env=CLOUD_ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        fs.upsert_user(ADMIN_EMAIL, {
            "password_hash": store.hash_password(ADMIN_PW), "role": "admin"})
        fs.upsert_user(VIEWER_EMAIL, {
            "password_hash": store.hash_password(VIEWER_PW), "role": "viewer"})
        cls.fs = fs
        # The whole 'secret' folder is private to the admin (model B: an owned
        # path is private) → hidden from the viewer, inherited by its children.
        fs.set_owner("secret", "user:" + ADMIN_EMAIL)
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

    def test_tree_hides_private_from_viewer_only(self):
        admin_paths = self._tree_paths(self.admin)
        viewer_paths = self._tree_paths(self.viewer)
        self.assertIn("secret/private.md", admin_paths)
        self.assertIn("public/note.md", admin_paths)
        self.assertNotIn("secret/private.md", viewer_paths)   # private → hidden
        self.assertIn("public/note.md", viewer_paths)         # the commons stays

    def test_file_serve_404_for_viewer(self):
        self.assertEqual(self.srv.get("/secret/private.md",
                         headers={"Cookie": self.admin}).status, 200)
        self.assertEqual(self.srv.get("/secret/private.md",
                         headers={"Cookie": self.viewer}).status, 404)
        self.assertEqual(self.srv.get("/public/note.md",
                         headers={"Cookie": self.viewer}).status, 200)

    def test_acl_bypass_via_path_normalization(self):
        # Regression: a non-normalized path must not slip a private doc past the
        # ACL. The static handler normalizes via posixpath.normpath, so the ACL
        # check runs on that canonical form. Each vector resolves to secret/private.md.
        for vector in (
            "/%2fsecret/private.md",   # leading %2f → //secret/... after decode
            "/secret//private.md",     # embedded double slash
            "/%2e/secret/private.md",  # encoded "." curdir segment
        ):
            resp = self.srv.get(vector, headers={"Cookie": self.viewer})
            self.assertEqual(resp.status, 404,
                             f"{vector} leaked to viewer ({resp.status})")
        self.assertEqual(self.srv.get("/secret/private.md",
                         headers={"Cookie": self.admin}).status, 200)

    def test_search_filtered_for_viewer(self):
        admin = self.srv.get("/api/search?q=terme-secret-prive",
                             headers={"Cookie": self.admin}).json()
        viewer = self.srv.get("/api/search?q=terme-secret-prive",
                              headers={"Cookie": self.viewer}).json()
        self.assertTrue(any(r.get("path") == "secret/private.md" for r in admin))
        self.assertFalse(any(r.get("path") == "secret/private.md" for r in viewer))

    def test_backlinks_index_filtered_for_viewer(self):
        # The Mind/backlinks must not leak the name of the private doc.
        admin = self.srv.get("/_backlinks.json",
                             headers={"Cookie": self.admin}).json()
        viewer = self.srv.get("/_backlinks.json",
                              headers={"Cookie": self.viewer}).json()
        self.assertIn("secret/private.md", admin)
        self.assertNotIn("secret/private.md", viewer)

    def test_grant_reveals_specific_private_to_viewer(self):
        # A 'view' grant on the exact doc reveals it live, even under an owned
        # folder (the grant is at/below the owner boundary, so it applies).
        self.fs.grant("secret/private.md", "user:" + VIEWER_EMAIL, "view")
        try:
            self.assertIn("secret/private.md", self._tree_paths(self.viewer))
            self.assertEqual(self.srv.get("/secret/private.md",
                             headers={"Cookie": self.viewer}).status, 200)
        finally:
            self.fs.revoke_grant("secret/private.md", "user:" + VIEWER_EMAIL)


if __name__ == "__main__":
    unittest.main()
