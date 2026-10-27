"""Tests of the agent-facing MCP behaviors: actionable errors (path suggestions, closest
passage, ambiguous lines), verifiable writes (diff, dry_run, base_version), trust
signals and section-level hits in search_docs, grep_docs, ranged/section reads, and
structured JSON results.

MCP requires an 'api'-role Bearer token → cloud-mode harness, like test_mcp_tools.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env  # noqa: E402
from test_mcp_tools import _seed_api_token, _call  # noqa: E402

ALPHA = ("# Projet Alpha\n\n## Contexte\n\nLe client veut un tableau de bord.\n\n"
         "## Pricing\n\nLe tarif mensuel est de 49 euros.\nLe tarif annuel est de 490 euros.\n\n"
         "## Suite\n\nRien.\n")
MIND = {
    "accueil.md": "# Accueil\n\nVoir [[projets/alpha]].\n",
    "projets/alpha.md": ALPHA,
    "projets/beta.md": "# Projet Beta\n\nLe tarif mensuel est de 59 euros.\n",
    "notes/recap-klayn.md": "# Recap Klayn\n\nDecision : on garde la v2.\n",
}


def _raw(srv, token, tool, arguments=None):
    """The whole CallToolResult (every content block, structuredContent)."""
    resp = srv.post(f"/mcp/{token}", json_body={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments or {}}})
    assert resp.status == 200, f"HTTP {resp.status}"
    return resp.json()["result"]


def _version(srv, token, rel):
    footer = _raw(srv, token, "read_doc", {"path": rel})["content"][-1]["text"]
    return footer.rsplit("version ", 1)[1].rstrip("]")


class TestAgenticReads(unittest.TestCase):
    """Read-only → one server shared per class."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        cls.srv.start()
        cls.token = _seed_api_token(cls.srv)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_not_found_suggests_near_paths(self):
        err, text = _call(self.srv, self.token, "read_doc", {"path": "projets/alfa.md"})
        self.assertTrue(err)
        self.assertIn("Did you mean: projets/alpha.md", text)
        # Right filename, wrong folder: the real location comes first.
        err, text = _call(self.srv, self.token, "read_doc", {"path": "projets/recap-klayn.md"})
        self.assertIn("Did you mean: notes/recap-klayn.md", text)

    def test_read_section(self):
        result = _raw(self.srv, self.token, "read_doc",
                      {"path": "projets/alpha.md", "section": "PRICING"})
        body, footer = (c["text"] for c in result["content"])
        self.assertEqual(body, "## Pricing\n\nLe tarif mensuel est de 49 euros.\n"
                               "Le tarif annuel est de 490 euros.\n")
        self.assertIn("lines 7-11 of 14", footer)
        self.assertIn("version ", footer)

    def test_unknown_section_lists_headings(self):
        err, text = _call(self.srv, self.token, "read_doc",
                          {"path": "projets/alpha.md", "section": "roadmap"})
        self.assertTrue(err)
        self.assertIn("Pricing", text)

    def test_read_line_range(self):
        result = _raw(self.srv, self.token, "read_doc",
                      {"path": "projets/alpha.md", "start_line": 9, "end_line": 9})
        self.assertEqual(result["content"][0]["text"], "Le tarif mensuel est de 49 euros.")

    def test_whole_read_is_unchanged(self):
        result = _raw(self.srv, self.token, "read_doc", {"path": "projets/alpha.md"})
        self.assertEqual(result["content"][0]["text"], ALPHA)

    def test_search_hit_points_at_line_and_section(self):
        _, data = _call(self.srv, self.token, "search_docs", {"q": "tarif annuel"})
        hit = data["hits"][0]
        self.assertEqual(hit["path"], "projets/alpha.md")
        self.assertEqual((hit["line"], hit["section"]), (10, "Projet Alpha > Pricing"))
        self.assertRegex(hit["last_modified"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertNotIn("mtime", hit)

    def test_json_results_are_structured(self):
        result = _raw(self.srv, self.token, "search_docs", {"q": "tarif"})
        self.assertEqual(result["structuredContent"], json.loads(result["content"][0]["text"]))
        self.assertNotIn("\n", result["content"][0]["text"])  # compact, no indentation

    def test_grep_docs(self):
        _, data = _call(self.srv, self.token, "grep_docs", {"pattern": "TARIF MENSUEL"})
        self.assertEqual([(m["path"], m["line"]) for m in data["matches"]],
                         [("projets/alpha.md", 9), ("projets/beta.md", 3)])
        _, data = _call(self.srv, self.token, "grep_docs",
                        {"pattern": r"\d+ euros", "regex": True, "limit": 2})
        self.assertEqual(len(data["matches"]), 2)
        self.assertTrue(data["truncated"])
        _, data = _call(self.srv, self.token, "grep_docs",
                        {"pattern": "tarif", "path_prefix": "notes"})
        self.assertEqual(data["matches"], [])
        err, text = _call(self.srv, self.token, "grep_docs", {"pattern": "(", "regex": True})
        self.assertTrue(err)
        self.assertIn("Invalid regex", text)

    def test_grep_hints_at_a_forgotten_regex(self):
        _, data = _call(self.srv, self.token, "grep_docs", {"pattern": "tarif annuel|tarif mensuel"})
        self.assertEqual(data["matches"], [])
        self.assertIn("regex=true", data["hint"])
        _, data = _call(self.srv, self.token, "grep_docs",
                        {"pattern": "tarif annuel|tarif mensuel", "regex": True})
        self.assertEqual(len(data["matches"]), 3)
        self.assertNotIn("hint", data)
        _, data = _call(self.srv, self.token, "grep_docs", {"pattern": "introuvable"})
        self.assertNotIn("hint", data)  # a plain word that isn't there: nothing to suggest


class TestAgenticWrites(unittest.TestCase):
    """Mutations → a FRESH server per test."""

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        self.srv.start()
        self.token = _seed_api_token(self.srv)

    def tearDown(self):
        self.srv.stop()

    def _edit(self, **args):
        return _call(self.srv, self.token, "edit_doc",
                     {"path": "projets/alpha.md", "ai": "claude", **args})

    def test_edit_returns_diff_and_new_version(self):
        err, text = self._edit(old_string="49 euros", new_string="45 euros",
                               base_version=_version(self.srv, self.token, "projets/alpha.md"))
        self.assertFalse(err, text)
        self.assertIn("-Le tarif mensuel est de 49 euros.", text)
        self.assertIn("+Le tarif mensuel est de 45 euros.", text)
        reported = text.split("now version ", 1)[1].split(")", 1)[0]
        self.assertEqual(reported, _version(self.srv, self.token, "projets/alpha.md"))

    def test_stale_base_version_is_refused(self):
        seen = _version(self.srv, self.token, "projets/alpha.md")
        self._edit(old_string="Rien.", new_string="Une suite.")  # someone else's change
        err, text = self._edit(content="# Projet Alpha\n\nRéécrit.\n", base_version=seen)
        self.assertTrue(err)
        self.assertIn("changed since you read it", text)
        self.assertIn("Une suite.", self.srv.path("projets/alpha.md").read_text(encoding="utf-8"))

    def test_dry_run_writes_nothing(self):
        err, text = self._edit(old_string="49 euros", new_string="45 euros", dry_run=True)
        self.assertFalse(err)
        self.assertIn("Dry run", text)
        self.assertIn("+Le tarif mensuel est de 45 euros.", text)
        self.assertIn("49 euros", self.srv.path("projets/alpha.md").read_text(encoding="utf-8"))

    def test_missing_old_string_shows_closest_passage(self):
        err, text = self._edit(old_string="Le tarif mensuel est de 50 euros.", new_string="x")
        self.assertTrue(err)
        self.assertIn("Closest passage (lines 9-9):\nLe tarif mensuel est de 49 euros.", text)

    def test_ambiguous_old_string_lists_lines(self):
        err, text = self._edit(old_string="Le tarif", new_string="Le prix")
        self.assertTrue(err)
        self.assertIn("appears 2 times (lines 9, 10)", text)

    def test_identical_rewrite_is_a_no_op(self):
        err, text = self._edit(content=ALPHA)
        self.assertFalse(err)
        self.assertIn("No change", text)

    def test_create_on_existing_path_points_to_edit(self):
        err, text = _call(self.srv, self.token, "create_doc",
                          {"path": "projets/alpha.md", "content": "# x", "ai": "claude"})
        self.assertTrue(err)
        self.assertIn("edit_doc", text)

    def test_move_dry_run_lists_rewrites_and_moves_nothing(self):
        err, text = _call(self.srv, self.token, "move_doc", {
            "from": "projets/alpha.md", "to": "projets/alpha-v2.md", "dry_run": True, "ai": "claude"})
        self.assertFalse(err, text)
        self.assertIn("would rewrite 1 incoming wikilink(s) in: accueil.md (1)", text)
        self.assertTrue(self.srv.path("projets/alpha.md").exists())
        self.assertFalse(self.srv.path("projets/alpha-v2.md").exists())

    def test_trust_signals(self):
        _call(self.srv, self.token, "edit_doc", {"path": "projets/beta.md", "ai": "claude",
                                                 "old_string": "# Projet Beta",
                                                 "new_string": "# Projet Beta (v2)"})
        _call(self.srv, self.token, "judge_contradiction", {
            "a": "projets/alpha.md", "b": "projets/beta.md", "a_line": 9, "b_line": 3,
            "verdict": "real", "ai": "claude"})
        old = self.srv.path("notes/vieux.md")
        old.write_text("# Vieux\n\nUn tarif oublié.\n", encoding="utf-8")
        env = {**self.srv._git_env(), "GIT_AUTHOR_DATE": "2020-01-01T12:00:00Z",
               "GIT_COMMITTER_DATE": "2020-01-01T12:00:00Z"}
        subprocess.run(["git", "add", str(old)], cwd=self.srv.root, env=env, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "old note"], cwd=self.srv.root, env=env,
                       check=True)

        _, data = _call(self.srv, self.token, "search_docs", {"q": "tarif"})
        hits = {h["path"]: h for h in data["hits"]}
        beta, alpha, vieux = hits["projets/beta.md"], hits["projets/alpha.md"], hits["notes/vieux.md"]
        self.assertEqual(beta["ai"], "claude")
        self.assertIn("last_editor", beta)
        self.assertNotIn("ai", alpha)
        self.assertEqual(alpha["contested_with"], ["projets/beta.md"])
        self.assertEqual(beta["contested_with"], ["projets/alpha.md"])
        self.assertEqual((vieux["last_modified"], vieux["stale"]), ("2020-01-01", True))
        self.assertNotIn("stale", alpha)


if __name__ == "__main__":
    unittest.main()
