"""Tests of the resume view (MCP Apps): the tool names it, the server serves it (and keeps it
out of the document listing), and a stand-in host (tests/apps_host.mjs, Playwright) renders it
on a live tool result: what it shows, and what it tells the host when the user acts (the model
context, the message that resumes the session, the tool it calls to open another save).

Skipped without the viewer's node toolchain (src/viewer/build: npm ci).
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402
from test_resume_session import MIND, PATH  # noqa: E402

HOST = _TESTS_DIR / "apps_host.mjs"
PLAYWRIGHT = _TESTS_DIR.parent / "src" / "viewer" / "build" / "node_modules" / "@playwright" / "test"
VIEW = "ui://atlas/resume"


@unittest.skipUnless(shutil.which("node") and PLAYWRIGHT.is_dir(), "needs the viewer's node toolchain")
class TestResumeView(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def rpc(self, method, params=None):
        return self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).json()["result"]

    def host(self, args, theme="light"):
        """Render the view in the stand-in host on resume_session(args); its JSON report."""
        html = self.rpc("resources/read", {"uri": VIEW})["contents"][0]["text"]
        with tempfile.TemporaryDirectory() as tmp:
            view = Path(tmp) / "view.html"
            view.write_text(html, encoding="utf-8")
            run = subprocess.run(["node", str(HOST), str(view), f"{self.srv.base_url}/mcp/{self.token}",
                                  json.dumps(args), theme], capture_output=True, text=True,
                                 encoding="utf-8", timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def sent(self, report, method):
        return [m for m in report["log"] if m.get("method") == method]

    def test_the_tool_names_its_view(self):
        capabilities = self.rpc("initialize", {"protocolVersion": "2025-06-18"})["capabilities"]
        self.assertIn("io.modelcontextprotocol/ui", capabilities["extensions"])
        tools = {t["name"]: t for t in self.rpc("tools/list")["tools"]}
        self.assertEqual(tools["resume_session"]["_meta"]["ui"]["resourceUri"], VIEW)
        content = self.rpc("resources/read", {"uri": VIEW})["contents"][0]
        self.assertEqual(content["mimeType"], "text/html;profile=mcp-app")
        self.assertEqual(content["_meta"]["ui"]["permissions"], {"clipboardWrite": {}})
        self.assertIsNone(re.search(r"__[A-Z0-9]+__", content["text"]))  # every marker filled
        self.assertNotIn(VIEW, [r["uri"] for r in self.rpc("resources/list")["resources"]])

    def test_a_save_renders_and_the_user_acts(self):
        err = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "edit_doc", "arguments": {
                "path": "notes/plan.md", "old_string": "Le plan de l'auth.",
                "new_string": "Le plan de l'auth, revu.", "ai": "claude"}}}).json()["result"].get("isError")
        self.assertFalse(err)
        report = self.host({"path": PATH})
        self.assertEqual(report["title"], "Refonte de l'auth")
        self.assertEqual(report["linked"], ["plan"])
        self.assertTrue(any("revu" in line for line in report["excerpt"]))  # the diff, unfolded
        self.assertTrue(any("plan" in badge for badge in report["moved"]))  # a point's doc moved
        methods = [m.get("method") for m in report["log"]]
        self.assertEqual(methods[:2], ["ui/initialize", "ui/notifications/initialized"])
        self.assertTrue(self.sent(report, "ui/notifications/size-changed"))
        # The first point unchecked: the model is told, and the resume message leaves it out.
        context = self.sent(report, "ui/update-model-context")[-1]["params"]
        self.assertEqual(len(context["structuredContent"]["keep"]), report["points"] - 1)
        self.assertIn("Migrer les jetons existants", context["structuredContent"]["drop"][0])
        message = self.sent(report, "ui/message")[-1]["params"]
        self.assertEqual(message["role"], "user")
        self.assertIn("Refonte de l'auth", message["content"]["text"])
        self.assertNotIn("Migrer les jetons", message["content"]["text"])

    def test_the_list_opens_a_save(self):
        report = self.host({}, theme="dark")
        self.assertEqual(set(report["saves"]), {"Refonte de l'auth", "Refonte de l'auth, suite"})
        self.assertIn(report["opened"], report["saves"])
        call = self.sent(report, "tools/call")[0]["params"]
        self.assertEqual((call["name"], list(call["arguments"])), ("resume_session", ["path"]))


if __name__ == "__main__":
    unittest.main()
