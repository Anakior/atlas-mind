"""A move reads only the docs that may link to what moves: the build's backlinks index says
which, every doc written since it was built is read too, and without a usable index (or with
a moving doc newer than it) all of them are."""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import build  # noqa: E402
from server.pure import docs  # noqa: E402

OLD = time.time() - 3600


class TestMoveIndex(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-move-index-"))
        self.content = self.tmp / "content"
        self.index = self.tmp / "_backlinks.json"
        self._write("notes/b.md", "# B\n")
        self._write("a.md", "Voir [[notes/b]].\n")
        self._write("c.md", "Voir [[b]].\n")
        self._write("unlisted.md", "Voir [[notes/b]].\n")  # a link the index does not know
        self._index({"notes/b.md": {"in": ["a.md", "c.md"], "out": []},
                     "a.md": {"in": [], "out": ["notes/b.md"]},
                     "c.md": {"in": [], "out": ["notes/b.md"]},
                     "unlisted.md": {"in": [], "out": []}})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, rel, text, when=OLD):
        path = self.content / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        os.utime(path, (when, when))

    def _index(self, graph):
        self.index.write_text(json.dumps(graph), encoding="utf-8")

    def _read(self, rel):
        return (self.content / rel).read_text(encoding="utf-8")

    def test_only_the_indexed_docs_are_read(self):
        status, payload = docs.move_md_with_relink("notes/b.md", "archive/b.md", self.content, build,
                                                   index=self.index)
        self.assertEqual(status, "ok")
        self.assertIn("[[archive/b]]", self._read("a.md"))
        self.assertEqual(self._read("c.md"), "Voir [[b]].\n")  # by name: still resolves
        self.assertIn("[[notes/b]]", self._read("unlisted.md"))  # trusted the index: not read
        self.assertEqual(payload["links_updated"], 1)

    def test_a_doc_written_since_the_index_is_read(self):
        self._write("fresh.md", "Voir [[notes/b]].\n", when=time.time())
        docs.move_md_with_relink("notes/b.md", "archive/b.md", self.content, build, index=self.index)
        self.assertIn("[[archive/b]]", self._read("fresh.md"))

    def test_without_a_usable_index_every_doc_is_read(self):
        self.index.write_text("not json", encoding="utf-8")
        docs.move_md_with_relink("notes/b.md", "archive/b.md", self.content, build, index=self.index)
        self.assertIn("[[archive/b]]", self._read("unlisted.md"))

    def test_a_folder_move_reads_what_links_into_it(self):
        moved = docs.move_dir_with_relink(self.content / "notes", self.content / "archive/notes",
                                          self.content, build, index=self.index)
        self.assertEqual([r["path"] for r in moved], ["a.md"])
        self.assertIn("[[archive/notes/b]]", self._read("a.md"))


if __name__ == "__main__":
    unittest.main()
