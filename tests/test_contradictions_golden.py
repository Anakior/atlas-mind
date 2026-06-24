"""Golden corpus for the contradiction detector.

A labelled fixture mind (fixtures/contradictions_kb/) measured against ground
truth, to pin the CURRENT detector's blind spots as the baseline the redesign
must beat. Run the file directly for the full recall/precision report; under
pytest it asserts the baseline invariants below.
"""
import json
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import server as _s                       # noqa: E402
from config import AtlasConfig            # noqa: E402
from server.pure import queries           # noqa: E402
from server.pure import contradictions as c  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "contradictions_kb"


def _load_expected() -> dict:
    return json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))


def _detect() -> list:
    # ctx=None bypasses the ACL (local read); CONFIG points the engine at the fixture.
    _s.CONFIG = AtlasConfig.load(root=FIXTURE, env={})
    return queries._contradiction_candidates(None, 100)


def _pair(docs) -> frozenset:
    return frozenset(docs)


def measure() -> dict:
    expected = _load_expected()
    emitted = {_pair((c["a"], c["b"])) for c in _detect()}
    real = {_pair(c["docs"]) for c in expected["contradictions"] if len(c["docs"]) == 2}
    found = emitted & real
    return {
        "expected": expected,
        "emitted": emitted,
        "real": real,
        "found": found,
        "precision": len(found) / len(emitted) if emitted else 0.0,
        "recall": len(found) / len(real) if real else 0.0,
    }


class TestGoldenCorpus(unittest.TestCase):
    def test_fixture_is_well_formed(self):
        # A label pointing at a missing doc would make every metric lie.
        expected = _load_expected()
        for entry in expected["contradictions"] + expected["traps"]:
            for doc in entry["docs"]:
                self.assertTrue((FIXTURE / "content" / doc).is_file(), doc)

    def test_detector_is_deterministic(self):
        self.assertEqual(_detect(), _detect())

    def test_baseline_blind_to_untagged_and_intra_doc(self):
        # The redesign target: real contradictions reachable by neither tag nor link.
        m = measure()
        for c in m["expected"]["contradictions"]:
            if c["pairable_by"] == "none" and len(c["docs"]) == 2:
                self.assertNotIn(_pair(c["docs"]), m["emitted"], c["detail"])

    def test_baseline_emits_topical_trap_as_noise(self):
        # Same tag, different subject: the topical detector can't tell, so it floods.
        m = measure()
        for trap in m["expected"]["traps"]:
            self.assertIn(_pair(trap["docs"]), m["emitted"], trap["reason"])

    def test_baseline_precision_is_poor(self):
        # < 50 %: most emitted pairs are not contradictions — the noise the redesign fixes.
        self.assertLess(measure()["precision"], 0.5)


class TestValueGenerator(unittest.TestCase):
    """The new value-collision generator vs the topical baseline, on the same corpus."""

    def _run(self):
        _s.CONFIG = AtlasConfig.load(root=FIXTURE, env={})
        cands = c.find_value_contradictions(None, 100)
        return cands, {_pair((x["a"], x["b"])) for x in cands}

    def test_emits_only_real_contradictions_on_this_corpus(self):
        # Numeric collisions are high-precision: no false positive here (baseline had 6).
        cands, pairs = self._run()
        real = {_pair(c2["docs"]) for c2 in _load_expected()["contradictions"] if len(c2["docs"]) == 2}
        self.assertTrue(pairs)
        self.assertEqual(pairs - real, set())

    def test_catches_the_numeric_pairs_baseline_only_reached_via_tags(self):
        _, pairs = self._run()
        self.assertIn(_pair(("infra/deploy-prod.md", "infra/deploy-staging.md")), pairs)
        self.assertIn(_pair(("pricing.md", "pricing-faq.md")), pairs)

    def test_categorical_pairs_are_still_missed_pending_next_level(self):
        # PostgreSQL/MongoDB and SSO obligatoire/optionnel are textual, not numeric.
        _, pairs = self._run()
        self.assertNotIn(_pair(("notes-archi.md", "notes-data.md")), pairs)

    def test_every_candidate_carries_line_evidence(self):
        cands, _ = self._run()
        for x in cands:
            self.assertTrue(x["a_value"] and x["b_value"] and x["a_line"] and x["b_line"])

    def test_generator_is_deterministic(self):
        self.assertEqual(self._run()[0], self._run()[0])


class TestCombinedGenerator(unittest.TestCase):
    """The full generator (typed collisions + rare-anchor pairs) vs the topical baseline."""

    def _run(self):
        _s.CONFIG = AtlasConfig.load(root=FIXTURE, env={})
        return c.find_contradictions(None, 100)

    def _scores(self):
        cands = self._run()
        pairs = {_pair((x["a"], x["b"])) for x in cands}
        real = {_pair(e["docs"]) for e in _load_expected()["contradictions"] if len(e["docs"]) == 2}
        found = pairs & real
        return cands, len(found) / len(real), len(found) / len(pairs)

    def test_beats_baseline_on_both_axes(self):
        _, recall, precision = self._scores()
        self.assertEqual(recall, 1.0)             # every cross-doc contradiction surfaced
        self.assertGreater(precision, 0.33)       # baseline precision was 3/9
        self.assertGreaterEqual(precision, 0.75)

    def test_numeric_pairs_stay_high_confidence_with_values(self):
        cands = self._run()
        hc = {_pair((x["a"], x["b"])): x for x in cands if x["confidence"] == "high"}
        self.assertIn(_pair(("pricing.md", "pricing-faq.md")), hc)
        self.assertTrue(hc[_pair(("pricing.md", "pricing-faq.md"))]["a_value"])

    def test_categorical_pairs_recovered_as_low_confidence(self):
        low = {_pair((x["a"], x["b"])) for x in self._run() if x["confidence"] == "low"}
        self.assertIn(_pair(("notes-archi.md", "notes-data.md")), low)
        self.assertIn(_pair(("config/sso-spec.md", "config/sso-roadmap.md")), low)

    def test_is_deterministic(self):
        self.assertEqual(self._run(), self._run())


def _report() -> None:
    m = measure()
    by_pair = {_pair((c["a"], c["b"])): c for c in _detect()}
    print(f"\nGolden corpus — détecteur ACTUEL : {len(m['emitted'])} paires émises\n")
    for k in sorted(m["emitted"], key=lambda p: -(by_pair[p].get("score") or 0)):
        c = by_pair[k]
        verdict = "VRAIE contradiction" if k in m["real"] else "bruit"
        a, b = sorted(k)
        print(f"  [{verdict:20}] {a}  <->  {b}  (tags={c['shared_tags']} lié={c['linked']} score={c['score']})")
    print(f"\n  précision {m['precision']:.0%} ({len(m['found'])}/{len(m['emitted'])})"
          f"   rappel {m['recall']:.0%} ({len(m['found'])}/{len(m['real'])} contradictions inter-doc)")
    for c in m["expected"]["contradictions"]:
        if _pair(c["docs"]) not in m["found"]:
            print(f"  ANGLE MORT [{c['pairable_by']:4}] {c['detail']}")


if __name__ == "__main__":
    _report()
