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

DOCS = {
    "a.md": "# A\n\nLe timeout du webhook est de 30 s.\n",
    "b.md": "# B\n\nLe timeout du webhook est de 60 s.\n",
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


if __name__ == "__main__":
    unittest.main()
