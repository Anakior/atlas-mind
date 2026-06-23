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

import server as _s              # noqa: E402
from config import AtlasConfig   # noqa: E402
from server.pure import queries  # noqa: E402

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
