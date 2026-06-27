"""Tests for the fr/en i18n (Phase 2a — neutral engine, language from atlas.toml).

An instance's language comes from the root `lang` key of atlas.toml:
- viewer: build.py injects __LANG__ into <html lang> and the viewer's
  STRINGS = {fr, en} dictionary serves all UI labels via t(...);
- server: the served HTML pages (login, /share/*, share errors) go through
  server.STRINGS, selected by CONFIG.lang. The API's JSON errors and the logs
  stay as-is (contract characterized elsewhere).

The default is "en": without atlas.toml, the engine renders in English.
An unsupported language fails with AtlasConfigError, never with broken English.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer

REPO_ROOT = Path(__file__).resolve().parent.parent
REPO_SRC = REPO_ROOT / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

from config import AtlasConfig, AtlasConfigError  # noqa: E402

ENGLISH_TOML = """\
prefix = "Test"
tagline = "A test knowledge base."
lang = "en"
"""

CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "i18n-test-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",   # short-circuits the git clone at boot
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}


class TomlAtlasServer(AtlasServer):
    """AtlasServer whose mind embeds an atlas.toml (written BEFORE the git
    init and the build, like a real configured mind)."""

    def __init__(self, toml_text: str, **kwargs):
        super().__init__(**kwargs)
        self._toml_text = toml_text

    def _populate(self) -> None:
        super()._populate()
        (self.root / "atlas.toml").write_text(self._toml_text, encoding="utf-8")


class TestI18nInvalidLang(unittest.TestCase):

    def test_invalid_lang_raises_atlas_config_error(self):
        # Consumed by <html lang> and the fr/en dictionaries: an unsupported
        # language must fail outright when the config is loaded.
        with tempfile.TemporaryDirectory(prefix="atlas-i18n-") as tmp:
            (Path(tmp) / "atlas.toml").write_text('lang = "de"\n',
                                                  encoding="utf-8")
            with self.assertRaises(AtlasConfigError) as ctx:
                AtlasConfig.load(root=tmp, env={})
            self.assertIn("lang", str(ctx.exception))


class TestI18nEnglishViewerAndShare(unittest.TestCase):
    """Mind lang=en, local mode: dist/index.html and share pages in English
    (the link is created via POST /api/share; local share behavior is
    characterized by test_misc)."""

    @classmethod
    def setUpClass(cls):
        cls.srv = TomlAtlasServer(ENGLISH_TOML)
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_dist_index_has_lang_en_and_english_strings(self):
        text = self.srv.get("/").text
        self.assertIn('<html lang="en">', text)
        # Labels from the STRINGS.en dictionary embedded in the page.
        self.assertIn("Signed in as", text)
        self.assertIn("Recently modified", text)
        self.assertRegex(text, "[\"']Search…[\"']")
        self.assertNotIn("__LANG__", text)

    def test_share_page_english(self):
        token = self.srv.post(
            "/api/share", json_body={"path": "projets/beta.md"}).json()["token"]
        resp = self.srv.get(f"/s/{token}")
        self.assertEqual(resp.status, 200)
        self.assertIn('<html lang="en">', resp.text)
        self.assertIn("Read-only share via", resp.text)
        self.assertIn("Contents", resp.text)        # table-of-contents title (JS)
        self.assertNotIn("Partage en lecture seule", resp.text)

    def test_share_error_pages_english(self):
        invalid = self.srv.get("/s/not-a-token")
        self.assertEqual(invalid.status, 404)
        self.assertIn("Invalid link", invalid.text)
        self.assertNotIn("Lien invalide", invalid.text)

        created = self.srv.post(
            "/api/share", json_body={"path": "accueil.md"}).json()
        shares_file = self.srv.root / ".atlas" / "shares.json"
        shares = json.loads(shares_file.read_text(encoding="utf-8"))
        for share in shares:
            if share["id"] == created["id"]:
                share["expires_at"] = 1
        shares_file.write_text(json.dumps(shares), encoding="utf-8")
        resp = self.srv.get(f"/s/{created['token']}")
        self.assertEqual(resp.status, 410)
        self.assertIn("Link expired", resp.text)


class TestI18nEnglishLoginPage(unittest.TestCase):
    """Cloud mode + lang=en: login page entirely in English."""

    @classmethod
    def setUpClass(cls):
        cls.srv = TomlAtlasServer(ENGLISH_TOML, extra_env=dict(CLOUD_ENV))
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_login_page_english(self):
        resp = self.srv.get("/login")
        self.assertEqual(resp.status, 200)
        self.assertIn('<html lang="en">', resp.text)
        self.assertIn("Sign in", resp.text)
        self.assertIn('placeholder="Password"', resp.text)
        self.assertNotIn("Connexion", resp.text)
        self.assertNotIn("Se connecter", resp.text)

    def test_login_invalid_credentials_english(self):
        resp = self.srv.post(
            "/login",
            data=b"email=nobody%40example.com&password=wrong",
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(resp.status, 401)
        self.assertIn("Invalid credentials", resp.text)
        self.assertNotIn("Identifiants invalides", resp.text)


class TestI18nEnglishDefault(unittest.TestCase):
    """Without atlas.toml: everything renders in English (engine default)."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=dict(CLOUD_ENV))
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_login_page_default_english(self):
        resp = self.srv.get("/login")
        self.assertEqual(resp.status, 200)
        self.assertIn('<html lang="en">', resp.text)
        self.assertIn("Sign in", resp.text)
        self.assertIn('placeholder="Password"', resp.text)
        self.assertNotIn("Se connecter", resp.text)

    def test_dist_index_default_english(self):
        # dist/index.html is generated at _populate even in cloud mode.
        text = (self.srv.root / "dist" / "index.html").read_text(
            encoding="utf-8")
        self.assertIn('<html lang="en">', text)
        self.assertIn("Recently modified", text)
        self.assertRegex(text, "[\"']Search…[\"']")


class TestI18nViewerDictionaryConsistency(unittest.TestCase):
    """Structural consistency of the viewer dictionary: fr and en expose the
    SAME keys, and every data-i18n* attribute in the markup references an
    existing key — an orphan label would display as its raw key."""

    @classmethod
    def setUpClass(cls):
        # The viewer is split: the STRINGS dict lives in web/js/*.js and the
        # data-i18n markup in web/partials/*.html — read the full source (shell +
        # fragments), as the build recollates them.
        web = REPO_ROOT / "src" / "web"
        parts = [(web / "viewer.html").read_text(encoding="utf-8")]
        for sub in ("js", "partials", "styles"):
            directory = web / sub
            if directory.is_dir():
                for frag in sorted(directory.iterdir()):
                    if frag.is_file():
                        parts.append(frag.read_text(encoding="utf-8"))
        cls.template = "\n".join(parts)

    def _dict_key_list(self, lang: str) -> list:
        # Tolerate a TS type annotation: `const STRINGS: Record<...> = {`.
        block = re.split(r"const STRINGS\b[^=]*=\s*\{", self.template, 1)[1].split("\n};", 1)[0]
        section = block.split(f"  {lang}: {{", 1)[1].split("\n  },", 1)[0]
        return re.findall(r"^    ([A-Za-z0-9_]+):", section, re.M)

    def _dict_keys(self, lang: str) -> set:
        return set(self._dict_key_list(lang))

    def test_fr_and_en_have_identical_keys(self):
        fr, en = self._dict_keys("fr"), self._dict_keys("en")
        self.assertGreater(len(fr), 100)  # the dictionary is substantial
        self.assertEqual(fr, en)

    def test_no_duplicate_keys(self):
        # A duplicate object key silently keeps the LAST value (the noResults/closeEsc
        # bug this split fixed). _dict_keys collapses to a set and would hide it, so
        # check the raw list per language.
        for lang in ("fr", "en"):
            keys = self._dict_key_list(lang)
            dupes = sorted({k for k in keys if keys.count(k) > 1})
            self.assertEqual(dupes, [], f"duplicate {lang} keys: {dupes}")

    def test_every_data_i18n_attribute_resolves(self):
        fr = self._dict_keys("fr")
        used = set(re.findall(
            r'data-i18n(?:-title|-placeholder)?="([A-Za-z0-9_]+)"',
            self.template))
        self.assertGreater(len(used), 30)
        self.assertEqual(used - fr, set())


if __name__ == "__main__":
    unittest.main()
