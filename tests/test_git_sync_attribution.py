"""GitSync.commit_change: an inline, path-scoped, authored commit (bot as committer,
no sweep of unrelated worktree changes) + the coalesced async push. Against a throwaway
repo + bare remote so the real git sequencing is tested."""
import shutil
import subprocess
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.services.git_sync import GitSync  # noqa: E402

US = "\x1f"


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True,
                          text=True, check=True).stdout


def _wait_push_idle(gs, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with gs._push_lock:
            if not gs._push_pending and (gs._pusher is None or not gs._pusher.is_alive()):
                return
        time.sleep(0.05)
    raise TimeoutError("push worker did not go idle")


def _commits(repo):
    """[(subject, author_name, author_email, committer_name, body)] newest first."""
    fmt = US.join(["%s", "%an", "%ae", "%cn", "%b"]) + "\x1e"
    rows = [r for r in _git(repo, "log", "--format=" + fmt).split("\x1e") if r.strip()]
    return [tuple(r.strip("\n").split(US)) for r in rows]


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestCommitChange(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-attr-"))
        self.repo = self.tmp / "work"
        self.remote = self.tmp / "remote.git"
        self.repo.mkdir()
        _git(self.tmp, "init", "--bare", "-q", str(self.remote))
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "atlas-bot@example.com")
        _git(self.repo, "config", "user.name", "Atlas Bot")
        _git(self.repo, "config", "commit.gpgsign", "false")
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "init")
        _git(self.repo, "remote", "add", "origin", str(self.remote))
        _git(self.repo, "push", "-q", "-u", "origin", "HEAD")
        self.gs = GitSync(config=SimpleNamespace(root=self.repo, dev_mode=False))
        # Stand in for the viewer build (a CompletedProcess), so we never shell out to
        # `python -m build` yet pull_and_rebuild's result logging still works.
        self.gs.build = lambda **k: SimpleNamespace(returncode=0, stderr="")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, name, text):
        (self.repo / name).write_text(text, encoding="utf-8")

    def test_inline_authored_commit_reaches_remote(self):
        self._write("A.md", "alpha\n")
        self.gs.commit_change("docs: create A.md", ["A.md"],
                              author=("Ada Lovelace", "ada@example.com"))
        self._write("B.md", "beta\n")
        self.gs.commit_change("docs: edit B.md", ["B.md"],
                              author=("Bob Martin", "bob@example.com"),
                              trailers=["X-Atlas-Author: ai/claude"])
        _wait_push_idle(self.gs)

        by = {c[0]: c for c in _commits(self.repo)}
        a = by["docs: create A.md"]
        self.assertEqual((a[1], a[2]), ("Ada Lovelace", "ada@example.com"))
        self.assertEqual(a[3], "Atlas Bot")
        b = by["docs: edit B.md"]
        self.assertEqual(b[1], "Bob Martin")
        self.assertIn("X-Atlas-Author: ai/claude", b[4])
        self.assertEqual(_git(self.repo, "rev-parse", "HEAD").strip(),
                         _git(self.repo, "rev-parse", "@{u}").strip())

    def test_commit_is_path_scoped_not_a_sweep(self):
        self._write("UNRELATED.md", "stays uncommitted\n")
        self._write("A.md", "alpha\n")
        self.gs.commit_change("docs: create A.md", ["A.md"],
                              author=("Ada Lovelace", "ada@example.com"))
        _wait_push_idle(self.gs)
        names = _git(self.repo, "show", "--name-only", "--format=", "HEAD").split()
        self.assertIn("A.md", names)
        self.assertNotIn("UNRELATED.md", names)
        self.assertIn("UNRELATED.md", _git(self.repo, "status", "--porcelain"))

    def test_pull_and_rebuild_pushes_unpushed_commits(self):
        # A commit already on disk (e.g. an inline commit whose push failed) must be
        # pushed by the backstop even though it commits nothing itself (push_if_ahead).
        self._write("C.md", "gamma\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "docs: C")
        self.assertNotEqual(_git(self.repo, "rev-parse", "HEAD").strip(),
                            _git(self.repo, "rev-parse", "@{u}").strip())
        self.gs.pull_and_rebuild()
        self.assertEqual(_git(self.repo, "rev-parse", "HEAD").strip(),
                         _git(self.repo, "rev-parse", "@{u}").strip())

    def test_newline_in_subject_cannot_forge_a_trailer(self):
        # A doc/folder name with a newline would split the subject into a body that
        # forges an X-Atlas-Author line; the subject must be collapsed to one line.
        self._write("Z.md", "zeta\n")
        self.gs.commit_change("created: evil\n\nX-Atlas-Author: ai/superuser", ["Z.md"],
                              author=("Ada Lovelace", "ada@example.com"),
                              trailers=["X-Atlas-Author: ai/claude"])
        _wait_push_idle(self.gs)
        subject, _an, _ae, _cn, body = _commits(self.repo)[0]
        self.assertNotIn("\n", subject)
        self.assertEqual(body.count("X-Atlas-Author"), 1)  # body = only the legit trailer
        self.assertIn("ai/claude", body)
        self.assertNotIn("ai/superuser", body)


if __name__ == "__main__":
    unittest.main()
