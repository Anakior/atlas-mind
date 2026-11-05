"""atlas sync's "keep both": when a note changed here and online, the online version stays in
place and this copy's goes beside it, in the merge commit itself — even when the instance
deleted the note and its folder went with it. Run: python tests/test_keep_both.py"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR.parent / "src"))

import cli  # noqa: E402

LOCAL = "# My valuable local edit\n"


class TestKeepBoth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self.tmp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Atlas test")
        self.git("config", "user.email", "test@atlas.local")
        self.git("config", "commit.gpgsign", "false")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.dest, capture_output=True, text=True,
                              check=True).stdout.strip()

    def diverge(self, rel, online):
        """`rel` edited here; online, `online(rel)` changes it the other way. FETCH_HEAD = online."""
        note = self.dest / rel
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text("# Original\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "original")
        self.git("branch", "online")
        note.write_text(LOCAL, encoding="utf-8")
        self.git("commit", "-q", "-am", "edit here")
        self.git("checkout", "-q", "online")
        online(rel)
        self.git("commit", "-q", "-am", "online change")
        self.git("checkout", "-q", "main")
        self.git("fetch", "-q", ".", "online")

    def delete(self, rel):
        self.git("rm", "-q", "--", rel)

    def assert_kept(self, copies, rel):
        self.assertEqual(len(copies), 1)
        self.assertEqual((self.dest / copies[0]).read_text(encoding="utf-8"), LOCAL)
        self.assertEqual(self.git("show", f"HEAD:{copies[0]}") + "\n", LOCAL)  # in the merge commit
        self.assertEqual(len(self.git("rev-list", "--parents", "-n1", "HEAD").split()), 3)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertFalse((self.dest / rel).exists())

    def test_the_last_note_of_a_folder_deleted_online(self):
        self.diverge("content/only-folder/note.md", self.delete)
        self.assert_kept(cli._keep_both(self.dest), "content/only-folder/note.md")

    def test_a_note_deep_in_folders_deleted_online(self):
        self.diverge("content/a/b/c/note.md", self.delete)
        self.assert_kept(cli._keep_both(self.dest), "content/a/b/c/note.md")

    def test_a_note_edited_both_sides(self):
        def edit(rel):
            (self.dest / rel).write_text("# Online\n", encoding="utf-8")

        self.diverge("content/both.md", edit)
        copies = cli._keep_both(self.dest)
        self.assertEqual(copies, ["content/both (my version).md"])
        self.assertEqual((self.dest / "content/both.md").read_text(encoding="utf-8"), "# Online\n")
        self.assertEqual(self.git("show", "HEAD:content/both (my version).md") + "\n", LOCAL)

    def test_a_copy_that_cannot_be_written_changes_nothing(self):
        self.diverge("content/only-folder/note.md", self.delete)
        here = self.git("rev-parse", "HEAD")
        with mock.patch.object(Path, "write_bytes", side_effect=OSError("disk full")):
            with self.assertRaises(cli.CliError):
                cli._keep_both(self.dest)
        self.assertEqual(self.git("rev-parse", "HEAD"), here)
        self.assertFalse((self.dest / ".git" / "MERGE_HEAD").exists())
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual((self.dest / "content/only-folder/note.md").read_text(encoding="utf-8"), LOCAL)


if __name__ == "__main__":
    unittest.main()
