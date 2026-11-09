"""Tests of the huissier (quotes): every quotation of a note checked word for word against the
other files of the mind, a PDF's text included: found (file, line, page), altered (what the file
really says) or missing; told to an agent when it reads a note and when it writes one.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
for _p in (_TESTS_DIR, REPO_SRC):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from harness import AtlasServer  # noqa: E402
from test_admin import (  # noqa: E402
    ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, cloud_env, file_store_of,
    seed_admin_and_viewer, session_cookie)
from test_contradictions_golden import _Mind  # noqa: E402
from test_file_text import HELVETICA, _pdf, _stream  # noqa: E402
from test_mcp_agentic import _raw  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402
from test_mcp_tools import _call  # noqa: E402
from server.pure import quotes  # noqa: E402

MINUTES = (b"BT /F1 12 Tf 72 720 Td (Chaque heure investie dans du neuf sur la version actuelle coute "
           b"trois fois son prix.) Tj 0 -14 Td (Le ratio est un point de depart, pas une definition.) Tj ET")
DOSSIER = """# Dossier

On m'a dit « le ratio est un point de départ, pas une définition » en réunion.
Puis : « Chaque heure investie dans du neuf coûte trois fois son prix ».
Et aussi « une phrase que personne n'a jamais écrite ».
Juste « point de départ » ou "trop court ici".
"""


class TestExtract(unittest.TestCase):
    def test_what_counts_as_a_quotation(self):
        text = ('---\ntitle: "un titre entre guillemets droits"\n---\n'
                '# Doc\n\nIl a dit « une vraie citation de six mots ».\n'
                'Elle : “une autre citation assez longue”, puis "une troisième entre guillemets droits".\n'
                'Code : `"une chaîne dans du code"` et\n```\n« dans un bloc de code ici »\n```\n'
                'Un « nom court » ne compte pas.\n')
        self.assertEqual([(q["line"], q["text"]) for q in quotes.extract(text)],
                         [(6, "une vraie citation de six mots"), (7, "une autre citation assez longue"),
                          (7, "une troisième entre guillemets droits")])

    def test_compared_as_words(self):
        self.assertEqual(quotes._words("C’est l’**énergie** — [[plan|le plan]], 30 %"),
                         quotes._words("c'est l'energie le plan 30%"))


class TestCheck(_Mind):
    """In-process: the minutes of a meeting as a PDF, a dossier quoting them."""
    DOCS = {"dossier.md": DOSSIER, "notes/autre.md": "# Autre\n\nRien à voir.\n"}

    def setUp(self):
        super().setUp()
        pdf = self.root / "content" / "pieces" / "reunion.pdf"
        pdf.parent.mkdir()
        pdf.write_bytes(_pdf(_stream(MINUTES), HELVETICA))

    def test_each_quote_gets_its_state(self):
        found, altered, missing = quotes.check("dossier.md", DOSSIER)
        self.assertEqual((found["line"], found["state"]), (3, "found"))
        self.assertEqual(found["source"], {"path": "pieces/reunion.pdf", "line": 3, "section": "Page 1"})
        self.assertEqual(altered["state"], "altered")
        self.assertEqual(altered["source"]["path"], "pieces/reunion.pdf")
        self.assertIn("sur la version actuelle", altered["source"]["says"])  # what was cut from it
        self.assertEqual(missing["state"], "missing")

    def test_a_note_is_not_its_own_source(self):
        self.assertEqual(quotes.check("dossier.md", DOSSIER, lines=(5, 5))[0]["state"], "missing")


MIND = {
    "pieces/transcript.md": "# Transcript\n\nLe client a dit : nous voulons trois relances par semaine au maximum.\n",
    "dossier.md": "# Dossier\n\nLe client : « nous voulons trois relances par semaine au maximum ».\n",
    "notes/cr.md": "# CR\n\nLe client : « nous voulons trois relances au maximum ».\n",
}


class TestAgent(unittest.TestCase):
    """Read-write → a fresh server per test."""

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def read(self, path):
        return [b["text"] for b in _raw(self.srv, self.token, "read_doc", {"path": path})["content"]]

    def test_read_doc_tells_the_altered_quote(self):
        body, footer, said = self.read("notes/cr.md")
        self.assertIn("quotes: 0 found, 1 altered, 0 nowhere in the mind", footer)
        self.assertIn("pieces/transcript.md", said)
        self.assertIn("par semaine", said)
        self.assertEqual(len(self.read("dossier.md")), 2)  # found: a word in the footer, nothing more

    def test_a_write_is_told_about_its_new_quotes(self):
        err, text = _call(self.srv, self.token, "create_doc", {
            "path": "notes/nouveau.md", "ai": "claude",
            "content": "# Nouveau\n\nIl a dit « une phrase que personne dans ce mind n'a écrite ».\n"})
        self.assertFalse(err, text)
        self.assertIn("New quotes: 0 found, 0 altered, 1 nowhere in the mind", text)
        self.assertIn("line 3", text)
        err, text = _call(self.srv, self.token, "edit_doc", {
            "path": "dossier.md", "ai": "claude", "old_string": "# Dossier", "new_string": "# Le dossier"})
        self.assertFalse(err, text)
        self.assertNotIn("quotes:", text)  # no new quote: nothing to say


PRIVATE = {
    "secret/pv.md": "# PV\n\nLe conseil a décidé de fermer le site de Lyon en mars prochain.\n",
    "notes/cr.md": "# CR\n\nOn nous a dit « le conseil a décidé de fermer le site de Lyon en mars prochain ».\n",
}


class TestPrivacy(unittest.TestCase):
    """A quote is checked against the files the reader may see: a private source stays unknown."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env(), mind=PRIVATE)
        cls.srv.start()
        fs = file_store_of(cls.srv)
        seed_admin_and_viewer(fs)
        fs.set_owner("secret/pv.md", "user:" + ADMIN_EMAIL)  # owned: private to the admin
        _, cls.bare = fs.create_api_identity("bare-bot")
        cls.admin = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.viewer = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def route(self, cookie, path):
        return self.srv.get("/api/quotes?path=" + path, headers={"Cookie": cookie})

    def test_a_private_source_stays_unknown(self):
        blocks = [b["text"] for b in _raw(self.srv, self.bare, "read_doc", {"path": "notes/cr.md"})["content"]]
        self.assertIn("quotes: 0 found, 0 altered, 1 nowhere in the mind", blocks[1])
        self.assertNotIn("secret/pv.md", "".join(blocks))
        viewer = self.route(self.viewer, "notes/cr.md").json()
        self.assertEqual([q["state"] for q in viewer["quotes"]], ["missing"])

    def test_the_viewer_route(self):
        admin = self.route(self.admin, "notes/cr.md").json()
        self.assertEqual(admin["quotes"][0]["state"], "found")
        self.assertEqual(admin["quotes"][0]["source"]["path"], "secret/pv.md")
        self.assertFalse(admin["cites_files"])  # a note's source, not a file
        self.assertEqual(self.route(self.admin, "secret/pv.pdf").status, 400)
        self.assertEqual(self.route(self.viewer, "secret/pv.md").status, 404)  # no existence oracle


if __name__ == "__main__":
    unittest.main()
