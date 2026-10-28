"""Tests of then_and_now and show_shift: what the mind said about a topic at a past date next to
what it says now, read from git (a doc rewritten, one deleted, one moved, one written since, one
left behind), and the pairs the model makes of it, each quote checked word for word against the
version it cites.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_mcp_tools import _call  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402

SEED_DATE = "2025-01-15T12:00:00"
MIND = {
    "welcome.md": "# Welcome\n",
    "notes/search.md": "# Search\n\n## Semantic search\n\nThe **embeddings** come as an opt-in extension, outside the core.\n",
    "notes/model.md": "# Model\n\nEmbeddings computed by a local model, cached on disk.\n",
    "notes/old-name.md": "# Ranking\n\nEmbeddings rank the hits.\n",
    "notes/roadmap.md": "# Roadmap\n\n- Embeddings: an opt-in extension.\n",
}


def change_of_mind(srv):
    """On 2025-03-10 the mind changes its mind: search rewritten, the model doc deleted, the
    ranking doc moved, a rule written; the roadmap is left as it was."""
    content = srv.content_root
    (content / "notes/search.md").write_text(
        "# Search\n\n## Semantic search\n\nNo embeddings in the engine: the AI is the semantic layer, downstream.\n",
        encoding="utf-8", newline="\n")
    (content / "notes/rules.md").write_text("# Rules\n\nZero dependency: never *embeddings* in the engine.\n",
                                            encoding="utf-8", newline="\n")
    srv.git("rm", "-q", "content/notes/model.md", check=True)
    srv.git("mv", "content/notes/old-name.md", "content/notes/ranking.md", check=True)
    srv.git("add", "-A", check=True)
    day = "2025-03-10T12:00:00"
    srv.git("commit", "-q", "-m", "docs: no embeddings in the engine", check=True,
            env={"GIT_AUTHOR_DATE": day, "GIT_COMMITTER_DATE": day})


SHIFTS = [
    {"badge": "reversed", "note": "From an extension to never.",
     "then": {"path": "notes/search.md", "quote": "The embeddings come as an opt-in extension"},
     "now": {"path": "notes/search.md", "quote": "No embeddings in the engine … downstream"}},
    {"badge": "dropped", "then": {"path": "notes/model.md", "quote": "Embeddings computed by a local model"}},
    {"badge": "new", "now": {"path": "notes/rules.md", "quote": "never embeddings in the engine"}},
    {"badge": "held", "then": {"path": "notes/old-name.md", "quote": "Embeddings rank the hits."},
     "now": {"path": "notes/ranking.md", "quote": "Embeddings rank the hits."}},
]
LAGGING = [{"path": "notes/roadmap.md", "quote": "Embeddings: an opt-in extension.", "echoes": 0}]


class TestThenAndNow(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND, seed_date=SEED_DATE)
        self.srv.start()
        change_of_mind(self.srv)
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def call(self, tool, **args):
        err, data = _call(self.srv, self.token, tool, args)
        self.assertFalse(err, data)
        return data

    def test_the_evidence(self):
        data = self.call("then_and_now", topic="embeddings", at="2025-02-01")
        self.assertEqual(data["at"], "2025-02-01")
        self.assertEqual([m["date"] for m in data["moments"]], ["2025-01-15", "2025-03-10"])
        docs = {d["path"]: d for d in data["docs"]}

        def text(doc, side):
            return " ".join(p["text"] for p in docs[doc][side]["passages"])
        self.assertIn("opt-in extension", text("notes/search.md", "then"))
        self.assertIn("No embeddings in the engine", text("notes/search.md", "now"))
        self.assertEqual(docs["notes/search.md"]["then"]["date"], "2025-01-15")
        self.assertEqual(docs["notes/search.md"]["now"]["date"], "2025-03-10")
        self.assertTrue(docs["notes/model.md"]["gone"])  # deleted since, still found
        self.assertIn("local model", text("notes/model.md", "then"))
        self.assertNotIn("now", docs["notes/model.md"])
        self.assertEqual(docs["notes/ranking.md"]["then"]["path"], "notes/old-name.md")  # moved since
        self.assertTrue(docs["notes/ranking.md"]["now"]["same_as_then"])
        self.assertNotIn("then", docs["notes/rules.md"])  # written since
        self.assertTrue(docs["notes/roadmap.md"]["now"]["same_as_then"])
        self.assertNotIn("welcome.md", docs)

    def test_without_a_date(self):
        data = self.call("then_and_now", topic="embeddings")
        self.assertEqual([m["date"] for m in data["moments"]], ["2025-01-15", "2025-03-10"])
        self.assertNotIn("docs", data)  # nothing compared until a date is picked
        self.assertIn("again", data["hint"])

    def test_a_date_before_the_mind(self):
        err, data = _call(self.srv, self.token, "then_and_now", {"topic": "embeddings", "at": "2024-06-01"})
        self.assertTrue(err)
        self.assertIn("starts on 2025-01-15", data)
        err, data = _call(self.srv, self.token, "then_and_now", {"topic": "embeddings", "at": "June"})
        self.assertTrue(err)

    def test_every_quote_is_checked(self):
        made_up = [
            {"badge": "reversed", "then": {"path": "notes/search.md", "quote": "opt-in extension"},
             "now": {"path": "notes/search.md", "quote": "Embeddings are mandatory"}},
            {"badge": "held", "then": {"path": "notes/search.md", "quote": "No embeddings in the engine"},
             "now": {"path": "notes/search.md", "quote": "No embeddings in the engine"}},  # not yet said then
            {"badge": "flipped"},
        ]
        not_behind = [  # old, but saying what the mind holds now; or naming no claim that moved
            {"path": "notes/ranking.md", "quote": "Embeddings rank the hits.", "echoes": 3},
            {"path": "notes/roadmap.md", "quote": "Embeddings: an opt-in extension."},
        ]
        data = self.call("show_shift", topic="embeddings", at="2025-02-01", shifts=SHIFTS + made_up,
                         lagging=LAGGING + not_behind)
        self.assertEqual([s["badge"] for s in data["shifts"]], ["reversed", "dropped", "new", "held"])
        reversed_, dropped, new, held = data["shifts"]
        self.assertEqual((reversed_["then"]["date"], reversed_["now"]["date"]), ("2025-01-15", "2025-03-10"))
        self.assertEqual(reversed_["then"]["line"], 5)
        self.assertTrue(reversed_["then"]["sha"])
        self.assertEqual(reversed_["note"], "From an extension to never.")
        self.assertIsNone(dropped["now"])
        self.assertIsNone(new["then"])
        self.assertEqual(held["then"]["path"], "notes/old-name.md")
        self.assertEqual([(r["side"], r.get("quote")) for r in data["rejected"]],
                         [("now", "Embeddings are mandatory"), ("then", "No embeddings in the engine"),
                          ("pair", None), ("lagging", "Embeddings rank the hits."),
                          ("lagging", "Embeddings: an opt-in extension.")])
        lagging, = data["lagging"]
        self.assertEqual((lagging["path"], lagging["last_modified"], lagging["echoes"]),
                         ("notes/roadmap.md", "2025-01-15", 0))
        self.assertEqual([m["date"] for m in data["moments"]], ["2025-01-15", "2025-03-10"])


if __name__ == "__main__":
    unittest.main()
