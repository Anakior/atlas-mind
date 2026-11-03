"""First admin without a shell: the server holds only the SHA-256 of a setup code
(ATLAS_SETUP_CODE_SHA256) and /api/setup accepts that code; the /setup page takes it
from the link's #code= fragment. The printed boot token keeps working."""
import hashlib
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import cli  # noqa: E402
from harness import AtlasServer  # noqa: E402
from config import AtlasConfig, AtlasConfigError  # noqa: E402
from test_admin import cloud_env, wait_for_setup_token  # noqa: E402

CODE, DIGEST = cli.new_setup_code()


class TestSetupCode(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env={**cloud_env(), "ATLAS_SETUP_CODE_SHA256": DIGEST})
        self.srv.start()

    def tearDown(self):
        self.srv.stop()

    def _setup(self, code):
        return self.srv.post("/api/setup", json_body={
            "setup_token": code, "email": "sophie@example.com",
            "password": "a-long-password", "first_name": "Sophie", "last_name": ""})

    def test_the_link_code_creates_the_first_admin_once(self):
        self.assertEqual(self._setup("not-the-code").status, 403)
        self.assertEqual(self._setup(CODE).status, 200)
        self.assertEqual(self._setup(CODE).status, 409)  # an admin exists: the window is closed

    def test_the_boot_token_still_works(self):
        self.assertEqual(self._setup(wait_for_setup_token(self.srv)).status, 200)

    def test_the_page_reads_the_code_from_the_fragment(self):
        page = self.srv.get("/setup").body.decode("utf-8")
        self.assertIn("get('code')", page)
        self.assertIn('id="token-field"', page)


class TestSetupCodeHelpers(unittest.TestCase):
    def test_code_and_digest_match(self):
        code, digest = cli.new_setup_code()
        self.assertEqual(hashlib.sha256(code.encode()).hexdigest(), digest)
        self.assertRegex(code, r"^[A-Za-z0-9_-]{20,}$")  # safe in a URL fragment

    def test_link_puts_the_code_in_the_fragment(self):
        self.assertEqual(cli.setup_link("https://a.fly.dev/", "abc"),
                         "https://a.fly.dev/setup#code=abc")

    def test_config_rejects_a_malformed_digest(self):
        with self.assertRaises(AtlasConfigError):
            AtlasConfig(Path("."), env={"ATLAS_SETUP_CODE_SHA256": "not-a-sha"})
        cfg = AtlasConfig(Path("."), env={"ATLAS_SETUP_CODE_SHA256": DIGEST.upper()})
        self.assertEqual(cfg.setup_code_sha256, DIGEST)


if __name__ == "__main__":
    unittest.main()
