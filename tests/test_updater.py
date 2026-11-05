"""Settings › About › Update (server/services/updater.py): the release is installed in place and
checked before the restart, a failed one puts the running release back (or says it could not),
and an install that is not a PyPI virtualenv never gets the button."""
import contextlib
import io
import json
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

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
        updater.needs_repair = None
        if updater._busy.locked():
            updater._busy.release()

    def _fake(self, *, fails=(), reports=None):
        """pip fails on the versions in `fails`; `reports` maps the version pip installed
        last to what a fresh interpreter then finds ("" = it does not import)."""
        reports = reports or {}

        def pip(version):
            self.installs.append(version)
            ok = version not in fails
            return subprocess.CompletedProcess([], 0 if ok else 1, "", "" if ok else "ERROR: no such version")
        updater._pip_install = pip
        updater._installed_version = lambda: reports.get(self.installs[-1], self.installs[-1])

    def test_installed_and_checked(self):
        self._fake()
        self.assertEqual(updater.update("2.2.0", "2.1.1"), (True, ""))
        self.assertEqual(self.installs, ["2.2.0"])

    def test_a_failed_install_puts_the_running_release_back(self):
        self._fake(fails={"2.2.0"})
        with contextlib.redirect_stderr(io.StringIO()) as log:
            ok, why = updater.update("2.2.0", "2.1.1")
        self.assertFalse(ok)
        self.assertIn("no such version", why)
        self.assertEqual(self.installs, ["2.2.0", "2.1.1"])
        self.assertIn("back on 2.1.1", log.getvalue())
        self.assertIsNone(updater.needs_repair)

    def test_a_release_that_does_not_start_is_undone(self):
        self._fake(reports={"2.2.0": ""})  # the fresh interpreter could not import it
        with contextlib.redirect_stderr(io.StringIO()):
            ok, _ = updater.update("2.2.0", "2.1.1")
        self.assertFalse(ok)
        self.assertEqual(self.installs, ["2.2.0", "2.1.1"])
        self.assertFalse(updater._busy.locked())  # another try stays possible

    def test_a_failed_rollback_asks_for_a_manual_repair(self):
        self._fake(fails={"2.2.0", "2.1.1"})
        with contextlib.redirect_stderr(io.StringIO()) as log:
            ok, why = updater.update("2.2.0", "2.1.1")
        self.assertFalse(ok)
        self.assertIn("manual repair", why)
        self.assertIn("atlas-mind==2.1.1", why)
        self.assertNotIn("back on", log.getvalue())
        self.assertIn("manual repair", log.getvalue())
        self.assertIn("atlas-mind==2.1.1", updater.needs_repair)
        self.assertFalse(updater._busy.locked())

    def test_a_rollback_that_does_not_start_asks_for_a_manual_repair(self):
        # pip said yes both times, yet neither release imports: no silent half-state.
        self._fake(reports={"2.2.0": "", "2.1.1": ""})
        with contextlib.redirect_stderr(io.StringIO()):
            ok, why = updater.update("2.2.0", "2.1.1")
        self.assertFalse(ok)
        self.assertIn("manual repair", why)
        self.assertIsNotNone(updater.needs_repair)

    def test_a_good_update_clears_an_earlier_repair(self):
        self._fake()
        updater.needs_repair = "pip install atlas-mind==2.1.1"
        self.assertEqual(updater.update("2.2.0", "2.1.1"), (True, ""))
        self.assertIsNone(updater.needs_repair)

    def test_one_update_at_a_time(self):
        self._fake()
        updater._busy.acquire()
        self.assertEqual(updater.update("2.2.0", "2.1.1"), (False, "an update is already running"))
        self.assertEqual(self.installs, [])

    def test_a_source_run_has_no_button(self):
        self.assertNotEqual(updater.install_kind(), "button")  # the tests run the engine from src/


class TestRestart(unittest.TestCase):
    """Once the new release is in: flush what is pending, then re-execute the same command."""

    def _restart(self, flush):
        steps, execd = [], threading.Event()

        def recorded_flush():
            steps.append(("flush",))
            flush()

        def execv(path, argv):
            steps.append(("exec", path, argv))
            execd.set()

        with mock.patch.object(updater.os, "execv", execv):
            updater.restart(recorded_flush)
            self.assertTrue(execd.wait(10), "the restart never re-executed")
        return steps

    def test_flushes_then_reexecutes_the_same_command(self):
        steps = self._restart(lambda: None)
        self.assertEqual(steps, [("flush",),
                                 ("exec", sys.executable, [sys.executable, *sys.orig_argv[1:]])])

    def test_a_failed_flush_still_restarts(self):
        def flush():
            raise RuntimeError("remote down")

        with contextlib.redirect_stderr(io.StringIO()) as log:
            steps = self._restart(flush)
        self.assertEqual([step[0] for step in steps], ["flush", "exec"])
        self.assertIn("flush before restart failed: remote down", log.getvalue())


class TestUpdateCheckCache(unittest.TestCase):
    """The About tab asks for a recent answer; the gear's check keeps the day's."""

    def setUp(self):
        from server.services import update_check
        self.mod = update_check
        self.real = update_check.urllib.request.urlopen
        self.calls = 0
        self.answers = []

        def fake(url, timeout=None):
            self.calls += 1
            answer = self.answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return io.BytesIO(json.dumps({"info": {"version": answer}}).encode())

        update_check.urllib.request.urlopen = fake

    def tearDown(self):
        self.mod.urllib.request.urlopen = self.real

    def test_a_recent_answer_when_asked(self):
        self.answers = ["2.2.0", "2.3.0"]
        checker = self.mod.UpdateChecker()
        self.assertEqual(checker.latest(), "2.2.0")
        self.assertEqual(checker.latest(), "2.2.0")  # the day's cache
        self.assertEqual(checker.latest(max_age=0), "2.3.0")
        self.assertEqual(self.calls, 2)

    def test_a_failed_lookup_keeps_the_last_version_and_waits(self):
        self.answers = ["2.2.0", OSError("offline")]
        checker = self.mod.UpdateChecker()
        checker.latest()
        self.assertEqual(checker.latest(max_age=0), "2.2.0")
        self.assertEqual(checker.latest(max_age=0), "2.2.0")  # no new lookup within the minute
        self.assertEqual(self.calls, 2)


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
