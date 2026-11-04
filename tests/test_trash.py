"""The viewer's delete is reversible like delete_doc's: DELETE /api/file moves the doc
to .trash/ (ACL along, shares revoked), GET /api/trash lists what this person may
restore, POST /api/trash/restore puts it back — beside it when the place is taken."""
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


class TestTrash(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.admin = cls._headers(ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.viewer = cls._headers(VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    @classmethod
    def _headers(cls, email, password):
        cookie = session_cookie(cls.srv, email, password)
        return {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(cls.srv, cookie)}

    def _create(self, rel, text, who):
        resp = self.srv.request("PUT", "/api/file", headers=who,
                                json_body={"path": rel, "content": text})
        self.assertEqual(resp.status, 200)

    def _delete(self, rel, who):
        return self.srv.request("DELETE", "/api/file", headers=who, json_body={"path": rel})

    def _trash(self, who):
        resp = self.srv.get("/api/trash", headers=who)
        self.assertEqual(resp.status, 200)
        return {i["original"]: i for i in resp.json()["items"]}

    def _restore(self, trashed, who):
        return self.srv.post("/api/trash/restore", headers=who, json_body={"path": trashed})

    def test_delete_goes_to_trash_and_restores(self):
        self._create("notes/gone.md", "# Gone\n", self.admin)
        resp = self._delete("notes/gone.md", self.admin)
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json()["trashed"], ".trash/notes/gone.md")
        self.assertFalse((self.srv.content_root / "notes/gone.md").exists())
        item = self._trash(self.admin)["notes/gone.md"]
        self.assertGreater(item["deleted_at"], 0)

        resp = self._restore(item["path"], self.admin)
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json()["path"], "notes/gone.md")
        self.assertEqual((self.srv.content_root / "notes/gone.md").read_text(encoding="utf-8"), "# Gone\n")
        self.assertNotIn("notes/gone.md", self._trash(self.admin))

    def test_restore_beside_a_doc_now_at_that_place(self):
        self._create("notes/twin.md", "# Old\n", self.admin)
        self._delete("notes/twin.md", self.admin)
        self._create("notes/twin.md", "# New\n", self.admin)
        resp = self._restore(".trash/notes/twin.md", self.admin)
        self.assertEqual(resp.json()["path"], "notes/twin-restored.md")
        self.assertEqual((self.srv.content_root / "notes/twin.md").read_text(encoding="utf-8"), "# New\n")

    def test_a_private_doc_stays_private_in_the_trash(self):
        self._create("notes/mine.md", "# Mine\n", self.admin)
        self.fs.set_owner("notes/mine.md", "user:" + ADMIN_EMAIL)
        self._delete("notes/mine.md", self.admin)
        self.assertNotIn("notes/mine.md", self._trash(self.viewer))
        self.assertEqual(self._restore(".trash/notes/mine.md", self.viewer).status, 404)
        self.assertIn("notes/mine.md", self._trash(self.admin))

    def test_a_pdf_goes_to_trash_and_restores(self):
        pdf = self.srv.content_root / "notes/scan.pdf"
        pdf.write_bytes(b"%PDF-1.4 scan")
        resp = self._delete("notes/scan.pdf", self.admin)
        self.assertEqual(resp.status, 200, resp.body)
        self.assertFalse(pdf.exists())
        item = self._trash(self.admin)["notes/scan.pdf"]
        self.assertEqual(self._restore(item["path"], self.admin).json()["path"], "notes/scan.pdf")
        self.assertEqual(pdf.read_bytes(), b"%PDF-1.4 scan")

    def _purge(self, body, who):
        return self.srv.request("DELETE", "/api/trash", headers=who, json_body=body)

    def test_an_item_is_deleted_for_good(self):
        self._create("notes/poof.md", "# Poof\n", self.admin)
        self._delete("notes/poof.md", self.admin)
        self.assertEqual(self._purge({"path": ".trash/notes/poof.md"}, self.admin).json()["deleted"], 1)
        self.assertFalse((self.srv.content_root / ".trash/notes/poof.md").exists())
        self.assertNotIn("notes/poof.md", self._trash(self.admin))
        self.assertEqual(self._purge({"path": ".trash/notes/poof.md"}, self.admin).status, 404)

    def test_emptying_takes_only_what_is_yours(self):
        self._create("notes/a-moi.md", "# A moi\n", self.admin)
        self.fs.set_owner("notes/a-moi.md", "user:" + ADMIN_EMAIL)
        self._delete("notes/a-moi.md", self.admin)
        self._purge({"all": True}, self.viewer)
        self.assertTrue((self.srv.content_root / ".trash/notes/a-moi.md").exists())
        self._purge({"all": True}, self.admin)
        self.assertEqual(self._trash(self.admin), {})

    def test_restore_refuses_paths_outside_the_trash(self):
        self._create("notes/live.md", "# Live\n", self.admin)
        for bad in ("notes/live.md", ".trash/../notes/live.md", ".trash/../../atlas.toml"):
            self.assertEqual(self._restore(bad, self.admin).status, 404, bad)


if __name__ == "__main__":
    unittest.main()
