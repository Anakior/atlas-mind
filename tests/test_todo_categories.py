"""Guardrail: the CONFIGURED todo categories (atlas.toml [todo].categories)
must reach the viewer.

Historical bug: the backend (parse_todos/config) was configurable, but the
viewer hardcoded the "work" / "personal" tabs and a tcat() that forced any
cat ≠ 'personal' to 'work' → custom categories (e.g. taff/perso) had ALL
their todos filed into a single tab.
"""
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
REPO_SRC = TESTS_DIR.parent / "src"
for p in (str(REPO_SRC), str(TESTS_DIR)):   # src/ (build) + tests/ (harness)
    if p not in sys.path:
        sys.path.insert(0, p)

import build  # noqa: E402
from harness import AtlasServer  # noqa: E402


class _TomlMind(AtlasServer):
    """Mind served with an atlas.toml written BEFORE the build (a real configured mind)."""

    def __init__(self, toml_text: str, **kw):
        super().__init__(**kw)
        self._toml_text = toml_text

    def _populate(self) -> None:
        super()._populate()
        (self.root / "atlas.toml").write_text(self._toml_text, encoding="utf-8")


def _render(categories):
    return build.render_template(
        tree={"name": "content", "type": "dir", "children": []},
        embed_content=None, embed_backlinks=None, embed_notes=None,
        build_ts="2026-01-01T00:00:00Z",
        todo_categories=categories,
    )


class TestTodoCategoriesReachViewer(unittest.TestCase):
    def test_custom_categories_injected_and_defaults_absent(self):
        html = _render([{"cat": "taff", "label": "Taff"},
                        {"cat": "perso", "label": "Perso"}])
        # The JSON of the configured categories is injected into the viewer.
        self.assertIn('"cat": "taff"', html)
        self.assertIn('"cat": "perso"', html)
        self.assertIn('"label": "Taff"', html)
        self.assertIn('"label": "Perso"', html)
        # The default categories are NOT injected when others are configured
        # (we target the categories JSON, not the word "work" which may live elsewhere).
        self.assertNotIn('"cat": "work"', html)
        self.assertNotIn('"cat": "personal"', html)
        # The placeholder was indeed substituted (no raw __TODO_CATEGORIES_JSON__).
        self.assertNotIn("__TODO_CATEGORIES_JSON__", html)

    def test_default_categories_when_unset(self):
        html = build.render_template(
            tree={"name": "content", "type": "dir", "children": []},
            embed_content=None, embed_backlinks=None, embed_notes=None,
            build_ts="2026-01-01T00:00:00Z")  # no todo_categories
        self.assertIn('"cat": "work"', html)
        self.assertIn('"cat": "personal"', html)

    def test_no_hardcoded_static_filter_buttons(self):
        # The tabs are generated in JS from the config: the template must no
        # longer contain a static <button data-cat="work">.
        html = _render([{"cat": "a", "label": "A"}, {"cat": "b", "label": "B"}])
        self.assertNotIn('data-cat="work"', html)
        self.assertNotIn('data-cat="personal"', html)


class TestTodoCategoriesEndToEnd(unittest.TestCase):
    """Full chain config → build → served dist (would have caught the wiring
    bug where only the OFFLINE render_template call received the categories)."""

    @classmethod
    def setUpClass(cls):
        cls.srv = _TomlMind('[todo]\ncategories = ["alpha", "beta"]\n')
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_served_viewer_uses_configured_categories(self):
        # Local mode: GET / serves the viewer built for this mind.
        text = self.srv.get("/").text
        self.assertIn('"cat": "alpha"', text)
        self.assertIn('"cat": "beta"', text)
        self.assertNotIn('"cat": "work"', text)
        self.assertNotIn('"cat": "personal"', text)


if __name__ == "__main__":
    unittest.main()
