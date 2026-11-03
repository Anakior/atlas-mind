"""Putting files into the mind from the viewer: a dropped file lands where it was dropped,
never over another one; a page that would run on the mind's origin (.html, .svg) never comes
in; a zip unpacks into a folder of its name and nothing in it can land outside that folder;
an image pasted into a note is exactly as private as the note; a member only puts files where
they may create a document."""
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
from server.pure import uploads  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env, csrf_token_for,
    file_store_of, seed_admin_and_viewer, session_cookie,
)


def _zip(members: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


class TestUploadRules(unittest.TestCase):
    def test_what_may_come_in(self):
        for ok in ("scan.pdf", "dossier/photo.JPG", "notes/a.md", "compta/2026.xlsx"):
            self.assertIsNotNone(uploads.clean_rel(ok), ok)
        for refused in ("page.html", "logo.svg", "run.js", "../x.pdf", "/abs.pdf", ".hidden/x.pdf",
                        "a/.git/x.pdf", "C:/x.pdf", "a<b.pdf", "noext", "a//b.pdf"):
            self.assertIsNone(uploads.clean_rel(refused), refused)

    def test_a_taken_name_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "scan.pdf").write_bytes(b"1")
            (Path(tmp) / "scan (2).pdf").write_bytes(b"2")
            self.assertEqual(uploads.free_rel(tmp, "scan.pdf"), "scan (3).pdf")
            self.assertEqual(uploads.free_rel(tmp, "other.pdf"), "other.pdf")

    def test_a_zip_stays_inside_its_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            zp = Path(tmp) / "a.zip"
            zp.write_bytes(_zip({"Archive/a.md": "# A", "Archive/sub/b.pdf": "%PDF",
                                 "Archive/../../evil.md": "x", "Archive/x.svg": "<svg/>",
                                 "__MACOSX/Archive/._a.md": "junk"}))
            entries, skipped = uploads.zip_entries(zp, "projets/Archive")
            self.assertEqual(sorted(rel for _, rel in entries),
                             ["projets/Archive/a.md", "projets/Archive/sub/b.pdf"])
            self.assertEqual(sorted(skipped), ["Archive/../../evil.md", "Archive/x.svg"])
            zp.write_bytes(b"not a zip")
            with self.assertRaises(uploads.UploadError):
                uploads.zip_entries(zp, "x")


class TestUploadRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        with open(cls.srv.root / ".git" / "info" / "exclude", "a", encoding="utf-8") as f:
            f.write("\nserver.log\n")
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.admin = cls.headers(ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.member = cls.headers(VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    @classmethod
    def headers(cls, email, password):
        cookie = session_cookie(cls.srv, email, password)
        return {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(cls.srv, cookie)}

    def upload(self, path, data=b"%PDF-1.4", who=None, ctype="application/octet-stream", beside=None):
        query = f"/api/upload?path={path}" + (f"&beside={beside}" if beside else "")
        return self.srv.post(query, data=data, headers={**(who or self.admin), "Content-Type": ctype})

    def test_a_dropped_file_lands_and_is_kept_in_history(self):
        resp = self.upload("factures/scan.pdf")
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(resp.json()["paths"], ["factures/scan.pdf"])
        self.assertEqual((self.srv.content_root / "factures" / "scan.pdf").read_bytes(), b"%PDF-1.4")
        self.assertIn("created: scan.pdf", self.srv.git("log", "-3", "--format=%s").stdout)
        events = self.srv.get("/api/activity?since=1&limit=20", headers=self.admin).json()["events"]
        self.assertIn(("create", ["factures/scan.pdf"]), [(e["type"], e["paths"]) for e in events])
        again = self.upload("factures/scan.pdf", data=b"%PDF-other")
        self.assertEqual(again.json()["paths"], ["factures/scan (2).pdf"])
        self.assertEqual((self.srv.content_root / "factures" / "scan.pdf").read_bytes(), b"%PDF-1.4")

    def test_what_never_comes_in(self):
        self.assertEqual(self.upload("a.pdf", ctype="multipart/form-data").status, 415)
        self.assertEqual(self.upload("a.pdf", ctype="text/plain").status, 415)
        self.assertEqual((self.upload("page.html").status, self.upload("page.html").json()["error"]),
                         (400, "bad_type"))
        self.assertEqual(self.upload("logo.svg").json()["error"], "bad_type")
        self.assertEqual(self.upload("../out.pdf").json()["error"], "bad_path")
        self.assertEqual(self.srv.post("/api/upload?path=a.pdf", data=b"x",
                                       headers={"Content-Type": "application/octet-stream"}).status, 401)

    def test_a_zip_unpacks_into_a_folder_of_its_name(self):
        resp = self.upload("import/Archive.zip", data=_zip({
            "Archive/a.md": "# A\n", "Archive/sub/b.pdf": "%PDF", "Archive/../../evil.md": "x"}))
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(sorted(resp.json()["paths"]), ["import/Archive/a.md", "import/Archive/sub/b.pdf"])
        self.assertEqual(resp.json()["skipped"], ["Archive/../../evil.md"])
        self.assertFalse((self.srv.root / "evil.md").exists())
        self.assertFalse((self.srv.content_root / "evil.md").exists())

    def test_a_pasted_image_is_as_private_as_its_note(self):
        note = "perso/journal.md"
        self.fs.set_owner(note, f"user:{VIEWER_EMAIL}")
        self.fs.grant(note, f"user:{ADMIN_EMAIL}", "view")
        resp = self.upload("perso/journal-image.png", data=b"\x89PNG", who=self.member, beside=note)
        self.assertEqual(resp.status, 200, resp.text)
        acl = self.fs.get_acl("perso/journal-image.png")
        self.assertEqual(acl["owner"], f"user:{VIEWER_EMAIL}")
        self.assertEqual([g["principal"] for g in acl["grants"]], [f"user:{ADMIN_EMAIL}"])

    def test_a_file_moves_like_a_note(self):
        self.assertEqual(self.upload("vrac/devis.pdf").status, 200)
        moved = self.srv.post("/api/file/move", json_body={"from": "vrac/devis.pdf", "to": "maison/devis.pdf"},
                              headers=self.admin)
        self.assertEqual(moved.status, 200, moved.text)
        self.assertTrue((self.srv.content_root / "maison" / "devis.pdf").is_file())
        self.assertFalse((self.srv.content_root / "vrac" / "devis.pdf").exists())
        bad = self.srv.post("/api/file/move", json_body={"from": "maison/devis.pdf", "to": "maison/devis.html"},
                            headers=self.admin)
        self.assertEqual(bad.status, 400)  # a file keeps its kind

    def test_a_member_only_puts_files_where_they_may_create(self):
        self.fs.set_owner("admin-only", f"user:{ADMIN_EMAIL}")
        self.assertEqual(self.upload("admin-only/x.pdf", who=self.member).status, 403)
        self.assertEqual(self.upload("commun/x.pdf", who=self.member).status, 200)


class TestCliImport(unittest.TestCase):
    """`atlas import`: the same rules as a drop in the viewer, from a terminal."""

    def setUp(self):
        from test_cli import run_cli
        self.run_cli = run_cli
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-import-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.mind = self.tmp / "mind"
        self.assertEqual(run_cli("init", self.mind).returncode, 0)

    def test_a_folder_and_a_zip_come_in_beside_what_is_there(self):
        src = self.tmp / "Classeur"
        (src / "sous").mkdir(parents=True)
        (src / "a.md").write_bytes(b"# A\n")
        (src / "sous" / "b.pdf").write_bytes(b"%PDF")
        (src / "logo.svg").write_bytes(b"<svg/>")
        done = self.run_cli("import", src, "--into", "archives", "--dir", self.mind)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("2 file(s) added, 1 left out: Classeur/logo.svg", done.stdout)
        content = self.mind / "content" / "archives" / "Classeur"
        self.assertTrue((content / "sous" / "b.pdf").is_file())
        again = self.run_cli("import", src / "a.md", "--into", "archives/Classeur", "--dir", self.mind)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertTrue((content / "a (2).md").is_file())
        zp = self.tmp / "Photos.zip"
        zp.write_bytes(_zip({"Photos/un.jpg": b"jpg", "Photos/../../evil.md": "x"}))
        unzipped = self.run_cli("import", zp, "--dir", self.mind)
        self.assertIn("1 file(s) added, 1 left out", unzipped.stdout)
        self.assertTrue((self.mind / "content" / "Photos" / "un.jpg").is_file())
        log = subprocess.run(["git", "log", "--format=%s"], cwd=self.mind, capture_output=True, text=True)
        self.assertIn("created: Photos (1)", log.stdout)


if __name__ == "__main__":
    unittest.main()
