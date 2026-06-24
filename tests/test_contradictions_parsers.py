"""Unit tests for the typed value parsers: number parsing, unit canonicalization,
booleans, and the parse_value dispatch."""
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.pure import contradictions as c  # noqa: E402

NBSP = chr(0xa0)  # no-break space, a common thousands separator in FR typography


class TestParseNumber(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(c.parse_number("29"), 29.0)
        self.assertEqual(c.parse_number("8799"), 8799.0)

    def test_whitespace_grouping(self):
        self.assertEqual(c.parse_number("8 799"), 8799.0)            # regular space
        self.assertEqual(c.parse_number("8" + NBSP + "799"), 8799.0)  # no-break space

    def test_decimal_separators(self):
        self.assertEqual(c.parse_number("29,5"), 29.5)               # FR comma decimal
        self.assertEqual(c.parse_number("1 000,50"), 1000.5)
        self.assertEqual(c.parse_number("1.000,50"), 1000.5)         # EU grouped
        self.assertEqual(c.parse_number("1,234.56"), 1234.56)        # US grouped

    def test_not_a_number(self):
        self.assertIsNone(c.parse_number("abc"))
        self.assertIsNone(c.parse_number(""))


class TestParseQuantity(unittest.TestCase):
    def test_time_canonical_to_seconds(self):
        self.assertEqual(c.parse_quantity("30 s").number, 30.0)
        self.assertEqual(c.parse_quantity("0.5 min").number, 30.0)      # same as 30 s
        self.assertAlmostEqual(c.parse_quantity("200 ms").number, 0.2)

    def test_dimensions(self):
        self.assertEqual(c.parse_quantity("2 Go").dimension, "data")
        self.assertEqual(c.parse_quantity("2 Go").number, 2 * 1024 ** 3)
        self.assertAlmostEqual(c.parse_quantity("50 %").number, 0.5)

    def test_money_keeps_currency_without_conversion(self):
        v = c.parse_quantity("29 EUR/mois")
        self.assertEqual((v.number, v.unit, v.dimension), (29.0, "EUR", "money"))
        self.assertEqual(c.parse_quantity("39 EUR").number, 39.0)

    def test_currency_by_symbol_code_or_fr_en_name(self):
        self.assertEqual(c.parse_quantity("100 CHF").unit, "CHF")   # ISO code, no list needed
        self.assertEqual(c.parse_quantity("100 CHF").dimension, "money")
        self.assertEqual(c.parse_quantity("29 £").unit, "GBP")      # symbol → ISO code
        self.assertEqual(c.parse_quantity("29 euros").unit, "EUR")  # FR name → ISO code
        self.assertIsNone(c.parse_quantity("29 bananes"))           # not a currency

    def test_units_accept_abbreviations_and_fr_en_words(self):
        self.assertEqual(c.parse_quantity("3 h").number, 10800.0)        # abbreviation
        self.assertEqual(c.parse_quantity("3 heures").number, 10800.0)   # FR word
        self.assertEqual(c.parse_quantity("3 hours").number, 10800.0)    # EN word
        self.assertEqual(c.parse_quantity("200 octets").number, 200.0)   # FR word
        self.assertIsNone(c.parse_quantity("3 fortnights"))             # outside the bounded set

    def test_bare_number_or_text_is_not_a_quantity(self):
        self.assertIsNone(c.parse_quantity("8799"))
        self.assertIsNone(c.parse_quantity("PostgreSQL"))


class TestParseBool(unittest.TestCase):
    def test_truthy_falsy_bilingual(self):
        self.assertIs(c.parse_bool("oui"), True)
        self.assertIs(c.parse_bool("Non"), False)
        self.assertIs(c.parse_bool("true"), True)
        self.assertIsNone(c.parse_bool("maybe"))
        self.assertIsNone(c.parse_bool("1"))  # a number, not a boolean


class TestParseValueDispatch(unittest.TestCase):
    def test_most_specific_kind_wins(self):
        self.assertEqual(c.parse_value("30 s").kind, "quantity")
        self.assertEqual(c.parse_value("8799").kind, "number")
        self.assertEqual(c.parse_value("oui").kind, "bool")
        self.assertEqual(c.parse_value("PostgreSQL"), c.Value("text", None, "", "", "postgresql"))
        self.assertIsNone(c.parse_value("   "))

    def test_canonicalization_enables_same_and_keeps_real_divergence(self):
        self.assertEqual(c.parse_value("30 s").number, c.parse_value("0.5 min").number)
        self.assertNotEqual(c.parse_value("30 s").number, c.parse_value("60 s").number)


if __name__ == "__main__":
    unittest.main()
