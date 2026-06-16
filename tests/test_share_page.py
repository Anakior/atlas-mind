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

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer, DEFAULT_MIND


class TestSharePageScript(unittest.TestCase):
    """projets/beta.md is part of the harness DEFAULT_MIND; frontmatter.md adds a
    doc with leading YAML frontmatter. Local mode: the link is created via POST
    /api/share (registry-backed) and served at /s/<token>."""

    _MIND = {**DEFAULT_MIND,
             "frontmatter.md": "---\ntags: [foo, bar]\nstatus: draft\n---\n\n"
                               "# Real Heading\n\nBody paragraph.\n"}

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=cls._MIND)
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _share_token(self, path: str) -> str:
        resp = self.srv.post("/api/share", json_body={"path": path})
        self.assertEqual(resp.status, 200, resp.text[:300])
        return resp.json()["token"]

    def _render_script(self) -> str:
        resp = self.srv.get(f"/s/{self._share_token('projets/beta.md')}")
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

    def test_frontmatter_stripped_from_body(self):
        # The leading YAML frontmatter must not reach the embedded body, or marked
        # renders the `tags: …` line followed by its closing `---` as a setext H2
        # that leaks into the page AND the table of contents. The viewer build
        # strips it the same way (build/__init__.py).
        resp = self.srv.get(f"/s/{self._share_token('frontmatter.md')}")
        self.assertEqual(resp.status, 200, resp.text[:300])
        self.assertNotIn("tags: [foo, bar]", resp.text)
        self.assertNotIn("status: draft", resp.text)
        self.assertIn("Real Heading", resp.text)  # the real body still renders

    @unittest.skipUnless(shutil.which("node"), "node not available")
    def test_render_script_parses(self):
        # node --check parses the script; an invalid regex literal is a parse-time
        # SyntaxError, exactly the failure that blanked the page.
        with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8",
                                         delete=False) as f:
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
