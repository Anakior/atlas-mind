"""Golden tests for the cluster+detector contradiction engine.

A small SYNTHETIC mind, sized so _REL_FLOOR=0.50 passes (the fixture is built around the
constant, never the constant tuned to a corpus). Three ground-truth pairs surface (one as
table-drift, two as cosine clusters) plus the deterministic detectors, the merge/dedup rule,
confidence semantics, volume, determinism and the memory-bound proofs.
"""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import server as _s                            # noqa: E402
from config import AtlasConfig                 # noqa: E402
from server.pure import contradictions as c    # noqa: E402
from server.pure import contradictions_store as store  # noqa: E402
from server.pure import mcp_call               # noqa: E402

T = "```"  # fence token, kept out of the corpus strings below


# --- ground-truth pairs ---------------------------------------------------------------------
BILAN_A = (
    "# Bilan activite trimestriel klaynette\n\n"
    "Recapitulatif des indicateurs klaynette pour le trimestre.\n\n"
    "| metrique | valeur |\n"
    "|---|---|\n"
    "| boutiques | 1114 |\n"
    "| commandes | 5300 |\n"
    "| revenu | 8200 |\n"
)
BILAN_B = (
    "# Bilan activite trimestriel klaynette\n\n"
    "Recapitulatif des indicateurs klaynette pour le trimestre.\n\n"
    "| metrique | valeur |\n"
    "|---|---|\n"
    "| boutiques | 1105 |\n"
    "| commandes | 5300 |\n"
    "| revenu | 8200 |\n"
)
KLAYN_A = (
    "# Architecture klayn\n\n"
    "Le moteur klayn utilise un orchestrateur souverain pour le routage.\n"
    "L orchestrateur klayn delegue le routage souverain aux noeuds.\n"
)
KLAYN_B = (
    "# Notes klayn\n\n"
    "Klayn et son orchestrateur souverain assurent le routage.\n"
    "Le routage souverain de klayn passe par l orchestrateur.\n"
)
POE1_A = (
    "# Build poe1 necromancien\n\n"
    "Le necromancien poe1 invoque des squelettes avec une aura de fragilite.\n"
    "Aura de fragilite et squelettes definissent le necromancien poe1.\n"
)
POE1_B = (
    "# Guide poe1\n\n"
    "Necromancien poe1: squelettes nombreux sous aura de fragilite.\n"
    "La fragilite affaiblit, les squelettes du necromancien frappent.\n"
)

# --- detectors ------------------------------------------------------------------------------
SSO_SPEC = (
    "# Specification authentification sso saml\n\n"
    "L authentification sso saml est obligatoire pour les marchands entreprise.\n"
    "Le connecteur sso saml gere les assertions entreprise.\n"
)
SSO_ROADMAP = (
    "# Roadmap authentification sso saml\n\n"
    "L authentification sso saml est optionnel pour les marchands entreprise.\n"
    "Le connecteur sso saml reste configurable par entreprise.\n"
)
GRAPHQL_A = (
    "# Graphql subscription transport\n\n"
    "The graphql subscription websocket transport is supported in production.\n"
    "Our graphql subscription layer relies on websocket transport.\n"
)
GRAPHQL_B = (
    "# Graphql subscription transport notes\n\n"
    "The graphql subscription websocket transport is not supported yet.\n"
    "Legacy graphql subscription clients used websocket transport.\n"
)
ROADMAP = (
    "# Roadmap activity layer\n\n"
    "Le module telemetry doit etre tranche prochainement.\n\n"
    "| chantier | etat |\n"
    "|---|---|\n"
    "| telemetry | 🚢 livre |\n"
    "\n"
    "Decision telemetry: a trancher avant la fin du sprint.\n"
)
# multi-series table: >=2 numeric divergences -> NOT a table-drift (the documented FP trap).
METRICS_JAN = (
    "# Metrics janvier pelican\n\n"
    "Series pelican mensuelles distinctes.\n\n"
    "| jour | pelican |\n"
    "|---|---|\n"
    "| lundi | 10 |\n"
    "| mardi | 20 |\n"
    "| mercredi | 30 |\n"
)
METRICS_FEB = (
    "# Metrics fevrier pelican\n\n"
    "Series pelican mensuelles distinctes.\n\n"
    "| jour | pelican |\n"
    "|---|---|\n"
    "| lundi | 11 |\n"
    "| mardi | 22 |\n"
    "| mercredi | 33 |\n"
)

CORPUS = {
    "bilan-q3.md": BILAN_A, "bilan-q4.md": BILAN_B,
    "klayn-archi.md": KLAYN_A, "klayn-notes.md": KLAYN_B,
    "poe1-build.md": POE1_A, "poe1-guide.md": POE1_B,
    "sso-spec.md": SSO_SPEC, "sso-roadmap.md": SSO_ROADMAP,
    "graphql-a.md": GRAPHQL_A, "graphql-b.md": GRAPHQL_B,
    "roadmap.md": ROADMAP,
    "metrics-jan.md": METRICS_JAN, "metrics-feb.md": METRICS_FEB,
}


def _pair(a, b):
    return frozenset((a, b))


def _write(root, docs):
    for rel, text in docs.items():
        p = root / "content" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="")


class _Mind(unittest.TestCase):
    """Base: a throwaway mind built from CORPUS (overridable), CONFIG pointed at it."""
    DOCS = CORPUS

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="atlas-golden-"))
        _write(self.root, self.DOCS)
        _s.CONFIG = AtlasConfig.load(root=self.root, env={})

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _detect(self):
        return c.find_contradictions(None, 100)

    def _rows(self):
        return {_pair(x["a"], x["b"]): x for x in self._detect()}


class TestClusterRecall(_Mind):
    def test_cluster_recall(self):
        rows = self._rows()
        # #1 bilans -> table-drift (detector wins the merge); #2 klayn, #3 poe1 -> cluster.
        self.assertEqual(rows[_pair("bilan-q3.md", "bilan-q4.md")]["kind"], "table-drift")
        self.assertEqual(rows[_pair("klayn-archi.md", "klayn-notes.md")]["kind"], "cluster")
        self.assertEqual(rows[_pair("poe1-build.md", "poe1-guide.md")]["kind"], "cluster")


class TestTableDriftPrecision(_Mind):
    def test_table_drift_precision(self):
        rows = self._rows()
        drift = rows[_pair("bilan-q3.md", "bilan-q4.md")]
        self.assertEqual(drift["kind"], "table-drift")
        self.assertEqual({drift["a_value"], drift["b_value"]}, {"1114", "1105"})
        # The multi-series table (>=2 divergences) must NOT be a table-drift.
        multi = rows.get(_pair("metrics-jan.md", "metrics-feb.md"))
        self.assertIsNotNone(multi)
        self.assertNotEqual(multi["kind"], "table-drift")


class TestPolarityDetector(_Mind):
    def test_polarity_detector(self):
        rows = self._rows()
        fr = rows[_pair("sso-spec.md", "sso-roadmap.md")]
        self.assertEqual(fr["kind"], "polarity")
        self.assertEqual(fr["confidence"], "review")  # a lead, à vérifier, never asserted
        self.assertTrue(fr["a_line"] and fr["b_line"])
        en = rows[_pair("graphql-a.md", "graphql-b.md")]
        self.assertEqual(en["kind"], "polarity")
        self.assertEqual(en["confidence"], "review")

    def test_negation_not_read_as_positive(self):
        # "is not supported" matches the NEGATIVE side, never the positive "supported": the
        # graphql pair only surfaces because one line is positive and the other negative.
        en = self._rows()[_pair("graphql-a.md", "graphql-b.md")]
        self.assertEqual(en["kind"], "polarity")
        self.assertIn("not supported", _s._normalize_text(en["a_value"] + " " + en["b_value"]))


class TestIntraStatus(_Mind):
    def test_intra_status(self):
        rows = self._rows()
        row = rows[_pair("roadmap.md", "roadmap.md")]
        self.assertEqual(row["kind"], "intra-status")
        self.assertEqual(row["a"], row["b"])
        self.assertEqual(row["a"], "roadmap.md")
        self.assertNotEqual(row["a_line"], row["b_line"])


class TestIntraDocDismiss(_Mind):
    DOCS = {"roadmap.md": ROADMAP}

    def test_intra_doc_dismiss(self):
        # a==b with DISTINCT lines round-trips through the store (verdict_holds returns it).
        rel = "roadmap.md"
        text = (self.root / "content" / rel).read_text(encoding="utf-8-sig")
        dh = _s.doc_hash(text)
        lines = text.splitlines()
        sa, sb = _s.doc_hash(lines[6].strip()), _s.doc_hash(lines[8].strip())
        self.assertNotEqual(sa, sb)
        _s.set_verdict(rel, rel, "real", dh, dh, "claude", a_span=sa, b_span=sb)
        idx = store.verdict_index()
        held = store.verdict_holds(idx[(rel, rel)], dh, dh,
                                   _s.line_hashes(text), _s.line_hashes(text))
        self.assertEqual(held, "real")

    def test_same_line_intra_doc_is_rejected(self):
        # a==b with a_line == b_line must be rejected by the MCP judge guard.
        res = mcp_call._tool_judge_contradiction(
            {"a": "roadmap.md", "b": "roadmap.md", "verdict": "real",
             "a_line": 5, "b_line": 5, "ai": "claude"}, None)
        self.assertTrue(res.get("isError"))


class TestMergeDedup(_Mind):
    def test_merge_dedup(self):
        # The bilans pair is BOTH a cosine cluster candidate and a table-drift; it must surface
        # exactly once, as table-drift (the detector replaces the cluster row).
        cands = self._detect()
        bilan = [x for x in cands if _pair(x["a"], x["b"]) == _pair("bilan-q3.md", "bilan-q4.md")]
        self.assertEqual(len(bilan), 1)
        self.assertEqual(bilan[0]["kind"], "table-drift")
        # sanity: the same pair is a cluster candidate before the merge.
        corpus = [(rel, rel, t) for rel, t in self.DOCS.items()]
        clean = [(rel, n, c._strip_noise(rel, t)) for rel, n, t in corpus]
        vectors, df, N = c._corpus_vectors(clean)
        cluster_pairs = {_pair(r["a"], r["b"]) for r in c._cluster_candidates(vectors, df, N)}
        self.assertIn(_pair("bilan-q3.md", "bilan-q4.md"), cluster_pairs)


class TestConfidenceSemantics(_Mind):
    def test_confidence_semantics(self):
        # Only table-drift is asserted "high"; clusters and the polarity / intra-status leads
        # are "review" (à vérifier) so they never dominate the card.
        for x in self._detect():
            if x["kind"] == "table-drift":
                self.assertEqual(x["confidence"], "high")
            else:
                self.assertEqual(x["confidence"], "review")


class TestVolume(_Mind):
    def test_volume_is_a_handful(self):
        self.assertLessEqual(len(self._detect()), 12)


class TestDeterminism(_Mind):
    def test_determinism(self):
        self.assertEqual(c.find_contradictions(None, 100), c.find_contradictions(None, 100))


class TestNoValueFields(_Mind):
    def test_no_value_fields(self):
        dead = ("shared_count", "shared_df", "shared_tags", "linked")
        for x in self._detect():
            for f in dead:
                self.assertNotIn(f, x)
            if x["kind"] == "cluster":
                self.assertNotIn("a_value", x)
                self.assertNotIn("b_value", x)
            else:
                self.assertIn("a_value", x)
                self.assertIn("b_value", x)


class TestUnicodeSmoke(_Mind):
    DOCS = {
        "otchet-a.md": (
            "# Отчёт клайн\n\nПоказатели клайн за квартал.\n\n"
            "| метрика | значение |\n|---|---|\n"
            "| магазины | 1114 |\n| заказы | 5300 |\n| выручка | 8200 |\n"
        ),
        "otchet-b.md": (
            "# Отчёт клайн\n\nПоказатели клайн за квартал.\n\n"
            "| метрика | значение |\n|---|---|\n"
            "| магазины | 1105 |\n| заказы | 5300 |\n| выручка | 8200 |\n"
        ),
    }

    def test_tokenize_non_latin_non_empty(self):
        self.assertTrue(c._tokenize("Привет мир контракт"))
        self.assertTrue(c._tokenize("契約 文書 比較"))

    def test_cyrillic_table_divergence_surfaces(self):
        cands = self._detect()
        self.assertGreaterEqual(len(cands), 1)
        drift = [x for x in cands if x["kind"] == "table-drift"]
        self.assertEqual({drift[0]["a_value"], drift[0]["b_value"]}, {"1114", "1105"})


class TestPerfBound(unittest.TestCase):
    def test_perf_bound(self):
        # A term in every doc (df = N > _PER_TERM_CAP) contributes ZERO candidate pairs.
        N = 60
        vectors, df = {}, {"ubiq": N}
        for i in range(N):
            vectors[f"d{i:03d}.md"] = {"ubiq": 1.0, f"u{i}": 1.0}
            df[f"u{i}"] = 1
        pairset, truncated = c._candidate_pairs(vectors, df, N)
        self.assertEqual(len(pairset), 0)
        self.assertFalse(truncated)
        self.assertLessEqual(len(pairset), c._PAIR_CAP)

    def test_pair_cap_truncates_without_raising(self):
        orig = c._PAIR_CAP
        c._PAIR_CAP = 5
        try:
            vectors = {f"d{i}.md": {"shared": 1.0} for i in range(8)}  # df=8 <= cap_frac
            pairset, truncated = c._candidate_pairs(vectors, {"shared": 8}, 8)
            self.assertLessEqual(len(pairset), 5)
            self.assertTrue(truncated)
        finally:
            c._PAIR_CAP = orig


class TestEvidenceIsAdvisory(_Mind):
    DOCS = {
        # Two cluster docs; one carries a supersession marker. Evidence must attach but never
        # promote the cluster row to "high".
        "feature-a.md": (
            "# Feature alpha onboarding\n\n"
            "Le tunnel onboarding alpha guide le marchand etape par etape.\n"
            "Onboarding alpha: le tunnel marchand est documente.\n"
        ),
        "feature-b.md": (
            "# Feature alpha onboarding bis\n\n"
            "Le tunnel onboarding alpha est remplace par le nouveau parcours marchand.\n"
            "Onboarding alpha: le tunnel marchand evolue.\n"
        ),
    }

    def test_evidence_is_advisory(self):
        rows = self._rows()
        row = rows[_pair("feature-a.md", "feature-b.md")]
        self.assertEqual(row["kind"], "cluster")
        self.assertEqual(row["confidence"], "review")  # marker present, never promoted
        self.assertIn("evidence", row)
        self.assertTrue(any(e["marker"] == "remplace par" for e in row["evidence"]))


class TestSolidOnlyViewerFeed(_Mind):
    def test_solid_only_keeps_high_and_real_only(self):
        # The human viewer feed (solid_only) keeps ONLY the precise high-confidence detector
        # (table-drift) and pairs confirmed 'real'; clusters + polarity/intra leads are dropped.
        full = c.find_contradictions(None, 100)
        self.assertTrue(any(x["kind"] == "cluster" for x in full))   # clusters exist in the full feed
        solid = c.find_contradictions(None, 100, solid_only=True)
        for x in solid:
            self.assertTrue(x["confidence"] == "high" or x.get("verdict") == "real")
        self.assertNotIn("cluster", {x["kind"] for x in solid})
        self.assertNotIn("polarity", {x["kind"] for x in solid})
        self.assertNotIn("intra-status", {x["kind"] for x in solid})
        # the bilans table-drift (high) survives into the solid feed.
        self.assertIn(_pair("bilan-q3.md", "bilan-q4.md"),
                      {_pair(x["a"], x["b"]) for x in solid})


if __name__ == "__main__":
    unittest.main()
