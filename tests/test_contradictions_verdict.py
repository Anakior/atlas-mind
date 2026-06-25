"""find_contradictions honours the verdict cache: a pair judged 'none' stops resurfacing,
a 'real' one is annotated. Uses a throwaway mind so the committed fixture stays clean."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import server as _s              # noqa: E402
from config import AtlasConfig   # noqa: E402
from server.pure import contradictions as c  # noqa: E402

# Two docs sharing >=2 rare content tokens (webhook / timeout / retry / idempotence) so they
# form a cosine cluster pair the engine emits. The deleted value tower's 30 s/60 s docs would
# never surface now. The verdict-cache behaviour below is what is under test, not the detector.
DOCS = {
    "a.md": ("# A\n\nLe webhook gère le timeout et la retry idempotence.\n"
             "Configuration idempotence du timeout webhook documentée.\n"),
    "b.md": ("# B\n\nLe timeout webhook déclenche une retry.\n"
             "Idempotence du webhook: la retry respecte le timeout.\n"),
}
PAIR = frozenset(("a.md", "b.md"))


class TestVerdictCache(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="atlas-verdict-"))
        for rel, text in DOCS.items():
            p = self.root / "content" / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8", newline="")
        _s.CONFIG = AtlasConfig.load(root=self.root, env={})

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _pairs(self, **kw):
        return {frozenset((x["a"], x["b"])) for x in c.find_contradictions(None, 50, **kw)}

    def _hashes(self):
        read = lambda rel: (self.root / "content" / rel).read_text(encoding="utf-8-sig")
        return _s.doc_hash(read("a.md")), _s.doc_hash(read("b.md"))

    def test_dismissed_pair_is_filtered_unless_requested(self):
        self.assertIn(PAIR, self._pairs())  # surfaces by default
        ha, hb = self._hashes()
        _s.set_verdict("a.md", "b.md", "none", ha, hb, "claude")
        self.assertNotIn(PAIR, self._pairs())                       # dismissed -> gone
        self.assertIn(PAIR, self._pairs(include_dismissed=True))    # still reachable on demand

    def test_real_verdict_is_annotated(self):
        ha, hb = self._hashes()
        _s.set_verdict("a.md", "b.md", "real", ha, hb, "claude")
        match = [x for x in c.find_contradictions(None, 50) if {x["a"], x["b"]} == {"a.md", "b.md"}]
        self.assertTrue(match)
        self.assertTrue(all(x["verdict"] == "real" for x in match))

    def _edit(self, rel, fn):
        p = self.root / "content" / rel
        p.write_text(fn(p.read_text(encoding="utf-8-sig")), encoding="utf-8", newline="")

    def test_span_bound_verdict_survives_unrelated_edit_but_not_a_judged_edit(self):
        # Dismiss the pair, bound to the webhook lines (the actual judged claim).
        ha, hb = self._hashes()
        sa = _s.doc_hash("Le webhook gère le timeout et la retry idempotence.")
        sb = _s.doc_hash("Le timeout webhook déclenche une retry.")
        _s.set_verdict("a.md", "b.md", "none", ha, hb, "claude", a_span=sa, b_span=sb)
        self.assertNotIn(PAIR, self._pairs())                         # dismissed

        self._edit("a.md", lambda t: t + "Une note ajoutée plus tard.\n")
        self.assertNotIn(PAIR, self._pairs())                         # edit elsewhere -> STILL dismissed (the fix)

        # Touch the judged line (keeping the rare-token overlap so it still clusters) -> resurfaces.
        self._edit("a.md", lambda t: t.replace("Le webhook gère le timeout",
                                               "Le webhook pilote le timeout"))
        self.assertIn(PAIR, self._pairs())                            # judged line changed -> resurfaces


if __name__ == "__main__":
    unittest.main()
