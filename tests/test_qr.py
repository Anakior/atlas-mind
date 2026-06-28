"""QR codec (src/viewer/lib/ui/qr-code.ts) — determinism + exact-matrix goldens, run through node.

The .ts is bundled to an importable .mjs by jsmod.requirable; we dynamic-import() it and read
`new m.QrCode(text).matrix` (a named export) then sha256 it. The goldens were pinned from the
original 17-qr.js BEFORE the TS refactor, so they prove the port is byte-identical (a wrong
>>/<</^/& slips past tsc and the renderer but flips the matrix)."""
import hashlib
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from jsmod import requirable

QR = Path(__file__).resolve().parent.parent / "src" / "viewer" / "lib" / "ui" / "qr-code.ts"

# input -> (dimensions, sha256 of the rows joined by '\n', each cell '1' if ===1 else '0').
GOLDENS = {
    "otpauth://totp/Atlas:admin@test.local?secret=JBSWY3DPEHPK3PXP&issuer=Atlas&algorithm=SHA1&digits=6&period=30":
        ("41x41", "50b3cc80728a04cdaa738c001705ef36ff44dae001f955850354a525d957960c"),
    "HELLO": ("21x21", "0531aee8d5d6759db4fc738c003f84cdb6fb19d5637c960707f8e722dc94c851"),
    "https://example.com/a-medium-length-url-to-exercise-a-higher-version-0123456789":
        ("37x37", "3a2590b5b2f63def8946843226505db68f830d5255d1742b1b3b3994f0b6b116"),
    "": ("21x21", "4ce260f1891fd1b827103e74ba1bc3c445e9a9c336d6d5a0e03656ccb28da00e"),
}


def _matrix(text):
    # Dynamic-import the bundled .mjs (as a file URL) and emit JSON of new QrCode(text).matrix.
    script = (
        "const {pathToFileURL}=require('url');"
        "import(pathToFileURL(process.argv[1]).href).then(m=>"
        "process.stdout.write(JSON.stringify(new m.QrCode(process.argv[2]).matrix)));"
    )
    out = subprocess.run(
        ["node", "-e", script, str(requirable(QR)), text],
        capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def _digest(matrix):
    rows = "\n".join("".join("1" if c == 1 else "0" for c in row) for row in matrix)
    return hashlib.sha256(rows.encode()).hexdigest()


@unittest.skipUnless(shutil.which("node"), "node not available")
class TestQrCodec(unittest.TestCase):
    def test_matrices_match_pinned_goldens(self):
        for text, (dims, sha) in GOLDENS.items():
            m = _matrix(text)
            self.assertEqual(f"{len(m)}x{len(m[0])}", dims, f"size for {text!r}")
            self.assertEqual(_digest(m), sha, f"matrix for {text!r}")

    def test_deterministic(self):
        t = "otpauth://totp/Atlas:x@y.z?secret=ABCDEFGHIJKLMNOP"
        self.assertEqual(_matrix(t), _matrix(t))

    def test_square_with_version1_size(self):
        m = _matrix("HELLO")
        self.assertEqual(len(m), 21)  # v1 = 17 + 1*4
        self.assertTrue(all(len(row) == 21 for row in m))

    def test_null_when_past_capacity(self):
        # Beyond v10 capacity -> null, not a malformed matrix.
        self.assertIsNone(_matrix("x" * 300))


if __name__ == "__main__":
    unittest.main()
