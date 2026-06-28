"""Determinism + id-uniqueness of the constellation avatar generator (ui/avatar.ts),
exercised through node since the function is pure JS. The .ts is bundled to an importable
.mjs by jsmod.requirable (esbuild ESM bundle; avatar's own import of core/rng.ts is resolved
in), and its named exports (constellationSvg/avatarSeed) are read via dynamic import()."""
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from jsmod import requirable

AVATAR = Path(__file__).resolve().parent.parent / "src" / "viewer" / "lib" / "ui" / "avatar.ts"


def _svg(identity, size=56):
    # Dynamic-import the bundled .mjs (as a file URL) and emit constellationSvg(identity, size).
    script = (
        "const {pathToFileURL}=require('url');"
        "import(pathToFileURL(process.argv[1]).href).then(m=>"
        "process.stdout.write(m.constellationSvg(process.argv[2], +process.argv[3])));"
    )
    out = subprocess.run(
        ["node", "-e", script, str(requirable(AVATAR)), identity, str(size)],
        capture_output=True, text=True, check=True)
    return out.stdout


def _seed(first, last, email):
    script = (
        "const {pathToFileURL}=require('url');"
        "import(pathToFileURL(process.argv[1]).href).then(m=>"
        "process.stdout.write(m.avatarSeed(process.argv[2], process.argv[3], process.argv[4])));"
    )
    out = subprocess.run(
        ["node", "-e", script, str(requirable(AVATAR)), first, last, email],
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

    def test_avatar_seed_is_name_plus_email(self):
        # No name -> pure email (stable, same as before names existed).
        self.assertEqual(_seed("", "", "ada@example.com"), "ada@example.com")
        # Name halves trimmed, blanks dropped, then concatenated with the email.
        self.assertEqual(_seed(" Ada ", "Lovelace", "ada@example.com"),
                         "Ada Lovelaceada@example.com")
        self.assertEqual(_seed("Ada", "", "ada@example.com"), "Adaada@example.com")

    def test_setting_a_name_changes_the_avatar(self):
        # The avatar reflects the name: adding/changing it yields a different drawing
        # (the email keeps it unique; this change-on-rename is intended).
        no_name = _svg(_seed("", "", "ada@example.com"))
        named = _svg(_seed("Ada", "Lovelace", "ada@example.com"))
        self.assertNotEqual(no_name, named)


if __name__ == "__main__":
    unittest.main()
