"""A copy on GitHub with the instance's own deploy key: the repo name people paste is
understood, git's refusals become causes the screen explains, a refused first push
leaves the mind as it was, and only admins reach the routes."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from server.pure import github_remote, restore  # noqa: E402
from server.services.git_sync import GitSync  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
    csrf_token_for, file_store_of, seed_admin_and_viewer, session_cookie)


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True).stdout


class TestParsing(unittest.TestCase):
    def test_repo_from_what_people_paste(self):
        for text in ("sophie/atlas", " sophie/atlas.git ", "https://github.com/sophie/atlas",
                     "https://github.com/sophie/atlas.git", "git@github.com:sophie/atlas.git"):
            self.assertEqual(github_remote.parse_repo(text), "sophie/atlas", text)
        for bad in ("", "atlas", "sophie/atlas/extra", "-bad/atlas", "sophie/at las"):
            self.assertIsNone(github_remote.parse_repo(bad), bad)

    def test_refusals_become_causes(self):
        cases = {
            "ERROR: The key you are authenticating with has been marked as read only.": "write_access",
            "git@github.com: Permission denied (publickey).": "key_missing",
            "ERROR: Repository not found.": "repo_not_found",
            " ! [rejected]        HEAD -> main (fetch first)": "repo_not_empty",
            "something else": "other",
        }
        for message, cause in cases.items():
            self.assertEqual(github_remote.hint(message), cause, message)


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestConnectRemote(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-gh-"))
        self.repo = self.tmp / "work"
        self.repo.mkdir()
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.email", "a@example.com")
        _git(self.repo, "config", "user.name", "A")
        (self.repo / "note.md").write_text("# Note\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "init")
        self.gs = GitSync(config=SimpleNamespace(root=self.repo, dev_mode=False))
        self.gs.build = lambda **k: SimpleNamespace(returncode=0, stderr="")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_connect_pushes_the_whole_mind_then_syncs(self):
        bare = self.tmp / "copy.git"
        _git(self.tmp, "init", "--bare", "-q", str(bare))
        ok, message = self.gs.connect_remote(str(bare), "ssh")
        self.assertTrue(ok, message)
        self.assertIn("init", _git(bare, "log", "--format=%s", "main"))
        self.assertEqual(self.gs.health()["status"], "ok")

    def _bare_copy_of(self, files):
        src = self.tmp / "elsewhere"
        src.mkdir()
        _git(src, "init", "-q", "-b", "main")
        _git(src, "config", "user.email", "b@example.com")
        _git(src, "config", "user.name", "B")
        for rel, text in files.items():
            (src / rel).parent.mkdir(parents=True, exist_ok=True)
            (src / rel).write_bytes(text.encode())
        _git(src, "add", "-A")
        _git(src, "commit", "-q", "-m", "the copy")
        bare = self.tmp / "copy.git"
        _git(self.tmp, "clone", "-q", "--bare", str(src), str(bare))
        return bare

    def test_adopt_takes_the_copy_history_and_keeps_the_current_one(self):
        bare = self._bare_copy_of({"content/back.md": "# Back\n", "atlas.toml": ""})
        before = _git(self.repo, "rev-parse", "HEAD").strip()
        ok, message = self.gs.adopt_remote(str(bare), "ssh")
        self.assertTrue(ok, message)
        self.assertTrue((self.repo / "content" / "back.md").is_file())
        self.assertEqual(_git(self.repo, "rev-parse", "refs/atlas/before-restore").strip(), before)
        self.assertEqual(self.gs.health()["status"], "ok")

    def test_adopt_refuses_a_repo_holding_no_atlas(self):
        bare = self._bare_copy_of({"notes.md": "x"})
        with self.assertRaises(restore.RestoreError):
            self.gs.adopt_remote(str(bare), "ssh")
        self.assertIsNone(self.gs.remote_url())
        self.assertTrue((self.repo / "note.md").is_file())

    def test_adopting_an_empty_repo_says_so(self):
        bare = self.tmp / "empty.git"
        _git(self.tmp, "init", "--bare", "-q", str(bare))
        ok, message = self.gs.adopt_remote(str(bare), "ssh")
        self.assertFalse(ok)
        self.assertEqual(github_remote.hint(message), "repo_empty")
        self.assertIsNone(self.gs.remote_url())

    def test_a_refused_push_leaves_the_mind_local(self):
        ok, message = self.gs.connect_remote(str(self.tmp / "missing.git"), "ssh")
        self.assertFalse(ok)
        self.assertTrue(message)
        self.assertIsNone(self.gs.remote_url())
        self.assertEqual(self.gs.health()["status"], "local")


class TestGithubRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        seed_admin_and_viewer(file_store_of(cls.srv))
        cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin = {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(cls.srv, cookie)}
        viewer = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)
        cls.viewer = {"Cookie": viewer, "X-CSRF-Token": csrf_token_for(cls.srv, viewer)}

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_admin_only(self):
        self.assertEqual(self.srv.get("/api/admin/github", headers=self.viewer).status, 403)
        resp = self.srv.post("/api/admin/github", headers=self.viewer, json_body={"repo": "a/b"})
        self.assertEqual(resp.status, 403)

    def test_bad_repo_is_refused_before_anything(self):
        resp = self.srv.post("/api/admin/github", headers=self.admin, json_body={"repo": "not a repo"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json()["error"], "bad_repo")

    @unittest.skipUnless(shutil.which("ssh-keygen"), "ssh-keygen not available")
    def test_the_key_is_made_once_and_kept_out_of_git(self):
        first = self.srv.post("/api/admin/github/key", headers=self.admin, json_body={}).json()["key"]
        self.assertTrue(first.startswith("ssh-ed25519 "))
        again = self.srv.post("/api/admin/github/key", headers=self.admin, json_body={}).json()["key"]
        self.assertEqual(first, again)
        state = self.srv.get("/api/admin/github", headers=self.admin).json()
        self.assertEqual(state, {"remote": None, "key": first, "owner": False, "clone": None})
        tracked = subprocess.run(["git", "ls-files"], cwd=str(self.srv.root),
                                 capture_output=True, text=True).stdout
        self.assertNotIn(github_remote.KEY_FILE, tracked)


if __name__ == "__main__":
    unittest.main()
