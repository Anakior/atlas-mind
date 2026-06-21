"""Persistent-volume content checkout (KB_REPO_PATH on /data, brick: durability).

Re-running boot must NEVER re-clone or clobber an existing checkout — in particular
an un-pushed local commit that the volume preserved across a machine restart must
survive (that is the whole point of putting the repo on the persistent volume)."""
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import server  # noqa: E402


def _git(cwd, *a):
    return subprocess.run(["git", *a], cwd=str(cwd), capture_output=True,
                          text=True, check=True).stdout


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestRepoBootstrap(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-boot-"))
        self.remote = self.tmp / "remote.git"
        seed = self.tmp / "seed"
        _git(self.tmp, "init", "--bare", "-q", str(self.remote))
        seed.mkdir()
        _git(seed, "init", "-q")
        _git(seed, "config", "user.email", "seed@x")
        _git(seed, "config", "user.name", "seed")
        (seed / "README.md").write_text("seed\n", encoding="utf-8")
        _git(seed, "add", "-A")
        _git(seed, "commit", "-q", "-m", "seed")
        _git(seed, "remote", "add", "origin", str(self.remote))
        _git(seed, "push", "-q", "-u", "origin", "HEAD")
        self._old = os.environ.get("GITHUB_REPO_URL")
        os.environ["GITHUB_REPO_URL"] = str(self.remote)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("GITHUB_REPO_URL", None)
        else:
            os.environ["GITHUB_REPO_URL"] = self._old
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_clones_if_absent_then_never_reclobbers(self):
        repo = self.tmp / "repo"
        # First boot on an empty volume: clone.
        self.assertTrue(server.ensure_repo_cloned(repo))
        self.assertTrue((repo / ".git").exists())
        _git(repo, "config", "user.email", "bot@x")
        _git(repo, "config", "user.name", "bot")
        # A local commit that was made but NOT pushed before a restart; on the volume
        # it persists. Boot must keep it (and later push it), never wipe it.
        (repo / "local.md").write_text("only on the volume, not pushed\n", encoding="utf-8")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "local unpushed")
        head = _git(repo, "rev-parse", "HEAD").strip()
        # Second boot (repo already on the volume): must NOT re-clone, must NOT lose it.
        self.assertFalse(server.ensure_repo_cloned(repo))
        self.assertEqual(head, _git(repo, "rev-parse", "HEAD").strip())
        self.assertTrue((repo / "local.md").exists())


if __name__ == "__main__":
    unittest.main()
