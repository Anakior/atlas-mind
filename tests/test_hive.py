"""Hive — atlas nodes, PUBLISHING side (#10, Phase A).

An admin publishes a folder OR a file as a "node": they get a self-contained,
copyable link (origin + token + name + path). The remote recipient has NO
session here: they read the manifest and the subtree's files via a node Bearer
token, read-only, and can only see that subtree — neither the rest of the
content, nor the admin, nor the v1 API.
"""
import base64
import hashlib
import json
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer, TODO_REL, DEFAULT_QUICK_MD  # noqa: E402
import store  # noqa: E402

ADMIN_EMAIL, ADMIN_PW = "admin@fed.local", "admin-pw-0123456789"

GUIDE_BODY = "# Guide\n\nContenu du guide d'equipe.\n"
DEEP_BODY = "# Deep\n\nDoc imbrique sous le noeud.\n"
SECRET_BODY = "# Secret\n\nNe doit jamais fuiter par le noeud team.\n"

MIND = {
    "team/guide.md": GUIDE_BODY,
    "team/sub/deep.md": DEEP_BODY,
    "private/secret.md": SECRET_BODY,
    TODO_REL: DEFAULT_QUICK_MD,
}

CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "fed-test-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
    # Self-subscription tests fetch the node over loopback (127.0.0.1); opt in
    # to private/loopback remotes so the SSRF guard does not block the harness.
    "ATLAS_ALLOW_PRIVATE_REMOTES": "1",
}


def _decode_link(link: str) -> dict:
    assert link.startswith("atlas-node:"), link
    blob = link[len("atlas-node:"):]
    blob += "=" * (-len(blob) % 4)  # re-adds the stripped base64url padding
    return json.loads(base64.urlsafe_b64decode(blob).decode())


class TestNodePublishing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=MIND, extra_env=CLOUD_ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        fs.upsert_user(ADMIN_EMAIL, {
            "password_hash": store.hash_password(ADMIN_PW), "role": "admin"})
        resp = cls.srv.post("/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        assert resp.status == 303, resp.status
        cls.admin = resp.headers.get("Set-Cookie", "").split(";", 1)[0]
        cls.csrf = cls.srv.get("/api/me", headers={"Cookie": cls.admin}).json().get("csrf_token", "")

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _admin_hdr(self):
        return {"Cookie": self.admin, "X-CSRF-Token": self.csrf}

    def _create_node(self, name, path):
        return self.srv.post("/api/admin/nodes",
                             json_body={"name": name, "path": path},
                             headers=self._admin_hdr())

    def _bearer(self, token):
        return {"Authorization": f"Bearer {token}"}

    def test_create_folder_node_returns_decodable_link(self):
        r = self._create_node("team", "team")
        self.assertEqual(r.status, 201, r.body)
        payload = r.json()
        self.assertEqual(payload["path"], "team")
        decoded = _decode_link(payload["link"])
        self.assertEqual(decoded["name"], "team")
        self.assertEqual(decoded["path"], "team")
        self.assertTrue(decoded["token"])
        self.assertTrue(decoded["url"])

    def test_manifest_lists_subtree_only(self):
        token = _decode_link(self._create_node("team", "team").json()["link"])["token"]
        manifest = self.srv.get("/api/node/manifest", headers=self._bearer(token)).json()
        paths = {f["path"] for f in manifest["files"]}
        self.assertEqual(paths, {"guide.md", "sub/deep.md"})   # rebased on the node root
        self.assertNotIn("secret.md", paths)                   # content outside the node does not leak
        guide = next(f for f in manifest["files"] if f["path"] == "guide.md")
        self.assertEqual(guide["sha256"], hashlib.sha256(GUIDE_BODY.encode()).hexdigest())
        self.assertEqual(guide["size"], len(GUIDE_BODY.encode()))

    def test_file_fetch_returns_content(self):
        token = _decode_link(self._create_node("team", "team").json()["link"])["token"]
        r = self.srv.get("/api/node/file?path=sub/deep.md", headers=self._bearer(token))
        self.assertEqual(r.status, 200)
        self.assertEqual(r.body.decode(), DEEP_BODY)

    def test_file_outside_node_is_404(self):
        token = _decode_link(self._create_node("team", "team").json()["link"])["token"]
        # A real file but outside the node's subtree: invisible through this token.
        r = self.srv.get("/api/node/file?path=private/secret.md", headers=self._bearer(token))
        self.assertEqual(r.status, 404)

    def test_manifest_requires_valid_token(self):
        self.assertEqual(self.srv.get("/api/node/manifest").status, 401)
        self.assertEqual(self.srv.get("/api/node/manifest",
                         headers=self._bearer("not-a-real-token")).status, 401)

    def test_single_file_node(self):
        token = _decode_link(self._create_node("le-secret", "private/secret.md").json()["link"])["token"]
        manifest = self.srv.get("/api/node/manifest", headers=self._bearer(token)).json()
        self.assertEqual([f["path"] for f in manifest["files"]], ["secret.md"])
        r = self.srv.get("/api/node/file?path=secret.md", headers=self._bearer(token))
        self.assertEqual(r.body.decode(), SECRET_BODY)

    def test_revoke_kills_token(self):
        token = _decode_link(self._create_node("ephemere", "team").json()["link"])["token"]
        self.assertEqual(self.srv.get("/api/node/manifest", headers=self._bearer(token)).status, 200)
        r = self.srv.delete("/api/admin/nodes",
                            json_body={"name": "ephemere"}, headers=self._admin_hdr())
        self.assertEqual(r.status, 200, r.body)
        self.assertEqual(self.srv.get("/api/node/manifest", headers=self._bearer(token)).status, 401)

    def test_node_token_does_not_open_admin(self):
        token = _decode_link(self._create_node("team", "team").json()["link"])["token"]
        # A node token is NOT an admin session: the admin list rejects it.
        self.assertIn(self.srv.get("/api/admin/nodes", headers=self._bearer(token)).status,
                      (401, 403))

    def test_create_rejects_unknown_path(self):
        r = self._create_node("ghost", "does/not/exist")
        self.assertEqual(r.status, 400)

    def test_create_rejects_unsafe_names(self):
        # A node name becomes a directory under content/remotes/: '.', '..',
        # separators and control chars must be refused (a "." name would
        # collapse the mirror onto the whole remotes/ tree → sibling wipe).
        for bad in (".", "..", "a/b", "x\\y", "", "  "):
            r = self._create_node(bad, "team")
            self.assertEqual(r.status, 400, f"name {bad!r} accepted ({r.status})")

    def test_admin_list_reflects_created_nodes(self):
        self._create_node("listed", "team")
        nodes = self.srv.get("/api/admin/nodes", headers={"Cookie": self.admin}).json()
        names = {n["name"] for n in nodes}
        self.assertIn("listed", names)


def _encode_link(url, name, path, token):
    payload = {"url": url, "name": name, "path": path, "token": token}
    blob = base64.urlsafe_b64encode(
        json.dumps(payload).encode()).decode().rstrip("=")
    return "atlas-node:" + blob


class TestNodeSubscription(unittest.TestCase):
    """SUBSCRIBER side: the instance subscribes to ITS OWN node (self-subscription) —
    the manifest/files travel through a real outbound HTTP request to itself,
    which exercises the entire sync client without a 2nd instance."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=dict(MIND), extra_env=CLOUD_ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        fs.upsert_user(ADMIN_EMAIL, {
            "password_hash": store.hash_password(ADMIN_PW), "role": "admin"})
        resp = cls.srv.post("/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        assert resp.status == 303, resp.status
        cls.admin = resp.headers.get("Set-Cookie", "").split(";", 1)[0]
        cls.csrf = cls.srv.get("/api/me", headers={"Cookie": cls.admin}).json().get("csrf_token", "")

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _hdr(self):
        return {"Cookie": self.admin, "X-CSRF-Token": self.csrf}

    def _publish_and_subscribe(self, node_name, node_path, remote_name):
        # 1) Publish the node, retrieve the token from the link.
        pub = self.srv.post("/api/admin/nodes",
                            json_body={"name": node_name, "path": node_path},
                            headers=self._hdr()).json()
        token = _decode_link(pub["link"])["token"]
        # 2) Build a link pointing to the test server's real HTTP URL
        #    (the native link encodes https:// because auth is enabled) and subscribe.
        link = _encode_link(self.srv.base_url, remote_name, node_path, token)
        return self.srv.post("/api/admin/remotes",
                             json_body={"link": link}, headers=self._hdr())

    def test_subscribe_mirrors_subtree(self):
        r = self._publish_and_subscribe("team", "team", "team")
        self.assertEqual(r.status, 201, r.body)
        body = r.json()
        self.assertTrue(body["sync"]["ok"], body)
        self.assertEqual(body["sync"]["files"], 2)
        # The mirror is servable like a normal doc, under remotes/<name>/.
        guide = self.srv.get("/remotes/team/guide.md", headers={"Cookie": self.admin})
        self.assertEqual(guide.status, 200)
        self.assertEqual(guide.body.decode(), GUIDE_BODY)

    def test_remote_list_hides_token(self):
        self._publish_and_subscribe("team", "team", "tok-check")
        remotes = self.srv.get("/api/admin/remotes", headers={"Cookie": self.admin}).json()
        row = next(r for r in remotes if r["name"] == "tok-check")
        self.assertNotIn("token", row)            # the token NEVER leaves
        self.assertGreater(row["last_sync_at"], 0)
        self.assertEqual(row["last_error"], "")

    def test_mirror_is_read_only(self):
        self._publish_and_subscribe("team", "team", "ro")
        # Editing refused on the mirror…
        put = self.srv.put("/api/file",
                           json_body={"path": "remotes/ro/guide.md", "content": "hack"},
                           headers=self._hdr())
        self.assertEqual(put.status, 403)
        # …deletion too.
        dele = self.srv.delete("/api/file",
                               json_body={"path": "remotes/ro/guide.md"}, headers=self._hdr())
        self.assertEqual(dele.status, 403)

    def test_appropriate_makes_editable_copy(self):
        self._publish_and_subscribe("team", "team", "appr")
        r = self.srv.post("/api/admin/remotes/appropriate",
                          json_body={"name": "appr", "source": "guide.md", "dest": "mine/guide.md"},
                          headers=self._hdr())
        self.assertEqual(r.status, 201, r.body)
        self.assertEqual(r.json()["copied"], 1)
        # The copy is outside remotes/ → editable.
        copy = self.srv.get("/mine/guide.md", headers={"Cookie": self.admin})
        self.assertEqual(copy.body.decode(), GUIDE_BODY)
        put = self.srv.put("/api/file",
                           json_body={"path": "mine/guide.md", "content": "# Édité\n"},
                           headers=self._hdr())
        self.assertEqual(put.status, 200, put.body)

    def test_unsubscribe_removes_mirror(self):
        self._publish_and_subscribe("team", "team", "bye")
        self.assertEqual(self.srv.get("/remotes/bye/guide.md",
                         headers={"Cookie": self.admin}).status, 200)
        r = self.srv.delete("/api/admin/remotes",
                            json_body={"name": "bye"}, headers=self._hdr())
        self.assertEqual(r.status, 200, r.body)
        self.assertEqual(self.srv.get("/remotes/bye/guide.md",
                         headers={"Cookie": self.admin}).status, 404)
        remotes = self.srv.get("/api/admin/remotes", headers={"Cookie": self.admin}).json()
        self.assertNotIn("bye", {r["name"] for r in remotes})

    def test_bad_link_rejected(self):
        r = self.srv.post("/api/admin/remotes",
                          json_body={"link": "not-a-node-link"}, headers=self._hdr())
        self.assertEqual(r.status, 400)

    def test_appropriate_folder_refuses_overwrite(self):
        # Regression: the folder branch must mirror the single-file 409 guard —
        # never silently overwrite the admin's own (non-mirror) documents.
        self._publish_and_subscribe("team", "team", "appr-dir")
        r1 = self.srv.post("/api/admin/remotes/appropriate",
                           json_body={"name": "appr-dir", "source": "", "dest": "copy1"},
                           headers=self._hdr())
        self.assertEqual(r1.status, 201, r1.body)
        # A second appropriation onto the same dest collides → 409, no overwrite.
        r2 = self.srv.post("/api/admin/remotes/appropriate",
                           json_body={"name": "appr-dir", "source": "", "dest": "copy1"},
                           headers=self._hdr())
        self.assertEqual(r2.status, 409, r2.body)


class TestHiveSSRFGuard(unittest.TestCase):
    """Without ATLAS_ALLOW_PRIVATE_REMOTES, subscribing to a loopback/private
    URL must be refused by the SSRF guard (the link is attacker-supplied)."""

    @classmethod
    def setUpClass(cls):
        env = {k: v for k, v in CLOUD_ENV.items()
               if k != "ATLAS_ALLOW_PRIVATE_REMOTES"}
        cls.srv = AtlasServer(mind=dict(MIND), extra_env=env)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        fs.upsert_user(ADMIN_EMAIL, {
            "password_hash": store.hash_password(ADMIN_PW), "role": "admin"})
        resp = cls.srv.post("/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        cls.admin = resp.headers.get("Set-Cookie", "").split(";", 1)[0]
        cls.csrf = cls.srv.get("/api/me", headers={"Cookie": cls.admin}).json().get("csrf_token", "")

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_loopback_remote_refused_by_default(self):
        link = _encode_link("http://127.0.0.1:9/", "evil", "team", "tok")
        r = self.srv.post("/api/admin/remotes", json_body={"link": link},
                          headers={"Cookie": self.admin, "X-CSRF-Token": self.csrf})
        self.assertEqual(r.status, 201, r.body)
        self.assertFalse(r.json()["sync"]["ok"])           # sync blocked
        self.assertIn("non-routable", r.json()["sync"]["error"])


if __name__ == "__main__":
    unittest.main()
