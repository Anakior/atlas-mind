"""Guardrails on the shape of the Docker image: the ENGINE must be self-contained.

The historical trap: the image only copied src/ and the viewer (web/) came from
the git clone of the content — a clone↔image coupling and impossibility of
removing web/ from the mind. These tests fail if someone re-breaks this
(e.g. removes `COPY web/`).
"""
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOCKERFILE = (REPO / "deploy" / "Dockerfile").read_text(encoding="utf-8")
DOCKERIGNORE = (REPO / ".dockerignore").read_text(encoding="utf-8")
REQUIREMENTS = (REPO / "requirements.txt").read_text(encoding="utf-8")
# Real dependencies = non-empty lines excluding comments (we ignore the '#').
REQ_DEPS = [ln.strip() for ln in REQUIREMENTS.splitlines()
            if ln.strip() and not ln.lstrip().startswith("#")]


class TestDeployImageSelfContained(unittest.TestCase):
    def test_dockerfile_copies_engine_code_and_viewer(self):
        # The self-contained engine = src/ (which now bundles web/ + templates/).
        self.assertIn("COPY src/", DOCKERFILE,
                      "Dockerfile must embed src/ (self-contained image)")

    def test_dockerignore_lets_web_into_build_context(self):
        # src/ (with its bundled assets) must NOT be excluded from the context.
        for keep in ("!src", "!requirements.txt"):
            self.assertIn(keep, DOCKERIGNORE,
                          f".dockerignore must re-include {keep!r}")

    def test_requirements_has_no_mongo(self):
        # The image (ATLAS_STORE=file) never pulls pymongo as a DEPENDENCY.
        # (We test the real dependencies, not any comment that mentions pymongo.)
        self.assertFalse(
            any("pymongo" in dep.lower() for dep in REQ_DEPS),
            f"pymongo must not be a dependency of the image: {REQ_DEPS}")

    def test_requirements_keeps_bcrypt_for_legacy_hashes(self):
        # bcrypt stays to verify the legacy "$2…" hashes.
        self.assertTrue(any("bcrypt" in dep.lower() for dep in REQ_DEPS))


if __name__ == "__main__":
    unittest.main()
