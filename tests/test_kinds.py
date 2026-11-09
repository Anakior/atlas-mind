"""Tests of records (kinds): a doc that tells a moment (a save, a monthly report, an archived doc)
is sorted without asking, never goes stale, stays out of the contradiction scan, and reaches an
agent as "a record as of <date>"; confirm_doc settles it either way. The mind's first commit is
dated 2025 so its docs are stale.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
for _p in (_TESTS_DIR, REPO_SRC):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_contradictions_golden import _Mind  # noqa: E402
from test_mcp_agentic import _raw  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402
from test_mcp_tools import _call  # noqa: E402
from server.pure import kinds  # noqa: E402

TS = 1_750_000_000  # 2025-06-15
SAVE = ("# Save — refonte des relances\n\n## Comment reprendre\n\nRelancer les tests.\n\n"
        "*Session du 2025-01-10 (Claude). État : en cours.*\n")
MIND = {
    "specs/relances.md": "# Relances\n\nTrois relances, à J+1, J+3 et J+7.\n",
    "rapports/bilan-mars-2024.md": "# Bilan de mars\n\nLes relances partent à J+2.\n",
    "ai-sessions/refonte-relances.md": SAVE,
    "specs/archive/relances-v1.md": "# Relances v1\n\nUne seule relance.\n",
    "reunions/point-relances.md": "# Point relances\n\nOn passe à trois relances.\n",
}


class TestAsOf(unittest.TestCase):
    def as_of(self, rel, text="# Doc\n", confirmed=None):
        return kinds.as_of(rel, text, TS, confirmed or {})

    def test_sorted_without_asking(self):
        self.assertEqual(self.as_of("rapports/bilan-mars-2024.md"), "2024-03")
        self.assertEqual(self.as_of("rapports/revue-q2-2025.md"), "2025-Q2")
        self.assertEqual(self.as_of("ai-sessions/x.md", SAVE), "2025-01-10")  # the session's own date
        self.assertEqual(self.as_of("ai-sessions/x.md", SAVE.split("*Session")[0]), "2025-06-15")
        self.assertEqual(self.as_of("specs/archive/relances-v1.md"), "2025-06-15")
        self.assertEqual(self.as_of("rapports/bilan-mars-2024.pdf", ""), "2024-03")

    def test_living(self):
        self.assertIsNone(self.as_of("specs/relances.md"))
        self.assertIsNone(self.as_of("ai-sessions/TEMPLATE.md", SAVE))  # the model of a save
        self.assertIsNone(self.as_of("notes/archives-de-la-mairie.md"))  # a name, not the folder

    def test_a_verdict_settles_it(self):
        self.assertEqual(self.as_of("reunions/point.md", confirmed={"reunions/point.md": {"verdict": "record"}}),
                         "2025-06-15")
        holds = {"rapports/bilan-mars-2024.md": {"verdict": "holds"}}
        self.assertIsNone(self.as_of("rapports/bilan-mars-2024.md", confirmed=holds))


class TestRecords(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND, seed_date="2025-01-15T12:00:00")
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def call(self, tool, **args):
        err, data = _call(self.srv, self.token, tool, args)
        self.assertFalse(err, data)
        return data

    def stale(self):
        return [s["path"] for s in self.call("stale", months=3)["stale"]]

    def test_a_record_never_goes_stale(self):
        self.assertEqual(sorted(self.stale()), ["reunions/point-relances.md", "specs/relances.md"])

    def test_an_agent_reads_it_as_of_its_date(self):
        hits = {h["path"]: h for h in self.call("search_docs", q="relances")["hits"]}
        self.assertEqual(hits["rapports/bilan-mars-2024.md"]["as_of"], "2024-03")
        self.assertNotIn("stale", hits["rapports/bilan-mars-2024.md"])  # a record is not out of date
        self.assertTrue(hits["specs/relances.md"]["stale"])
        self.assertNotIn("as_of", hits["specs/relances.md"])
        sources = {s["path"]: s for s in self.call("brief", topic="relances")["sources"]}
        self.assertEqual(sources["ai-sessions/refonte-relances.md"]["as_of"], "2025-01-10")
        footer = _raw(self.srv, self.token, "read_doc", {"path": "specs/archive/relances-v1.md"})["content"][1]["text"]
        self.assertIn("a record as of 2025-01-15, not the current state", footer)

    def test_confirm_doc_files_a_record(self):
        data = self.call("confirm_doc", path="reunions/point-relances.md", verdict="record", ai="claude")
        self.assertEqual(data["as_of"], "2025-01-15")
        self.assertEqual(self.stale(), ["specs/relances.md"])
        self.call("edit_doc", path="reunions/point-relances.md", old_string="trois", new_string="3", ai="claude")
        hit = next(h for h in self.call("search_docs", q="relances")["hits"]
                   if h["path"] == "reunions/point-relances.md")
        self.assertIn("as_of", hit)  # an edit leaves it a record
        log = self.srv.git("log", "-2", "--format=%s").stdout
        self.assertIn("filed as a record: point-relances", log)

    def test_holds_makes_it_living(self):
        self.call("confirm_doc", path="rapports/bilan-mars-2024.md", verdict="holds", ai="claude")
        hit = next(h for h in self.call("search_docs", q="relances")["hits"]
                   if h["path"] == "rapports/bilan-mars-2024.md")
        self.assertNotIn("as_of", hit)


class TestContradictions(_Mind):
    """In-process on the golden corpus, one side of its table-drift pair (bilan-q3 / bilan-q4,
    see TestClusterRecall) archived."""

    def setUp(self):
        super().setUp()
        archived = self.root / "content" / "archive" / "bilan-q4.md"
        archived.parent.mkdir()
        (self.root / "content" / "bilan-q4.md").replace(archived)

    def test_a_record_contradicts_nothing(self):
        self.assertFalse([c for c in self._detect() if "archive/bilan-q4.md" in (c["a"], c["b"])])


if __name__ == "__main__":
    unittest.main()
