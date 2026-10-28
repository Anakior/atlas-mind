"""Shared by the tests of the MCP Apps views: a server on a mind, and the stand-in host
(tests/apps_host.mjs, Playwright) that renders a view on a live tool result and acts on it like a
user, reporting what the view showed and every message it sent the host.

Skipped without the viewer's node toolchain (src/viewer/build: npm ci, then npx playwright
install chromium).
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer
from test_cloud_filestore import cloud_env, ADMIN_EMAIL
from test_mcp_sessions import _token

_TESTS_DIR = Path(__file__).resolve().parent
HOST = _TESTS_DIR / "apps_host.mjs"
PLAYWRIGHT = _TESTS_DIR.parent / "src" / "viewer" / "build" / "node_modules" / "@playwright" / "test"


@unittest.skipUnless(shutil.which("node") and PLAYWRIGHT.is_dir(), "needs the viewer's node toolchain")
class ViewTestCase(unittest.TestCase):
    MIND = None       # the mind served
    VIEW = None       # its ui:// resource
    TOOL = None       # the tool that names it
    SEED_DATE = None  # the date of the mind's first commit, when its docs must read as old

    @classmethod
    def setUpClass(cls):
        # The package alone isn't enough: its browser comes from `npx playwright install chromium`.
        probe = subprocess.run(["node", "-e", "require(process.argv[1]).chromium.launch().then(b => b.close())",
                                str(PLAYWRIGHT)], capture_output=True, text=True, timeout=60)
        if probe.returncode != 0:
            raise unittest.SkipTest("Playwright's Chromium is not installed")

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=self.MIND, seed_date=self.SEED_DATE)
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def rpc(self, method, params=None):
        return self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).json()["result"]

    def host(self, args, theme="light"):
        """Render the view in the stand-in host on TOOL(args); its JSON report."""
        html = self.rpc("resources/read", {"uri": self.VIEW})["contents"][0]["text"]
        with tempfile.TemporaryDirectory() as tmp:
            view = Path(tmp) / "view.html"
            view.write_text(html, encoding="utf-8")
            run = subprocess.run(["node", str(HOST), str(view), f"{self.srv.base_url}/mcp/{self.token}",
                                  self.TOOL, json.dumps(args), theme], capture_output=True, text=True,
                                 encoding="utf-8", timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def sent(self, report, method):
        return [m for m in report["log"] if m.get("method") == method]

    def assert_served(self):
        """The tool names the view, which comes whole and stays out of the document listing."""
        tools = {t["name"]: t for t in self.rpc("tools/list")["tools"]}
        self.assertEqual(tools[self.TOOL]["_meta"]["ui"]["resourceUri"], self.VIEW)
        content = self.rpc("resources/read", {"uri": self.VIEW})["contents"][0]
        self.assertEqual(content["mimeType"], "text/html;profile=mcp-app")
        self.assertNotRegex(content["text"], r"__[A-Z0-9_]+__")  # every marker filled
        self.assertNotIn(self.VIEW, [r["uri"] for r in self.rpc("resources/list")["resources"]])
        return content
