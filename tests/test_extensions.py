"""Tests for the extension hook (spec decision: two hooks, not a plugin system).

1. Build: build.py discovers <mind>/.atlas/extensions/*.css|*.js (alphabetical
   order) and inlines them into dist/index.html via the placeholders
   __EXTENSIONS_CSS__ / __EXTENSIONS_JS__ -- offline mode included. The closing
   tag (`</script`, `</style`) is neutralized to `<\\/...` (same protection as
   the JSON placeholders) so that extension code cannot escape its inline
   container.
2. Server: at boot, server.py loads <mind>/.atlas/extensions/*.py; each module
   exposes register(context) and registers its routes via
   context.add_route(method, pattern, handler, role=...). Roles "public" /
   "auth" / "admin" (default: "auth" on GET, "admin" on POST), applied in cloud
   mode. A broken extension = stderr warning, never a crash at boot.

A mind WITHOUT extensions = strictly identical behavior: it is the rest of the
suite (which runs without .atlas/extensions/) that proves it, plus the consumed
placeholders test below.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from harness import AtlasServer
from test_cloud_filestore import (
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD,
    cloud_env, file_store_of, seed_default_users, session_cookie, auth_headers,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
REPO_SRC = REPO_ROOT / "src"

# ─── Build side: inlined CSS/JS assets ──────────────────────────────────────────

CSS_A = ".atlas-ext-aaa{color:#a1b2c3}"
CSS_Z = ".atlas-ext-zzz{color:#0f0f0f}"
JS_A = "window.__extA = 'ext-a-loaded';"
JS_Z = "window.__extZ = 'ext-z-loaded';"
TXT_MARKER = "EXT-TXT-MUST-NOT-BE-INJECTED"
PY_MARKER = "EXT-PY-MUST-NOT-BE-INJECTED"

JS_WITH_SCRIPT_CLOSE = 'console.log("</script><b>pwn</b>");'
CSS_WITH_STYLE_CLOSE = '.kb-ext-quote::after{content:"</style>"}'
CSS_WITH_HEAD_CLOSE = '.kb-ext-probe::after{content:"QQQ</head>QQQ"}'
JS_WITH_HEAD_CLOSE = 'console.log("ext </head> marker");'


def make_mind(root: Path, *, extensions: dict | None = None) -> None:
    """Minimal decoupled mind: content/ with one doc, and optional extension
    files under <mind>/.atlas/extensions/."""
    (root / "content").mkdir(parents=True)
    (root / "content" / "accueil.md").write_text("# Accueil\n", encoding="utf-8")
    for name, content in (extensions or {}).items():
        target = root / ".atlas" / "extensions" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def run_build(mind: Path, *args: str) -> subprocess.CompletedProcess:
    """The ENGINE's build.py on a decoupled mind (ATLAS_MIND)."""
    env = os.environ.copy()
    env["ATLAS_MIND"] = str(mind)
    env.pop("KB_AUTH_ENABLED", None)
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env["PYTHONPATH"] = str(REPO_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, "-m", "build", *args],
        cwd=str(mind), env=env, capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"build.py failed (exit {result.returncode}):\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}")
    return result


class TestBuildExtensionAssets(unittest.TestCase):
    """CSS/JS from .atlas/extensions/ inlined into dist/index.html (and the
    offline variant), alphabetical order, other files ignored."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="atlas-ext-build-")
        cls.addClassCleanup(cls._tmp.cleanup)
        cls.mind = Path(cls._tmp.name)
        make_mind(cls.mind, extensions={
            "a-theme.css": CSS_A,
            "z-theme.css": CSS_Z,
            "a-widget.js": JS_A,
            "z-widget.js": JS_Z,
            "notes.txt": TXT_MARKER,
            "mod_serveur.py": f"# {PY_MARKER}\n",
        })
        run_build(cls.mind)
        run_build(cls.mind, "--offline")
        cls.online = (cls.mind / "dist" / "index.html").read_text(encoding="utf-8")
        cls.offline = (cls.mind / "dist" / "index-offline.html").read_text(
            encoding="utf-8")

    def test_css_injected_in_online_build(self):
        self.assertIn(CSS_A, self.online)
        self.assertIn(CSS_Z, self.online)
        # The placeholder was indeed consumed (the CSS is in place).
        self.assertNotIn("__EXTENSIONS_CSS__", self.online)

    def test_js_injected_in_online_build(self):
        self.assertIn(JS_A, self.online)
        self.assertIn(JS_Z, self.online)
        self.assertNotIn("__EXTENSIONS_JS__", self.online)

    def test_alphabetical_order_and_other_files_ignored(self):
        # a-* before z-* (sorted discovery), for both CSS and JS.
        self.assertLess(self.online.index(CSS_A), self.online.index(CSS_Z))
        self.assertLess(self.online.index(JS_A), self.online.index(JS_Z))
        # Only .css/.js are inlined: neither the .txt nor the .py (server) leaks
        # into the HTML.
        self.assertNotIn(TXT_MARKER, self.online)
        self.assertNotIn(PY_MARKER, self.online)

    def test_offline_build_embeds_extensions_too(self):
        self.assertIn(CSS_A, self.offline)
        self.assertIn(JS_A, self.offline)
        self.assertNotIn("__EXTENSIONS_CSS__", self.offline)
        self.assertNotIn("__EXTENSIONS_JS__", self.offline)


class TestBuildExtensionEscaping(unittest.TestCase):
    """`</script` / `</style` in extension code: neutralized to `<\\/...` so they
    never close the viewer's inline container."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="atlas-ext-escape-")
        cls.addClassCleanup(cls._tmp.cleanup)
        cls.mind = Path(cls._tmp.name)
        make_mind(cls.mind, extensions={
            "evil.js": JS_WITH_SCRIPT_CLOSE,
            "evil.css": CSS_WITH_STYLE_CLOSE,
        })
        run_build(cls.mind)
        cls.html = (cls.mind / "dist" / "index.html").read_text(encoding="utf-8")

    def test_script_closing_tag_escaped_in_js(self):
        # The raw sequence from the extension file never appears...
        self.assertNotIn(JS_WITH_SCRIPT_CLOSE, self.html)
        # ...it is injected with the closing tag neutralized (identical JS
        # semantics within a string: "<\/script>" === "</script>").
        self.assertIn('console.log("<\\/script><b>pwn</b>");', self.html)

    def test_style_closing_tag_escaped_in_css(self):
        self.assertNotIn(CSS_WITH_STYLE_CLOSE, self.html)
        self.assertIn('.kb-ext-quote::after{content:"<\\/style>"}', self.html)


class TestBuildExtensionHeadEscaping(unittest.TestCase):
    """`</head` in extension code: neutralized to `<\\/head` -- a real offline
    build bug: inline_vendor_assets injects MiniSearch by replacing the FIRST
    `</head>` of the document, yet the extensions' <style> lives in the template's
    <head>. A literal `</head>` in an extension received the injection in the
    middle of the CSS: MiniSearch never ran (offline search broken) and the CSS
    rule was corrupted."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="atlas-ext-head-")
        cls.addClassCleanup(cls._tmp.cleanup)
        cls.mind = Path(cls._tmp.name)
        make_mind(cls.mind, extensions={
            "probe.css": CSS_WITH_HEAD_CLOSE,
            "probe.js": JS_WITH_HEAD_CLOSE,
        })
        run_build(cls.mind, "--offline")
        cls.offline = (cls.mind / "dist" / "index-offline.html").read_text(
            encoding="utf-8")

    def test_head_closing_tag_escaped_in_css_and_js(self):
        self.assertNotIn(CSS_WITH_HEAD_CLOSE, self.offline)
        self.assertIn('.kb-ext-probe::after{content:"QQQ<\\/head>QQQ"}',
                      self.offline)
        self.assertNotIn(JS_WITH_HEAD_CLOSE, self.offline)
        self.assertIn('console.log("ext <\\/head> marker");', self.offline)

    def test_minisearch_injected_after_extension_style_not_inside(self):
        # Exact signature of the regression: the MiniSearch <script> landed
        # inside the content:"QQQ..." string of the extension CSS.
        self.assertNotIn("QQQ<script>", self.offline)
        marker = "<script>/* vendor: minisearch.min.js */"
        self.assertIn(marker, self.offline)
        # The injection did happen at the template's `</head>`, AFTER the
        # extensions' <style>.
        self.assertLess(
            self.offline.index('.kb-ext-probe::after'),
            self.offline.index(marker))


class TestBuildWithoutExtensions(unittest.TestCase):
    """Mind without .atlas/extensions/: placeholders consumed (empty), no
    residue -- the generated viewer is identical to the historical one."""

    def test_placeholders_consumed_when_no_extensions_dir(self):
        with tempfile.TemporaryDirectory(prefix="atlas-ext-none-") as tmp:
            mind = Path(tmp)
            make_mind(mind)
            run_build(mind)
            html = (mind / "dist" / "index.html").read_text(encoding="utf-8")
            self.assertNotIn("__EXTENSIONS_CSS__", html)
            self.assertNotIn("__EXTENSIONS_JS__", html)


# ─── Server side: Python register(context) modules ──────────────────────────────

SERVER_EXT_PY = r'''
"""Test extension: GET/POST routes, default and explicit roles."""


def register(context):
    def ping(handler, match):
        handler._send_json(200, {"pong": True,
                                 "site": context.config.site_name})

    def echo(handler, match):
        data = handler._read_json()
        handler._send_json(200, {"echo": data.get("msg")})

    def item(handler, match):
        handler._send_json(200, {"item_id": int(match.group(1))})

    def public(handler, match):
        handler._send_json(200, {"public": True})

    context.add_route("GET", r"^/api/ext/ping$", ping)    # default GET: auth
    context.add_route("POST", r"^/api/ext/echo$", echo)   # default POST: admin
    context.add_route("GET", r"^/api/ext/item/(\d+)$", item)
    context.add_route("GET", r"^/api/ext/public$", public, role="public")
'''

BROKEN_EXT_PY = "def register(context:\n    pas du python valide\n"
NO_REGISTER_EXT_PY = "VALUE = 42\n"
GOOD_EXT_PY = r'''
def register(context):
    def good(handler, match):
        handler._send_json(200, {"good": True})

    context.add_route("GET", r"^/api/ext/good$", good, role="public")
'''


class TestServerExtensionsLocal(unittest.TestCase):
    """Local mode (simulated admin session): the extension routes respond, the
    regex groups reach the handler, the rest falls to 404."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_files={
            ".atlas/extensions/routes.py": SERVER_EXT_PY,
        })
        cls.srv.start()
        cls.addClassCleanup(cls.srv.stop)

    def test_get_route_served_with_config_access(self):
        resp = self.srv.get("/api/ext/ping")
        self.assertEqual(resp.status, 200)
        body = resp.json()
        self.assertTrue(body["pong"])
        # context.config is indeed the server's AtlasConfig.
        self.assertEqual(body["site"], "Atlas Mind")

    def test_post_route_served(self):
        resp = self.srv.post("/api/ext/echo", json_body={"msg": "bonjour"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {"echo": "bonjour"})

    def test_regex_match_passed_to_handler(self):
        resp = self.srv.get("/api/ext/item/42")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {"item_id": 42})

    def test_unmatched_extension_path_falls_through_404(self):
        resp = self.srv.post("/api/ext/nope", json_body={})
        self.assertEqual(resp.status, 404)

    def test_pob_tree_route_no_longer_native(self):
        # The Path of Exile module was extracted from the engine into the example
        # extension examples/extensions/pob/: without it, /api/pob-tree no longer
        # exists (404), even when other extensions are installed.
        resp = self.srv.post("/api/pob-tree",
                             json_body={"version": "3_99", "nodes": "1"})
        self.assertEqual(resp.status, 404)


class TestServerBrokenExtensions(unittest.TestCase):
    """Broken extension (SyntaxError) or without register: stderr warning, the
    server starts anyway and the healthy extensions work."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_files={
            ".atlas/extensions/10_broken.py": BROKEN_EXT_PY,
            ".atlas/extensions/20_noregister.py": NO_REGISTER_EXT_PY,
            ".atlas/extensions/30_good.py": GOOD_EXT_PY,
        })
        cls.srv.start()  # start() succeeds = the boot did not crash
        cls.addClassCleanup(cls.srv.stop)

    def test_broken_extension_warns_and_server_continues(self):
        log = self.srv.read_log()
        self.assertIn("10_broken.py skipped", log)
        # The server still responds (healthz already validated the boot).
        self.assertEqual(self.srv.get("/healthz").status, 200)

    def test_module_without_register_warns(self):
        self.assertIn("20_noregister.py skipped: no register(context) function",
                      self.srv.read_log())

    def test_healthy_extension_still_loaded_after_broken_one(self):
        resp = self.srv.get("/api/ext/good")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {"good": True})


class TestCloudExtensionRoles(unittest.TestCase):
    """Cloud mode (KB_AUTH_ENABLED=1, ATLAS_STORE=file): the extension routes'
    roles are applied -- default "auth" on GET, "admin" on POST, "public" served
    without a session."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(
            extra_env=cloud_env(),
            extra_files={".atlas/extensions/routes.py": SERVER_EXT_PY},
        )
        cls.srv.start()
        cls.addClassCleanup(cls.srv.stop)
        seed_default_users(file_store_of(cls.srv))
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        time.sleep(1.05)  # distinct ts -> viewer cookie signed differently
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    def test_get_default_role_requires_session(self):
        self.assertEqual(self.srv.get("/api/ext/ping").status, 401)
        resp = self.srv.get("/api/ext/ping",
                            headers={"Cookie": self.viewer_cookie})
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.json()["pong"])

    def test_post_default_role_requires_admin_and_csrf(self):
        # No session → 401.
        self.assertEqual(self.srv.post("/api/ext/echo", json_body={"msg": "x"}).status, 401)
        # A non-admin is refused even with a valid CSRF token.
        denied = self.srv.post("/api/ext/echo", json_body={"msg": "x"},
                               headers=auth_headers(self.srv, self.viewer_cookie))
        self.assertEqual(denied.status, 403)
        # T4: an admin WITHOUT the synchronizer CSRF token is refused — a mutating
        # extension route carries the same CSRF defense as the core POST routes.
        no_csrf = self.srv.post("/api/ext/echo", json_body={"msg": "x"},
                                headers={"Cookie": self.admin_cookie})
        self.assertEqual(no_csrf.status, 403)
        # Admin WITH the CSRF token → served.
        granted = self.srv.post("/api/ext/echo", json_body={"msg": "x"},
                                headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(granted.status, 200)
        self.assertEqual(granted.json(), {"echo": "x"})

    def test_public_role_served_without_session(self):
        resp = self.srv.get("/api/ext/public")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {"public": True})


# ─── Example extension: Path of Exile module (examples/extensions/pob/) ─────────

POB_EXAMPLE_DIR = REPO_ROOT / "examples" / "extensions" / "pob"

# Minimal but realistic PoE1 tree.lua (same indentation/keys as the Path of
# Building Community data): pre-seeded into the extension cache so /api/pob-tree
# resolves the nodes without touching the network.
FAKE_TREE_LUA = """return {
    ["classes"]= {
        {
            ["name"]= "Witch",
            {
                ["name"]= "Necromancer",
            },
        },
    },
    ["nodes"]= {
        [111]= {
            ["name"]= "Chaos Inoculation",
            ["isKeystone"]= true,
            ["stats"]= {
                "Maximum Life becomes 1, Immune to Chaos Damage",
            },
        },
        [222]= {
            ["name"]= "Heart and Soul",
            ["isNotable"]= true,
            ["stats"]= {
                "+20 to maximum Life",
            },
        },
        [333]= {
            ["name"]= "Life Mastery",
            ["isMastery"]= true,
            ["masteryEffects"]= {
                {
                    ["effect"]= 5555,
                    ["stats"]= {
                        "+40 to maximum Life",
                    },
                },
            },
        },
        [444]= {
            ["name"]= "Intelligence",
            ["stats"]= {
                "+10 to Intelligence",
            },
        },
    },
}
"""

# Spec of a minimal realistic PoB build: 4 allocated nodes (keystone + notable +
# mastery + small passive), 1 mastery effect, Witch/Necromancer.
POB_TREE_PAYLOAD = {
    "version": "3_99",
    "nodes": "111,222,333,444",
    "classId": "0",
    "ascendClassId": "1",
    "masteryEffects": "{333,5555}",
}


class TestPobExampleExtension(unittest.TestCase):
    """Mind with the pob extension installed (pob.py + pob.js + pob.css copied
    into .atlas/extensions/): /api/pob-tree responds like the old native
    endpoint, and the assets are inlined into dist/ and the share page."""

    @classmethod
    def setUpClass(cls):
        extension_files = {
            f".atlas/extensions/{name}": (POB_EXAMPLE_DIR / name).read_text(
                encoding="utf-8")
            for name in ("pob.py", "pob.js", "pob.css")
        }
        # Pre-seeded tree cache (next to the installed module): no network.
        extension_files[".atlas/extensions/_tree_cache/poe1_3_99.lua"] = \
            FAKE_TREE_LUA
        cls.srv = AtlasServer(extra_files=extension_files)
        cls.srv.start()
        cls.addClassCleanup(cls.srv.stop)

    def test_pob_tree_endpoint_resolves_like_before(self):
        resp = self.srv.post("/api/pob-tree", json_body=POB_TREE_PAYLOAD)
        self.assertEqual(resp.status, 200)
        body = resp.json()
        self.assertTrue(body["resolved"])
        self.assertEqual(body["game"], "poe1")  # detected from version 3_x
        self.assertEqual(body["version"], "3_99")
        self.assertEqual(body["class"], "Witch")
        self.assertEqual(body["ascendancy"], "Necromancer")
        self.assertEqual(body["counts"], {
            "allocated": 4, "keystones": 1, "notables": 1, "ascNotables": 0,
            "masteries": 1, "jewels": 0, "small": 1, "unknown": 0,
        })
        self.assertEqual(body["keystones"], [{
            "name": "Chaos Inoculation",
            "stats": "Maximum Life becomes 1, Immune to Chaos Damage",
        }])
        self.assertEqual(body["notables"], [{
            "name": "Heart and Soul", "stats": "+20 to maximum Life",
        }])
        self.assertEqual(body["masteries"], [{
            "name": "Life Mastery", "effect": "+40 to maximum Life",
        }])
        self.assertEqual(body["smallsBreakdown"],
                         [{"stat": "+10 to Intelligence", "count": 1}])

    def test_unknown_version_degrades_to_counts_only(self):
        # Version absent from the cache + non-existent GitHub URL (3_0_inconnue):
        # the historical "counts only" contract is preserved.
        resp = self.srv.post("/api/pob-tree", json_body={
            "version": "3_0_inconnue", "nodes": "1,2,3",
            "masteryEffects": "{1,9}",
        })
        self.assertEqual(resp.status, 200)
        body = resp.json()
        self.assertFalse(body["resolved"])
        self.assertEqual(body["counts"], {"allocated": 3, "masteries": 1})

    def test_pob_assets_inlined_in_dist(self):
        index = (self.srv.dist_dir / "index.html").read_text(encoding="utf-8")
        self.assertIn(".poe-card", index)                  # pob.css
        self.assertIn("registerTemplate('pob'", index)     # pob.js
        self.assertIn("/api/pob-tree", index)              # card generator

    def test_share_page_carries_extension_assets(self):
        token = self.srv.post(
            "/api/share", json_body={"path": "accueil.md"}).json()["token"]
        resp = self.srv.get(f"/s/{token}")
        self.assertEqual(resp.status, 200)
        self.assertIn(".poe-card", resp.text)     # injected CSS
        self.assertIn("poe-var-tab", resp.text)   # injected JS (click delegate)


if __name__ == "__main__":
    unittest.main()
