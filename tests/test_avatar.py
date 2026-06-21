"""Determinism + id-uniqueness of the constellation avatar generator (02-avatar.js),
exercised through node since the function is pure JS."""
import re
import shutil
import subprocess
import unittest
from pathlib import Path

AVATAR_JS = Path(__file__).resolve().parent.parent / "src" / "web" / "js" / "02-avatar.js"


def _svg(identity, size=56):
    script = (
        "const {constellationSvg} = require(process.argv[1]);"
        "process.stdout.write(constellationSvg(process.argv[2], +process.argv[3]));"
    )
    out = subprocess.run(
        ["node", "-e", script, str(AVATAR_JS), identity, str(size)],
        capture_output=True, text=True, check=True)
    return out.stdout


@unittest.skipUnless(shutil.which("node"), "node not available")
class TestConstellationAvatar(unittest.TestCase):
    def test_deterministic(self):
        self.assertEqual(_svg("ada@example.com"), _svg("ada@example.com"))

    def test_differs_per_identity(self):
        self.assertNotEqual(_svg("ada@example.com"), _svg("bob@example.com"))

    def test_is_nontrivial_svg(self):
        svg = _svg("ada@example.com")
        self.assertTrue(svg.startswith("<svg"))
        self.assertGreater(len(svg), 200)

    def test_ids_seed_suffixed_so_two_avatars_dont_collide(self):
        # Different avatars on one page must share NO gradient/filter/clip id, else the
        # second would inherit the first's defs.
        ids_a = set(re.findall(r'id="([^"]+)"', _svg("ada@example.com")))
        ids_b = set(re.findall(r'id="([^"]+)"', _svg("bob@example.com")))
        self.assertTrue(ids_a)
        self.assertEqual(ids_a & ids_b, set())


if __name__ == "__main__":
    unittest.main()
