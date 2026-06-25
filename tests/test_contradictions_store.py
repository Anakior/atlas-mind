"""Span-bound verdict validation: a verdict survives edits elsewhere in a doc and only
resurfaces when the JUDGED line content changes. Pure (no CONFIG / no IO)."""
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.pure import contradictions_store as store  # noqa: E402

SPAN_ENTRY = {"a": "a.md", "b": "b.md", "verdict": "none",
              "a_hash": "DA", "b_hash": "DB", "a_span": "SA", "b_span": "SB"}
PLAIN_ENTRY = {"a": "a.md", "b": "b.md", "verdict": "real", "a_hash": "DA", "b_hash": "DB"}


class TestVerdictHolds(unittest.TestCase):
    def test_span_holds_despite_edits_elsewhere(self):
        # Both doc hashes changed (edits elsewhere) but the judged spans still exist -> holds.
        self.assertEqual(
            store.verdict_holds(SPAN_ENTRY, "CHANGED", "CHANGED", {"SA", "x"}, {"SB", "y"}),
            "none")

    def test_span_invalid_when_judged_line_changed(self):
        # A judged span no longer present -> resurfaces (verdict dropped).
        self.assertIsNone(store.verdict_holds(SPAN_ENTRY, "DA", "DB", {"gone"}, {"SB"}))

    def test_falls_back_to_doc_hash_without_spans(self):
        self.assertEqual(store.verdict_holds(PLAIN_ENTRY, "DA", "DB"), "real")
        self.assertIsNone(store.verdict_holds(PLAIN_ENTRY, "DA", "CHANGED"))

    def test_none_entry_is_unjudged(self):
        self.assertIsNone(store.verdict_holds(None, "DA", "DB"))


class TestLineHashes(unittest.TestCase):
    def test_uses_stripped_nonblank_lines(self):
        h = store.line_hashes("  foo  \n\nbar\n")
        self.assertEqual(h, {store.doc_hash("foo"), store.doc_hash("bar")})


class TestIntraDocPair(unittest.TestCase):
    def test_rel_rel_with_distinct_spans_round_trips(self):
        # An intra-doc (a==b) verdict binds on the two span hashes; _pair(rel,rel)=(rel,rel)
        # and verdict_holds returns it only while BOTH judged lines still exist.
        rel = "roadmap.md"
        dh = store.doc_hash("whole doc")
        sa, sb = store.doc_hash("table row livré"), store.doc_hash("body line à trancher")
        self.assertNotEqual(sa, sb)
        entry = {"a": rel, "b": rel, "verdict": "real", "a_hash": dh, "b_hash": dh,
                 "a_span": sa, "b_span": sb}
        idx = store.verdict_index([entry])
        self.assertEqual(store._pair(rel, rel), (rel, rel))
        self.assertIn((rel, rel), idx)
        self.assertEqual(store.verdict_holds(idx[(rel, rel)], dh, dh, {sa, "x"}, {sb, "y"}), "real")
        self.assertIsNone(store.verdict_holds(idx[(rel, rel)], dh, dh, {sa}, {"gone"}))


if __name__ == "__main__":
    unittest.main()
