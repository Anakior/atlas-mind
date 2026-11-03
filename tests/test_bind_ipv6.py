"""AtlasHTTPServer picks its socket family from the bind host: an IPv6 address
(what alwaysdata hands out) must not fail with the default AF_INET."""
import socket
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from server.context import AtlasHTTPServer  # noqa: E402


class _Ok(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


class TestBindFamily(unittest.TestCase):
    def _serve(self, host):
        server = AtlasHTTPServer((host, 0), None, _Ok)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return server

    def test_ipv4_bind_stays_inet(self):
        server = self._serve("127.0.0.1")
        self.assertEqual(server.address_family, socket.AF_INET)

    def test_ipv6_bind_uses_inet6_and_serves(self):
        if not socket.has_ipv6:
            self.skipTest("no IPv6 support on this machine")
        try:
            server = self._serve("::1")
        except OSError as e:
            self.skipTest(f"IPv6 loopback unavailable: {e}")
        self.assertEqual(server.address_family, socket.AF_INET6)
        port = server.server_address[1]
        with urllib.request.urlopen(f"http://[::1]:{port}/", timeout=5) as resp:
            self.assertEqual(resp.read(), b"ok")


if __name__ == "__main__":
    unittest.main()
