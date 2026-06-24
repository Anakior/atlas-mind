"""Unit tests for subject_key: the bucket key deciding what counts as 'the same subject'."""
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.pure import contradictions as c  # noqa: E402


class TestSubjectKey(unittest.TestCase):
    def test_normalizes_case_accents_emphasis(self):
        self.assertEqual(c.subject_key("**Port**"), "port")
        self.assertEqual(c.subject_key("  TIMEOUT  "), "timeout")
        self.assertEqual(c.subject_key("Base de Données"), "base de donnees")

    def test_drops_leading_articles(self):
        self.assertEqual(c.subject_key("Le Webhook"), "webhook")
        self.assertEqual(c.subject_key("The Webhook"), "webhook")
        self.assertEqual(c.subject_key("webhook"), "webhook")

    def test_same_subject_keys_collide(self):
        self.assertEqual(c.subject_key("L'API"), c.subject_key("api"))


if __name__ == "__main__":
    unittest.main()
