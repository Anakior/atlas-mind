"""R1 — the offline static export must not leak private docs.

`atlas build --offline` bakes content into a self-contained index-offline.html
with NO runtime access control (it is a file, served as-is), so it must embed
only the COMMON SOCLE — documents with no owner anywhere on their ancestor chain.
`--offline --as <email>` exports ONE account's full visible view instead. These
tests build real minds carrying an acl.json and assert what does / does not land
in the monolith (content, names/paths, annotations).
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_SRC = Path(__file__).resolve().parent.parent / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import store  # noqa: E402

PRIVATE_MARK = "PRIVATEMARKER_zztop"
SOCLE_MARK = "SOCLEMARKER_aabbcc"


def _build(mind: Path, *args: str) -> subprocess.CompletedProcess:
    """The ENGINE's build on a decoupled mind. Does NOT raise on failure — the
    error tests inspect the non-zero return + stderr."""
    env = os.environ.copy()
    env["ATLAS_MIND"] = str(mind)
    env.pop("KB_AUTH_ENABLED", None)
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env["PYTHONPATH"] = str(REPO_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "build", *args],
        cwd=str(mind), env=env, capture_output=True, text=True, timeout=60)


class TestOfflineExportAcl(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-r1-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.mind = self.tmp / "mind"
        (self.mind / "content" / "team").mkdir(parents=True)
        (self.mind / "atlas.toml").write_text('lang = "en"\n', encoding="utf-8")
        # A common-socle doc, a top-level private doc, and a doc INSIDE a private folder.
        (self.mind / "content" / "shared.md").write_text(
            f"# Shared\n{SOCLE_MARK} everyone.\n", encoding="utf-8")
        (self.mind / "content" / "diary.md").write_text(
            f"# Diary\n{PRIVATE_MARK} mine.\n", encoding="utf-8")
        (self.mind / "content" / "team" / "plan.md").write_text(
            f"# Plan\n{PRIVATE_MARK} folder.\n", encoding="utf-8")
        # An annotation on the private diary — its key (the doc path) must not leak.
        (self.mind / ".notes").mkdir()
        (self.mind / ".notes" / "diary.md.json").write_text(
            '[{"text":"NOTELEAK","quote":"x"}]', encoding="utf-8")
        self.fs = store.FileStore(str(self.mind / ".atlas"))
        self.fs.upsert_user("alice@x.com", {
            "role": "viewer", "password_hash": store.hash_password("x" * 10)})
        # alice owns the top-level diary AND the whole team/ folder (private space).
        self.fs.set_owner("diary.md", "user:alice@x.com")
        self.fs.set_owner("team", "user:alice@x.com")

    def _offline(self) -> str:
        return (self.mind / "dist" / "index-offline.html").read_text(encoding="utf-8")

    def test_default_offline_embeds_only_socle(self):
        r = _build(self.mind, "--offline")
        self.assertEqual(r.returncode, 0, r.stderr)
        html = self._offline()
        self.assertIn(SOCLE_MARK, html)         # the common doc is present
        self.assertNotIn(PRIVATE_MARK, html)    # neither private doc's CONTENT
        self.assertNotIn("diary.md", html)      # nor the private NAME/PATH
        self.assertNotIn("plan.md", html)       # nor the doc inside the private folder
        self.assertNotIn("NOTELEAK", html)      # nor the private doc's annotation

    def test_as_owner_embeds_their_private_docs(self):
        r = _build(self.mind, "--offline", "--as", "alice@x.com")
        self.assertEqual(r.returncode, 0, r.stderr)
        html = self._offline()
        self.assertIn(SOCLE_MARK, html)
        self.assertIn(PRIVATE_MARK, html)       # alice sees her private docs
        self.assertIn("diary.md", html)

    def test_as_unknown_email_fails(self):
        r = _build(self.mind, "--offline", "--as", "ghost@x.com")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no such account", r.stderr)

    def test_as_requires_offline(self):
        r = _build(self.mind, "--as", "alice@x.com")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("only applies to an --offline", r.stderr)

    def test_no_acl_registry_embeds_everything(self):
        # A mind with NO acl.json: nothing is private → the socle IS everything,
        # so the legacy "embed all" behaviour is preserved (single-user minds).
        bare = self.tmp / "bare"
        (bare / "content").mkdir(parents=True)
        (bare / "atlas.toml").write_text('lang = "en"\n', encoding="utf-8")
        (bare / "content" / "a.md").write_text(
            f"# A\n{PRIVATE_MARK}\n", encoding="utf-8")
        r = _build(bare, "--offline")
        self.assertEqual(r.returncode, 0, r.stderr)
        html = (bare / "dist" / "index-offline.html").read_text(encoding="utf-8")
        self.assertIn(PRIVATE_MARK, html)


if __name__ == "__main__":
    unittest.main()
