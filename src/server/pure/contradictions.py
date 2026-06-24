"""Typed value parsing and comparison for contradiction detection.

Parses a raw value string into a unit-canonical Value, then compare() tells
"30 s" == "0.5 min" apart from "30 s" != "2 min" without re-deriving units.
Pure stdlib; no CONFIG needed.
"""
import math
import re
from typing import NamedTuple, Optional

import server as _s  # _normalize_text facade (lowercase + accent-fold)


SAME = "same"
INCOMPATIBLE = "incompatible"  # comparable but divergent → a contradiction candidate
UNRELATED = "unrelated"        # not comparable: different kind, dimension, or currency


class Value(NamedTuple):
    kind: str                  # "quantity" | "number" | "bool" | "text"
    number: Optional[float]    # canonical magnitude (base unit) for quantity/number
    unit: str                  # canonical unit of a quantity ("s", "byte", "ratio", "EUR"), else ""
    dimension: str             # "time" | "data" | "ratio" | "money", else ""
    text: str                  # normalized token for bool/text, else ""


# Factor to a base unit per dimension, so magnitudes compare whatever unit they were written in.
# Abbreviations/symbols + the common FR/EN spellings (the engine's two languages), kept bounded.
_TIME = {  # base: second
    "ms": 1e-3, "s": 1, "sec": 1, "second": 1, "seconds": 1, "seconde": 1, "secondes": 1,
    "mn": 60, "min": 60, "minute": 60, "minutes": 60,
    "h": 3600, "heure": 3600, "heures": 3600, "hour": 3600, "hours": 3600,
    "j": 86400, "d": 86400, "jour": 86400, "jours": 86400, "day": 86400, "days": 86400,
}
_DATA = {  # base: byte
    "o": 1, "b": 1, "octet": 1, "octets": 1, "byte": 1, "bytes": 1,
    "ko": 1024, "kb": 1024, "mo": 1024 ** 2, "mb": 1024 ** 2,
    "go": 1024 ** 3, "gb": 1024 ** 3, "to": 1024 ** 4, "tb": 1024 ** 4,
}
_RATIO = {"%": 0.01, "pourcent": 0.01, "percent": 0.01}  # base: fraction
_DIMENSIONS = (("time", _TIME, "s"), ("data", _DATA, "byte"), ("ratio", _RATIO, "ratio"))
# Money has no cross-unit factor: keep the amount, canonicalize only the currency.
# Symbols and common FR/EN names map to their ISO code; any uppercase 3-letter code is
# taken as-is, so every ISO 4217 currency also works without a list (see _currency_code).
_CURRENCY_SYMBOL = {"€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY"}
_CURRENCY_NAME = {"euro": "EUR", "euros": "EUR", "dollar": "USD", "dollars": "USD"}

# "1"/"0" stay out: they are numbers, not booleans.
_TRUE = {"true", "vrai", "oui", "yes", "on"}
_FALSE = {"false", "faux", "non", "no", "off"}

# Permissive number: any whitespace (incl. nbsp) groups thousands, ./, separate decimals.
_NUMBER = r"-?\d[\d\s.,]*\d|-?\d"
_NUM_RE = re.compile(_NUMBER)
_QTY_RE = re.compile(r"(?P<num>" + _NUMBER + r")\s*(?P<unit>[%€$£¥]|[a-zµ]+)", re.I)


def parse_number(raw: str) -> Optional[float]:
    """Locale-tolerant magnitude. Spaces/nbsp group thousands; a lone comma is a
    decimal point (FR); with both '.' and ',' present, the rightmost is decimal."""
    m = _NUM_RE.search(raw)
    if not m:
        return None
    s = re.sub(r"\s", "", m.group(0))
    if "." in s and "," in s:
        sep = "." if s.rfind(".") > s.rfind(",") else ","
        s = s.replace("," if sep == "." else ".", "").replace(sep, ".")
    else:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _currency_code(token: str) -> Optional[str]:
    """A currency symbol, common FR/EN name, or ISO 4217 code → canonical code, else
    None. Any uppercase 3-letter code is accepted, so all currencies work without a list."""
    if token in _CURRENCY_SYMBOL:
        return _CURRENCY_SYMBOL[token]
    if token.lower() in _CURRENCY_NAME:
        return _CURRENCY_NAME[token.lower()]
    if len(token) == 3 and token.isalpha() and token.isupper():
        return token
    return None


def parse_quantity(raw: str) -> Optional[Value]:
    """A number immediately followed by a known unit, normalized to its base unit.
    None when no unit is recognized — a bare number is not a quantity."""
    m = _QTY_RE.match(raw.strip().lstrip("~≈ ").strip())
    if not m:
        return None
    n = parse_number(m.group("num"))
    if n is None:
        return None
    raw_unit = m.group("unit")
    unit = raw_unit.lower()
    for dim, table, base in _DIMENSIONS:
        if unit in table:
            return Value("quantity", n * table[unit], base, dim, "")
    code = _currency_code(raw_unit)
    if code:
        return Value("quantity", n, code, "money", "")
    return None


def parse_bool(raw: str) -> Optional[bool]:
    t = raw.strip().lower()
    if t in _TRUE:
        return True
    if t in _FALSE:
        return False
    return None


def parse_value(raw: str) -> Optional[Value]:
    """Most specific typed reading: quantity > number > bool > text (a normalized
    categorical fallback). None for empty input."""
    if not raw or not raw.strip():
        return None
    s = raw.strip()
    quantity = parse_quantity(s)
    if quantity is not None:
        return quantity
    if re.fullmatch(r"[-\d\s.,]+", s):
        number = parse_number(s)
        if number is not None:
            return Value("number", number, "", "", "")
    flag = parse_bool(s)
    if flag is not None:
        return Value("bool", None, "", "", "true" if flag else "false")
    return Value("text", None, "", "", _s._normalize_text(s))


def _magnitudes_match(x: Optional[float], y: Optional[float], rel_tol: float, abs_tol: float) -> bool:
    return x is not None and y is not None and math.isclose(x, y, rel_tol=rel_tol, abs_tol=abs_tol)


def compare(a: Optional[Value], b: Optional[Value], *, rel_tol: float = 1e-9, abs_tol: float = 1e-9) -> str:
    """Verdict on two parsed values: SAME (equal after canonicalization),
    INCOMPATIBLE (comparable but divergent — a contradiction candidate), or
    UNRELATED (not comparable). Tolerances absorb formatting/rounding noise only,
    so real divergences surface for the downstream judge."""
    if a is None or b is None or a.kind != b.kind:
        return UNRELATED
    if a.kind in ("text", "bool"):
        return SAME if a.text == b.text else INCOMPATIBLE
    if a.kind == "number":
        return SAME if _magnitudes_match(a.number, b.number, rel_tol, abs_tol) else INCOMPATIBLE
    if a.kind == "quantity":
        if a.dimension != b.dimension or a.unit != b.unit:
            return UNRELATED  # different dimension, or different currency (no conversion)
        return SAME if _magnitudes_match(a.number, b.number, rel_tol, abs_tol) else INCOMPATIBLE
    return UNRELATED
