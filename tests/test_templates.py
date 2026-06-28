"""Tests for the externalized new-document skeletons (Phase 2a).

The personal templates (Monthly report, spec, Course…) have been MOVED OUT of
the engine: the viewer now only embeds skeletons discovered at build time by
build.py (load_doc_templates) in the engine-side templates/ (note.md,
reunion.md — neutral), merged with <mind>/templates/*.md (the mind adds or
overrides its own). The result is injected into dist/index.html via the
__TEMPLATES__ placeholder (JSON {label: content}, label = filename without
extension).

The Path of Exile module has been extracted from the engine (example extension
examples/extensions/pob/): only the "Empty" option and the discovered
skeletons remain in the modal's select.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REPO_SRC = REPO_ROOT / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import build  # noqa: E402

ENGINE_NOTE_CONTENT = "# {{title}}\n\n_{{date}}_\n\n"

# Every neutral skeleton shipped by the engine (templates/*.md). Update when a
# base template is added or removed.
ENGINE_TEMPLATES = {
    "note", "reunion", "zettel", "projet", "decision",
    "lecture", "guide", "contact", "retro", "spec",
}

# esbuild collapses the whole bundle onto a few long lines and chains the
# top-level constants into one comma-separated `var` (…,DOC_TEMPLATES=<json>,NEXT=…);
# the name is preserved. Locate the assignment whitespace-agnostically (no line
# anchors, no `var ` keyword in front anymore), then decode exactly one JSON object
# from it — raw_decode stops at the matching brace, ignoring the trailing
# declarators, so the inner `{{title}}` braces never confuse the extraction.
DOC_TEMPLATES_RE = re.compile(r"\bDOC_TEMPLATES\s*=(?!=)\s*")


def make_mind(root: Path, *, templates: dict | None = None) -> None:
    """Minimal decoupled mind: content/ with one doc, and optional mind
    skeletons under <mind>/templates/ (sibling of content/)."""
    (root / "content").mkdir(parents=True)
    (root / "content" / "accueil.md").write_text("# Accueil\n", encoding="utf-8")
    for name, content in (templates or {}).items():
        target = root / "templates" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def run_build(mind: Path, *args: str) -> subprocess.CompletedProcess:
    """The ENGINE's build.py on a decoupled mind (ATLAS_MIND): the engine
    skeletons come from the repo's real templates/ folder."""
    env = os.environ.copy()
    env["ATLAS_MIND"] = str(mind)
    env.pop("KB_AUTH_ENABLED", None)
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env["PYTHONPATH"] = str(REPO_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, "-m", "build", *args],
        cwd=str(mind), env=env, capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"build.py failed (exit {result.returncode}):\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}")
    return result


def extract_doc_templates(index_html: str) -> dict:
    """The JSON object injected in place of __TEMPLATES__."""
    match = DOC_TEMPLATES_RE.search(index_html)
    if match is None:
        raise AssertionError("DOC_TEMPLATES not found in the generated HTML")
    templates, _ = json.JSONDecoder().raw_decode(index_html, match.end())
    return templates


class TestEngineTemplatesDiscovered(unittest.TestCase):
    """Mind without templates/: the engine's NEUTRAL skeletons (note,
    reunion) are discovered at build time and injected into dist/index.html."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="atlas-tpl-")
        cls.mind = Path(cls._tmp.name)
        make_mind(cls.mind)
        run_build(cls.mind)
        cls.index = (cls.mind / "dist" / "index.html").read_text(
            encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_engine_templates_injected(self):
        templates = extract_doc_templates(self.index)
        self.assertEqual(set(templates), ENGINE_TEMPLATES)
        self.assertEqual(templates["note"], ENGINE_NOTE_CONTENT)
        self.assertIn("## Décisions", templates["reunion"])

    def test_injected_json_is_well_formed(self):
        # extract_doc_templates' json.loads is already the shape test; we
        # additionally check the {label: content} contract (str → str) and that
        # the substitution tokens are present as-is.
        templates = extract_doc_templates(self.index)
        for label, content in templates.items():
            self.assertIsInstance(label, str)
            self.assertIsInstance(content, str)
            self.assertIn("{{title}}", content)
        self.assertNotIn("__TEMPLATES__", self.index)

    def test_personal_templates_left_the_engine(self):
        # The personal templates are no longer hard-coded in the viewer: neither
        # their option labels nor their bodies. Only the Empty option stays
        # fixed; the PoB option left with the example extension
        # (examples/extensions/pob/), a bare mind no longer has any trace of it.
        for marker in ("Bilan mensuel", "Cahier des charges",
                       "Cours / formation", "## Réalisations",
                       "## Stakeholders"):
            self.assertNotIn(marker, self.index, marker)
        self.assertIn('value="blank"', self.index)
        self.assertNotIn('value="pob"', self.index)
        self.assertNotIn("Path of Building", self.index)

    def test_offline_build_embeds_templates_too(self):
        run_build(self.mind, "--offline")
        offline = (self.mind / "dist" / "index-offline.html").read_text(
            encoding="utf-8")
        templates = extract_doc_templates(offline)
        self.assertEqual(set(templates), ENGINE_TEMPLATES)


class TestMindTemplates(unittest.TestCase):
    """<mind>/templates/*.md: a mind skeleton is ADDED (label = filename
    without extension) and a same-named one OVERRIDES the engine's."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="atlas-tpl-mind-")
        cls.mind = Path(cls._tmp.name)
        make_mind(cls.mind, templates={
            "compte-rendu.md": "# {{title}}\n\n_{{isoDate}}_\n\n## Suivi\n",
            "note.md": "# {{title}}\n\nNote surchargée par le mind.\n",
        })
        run_build(cls.mind)
        cls.templates = extract_doc_templates(
            (cls.mind / "dist" / "index.html").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_mind_template_added_with_filename_label(self):
        self.assertEqual(set(self.templates), ENGINE_TEMPLATES | {"compte-rendu"})
        self.assertEqual(self.templates["compte-rendu"],
                         "# {{title}}\n\n_{{isoDate}}_\n\n## Suivi\n")

    def test_mind_template_overrides_engine(self):
        self.assertEqual(self.templates["note"],
                         "# {{title}}\n\nNote surchargée par le mind.\n")
        # The non-overridden engine skeleton stays the engine's.
        self.assertIn("## Décisions", self.templates["reunion"])


class TestLoadDocTemplatesUnit(unittest.TestCase):
    """load_doc_templates: ordered merge (the last folder wins), missing
    folders tolerated, only *.md files are discovered."""

    def test_merge_order_and_missing_dirs(self):
        with tempfile.TemporaryDirectory(prefix="atlas-tpl-unit-") as tmp:
            engine = Path(tmp) / "engine"
            mind = Path(tmp) / "mind"
            engine.mkdir()
            mind.mkdir()
            (engine / "note.md").write_text("moteur", encoding="utf-8")
            (engine / "reunion.md").write_text("réunion", encoding="utf-8")
            (mind / "note.md").write_text("mind", encoding="utf-8")
            (mind / "perso.md").write_text("perso", encoding="utf-8")
            (mind / "ignore.txt").write_text("pas un squelette",
                                              encoding="utf-8")
            templates = build.load_doc_templates(
                engine, mind, Path(tmp) / "absent")
            self.assertEqual(templates, {
                "note": "mind",         # the mind overrides the engine
                "reunion": "réunion",   # engine kept
                "perso": "perso",       # added by the mind
            })


if __name__ == "__main__":
    unittest.main()
