"""Getting a mind back from the zip "Export my notes" made: with its history bundle every
version returns and the history it replaces stays reachable; without one, its files are
laid over the notes; a zip reaching outside the mind is refused; only the owner of a mind
that is theirs alone may do it, and never past a connected GitHub copy."""
import io
import shutil
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
from server.pure import restore  # noqa: E402
from server.pure.export import exportable, write_export  # noqa: E402
from test_admin import ADMIN_EMAIL, ADMIN_PASSWORD, cloud_env, csrf_token_for, file_store_of, session_cookie  # noqa: E402


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True).stdout


def _mind(root: Path, notes: dict) -> Path:
    root.mkdir(parents=True)
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "a@example.com")
    _git(root, "config", "user.name", "A")
    (root / "atlas.toml").write_bytes(b'name = "test"\n')
    for rel, text in notes.items():
        path = root / "content" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode())
        _git(root, "add", "-A")
        _git(root, "commit", "-q", "-m", f"write {rel}")
    return root


def _export(mind: Path, history=True) -> bytes:
    buf = io.BytesIO()
    content = mind / "content"
    write_export(buf, content, exportable(content, lambda rel: True), "my-atlas", "fr",
                 mind if history else None)
    return buf.getvalue()


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestRestore(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-restore-"))
        self.old = _mind(self.tmp / "old", {"a.md": "# A v1\n", "dir/b.md": "# B\n"})
        (self.old / "content" / "a.md").write_bytes(b"# A v2\n")
        _git(self.old, "commit", "-qam", "a v2")
        self.new = _mind(self.tmp / "new", {"welcome.md": "# Welcome\n"})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def zip(self, data: bytes) -> Path:
        path = self.tmp / f"backup-{len(list(self.tmp.glob('*.zip')))}.zip"
        path.write_bytes(data)
        return path

    def test_the_history_comes_back_and_the_replaced_one_stays(self):
        backup = self.zip(_export(self.old))
        bundle, files, _ = restore.read_backup(backup)
        self.assertEqual(bundle, "my-atlas/historique.bundle")
        self.assertNotIn("LISEZ-MOI.txt", [rel for _, rel in files])
        before = _git(self.new, "rev-parse", "HEAD").strip()
        restore.restore_history(self.new, backup, bundle)
        self.assertEqual((self.new / "content" / "a.md").read_text().strip(), "# A v2")
        self.assertFalse((self.new / "content" / "welcome.md").exists())
        self.assertIn("a v2", _git(self.new, "log", "--format=%s"))
        self.assertEqual(_git(self.new, "rev-parse", restore.BEFORE).strip(), before)

    def test_without_history_the_files_are_laid_over(self):
        backup = self.zip(_export(self.old, history=False))
        bundle, files, _ = restore.read_backup(backup)
        self.assertIsNone(bundle)
        self.assertEqual(restore.restore_files(self.new / "content", backup, files), 2)
        self.assertEqual((self.new / "content" / "dir" / "b.md").read_bytes(), b"# B\n")
        self.assertTrue((self.new / "content" / "welcome.md").exists())

    def test_a_note_named_like_the_readme_is_kept(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("my-atlas/README.txt", "My own readme\n")
            z.writestr("my-atlas/.trash/gone.md", "x")
        _, files, _ = restore.read_backup(self.zip(buf.getvalue()))
        self.assertEqual([rel for _, rel in files], ["README.txt"])

    def test_unsafe_or_foreign_zips_are_refused(self):
        for name in ("../escape.md", "/abs.md", "C:/win.md"):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                z.writestr(name, "x")
            with self.assertRaises(restore.RestoreError, msg=name):
                restore.read_backup(self.zip(buf.getvalue()))
        with self.assertRaises(restore.RestoreError):
            restore.read_backup(self.zip(b"not a zip"))
        plain = _mind(self.tmp / "plain", {})
        (plain / "notes.md").write_bytes(b"x")
        _git(plain, "add", "-A")
        _git(plain, "commit", "-qm", "not atlas")
        _git(plain, "bundle", "create", str(self.tmp / "p.bundle"), "--all")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.write(self.tmp / "p.bundle", "x/history.bundle")
        backup = self.zip(buf.getvalue())
        with self.assertRaises(restore.RestoreError) as caught:
            restore.restore_history(self.new, backup, "x/history.bundle")
        self.assertEqual(caught.exception.code, "not_atlas")
        self.assertTrue((self.new / "content" / "welcome.md").exists())


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestRestoreRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        with open(cls.srv.root / ".git" / "info" / "exclude", "a", encoding="utf-8") as f:
            f.write("\nserver.log\n")
        cls.fs = file_store_of(cls.srv)
        cls.fs.upsert_user(ADMIN_EMAIL, {"password_hash": store.hash_password(ADMIN_PASSWORD),
                                         "role": "admin"})
        cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin = {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(cls.srv, cookie)}
        cls.tmp = Path(tempfile.mkdtemp(prefix="atlas-restore-route-"))
        cls.old = _mind(cls.tmp / "old", {"from-backup.md": "# Back\n"})

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def post(self, data: bytes, ctype="application/zip"):
        return self.srv.request("POST", "/api/admin/restore", data=data,
                                headers={**self.admin, "Content-Type": ctype})

    def test_a_form_cannot_post_it(self):
        self.assertEqual(self.post(_export(self.old), ctype="multipart/form-data").status, 415)

    def test_the_history_is_restored(self):
        resp = self.post(_export(self.old))
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(resp.json()["mode"], "history")
        self.assertTrue((self.srv.content_root / "from-backup.md").is_file())

    def backup(self, password):
        return self.srv.post("/api/admin/backup", json_body={"password": password}, headers=self.admin)

    def test_a_full_backup_asks_the_password_and_brings_the_registry_back(self):
        self.assertEqual((self.backup("not-it").status, self.backup("not-it").json()["error"]),
                         (401, "bad_password"))
        self.fs.set_owner("perso/journal.md", "user:" + ADMIN_EMAIL)
        made = self.backup(ADMIN_PASSWORD)
        self.assertEqual(made.status, 200)
        names = zipfile.ZipFile(io.BytesIO(made.body)).namelist()
        top = names[0].split("/")[0]
        self.assertIn(f"{top}/.atlas/users.json", names)
        self.assertIn(f"{top}/.atlas/acl.json", names)
        self.assertFalse(any(n.endswith((".lock", "state.json")) for n in names), names)
        self.fs.delete_acl("perso/journal.md")
        (self.srv.root / ".atlas" / "todos.json").write_text('{"x": [{"text": "made since"}]}', encoding="utf-8")
        restored = self.post(made.body)
        self.assertEqual(restored.status, 200, restored.text)
        self.assertTrue(restored.json()["registry"])
        self.assertEqual(file_store_of(self.srv).get_acl("perso/journal.md")["owner"], "user:" + ADMIN_EMAIL)
        self.assertFalse((self.srv.root / ".atlas" / "todos.json").exists())  # made after the backup

    def test_not_past_a_github_copy_nor_in_a_shared_mind(self):
        self.srv.git("remote", "add", "origin", "git@github.com:me/copy.git", check=True)
        try:
            resp = self.post(_export(self.old))
            self.assertEqual((resp.status, resp.json()["error"]), (409, "github_connected"))
        finally:
            self.srv.git("remote", "remove", "origin")
        self.fs.upsert_user("other@example.com", {"password_hash": store.hash_password("x" * 12),
                                                  "role": "viewer"})
        try:
            resp = self.post(_export(self.old))
            self.assertEqual((resp.status, resp.json()["error"]), (403, "shared"))
            resp = self.backup(ADMIN_PASSWORD)
            self.assertEqual((resp.status, resp.json()["error"]), (403, "shared"))
        finally:
            self.fs.delete_user("other@example.com")


if __name__ == "__main__":
    unittest.main()
