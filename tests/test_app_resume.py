"""Tests of the resume view (MCP Apps): the tool names it, the server serves it (and keeps it
out of the document listing), and the stand-in host renders it on a live tool result: what it
shows, and what it tells the host when the user acts (the model context, the message that
resumes the session, the tool it calls to open another save). See appview.py.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from appview import ViewTestCase  # noqa: E402
from test_resume_session import MIND, PATH  # noqa: E402


class TestResumeView(ViewTestCase):
    MIND, VIEW, TOOL = MIND, "ui://atlas/resume", "resume_session"

    def test_the_tool_names_its_view(self):
        capabilities = self.rpc("initialize", {"protocolVersion": "2025-06-18"})["capabilities"]
        self.assertIn("io.modelcontextprotocol/ui", capabilities["extensions"])
        self.assertEqual(self.assert_served()["_meta"]["ui"]["permissions"], {"clipboardWrite": {}})

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
        self.assertIn("Refonte de l'auth", message["content"][0]["text"])
        self.assertNotIn("Migrer les jetons", message["content"][0]["text"])
        self.assertEqual(report["after_resume"], "Sent")  # the host took it

    def test_the_list_opens_a_save(self):
        report = self.host({}, theme="dark")
        self.assertEqual(len(report["saves"]), 2)  # the linked refonte saves are one line
        self.assertIn("Hébergement", report["saves"])
        self.assertIn(report["opened"], report["saves"])
        calls = [m["params"] for m in self.sent(report, "tools/call")]
        self.assertEqual((calls[0]["name"], list(calls[0]["arguments"])), ("resume_session", ["path"]))
        self.assertEqual((calls[1]["arguments"], report["back"]), ({}, 2))  # and back to the list


if __name__ == "__main__":
    unittest.main()
