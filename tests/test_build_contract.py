"""Contract pins for the build module surface (refactor safety net).

server.py reaches into build's PUBLIC *and* PRIVATE surface through
_import_build() — those names form an inter-module API that the monolith split
must keep importable as top-level ``build.<name>``. server.py also MONKEY-PATCHES
``build.EXCLUDED_NAMES`` (``_build.EXCLUDED_NAMES = CONFIG.excluded_names``) and
relies on ``build.walk()`` reading that patched value AT CALL TIME. This test
freezes both invariants so a future ``build/`` package split can't silently break
the bridge — the rest of the suite is black-box and would not notice.
"""
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if _REPO_SRC not in sys.path:
    sys.path.insert(0, _REPO_SRC)

import build  # noqa: E402

# The exact surface server.py consumes via _import_build(), plus the four
# functions imported directly by the build-importing tests
# (test_branding / test_todo_categories / test_tasks / test_templates).
_CONTRACT_SYMBOLS = (
    # consumed by server.py via _import_build()
    "walk",
    "build_links_index",
    "build_tasks_index",
    "load_extension_assets",
    "_escape_closing_tag",
    "_CLOSING_STYLE_RE",
    "_CLOSING_SCRIPT_RE",
    "_parse_frontmatter",
    "_resolve_wikilink",
    "_WIKILINK_RE",
    "_folder_tags",
    "EXCLUDED_NAMES",
    # imported directly by tests
    "load_doc_templates",
    "render_manifest",
    "render_template",
)


class TestBuildModuleSurface(unittest.TestCase):
    def test_all_contract_symbols_are_importable(self):
        missing = [name for name in _CONTRACT_SYMBOLS if not hasattr(build, name)]
        self.assertEqual(missing, [], f"build no longer exposes: {missing}")


class TestExcludedNamesMonkeyPatch(unittest.TestCase):
    """server.py sets ``build.EXCLUDED_NAMES = CONFIG.excluded_names`` then calls
    ``build.walk()``; walk must honour the patched value (it reads the module-level
    name at call time, default arg = None). A package split that froze EXCLUDED_NAMES
    inside a submodule would break this without any other test noticing."""

    def test_walk_honours_a_patched_excluded_name(self):
        original = build.EXCLUDED_NAMES
        try:
            with tempfile.TemporaryDirectory() as tmp:
                content = Path(tmp) / "content"
                content.mkdir()
                (content / "keep.md").write_text("# Keep\n", encoding="utf-8")
                secret = content / "secret"
                secret.mkdir()
                (secret / "inside.md").write_text("# Inside\n", encoding="utf-8")

                # Patch exactly like server.py's _import_build() does, then walk.
                # Pre-seed _accum so walk skips the git-dates lookup (no repo here).
                build.EXCLUDED_NAMES = {"secret"}
                tree = build.walk(content, _accum={"md_files": [], "git_dates": {}})
                names = {child["name"] for child in tree["children"]}

                self.assertIn("keep.md", names)
                self.assertNotIn("secret", names)
        finally:
            build.EXCLUDED_NAMES = original


if __name__ == "__main__":
    unittest.main()
