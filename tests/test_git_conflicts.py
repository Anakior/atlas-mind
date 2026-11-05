"""A conflict with the remote never leaves git half-way or writes conflict markers into a note:
a save that conflicts stays committed here and the pull is undone, and a restart over a pull
that could not apply finds the mind on its branch. Run: python tests/test_git_conflicts.py"""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import cloud_env  # noqa: E402

MARKER = "<<<<<<<"


def _git(cwd, *args):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, env=env)


class _WithRemote:
    """A bare remote the test mind tracks, and another clone that edits accueil.md first."""

    def remote_edits_accueil(self, srv, tmp):
        # The harness logs inside the mind; a real instance never writes there.
        with open(srv.root / ".git" / "info" / "exclude", "a", encoding="utf-8") as f:
            f.write("\nserver.log\n")
        self.bare = Path(tmp) / "remote.git"
        _git(tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        srv.git("remote", "add", "origin", str(self.bare), check=True)
        srv.git("push", "-q", "-u", "origin", "main", check=True)
        other = Path(tmp) / "other"
        _git(tmp, "clone", "-q", str(self.bare), str(other))
        _git(other, "config", "user.email", "o@o")
        _git(other, "config", "user.name", "o")
        (other / "content" / "accueil.md").write_bytes(b"# Accueil\n\nREMOTE line\n")
        _git(other, "commit", "-qam", "remote edit")
        self.assertEqual(_git(other, "push", "-q").returncode, 0)

    def remote_accueil(self):
        return _git(self.bare, "show", "main:content/accueil.md").stdout


class TestSaveConflict(_WithRemote, unittest.TestCase):
    def test_a_conflicting_save_never_commits_markers(self):
        with AtlasServer() as srv, tempfile.TemporaryDirectory() as tmp:
            self.remote_edits_accueil(srv, tmp)
            put = srv.put("/api/file", json_body={"path": "accueil.md", "content": "# Accueil\n\nLOCAL line\n"},
                          headers={"Origin": srv.base_url})
            self.assertEqual(put.status, 200)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and "LOCAL line" not in srv.git("show", "HEAD:content/accueil.md").stdout:
                time.sleep(0.2)
            time.sleep(1)  # the pull and push of that sync, after its commit
            self.assertIn("LOCAL line", srv.git("show", "HEAD:content/accueil.md").stdout)
            self.assertNotIn(MARKER, (srv.content_root / "accueil.md").read_text(encoding="utf-8"))
            self.assertEqual(srv.git("ls-files", "-u").stdout, "")
            self.assertEqual(self.remote_accueil(), "# Accueil\n\nREMOTE line\n")


class TestRestartOverAConflict(_WithRemote, unittest.TestCase):
    def test_a_restart_finds_the_mind_on_its_branch(self):
        srv = AtlasServer(extra_env=cloud_env())
        srv.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                self.remote_edits_accueil(srv, tmp)
                (srv.content_root / "accueil.md").write_bytes(b"# Accueil\n\nINSTANCE line\n")
                srv.git("commit", "-qam", "edited: accueil", check=True)
                # A pull that stopped half-way, as a crash would leave it.
                srv.git("fetch", "-q", "origin", check=True)
                srv.git("rebase", "origin/main")
                self.assertTrue((srv.root / ".git" / "rebase-merge").exists())
                srv.restart()
                self.assertEqual(srv.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip(), "main")
                self.assertFalse((srv.root / ".git" / "rebase-merge").exists())
                self.assertEqual(srv.git("ls-files", "-u").stdout, "")
                text = (srv.content_root / "accueil.md").read_text(encoding="utf-8")
                self.assertNotIn(MARKER, text)
                self.assertIn("INSTANCE line", text)
        finally:
            srv.stop()


if __name__ == "__main__":
    unittest.main()
