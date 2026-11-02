"""The instance appearance (cloud mode): the accent and whether the site prefix and the tagline
show, set by an admin in Settings › Apparence and read by every account.

- FileStore: settings.json merge semantics (a None drops the field, untouched fields stay).
- GET /api/appearance: any account; anonymous → 401.
- POST /api/appearance: admin only (viewer → 403), CSRF-checked, validated (#rrggbb or null,
  show_prefix / show_tagline booleans, something to set).
"""
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer
from test_admin import (ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
                        csrf_token_for, file_store_of, seed_admin_and_viewer, session_cookie)

import store  # noqa: E402  (test_admin puts src/ on sys.path)


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
        self.assertEqual(resp.json(), {"brand": "#3b82f6", "show_prefix": False})
        seen = self.srv.get("/api/appearance", headers={"Cookie": self.viewer_cookie})
        self.assertEqual(seen.status, 200)
        self.assertEqual(seen.json(), {"brand": "#3b82f6", "show_prefix": False})
        # Back to Atlas gold; the prefix setting stays.
        self.assertEqual(self._post({"brand": None}).json(), {"show_prefix": False})
        self.assertEqual(self._post({"show_prefix": True, "show_tagline": False}).json(),
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

    def test_rejects_bad_values(self):
        for body in ({"brand": "red"}, {"brand": "#ff00"}, {"brand": "#ff0000; x"},
                     {"show_prefix": "no"}, {"show_tagline": 1}, {}, ["brand"]):
            with self.subTest(body=body):
                self.assertEqual(self._post(body).status, 400)


if __name__ == "__main__":
    unittest.main()
