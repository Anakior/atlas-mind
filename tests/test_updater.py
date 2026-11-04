"""Settings › About › Update (server/services/updater.py): the release is installed in place and
checked before the restart, a failed one puts the running release back, and an install that is
not a PyPI virtualenv never gets the button."""
import subprocess
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from server.services import updater  # noqa: E402
from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, cloud_env, csrf_token_for, file_store_of,
    seed_admin_and_viewer, session_cookie)


class TestUpdate(unittest.TestCase):
    def setUp(self):
        self.installs = []
        self._pip, self._version = updater._pip_install, updater._installed_version

    def tearDown(self):
        updater._pip_install, updater._installed_version = self._pip, self._version
        if updater._busy.locked():
            updater._busy.release()

    def _fake(self, *, pip_ok=True, starts_as=None):
        def pip(version):
            self.installs.append(version)
            return subprocess.CompletedProcess([], 0 if pip_ok else 1, "", "" if pip_ok else "ERROR: no such version")
        updater._pip_install = pip
        updater._installed_version = lambda: starts_as if starts_as is not None else self.installs[-1]

    def test_installed_and_checked(self):
        self._fake()
        self.assertEqual(updater.update("2.2.0", "2.1.1"), (True, ""))
        self.assertEqual(self.installs, ["2.2.0"])

    def test_a_failed_install_puts_the_running_release_back(self):
        self._fake(pip_ok=False)
        ok, why = updater.update("2.2.0", "2.1.1")
        self.assertFalse(ok)
        self.assertIn("no such version", why)
        self.assertEqual(self.installs, ["2.2.0", "2.1.1"])

    def test_a_release_that_does_not_start_is_undone(self):
        self._fake(starts_as="")  # the fresh interpreter could not import it
        ok, _ = updater.update("2.2.0", "2.1.1")
        self.assertFalse(ok)
        self.assertEqual(self.installs, ["2.2.0", "2.1.1"])
        self.assertFalse(updater._busy.locked())  # another try stays possible

    def test_one_update_at_a_time(self):
        self._fake()
        updater._busy.acquire()
        self.assertEqual(updater.update("2.2.0", "2.1.1"), (False, "an update is already running"))
        self.assertEqual(self.installs, [])

    def test_a_source_run_has_no_button(self):
        self.assertNotEqual(updater.install_kind(), "button")  # the tests run the engine from src/


class TestRoutes(unittest.TestCase):
    def test_update_check_says_how_this_install_updates(self):
        env = cloud_env()
        env["ATLAS_UPDATE_CHECK"] = "0"
        with AtlasServer(extra_env=env) as srv:
            seed_admin_and_viewer(file_store_of(srv))
            cookie = session_cookie(srv, ADMIN_EMAIL, ADMIN_PASSWORD)
            body = srv.get("/api/admin/update-check", headers={"Cookie": cookie}).json()
            self.assertIn(body["install"], ("container", "source", "manual"))
            self.assertTrue(body["disabled"])

    def test_update_is_refused_where_a_click_cannot_install(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            seed_admin_and_viewer(file_store_of(srv))
            cookie = session_cookie(srv, ADMIN_EMAIL, ADMIN_PASSWORD)
            headers = {"Cookie": cookie, "X-CSRF-Token": csrf_token_for(srv, cookie)}
            r = srv.post("/api/admin/update", headers=headers, json_body={})
            self.assertEqual(r.status, 409, r.body)  # a source run updates its own way


if __name__ == "__main__":
    unittest.main()
