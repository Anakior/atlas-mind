"""Unit tests for the cosine clustering engine internals: tokenizer, noise strip, exact-cosine
ranker, union-find rooting, oversize drop-weakest, the per-doc vector cap, and the table number
parser. Pure (no CONFIG / no IO): each function is exercised directly."""
import math
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

from server.pure import contradictions as c  # noqa: E402


def _unit(d):
    n = math.sqrt(sum(v * v for v in d.values())) or 1.0
    return {k: v / n for k, v in d.items()}


class TestTokenize(unittest.TestCase):
    def test_non_latin_kept(self):
        self.assertEqual(c._tokenize("Привет мир контракт"), ["привет", "мир", "контракт"])
        self.assertEqual(c._tokenize("契約 文書 比較"), ["契約", "文書", "比較"])

    def test_ascii_len_floor(self):
        # Short ASCII noise dropped; the floor does NOT apply to non-ASCII (covered above).
        self.assertNotIn("ab", c._tokenize("ab cat"))
        self.assertIn("cat", c._tokenize("ab cat"))

    def test_drops_digits_underscores_and_stopwords(self):
        toks = c._tokenize("the 13d ___ 9000 contract value")
        self.assertNotIn("the", toks)        # stopword
        self.assertNotIn("13d", toks)        # leading digit -> not a word start
        self.assertNotIn("9000", toks)       # pure digits
        self.assertEqual(set(toks), {"contract", "value"})


class TestStripNoise(unittest.TestCase):
    def test_fenced_and_inline(self):
        text = ("keep1\n```\ncodeA\n```\nkeep2 `inlineX` keep3\n~~~\ncodeB\n~~~\nkeep4")
        out = c._strip_noise("d.md", text)
        for k in ("keep1", "keep2", "keep3", "keep4"):
            self.assertIn(k, out)
        for bad in ("codeA", "codeB", "inlineX"):
            self.assertNotIn(bad, out)

    def test_html_runs_before_fence(self):
        # An .html doc whose visible text (after tag strip) holds a fenced block: the fence
        # strip must run AFTER _html_to_text, so the rendered code is still removed.
        html = "<p>visible alpha</p><div>``` secretcode ``` visible beta</div>"
        out = c._strip_noise("page.html", html)
        self.assertIn("alpha", out)
        self.assertIn("beta", out)
        self.assertNotIn("secretcode", out)


class TestScorePairs(unittest.TestCase):
    def test_exact_cosine_and_mutual_relative(self):
        # cos(a,b) = 0.6*0.8 + 0.8*0.6 = 0.96; each doc's best match is the other -> ra=rb=1.
        vectors = {"a": _unit({"x": 6.0, "y": 8.0}), "b": _unit({"x": 8.0, "y": 6.0})}
        edges = c._score_pairs({("a", "b")}, vectors)
        self.assertEqual(set(edges), {("a", "b")})
        self.assertAlmostEqual(edges[("a", "b")], 1.0, places=6)

    def test_cos_floor_drops_incidental_overlap(self):
        # A single weak shared dimension below _COS_FLOOR yields no edge.
        vectors = {"a": _unit({"shared": 0.01, "p": 1.0}),
                   "b": _unit({"shared": 0.01, "q": 1.0})}
        self.assertEqual(c._score_pairs({("a", "b")}, vectors), {})

    def test_relative_score_is_sqrt_of_ratios(self):
        # a's best match is c (cos 1.0); a-b cosine is weaker, so ra<1 pulls the edge below 1.
        a = _unit({"core": 1.0, "p": 1.0})
        b = _unit({"core": 1.0})
        cc = _unit({"core": 1.0, "p": 1.0})
        vectors = {"a": a, "b": b, "c": cc}
        edges = c._score_pairs({("a", "b"), ("a", "c"), ("b", "c")}, vectors)
        cos_ab = sum(w * b.get(t, 0.0) for t, w in a.items())
        cos_ac = sum(w * cc.get(t, 0.0) for t, w in a.items())
        cos_bc = sum(w * cc.get(t, 0.0) for t, w in b.items())
        maxa = max(cos_ab, cos_ac)
        maxb = max(cos_ab, cos_bc)
        ra, rb = cos_ab / maxa, cos_ab / maxb
        self.assertAlmostEqual(edges[("a", "b")], math.sqrt(ra * rb), places=6)


class TestClusterFormation(unittest.TestCase):
    def test_union_find_groups_one_component(self):
        # Four docs all sharing one rare term: one connected component, all in cluster_id 0.
        vectors = {
            "z_d.md": _unit({"core": 1.0, "dd": 0.3}),
            "y_c.md": _unit({"core": 1.0, "cc": 0.3}),
            "x_b.md": _unit({"core": 1.0, "bb": 0.3}),
            "a_a.md": _unit({"core": 1.0, "aa": 0.3}),
        }
        df = {"core": 4, "aa": 1, "bb": 1, "cc": 1, "dd": 1}
        rows = c._cluster_candidates(vectors, df, 4)
        self.assertEqual({r["cluster_id"] for r in rows}, {0})
        self.assertTrue(all(r["cluster_size"] == 4 for r in rows))

    def test_components_returns_every_group_sorted(self):
        # Two disjoint pairs -> two components, each sorted, smallest-member first. The result
        # is independent of edge order (union-find rooted to min, output sorted).
        nodes = ["b.md", "a.md", "d.md", "c.md"]
        pairs = [("c.md", "d.md"), ("a.md", "b.md")]
        self.assertEqual(c._components(nodes, pairs),
                         [["a.md", "b.md"], ["c.md", "d.md"]])

    def test_oversize_split_keeps_both_subclusters(self):
        # Two tight pairs (a-b, c-d) held in ONE component only by weaker cross edges (shared
        # 'co'). With _CLUSTER_MAX=2 the cross edges are shed first; BOTH surviving pairs must
        # be emitted; the smaller sub-cluster is never dropped (regression for drop-weakest).
        orig = c._CLUSTER_MAX
        c._CLUSTER_MAX = 2
        try:
            vectors = {
                "a.md": _unit({"ab": 0.5, "co": 0.7, "ua": 0.51}),
                "b.md": _unit({"ab": 0.5, "co": 0.7, "ub": 0.51}),
                "c.md": _unit({"cd": 0.5, "co": 0.7, "uc": 0.51}),
                "d.md": _unit({"cd": 0.5, "co": 0.7, "ud": 0.51}),
            }
            df = {"co": 4, "ab": 2, "cd": 2, "ua": 1, "ub": 1, "uc": 1, "ud": 1}
            rows = c._cluster_candidates(vectors, df, 4)
            pairs = {frozenset((r["a"], r["b"])) for r in rows}
            self.assertEqual(pairs,
                             {frozenset(("a.md", "b.md")), frozenset(("c.md", "d.md"))})
            self.assertTrue(all(r["cluster_size"] == 2 for r in rows))
        finally:
            c._CLUSTER_MAX = orig

    def test_cluster_max_drops_weakest_edges(self):
        # With _CLUSTER_MAX shrunk to 2, an oversize component sheds its weakest edges until
        # only the strongest-connected pair remains.
        orig = c._CLUSTER_MAX
        c._CLUSTER_MAX = 2
        try:
            vectors = {
                "a_a.md": _unit({"core": 1.0, "p": 0.9}),
                "b_b.md": _unit({"core": 1.0, "p": 0.9}),  # a-b carries the shared rare 'p'
                "c_c.md": _unit({"core": 1.0}),            # weakest link
            }
            df = {"core": 3, "p": 2}
            rows = c._cluster_candidates(vectors, df, 3)
            self.assertEqual(len(rows), 1)
            self.assertEqual({rows[0]["a"], rows[0]["b"]}, {"a_a.md", "b_b.md"})
            self.assertEqual(rows[0]["cluster_size"], 2)
        finally:
            c._CLUSTER_MAX = orig


class TestVecCap(unittest.TestCase):
    def test_evicts_lowest_idf_keeping_rarest(self):
        # Cap to 2 terms/doc: the rarest (highest-idf) terms are retained, the ubiquitous one
        # (lowest idf) is evicted. tf is held at 1 so the ranking is pure idf.
        orig = c._VEC_CAP
        c._VEC_CAP = 2
        try:
            clean = [("doc.md", "doc.md", "ccommon rrare1 rrare2")]
            for i in range(8):
                clean.append((f"pad{i}.md", f"pad{i}.md", f"ccommon w{i}"))
            clean.append(("r1.md", "r1.md", "rrare1 z1"))
            clean.append(("r2.md", "r2.md", "rrare2 z2"))
            vectors, df, _N = c._corpus_vectors(clean)
            self.assertGreater(df["ccommon"], df["rrare1"])
            kept = set(vectors["doc.md"])
            self.assertEqual(len(kept), 2)
            self.assertNotIn("ccommon", kept)            # lowest idf evicted
            self.assertEqual(kept, {"rrare1", "rrare2"})  # rarest retained
        finally:
            c._VEC_CAP = orig


class TestParseNum(unittest.TestCase):
    def test_whitespace_thousands(self):
        self.assertEqual(c._parse_num("1 114"), 1114.0)

    def test_lone_comma_is_decimal(self):
        self.assertEqual(c._parse_num("3,5"), 3.5)
        self.assertEqual(c._parse_num("1,234"), 1.234)  # a lone comma reads as a decimal point

    def test_rejects_units(self):
        self.assertIsNone(c._parse_num("13d"))
        self.assertIsNone(c._parse_num("12 px"))
        self.assertIsNone(c._parse_num("abc"))

    def test_plain_integer(self):
        self.assertEqual(c._parse_num("1105"), 1105.0)

    def test_fr_narrow_and_thin_space_thousands(self):
        # Modern FR formatting uses U+202F (Intl/Office) and U+2009 as the thousands sep; both
        # must parse, else _detect_table_drift treats the cell as text and skips a real drift.
        self.assertEqual(c._parse_num("1 114"), 1114.0)   # narrow no-break space
        self.assertEqual(c._parse_num("1 114"), 1114.0)   # thin space
        self.assertEqual(c._parse_num("1 114"), 1114.0)   # no-break space


class TestPolarityBoundaries(unittest.TestCase):
    """Polarity phrases are word-boundary anchored: short markers like 'on'/'off'/'fait' must
    not fire inside ordinary words, and 'complete' must not match inside 'incomplete'."""
    def _entry(self, positive_word):
        for pos_re, neg_re in c._POLARITY_RE:
            if pos_re.search(positive_word):
                return pos_re, neg_re
        return None, None

    def test_short_markers_not_matched_inside_words(self):
        on_pos, on_neg = next((p, n) for p, n in c._POLARITY_RE if p.search("on"))
        for word in ("maison", "fonctionne", "facturation", "option", "connexion"):
            self.assertIsNone(on_pos.search(word), word)
        for word in ("effort", "officiel"):
            self.assertIsNone(on_neg.search(word), word)

    def test_complete_not_matched_inside_incomplete(self):
        pos_re, _neg = self._entry("complete")
        self.assertIsNotNone(pos_re)
        self.assertIsNone(pos_re.search("incomplete"))  # would be a polarity sense inversion
        self.assertIsNotNone(pos_re.search("the feature is complete"))


if __name__ == "__main__":
    unittest.main()
