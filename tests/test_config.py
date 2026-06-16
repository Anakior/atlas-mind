"""Tests of AtlasConfig (src/config.py) and of the engine/mind decoupling.

Two levels:
- Unit: AtlasConfig.load(root=..., env=...) with an explicit env (never
  os.environ) → EXACT defaults of the old globals of server.py/build.py,
  priority env > atlas.toml > defaults, clear errors on malformed toml.
- Integration (harness): server launched on a mind SEPARATE from the engine
  directory via ATLAS_MIND (the key decoupling test), atlas.toml taken into
  account end to end (todos, exclusions), boot cleanly refused on invalid toml.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer, DEFAULT_QUICK_MD, DEFAULT_MIND, TODO_REL

# The src/config.py module is imported directly (same code as the one copied
# into the test servers' tmpdir).
REPO_SRC = Path(__file__).resolve().parent.parent / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import config  # noqa: E402
from config import AtlasConfig, AtlasConfigError, resolve_mind_root  # noqa: E402


class ConfigTestBase(unittest.TestCase):
    """A bare temporary mind per test (and a loader without ambient env)."""

    def setUp(self):
        self.mind = Path(tempfile.mkdtemp(prefix="atlas-config-"))
        self.addCleanup(shutil.rmtree, self.mind, True)

    def write_toml(self, text: str) -> None:
        (self.mind / "atlas.toml").write_text(text, encoding="utf-8")

    def load(self, env: dict = None) -> AtlasConfig:
        return AtlasConfig.load(root=self.mind, env=env or {})


class TestDefaults(ConfigTestBase):
    """Without env or atlas.toml: the EXACT historical values of server.py."""

    def test_default_paths(self):
        cfg = self.load()
        self.assertEqual(cfg.root, self.mind.resolve())
        self.assertEqual(cfg.content_root, cfg.root / "content")
        self.assertEqual(cfg.dist_dir, cfg.root / "dist")
        self.assertEqual(cfg.index_file, cfg.root / "dist" / "index.html")
        self.assertEqual(cfg.notes_dir, cfg.root / ".notes")
        self.assertEqual(cfg.store_dir, cfg.root / ".atlas")
        # De-personalized default (branding decision: no personal marker in the
        # engine): notes/quick.md, no more example-corp/ path.
        self.assertEqual(cfg.todo_file,
                         cfg.content_root / "notes" / "quick.md")

    def test_default_server_values(self):
        cfg = self.load()
        self.assertEqual(cfg.port, 8765)
        self.assertFalse(cfg.auth_enabled)
        self.assertEqual(cfg.session_secret, b"dev-secret-change-me")
        self.assertEqual(cfg.session_max_age, 30 * 86400)  # 30 days by default (batch 2d)
        self.assertEqual(cfg.git_pull_interval, 300)
        self.assertEqual(cfg.github_webhook_secret, b"")
        self.assertEqual(cfg.store_kind, "file")  # public default: zero dependency
        self.assertIsNone(cfg.github_repo_url)

    def test_default_todo_build_git_values(self):
        cfg = self.load()
        self.assertEqual(cfg.todo_categories, ("work", "personal"))
        self.assertEqual(cfg.todo_cat_default, "work")
        self.assertEqual(cfg.todo_cat_headers,
                         {"work": "Work", "personal": "Personal"})
        self.assertEqual(cfg.excluded_names, {"quick.md"})
        self.assertEqual(cfg.git_author_name, "Atlas Bot")
        self.assertEqual(cfg.git_author_email, "atlas-bot@example.com")

    def test_web_dir_is_engine_side(self):
        # web/ (viewer template + PWA assets) belongs to the ENGINE: even with a
        # decoupled mind that has its own web/, it is the engine's one (present
        # in this repo) that is kept.
        (self.mind / "web").mkdir()
        cfg = self.load()
        # Viewer assets are bundled inside the package (src/web), not taken from
        # the mind even if it ships its own web/.
        self.assertEqual(cfg.web_dir, config.PACKAGE_DIR / "web")
        self.assertNotEqual(cfg.web_dir, self.mind / "web")


class TestEnvOverrides(ConfigTestBase):

    def test_env_overrides_beat_defaults(self):
        cfg = self.load(env={
            "PORT": "9999",
            "KB_AUTH_ENABLED": "1",
            "SESSION_SECRET": "env-secret",
            "GIT_PULL_INTERVAL": "42",
            "GITHUB_WEBHOOK_SECRET": "hook",
            "ATLAS_STORE": "file",
            "ATLAS_STORE_DIR": "/srv/registry",
            "GITHUB_REPO_URL": "https://example.com/env.git",
        })
        self.assertEqual(cfg.port, 9999)
        self.assertTrue(cfg.auth_enabled)
        self.assertEqual(cfg.session_secret, b"env-secret")
        self.assertEqual(cfg.git_pull_interval, 42)
        self.assertEqual(cfg.github_webhook_secret, b"hook")
        self.assertEqual(cfg.store_kind, "file")
        self.assertEqual(cfg.store_dir, Path("/srv/registry"))
        self.assertEqual(cfg.github_repo_url, "https://example.com/env.git")

    def test_kb_auth_enabled_keeps_historic_truthiness(self):
        # Preserved semantics of bool(os.environ.get(...)): any NON-EMPTY value
        # enables auth — including "0" — and the empty string disables it.
        self.assertTrue(self.load(env={"KB_AUTH_ENABLED": "0"}).auth_enabled)
        self.assertFalse(self.load(env={"KB_AUTH_ENABLED": ""}).auth_enabled)

    def test_session_max_age_env_override(self):
        cfg = self.load(env={"SESSION_MAX_AGE": "3600"})
        self.assertEqual(cfg.session_max_age, 3600)

    def test_session_max_age_must_be_positive(self):
        with self.assertRaises(config.AtlasConfigError):
            self.load(env={"SESSION_MAX_AGE": "0"})
        with self.assertRaises(config.AtlasConfigError):
            self.load(env={"SESSION_MAX_AGE": "-5"})



class TestTomlConfig(ConfigTestBase):

    FULL_TOML = """\
[server]
port = 9001
auth_enabled = true
session_secret = "toml-secret"
git_pull_interval = 60
github_webhook_secret = "toml-hook"

[store]
kind = "FILE"
dir = "registry"

[git]
author_name = "Toml Bot"
author_email = "bot@toml.local"
repo_url = "https://example.com/toml.git"

[todo]
file = "notes/todo.md"
categories = ["Boulot", "Maison"]

[build]
excluded_names = ["secret.md"]
"""

    def test_toml_overrides_defaults(self):
        self.write_toml(self.FULL_TOML)
        cfg = self.load()
        self.assertEqual(cfg.port, 9001)
        self.assertTrue(cfg.auth_enabled)
        self.assertEqual(cfg.session_secret, b"toml-secret")
        self.assertEqual(cfg.git_pull_interval, 60)
        self.assertEqual(cfg.github_webhook_secret, b"toml-hook")
        self.assertEqual(cfg.store_kind, "file")  # normalized to lowercase
        self.assertEqual(cfg.store_dir, cfg.root / "registry")
        self.assertEqual(cfg.git_author_name, "Toml Bot")
        self.assertEqual(cfg.git_author_email, "bot@toml.local")
        self.assertEqual(cfg.github_repo_url, "https://example.com/toml.git")
        self.assertEqual(cfg.todo_file, cfg.content_root / "notes/todo.md")
        self.assertEqual(cfg.todo_categories, ("boulot", "maison"))
        self.assertEqual(cfg.excluded_names, {"secret.md"})

    def test_toml_partial_keeps_other_defaults(self):
        self.write_toml("[server]\nport = 9100\n")
        cfg = self.load()
        self.assertEqual(cfg.port, 9100)
        self.assertEqual(cfg.session_secret, b"dev-secret-change-me")
        self.assertEqual(cfg.store_kind, "file")
        self.assertEqual(cfg.todo_categories, ("work", "personal"))
        self.assertEqual(cfg.excluded_names, {"quick.md"})

    def test_env_beats_toml(self):
        self.write_toml(self.FULL_TOML)
        cfg = self.load(env={
            "PORT": "7777",
            "SESSION_SECRET": "env-secret",
            "ATLAS_STORE_DIR": "/srv/from-env",
        })
        self.assertEqual(cfg.port, 7777)
        self.assertEqual(cfg.session_secret, b"env-secret")
        self.assertEqual(cfg.store_dir, Path("/srv/from-env"))  # env beats toml dir
        # Keys not covered by the env stay from the toml.
        self.assertEqual(cfg.git_pull_interval, 60)

    def test_invalid_store_kind_raises(self):
        # 'file' is the only supported backend: anything else fails loudly at boot.
        with self.assertRaises(config.AtlasConfigError):
            self.load(env={"ATLAS_STORE": "mongo"})

    def test_empty_env_value_falls_back_to_toml(self):
        # Historical `or` semantics of ATLAS_STORE: EMPTY env value → next level
        # (the toml), not an empty string.
        self.write_toml("[store]\nkind = \"file\"\n")
        cfg = self.load(env={"ATLAS_STORE": ""})
        self.assertEqual(cfg.store_kind, "file")

    def test_toml_todo_categories_drive_default_and_headers(self):
        self.write_toml("[todo]\ncategories = [\"boulot\", \"maison\"]\n")
        cfg = self.load()
        self.assertEqual(cfg.todo_categories, ("boulot", "maison"))
        self.assertEqual(cfg.todo_cat_default, "boulot")
        self.assertEqual(cfg.todo_cat_headers,
                         {"boulot": "Boulot", "maison": "Maison"})

    def test_toml_legacy_taff_perso_categories_still_supported(self):
        # Compat: the OLD defaults ("taff"/"perso", replaced by
        # "travail"/"personnel") stay usable via [todo].categories — a
        # historical instance configured this way must never break.
        self.write_toml("[todo]\ncategories = [\"taff\", \"perso\"]\n")
        cfg = self.load()
        self.assertEqual(cfg.todo_categories, ("taff", "perso"))
        self.assertEqual(cfg.todo_cat_default, "taff")
        self.assertEqual(cfg.todo_cat_headers,
                         {"taff": "Taff", "perso": "Perso"})

    def test_malformed_toml_raises_clear_error(self):
        self.write_toml("this is not [valid toml\n")
        with self.assertRaises(AtlasConfigError) as cm:
            self.load()
        self.assertIn("atlas.toml", str(cm.exception))

    def test_wrong_types_raise_clear_errors(self):
        # toml of the wrong type → error naming the offending key.
        self.write_toml("[server]\nport = \"eight-thousand\"\n")
        with self.assertRaises(AtlasConfigError) as cm:
            self.load()
        self.assertIn("server.port", str(cm.exception))
        # non-numeric env → error naming the offending variable.
        (self.mind / "atlas.toml").unlink()
        with self.assertRaises(AtlasConfigError) as cm:
            self.load(env={"PORT": "eight-thousand"})
        self.assertIn("PORT", str(cm.exception))


class TestTrustedIpHeader(ConfigTestBase):
    """server.trusted_ip_header / ATLAS_TRUSTED_IP_HEADER: trusted header for
    the client IP behind a reverse proxy (de-fly-ization)."""

    def test_default_is_none(self):
        # Default = historical behavior (Fly-Client-IP → X-Forwarded-For →
        # socket chain), signaled by None.
        self.assertIsNone(self.load().trusted_ip_header)

    def test_blank_toml_value_means_none(self):
        self.write_toml("[server]\ntrusted_ip_header = \"  \"\n")
        self.assertIsNone(self.load().trusted_ip_header)

    def test_toml_value(self):
        self.write_toml("[server]\ntrusted_ip_header = \"CF-Connecting-IP\"\n")
        self.assertEqual(self.load().trusted_ip_header, "CF-Connecting-IP")

    def test_env_beats_toml_and_empty_env_falls_back(self):
        self.write_toml("[server]\ntrusted_ip_header = \"X-Forwarded-For\"\n")
        cfg = self.load(env={"ATLAS_TRUSTED_IP_HEADER": "X-Real-IP"})
        self.assertEqual(cfg.trusted_ip_header, "X-Real-IP")
        # `or` semantics: EMPTY env value → next level (the toml).
        cfg = self.load(env={"ATLAS_TRUSTED_IP_HEADER": ""})
        self.assertEqual(cfg.trusted_ip_header, "X-Forwarded-For")

    def test_wrong_type_raises_clear_error(self):
        self.write_toml("[server]\ntrusted_ip_header = 42\n")
        with self.assertRaises(AtlasConfigError) as cm:
            self.load()
        self.assertIn("server.trusted_ip_header", str(cm.exception))


class TestMindResolution(ConfigTestBase):

    def test_resolve_mind_root_priorities(self):
        other = Path(tempfile.mkdtemp(prefix="atlas-mind-"))
        self.addCleanup(shutil.rmtree, other, True)
        # Explicit ATLAS_MIND takes precedence over everything else.
        self.assertEqual(
            resolve_mind_root({"ATLAS_MIND": str(self.mind),
                                "KB_AUTH_ENABLED": "1",
                                "KB_REPO_PATH": str(other)}),
            self.mind.resolve())
        # Cloud mode without ATLAS_MIND: KB_REPO_PATH (default /app/repo).
        self.assertEqual(
            resolve_mind_root({"KB_AUTH_ENABLED": "1",
                                "KB_REPO_PATH": str(other)}),
            other.resolve())
        self.assertEqual(resolve_mind_root({"KB_AUTH_ENABLED": "1"}),
                         Path("/app/repo").resolve())
        # Local mode with nothing: the parent of src/ (the engine repo).
        self.assertEqual(resolve_mind_root({}), config.ENGINE_ROOT)
        # And the explicit argument of load() takes precedence over ATLAS_MIND.
        cfg = AtlasConfig.load(root=self.mind, env={"ATLAS_MIND": str(other)})
        self.assertEqual(cfg.root, self.mind.resolve())


# ─── Integration: mind separate from the engine (ATLAS_MIND) ──────────────────


class TestSeparateMindServer(unittest.TestCase):
    """The key decoupling test: the server runs from the harness tmpdir
    (engine: src/ + web/) but serves a DISTINCT mind passed via ATLAS_MIND.
    The harness decoy content (accueil.md…) must never show through."""

    HELLO_MD = "# Mind séparé\n\nDocument servi depuis un mind découplé.\n"

    @classmethod
    def setUpClass(cls):
        cls.mind = Path(tempfile.mkdtemp(prefix="atlas-sep-mind-"))
        (cls.mind / "content" / TODO_REL).parent.mkdir(parents=True)
        (cls.mind / "content" / "hello.md").write_text(
            cls.HELLO_MD, encoding="utf-8", newline="")
        (cls.mind / "content" / TODO_REL).write_text(
            DEFAULT_QUICK_MD, encoding="utf-8", newline="")
        cls.srv = AtlasServer(extra_env={"ATLAS_MIND": str(cls.mind)})
        cls.srv.start()
        # dist/ of the separate mind generated by the ENGINE's build.py, pointed
        # at the mind via ATLAS_MIND (same mechanism as trigger_sync server-side).
        env = os.environ.copy()
        env["ATLAS_MIND"] = str(cls.mind)
        env["PYTHONPATH"] = str(cls.srv.root / "src") + os.pathsep + env.get("PYTHONPATH", "")
        result = subprocess.run(
            [sys.executable, "-m", "build"],
            cwd=str(cls.srv.root), env=env,
            capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        assert (cls.mind / "dist" / "index.html").is_file()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.mind, ignore_errors=True)

    def test_separate_mind_is_served(self):
        resp = self.srv.get("/hello.md")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, self.HELLO_MD.encode("utf-8"))
        # The viewer (the mind's dist) references the mind's docs, not the decoy
        # copied by the harness into <engine>/content/.
        index = self.srv.get("/")
        self.assertEqual(index.status, 200)
        self.assertIn("hello.md", index.text)
        self.assertNotIn("accueil.md", index.text)
        tree = self.srv.get("/api/tree")
        self.assertEqual(tree.status, 200)
        self.assertIn("hello.md", tree.text)
        self.assertNotIn("accueil.md", tree.text)

    def test_separate_mind_receives_writes(self):
        resp = self.srv.put("/api/file", json_body={
            "path": "inbox/nouveau.md", "content": "# Nouveau\n"})
        self.assertEqual(resp.status, 200)
        self.assertEqual((self.mind / "content" / "inbox" / "nouveau.md")
                         .read_text(encoding="utf-8"), "# Nouveau\n")
        # Nothing leaked into the content/ of the engine directory.
        self.assertFalse((self.srv.content_root / "inbox" / "nouveau.md").exists())

    def test_separate_mind_todos(self):
        todos = self.srv.get("/api/todos").json()
        self.assertIn("Préparer le bilan mensuel", [t["text"] for t in todos])
        resp = self.srv.post("/api/todos", json_body={"text": "Todo découplée"})
        self.assertEqual(resp.status, 200)
        quick = (self.mind / "content" / TODO_REL).read_text(encoding="utf-8")
        self.assertIn("- [ ] Todo découplée", quick)


class TestMindSrcIsIgnored(unittest.TestCase):
    """Clone↔image anti-shadowing: a src/build.py present in the mind (historical
    repo with the old engine embedded) must NEVER be imported/executed by the
    standalone engine. The decoy would crash on import if it were loaded."""

    @classmethod
    def setUpClass(cls):
        cls.mind = Path(tempfile.mkdtemp(prefix="atlas-decoy-mind-"))
        (cls.mind / "content" / TODO_REL).parent.mkdir(parents=True)
        (cls.mind / "content" / "ok.md").write_text("# OK\n", encoding="utf-8")
        (cls.mind / "content" / TODO_REL).write_text(
            DEFAULT_QUICK_MD, encoding="utf-8")
        # Decoy: a build.py that raises on import. If it were imported by
        # _import_build (old behavior "the clone's src/ wins"), /api/tree would
        # crash. The standalone engine must ignore it and use ITS build.py.
        (cls.mind / "src").mkdir()
        (cls.mind / "src" / "build.py").write_text(
            "raise RuntimeError('DECOY: the mind build.py must never "
            "be imported')\n", encoding="utf-8")
        # run_build=False: we test /api/tree (live walk via _import_build), not dist.
        cls.srv = AtlasServer(extra_env={"ATLAS_MIND": str(cls.mind)},
                              run_build=False)
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.mind, ignore_errors=True)

    def test_tree_works_despite_decoy_build_in_mind(self):
        # /api/tree goes through _import_build → if the mind's decoy were
        # imported, it would raise (at module level) and the tree would fail.
        tree = self.srv.get("/api/tree")
        self.assertEqual(tree.status, 200)
        self.assertIn("ok.md", tree.text)


# ─── Integration: atlas.toml read in the mind ─────────────────────────────────


class TomlMindServer(AtlasServer):
    """AtlasServer whose mind embeds an atlas.toml (written before the harness
    build and the server boot, like a real configured mind)."""

    def __init__(self, *args, atlas_toml: str = "", **kwargs):
        super().__init__(*args, **kwargs)
        self._atlas_toml = atlas_toml

    def _populate(self):
        super()._populate()
        (self.root / "atlas.toml").write_text(self._atlas_toml, encoding="utf-8")


class TestTomlEndToEnd(unittest.TestCase):

    def test_toml_todo_file_and_categories_applied(self):
        toml = "[todo]\nfile = \"notes/todo.md\"\ncategories = [\"boulot\", \"maison\"]\n"
        mind = dict(DEFAULT_MIND)
        mind["notes/todo.md"] = (
            "# To-do\n\n## Boulot\n\n- [ ] Tâche pro\n\n"
            "## Maison\n\n- [x] Tâche maison\n\n"
        )
        with TomlMindServer(mind=mind, atlas_toml=toml) as srv:
            todos = srv.get("/api/todos").json()
            self.assertEqual(
                [(t["text"], t["cat"]) for t in todos],
                [("Tâche pro", "boulot"), ("Tâche maison", "maison")])
            # An unknown category falls back to the 1st configured category.
            resp = srv.post("/api/todos",
                            json_body={"text": "Sans cat", "cat": "inconnue"})
            self.assertEqual(resp.status, 200)
            written = srv.path("notes/todo.md").read_text(encoding="utf-8")
            self.assertIn("## Boulot", written)
            self.assertIn("- [ ] Sans cat", written)
            # The historical todo file has not moved: notes/todo.md is indeed the
            # one carrying the todos now.
            self.assertEqual(srv.path(TODO_REL).read_text(encoding="utf-8"),
                             DEFAULT_MIND[TODO_REL])

    def test_toml_excluded_names_applied_to_tree_and_build(self):
        # The override REPLACES the default exclusions: beta.md disappears, and
        # quick.md (historically excluded by default) becomes visible again.
        toml = "[build]\nexcluded_names = [\"beta.md\"]\n"
        with TomlMindServer(atlas_toml=toml) as srv:
            tree = srv.get("/api/tree")
            self.assertEqual(tree.status, 200)
            self.assertNotIn("projets/beta.md", tree.text)
            self.assertIn(TODO_REL, tree.text)
            # The harness build (dist/index.html) read the same atlas.toml.
            index = srv.get("/")
            self.assertNotIn("beta.md", index.text)
            self.assertIn("quick.md", index.text)

    def test_malformed_toml_fails_boot_with_clear_error(self):
        srv = TomlMindServer(atlas_toml="this is not [valid toml\n",
                              run_build=False)
        with self.assertRaises(RuntimeError) as cm:
            srv.start()
        message = str(cm.exception)
        self.assertIn("FATAL", message)
        self.assertIn("atlas.toml", message)


# ─── Integration: trusted_ip_header and login rate limit ──────────────────────


class TestTrustedIpHeaderEndToEnd(unittest.TestCase):
    """The login rate limit (10/min per IP) identifies the client via
    _client_ip(): configured header if it exists, otherwise the historical Fly
    chain."""

    CLOUD_ENV = {
        "KB_AUTH_ENABLED": "1",
        "SESSION_SECRET": "atlas-test-trusted-ip-0123456789abcdef",
        "KB_REPO_PATH": "{root}",   # bypasses the git clone at boot
        "ATLAS_STORE": "file",
        "GIT_PULL_INTERVAL": "3600",
    }

    @staticmethod
    def attempt_login(srv: AtlasServer, headers: dict):
        # Empty registry: 401 expected as long as the rate limit lets it through.
        return srv.post("/login", headers=headers,
                        json_body={"email": "x@test.local", "password": "bad"})

    def test_login_rate_limit_uses_configured_header(self):
        env = dict(self.CLOUD_ENV)
        env["ATLAS_TRUSTED_IP_HEADER"] = "X-Real-IP"
        with AtlasServer(extra_env=env) as srv:
            # 10 attempts for the same IP of the configured header, under the
            # limit — the VARYING Fly-Client-IP is ignored (the configured
            # header is authoritative, it does not reset the counter).
            for i in range(10):
                resp = self.attempt_login(srv, {
                    "X-Real-IP": "203.0.113.7",
                    "Fly-Client-IP": f"198.51.100.{i}",
                })
                self.assertEqual(resp.status, 401)
            # 11th attempt, same X-Real-IP: capped.
            resp = self.attempt_login(srv, {
                "X-Real-IP": "203.0.113.7",
                "Fly-Client-IP": "198.51.100.99",
            })
            self.assertEqual(resp.status, 429)
            # Another IP in the configured header is not affected.
            resp = self.attempt_login(srv, {"X-Real-IP": "203.0.113.8"})
            self.assertEqual(resp.status, 401)

    def test_configured_list_header_uses_last_element(self):
        # Proxy that STACKS X-Forwarded-For (nginx $proxy_add_x_forwarded_for,
        # Caddy without override): the value arrives as "supplied_by_the_client,
        # ip_seen_by_the_proxy". Only the LAST element is trusted — a client that
        # rotates the first element (spoofable) must NOT bypass the login rate
        # limit.
        env = dict(self.CLOUD_ENV)
        env["ATLAS_TRUSTED_IP_HEADER"] = "X-Forwarded-For"
        with AtlasServer(extra_env=env) as srv:
            for i in range(10):
                resp = self.attempt_login(srv, {
                    "X-Forwarded-For": f"198.51.100.{i}, 203.0.113.77"})
                self.assertEqual(resp.status, 401)
            # 11th attempt: the spoof rotates again, the real IP (last element)
            # is the same → capped.
            resp = self.attempt_login(srv, {
                "X-Forwarded-For": "198.51.100.99, 203.0.113.77"})
            self.assertEqual(resp.status, 429)
            # Another real client (different last element) passes.
            resp = self.attempt_login(srv, {
                "X-Forwarded-For": "198.51.100.99, 203.0.113.78"})
            self.assertEqual(resp.status, 401)

    def test_default_ignores_forgeable_client_headers(self):
        # Without trusted_ip_header and NOT on Fly: the socket peer identifies
        # the client. Forgeable client headers (Fly-Client-IP, X-Forwarded-For)
        # are IGNORED, so an attacker rotating them cannot mint fresh rate-limit
        # buckets to bypass the login cap (the bug the fix closes).
        with AtlasServer(extra_env=dict(self.CLOUD_ENV)) as srv:
            for i in range(10):
                resp = self.attempt_login(srv, {
                    "Fly-Client-IP": f"203.0.113.{i}",
                    "X-Forwarded-For": f"198.51.100.{i}, 10.0.0.1",
                })
                self.assertEqual(resp.status, 401)
            # 11th: brand-new forged headers, but the socket peer is unchanged
            # → capped despite the rotation.
            resp = self.attempt_login(srv, {
                "Fly-Client-IP": "203.0.113.250",
                "X-Forwarded-For": "198.51.100.250, 10.0.0.1",
            })
            self.assertEqual(resp.status, 429)

    def test_fly_client_ip_trusted_only_on_fly(self):
        # On Fly (FLY_APP_NAME set), Fly-Client-IP is platform-injected and
        # authoritative: distinct values get independent buckets, the same value
        # is capped.
        env = dict(self.CLOUD_ENV)
        env["FLY_APP_NAME"] = "atlas-test"
        with AtlasServer(extra_env=env) as srv:
            for _ in range(10):
                resp = self.attempt_login(srv, {"Fly-Client-IP": "203.0.113.50"})
                self.assertEqual(resp.status, 401)
            resp = self.attempt_login(srv, {"Fly-Client-IP": "203.0.113.50"})
            self.assertEqual(resp.status, 429)
            # A different client (distinct Fly-Client-IP) is not affected.
            resp = self.attempt_login(srv, {"Fly-Client-IP": "203.0.113.99"})
            self.assertEqual(resp.status, 401)


if __name__ == "__main__":
    unittest.main()
