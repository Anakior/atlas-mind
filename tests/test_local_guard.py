"""Local mode has no login: it answers to loopback names and IP literals only (DNS
rebinding needs a domain), and its writes keep the base CSRF checks (JSON body,
same origin). public_url replaces the request Host when a proxy rewrites it."""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from config import AtlasConfig, AtlasConfigError  # noqa: E402
from test_admin import cloud_env  # noqa: E402


class TestLocalHostGuard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _status(self, host):
        return self.srv.get("/", headers={"Host": host}).status

    def test_loopback_names_and_ip_literals_pass(self):
        port = self.srv.port
        for host in (f"localhost:{port}", f"127.0.0.1:{port}", f"[::1]:{port}",
                     f"192.168.1.20:{port}", f"atlas.localhost:{port}"):
            self.assertEqual(self._status(host), 200, host)

    def test_a_domain_name_is_refused(self):
        self.assertEqual(self._status(f"evil.example:{self.srv.port}"), 421)
        self.assertEqual(self.srv.get("/healthz", headers={"Host": "evil.example"}).status, 421)

    def _put(self, headers, **kw):
        return self.srv.request("PUT", "/api/file", headers=headers, **kw)

    def test_writes_need_json_and_the_same_origin(self):
        body = {"path": "notes/guard.md", "content": "# Guard\n"}
        origin = f"http://127.0.0.1:{self.srv.port}"
        self.assertEqual(self._put({"Content-Type": "text/plain"},
                                   data=b'{"path": "notes/guard.md", "content": "x"}').status, 415)
        self.assertEqual(self._put({"Origin": "http://evil.example"}, json_body=body).status, 403)
        self.assertEqual(self._put({"Origin": origin}, json_body=body).status, 200)


class TestPublicUrl(unittest.TestCase):
    def test_public_url_drives_the_oauth_metadata(self):
        env = {**cloud_env(), "ATLAS_PUBLIC_URL": "https://atlas.example.com/"}
        with AtlasServer(extra_env=env) as srv:
            meta = srv.get("/.well-known/oauth-authorization-server").json()
        self.assertEqual(meta["issuer"], "https://atlas.example.com")

    def test_public_url_must_be_scheme_and_host(self):
        for bad in ("atlas.example.com", "https://atlas.example.com/sub", "ftp://x"):
            with self.assertRaises(AtlasConfigError, msg=bad):
                AtlasConfig(Path("."), env={"ATLAS_PUBLIC_URL": bad})


if __name__ == "__main__":
    unittest.main()
