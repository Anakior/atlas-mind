"""The side paths to a doc honor its rights like the tools do: the static files (however the
URL is spelled), folder listings, annotations, share links, published nodes, and the
sessions and tokens of an account once it is removed. Run: python tests/test_access_paths.py"""
import http.client
import sys
import unittest
from pathlib import Path
from urllib.parse import urlsplit

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import cli  # noqa: E402
import server  # noqa: E402
import store  # noqa: E402
from harness import AtlasServer  # noqa: E402
from server.pure.hive import decode_node_link  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
    csrf_token_for, file_store_of, seed_admin_and_viewer, session_cookie)

VIEWER = "user:" + VIEWER_EMAIL

MIND = {
    "welcome.md": "# Welcome\n",
    "notes/open.md": "# Open\n",
    "notes/viewer-secret.md": "# Merger\n\nQuasarword is the target.\n",
    "notes/admin-plan.md": "# Plan\n\nThe admin's own plan.\n",
    "vault/inside.md": "# Inside\n\nVaultword.\n",
    "shared/team.md": "# Team\n",
    "shared/viewer-only.md": "# Mine\n\nNodeword.\n",
    "notes/links.md": "# Links\n\nSee [[deal]].\n",
    "notes/viewer-index.md": "# Index\n\nSee [[deal]].\n",
    "notes/deal.md": "# Deal\n",
}


class TestAccessPaths(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        for rel in ("notes/viewer-secret.md", "vault", "shared/viewer-only.md",
                    "notes/viewer-index.md", "notes/deal.md"):
            cls.fs.set_owner(rel, VIEWER)
        cls.fs.set_owner("notes/admin-plan.md", "user:" + ADMIN_EMAIL)
        cls.admin = cls._session(ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.viewer = cls._session(VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    @classmethod
    def _session(cls, email, password):
        cookie = session_cookie(cls.srv, email, password)
        return {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(cls.srv, cookie)}

    def raw_get(self, target, who):
        """The request target sent as is: urllib would drop a '#' a raw client can send."""
        conn = http.client.HTTPConnection(urlsplit(self.srv.base_url).netloc, timeout=10)
        try:
            conn.request("GET", target, headers={"Cookie": who["Cookie"]})
            resp = conn.getresponse()
            return resp.status, resp.read().decode("utf-8", "replace")
        finally:
            conn.close()

    def test_no_spelling_of_the_url_serves_a_private_doc(self):
        for target in ("/notes/viewer-secret.md#x", "/vault/inside.md#/../../welcome.md",
                       "/notes/viewer-secret.md%23", "/vault//inside.md"):
            with self.subTest(target=target):
                status, body = self.raw_get(target, self.admin)
                self.assertEqual(status, 404)
                self.assertNotIn("Quasarword", body)
                self.assertNotIn("Vaultword", body)
        self.assertEqual(self.raw_get("/notes/open.md#x", self.admin)[0], 200)

    def test_a_folder_is_never_listed(self):
        status, body = self.raw_get("/notes/", self.admin)
        self.assertEqual(status, 404)
        self.assertNotIn("viewer-secret", body)

    def test_annotations_follow_the_rights_of_their_doc(self):
        made = self.srv.post("/api/notes", headers=self.admin, json_body={
            "path": "notes/admin-plan.md", "note": "check", "exact": "own plan"})
        self.assertEqual(made.status, 200)
        self.assertEqual(self.srv.get("/api/notes?path=notes/admin-plan.md", headers=self.viewer).status, 404)
        refused = self.srv.post("/api/notes", headers=self.admin, json_body={
            "path": "notes/viewer-secret.md", "note": "peek", "exact": "Quasarword"})
        self.assertEqual(refused.status, 404)

    def test_a_share_link_points_only_where_its_maker_may(self):
        mine = self.srv.post("/api/share", headers=self.admin, json_body={"path": "notes/open.md"})
        self.assertEqual(mine.status, 200)
        repoint = self.srv.patch(f"/api/share/{mine.json()['id']}", headers=self.admin,
                                 json_body={"path": "notes/viewer-secret.md"})
        self.assertEqual(repoint.status, 404)
        theirs = self.srv.post("/api/share", headers=self.viewer, json_body={"path": "notes/viewer-secret.md"})
        self.assertEqual(theirs.status, 200)
        listed = [s["path"] for s in self.srv.get("/api/share/list", headers=self.admin).json()]
        self.assertIn("notes/open.md", listed)
        self.assertNotIn("notes/viewer-secret.md", listed)

    def test_a_node_publishes_only_the_commons(self):
        self.assertEqual(self.srv.post("/api/admin/nodes", headers=self.admin,
                                       json_body={"name": "vault", "path": "vault"}).status, 400)
        made = self.srv.post("/api/admin/nodes", headers=self.admin, json_body={"name": "team", "path": "shared"})
        self.assertEqual(made.status, 201)
        token = decode_node_link(made.json()["link"])["token"]
        manifest = self.srv.get("/api/node/manifest", headers={"Authorization": "Bearer " + token}).json()
        self.assertEqual([f["path"] for f in manifest["files"]], ["team.md"])

    def test_the_trash_is_no_way_into_a_private_folder(self):
        planted = self.srv.put("/api/file", headers=self.admin, json_body={
            "path": ".trash/vault/planted.md", "content": "# Planted\n"})
        self.assertEqual(planted.status, 400)
        # One that got there anyway (an old version, a hand-made file) is not restored into it.
        trashed = self.srv.content_root / ".trash" / "vault" / "slipped.md"
        trashed.parent.mkdir(parents=True, exist_ok=True)
        trashed.write_text("# Slipped\n", encoding="utf-8")
        self.fs.set_owner(".trash/vault/slipped.md", "user:" + ADMIN_EMAIL)
        restore = self.srv.post("/api/trash/restore", headers=self.admin, json_body={"path": ".trash/vault/slipped.md"})
        self.assertEqual(restore.status, 403)
        self.assertFalse((self.srv.content_root / "vault" / "slipped.md").exists())

    def test_moving_a_private_doc_does_not_publish_its_new_name(self):
        moved = self.srv.post("/api/file/move", headers=self.viewer,
                              json_body={"from": "notes/deal.md", "to": "notes/acme-takeover.md"})
        self.assertEqual(moved.status, 200, moved.text)
        read = lambda rel: (self.srv.content_root / rel).read_text(encoding="utf-8")
        self.assertIn("[[deal]]", read("notes/links.md"))  # a commons doc keeps the old name
        self.assertIn("[[acme-takeover]]", read("notes/viewer-index.md"))  # the owner's own follows
        activity = self.srv.get("/api/activity?days=1", headers=self.admin).text
        self.assertNotIn("acme-takeover", activity)

    def test_only_a_navigation_signs_out(self):
        image = self.srv.get("/logout", headers={**self.viewer, "Sec-Fetch-Dest": "image"})
        self.assertEqual(image.status, 403)
        self.assertTrue(self.srv.get("/api/me", headers=self.viewer).json().get("authenticated"))

    def test_a_removed_account_is_out_with_its_tokens(self):
        email = "leaving@test.local"
        self.fs.upsert_user(email, {"password_hash": store.hash_password("leaving-password-42"), "role": "admin"})
        cookie = session_cookie(self.srv, email, "leaving-password-42")
        token = self.fs.create_api_identity("leaving-bot", acts_as=email)[1]
        gone = self.srv.request("DELETE", "/api/admin/users", headers=self.admin, json_body={"email": email})
        self.assertEqual(gone.status, 200)
        self.assertFalse(self.srv.get("/api/me", headers={"Cookie": cookie}).json().get("authenticated"))
        call = self.srv.post(f"/mcp/{token}", json_body={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(call.status, 401)


class TestDiskCase(unittest.TestCase):
    def test_a_path_takes_the_case_its_folders_hold(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "notes").mkdir()
            (Path(tmp) / "notes" / "Secret.md").write_text("x", encoding="utf-8")
            self.assertEqual(server._disk_case(Path(tmp), "NOTES/secret.MD"), "notes/Secret.md")


class TestSessionSecret(unittest.TestCase):
    def test_a_guessable_secret_is_refused(self):
        for weak in (b"", b"change-me", b"dev-secret-change-me", b"short-secret"):
            self.assertTrue(server._weak_secret(weak), weak)
        self.assertFalse(server._weak_secret(b"9f2c4e1a7b3d5f60a8c2e4f6b1d3a5c7"))

    def test_the_systemd_unit_carries_no_secret(self):
        set_lines = [ln for ln in cli.DEPLOY_SYSTEMD.splitlines() if ln.startswith("Environment=SESSION_SECRET")]
        self.assertEqual(set_lines, [])


if __name__ == "__main__":
    unittest.main()
