"""Leaving with one's notes: GET /api/export zips every file the person may read, never
the registry or the trash; the whole history (git bundle) comes along only when the mind
is entirely theirs — a shared mind's history holds the others' private docs."""
import io
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import store  # noqa: E402
from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
    file_store_of, session_cookie)

MIND = {"notes/shared.md": "# Shared\n", "notes/admin-only.md": "# Admin only\n",
        ".trash/notes/gone.md": "# Gone\n"}


class TestExport(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(mind=MIND, extra_env=cloud_env())
        self.srv.start()
        self.fs = file_store_of(self.srv)
        self.fs.upsert_user(ADMIN_EMAIL, {"password_hash": store.hash_password(ADMIN_PASSWORD),
                                          "role": "admin"})

    def tearDown(self):
        self.srv.stop()

    def _export(self, email, password):
        resp = self.srv.get("/api/export", headers={"Cookie": session_cookie(self.srv, email, password)})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "application/zip")
        return {n.split("/", 1)[1] for n in zipfile.ZipFile(io.BytesIO(resp.body)).namelist()}

    def test_sole_account_gets_notes_and_history_never_the_registry(self):
        names = self._export(ADMIN_EMAIL, ADMIN_PASSWORD)
        self.assertIn("notes/shared.md", names)
        self.assertIn("history.bundle", names)
        self.assertFalse(any(n.startswith((".atlas", ".trash")) for n in names), names)

    def test_shared_mind_exports_what_each_may_read_without_history(self):
        self.fs.upsert_user(VIEWER_EMAIL, {"password_hash": store.hash_password(VIEWER_PASSWORD),
                                           "role": "viewer"})
        self.fs.set_owner("notes/admin-only.md", "user:" + ADMIN_EMAIL)
        names = self._export(VIEWER_EMAIL, VIEWER_PASSWORD)
        self.assertIn("notes/shared.md", names)
        self.assertNotIn("notes/admin-only.md", names)
        self.assertNotIn("history.bundle", names)
        self.assertNotIn("history.bundle", self._export(ADMIN_EMAIL, ADMIN_PASSWORD))

    def test_requires_a_session(self):
        self.assertEqual(self.srv.get("/api/export").status, 401)

    def test_a_note_sent_as_a_file_stands_alone(self):
        # One note as a page that opens anywhere: its libraries inside, and the pictures
        # beside it the sender may read; never one they may not.
        (self.srv.content_root / "notes" / "photo.png").write_bytes(b"\x89PNG-ok")
        (self.srv.content_root / "notes" / "secret.png").write_bytes(b"\x89PNG-no")
        (self.srv.content_root / "notes" / "page.md").write_text(
            "# Ma page\n\n![](photo.png)\n\n![](secret.png)\n", encoding="utf-8")
        self.fs.upsert_user(VIEWER_EMAIL, {"password_hash": store.hash_password(VIEWER_PASSWORD),
                                           "role": "viewer"})
        self.fs.set_owner("notes/secret.png", "user:" + ADMIN_EMAIL)
        cookie = session_cookie(self.srv, VIEWER_EMAIL, VIEWER_PASSWORD)
        resp = self.srv.get("/api/export/page?path=notes/page.md", headers={"Cookie": cookie})
        self.assertEqual(resp.status, 200)
        self.assertIn("attachment", resp.headers.get("Content-Disposition", ""))
        page = resp.text
        self.assertNotIn('src="/vendor/', page)
        self.assertIn("<title>Ma page", page)
        self.assertIn("data:image/png;base64,iVBORy1vaw", page)  # photo.png
        self.assertNotIn("iVBORy1ubw", page)                      # secret.png stays out
        self.assertEqual(self.srv.get("/api/export/page?path=notes/admin-only.md",
                                      headers={"Cookie": cookie}).status, 200)
        self.fs.set_owner("notes/admin-only.md", "user:" + ADMIN_EMAIL)
        self.assertEqual(self.srv.get("/api/export/page?path=notes/admin-only.md",
                                      headers={"Cookie": cookie}).status, 404)


class TestCliExport(unittest.TestCase):
    def test_cli_export_bundles_the_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            mind, out = Path(tmp) / "m", Path(tmp) / "out.zip"
            cli = str(TESTS_DIR.parent / "src" / "cli.py")
            subprocess.run([sys.executable, cli, "init", str(mind), "--yes"], check=True,
                           capture_output=True)
            subprocess.run([sys.executable, cli, "export", str(mind), "--out", str(out)],
                           check=True, capture_output=True)
            with zipfile.ZipFile(out) as z:
                names = {n.split("/", 1)[1] for n in z.namelist()}
                bundle = z.read(next(n for n in z.namelist() if n.endswith("history.bundle")))
            self.assertIn("welcome.md", names)
            restored = Path(tmp) / "history.bundle"
            restored.write_bytes(bundle)
            clone = subprocess.run(["git", "clone", "-q", str(restored), str(Path(tmp) / "back")],
                                   capture_output=True, text=True)
            self.assertEqual(clone.returncode, 0, clone.stderr)
            self.assertTrue((Path(tmp) / "back" / "content" / "welcome.md").exists())


if __name__ == "__main__":
    unittest.main()
