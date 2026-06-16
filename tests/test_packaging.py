"""The engine must boot as the INSTALLED package, not only from source on PYTHONPATH.

Prod runs `python -m atlas_mind.server` against a pip-installed wheel: the
`atlas_mind` package is importable, but its directory is NOT itself on sys.path.
The dev/test entry (`python -m server`, engine src on PYTHONPATH) makes the flat
intra-package imports (`from server.X import …`, `import server as _s`) resolve
for free — which MASKS any bug in the package's own sys.path bootstrap. A
regression there once shipped a total outage with every test green
(`ModuleNotFoundError: No module named 'server'`, raised only under the dotted
name). These two tests close the two halves of that gap:

- test_boots_as_installed_package reproduces the prod layout (engine copied as
  <tmp>/pkg/atlas_mind/, only <tmp>/pkg on PYTHONPATH) and asserts the server
  serves /healthz under `python -m atlas_mind.server`.
- test_pyproject_lists_every_subpackage guards the other half: a sub-package
  present on disk but missing from [tool.setuptools].packages ships an amputated
  wheel (0 files under server/ → ImportError on a real pip install).
"""
from __future__ import annotations

import tomllib
import unittest

from harness import AtlasServer, REPO_ROOT, SRC_DIR

# Cloud mode (KB_AUTH_ENABLED), like the deployed Fly image. KB_REPO_PATH={root}
# short-circuits the git clone at boot; the server still builds the viewer
# in-process at boot, which exercises `import build` under the installed layout.
CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "packaging-test-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}


class TestRunsAsInstalledPackage(unittest.TestCase):
    """`python -m atlas_mind.server` against the package laid out like a pip
    install — the one entry point no other test exercises, and the one prod uses."""

    def test_boots_as_installed_package(self):
        with AtlasServer(installed_layout=True, run_build=False,
                         extra_env=dict(CLOUD_ENV)) as srv:
            # Before the sys.path bootstrap was ordered ahead of the flat imports,
            # this raised ModuleNotFoundError: No module named 'server' at import,
            # so the process never listened.
            self.assertEqual(
                srv.get("/healthz").status, 200,
                f"server did not boot as atlas_mind.server:\n{srv.read_log()[-2000:]}")
            # The cloud login page rendering proves the app is actually live, not
            # just the bare healthcheck.
            self.assertEqual(srv.get("/login").status, 200)
            # The viewer is built in-process at boot (`import build`); its presence
            # proves the build module's flat imports also resolve under the
            # installed layout, not only the server's.
            self.assertTrue((srv.root / "dist" / "index.html").is_file())


class TestPyprojectPackaging(unittest.TestCase):
    """Static guard on the wheel's contents: every package on disk is declared."""

    def test_pyproject_lists_every_subpackage(self):
        on_disk = set()
        for init in SRC_DIR.rglob("__init__.py"):
            rel = init.parent.relative_to(SRC_DIR)
            on_disk.add(".".join(("atlas_mind", *rel.parts)) if rel.parts
                        else "atlas_mind")
        meta = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        declared = set(meta["tool"]["setuptools"]["packages"])
        self.assertEqual(
            on_disk, declared,
            "[tool.setuptools].packages is out of sync with src/ — a missing entry "
            "ships an amputated wheel.\n"
            f"on disk but NOT declared: {sorted(on_disk - declared)}\n"
            f"declared but NOT on disk: {sorted(declared - on_disk)}")


if __name__ == "__main__":
    unittest.main()
