"""Online, a request a proxy says came in over plain http (X-Forwarded-Proto: http, as from a
link in alwaysdata's admin) is sent to https: Atlas's cookies are Secure, so a sign-in over http
would loop on the login page. Never on loopback, nor when nothing says it came in clear."""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from test_admin import cloud_env  # noqa: E402

HOST = "atlas.example.org"


class TestHttpsRedirect(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def get(self, path, **headers):
        return self.srv.get(path, headers={"Host": HOST, **headers})

    def test_plain_http_goes_to_https(self):
        resp = self.get("/login?next=%2Fnotes", **{"X-Forwarded-Proto": "http"})
        self.assertEqual(resp.status, 308)
        self.assertEqual(resp.headers["Location"], f"https://{HOST}/login?next=%2Fnotes")
        post = self.srv.post("/login", data=b"", headers={"Host": HOST, "X-Forwarded-Proto": "http"})
        self.assertEqual(post.status, 308)  # the method and its body go along

    def test_left_alone(self):
        self.assertEqual(self.get("/login", **{"X-Forwarded-Proto": "https"}).status, 200)
        self.assertEqual(self.get("/login").status, 200)  # no proxy said anything
        loopback = self.srv.get("/login", headers={"X-Forwarded-Proto": "http"})
        self.assertEqual(loopback.status, 200)


class TestHttpsRedirectToThePublicAddress(unittest.TestCase):
    def test_public_url_and_base_path(self):
        env = {**cloud_env(), "ATLAS_PUBLIC_URL": "https://notes.example.org", "ATLAS_BASE_PATH": "/atlas/"}
        with AtlasServer(extra_env=env) as srv:
            resp = srv.get("/atlas/login", headers={"Host": "10.0.0.5:8100", "X-Forwarded-Proto": "http"})
            self.assertEqual(resp.status, 308)
            self.assertEqual(resp.headers["Location"], "https://notes.example.org/atlas/login")


if __name__ == "__main__":
    unittest.main()
