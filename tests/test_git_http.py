"""The mind's own git (/git), for a copy on your computer without GitHub: the owner of a
mind that is theirs alone clones it with an access token and pushes notes back; a push
that touches the instance (atlas.toml, anything outside content/ and AGENTS.md) is
refused whole; nobody else gets in, since a clone carries every file and all history."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import store  # noqa: E402
from harness import AtlasServer  # noqa: E402
from server.pure.push_guard import refusal  # noqa: E402
from test_admin import ADMIN_EMAIL, ADMIN_PASSWORD, cloud_env, file_store_of  # noqa: E402

CLI = TESTS_DIR.parent / "src" / "cli.py"
OLD, NEW, ZERO = "a" * 40, "b" * 40, "0" * 40


class TestPushGuard(unittest.TestCase):
    def check(self, paths, ref="refs/heads/main", old=OLD, new=NEW):
        return refusal([(old, new, ref)], lambda o, n: paths)

    def test_notes_pass(self):
        self.assertEqual(self.check(["content/a.md", "content/dossier/b.pdf", "AGENTS.md"]), "")

    def test_the_instance_stays_out_of_reach(self):
        for path in ("atlas.toml", ".gitignore", "content/.gitattributes", "dist/index.html",
                     "content/x/.git/config", "README.md"):
            self.assertIn(path, self.check(["content/a.md", path]), path)

    def test_only_main_moves_forward(self):
        self.assertIn("main branch", self.check([], ref="refs/heads/other"))
        self.assertIn("deleted", self.check([], new=ZERO))
        self.assertIn("pull it first", self.check([], old=ZERO))


def _git(cwd, *args, check=True):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_AUTHOR_NAME="Me", GIT_AUTHOR_EMAIL="me@example.com",
               GIT_COMMITTER_NAME="Me", GIT_COMMITTER_EMAIL="me@example.com")
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True,
                          env=env, check=check)


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestGitHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        # The harness logs inside the mind; a real instance never writes there.
        with open(cls.srv.root / ".git" / "info" / "exclude", "a", encoding="utf-8") as f:
            f.write("\nserver.log\n")
        cls.fs = file_store_of(cls.srv)
        cls.fs.upsert_user(ADMIN_EMAIL, {"password_hash": store.hash_password(ADMIN_PASSWORD),
                                         "role": "admin"})
        _, cls.token = cls.fs.create_api_identity("laptop", acts_as=ADMIN_EMAIL)
        cls.tmp = Path(tempfile.mkdtemp(prefix="atlas-clone-"))

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def url(self, token=None):
        return self.srv.base_url.replace("://", f"://me:{token or self.token}@") + "/git"

    def clone(self, name, token=None):
        return _git(self.tmp, "clone", "-q", self.url(token), name, check=False)

    def test_clone_edit_push(self):
        self.assertEqual(self.clone("copy").returncode, 0)
        copy = self.tmp / "copy"
        self.assertTrue((copy / "content").is_dir())
        (copy / "content" / "from-laptop.md").write_bytes(b"# Written offline\n")
        _git(copy, "add", "-A")
        _git(copy, "commit", "-q", "-m", "from my laptop")
        push = _git(copy, "push", "-q", "origin", "HEAD:main", check=False)
        self.assertEqual(push.returncode, 0, push.stderr)
        self.assertTrue((self.srv.content_root / "from-laptop.md").is_file())
        self.assertIn("from my laptop", self.srv.git("log", "-1", "--format=%s").stdout)

    def test_a_large_push_arrives(self):
        # Past http.postBuffer (1 MiB) git sends the push chunked.
        self.assertEqual(self.clone("large").returncode, 0)
        copy = self.tmp / "large"
        (copy / "content" / "scan.pdf").write_bytes(os.urandom(3 << 20))
        _git(copy, "add", "-A")
        _git(copy, "commit", "-q", "-m", "a big scan")
        push = _git(copy, "push", "-q", "origin", "HEAD:main", check=False)
        self.assertEqual(push.returncode, 0, push.stderr)
        self.assertEqual((self.srv.content_root / "scan.pdf").stat().st_size, 3 << 20)

    def test_a_push_touching_the_instance_is_refused_whole(self):
        self.assertEqual(self.clone("meddle").returncode, 0)
        copy = self.tmp / "meddle"
        (copy / "content" / "fine.md").write_bytes(b"# Fine\n")
        with open(copy / "atlas.toml", "a", encoding="utf-8") as f:
            f.write("\n# meddling\n")
        _git(copy, "add", "-A")
        _git(copy, "commit", "-q", "-m", "meddle")
        push = _git(copy, "push", "origin", "HEAD:main", check=False)
        self.assertNotEqual(push.returncode, 0)
        self.assertIn("atlas.toml", push.stderr)
        self.assertFalse((self.srv.content_root / "fine.md").exists())

    def test_a_wrong_token_gets_nothing(self):
        self.assertNotEqual(self.clone("stranger", token="not-a-token").returncode, 0)
        resp = self.srv.get("/git/info/refs?service=git-upload-pack")
        self.assertEqual(resp.status, 401)
        self.assertIn("Basic", resp.headers.get("WWW-Authenticate", ""))

    def test_atlas_sync_round_trip(self):
        def sync(*args):
            env = {**os.environ, "ATLAS_TOKEN": self.token}
            return subprocess.run([sys.executable, str(CLI), "sync", *args], capture_output=True,
                                  text=True, env=env, cwd=str(self.tmp))

        made = sync(self.srv.base_url, "synced")
        self.assertEqual(made.returncode, 0, made.stderr)
        copy = self.tmp / "synced"
        (copy / "content" / "from-my-copy.md").write_bytes(b"# Mine\n")
        sent = sync(str(copy))
        self.assertEqual(sent.returncode, 0, sent.stderr)
        self.assertIn("1 change(s) sent", sent.stdout)
        self.assertTrue((self.srv.content_root / "from-my-copy.md").is_file())

        (self.srv.content_root / "from-online.md").write_bytes(b"# Online\n")
        self.srv.git("add", "-A", check=True)
        # The sync after the push may have recorded it already: either commit will do.
        self.srv.git("commit", "-q", "-m", "online edit")
        got = sync(str(copy))
        self.assertEqual(got.returncode, 0, got.stderr)
        self.assertRegex(got.stdout, r"[1-9]\d* received")
        self.assertTrue((copy / "content" / "from-online.md").is_file())
        self.assertIn("Up to date", sync(str(copy)).stdout)

    def test_atlas_sync_keeps_both_versions(self):
        def sync(*args):
            env = {**os.environ, "ATLAS_TOKEN": self.token}
            return subprocess.run([sys.executable, str(CLI), "sync", *args], capture_output=True,
                                  text=True, env=env, cwd=str(self.tmp))

        def online(text):
            (self.srv.content_root / "both.md").write_bytes(text)
            self.srv.git("add", "-A", check=True)
            self.srv.git("commit", "-q", "-m", "online edit")

        online(b"# Shared\n\nfirst\n")
        self.assertEqual(sync(self.srv.base_url, "both-sides").returncode, 0)
        copy = self.tmp / "both-sides"
        (copy / "content" / "both.md").write_bytes(b"# Shared\n\nmine\n")
        online(b"# Shared\n\nonline\n")
        done = sync(str(copy))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("yours is beside it", done.stdout)
        self.assertIn("online", (copy / "content" / "both.md").read_text())
        mine = [p for p in (copy / "content").glob("both (*).md")]
        self.assertEqual(len(mine), 1, list((copy / "content").iterdir()))
        self.assertIn("mine", mine[0].read_text())
        self.assertTrue((self.srv.content_root / mine[0].name).is_file())

    def test_atlas_sync_with_the_address_inside_a_copy_syncs_it(self):
        # A copy made by `git clone`, then `atlas sync <address>` run from inside it: that copy
        # is synced, no second one is nested in it.
        self.assertEqual(self.clone("cloned").returncode, 0)
        copy = self.tmp / "cloned"
        (copy / "content" / "from-a-clone.md").write_bytes(b"# From a clone\n")
        env = {**os.environ, "ATLAS_TOKEN": self.token}
        done = subprocess.run([sys.executable, str(CLI), "sync", self.srv.base_url], capture_output=True,
                              text=True, env=env, cwd=str(copy))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("1 change(s) sent", done.stdout)
        self.assertTrue((self.srv.content_root / "from-a-clone.md").is_file())
        self.assertEqual([p.name for p in copy.iterdir() if p.is_dir() and p.name != ".git"], ["content"])

    def test_a_shared_mind_is_not_cloned(self):
        self.fs.upsert_user("other@example.com", {"password_hash": store.hash_password("x" * 12),
                                                  "role": "viewer"})
        try:
            result = self.clone("shared")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("403", result.stderr)
        finally:
            self.fs.delete_user("other@example.com")


if __name__ == "__main__":
    unittest.main()
