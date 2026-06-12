"""Dependency vendoring: Atlas must work 100% without the Internet.

Scope: no resource is loaded from a CDN or Google Fonts anymore — neither by
dist/index.html (online viewer), nor by the /login page, nor by
index-offline.html (file:// monolith, /vendor/ assets inlined). The libs
(marked, DOMPurify, highlight.js, MiniSearch, pako) and the fonts live in
web/vendor/, served by the server under /vendor/ with the right content-types,
without auth (the login page depends on it) and without traversal. The
dangerous "DOMPurify absent → raw HTML" fallback in renderMd is removed.
"""
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import AtlasServer  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER = REPO_ROOT / "web" / "viewer.html"
SERVER_PY = REPO_ROOT / "src" / "server.py"
SW_JS = REPO_ROOT / "web" / "sw.js"

# External load reference: a src/href attribute, CSS url() or import that points
# to http(s)://… "Doc anchor" URLs (comments, links in help strings, SVG xmlns)
# trigger NO network request and are therefore out of scope.
_EXTERNAL_LOAD_RE = re.compile(
    r"""(?:src|href)\s*=\s*["']https?://"""
    r"""|url\(\s*["']?https?://"""
    r"""|@import\s+["']https?://""", re.I)

# Hosts of the old CDNs: must no longer appear AT ALL in the pages served
# online (dist/index.html references /vendor/, nothing is inlined).
_CDN_HOSTS = ("cdn.tailwindcss.com", "cdn.jsdelivr.net",
              "cdnjs.cloudflare.com", "fonts.googleapis.com",
              "fonts.gstatic.com")

CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "vendoring-test-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",  # bypasses the git clone at boot
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}


class TestVendoringOnline(unittest.TestCase):
    """Online viewer (local mode): everything comes from /vendor/."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_dist_index_loads_nothing_external(self):
        text = self.srv.get("/").text
        self.assertIsNone(_EXTERNAL_LOAD_RE.search(text),
                          "dist/index.html still loads an external resource")
        for host in _CDN_HOSTS:
            self.assertNotIn(host, text)

    def test_dist_index_references_vendor_assets(self):
        text = self.srv.get("/").text
        for ref in ('href="/vendor/tailwind.css"', 'href="/vendor/fonts.css"',
                    'src="/vendor/marked.min.js"', 'src="/vendor/purify.min.js"',
                    'href="/vendor/highlight-github-dark.min.css"',
                    'src="/vendor/highlight.min.js"',
                    "'/vendor/minisearch.min.js'"):
            self.assertIn(ref, text)

    def test_vendor_assets_served_with_content_types(self):
        cases = {
            "/vendor/tailwind.css": "text/css",
            "/vendor/fonts.css": "text/css",
            "/vendor/highlight-github-dark.min.css": "text/css",
            "/vendor/marked.min.js": "text/javascript",
            "/vendor/purify.min.js": "text/javascript",
            "/vendor/highlight.min.js": "text/javascript",
            "/vendor/minisearch.min.js": "text/javascript",
            "/vendor/pako.min.js": "text/javascript",
            "/vendor/fonts/manrope-latin.woff2": "font/woff2",
            "/vendor/fonts/rubik-80s-fade-latin.woff2": "font/woff2",
        }
        for path, expected_type in cases.items():
            resp = self.srv.get(path)
            self.assertEqual(resp.status, 200, path)
            self.assertTrue(len(resp.body) > 0, path)
            content_type = resp.headers.get("Content-Type", "")
            self.assertTrue(content_type.startswith(expected_type),
                            f"{path}: {content_type!r}")

    def test_vendor_traversal_is_blocked(self):
        for path in ("/vendor/../src/server.py",
                     "/vendor/%2e%2e/src/server.py",
                     "/vendor/..%2f..%2fsrc%2fserver.py"):
            resp = self.srv.get(path)
            self.assertNotEqual(resp.status, 200, path)
            self.assertNotIn(b"SimpleHTTPRequestHandler", resp.body, path)

    def test_vendor_directory_listing_refused(self):
        # /vendor/fonts/ (trailing slash) resolved to a real directory and
        # SimpleHTTPRequestHandler rendered an HTML autoindex of the fonts.
        # Only files are served under /vendor/ → 404.
        for path in ("/vendor/", "/vendor/fonts/", "/vendor/fonts"):
            resp = self.srv.get(path)
            self.assertEqual(resp.status, 404, path)
            self.assertNotIn(b"Directory listing", resp.body, path)

    def test_offline_build_is_self_contained(self):
        result = subprocess.run(
            [sys.executable, str(self.srv.root / "src" / "build.py"),
             "--offline"],
            cwd=str(self.srv.root), capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.srv.dist_dir / "index-offline.html").read_text(
            encoding="utf-8")
        # No resource loaded over http(s), and no remaining /vendor/ reference
        # in the markup: everything is inlined.
        self.assertIsNone(_EXTERNAL_LOAD_RE.search(text))
        self.assertNotIn('src="/vendor/', text)
        self.assertNotIn('href="/vendor/', text)
        # The libs are indeed in there (markers placed by inline_vendor_assets),
        # MiniSearch included (offline search without network).
        for marker in ("vendor: tailwind.css", "vendor: fonts.css",
                       "vendor: marked.min.js", "vendor: purify.min.js",
                       "vendor: highlight.min.js",
                       "vendor: highlight-github-dark.min.css",
                       "vendor: minisearch.min.js"):
            self.assertIn(marker, text)
        # The @font-face fonts are data: URIs (file:// without network).
        self.assertIn("url(data:font/woff2;base64,", text)
        self.assertNotIn("url(/vendor/fonts/", text)
        # The icon <link>s too: href="/icon.svg" would resolve to
        # file:///icon.svg (2 ERR_FILE_NOT_FOUND console errors).
        self.assertNotIn('href="/icon.svg"', text)
        self.assertIn('href="data:image/svg+xml;base64,', text)
        # Integrity: each inlined lib is BYTE-IDENTICAL to the vendored file
        # (a real regression: a late replace of </head> injected MiniSearch
        # in the middle of a DOMPurify string and broke its parsing).
        vendor = self.srv.root / "web" / "vendor"
        for name in ("marked.min.js", "purify.min.js", "highlight.min.js",
                     "minisearch.min.js"):
            match = re.search(
                r"<script>/\* vendor: " + re.escape(name) + r" \*/\n(.*?)</script>",
                text, re.S)
            self.assertIsNotNone(match, name)
            expected = (vendor / name).read_text(encoding="utf-8")
            self.assertEqual(match.group(1), expected,
                             f"{name} inlined != vendored file")


class TestVendoringLoginPage(unittest.TestCase):
    """/login page (cloud mode): local fonts, /vendor/ reachable without session."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=CLOUD_ENV)
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_login_page_loads_nothing_external(self):
        resp = self.srv.get("/login")
        self.assertEqual(resp.status, 200)
        self.assertIsNone(_EXTERNAL_LOAD_RE.search(resp.text),
                          "the /login page still loads an external resource")
        for host in _CDN_HOSTS:
            self.assertNotIn(host, resp.text)
        self.assertIn('href="/vendor/fonts.css"', resp.text)

    def test_vendor_assets_are_public(self):
        # Without a session: the login page needs the fonts BEFORE auth.
        for path in ("/vendor/fonts.css", "/vendor/fonts/manrope-latin.woff2"):
            resp = self.srv.get(path)
            self.assertEqual(resp.status, 200, path)


class TestVendoringSources(unittest.TestCase):
    """Source invariants (no server)."""

    def test_viewer_has_no_external_load(self):
        text = VIEWER.read_text(encoding="utf-8")
        self.assertIsNone(_EXTERNAL_LOAD_RE.search(text))
        for host in _CDN_HOSTS:
            self.assertNotIn(host, text)

    def test_server_pages_have_no_cdn_hosts(self):
        # LOGIN_HTML / SHARE_HTML / SHARE_ERROR_HTML: libs and fonts in /vendor/.
        text = SERVER_PY.read_text(encoding="utf-8")
        for host in _CDN_HOSTS:
            self.assertNotIn(host, text)

    def test_dompurify_fallback_removed(self):
        text = VIEWER.read_text(encoding="utf-8")
        # The "DOMPurify absent → raw HTML" fallback pattern no longer exists:
        # no ternary returns the un-sanitized output of marked anymore.
        self.assertNotIn("DOMPurify.sanitize(raw) : raw", text)
        self.assertNotIn(
            "(typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize", text)
        # renderMd always sanitizes, and blocks rendering if the lib is missing.
        self.assertIn("return DOMPurify.sanitize(marked.parse(md || ''));", text)
        self.assertIn("rendu bloqué", text)

    def test_sw_precaches_vendor_and_bumped_version(self):
        text = SW_JS.read_text(encoding="utf-8")
        self.assertNotIn("atlas-cache-v1", text)
        self.assertIn("atlas-cache-v2", text)
        for asset in ("/vendor/tailwind.css", "/vendor/fonts.css",
                      "/vendor/marked.min.js", "/vendor/purify.min.js",
                      "/vendor/highlight.min.js", "/vendor/minisearch.min.js",
                      "/vendor/fonts/manrope-latin.woff2"):
            self.assertIn(f"'{asset}'", text)

    def test_marked_dead_highlight_option_removed(self):
        # marked ≥ v5 REMOVED the `highlight` option from setOptions (silently
        # ignored by the vendored marked v15 → monochrome code blocks).
        # Colorization goes through a custom `code` renderer that calls
        # hljs — in the viewer AND the share page (SHARE_HTML).
        for path in (VIEWER, SERVER_PY):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("highlight: (code, lang)", text, path.name)
            self.assertIn('code class="hljs', text, path.name)
            self.assertIn("hljs.highlightAuto", text, path.name)

    def test_vendor_licenses_are_preserved(self):
        vendor = REPO_ROOT / "web" / "vendor"
        # OFL: the license must travel with the .woff2 files (per-family notices).
        ofl = (vendor / "fonts" / "OFL.txt").read_text(encoding="utf-8")
        self.assertIn("SIL OPEN FONT LICENSE Version 1.1", ofl)
        for family in ("Corinthia", "Rubik", "Manrope", "Lora",
                       "JetBrains Mono"):
            self.assertIn(family, ofl)
        # Inventory of lib + version + license.
        licenses = (vendor / "LICENSES.md").read_text(encoding="utf-8")
        for lib in ("marked", "DOMPurify", "highlight.js", "MiniSearch",
                    "pako", "mammoth", "Tailwind"):
            self.assertIn(lib, licenses)
        # mammoth ships no banner → its BSD-2-Clause text must be reproduced here.
        self.assertIn("BSD-2-Clause", licenses)
        # MiniSearch: jsDelivr does not preserve the MIT banner — restored.
        first_line = (vendor / "minisearch.min.js").read_text(
            encoding="utf-8").splitlines()[0]
        self.assertIn("Luca Ongaro", first_line)
        self.assertIn("MIT", first_line)

    def test_vendor_files_exist_and_are_non_trivial(self):
        vendor = REPO_ROOT / "web" / "vendor"
        for name, minimum_size in {
            "tailwind.css": 20_000, "fonts.css": 2_000,
            "marked.min.js": 10_000, "purify.min.js": 10_000,
            "highlight.min.js": 50_000, "highlight-github-dark.min.css": 500,
            "minisearch.min.js": 10_000, "pako.min.js": 20_000,
            "mammoth.min.js": 100_000,
        }.items():
            path = vendor / name
            self.assertTrue(path.is_file(), name)
            self.assertGreater(path.stat().st_size, minimum_size, name)
        woff2_files = list((vendor / "fonts").glob("*.woff2"))
        self.assertGreaterEqual(len(woff2_files), 14)


if __name__ == "__main__":
    unittest.main()
