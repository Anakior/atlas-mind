"""The home's "connect your AI" step: an assistant that connects (initialize, tools/list) is
connected, not done; the step is done on the first read_doc that returned a doc, never on a
refused one, and it names that doc. Run: python tests/test_first_read.py"""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, cloud_env, file_store_of, seed_admin_and_viewer, session_cookie)


class TestFirstRead(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env(), mind={"projets/atlas.md": "# Atlas\n"})
        cls.srv.start()
        fs = file_store_of(cls.srv)
        seed_admin_and_viewer(fs)
        cls.token = fs.create_api_identity("Claude", acts_as=ADMIN_EMAIL)[1]
        cls.cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def rpc(self, method, params=None):
        resp = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
        self.assertEqual(resp.status, 200)

    def access(self):
        tokens = self.srv.get("/api/tokens", headers={"Cookie": self.cookie}).json()
        return next(t for t in tokens if t["label"] == "Claude")

    def test_a_connection_then_a_read(self):
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "test", "version": "1"}})
        self.rpc("tools/list")
        self.assertTrue(self.access().get("last_used_at"))
        self.assertNotIn("last_read", self.access())

        self.rpc("tools/call", {"name": "read_doc", "arguments": {"path": "projets/absent.md"}})
        self.assertNotIn("last_read", self.access())

        self.rpc("tools/call", {"name": "read_doc", "arguments": {"path": "projets/atlas.md"}})
        self.assertEqual(self.access()["last_read"]["path"], "projets/atlas.md")


if __name__ == "__main__":
    unittest.main()
