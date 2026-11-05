"""What is kept beside a doc by its path follows it when it moves: its annotations, its
confirmations, the contradiction verdicts that name it; a new doc at the old path starts
clean. Run: python tests/test_sidecars_follow.py"""
import json
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402

MIND = {"notes/target.md": "# Target\n\nhello world line\n", "notes/other.md": "# Other\n",
        "projets/plan.md": "# Plan\n"}


class TestSidecarsFollow(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(mind=MIND)
        self.srv.start()
        self.h = {"Origin": self.srv.base_url}

    def tearDown(self):
        self.srv.stop()

    def notes(self, rel):
        return self.srv.get(f"/api/notes?path={rel}", headers=self.h).json()

    def keyed(self, name, key):
        return json.loads((self.srv.root / name).read_text(encoding="utf-8"))[key]

    def seed(self, *paths):
        (self.srv.root / ".attestations.json").write_text(json.dumps({"version": 1, "attestations": [
            {"path": p, "verdict": "holds", "hash": "x"} for p in paths]}), encoding="utf-8")
        (self.srv.root / ".contradictions.json").write_text(json.dumps({"version": 1, "verdicts": [
            {"a": paths[0], "b": "notes/other.md", "verdict": "real", "a_hash": "ha", "b_hash": "hb"}]}),
            encoding="utf-8")

    def move(self, frm, to):
        resp = self.srv.post("/api/file/move", headers=self.h, json_body={"from": frm, "to": to})
        self.assertEqual(resp.status, 200, resp.text)

    def test_a_moved_doc_takes_its_annotations_and_verdicts(self):
        made = self.srv.post("/api/notes", headers=self.h, json_body={
            "path": "notes/target.md", "note": "mine", "exact": "hello world"})
        self.assertEqual(made.status, 200)
        self.seed("notes/target.md")
        self.move("notes/target.md", "zz/renamed.md")
        self.assertEqual([n["note"] for n in self.notes("zz/renamed.md")], ["mine"])
        self.assertEqual(self.notes("notes/target.md"), [])
        self.assertEqual([a["path"] for a in self.keyed(".attestations.json", "attestations")], ["zz/renamed.md"])
        # The rename put the pair out of order: each side keeps its own hash.
        verdict = self.keyed(".contradictions.json", "verdicts")[0]
        self.assertEqual((verdict["a"], verdict["a_hash"], verdict["b"], verdict["b_hash"]),
                         ("notes/other.md", "hb", "zz/renamed.md", "ha"))
        put = self.srv.put("/api/file", headers=self.h, json_body={"path": "notes/target.md", "content": "# New\n"})
        self.assertEqual(put.status, 200)
        self.assertEqual(self.notes("notes/target.md"), [])

    def test_a_renamed_folder_takes_them_too(self):
        self.srv.post("/api/notes", headers=self.h, json_body={
            "path": "projets/plan.md", "note": "folder note", "exact": "Plan"})
        self.seed("projets/plan.md")
        resp = self.srv.post("/api/dir/rename", headers=self.h, json_body={"from": "projets", "to": "work"})
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual([n["note"] for n in self.notes("work/plan.md")], ["folder note"])
        self.assertEqual([a["path"] for a in self.keyed(".attestations.json", "attestations")], ["work/plan.md"])


if __name__ == "__main__":
    unittest.main()
