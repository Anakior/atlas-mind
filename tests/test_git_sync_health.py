"""GitSync.health(): a failed commit/pull/push is recorded, classified and reported
instead of vanishing on stderr, and a mind without a remote skips pull/push quietly.
Against a throwaway repo + bare remote, as in test_git_sync_attribution."""
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.services.git_sync import GitSync, classify_git_error, mask_url  # noqa: E402


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


class TestClassify(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(classify_git_error(
            "fatal: Authentication failed for 'https://github.com/x/y.git/'"), "auth")
        self.assertEqual(classify_git_error(
            "fatal: unable to access '...': Could not resolve host: github.com"), "network")
        self.assertEqual(classify_git_error(
            " ! [rejected]        main -> main (fetch first)"), "conflict")
        self.assertEqual(classify_git_error(
            "fatal: detected dubious ownership in repository at '/x'"), "other")

    def test_mask_url_hides_credentials(self):
        self.assertEqual(mask_url("https://x-access-token:SECRET@github.com/a/b.git"),
                         "https://***@github.com/a/b.git")


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestHealth(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-health-"))
        self.repo = self.tmp / "work"
        self.repo.mkdir()
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "atlas-bot@example.com")
        _git(self.repo, "config", "user.name", "Atlas Bot")
        _git(self.repo, "config", "commit.gpgsign", "false")
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "init")
        self.gs = GitSync(config=SimpleNamespace(root=self.repo, dev_mode=False))
        self.gs.build = lambda **k: SimpleNamespace(returncode=0, stderr="")
        self.gs._retry_s = ()      # no retry unless a test asks for one
        self.gs._error_grace = 0   # a pull/push failure counts at once unless a test says

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _add_remote(self):
        remote = self.tmp / "remote.git"
        _git(self.tmp, "init", "--bare", "-q", str(remote))
        _git(self.repo, "remote", "add", "origin", str(remote))
        _git(self.repo, "push", "-q", "-u", "origin", "HEAD")
        return remote

    def _write(self, name, text):
        (self.repo / name).write_text(text, encoding="utf-8")

    def test_no_remote_is_local_and_still_commits(self):
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        _wait_push_idle(self.gs)
        self.gs.pull_and_rebuild()
        health = self.gs.health()
        self.assertEqual(health["status"], "local")
        self.assertFalse(health["remote"])
        self.assertIsNone(health["error"])  # no pull/push attempted, so nothing failed
        self.assertIn("created: A", _git(self.repo, "log", "--format=%s"))

    def test_clean_push_is_ok(self):
        self._add_remote()
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        _wait_push_idle(self.gs)
        health = self.gs.health()
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["unpushed"], 0)
        self.assertIsNotNone(health["last_push_at"])

    def test_failed_push_is_reported_then_cleared(self):
        remote = self._add_remote()
        # The remote becomes unreachable: pull and push now fail.
        _git(self.repo, "remote", "set-url", "origin", str(self.tmp / "missing.git"))
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        _wait_push_idle(self.gs)
        health = self.gs.health()
        self.assertEqual(health["status"], "error")
        self.assertEqual(health["unpushed"], 1)
        self.assertIsNotNone(health["oldest_unpushed_at"])
        self.assertIn(health["error"]["op"], ("pull", "push"))

        _git(self.repo, "remote", "set-url", "origin", str(remote))  # reachable again
        self.gs.sync_now()
        self.assertEqual(self._wait_status("ok")["error"], None)

    def test_retry_clears_a_commit_failure_once_fixed(self):
        lock = self.repo / ".git" / "index.lock"
        lock.write_text("", encoding="utf-8")
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        _wait_push_idle(self.gs)
        self.assertEqual(self.gs.health()["error"]["op"], "commit")
        lock.unlink()  # the cause is gone: the retry commits what was left over
        self.gs.sync_now()
        self._wait_status("local")
        self.assertIn("docs: update via viewer", _git(self.repo, "log", "--format=%s"))

    def _wait_status(self, status, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            health = self.gs.health()
            if health["status"] == status:
                return health
            time.sleep(0.05)
        self.fail(f"status never became {status!r}: {self.gs.health()}")

    def test_failed_commit_is_reported(self):
        # A stale index.lock makes git refuse every commit: before, it vanished silently.
        (self.repo / ".git" / "index.lock").write_text("", encoding="utf-8")
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        _wait_push_idle(self.gs)
        health = self.gs.health()
        self.assertEqual(health["status"], "error")
        self.assertEqual(health["error"]["op"], "commit")
        self.assertTrue(health["error"]["message"])

    def test_nothing_to_commit_is_not_an_error(self):
        self.gs.pull_and_rebuild()  # the backstop commit finds nothing to commit
        self.assertIsNone(self.gs.health()["error"])

    def test_a_short_failure_is_not_yet_an_error(self):
        # GitHub failing now and then must not raise the banner: pending, not error.
        self._add_remote()
        self.gs._error_grace = 120
        _git(self.repo, "remote", "set-url", "origin", str(self.tmp / "missing.git"))
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        _wait_push_idle(self.gs)
        health = self.gs.health()
        self.assertEqual(health["status"], "pending")
        self.assertEqual(health["error"]["op"], "push")  # still told to doctor and the API

    def test_failed_push_is_retried_without_a_new_save(self):
        remote = self._add_remote()
        self.gs._retry_s = (1.0,)
        _git(self.repo, "remote", "set-url", "origin", str(self.tmp / "missing.git"))
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        deadline = time.time() + 10
        while self.gs.health()["error"] is None and time.time() < deadline:
            time.sleep(0.05)
        _git(self.repo, "remote", "set-url", "origin", str(remote))  # back before the retry
        self.assertIsNone(self._wait_status("ok")["error"])

    def test_push_behind_the_remote_pulls_then_pushes(self):
        # The remote moved (another computer): the refused push is no error.
        remote = self._add_remote()
        other = self.tmp / "other"
        _git(self.tmp, "clone", "-q", str(remote), str(other))
        (other / "B.md").write_text("beta\n", encoding="utf-8")
        _git(other, "add", "-A")
        _git(other, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "-m", "B")
        _git(other, "push", "-q")
        self._write("A.md", "alpha\n")
        self.gs.commit_change("created: A", ["A.md"])
        _wait_push_idle(self.gs)
        health = self.gs.health()
        self.assertEqual(health["status"], "ok")
        self.assertIsNone(health["error"])
        self.assertTrue((self.repo / "B.md").exists())
        self.assertIn("created: A", _git(remote, "log", "--format=%s"))

    def test_a_rebase_that_cannot_apply_is_undone(self):
        remote = self._add_remote()
        other = self.tmp / "other"
        _git(self.tmp, "clone", "-q", str(remote), str(other))
        (other / "README.md").write_text("theirs\n", encoding="utf-8")
        _git(other, "-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-qam", "theirs")
        _git(other, "push", "-q")
        self._write("README.md", "ours\n")
        self.gs.commit_change("edited: README", ["README.md"])
        _wait_push_idle(self.gs)
        health = self.gs.health()
        self.assertEqual((health["error"]["op"], health["error"]["kind"]), ("pull", "conflict"))
        self.assertFalse((self.repo / ".git" / "rebase-merge").exists())
        self.assertEqual((self.repo / "README.md").read_text(encoding="utf-8"), "ours\n")

    def test_a_save_does_not_wait_for_the_network(self):
        # A fetch hanging on GitHub must not hold the repo: here it hangs until the save is
        # done, so the save has to commit while it waits.
        self._add_remote()
        fetching, released, real_net = threading.Event(), threading.Event(), self.gs._net

        def hanging_net(*args):
            fetching.set()
            released.wait(60)
            return real_net(*args)

        self.gs._net = hanging_net
        backstop = threading.Thread(target=self.gs.pull_and_rebuild)
        backstop.start()
        try:
            self.assertTrue(fetching.wait(30))
            self._write("A.md", "alpha\n")
            save = threading.Thread(target=self.gs.commit_change, args=("created: A", ["A.md"]))
            save.start()
            save.join(30)
            self.assertFalse(save.is_alive(), "the save waited for the fetch")
            self.assertIn("created: A", _git(self.repo, "log", "--format=%s"))
        finally:
            released.set()
            backstop.join()
        _wait_push_idle(self.gs)


if __name__ == "__main__":
    unittest.main()
