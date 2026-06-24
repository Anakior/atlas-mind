"""Unit tests for the typed value comparator: SAME / INCOMPATIBLE / UNRELATED."""
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.pure import contradictions as c  # noqa: E402


def cmp(a, b):
    return c.compare(c.parse_value(a), c.parse_value(b))


class TestCompareSame(unittest.TestCase):
    def test_canonical_equivalents_are_same(self):
        self.assertEqual(cmp("30 s", "0.5 min"), c.SAME)          # unit canonicalization
        self.assertEqual(cmp("0.2 s", "200 ms"), c.SAME)          # float noise absorbed
        self.assertEqual(cmp("29 EUR", "29 EUR"), c.SAME)
        self.assertEqual(cmp("PostgreSQL", "postgresql"), c.SAME)  # case/accent fold
        self.assertEqual(cmp("oui", "yes"), c.SAME)               # bool, bilingual


class TestCompareIncompatible(unittest.TestCase):
    def test_real_divergences_are_incompatible(self):
        self.assertEqual(cmp("30 s", "60 s"), c.INCOMPATIBLE)
        self.assertEqual(cmp("29 EUR", "39 EUR"), c.INCOMPATIBLE)
        self.assertEqual(cmp("PostgreSQL", "MongoDB"), c.INCOMPATIBLE)
        self.assertEqual(cmp("obligatoire", "optionnel"), c.INCOMPATIBLE)
        self.assertEqual(cmp("oui", "non"), c.INCOMPATIBLE)
        self.assertEqual(cmp("15 j", "20 j"), c.INCOMPATIBLE)


class TestCompareUnrelated(unittest.TestCase):
    def test_not_comparable_is_unrelated(self):
        self.assertEqual(cmp("30 s", "2 Go"), c.UNRELATED)        # different dimension
        self.assertEqual(cmp("29 EUR", "29 USD"), c.UNRELATED)    # different currency, no conversion
        self.assertEqual(cmp("30 s", "PostgreSQL"), c.UNRELATED)  # different kind
        self.assertEqual(cmp("8799", "30 s"), c.UNRELATED)        # bare number vs quantity

    def test_none_is_unrelated(self):
        self.assertEqual(c.compare(None, c.parse_value("30 s")), c.UNRELATED)


if __name__ == "__main__":
    unittest.main()
