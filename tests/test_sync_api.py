"""GET/POST /api/sync and the MCP sync warning: a commit git refuses shows up in the
viewer's health endpoint and in the tools the agent reads first, instead of
vanishing on stderr. Cloud mode, mind without a remote."""
import json
import sys
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env,
    csrf_token_for, file_store_of, seed_admin_and_viewer, session_cookie)


class TestSyncApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        fs = file_store_of(cls.srv)
        seed_admin_and_viewer(fs)
        _, cls.token = fs.create_api_identity("sync-bot")
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin_csrf = csrf_token_for(cls.srv, cls.admin_cookie)
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _admin(self):
        return {"Cookie": self.admin_cookie, "X-CSRF-Token": self.admin_csrf}

    def _health(self, cookie):
        resp = self.srv.get("/api/sync", headers={"Cookie": cookie})
        self.assertEqual(resp.status, 200)
        return resp.json()

    def _write(self, path, text):
        resp = self.srv.request("PUT", "/api/file", headers=self._admin(),
                                json_body={"path": path, "content": text})
        self.assertEqual(resp.status, 200)

    def _wait_status(self, status, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            health = self._health(self.admin_cookie)
            if health["status"] == status:
                return health
            time.sleep(0.1)
        self.fail(f"sync status never became {status!r}: {health}")

    def _list_tree(self):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "list_tree", "arguments": {}}}
        resp = self.srv.post(f"/mcp/{self.token}", json_body=body)
        return json.loads(resp.json()["result"]["content"][0]["text"])

    def test_requires_a_session(self):
        self.assertEqual(self.srv.get("/api/sync").status, 401)

    def test_commit_failure_is_reported_then_cleared(self):
        self.assertEqual(self._health(self.admin_cookie)["status"], "local")  # no remote
        self.assertNotIn("warning", self._list_tree())

        lock = self.srv.root / ".git" / "index.lock"
        lock.write_text("", encoding="utf-8")  # git now refuses every commit
        try:
            self._write("notes/blocked.md", "# Blocked\n")
            health = self._wait_status("error")
            self.assertEqual(health["error"]["op"], "commit")
            self.assertTrue(health["error"]["message"])
            viewer = self._health(self.viewer_cookie)
            self.assertEqual(viewer["status"], "error")
            self.assertNotIn("message", viewer["error"])  # git's words stay with admins
            self.assertIn("could not record", self._list_tree()["warning"])
        finally:
            lock.unlink()

        self._write("notes/unblocked.md", "# Unblocked\n")
        self._wait_status("local")
        self.assertNotIn("warning", self._list_tree())

    def test_retry_is_accepted(self):
        resp = self.srv.post("/api/sync", headers=self._admin(), json_body={})
        self.assertEqual(resp.status, 202)


if __name__ == "__main__":
    unittest.main()
