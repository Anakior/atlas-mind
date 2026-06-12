"""Tests for the fr/en i18n (Phase 2a — neutral engine, language from atlas.toml).

An instance's language comes from the root `lang` key of atlas.toml:
- viewer: build.py injects __LANG__ into <html lang> and the viewer's
  STRINGS = {fr, en} dictionary serves all UI labels via t(...);
- server: the served HTML pages (login, /share/*, share errors) go through
  server.STRINGS, selected by CONFIG.lang. The API's JSON errors and the logs
  stay as-is (contract characterized elsewhere).

The default stays "fr": without atlas.toml, the historical rendering is unchanged.
An unsupported language fails with AtlasConfigError, never with broken English.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
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

LOCAL_DEFAULT_SECRET = b"dev-secret-change-me"

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


def forge_share_token(path: str, expires_at: int, secret: bytes) -> str:
    payload = json.dumps({"p": path, "e": expires_at}).encode()
    sig = hmac.new(secret, payload, hashlib.sha256).digest()
    return (base64.urlsafe_b64encode(payload).decode().rstrip("=") + "."
            + base64.urlsafe_b64encode(sig).decode().rstrip("="))


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
    (sharing uses a token forged with the default secret, local behavior
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
        self.assertIn("'Search…'", text)
        self.assertNotIn("__LANG__", text)

    def test_share_page_english(self):
        token = forge_share_token("projets/beta.md", 0, LOCAL_DEFAULT_SECRET)
        resp = self.srv.get(f"/share/{token}")
        self.assertEqual(resp.status, 200)
        self.assertIn('<html lang="en">', resp.text)
        self.assertIn("Read-only share via", resp.text)
        self.assertIn("Contents", resp.text)        # table-of-contents title (JS)
        self.assertNotIn("Partage en lecture seule", resp.text)

    def test_share_error_pages_english(self):
        invalid = self.srv.get("/share/not-a-token")
        self.assertEqual(invalid.status, 404)
        self.assertIn("Invalid link", invalid.text)
        self.assertNotIn("Lien invalide", invalid.text)

        expired = forge_share_token("accueil.md", 1, LOCAL_DEFAULT_SECRET)
        resp = self.srv.get(f"/share/{expired}")
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


class TestI18nFrenchDefaultUnchanged(unittest.TestCase):
    """Without atlas.toml: everything stays in French (historical default intact)."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=dict(CLOUD_ENV))
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_login_page_default_french(self):
        resp = self.srv.get("/login")
        self.assertEqual(resp.status, 200)
        self.assertIn('<html lang="fr">', resp.text)
        self.assertIn("Connexion", resp.text)
        self.assertIn("Se connecter", resp.text)
        self.assertIn('placeholder="Mot de passe"', resp.text)

    def test_dist_index_default_french(self):
        # dist/index.html is generated at _populate even in cloud mode.
        text = (self.srv.root / "dist" / "index.html").read_text(
            encoding="utf-8")
        self.assertIn('<html lang="fr">', text)
        self.assertIn("Récemment modifiés", text)
        self.assertIn("'Rechercher…'", text)


class TestI18nViewerDictionaryConsistency(unittest.TestCase):
    """Structural consistency of the viewer dictionary: fr and en expose the
    SAME keys, and every data-i18n* attribute in the markup references an
    existing key — an orphan label would display as its raw key."""

    @classmethod
    def setUpClass(cls):
        cls.template = (REPO_ROOT / "web" / "viewer.html").read_text(
            encoding="utf-8")

    def _dict_keys(self, lang: str) -> set:
        block = self.template.split("const STRINGS = {", 1)[1].split("\n};", 1)[0]
        section = block.split(f"  {lang}: {{", 1)[1].split("\n  },", 1)[0]
        return set(re.findall(r"^    ([A-Za-z0-9_]+):", section, re.M))

    def test_fr_and_en_have_identical_keys(self):
        fr, en = self._dict_keys("fr"), self._dict_keys("en")
        self.assertGreater(len(fr), 100)  # the dictionary is substantial
        self.assertEqual(fr, en)

    def test_every_data_i18n_attribute_resolves(self):
        fr = self._dict_keys("fr")
        used = set(re.findall(
            r'data-i18n(?:-title|-placeholder)?="([A-Za-z0-9_]+)"',
            self.template))
        self.assertGreater(len(used), 30)
        self.assertEqual(used - fr, set())


if __name__ == "__main__":
    unittest.main()
