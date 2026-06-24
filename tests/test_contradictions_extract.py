"""Unit tests for extract_quantity_claims: prose quantities attached to salient anchors."""
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.pure import contradictions as c  # noqa: E402


def subject_values(text):
    return {(cl.subject, cl.value.number) for cl in c.extract_quantity_claims(text)}


class TestExtractQuantityClaims(unittest.TestCase):
    def test_quantity_attaches_to_salient_anchors(self):
        got = subject_values("Le timeout du webhook est de 30 s.")
        self.assertIn(("timeout", 30.0), got)
        self.assertIn(("webhook", 30.0), got)

    def test_drops_stopwords_units_and_currency(self):
        subs = {cl.subject for cl in c.extract_quantity_claims("Le plan coûte 29 EUR/mois.")}
        self.assertIn("plan", subs)
        self.assertNotIn("le", subs)    # stopword
        self.assertNotIn("eur", subs)   # currency code, not a subject

    def test_unit_word_is_not_an_anchor(self):
        subs = {cl.subject for cl in c.extract_quantity_claims("La marge est de 3 heures.")}
        self.assertIn("marge", subs)
        self.assertNotIn("heures", subs)  # unit word

    def test_three_letter_word_is_not_mistaken_for_currency(self):
        # 'SSO'/'pro'/'API' upper-cased look like ISO codes; they must stay valid subjects.
        subs = {cl.subject for cl in c.extract_quantity_claims("Le SSO couvre 3 jours.")}
        self.assertIn("sso", subs)

    def test_no_quantity_no_claims(self):
        self.assertEqual(c.extract_quantity_claims("Pas de valeur chiffrée ici."), [])

    def test_bare_number_is_not_extracted(self):
        # ports and other unit-less numbers are out of scope at this level
        self.assertEqual(c.extract_quantity_claims("Le service écoute sur le port 8080."), [])

    def test_line_number_is_reported(self):
        claims = c.extract_quantity_claims("intro\nLe timeout est 30 s.\nfin")
        self.assertTrue(claims and all(cl.line == 2 for cl in claims))


if __name__ == "__main__":
    unittest.main()
