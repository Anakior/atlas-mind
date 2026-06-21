"""Tests for the engine CLI (src/cli.py): scaffolding, build, administration of
the file registry (user/token/share) and end-to-end serve.

The CLI is invoked in a subprocess (`python3 src/cli.py …`) on temporary minds,
with an env purged of ambient variables (ATLAS_MIND, ATLAS_STORE…) — same
philosophy as the server harness.

The key test is the end-to-end Bearer flow: init → user add → token create →
serve → /api/v1/search with the token — it proves that the registry written by
the CLI is exactly the one the server consults (atlas.toml scaffolded with
store.kind = "file").
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from harness import find_free_port

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "src" / "cli.py"

REPO_SRC = REPO_ROOT / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import cli  # noqa: E402
import store  # noqa: E402
from config import AtlasConfig  # noqa: E402

# The token is printed alone on its line, indented: 64 hex (256 bits).
TOKEN_LINE_RE = re.compile(r"^\s*([0-9a-f]{64})\s*$", re.MULTILINE)

PASSWORD = "secret-password-123"


def clean_env(**extra) -> dict:
    """Purged env for the CLI subprocesses: an ambient ATLAS_MIND (or cloud
    residue) would redirect the commands to the wrong mind."""
    env = os.environ.copy()
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["PYTHONUNBUFFERED"] = "1"
    for var in ("ATLAS_MIND", "ATLAS_STORE", "ATLAS_STORE_DIR",
                "KB_AUTH_ENABLED", "GITHUB_REPO_URL",
                "KB_REPO_PATH", "SESSION_SECRET", "GITHUB_WEBHOOK_SECRET",
                "GIT_PULL_INTERVAL", "PORT"):
        env.pop(var, None)
    env.update(extra)
    return env


def run_cli(*args, env: dict = None, timeout: float = 60):
    return subprocess.run(
        [sys.executable, str(CLI), *[str(a) for a in args]],
        capture_output=True, text=True, timeout=timeout,
        # DEVNULL stdin → `atlas init` sees a non-TTY and stays non-interactive
        # (never prompts/hangs), whatever terminal the test runs from.
        stdin=subprocess.DEVNULL,
        env=env if env is not None else clean_env(),
    )


def extract_token(stdout: str) -> str:
    match = TOKEN_LINE_RE.search(stdout)
    assert match, f"no 64-hex token in the output:\n{stdout}"
    return match.group(1)


def http_get(url: str, headers: dict = None, timeout: float = 10):
    """Simple GET → (status, body); 4xx/5xx are returned, never raised."""
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        body = error.read()
        error.close()
        return error.code, body


class CliMindTest(unittest.TestCase):
    """One temporary directory per test; self.mind is NOT created automatically
    (the init tests want to control its existence)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-cli-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.mind = self.tmp / "mind"

    def init_mind(self) -> Path:
        result = run_cli("init", self.mind)
        assert result.returncode == 0, result.stderr
        return self.mind

    def users_json(self) -> list:
        return json.loads(
            (self.mind / ".atlas" / "users.json").read_text(encoding="utf-8"))

    def shares_json(self) -> list:
        return json.loads(
            (self.mind / ".atlas" / "shares.json").read_text(encoding="utf-8"))


# ─── init ──────────────────────────────────────────────────────────────────────


class TestCliInit(CliMindTest):

    def test_init_scaffolds_mind(self):
        result = run_cli("init", self.mind)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.mind / "atlas.toml").is_file())
        self.assertTrue((self.mind / "content" / "welcome.md").is_file())
        self.assertTrue((self.mind / "content" / "notes" / "example.md").is_file())
        self.assertTrue((self.mind / "content" / "inbox").is_dir())
        gitignore = (self.mind / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("dist/", gitignore)
        self.assertIn(".atlas/", gitignore)
        # The example docs reference each other via cross [[wikilinks]].
        welcome = (self.mind / "content" / "welcome.md").read_text(encoding="utf-8")
        self.assertIn("[[notes/example]]", welcome)
        # git init -b main
        branch = subprocess.run(
            ["git", "-C", str(self.mind), "symbolic-ref", "--short", "HEAD"],
            capture_output=True, text=True, env=clean_env())
        self.assertEqual(branch.stdout.strip(), "main")

    def test_init_atlas_toml_is_valid_and_uses_file_store(self):
        self.init_mind()
        config = AtlasConfig.load(root=self.mind, env={})
        # The scaffold uncomments ONLY store.kind = "file" (the registry managed
        # by `atlas user|token|share` is the one the server consults); everything
        # else stays commented → engine defaults unchanged.
        self.assertEqual(config.store_kind, "file")
        self.assertEqual(config.store_dir, self.mind / ".atlas")
        self.assertEqual(config.port, 8765)
        self.assertEqual(config.excluded_names, {"quick.md"})
        self.assertEqual(config.todo_file,
                         self.mind / "content" / "notes" / "quick.md")
        # The template's [todo].categories example is commented out: the engine
        # defaults ("work"/"personal") apply as-is.
        self.assertEqual(config.todo_categories, ("work", "personal"))

    def test_init_refuses_non_empty_dir(self):
        self.mind.mkdir(parents=True)
        (self.mind / "notes-perso.txt").write_text("précieux", encoding="utf-8")
        result = run_cli("init", self.mind)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not empty", result.stderr)
        self.assertFalse((self.mind / "atlas.toml").exists())

    def test_init_force_scaffolds_but_keeps_existing_files(self):
        self.mind.mkdir(parents=True)
        custom_toml = '[server]\nport = 9999\n'
        (self.mind / "atlas.toml").write_text(custom_toml, encoding="utf-8")
        result = run_cli("init", self.mind, "--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        # The existing file is never overwritten, the rest is scaffolded.
        self.assertEqual((self.mind / "atlas.toml").read_text(encoding="utf-8"),
                         custom_toml)
        self.assertIn("kept", result.stdout)
        self.assertTrue((self.mind / "content" / "welcome.md").is_file())

    def test_init_without_git_on_path(self):
        empty_bin = self.tmp / "empty-bin"
        empty_bin.mkdir()
        result = run_cli("init", self.mind, env=clean_env(PATH=str(empty_bin)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("git not found", result.stdout)
        self.assertFalse((self.mind / ".git").exists())
        self.assertTrue((self.mind / "content" / "welcome.md").is_file())

    def test_init_default_scaffold_is_english(self):
        self.init_mind()
        toml = (self.mind / "atlas.toml").read_text(encoding="utf-8")
        self.assertIn('lang = "en"', toml)
        self.assertIn('tagline = "Personal knowledge base."', toml)
        welcome = (self.mind / "content" / "welcome.md").read_text(encoding="utf-8")
        self.assertIn("# Welcome", welcome)
        # The going-online guide explains the private GitHub remote + push rights.
        out = run_cli("init", self.tmp / "mind2").stdout
        self.assertIn("PRIVATE", out)
        self.assertIn("remote add origin", out)

    def test_init_lang_and_flags_non_interactive(self):
        # Flags fully drive the scaffold; --yes guarantees no prompt even on a TTY.
        result = run_cli("init", self.mind, "--yes", "--lang", "fr",
                         "--prefix", "Acme", "--tagline", "Ma base.")
        self.assertEqual(result.returncode, 0, result.stderr)
        toml = (self.mind / "atlas.toml").read_text(encoding="utf-8")
        self.assertIn('lang = "fr"', toml)
        self.assertIn('prefix = "Acme"', toml)
        self.assertIn('tagline = "Ma base."', toml)
        # French scaffold variant: the welcome doc is in French.
        welcome = (self.mind / "content" / "welcome.md").read_text(encoding="utf-8")
        self.assertIn("# Bienvenue", welcome)


# ─── deploy ──────────────────────────────────────────────────────────────────


class TestCliDeploy(CliMindTest):

    def test_deploy_compose_scaffolds_files_and_guide(self):
        self.init_mind()
        result = run_cli("deploy", self.mind)  # default target: compose
        self.assertEqual(result.returncode, 0, result.stderr)
        for rel in ("deploy/Dockerfile", "deploy/docker-compose.yml",
                    "deploy/Caddyfile", "deploy/.env.example"):
            self.assertTrue((self.mind / rel).is_file(), rel)
        # The image installs the engine from PyPI (self-contained for pip users).
        self.assertIn("pip install", (self.mind / "deploy" / "Dockerfile").read_text(encoding="utf-8"))
        self.assertIn("SESSION_SECRET", result.stdout)

    def test_deploy_systemd_target(self):
        self.init_mind()
        result = run_cli("deploy", self.mind, "--target", "systemd")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.mind / "deploy" / "atlas.service").is_file())

    def test_deploy_fly_target(self):
        self.init_mind()
        result = run_cli("deploy", self.mind, "--target", "fly")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.mind / "deploy" / "fly.toml").is_file())
        dockerfile = (self.mind / "deploy" / "Dockerfile.fly").read_text(encoding="utf-8")
        # Clone-at-boot entrypoint (NOT `atlas serve`, which needs content/ first).
        self.assertIn("python", dockerfile)
        self.assertIn("atlas_mind.server", dockerfile)
        self.assertIn("GITHUB_REPO_URL", result.stdout)
        # Non-interactive (no TTY, no --app): the app name defaults to a slug of
        # the mind folder ("mind") — no placeholder left to edit by hand.
        toml = (self.mind / "deploy" / "fly.toml").read_text(encoding="utf-8")
        self.assertIn("app = 'mind'", toml)
        self.assertNotIn("your-atlas-app", toml)
        self.assertIn("fly apps create mind", result.stdout)

    def test_deploy_fly_app_flag_overrides_name(self):
        self.init_mind()
        result = run_cli("deploy", self.mind, "--target", "fly", "--app", "My Cool Atlas")
        self.assertEqual(result.returncode, 0, result.stderr)
        toml = (self.mind / "deploy" / "fly.toml").read_text(encoding="utf-8")
        # The name is slugified to a DNS-safe Fly app name.
        self.assertIn("app = 'my-cool-atlas'", toml)
        self.assertIn("fly apps create my-cool-atlas", result.stdout)

    @unittest.skipIf(os.name == "nt",
                     "isatty(NUL) is True on Windows, so DEVNULL cannot simulate a "
                     "non-interactive stdin — the --wizard TTY guard can't be "
                     "exercised here (it works on POSIX, where /dev/null reports "
                     "isatty()==False; the guard itself is correct).")
    def test_deploy_fly_wizard_refuses_non_interactive(self):
        # run_cli pipes stdin (DEVNULL) → no TTY (on POSIX) → the wizard must
        # refuse cleanly rather than block on a prompt.
        self.init_mind()
        result = run_cli("deploy", self.mind, "--target", "fly", "--wizard")
        self.assertEqual(result.returncode, 1)
        self.assertIn("interactive terminal", result.stderr)


    def test_deploy_keeps_existing_without_force(self):
        self.init_mind()
        run_cli("deploy", self.mind)
        (self.mind / "deploy" / "Caddyfile").write_text("custom", encoding="utf-8")
        again = run_cli("deploy", self.mind)
        self.assertIn("kept", again.stdout)
        self.assertEqual((self.mind / "deploy" / "Caddyfile").read_text(encoding="utf-8"),
                         "custom")


class TestGithubRepoUrl(unittest.TestCase):
    """_build_github_repo_url normalizes repo references into the token URL."""

    def test_accepted_forms_all_produce_token_url(self):
        expected = "https://x-access-token:tok@github.com/me/repo.git"
        for ref in ("https://github.com/me/repo.git",
                    "https://github.com/me/repo",
                    "git@github.com:me/repo.git",
                    "me/repo"):
            self.assertEqual(cli._build_github_repo_url(ref, "tok"), expected, ref)

    def test_unrecognized_ref_raises(self):
        with self.assertRaises(cli.CliError):
            cli._build_github_repo_url("not a repo", "tok")


# ─── build ─────────────────────────────────────────────────────────────────────


class TestCliBuild(CliMindTest):

    def test_build_generates_viewer(self):
        self.init_mind()
        result = run_cli("build", self.mind)
        self.assertEqual(result.returncode, 0, result.stderr)
        index = (self.mind / "dist" / "index.html").read_text(encoding="utf-8")
        self.assertIn("welcome.md", index)

    def test_build_offline_generates_monolith(self):
        self.init_mind()
        result = run_cli("build", self.mind, "--offline")
        self.assertEqual(result.returncode, 0, result.stderr)
        offline = (self.mind / "dist" / "index-offline.html").read_text(encoding="utf-8")
        # Embedded content (not just the tree metadata).
        self.assertIn("An ordinary note", offline)

    def test_build_unknown_mind_is_a_human_error(self):
        result = run_cli("build", self.tmp / "nexiste-pas")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not found", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


# ─── user ──────────────────────────────────────────────────────────────────────


class TestCliUser(CliMindTest):

    def test_user_add_writes_verifiable_scrypt_hash(self):
        self.init_mind()
        result = run_cli("user", "add", self.mind,
                         "--email", "admin@test.local", "--password", PASSWORD)
        self.assertEqual(result.returncode, 0, result.stderr)
        records = self.users_json()
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["email"], "admin@test.local")
        self.assertEqual(record["role"], "admin")  # default role
        self.assertTrue(record["password_hash"].startswith("scrypt$"))
        self.assertTrue(store.verify_password(PASSWORD, record["password_hash"]))
        self.assertFalse(store.verify_password("mauvais-mot-de-passe",
                                               record["password_hash"]))

    def test_user_add_viewer_role(self):
        self.init_mind()
        result = run_cli("user", "add", self.mind, "--email", "Lecteur@Test.local",
                         "--password", PASSWORD, "--role", "viewer")
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.users_json()[0]
        # Email normalized to lowercase (like seed_user.py).
        self.assertEqual(record["email"], "lecteur@test.local")
        self.assertEqual(record["role"], "viewer")

    def test_user_add_persists_first_and_last_name(self):
        self.init_mind()
        result = run_cli("user", "add", self.mind, "--email", "ada@test.local",
                         "--password", PASSWORD,
                         "--first-name", "Ada", "--last-name", "Lovelace")
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.users_json()[0]
        # Two distinct fields, never a merged "name".
        self.assertEqual(record["first_name"], "Ada")
        self.assertEqual(record["last_name"], "Lovelace")
        self.assertNotIn("name", record)
        # Displayed back in "First Last" order on creation.
        self.assertIn("Ada Lovelace", result.stdout)

    def test_user_add_first_name_only(self):
        # A single half is allowed; the other stays absent (no implicit merge).
        self.init_mind()
        result = run_cli("user", "add", self.mind, "--email", "grace@test.local",
                         "--password", PASSWORD, "--first-name", "Grace")
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.users_json()[0]
        self.assertEqual(record["first_name"], "Grace")
        self.assertNotIn("last_name", record)

    def test_user_add_without_names_is_nameless(self):
        # The default path stays schemaless: no name keys at all.
        self.init_mind()
        run_cli("user", "add", self.mind, "--email", "plain@test.local",
                "--password", PASSWORD)
        record = self.users_json()[0]
        self.assertNotIn("first_name", record)
        self.assertNotIn("last_name", record)

    def test_user_add_rejects_control_char_name(self):
        # A NUL can't be passed as an argv on Windows (ValueError before exec), so
        # exercise the guard with another control char (newline) it also rejects.
        self.init_mind()
        result = run_cli("user", "add", self.mind, "--email", "bad@test.local",
                         "--password", PASSWORD, "--first-name", "line\nbreak")
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid first_name", result.stderr)
        # Rejected before any write: no registry created.
        self.assertFalse((self.mind / ".atlas" / "users.json").exists())

    def test_user_add_rejects_duplicate_email(self):
        self.init_mind()
        run_cli("user", "add", self.mind, "--email", "admin@test.local",
                "--password", PASSWORD)
        result = run_cli("user", "add", self.mind, "--email", "admin@test.local",
                         "--password", "autre-password-456")
        self.assertEqual(result.returncode, 1)
        self.assertIn("already taken", result.stderr)
        self.assertEqual(len(self.users_json()), 1)

    def test_user_add_rejects_short_password_and_bad_role(self):
        self.init_mind()
        result = run_cli("user", "add", self.mind, "--email", "a@test.local",
                         "--password", "court")
        self.assertEqual(result.returncode, 1)
        self.assertIn("too short", result.stderr)
        # Role outside the choices → argparse error (exit 2).
        result = run_cli("user", "add", self.mind, "--email", "a@test.local",
                         "--password", PASSWORD, "--role", "superadmin")
        self.assertEqual(result.returncode, 2)

    def test_user_list_shows_accounts(self):
        self.init_mind()
        empty = run_cli("user", "list", self.mind)
        self.assertEqual(empty.returncode, 0)
        self.assertIn("No accounts", empty.stdout)
        run_cli("user", "add", self.mind, "--email", "admin@test.local",
                "--password", PASSWORD)
        run_cli("user", "add", self.mind, "--email", "viewer@test.local",
                "--password", PASSWORD, "--role", "viewer")
        result = run_cli("user", "list", self.mind)
        self.assertEqual(result.returncode, 0)
        self.assertIn("admin@test.local", result.stdout)
        self.assertIn("viewer@test.local", result.stdout)
        self.assertIn("viewer", result.stdout)

    def test_user_remove(self):
        self.init_mind()
        run_cli("user", "add", self.mind, "--email", "admin@test.local",
                "--password", PASSWORD)
        result = run_cli("user", "remove", self.mind, "--email", "admin@test.local")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.users_json(), [])
        again = run_cli("user", "remove", self.mind, "--email", "admin@test.local")
        self.assertEqual(again.returncode, 1)
        self.assertIn("no account", again.stderr.lower())


# ─── token ─────────────────────────────────────────────────────────────────────


class TestCliToken(CliMindTest):

    def test_token_create_prints_once_and_stores_sha256_only(self):
        self.init_mind()
        result = run_cli("token", "create", self.mind)
        self.assertEqual(result.returncode, 0, result.stderr)
        token = extract_token(result.stdout)
        self.assertIn("will never be shown again", result.stdout)
        records = self.users_json()
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["email"], "claude@api.local")  # default label
        self.assertEqual(record["role"], "api")
        self.assertEqual(record["api_token_hash"],
                         hashlib.sha256(token.encode()).hexdigest())
        # The plaintext token NEVER touches the disk.
        raw = (self.mind / ".atlas" / "users.json").read_text(encoding="utf-8")
        self.assertNotIn(token, raw)

    def test_token_create_rotates_same_label(self):
        self.init_mind()
        first = extract_token(run_cli("token", "create", self.mind).stdout)
        second_result = run_cli("token", "create", self.mind)
        self.assertEqual(second_result.returncode, 0)
        self.assertIn("regenerated", second_result.stdout)
        second = extract_token(second_result.stdout)
        self.assertNotEqual(first, second)
        records = self.users_json()
        self.assertEqual(len(records), 1)  # rotation, no duplicate
        self.assertEqual(records[0]["api_token_hash"],
                         hashlib.sha256(second.encode()).hexdigest())

    def test_token_revoke_lifecycle(self):
        self.init_mind()
        run_cli("token", "create", self.mind, "--label", "claude")
        listed = run_cli("token", "list", self.mind)
        self.assertIn("active", listed.stdout)
        revoked = run_cli("token", "revoke", self.mind, "--label", "claude")
        self.assertEqual(revoked.returncode, 0, revoked.stderr)
        self.assertIsNone(self.users_json()[0]["api_token_hash"])
        self.assertIn("revoked", run_cli("token", "list", self.mind).stdout)
        again = run_cli("token", "revoke", self.mind, "--label", "claude")
        self.assertEqual(again.returncode, 0)
        self.assertIn("already revoked", again.stdout)
        unknown = run_cli("token", "revoke", self.mind, "--label", "inconnu")
        self.assertEqual(unknown.returncode, 0)
        self.assertIn("nothing to revoke", unknown.stdout)

    def test_token_label_colliding_with_human_account_is_rejected(self):
        self.init_mind()
        run_cli("user", "add", self.mind, "--email", "bob@api.local",
                "--password", PASSWORD)
        result = run_cli("token", "create", self.mind, "--label", "bob")
        self.assertEqual(result.returncode, 1)
        self.assertIn("already taken", result.stderr)


# ─── share ─────────────────────────────────────────────────────────────────────


class TestCliShare(CliMindTest):

    def test_share_list_empty(self):
        self.init_mind()
        result = run_cli("share", "list", self.mind)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No share links", result.stdout)

    def test_share_revoke_lifecycle(self):
        self.init_mind()
        file_store = store.FileStore(self.mind / ".atlas")
        share_id = file_store.insert_share({
            "path": "bienvenue.md",
            "token": "token-de-partage-en-clair",
            "expires_at": 0,
            "created_at": int(time.time()),
            "created_by": "admin@test.local",
            "revoked": False,
        })
        listed = run_cli("share", "list", self.mind)
        self.assertIn(share_id, listed.stdout)
        self.assertIn("active", listed.stdout)
        revoked = run_cli("share", "revoke", self.mind, "--id", share_id)
        self.assertEqual(revoked.returncode, 0, revoked.stderr)
        self.assertTrue(self.shares_json()[0]["revoked"])
        self.assertIn("revoked", run_cli("share", "list", self.mind).stdout)
        again = run_cli("share", "revoke", self.mind, "--id", share_id)
        self.assertEqual(again.returncode, 1)
        self.assertIn("not found or already revoked", again.stderr)


# ─── serve (end-to-end) ─────────────────────────────────────────────────────────


class TestCliServe(CliMindTest):

    def _launch_serve(self, mind: Path, attempts: int = 3):
        """`cli.py serve` in a subprocess, ready when /healthz responds 200.
        Returns (port, proc); shutdown registered in cleanup."""
        log_path = self.tmp / "serve.log"
        for _ in range(attempts):
            port = find_free_port()
            log_file = open(log_path, "ab")
            proc = subprocess.Popen(
                [sys.executable, str(CLI), "serve", str(mind), "--port", str(port)],
                env=clean_env(), stdout=log_file, stderr=subprocess.STDOUT,
            )
            self.addCleanup(log_file.close)
            self.addCleanup(self._terminate, proc)
            if self._wait_ready(proc, port):
                return port, proc
            log = log_path.read_text(encoding="utf-8", errors="replace")
            if "Address already in use" not in log:
                raise AssertionError(f"serve did not start:\n{log[-4000:]}")
        raise AssertionError("serve did not start (repeated port collisions)")

    @staticmethod
    def _terminate(proc: subprocess.Popen) -> None:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    @staticmethod
    def _wait_ready(proc: subprocess.Popen, port: int,
                    timeout: float = 20.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return False
            try:
                status, _ = http_get(f"http://127.0.0.1:{port}/healthz", timeout=2)
                if status == 200:
                    return True
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.05)
        return False

    def test_serve_bearer_end_to_end(self):
        """The full CLI chain: init → user add → token create → serve →
        /api/v1/search authenticated by the Bearer issued by the CLI."""
        self.init_mind()
        added = run_cli("user", "add", self.mind, "--email", "admin@test.local",
                        "--password", PASSWORD)
        self.assertEqual(added.returncode, 0, added.stderr)
        created = run_cli("token", "create", self.mind, "--label", "claude")
        self.assertEqual(created.returncode, 0, created.stderr)
        token = extract_token(created.stdout)

        port, _ = self._launch_serve(self.mind)
        base = f"http://127.0.0.1:{port}"

        status, body = http_get(f"{base}/api/v1/search?q=welcome",
                                headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(status, 200, body[:300])
        paths = [hit["path"] for hit in json.loads(body)]
        self.assertIn("welcome.md", paths)

        status, _ = http_get(f"{base}/api/v1/search?q=welcome",
                             headers={"Authorization": "Bearer " + "0" * 64})
        self.assertEqual(status, 401)

        # serve built the missing viewer at startup (dist/index.html).
        status, body = http_get(f"{base}/")
        self.assertEqual(status, 200)
        self.assertIn(b"welcome.md", body)

    def test_serve_unknown_mind_is_a_human_error(self):
        result = run_cli("serve", self.tmp / "nexiste-pas", "--port", "1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not found", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


# ─── help & cross-cutting errors ─────────────────────────────────────────────────


class TestCliHelpAndErrors(CliMindTest):

    def test_help_lists_all_commands(self):
        result = run_cli("--help")
        self.assertEqual(result.returncode, 0)
        for command in ("init", "serve", "dev", "build", "user", "token", "share"):
            self.assertIn(command, result.stdout)
        sub_help = run_cli("user", "--help")
        self.assertEqual(sub_help.returncode, 0)
        for action in ("add", "list", "remove"):
            self.assertIn(action, sub_help.stdout)

    def test_broken_atlas_toml_is_a_human_error(self):
        self.init_mind()
        (self.mind / "atlas.toml").write_text("[store\nkind=", encoding="utf-8")
        result = run_cli("user", "list", self.mind)
        self.assertEqual(result.returncode, 1)
        self.assertIn("atlas.toml", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


class DevSandboxTest(unittest.TestCase):
    """`atlas dev` prepares a throwaway mind and a sandbox env, then launches the
    server in a subprocess. We test the two pure helpers that do the real work
    (preparing the mind, building the env) without booting a server."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-dev-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_seed_copies_demo_mind(self):
        scratch = self.tmp / "mind"
        status = cli._seed_dev_mind(scratch, reset=False)
        self.assertTrue((scratch / "content").is_dir())
        # The bundled demo (or the init fallback) always provides a welcome doc.
        self.assertTrue((scratch / "content" / "welcome.md").is_file())
        self.assertIn(str(scratch), status)

    def test_existing_mind_is_reused_then_reset_wipes(self):
        scratch = self.tmp / "mind"
        cli._seed_dev_mind(scratch, reset=False)
        marker = scratch / "content" / "marker.md"
        marker.write_text("keep me", encoding="utf-8")
        # A second run reuses the mind as-is (the marker survives).
        reused = cli._seed_dev_mind(scratch, reset=False)
        self.assertIn("reused", reused)
        self.assertTrue(marker.exists())
        # --reset wipes everything and re-seeds (the marker is gone).
        cli._seed_dev_mind(scratch, reset=True)
        self.assertFalse(marker.exists())
        self.assertTrue((scratch / "content" / "welcome.md").is_file())

    def test_dev_env_is_a_pure_local_sandbox(self):
        scratch = self.tmp / "mind"
        # Even with a polluted shell env, the sandbox must not flip into real
        # cloud mode (which would try to clone/push a remote).
        os.environ["KB_AUTH_ENABLED"] = "1"
        self.addCleanup(os.environ.pop, "KB_AUTH_ENABLED", None)
        env = cli._dev_serve_env(scratch, port=9123, fresh=True)
        self.assertEqual(env["ATLAS_DEV"], "1")
        self.assertEqual(env["ATLAS_MIND"], str(scratch))
        self.assertEqual(env["ATLAS_DEV_FRESH"], "1")
        self.assertEqual(env["PORT"], "9123")
        self.assertNotIn("KB_AUTH_ENABLED", env)
        self.assertTrue(env["PYTHONPATH"].startswith(str(cli.ENGINE_SRC)))


if __name__ == "__main__":
    unittest.main()
