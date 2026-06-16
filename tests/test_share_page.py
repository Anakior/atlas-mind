"""The share page's inline render script must be valid JavaScript.

The share page (web/pages/share.html) carries its OWN marked + wikilink render
logic. A "refacto globally" extraction once DOUBLED every backslash in its regex
literals (`/\\s+/`, `/^\\[\\[…\\]\\]/`, `/[\\u0300-\\u036f]/`…), turning them into
invalid regexes → the whole <script> died at parse with `Uncaught SyntaxError:
Invalid regular expression` → marked.parse never ran → a blank share page (HTTP
200, empty <article>). The page-render tests only asserted marker strings were
present, so they stayed green through a total share outage. This guards the
script itself.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer

LOCAL_DEFAULT_SECRET = b"dev-secret-change-me"  # local mode, no SESSION_SECRET


def _forge_share_token(path: str, secret: bytes = LOCAL_DEFAULT_SECRET) -> str:
    payload = json.dumps({"p": path, "e": 0}).encode()  # e=0 → no expiry
    sig = hmac.new(secret, payload, hashlib.sha256).digest()
    enc = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
    return f"{enc(payload)}.{enc(sig)}"


class TestSharePageScript(unittest.TestCase):
    """projets/beta.md is part of the harness DEFAULT_MIND."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _render_script(self) -> str:
        resp = self.srv.get(f"/share/{_forge_share_token('projets/beta.md')}")
        self.assertEqual(resp.status, 200, resp.text[:300])
        # The first <script> after <body> is the render logic (the second is the
        # mind's extension bundle); the vendor scripts sit in <head>.
        body = resp.text.split("<body>", 1)[1]
        return body.split("<script>", 1)[1].split("</script>", 1)[0]

    def test_no_double_escaped_backslashes(self):
        # Every backslash here is a regex/string escape and must be single; a
        # doubled one (\\s, \\[, \\u…) is the over-escaping regression.
        self.assertNotIn(
            "\\\\", self._render_script(),
            "share render script is double-escaped → invalid regexes → blank page")

    @unittest.skipUnless(shutil.which("node"), "node not available")
    def test_render_script_parses(self):
        # node --check parses the script; an invalid regex literal is a parse-time
        # SyntaxError, exactly the failure that blanked the page.
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(self._render_script())
            tmp = f.name
        try:
            result = subprocess.run(["node", "--check", tmp],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            Path(tmp).unlink()


if __name__ == "__main__":
    unittest.main()
