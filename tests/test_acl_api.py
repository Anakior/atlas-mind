"""HTTP API for managing the model-B ACL — what the Phase-4 UI calls.

- /api/admin/groups : admin-only CRUD of named groups.
- /api/acl          : an OWNER (or admin) reads/changes a doc's sharing; a
                      non-owner who can read it cannot manage it; a stranger
                      gets 404 (no-existence-oracle).
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

ADMIN = ("admin@acl.local", "admin-pw-0123456789")
ALICE = ("alice@acl.local", "alice-pw-0123456789")
BOB = ("bob@acl.local", "bob-pw-0123456789")

MIND = {
    "common/hello.md": "# Hello\n\ncommun visible de tous.\n",
    "alice/note.md": "# Alice\n\nprive a alice, terme-alice.\n",
    TODO_REL: DEFAULT_QUICK_MD,
}
ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "acl-api-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}


def _cookie(srv, email, pw):
    r = srv.post("/login", json_body={"email": email, "password": pw})
    assert r.status == 303, f"login {email} → {r.status}"
    return r.headers.get("Set-Cookie", "").split(";", 1)[0]


class TestAclApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=MIND, extra_env=ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        for (email, pw), role in ((ADMIN, "admin"), (ALICE, "viewer"), (BOB, "viewer")):
            fs.upsert_user(email, {"password_hash": store.hash_password(pw), "role": role})
        fs.set_owner("alice/note.md", "user:" + ALICE[0])  # alice owns her note
        cls.fs = fs
        cls.admin = _cookie(cls.srv, *ADMIN)
        cls.alice = _cookie(cls.srv, *ALICE)
        cls.bob = _cookie(cls.srv, *BOB)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _auth(self, cookie):
        csrf = self.srv.get("/api/me", headers={"Cookie": cookie}).json().get("csrf_token", "")
        return {"Cookie": cookie, "X-CSRF-Token": csrf}

    def _acl(self, cookie, body):
        return self.srv.post("/api/acl", json_body=body, headers=self._auth(cookie))

    def _tree(self, cookie):
        out = []
        t = self.srv.get("/api/tree", headers={"Cookie": cookie}).json()

        def walk(n):
            for c in n.get("children", []):
                if c.get("type") == "file":
                    out.append(c["path"])
                else:
                    walk(c)
        walk(t)
        return out

    # ── groups (admin) ────────────────────────────────────────────────────
    def test_groups_admin_crud(self):
        r = self.srv.post("/api/admin/groups",
                          json_body={"name": "team", "members": [BOB[0]]},
                          headers=self._auth(self.admin))
        self.assertEqual(r.status, 200)
        groups = self.srv.get("/api/admin/groups", headers={"Cookie": self.admin}).json()
        self.assertEqual(groups.get("team"), [BOB[0]])

    def test_groups_forbidden_for_viewer(self):
        self.assertEqual(
            self.srv.get("/api/admin/groups", headers={"Cookie": self.alice}).status, 403)

    # ── /api/acl read ─────────────────────────────────────────────────────
    def test_owner_reads_can_manage(self):
        r = self.srv.get("/api/acl?path=alice/note.md", headers={"Cookie": self.alice}).json()
        self.assertEqual(r["owner"], "user:" + ALICE[0])
        self.assertTrue(r["can_manage"])

    def test_stranger_404_on_private(self):
        self.assertEqual(
            self.srv.get("/api/acl?path=alice/note.md", headers={"Cookie": self.bob}).status, 404)

    # ── grant / revoke flow ───────────────────────────────────────────────
    def test_owner_grants_then_grantee_sees_then_revoke(self):
        self.assertNotIn("alice/note.md", self._tree(self.bob))
        r = self._acl(self.alice, {"path": "alice/note.md", "action": "grant",
                                   "principal": "user:" + BOB[0], "level": "view"})
        self.assertEqual(r.status, 200)
        self.assertIn("alice/note.md", self._tree(self.bob))
        # bob can now read it, but cannot MANAGE it
        bad = self._acl(self.bob, {"path": "alice/note.md", "action": "grant",
                                   "principal": "user:x@y.z", "level": "view"})
        self.assertEqual(bad.status, 403)
        # revoke restores privacy
        self._acl(self.alice, {"path": "alice/note.md", "action": "revoke",
                               "principal": "user:" + BOB[0]})
        self.assertNotIn("alice/note.md", self._tree(self.bob))

    def test_make_commons_then_restore(self):
        self.fs.set_owner("alice/note.md", "user:" + ALICE[0])
        try:
            r = self._acl(self.alice, {"path": "alice/note.md", "action": "make_commons"})
            self.assertEqual(r.status, 200)
            self.assertIn("alice/note.md", self._tree(self.bob))  # now commons → bob sees it
        finally:
            self.fs.set_owner("alice/note.md", "user:" + ALICE[0])  # restore for other tests

    def test_group_grant_reaches_member(self):
        self.srv.post("/api/admin/groups", json_body={"name": "team", "members": [BOB[0]]},
                      headers=self._auth(self.admin))
        self._acl(self.alice, {"path": "alice/note.md", "action": "grant",
                               "principal": "group:team", "level": "view"})
        try:
            self.assertIn("alice/note.md", self._tree(self.bob))
        finally:
            self._acl(self.alice, {"path": "alice/note.md", "action": "revoke",
                                   "principal": "group:team"})


if __name__ == "__main__":
    unittest.main()
