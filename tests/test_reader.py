"""Tests of open_doc, the reader: a doc with its history laid on its passages. A plan written on
2025-01-15, reworded by its reader on 02-01, then reworked by Claude on 03-01 (a section
removed, a list item rewritten, a passage written in place of one it removed): who last
changed each passage, what changed since the reader's last edit or confirmation, the ghosts,
each passage's life, and what the model reads of it.
"""
import base64
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402

SEED_DATE = "2025-01-15T12:00:00"
PIXEL = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
PLAN = """# Plan

## Goals

Ship the reader beside the conversation, with the history laid on the doc.

- The wheel scrolls through every version of the doc.
- Ghosts show the passages removed since they left.

See [[roadmap]] for the dates.

## Risks

The history walk may be slow on a long doc with many versions and authors.

## Budget

Two weeks of work for one developer, tests and release included in that time.
"""
MIND = {"notes/plan.md": PLAN, "notes/roadmap.md": "# Roadmap\n\nThe reader ships in the next minor.\n",
        "notes/raw.html": "<p>not a note</p>"}


def commit(srv, day, message, author=None, ai=None):
    srv.git("add", "-A", check=True)
    env = {"GIT_AUTHOR_DATE": day, "GIT_COMMITTER_DATE": day}
    if author:
        env.update(GIT_AUTHOR_NAME="Admin", GIT_AUTHOR_EMAIL=author)
    srv.git("commit", "-q", "-m", message + (f"\n\nX-Atlas-Author: ai/{ai}" if ai else ""), check=True, env=env)


def rework(srv):
    """The reader rewords the goals on 02-01; Claude reworks the plan on 03-01."""
    plan = srv.content_root / "notes/plan.md"
    text = PLAN.replace("with the history laid", "with its whole history laid")
    text = text.replace("Ship the reader", "![sketch](sketch.png)\n\nShip the reader")
    plan.write_text(text, encoding="utf-8", newline="\n")
    (srv.content_root / "notes/sketch.png").write_bytes(PIXEL)
    commit(srv, "2025-02-01T12:00:00", "docs: reword the goals", author=ADMIN_EMAIL)
    text = text.replace("## Risks\n\nThe history walk may be slow on a long doc with many versions and authors.\n\n", "")
    text = text.replace("- Ghosts show the passages removed since they left.",
                        "- Ghosts show, where they stood, the passages a commit removed.")
    text = text.replace("Two weeks of work for one developer, tests and release included in that time.",
                        "Three weeks for one developer, with time for tests, the release and a beta.")
    plan.write_text(text, encoding="utf-8", newline="\n")
    commit(srv, "2025-03-01T12:00:00", "docs: rework the plan", ai="claude")


class TestReader(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND, seed_date=SEED_DATE)
        self.srv.start()
        rework(self.srv)
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def call(self, tool, **args):
        resp = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
        return resp.json()["result"]

    def open(self, path="notes/plan.md"):
        result = self.call("open_doc", path=path)
        self.assertFalse(result.get("isError"), result)
        return result["structuredContent"], result["content"][0]["text"]

    def passage(self, view, start):
        return next(p for p in view["passages"] if view["strings"][p["s"]].startswith(start))

    def test_who_changed_what_since_the_last_edit(self):
        view, _ = self.open()
        commits = view["commits"]
        self.assertEqual([c["subject"] for c in commits][-2:], ["docs: reword the goals", "docs: rework the plan"])
        self.assertEqual(view["look"]["how"], "edit")
        self.assertEqual(commits[view["look"]["commit"]]["subject"], "docs: reword the goals")
        goals = self.passage(view, "Ship the reader")
        self.assertTrue(commits[goals["c"]]["you"])
        self.assertFalse(goals["since"])  # the reader's own change
        self.assertNotIn("email", commits[0])
        wheel = self.passage(view, "- The wheel")
        self.assertEqual(wheel["c"], 0)  # unchanged since the plan was written
        self.assertFalse(wheel["since"])
        for start in ("- Ghosts show, where", "Three weeks"):
            changed = self.passage(view, start)
            self.assertEqual(commits[changed["c"]]["ai"], "claude")
            self.assertTrue(changed["since"], start)
        self.assertEqual(len(view["versions"]), 3)
        self.assertTrue(view["complete"])

    def test_ghosts_stand_where_the_removed_passages_were(self):
        view, _ = self.open()
        [ghost] = [g for g in view["ghosts"] if g["since"]]
        self.assertEqual([view["strings"][s] for s in ghost["s"]],
                         ["## Risks", "The history walk may be slow on a long doc with many versions and authors."])
        self.assertTrue(view["strings"][view["passages"][ghost["after"]]["s"]].startswith("See [[roadmap]]"))
        self.assertEqual(view["commits"][ghost["c"]]["ai"], "claude")
        # The version before shows them, marked as removed since.
        before = view["versions"][1]
        removed = [view["strings"][s] for s, fate in zip(before["s"], before["fate"]) if fate == "r"]
        self.assertIn("## Risks", removed)

    def test_a_passage_life(self):
        view, _ = self.open()
        goals = self.passage(view, "Ship the reader")
        self.assertEqual([("born" in e, e["c"]) for e in goals["life"]], [(True, 0), (False, 1)])
        self.assertIn(["+", "its whole"], goals["life"][1]["diff"])
        # Reworded past recognition: written in place of the passage it replaced.
        budget = self.passage(view, "Three weeks")
        self.assertEqual(view["strings"][budget["life"][-1]["from"]],
                         "Two weeks of work for one developer, tests and release included in that time.")
        self.assertEqual(budget["life"][0], {"c": 0, "born": True})

    def test_a_confirmation_is_a_fresh_look(self):
        self.assertFalse(self.call("confirm_doc", path="notes/plan.md", verdict="holds").get("isError"))
        view, text = self.open()
        self.assertEqual(view["look"]["how"], "confirm")
        self.assertFalse(any(p["since"] for p in view["passages"]))
        self.assertIn("Nothing changed since", text)

    def test_what_the_model_reads(self):
        view, text = self.open()
        self.assertIn('Showing notes/plan.md ("Plan") to the user', text)
        self.assertIn("2 passages changed (by claude), 2 removed", text)
        self.assertIn("Outline: Plan / Goals / Budget", text)
        self.assertNotIn("Ship the reader", text)  # the text is read_doc's

    def test_pictures_and_links_come_resolved(self):
        view, _ = self.open()
        self.assertTrue(view["images"]["sketch.png"].startswith("data:image/png;base64,"))
        self.assertEqual(view["links"], {"roadmap": "notes/roadmap.md"})

    def test_refusals(self):
        self.assertTrue(self.call("open_doc", path="notes/raw.html").get("isError"))
        self.assertTrue(self.call("open_doc", path="notes/missing.md").get("isError"))

    def test_the_view_opens_beside_the_conversation(self):
        read = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "resources/read", "params": {"uri": "ui://atlas/reader"}}).json()
        content = read["result"]["contents"][0]
        self.assertEqual(content["_meta"]["ui"]["preferredDisplayMode"], "fullscreen")
        tools = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"}).json()["result"]["tools"]
        tool = next(t for t in tools if t["name"] == "open_doc")
        self.assertEqual(tool["_meta"]["ui"]["resourceUri"], "ui://atlas/reader")


if __name__ == "__main__":
    unittest.main()
