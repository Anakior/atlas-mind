"""Tests of MCP prompts: the mind's own (content/agents/prompts/*.md, arguments and
includes), the engine's built-ins (weekly review, contradiction triage, new doc from a
template), overriding, scopes, and the 2026-07-28 shape.

MCP requires an 'api'-role Bearer token → cloud-mode harness, like test_mcp_tools.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_mcp_protocol import _modern  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402

SAVE_SESSION = """---
description: Save this work session.
arguments: subject, folder?
---
# Save this session

Save our session about "{{subject}}" in {{folder}}, following:

{{include notes/model.md}}

And {{include nope/absent.md}}
"""
MIND = {
    "accueil.md": "# Accueil\n\nBienvenue.\n",
    "notes/model.md": "## Context\n\n## Decisions\n",
    "agents/prompts/save-session.md": SAVE_SESSION,
}


class TestPrompts(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def rpc(self, method, params=None, token=None):
        resp = self.srv.post(f"/mcp/{token or self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
        return resp.json()

    def get(self, name, **arguments):
        return self.rpc("prompts/get", {"name": name, "arguments": arguments})

    def test_capability_and_listing(self):
        caps = self.rpc("initialize")["result"]["capabilities"]
        self.assertIn("prompts", caps)
        prompts = {p["name"]: p for p in self.rpc("prompts/list")["result"]["prompts"]}
        self.assertTrue({"weekly-review", "triage-contradictions", "new-doc", "save-session"} <= set(prompts))
        save = prompts["save-session"]
        self.assertEqual((save["title"], save["description"]), ("Save this session", "Save this work session."))
        self.assertEqual(save["arguments"], [{"name": "subject", "required": True},
                                             {"name": "folder", "required": False}])
        self.assertIn("decision", next(a for a in prompts["new-doc"]["arguments"]
                                       if a["name"] == "template")["description"])

    def test_mind_prompt_fills_arguments_and_includes(self):
        result = self.get("save-session", subject="OAuth", folder="ai-sessions/")["result"]
        self.assertEqual(result["messages"][0]["role"], "user")
        text = result["messages"][0]["content"]["text"]
        self.assertIn('Save our session about "OAuth" in ai-sessions/', text)
        self.assertIn("## Context\n\n## Decisions", text)
        self.assertIn("nope/absent.md)", text)  # an unreadable include says so, never fails
        self.assertNotIn("# Save this session", text)  # the heading is the title, not the text
        without = self.get("save-session", subject="OAuth")["result"]["messages"][0]["content"]["text"]
        self.assertIn('about "OAuth" in ,', without)  # optional folder left out: empty
        self.assertNotIn("{{folder}}", without)

    def test_errors(self):
        self.assertEqual(self.get("save-session")["error"]["code"], -32602)
        self.assertIn("subject", self.get("save-session")["error"]["message"])
        self.assertIn("unknown prompt", self.get("nope")["error"]["message"])
        bad = self.get("new-doc", template="nope", subject="x")["error"]["message"]
        self.assertIn("decision", bad)  # the error lists the templates that exist

    def test_new_doc_from_a_template(self):
        text = self.get("new-doc", template="decision", subject="Choix du store")["result"][
            "messages"][0]["content"]["text"]
        self.assertIn("# Choix du store", text)
        self.assertIn("## Contexte", text)

    def test_weekly_review_shows_the_ai_edit(self):
        self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "edit_doc", "arguments": {
                "path": "accueil.md", "old_string": "Bienvenue", "new_string": "Salut", "ai": "claude"}}})
        text = self.get("weekly-review")["result"]["messages"][0]["content"]["text"]
        line = next(ln for ln in text.splitlines() if "accueil.md" in ln)
        self.assertIn("AI claude", line)  # net change over the week: added (harness) + AI edit

    def test_mind_prompt_overrides_a_builtin(self):
        self.srv.path("agents/prompts/weekly-review.md").write_text(
            "# Our review\n\nOur own weekly ritual.\n", encoding="utf-8")
        prompts = {p["name"]: p for p in self.rpc("prompts/list")["result"]["prompts"]}
        self.assertEqual(prompts["weekly-review"]["title"], "Our review")
        text = self.get("weekly-review")["result"]["messages"][0]["content"]["text"]
        self.assertEqual(text, "Our own weekly ritual.")

    def test_no_read_scope_no_prompts(self):
        inbox_only = _token(self.srv, "mail@api.local", ADMIN_EMAIL, scopes=["inbox"])
        self.assertEqual(self.rpc("prompts/list", token=inbox_only)["result"]["prompts"], [])
        self.assertIn("read scope", self.get_with(inbox_only, "save-session", subject="x"))

    def get_with(self, token, name, **arguments):
        return self.rpc("prompts/get", {"name": name, "arguments": arguments}, token)["error"]["message"]

    def test_modern_shape(self):
        result = _modern(self.srv, self.token, "prompts/list").json()["result"]
        self.assertEqual((result["resultType"], result["cacheScope"], result["ttlMs"]),
                         ("complete", "private", 60000))
        resp = _modern(self.srv, self.token, "prompts/get", {"name": "save-session",
                                                             "arguments": {"subject": "x"}},
                       headers={"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "prompts/get",
                                "Mcp-Name": "new-doc"})
        self.assertEqual((resp.status, resp.json()["error"]["code"]), (400, -32020))


if __name__ == "__main__":
    unittest.main()
