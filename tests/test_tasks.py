"""Tests of the global task rollup (#3).

- build.build_tasks_index: collects every GFM checkbox across docs, ignoring
  fenced code blocks; done/undone flagged.
- GET /_tasks-index.json: the index served online (built into dist/), excluding
  the dedicated [todo] file (quick.md) like the rest of the viewer.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

_REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if _REPO_SRC not in sys.path:
    sys.path.insert(0, _REPO_SRC)

import build  # noqa: E402
from harness import AtlasServer  # noqa: E402


class TestBuildTasksIndex(unittest.TestCase):
    """Pure-function checks on the checkbox collector."""

    def test_collects_checkboxes_and_flags_done(self):
        md = [{"path": "a.md", "body":
               "# A\n"
               "- [ ] todo one\n"
               "- [x] done two\n"
               "some prose\n"
               "  - [ ] indented three\n"
               "* [X] star done\n"}]
        tasks = build.build_tasks_index(md)
        by_text = {t["text"]: t for t in tasks}
        self.assertEqual(set(by_text), {"todo one", "done two", "indented three", "star done"})
        self.assertFalse(by_text["todo one"]["done"])
        self.assertTrue(by_text["done two"]["done"])
        self.assertTrue(by_text["star done"]["done"])      # * + [X]
        self.assertEqual(by_text["todo one"]["path"], "a.md")
        self.assertEqual(by_text["todo one"]["line"], 2)

    def test_ignores_code_fences(self):
        md = [{"path": "b.md", "body":
               "- [ ] real task\n"
               "```\n"
               "- [ ] not a task (in code)\n"
               "```\n"
               "~~~md\n"
               "- [ ] also code\n"
               "~~~\n"
               "- [x] another real\n"}]
        texts = {t["text"] for t in build.build_tasks_index(md)}
        self.assertEqual(texts, {"real task", "another real"})

    def test_empty_and_non_md_bodies(self):
        self.assertEqual(build.build_tasks_index([]), [])
        self.assertEqual(build.build_tasks_index([{"path": "x.html", "body": ""}]), [])


class TestTasksEndpoint(unittest.TestCase):
    """GET /_tasks-index.json — read-only → one server shared per class."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind={
            "projets/roadmap.md": "# Roadmap\n\n- [ ] Acheter du lait\n- [x] Finir le rapport\n",
            "notes/idees.md": "# Idées\n\n- [ ] Idée géniale\n",
            "accueil.md": "# Accueil\n\nPas de tâche ici.\n",
            # quick.md is the dedicated [todo] widget file → excluded from the rollup.
            "notes/quick.md": "## Taff\n\n- [ ] tâche du widget todo\n",
        })
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_rollup_lists_all_content_tasks(self):
        resp = self.srv.get("/_tasks-index.json")
        self.assertEqual(resp.status, 200)
        tasks = resp.json()
        by_text = {t["text"]: t for t in tasks}
        self.assertIn("Acheter du lait", by_text)
        self.assertIn("Finir le rapport", by_text)
        self.assertIn("Idée géniale", by_text)
        self.assertTrue(by_text["Finir le rapport"]["done"])
        self.assertFalse(by_text["Acheter du lait"]["done"])
        self.assertEqual(by_text["Acheter du lait"]["path"], "projets/roadmap.md")

    def test_rollup_excludes_the_todo_widget_file(self):
        tasks = self.srv.get("/_tasks-index.json").json()
        self.assertNotIn("tâche du widget todo", {t["text"] for t in tasks})

    def test_rollup_is_live_reflects_a_ticked_box_without_rebuild(self):
        # The rollup is computed from the CURRENT files, so ticking a box (as the
        # write-back does) shows up immediately — no rebuild of dist needed.
        with AtlasServer(mind={"projets/p.md": "# P\n\n- [ ] do the thing\n"}) as srv:
            before = {t["text"]: t["done"] for t in srv.get("/_tasks-index.json").json()}
            self.assertEqual(before.get("do the thing"), False)
            srv.path("projets/p.md").write_text(
                "# P\n\n- [x] do the thing\n", encoding="utf-8")
            after = {t["text"]: t["done"] for t in srv.get("/_tasks-index.json").json()}
            self.assertEqual(after.get("do the thing"), True)


if __name__ == "__main__":
    unittest.main()
