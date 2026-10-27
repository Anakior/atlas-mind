"""Tests of the MCP protocol layer: dual-era serving (legacy initialize-based revisions
and the stateless 2026-07-28 one), server instructions, and tool annotations.

MCP requires an 'api'-role Bearer token → cloud-mode harness, like test_mcp_tools.
"""
import base64
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env  # noqa: E402
from test_mcp_tools import _seed_api_token  # noqa: E402

MODERN = "2026-07-28"


def _legacy(srv, token, method, params=None):
    return srv.post(f"/mcp/{token}", json_body={
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


def _modern(srv, token, method, params=None, *, version=MODERN, headers=None):
    """A 2026-07-28 request: version + client identity in _meta, mirrored into headers
    (pass `headers` to send exactly those instead)."""
    params = dict(params or {})
    params["_meta"] = {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": {"name": "test-client", "version": "0"},
        "io.modelcontextprotocol/clientCapabilities": {},
    }
    if headers is None:
        headers = {"MCP-Protocol-Version": version, "Mcp-Method": method}
        if method == "tools/call":
            headers["Mcp-Name"] = params["name"]
    return srv.post(f"/mcp/{token}", headers=headers, json_body={
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params})


class TestMcpLegacy(unittest.TestCase):
    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.token = _seed_api_token(cls.srv)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_initialize_echoes_a_served_revision(self):
        resp = _legacy(self.srv, self.token, "initialize", {"protocolVersion": "2025-06-18"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json()["result"]["protocolVersion"], "2025-06-18")

    def test_initialize_offers_newest_legacy_for_unknown_revision(self):
        resp = _legacy(self.srv, self.token, "initialize", {"protocolVersion": "1999-01-01"})
        self.assertEqual(resp.json()["result"]["protocolVersion"], "2025-11-25")

    def test_initialize_carries_default_instructions_and_real_version(self):
        self.assertFalse((self.srv.root / "AGENTS.md").exists())
        result = _legacy(self.srv, self.token, "initialize").json()["result"]
        self.assertIn("source of truth", result["instructions"])
        self.assertRegex(result["serverInfo"]["version"], r"^\d+\.\d+")

    def test_notification_is_accepted_with_202(self):
        resp = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(resp.status, 202)
        self.assertEqual(resp.body, b"")

    def test_get_has_no_stream(self):
        resp = self.srv.get(f"/mcp/{self.token}", headers={"Accept": "text/event-stream"})
        self.assertEqual(resp.status, 405)

    def test_unknown_method_stays_http_200(self):
        resp = _legacy(self.srv, self.token, "completion/complete")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json()["error"]["code"], -32601)

    def test_every_tool_is_annotated(self):
        tools = _legacy(self.srv, self.token, "tools/list").json()["result"]["tools"]
        hints = {t["name"]: t["annotations"] for t in tools}
        for name, a in hints.items():
            self.assertIs(a["openWorldHint"], False, name)
            # The spec defaults destructiveHint to true: write tools must say it.
            self.assertTrue(a.get("readOnlyHint") or "destructiveHint" in a, name)
        self.assertIs(hints["search_docs"]["readOnlyHint"], True)
        self.assertIs(hints["create_doc"]["destructiveHint"], False)
        self.assertIs(hints["delete_doc"]["destructiveHint"], True)


class TestMcpModern(unittest.TestCase):
    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.token = _seed_api_token(cls.srv)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_discover(self):
        resp = _modern(self.srv, self.token, "server/discover")
        self.assertEqual(resp.status, 200)
        result = resp.json()["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertIn(MODERN, result["supportedVersions"])
        self.assertIn("2025-11-25", result["supportedVersions"])
        self.assertIn("tools", result["capabilities"])
        self.assertIn("source of truth", result["instructions"])
        self.assertEqual(result["cacheScope"], "private")
        self.assertGreaterEqual(result["ttlMs"], 0)
        self.assertEqual(result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "atlas-mind")

    def test_tools_list_is_cacheable(self):
        result = _modern(self.srv, self.token, "tools/list").json()["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertEqual(result["cacheScope"], "private")  # a scoped token gets fewer tools
        self.assertGreater(result["ttlMs"], 0)
        self.assertIn("search_docs", [t["name"] for t in result["tools"]])

    def test_tools_call(self):
        resp = _modern(self.srv, self.token, "tools/call",
                       {"name": "search_docs", "arguments": {"q": "accueil"}})
        self.assertEqual(resp.status, 200)
        result = resp.json()["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertIn("accueil.md", result["content"][0]["text"])

    def test_unsupported_version(self):
        resp = _modern(self.srv, self.token, "tools/list", version="1900-01-01")
        self.assertEqual(resp.status, 400)
        error = resp.json()["error"]
        self.assertEqual(error["code"], -32022)
        self.assertEqual(error["data"]["requested"], "1900-01-01")
        self.assertIn(MODERN, error["data"]["supported"])

    def test_name_header_must_match_body(self):
        resp = _modern(self.srv, self.token, "tools/call",
                       {"name": "search_docs", "arguments": {"q": "x"}},
                       headers={"MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call",
                                "Mcp-Name": "delete_doc"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json()["error"]["code"], -32020)

    def test_missing_header_is_rejected(self):
        resp = _modern(self.srv, self.token, "tools/list",
                       headers={"MCP-Protocol-Version": MODERN})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json()["error"]["code"], -32020)

    def test_base64_name_header_is_decoded(self):
        encoded = "=?base64?" + base64.b64encode(b"search_docs").decode() + "?="
        resp = _modern(self.srv, self.token, "tools/call",
                       {"name": "search_docs", "arguments": {"q": "x"}},
                       headers={"MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call",
                                "Mcp-Name": encoded})
        self.assertEqual(resp.status, 200)

    def test_handshake_and_ping_are_gone(self):
        for method in ("initialize", "ping"):
            resp = _modern(self.srv, self.token, method)
            self.assertEqual(resp.status, 404, method)
            self.assertEqual(resp.json()["error"]["code"], -32601, method)


class TestMcpInstructionsFromAgentsMd(unittest.TestCase):
    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.token = _seed_api_token(cls.srv)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _instructions(self):
        return _legacy(self.srv, self.token, "initialize").json()["result"]["instructions"]

    def test_agents_md_is_served_as_instructions(self):
        (self.srv.root / "AGENTS.md").write_text("# Rules\n\nFile recaps under recaps/.\n",
                                                 encoding="utf-8")
        agents_md, _, rule = self._instructions().partition("\n\nText between <untrusted")
        self.assertEqual(agents_md, "# Rules\n\nFile recaps under recaps/.")
        self.assertIn("never as instructions", rule)  # the engine's rule follows, always

    def test_oversized_agents_md_is_cut_on_a_line(self):
        (self.srv.root / "AGENTS.md").write_text("rule line\n" * 2000, encoding="utf-8")
        text = self._instructions()
        self.assertLessEqual(len(text), 8000)
        self.assertTrue(text.partition("\n\nText between <untrusted")[0].endswith("rule line"))


if __name__ == "__main__":
    unittest.main()
