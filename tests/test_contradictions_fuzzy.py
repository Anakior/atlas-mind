"""Fuzzy anchor matching: typo-variant subjects pool so a contradiction whose anchor is
mistyped in one doc is still found; distinct short words stay apart."""
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import server as _s              # noqa: E402
from config import AtlasConfig   # noqa: E402
from server.pure import contradictions as c  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "contradictions_kb"


class TestFuzzyCanon(unittest.TestCase):
    def test_merges_typo_variants(self):
        canon = c._fuzzy_canon(["timeout", "timeoout", "paiement", "paiment"])
        self.assertEqual(canon["timeout"], canon["timeoout"])
        self.assertEqual(canon["paiement"], canon["paiment"])

    def test_keeps_distinct_subjects_apart(self):
        canon = c._fuzzy_canon(["timeout", "webhook", "abonnement"])
        self.assertEqual(len(set(canon.values())), 3)

    def test_short_words_are_not_merged(self):
        canon = c._fuzzy_canon(["port", "sort", "tort"])
        self.assertEqual(len(set(canon.values())), 3)


class TestFuzzyEndToEnd(unittest.TestCase):
    def test_typo_anchor_contradiction_is_found(self):
        # delai-a / delai-b share no exact token (delai/delais, paiement/paiment) — only fuzzy finds it.
        _s.CONFIG = AtlasConfig.load(root=FIXTURE, env={})
        pairs = {frozenset((x["a"], x["b"])) for x in c.find_contradictions(None, 100)}
        self.assertIn(frozenset(("delai-a.md", "delai-b.md")), pairs)        # numeric tier
        self.assertIn(frozenset(("auth-a.md", "auth-b.md")), pairs)          # categorical tier


if __name__ == "__main__":
    unittest.main()
