"""A doc is shown by the title it gives itself, never one stored aside: `title:` in its
frontmatter, else its first `# heading` outside code, the <title> of a page; the file name
when it has none. The tree lists files in the order those titles read."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import build  # noqa: E402
from build.parse import _doc_title  # noqa: E402


class TestDocTitle(unittest.TestCase):
    def test_where_the_title_comes_from(self):
        cases = {
            "# Réunion avec **Paul**\n\ntexte": "Réunion avec Paul",
            "---\ntitle: \"Mon titre\"\ntags: [a]\n---\n# Autre\n": "Mon titre",
            "---\ntags: [a]\n---\n\n# Après le bloc\n": "Après le bloc",
            "```sh\n# un commentaire\n```\n# Le vrai titre\n": "Le vrai titre",
            "# Voir [[note|la note]] et [le site](https://x.y) `code`\n": "Voir la note et le site code",
            "Pas de titre\n\n## Un sous-titre\n": "",
        }
        for text, title in cases.items():
            self.assertEqual(_doc_title(text, ".md"), title, text)
        self.assertEqual(_doc_title("<html><title> Deck &amp; co </title>", ".html"), "Deck & co")

    def test_the_tree_reads_in_title_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "zz.md").write_text("# Alpha\n", encoding="utf-8")
            (root / "aa.md").write_text("Sans titre\n", encoding="utf-8")
            (root / "scan.pdf").write_bytes(b"%PDF")
            (root / "dossier").mkdir()
            (root / "dossier" / "x.md").write_text("# X\n", encoding="utf-8")
            tree = build.walk(root)
            shown = [(c.get("title") or c["name"]) for c in tree["children"]]
            self.assertEqual(shown, ["dossier", "aa.md", "Alpha", "scan.pdf"])
            self.assertNotIn("title", tree["children"][1])


if __name__ == "__main__":
    unittest.main()
