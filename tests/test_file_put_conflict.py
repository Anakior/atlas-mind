"""PUT /api/file with base_content: the editor's save is refused (409, with the current
text) when the doc changed since it was opened — an AI edit must never be overwritten
silently. Without base_content (checkbox toggles, older clients) nothing changes."""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, cloud_env, csrf_token_for, file_store_of,
    seed_admin_and_viewer, session_cookie)

DOC = "notes/shared.md"


class TestFilePutConflict(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        seed_admin_and_viewer(file_store_of(cls.srv))
        cls.cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.csrf = csrf_token_for(cls.srv, cls.cookie)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _put(self, body):
        return self.srv.request("PUT", "/api/file", json_body=body,
                                headers={"Cookie": self.cookie, "X-CSRF-Token": self.csrf})

    def _on_disk(self):
        return (self.srv.content_root / DOC).read_text(encoding="utf-8")

    def _seed(self, text):
        path = self.srv.content_root / DOC
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))

    def test_stale_base_is_refused_with_the_current_text(self):
        self._seed("# Shared\n\nClaude wrote this.\n")
        resp = self._put({"path": DOC, "content": "# Shared\n\nMine.\n",
                          "base_content": "# Shared\n"})
        self.assertEqual(resp.status, 409)
        self.assertEqual(resp.json()["current"], "# Shared\n\nClaude wrote this.\n")
        self.assertIn("Claude wrote this", self._on_disk())  # untouched

    def test_matching_base_saves(self):
        self._seed("# Shared\n\nv1\n")
        resp = self._put({"path": DOC, "content": "# Shared\n\nv2\n",
                          "base_content": "# Shared\n\nv1\n"})
        self.assertEqual(resp.status, 200)
        self.assertIn("v2", self._on_disk())

    def test_crlf_base_matches_its_lf_file(self):
        self._seed("# Shared\r\n\r\nwindows\r\n")
        resp = self._put({"path": DOC, "content": "# Shared\n\nsaved\n",
                          "base_content": "# Shared\r\n\r\nwindows\r\n"})
        self.assertEqual(resp.status, 200)

    def test_without_base_nothing_changes(self):
        self._seed("# Shared\n\nanything\n")
        resp = self._put({"path": DOC, "content": "# Shared\n\noverwritten\n"})
        self.assertEqual(resp.status, 200)
        self.assertIn("overwritten", self._on_disk())

    def test_base_is_ignored_on_creation(self):
        resp = self._put({"path": "notes/brand-new.md", "content": "# New\n",
                          "base_content": "stale"})
        self.assertEqual(resp.status, 200)


if __name__ == "__main__":
    unittest.main()
