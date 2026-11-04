"""Atlas under a base path (server.base_path / ATLAS_BASE_PATH), whatever its depth: a request
arriving with it has it taken off (and one a proxy already took it off still works), and every URL
Atlas makes carries it — redirects, cookies, OAuth and MCP addresses, pages, the manifest."""
import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import ADMIN_EMAIL, ADMIN_PASSWORD, cloud_env, file_store_of, seed_admin_and_viewer  # noqa: E402

BASE = "/outils/atlas"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class TestBasePath(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env={**cloud_env(), "ATLAS_BASE_PATH": BASE + "/"})
        cls.srv.start()
        seed_admin_and_viewer(file_store_of(cls.srv))
        cls.opener = urllib.request.build_opener(_NoRedirect)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _req(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.srv.base_url + path, data=data, method="POST" if data else "GET",
                                     headers={"Content-Type": "application/json"} if data else {})
        try:
            with self.opener.open(req, timeout=10) as r:
                return r.status, r.headers, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read().decode("utf-8", "replace")

    def test_oauth_and_mcp_addresses_carry_it(self):
        _, _, body = self._req(BASE + "/.well-known/oauth-protected-resource/mcp")
        self.assertTrue(json.loads(body)["resource"].endswith(BASE + "/mcp"))
        _, _, body = self._req(BASE + "/.well-known/openid-configuration")
        meta = json.loads(body)
        self.assertTrue(meta["issuer"].endswith(BASE))
        self.assertTrue(meta["token_endpoint"].endswith(BASE + "/oauth/token"))
        status, headers, _ = self._req(BASE + "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual(status, 401)
        self.assertIn(BASE + "/.well-known/oauth-protected-resource", headers["WWW-Authenticate"])

    def test_redirects_and_cookies_carry_it(self):
        status, headers, _ = self._req(BASE)
        self.assertEqual((status, headers["Location"]), (308, BASE + "/"))
        status, headers, _ = self._req(BASE + "/")
        self.assertEqual((status, headers["Location"]), (303, BASE + "/login"))
        status, headers, _ = self._req(BASE + "/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        cookies = headers.get_all("Set-Cookie")
        self.assertTrue(cookies and all(f"Path={BASE};" in c for c in cookies), cookies)

    def test_pages_and_manifest_carry_it(self):
        _, _, page = self._req(BASE + "/login")
        self.assertIn(f'action="{BASE}/login"', page)
        self.assertNotIn("__BASE__", page)
        _, _, manifest = self._req(BASE + "/manifest.json")
        self.assertEqual(json.loads(manifest)["start_url"], BASE + "/")

    def test_a_path_a_proxy_already_trimmed_still_works(self):
        status, _, body = self._req("/.well-known/openid-configuration")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["issuer"].endswith(BASE))


if __name__ == "__main__":
    unittest.main()
