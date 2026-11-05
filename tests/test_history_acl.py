"""A doc's history follows its rights (acl.level_at): a private doc moved, trashed or deleted
for good never opens its past to someone who can't read it, its owner keeps that past, and
whoever takes over a freed path does not get the old doc's past.
Run: python tests/test_history_acl.py"""
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
import store  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
    csrf_token_for, file_store_of, seed_admin_and_viewer, session_cookie)
from test_mcp_tools import _call  # noqa: E402

ADMIN = "user:" + ADMIN_EMAIL

MIND = {
    "welcome.md": "# Welcome\n",
    "notes/budget.md": "# Budget\n\nNebulacode budget is 425000 euros.\n",
    "notes/open.md": "# Open\n\nOpenword is for everyone.\n",
    "notes/gone.md": "# Gone\n\nGoneword was private.\n",
    "vault/inside.md": "# Inside\n\nVaultword stays in the vault.\n",
    "archive/plan.md": "# Plan\n\nFolderword is the plan.\n",
}


class TestHistoryFollowsRights(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env(), mind=MIND, seed_date="2025-01-15T12:00:00")
        cls.srv.start()
        fs = file_store_of(cls.srv)
        seed_admin_and_viewer(fs)
        for rel in ("notes/budget.md", "notes/gone.md", "vault", "archive"):
            fs.set_owner(rel, ADMIN)
        fs.set_creator("vault/inside.md", ADMIN)
        cls.seed = cls.srv.git("rev-parse", "HEAD").stdout.strip()
        cls.owner = fs.create_api_identity("owner-bot", acts_as=ADMIN_EMAIL)[1]
        cls.outsider = fs.create_api_identity("other-bot", acts_as=VIEWER_EMAIL, scopes=["read"])[1]
        cls.admin = cls._session(ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.viewer = cls._session(VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    @classmethod
    def _session(cls, email, password):
        cookie = session_cookie(cls.srv, email, password)
        return {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(cls.srv, cookie)}

    def mcp(self, token, tool, **args):
        return _call(self.srv, token, tool, args)

    def old_text(self, token, rel):
        return str(self.mcp(token, "doc_at", path=rel, rev=self.seed)[1])

    def revision(self, rel, who):
        return self.srv.get(f"/api/revision?path={rel}&rev={self.seed}", headers=who)

    def test_a_moved_private_doc_keeps_its_past(self):
        self.assertFalse(self.mcp(self.owner, "move_doc", **{"from": "notes/budget.md", "to": "notes/budget-2026.md"})[0])
        self.assertNotIn("Nebulacode", self.old_text(self.outsider, "notes/budget.md"))
        self.assertTrue(self.mcp(self.outsider, "doc_diff", path="notes/budget.md", rev=self.seed)[0])
        self.assertEqual(self.mcp(self.outsider, "doc_history", path="notes/budget.md")[1]["revisions"], [])
        then = self.mcp(self.outsider, "then_and_now", topic="Nebulacode", at="2025-02-01")[1]
        self.assertNotIn("Nebulacode", str(then.get("docs")))
        self.assertEqual(self.revision("notes/budget.md", self.viewer).status, 404)

        self.assertIn("Nebulacode", self.old_text(self.owner, "notes/budget.md"))
        self.assertIn("Nebulacode", self.old_text(self.owner, "notes/budget-2026.md"))
        self.assertEqual(self.revision("notes/budget.md", self.admin).status, 200)

    def test_a_purged_private_doc_stays_private_and_its_path_starts_clean(self):
        delete = self.srv.request("DELETE", "/api/file", headers=self.admin, json_body={"path": "notes/gone.md"})
        self.assertEqual(delete.status, 200)
        self.assertNotIn("Goneword", self.old_text(self.outsider, "notes/gone.md"))
        self.assertEqual(self.mcp(self.outsider, "search_history", query="Goneword")[1]["matches"], [])
        self.assertTrue(self.mcp(self.owner, "search_history", query="Goneword")[1]["matches"])

        purge = self.srv.request("DELETE", "/api/trash", headers=self.admin, json_body={"path": ".trash/notes/gone.md"})
        self.assertEqual(purge.json()["deleted"], 1)
        self.assertNotIn("Goneword", self.old_text(self.outsider, "notes/gone.md"))
        self.assertIn("Goneword", self.old_text(self.owner, "notes/gone.md"))

        put = self.srv.put("/api/file", headers=self.viewer, json_body={"path": "notes/gone.md", "content": "# Mine\n\nMine now.\n"})
        self.assertEqual(put.status, 200)
        revisions = self.srv.get("/api/history?path=notes/gone.md", headers=self.viewer).json()["revisions"]
        self.assertEqual(len(revisions), 1)
        self.assertEqual(self.revision("notes/gone.md", self.viewer).status, 404)
        self.assertIn("Mine now", str(self.mcp(self.outsider, "read_doc", path="notes/gone.md")[1]))

    def test_a_doc_trashed_from_a_private_folder_stays_private(self):
        delete = self.srv.request("DELETE", "/api/file", headers=self.admin, json_body={"path": "vault/inside.md"})
        self.assertEqual(delete.json()["trashed"], ".trash/vault/inside.md")
        self.assertNotIn("Vaultword", str(self.mcp(self.outsider, "read_doc", path=".trash/vault/inside.md")[1]))
        self.assertNotIn("Vaultword", self.old_text(self.outsider, "vault/inside.md"))
        trash = self.srv.get("/api/trash", headers=self.viewer).json()["items"]
        self.assertNotIn("vault/inside.md", [i["original"] for i in trash])

        restore = self.srv.post("/api/trash/restore", headers=self.admin, json_body={"path": ".trash/vault/inside.md"})
        self.assertEqual(restore.json()["path"], "vault/inside.md")
        self.assertNotIn("Vaultword", str(self.mcp(self.outsider, "read_doc", path="vault/inside.md")[1]))

    def test_a_moved_private_folder_keeps_its_past(self):
        self.assertFalse(self.mcp(self.owner, "move_doc", **{"from": "archive", "to": "archive-2026"})[0])
        self.assertNotIn("Folderword", self.old_text(self.outsider, "archive/plan.md"))
        self.assertIn("Folderword", self.old_text(self.owner, "archive/plan.md"))

    def test_a_moved_commons_doc_keeps_its_past_open(self):
        self.assertFalse(self.mcp(self.owner, "move_doc", **{"from": "notes/open.md", "to": "notes/open-now.md"})[0])
        self.assertIn("Openword", self.old_text(self.outsider, "notes/open.md"))
        then = self.mcp(self.outsider, "then_and_now", topic="Openword", at="2025-02-01")[1]
        self.assertIn("Openword", str(then.get("docs")))


class TestTrail(unittest.TestCase):
    """The store's side: what the trail keeps, and that it moves with the principals."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fs = store.FileStore(self.tmp.name, head=lambda: "c0ffee")

    def tearDown(self):
        self.tmp.cleanup()

    def test_moves_and_private_deletions_are_kept(self):
        self.fs.set_owner("a.md", ADMIN)
        self.fs.repoint_acl_by_path("a.md", "b.md")
        self.fs.set_creator("open.md", ADMIN)
        self.fs.delete_acl("open.md")  # a commons doc had nothing private to keep
        self.fs.delete_acl("b.md")
        self.assertEqual(self.fs.acl_trail(), [
            {"from": "a.md", "to": "b.md", "before": "c0ffee"},
            {"from": "b.md", "entry": {"owner": ADMIN, "grants": []}, "before": "c0ffee"},
        ])

    def test_the_kept_rights_follow_a_deleted_user(self):
        self.fs.set_owner("a.md", "user:old@x")
        self.fs.grant("a.md", "user:friend@x", "view")
        self.fs.delete_acl("a.md")
        self.fs.reassign_principal("user:old@x", ADMIN)
        self.fs.purge_grants_for_principal("user:friend@x")
        kept = self.fs.acl_trail()[0]["entry"]
        self.assertEqual((kept["owner"], kept["grants"]), (ADMIN, []))

    def test_a_backup_carries_the_trail(self):
        self.assertIn(store.FileStore.TRAIL_FILE, store.FileStore.DURABLE_FILES)


if __name__ == "__main__":
    unittest.main()
