"""The instance appearance (cloud mode): the accent, the site prefix and the tagline and whether
they show, set by an admin in Settings › Apparence and read by every account.

- FileStore: settings.json merge semantics (a None drops the field, untouched fields stay).
- GET /api/appearance: any account; anonymous → 401.
- POST /api/appearance: admin only (viewer → 403), CSRF-checked, validated (#rrggbb or null,
  show_prefix / show_tagline booleans, something to set).
- The prefix and the tagline go to atlas.toml, committed, and read back at once.
- set_toml_root_keys: a key replaces its line (live, else the commented example) or goes before
  the first table; quotes and backslashes are escaped.
"""
import subprocess
import tomllib
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer
from test_admin import (ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
                        csrf_token_for, file_store_of, seed_admin_and_viewer, session_cookie)

import store  # noqa: E402  (test_admin puts src/ on sys.path)
from cli import DEFAULT_TAGLINE_EN, DEFAULT_TAGLINE_FR  # noqa: E402
from config import set_toml_root_keys  # noqa: E402


def _look(body: dict) -> dict:
    """The appearance without the prefix, tagline and language every answer carries."""
    return {k: v for k, v in body.items() if k not in ("prefix", "tagline", "lang")}


class TestAppearanceStore(unittest.TestCase):

    def test_merge_and_reset(self):
        with tempfile.TemporaryDirectory() as tmp:
            fs = store.FileStore(Path(tmp))
            self.assertEqual(fs.get_appearance(), {})
            self.assertEqual(fs.set_appearance({"brand": "#3b82f6"}), {"brand": "#3b82f6"})
            fs.set_appearance({"show_prefix": False})
            self.assertEqual(fs.get_appearance(), {"brand": "#3b82f6", "show_prefix": False})
            fs.set_appearance({"brand": None})
            self.assertEqual(fs.get_appearance(), {"show_prefix": False})


class TestAppearanceApi(unittest.TestCase):

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        seed_admin_and_viewer(file_store_of(cls.srv))
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin_csrf = csrf_token_for(cls.srv, cls.admin_cookie)
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)
        cls.viewer_csrf = csrf_token_for(cls.srv, cls.viewer_cookie)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _post(self, body, cookie=None, csrf=None):
        headers = {"Cookie": cookie or self.admin_cookie, "X-CSRF-Token": csrf or self.admin_csrf}
        return self.srv.post("/api/appearance", json_body=body, headers=headers)

    def test_admin_sets_every_account_reads(self):
        resp = self._post({"brand": "#3B82F6", "show_prefix": False})
        self.assertEqual(resp.status, 200)
        self.assertEqual(_look(resp.json()), {"brand": "#3b82f6", "show_prefix": False})
        seen = self.srv.get("/api/appearance", headers={"Cookie": self.viewer_cookie})
        self.assertEqual(seen.status, 200)
        self.assertEqual(_look(seen.json()), {"brand": "#3b82f6", "show_prefix": False})
        # Back to Atlas gold; the prefix setting stays.
        self.assertEqual(_look(self._post({"brand": None}).json()), {"show_prefix": False})
        self.assertEqual(_look(self._post({"show_prefix": True, "show_tagline": False}).json()),
                         {"show_prefix": True, "show_tagline": False})
        self._post({"show_tagline": True})

    def test_viewer_cannot_set(self):
        resp = self._post({"brand": "#ff0000"}, self.viewer_cookie, self.viewer_csrf)
        self.assertEqual(resp.status, 403)

    def test_anonymous_cannot_read(self):
        self.assertEqual(self.srv.get("/api/appearance").status, 401)

    def test_csrf_required(self):
        resp = self.srv.post("/api/appearance", json_body={"brand": "#ff0000"},
                             headers={"Cookie": self.admin_cookie})
        self.assertEqual(resp.status, 403)

    def test_prefix_and_tagline_go_to_atlas_toml(self):
        prefix, tagline = 'Sophie\'s "Atlas"', 'Mes idées, \\ à moi'
        resp = self._post({"prefix": f"  {prefix} ", "tagline": tagline})
        self.assertEqual(resp.status, 200, resp.body)
        self.assertEqual((resp.json()["prefix"], resp.json()["tagline"]), (prefix, tagline))
        seen = self.srv.get("/api/appearance", headers={"Cookie": self.viewer_cookie}).json()
        self.assertEqual(seen["prefix"], prefix)
        toml = tomllib.loads((self.srv.root / "atlas.toml").read_text(encoding="utf-8"))
        self.assertEqual((toml["prefix"], toml["tagline"]), (prefix, tagline))
        log = subprocess.run(["git", "log", "-1", "--format=%s", "--", "atlas.toml"], cwd=self.srv.root,
                             capture_output=True, text=True).stdout
        self.assertIn("appearance: prefix, tagline", log)
        self.assertEqual(self._post({"prefix": ""}).json()["prefix"], "")  # "Atlas" alone

    def test_language_goes_to_atlas_toml_and_takes_the_default_line_along(self):
        before = self.srv.get("/api/appearance", headers={"Cookie": self.viewer_cookie}).json()
        self.assertEqual(self._post({"lang": "en", "tagline": DEFAULT_TAGLINE_EN}).status, 200)
        resp = self._post({"lang": "fr"}).json()
        self.assertEqual((resp["lang"], resp["tagline"]), ("fr", DEFAULT_TAGLINE_FR))
        toml = tomllib.loads((self.srv.root / "atlas.toml").read_text(encoding="utf-8"))
        self.assertEqual((toml["lang"], toml["tagline"]), ("fr", DEFAULT_TAGLINE_FR))
        # A line of one's own stays as typed.
        self._post({"tagline": "À moi"})
        self.assertEqual(self._post({"lang": "en"}).json()["tagline"], "À moi")
        self._post({"lang": before["lang"], "tagline": before["tagline"]})

    def test_rejects_bad_values(self):
        for body in ({"brand": "red"}, {"brand": "#ff00"}, {"brand": "#ff0000; x"},
                     {"show_prefix": "no"}, {"show_tagline": 1}, {}, ["brand"],
                     {"prefix": "two\nlines"}, {"prefix": "x" * 41}, {"prefix": 3},
                     {"tagline": "   "}, {"lang": "de"}, {"lang": 1}):
            with self.subTest(body=body):
                self.assertEqual(self._post(body).status, 400)


class TestTomlRootKeys(unittest.TestCase):

    def test_replaces_the_live_line_then_the_commented_example(self):
        text = '# prefix = "Acme"\ntagline = "Old"\nlang = "fr"\n\n[server]\nport = 1\n'
        out = set_toml_root_keys(text, {"prefix": "Ludo", "tagline": "New"})
        self.assertEqual(out, 'prefix = "Ludo"\ntagline = "New"\nlang = "fr"\n\n[server]\nport = 1\n')

    def test_a_missing_key_goes_before_the_first_table(self):
        value = 'a "b" \\ c'
        out = set_toml_root_keys('lang = "en"\n\n[server]\nport = 1\n', {"prefix": value})
        self.assertEqual(tomllib.loads(out), {"lang": "en", "prefix": value, "server": {"port": 1}})
        self.assertTrue(out.startswith('lang = "en"\nprefix = '))

    def test_a_key_inside_a_table_is_left_alone(self):
        out = set_toml_root_keys('[site]\nprefix = "not the root one"\n', {"prefix": "Root"})
        self.assertEqual(tomllib.loads(out), {"prefix": "Root", "site": {"prefix": "not the root one"}})

if __name__ == "__main__":
    unittest.main()
