"""Typed value parsing and comparison for contradiction detection (pure stdlib).

Values are canonicalized to a base unit so compare() needn't re-derive units.
"""
import difflib
import math
import re
from collections import Counter, defaultdict
from typing import NamedTuple, Optional

import server as _s  # _normalize_text (accent-fold + lowercase)


SAME = "same"
INCOMPATIBLE = "incompatible"  # comparable but divergent → a contradiction candidate
UNRELATED = "unrelated"        # not comparable (different kind, dimension, or currency)


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
# Money: no cross-unit factor — keep the amount, canonicalize the currency. Any uppercase
# 3-letter token is taken as an ISO code, so all currencies work without a list to maintain.
_CURRENCY_SYMBOL = {"€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY"}
_CURRENCY_NAME = {"euro": "EUR", "euros": "EUR", "dollar": "USD", "dollars": "USD"}

_TRUE = {"true", "vrai", "oui", "yes", "on"}   # "1"/"0" stay out: numbers, not booleans
_FALSE = {"false", "faux", "non", "no", "off"}

# Thousands grouping may be any whitespace (incl. nbsp); ./, separate decimals.
_NUMBER = r"-?\d[\d\s.,]*\d|-?\d"
_NUM_RE = re.compile(_NUMBER)
_QTY_RE = re.compile(r"(?P<num>" + _NUMBER + r")\s*(?P<unit>[%€$£¥]|[a-zµ]+)", re.I)


def parse_number(raw: str) -> Optional[float]:
    """Locale rule: whitespace groups thousands; a lone comma is the decimal point;
    with both '.' and ',' the rightmost is the decimal."""
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
    """Currency symbol, FR/EN name, or uppercase ISO code → canonical code, else None."""
    if token in _CURRENCY_SYMBOL:
        return _CURRENCY_SYMBOL[token]
    if token.lower() in _CURRENCY_NAME:
        return _CURRENCY_NAME[token.lower()]
    if len(token) == 3 and token.isalpha() and token.isupper():
        return token
    return None


def parse_quantity(raw: str) -> Optional[Value]:
    """A number followed by a known unit, normalized to its base. None if no unit —
    a bare number is not a quantity."""
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
    """Most specific reading: quantity > number > bool > text. None for empty input."""
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
    """SAME / INCOMPATIBLE / UNRELATED. Tolerances absorb formatting noise, not real
    differences, so genuine divergences surface."""
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


_ARTICLES = {"le", "la", "les", "l", "un", "une", "des", "du", "de", "the", "a", "an"}


def subject_key(text: str) -> str:
    """Bucket key for a subject phrase: accent-folded, lowercased, emphasis stripped,
    leading articles dropped (so 'Le Webhook' and '**webhook**' match)."""
    words = re.findall(r"[a-z0-9]+", _s._normalize_text(text))
    while words and words[0] in _ARTICLES:
        words.pop(0)
    return " ".join(words)


# Bounded FR/EN function words, dropped from anchors so buckets aren't dominated by "le/of/est".
_STOPWORDS = set(
    "le la les l un une de des du au aux et ou ni mais donc car ce cet cette ces son sa ses "
    "leur leurs il elle ils elles on nous vous je tu se y en a dans sur sous par pour avec sans "
    "vers chez entre est sont etre ete suis es ont ai as avons avez que qui quoi dont ou ne pas "
    "plus tres si comme aussi the an of to in on at by for with from as is are be been was were "
    "has have had do does did this that these those it its they we you i and or but not no so if "
    "then than too very".split()
)
_UNIT_WORDS = set(_TIME) | set(_DATA) | set(_RATIO) | set(_CURRENCY_NAME)


class Claim(NamedTuple):
    subject: str   # subject_key of the anchor the value attaches to
    value: Value
    line: int
    raw: str       # the value as written, for evidence


def _anchors(line: str) -> list:
    """Salient words of a line (non-stopword, non-unit), deduped in order — the
    candidate subjects a value on that line could be about."""
    out, seen = [], set()
    for tok in re.findall(r"[^\W\d_]+", line):
        low = _s._normalize_text(tok)
        if len(low) < 3 or low in _STOPWORDS or low in _UNIT_WORDS or low in seen:
            continue
        seen.add(low)
        out.append(low)
    return out


def extract_quantity_claims(text: str) -> list:
    """Prose quantities (number+unit; bare numbers excluded), each attached to the
    salient words of its line as candidate subjects (recall-first)."""
    claims = []
    for i, line in enumerate(text.splitlines(), start=1):
        matches = list(_QTY_RE.finditer(line))
        if not matches:
            continue
        # Anchor on the line minus the number+unit spans, so a glued unit ("EUR", "s") is
        # never taken as a subject — an isolated 3-letter word ("SSO") still is.
        blanked = line
        for m in matches:
            blanked = blanked[:m.start()] + " " * (m.end() - m.start()) + blanked[m.end():]
        anchors = _anchors(blanked)
        for m in matches:
            value = parse_quantity(m.group(0))
            if value is not None:
                for anchor in anchors:
                    claims.append(Claim(anchor, value, i, m.group(0).strip()))
    return claims


def _trigrams(word: str) -> set:
    p = f"  {word}  "
    return {p[i:i + 3] for i in range(len(p) - 2)}


def _fuzzy_canon(keys) -> dict:
    """Map each subject to a canonical one, merging typo-variants (timeout/timeoout) so
    their claims pool. Trigram-blocked then difflib-confirmed; keys under 5 chars aren't
    merged (a one-char gap between short words is usually two words, not a typo)."""
    grams = {k: _trigrams(k) for k in keys}
    by_gram = defaultdict(list)
    for k in keys:
        for g in grams[k]:
            by_gram[g].append(k)
    parent = {k: k for k in keys}

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    seen = set()
    for k in keys:
        if len(k) < 5:
            continue
        for c in {c for g in grams[k] for c in by_gram[g] if len(c) >= 5 and c != k}:
            pair = (k, c) if k < c else (c, k)
            if pair in seen:
                continue
            seen.add(pair)
            if difflib.SequenceMatcher(None, k, c).ratio() >= 0.85:
                ra, rb = root(k), root(c)
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)  # smaller key = stable representative
    return {k: root(k) for k in keys}


def find_value_contradictions(ctx=None, limit: int = 50, corpus=None) -> list:
    """Cross-doc collisions of typed values on a shared subject: two docs with
    INCOMPATIBLE values under the same anchor. Each candidate carries the values + lines."""
    if corpus is None:
        from server.pure import queries  # lazy: avoids an import cycle at module load
        corpus = queries._doc_corpus(ctx)
    by_subject = {}  # subject -> {rel: first Claim in that doc}
    for rel, _name, text in corpus:
        for claim in extract_quantity_claims(text):
            by_subject.setdefault(claim.subject, {}).setdefault(rel, claim)

    canon = _fuzzy_canon(list(by_subject))  # pool typo-variant anchors before colliding
    pooled = {}
    for subject, per_doc in by_subject.items():
        bucket = pooled.setdefault(canon[subject], {})
        for rel, claim in per_doc.items():
            bucket.setdefault(rel, claim)

    cap = max(3, len(corpus) // 2)  # skip ubiquitous anchors (low idf = generic noise)
    out, seen = [], set()
    for subject, per_doc in pooled.items():
        if not 2 <= len(per_doc) <= cap:
            continue
        items = sorted(per_doc.items())
        for i, (ra, ca) in enumerate(items):
            for rb, cb in items[i + 1:]:
                if compare(ca.value, cb.value) != INCOMPATIBLE or (subject, ra, rb) in seen:
                    continue
                seen.add((subject, ra, rb))
                out.append({
                    "a": ra, "b": rb, "subject": subject, "confidence": "high", "kind": "value-collision",
                    "a_value": ca.raw, "b_value": cb.raw, "a_line": ca.line, "b_line": cb.line,
                })
    out.sort(key=lambda c: (c["a"], c["b"], c["subject"]))
    return out[:limit]


_MIN_SHARED_ANCHORS = 2  # one shared rare word is coincidence; two means "same subject"


def _salient_tokens(text: str) -> set:
    # Content words only — a digit run (e.g. a port) is not a subject.
    return {t for t in re.findall(r"[a-z][a-z0-9]{2,}", _s._normalize_text(text))
            if t not in _STOPWORDS and t not in _UNIT_WORDS}


def find_shared_anchor_pairs(ctx=None, corpus=None) -> list:
    """Low-confidence pairs sharing rare terms (high idf): recovers categorical conflicts
    (PostgreSQL vs MongoDB) the typed generator can't reach. The AI judges."""
    if corpus is None:
        from server.pure import queries  # lazy: avoids an import cycle at module load
        corpus = queries._doc_corpus(ctx)
    df = Counter()
    doc_tokens = {}
    for rel, _name, text in corpus:
        toks = _salient_tokens(text)
        doc_tokens[rel] = toks
        df.update(toks)
    cap = max(3, len(corpus) // 10)  # a rare anchor is shared by few docs (high idf)
    token_docs = defaultdict(list)
    for rel, toks in doc_tokens.items():
        for t in toks:
            if 2 <= df[t] <= cap:
                token_docs[t].append(rel)
    shared = defaultdict(list)  # (a, b) -> [(df, anchor), ...]
    for t, docs in token_docs.items():
        docs.sort()
        for i, a in enumerate(docs):
            for b in docs[i + 1:]:
                shared[(a, b)].append((df[t], t))
    out = []
    for (a, b), terms in shared.items():
        if len(terms) < _MIN_SHARED_ANCHORS:
            continue
        terms.sort()
        d, anchor = terms[0]  # rarest shared term represents the pair
        out.append({"a": a, "b": b, "subject": anchor, "confidence": "low",
                    "kind": "shared-anchor", "shared_df": d, "shared_count": len(terms)})
    out.sort(key=lambda c: (-c["shared_count"], c["shared_df"], c["a"], c["b"]))
    return out


def find_contradictions(ctx=None, limit: int = 50, include_dismissed: bool = False) -> list:
    """High-confidence typed collisions, then low-confidence rare-anchor pairs. Applies
    the verdict cache: a pair dismissed 'none' is dropped (unless include_dismissed),
    a 'real' one annotated."""
    from server.pure import queries  # lazy: avoids an import cycle at module load
    corpus = queries._doc_corpus(ctx)
    high = find_value_contradictions(ctx, limit, corpus=corpus)
    high_pairs = {frozenset((h["a"], h["b"])) for h in high}
    low = [p for p in find_shared_anchor_pairs(ctx, corpus=corpus)
           if frozenset((p["a"], p["b"])) not in high_pairs]
    vindex = _s.verdict_index()
    hashes = {rel: _s.doc_hash(text) for rel, _name, text in corpus}
    lines = {rel: _s.line_hashes(text) for rel, _name, text in corpus}
    out = []
    for cand in high + low:
        a, b = cand["a"], cand["b"]
        verdict = _s.verdict_holds(vindex.get((a, b)), hashes.get(a, ""), hashes.get(b, ""),
                                   lines.get(a, frozenset()), lines.get(b, frozenset()))
        if verdict == "none" and not include_dismissed:
            continue
        cand["verdict"] = verdict
        out.append(cand)
    return out[:limit]
