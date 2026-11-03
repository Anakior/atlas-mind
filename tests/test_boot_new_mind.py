"""Cloud boot without GITHUB_REPO_URL: a new mind is started on the (persistent) disk,
with its first commit, instead of the old FATAL — GitHub is no prerequisite to start.
A folder holding files but no repo still stops the boot."""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestBootNewMind(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-newmind-"))
        self.repo = self.tmp / "kb"
        self.port = _free_port()
        self.env = {**{k: v for k, v in os.environ.items()
                       if k not in ("GITHUB_REPO_URL", "CLAUDECODE")},
                    "KB_AUTH_ENABLED": "1", "SESSION_SECRET": "new-mind-secret-0123456789abcdef",
                    "KB_REPO_PATH": str(self.repo), "ATLAS_STORE": "file",
                    "ATLAS_STORE_DIR": str(self.tmp / "store"), "ATLAS_LANG": "fr",
                    "ATLAS_BIND": "127.0.0.1", "PORT": str(self.port),
                    "GIT_PULL_INTERVAL": "3600", "PYTHONPATH": str(SRC)}
        self.proc = None

    def tearDown(self):
        if self.proc:
            if self.proc.poll() is None:
                self.proc.terminate()
            self.proc.communicate(timeout=10)  # drains and closes the pipe
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _boot(self):
        self.proc = subprocess.Popen([sys.executable, "-m", "server"], env=self.env,
                                     cwd=str(self.tmp), stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True)

    def test_starts_a_new_mind_with_its_first_commit(self):
        self._boot()
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/healthz", timeout=2) as r:
                    if r.status == 200:
                        break
            except OSError:
                time.sleep(0.2)
        else:
            self.fail("server never answered /healthz")
        self.assertIn('lang = "fr"', (self.repo / "atlas.toml").read_text(encoding="utf-8"))
        self.assertTrue((self.repo / "content" / "welcome.md").exists())
        log = subprocess.run(["git", "log", "--format=%s"], cwd=str(self.repo),
                             capture_output=True, text=True).stdout
        self.assertIn("chore: new mind", log)

    def test_refuses_unknown_files_without_a_repo(self):
        self.repo.mkdir()
        (self.repo / "notes.txt").write_text("not a mind\n", encoding="utf-8")
        self._boot()
        out, _ = self.proc.communicate(timeout=30)
        self.assertNotEqual(self.proc.returncode, 0)
        self.assertIn("refusing to start a new mind", out)
        self.assertFalse((self.repo / ".git").exists())


if __name__ == "__main__":
    unittest.main()
