"""Tests of MCP resources: the mind's documents as doc://<path> (list with pagination,
templates, read), ACL and scopes, resource links in search hits, and the 2026-07-28 shape.

MCP requires an 'api'-role Bearer token → cloud-mode harness, like test_mcp_tools.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, file_store_of, ADMIN_EMAIL, VIEWER_EMAIL  # noqa: E402
from test_mcp_protocol import _modern  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402

MIND = {
    "accueil.md": "# Bienvenue\n\nLe tarif est de 49 euros.\n",
    "notes/café menu.md": "# Café\n\nLe tarif du café.\n",
    "decks/q3.html": "<!DOCTYPE html><html><body><h1>Q3</h1></body></html>",
    "prive/secret.md": "# Secret\n\nRien pour les autres.\n",
}


class _Resources(unittest.TestCase):
    mind = MIND

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=self.mind)
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def rpc(self, method, params=None, token=None):
        return self.srv.post(f"/mcp/{token or self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).json()


class TestResources(_Resources):
    def test_list_and_read(self):
        self.assertIn("resources", self.rpc("initialize")["result"]["capabilities"])
        listed = {r["name"]: r for r in self.rpc("resources/list")["result"]["resources"]}
        self.assertEqual(listed["accueil.md"]["uri"], "doc://accueil.md")
        self.assertEqual(listed["accueil.md"]["title"], "Bienvenue")
        self.assertEqual(listed["decks/q3.html"]["mimeType"], "text/html")
        cafe = listed["notes/café menu.md"]
        self.assertEqual(cafe["uri"], "doc://notes/caf%C3%A9%20menu.md")
        content = self.rpc("resources/read", {"uri": cafe["uri"]})["result"]["contents"][0]
        self.assertEqual((content["mimeType"], content["text"]),
                         ("text/markdown", "# Café\n\nLe tarif du café.\n"))

    def test_template_and_errors(self):
        templates = self.rpc("resources/templates/list")["result"]["resourceTemplates"]
        self.assertEqual(templates[0]["uriTemplate"], "doc://{+path}")
        self.assertEqual(self.rpc("resources/read", {"uri": "doc://nope.md"})["error"]["code"], -32002)
        modern = _modern(self.srv, self.token, "resources/read", {"uri": "doc://nope.md"},
                         headers={"MCP-Protocol-Version": "2026-07-28",
                                  "Mcp-Method": "resources/read", "Mcp-Name": "doc://nope.md"})
        self.assertEqual(modern.json()["error"]["code"], -32602)
        mismatch = _modern(self.srv, self.token, "resources/read", {"uri": "doc://accueil.md"},
                           headers={"MCP-Protocol-Version": "2026-07-28",
                                    "Mcp-Method": "resources/read", "Mcp-Name": "doc://prive/secret.md"})
        self.assertEqual((mismatch.status, mismatch.json()["error"]["code"]), (400, -32020))

    def test_acl_and_scope(self):
        file_store_of(self.srv).set_owner("prive/secret.md", "user:" + ADMIN_EMAIL)
        viewer = _token(self.srv, "bot@api.local", VIEWER_EMAIL, role="viewer")
        names = [r["name"] for r in self.rpc("resources/list", token=viewer)["result"]["resources"]]
        self.assertNotIn("prive/secret.md", names)
        self.assertIn("error", self.rpc("resources/read", {"uri": "doc://prive/secret.md"}, viewer))
        inbox_only = _token(self.srv, "mail@api.local", ADMIN_EMAIL, scopes=["inbox"])
        self.assertEqual(self.rpc("resources/list", token=inbox_only)["result"]["resources"], [])
        self.assertIn("read scope", self.rpc("resources/read", {"uri": "doc://accueil.md"},
                                             inbox_only)["error"]["message"])

    def test_search_hits_link_to_resources(self):
        content = self.rpc("tools/call", {"name": "search_docs", "arguments": {"q": "tarif"}})[
            "result"]["content"]
        links = [c for c in content if c["type"] == "resource_link"]
        self.assertIn("doc://accueil.md", [link["uri"] for link in links])


class TestPagination(_Resources):
    mind = {f"notes/n{i:03d}.md": f"# Note {i}\n" for i in range(205)}

    def test_pages(self):
        first = self.rpc("resources/list")["result"]
        self.assertEqual((len(first["resources"]), first["nextCursor"]), (200, "200"))
        second = self.rpc("resources/list", {"cursor": first["nextCursor"]})["result"]
        self.assertEqual(len(second["resources"]), 5)
        self.assertNotIn("nextCursor", second)


if __name__ == "__main__":
    unittest.main()
