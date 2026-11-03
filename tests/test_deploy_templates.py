"""Guardrails on the Fly template `atlas deploy` writes: the content checkout must live
on the volume (an unpushed commit on the ephemeral rootfs is lost on the next restart),
and the first admin comes from a setup link, never a root shell into the machine."""
import sys
import tomllib
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import cli  # noqa: E402


class TestFlyTemplate(unittest.TestCase):
    def setUp(self):
        self.toml = tomllib.loads(cli.DEPLOY_FLY_TOML)

    def test_repo_and_registry_live_on_the_volume(self):
        mount = self.toml["mounts"]["destination"]
        env = self.toml["env"]
        self.assertTrue(env["KB_REPO_PATH"].startswith(mount + "/"))
        self.assertTrue(env["ATLAS_STORE_DIR"].startswith(mount + "/"))

    def test_the_first_admin_comes_from_a_link_not_a_shell(self):
        # No root shell into the machine with a password in argv: the wizard and the
        # printed guide hand out a /setup#code=… link instead.
        source = (SRC / "cli.py").read_text(encoding="utf-8")
        self.assertNotIn("ssh console", source)
        self.assertIn("ATLAS_SETUP_CODE_SHA256", source)


if __name__ == "__main__":
    unittest.main()
