"""Your own password: POST /api/account/password changes it with the current one (and the
2FA code when on), the other sessions end while this one stays open. POST
/api/account/recovery-codes makes the codes that replace a forgotten one from the sign-in page
(POST /api/password/recover), each good once."""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env, csrf_token_for, file_store_of, login,
    seed_admin_and_viewer, session_cookie)

NEW = "a-brand-new-secret"


class TestPasswordChange(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.addCleanup(self.srv.stop)
        seed_admin_and_viewer(file_store_of(self.srv))
        self.cookie = session_cookie(self.srv, VIEWER_EMAIL, VIEWER_PASSWORD)
        self.other = session_cookie(self.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    def _change(self, body, cookie=None):
        cookie = cookie or self.cookie
        return self.srv.post("/api/account/password", json_body=body,
                             headers={"Cookie": cookie, "X-CSRF-Token": csrf_token_for(self.srv, cookie)})

    def _signs_in(self, password):
        return login(self.srv, VIEWER_EMAIL, password).status == 303

    def test_the_new_password_works_and_this_session_stays(self):
        resp = self._change({"current": VIEWER_PASSWORD, "password": NEW})
        self.assertEqual(resp.status, 200, resp.body)
        self.assertTrue(self._signs_in(NEW))
        self.assertFalse(self._signs_in(VIEWER_PASSWORD))
        renewed = next(c.split(";", 1)[0] for c in resp.headers.get_all("Set-Cookie")
                       if c.startswith(self.cookie.split("=", 1)[0] + "="))
        self.assertEqual(self.srv.get("/api/account/profile", headers={"Cookie": renewed}).status, 200)
        self.assertEqual(self.srv.get("/api/account/profile", headers={"Cookie": self.other}).status, 401)

    def test_a_wrong_current_password_changes_nothing(self):
        resp = self._change({"current": "not-it", "password": NEW})
        self.assertEqual((resp.status, resp.json()), (401, {"error": "bad_password"}))
        self.assertTrue(self._signs_in(VIEWER_PASSWORD))

    def test_too_short_is_refused(self):
        self.assertEqual(self._change({"current": VIEWER_PASSWORD, "password": "short"}).status, 400)


    def _codes(self, password=VIEWER_PASSWORD):
        return self.srv.post("/api/account/recovery-codes", json_body={"password": password},
                             headers={"Cookie": self.cookie, "X-CSRF-Token": csrf_token_for(self.srv, self.cookie)})

    def _left(self):
        return self.srv.get("/api/account/profile", headers={"Cookie": self.cookie}).json()["recovery_codes"]

    def _recover(self, code, password=NEW):
        return self.srv.post("/api/password/recover",
                             json_body={"email": VIEWER_EMAIL, "code": code, "password": password})

    def test_codes_need_the_password(self):
        self.assertEqual(self._codes("not-it").status, 401)
        self.assertEqual(self._left(), 0)
        codes = self._codes().json()["codes"]
        self.assertEqual(self._left(), len(codes))

    def test_a_code_replaces_a_forgotten_password_once(self):
        code = self._codes().json()["codes"][0]
        self.assertEqual(self._recover(code.upper()).status, 200)
        self.assertTrue(self._signs_in(NEW))
        self.assertEqual(self._recover(code, "yet-another-one").status, 401)
        self.assertTrue(self._signs_in(NEW))

    def test_a_wrong_code_changes_nothing(self):
        self._codes()
        self.assertEqual(self._recover("0000aaaa-0000aaaa").status, 401)
        self.assertTrue(self._signs_in(VIEWER_PASSWORD))


if __name__ == "__main__":
    unittest.main()
