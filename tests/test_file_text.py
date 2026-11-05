"""Files are read for the AI and for search, with the stdlib only (an AI's client cannot open
them itself: claude.ai fetches allow-listed domains only): the text of a .docx/.xlsx/.pptx and
their OpenDocument cousins, headings as `#` lines (read_doc can ask for a section), a sheet's
rows as `a | b`; a PDF page by page, its words found back even when each glyph is placed on
its own. A scan or an image has no text: read_doc hands out a link that opens it for an hour
without signing in, and only that file."""
import io
import secrets
import sys
import tempfile
import time
import unittest
import zipfile
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import urlsplit

_TESTS_DIR = Path(__file__).resolve().parent
for p in (str(_TESTS_DIR.parent / "src"), str(_TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from harness import AtlasServer  # noqa: E402
from server.pure import file_links, file_text  # noqa: E402
from test_mcp_tools import _seed_api_token  # noqa: E402
from test_cloud_filestore import cloud_env  # noqa: E402

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
ODF = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
       'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
       'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"')


def _zip(parts: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in parts.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _para(text, style=None, listed=False):
    ppr = ""
    if style or listed:
        ppr = "<w:pPr>" + (f'<w:pStyle w:val="{style}"/>' if style else "") + \
              ("<w:numPr/>" if listed else "") + "</w:pPr>"
    return f"<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>"


DOCX = _zip({"word/document.xml": f'<w:document {W}><w:body>'
             + _para("Compte rendu", "Titre1") + _para("Intro") + _para("Point A", listed=True)
             + _para("Détails", "Heading2")
             + '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r></w:p></w:body></w:document>'})

XLSX = _zip({
    "xl/workbook.xml": f'<workbook {S} {R}><sheets><sheet name="Budget" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": f'<Relationships {REL}><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": f'<sst {S}><si><t>Poste</t></si><si><r><t>Mon</t></r><r><t>tant</t></r></si></sst>',
    "xl/worksheets/sheet1.xml": f'<worksheet {S}><sheetData>'
                                '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
                                '<row><c t="inlineStr"><is><t>Loyer</t></is></c><c><v>850</v></c></row>'
                                '</sheetData></worksheet>',
})

PPTX = _zip({
    "ppt/presentation.xml": f'<p:presentation {P} {R}><p:sldIdLst><p:sldId r:id="rB"/><p:sldId r:id="rA"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": f'<Relationships {REL}><Relationship Id="rA" Target="slides/slide1.xml"/>'
                                       '<Relationship Id="rB" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": f'<p:sld {P} {A}><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>',
    "ppt/slides/slide2.xml": f'<p:sld {P} {A}><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>',
})

ODT = _zip({"content.xml": f'<office:document-content {ODF}><office:body><office:text>'
            '<text:h text:outline-level="2">Ordre du jour</text:h>'
            '<text:p>un<text:s text:c="2"/>deux<text:tab/>trois</text:p>'
            '</office:text></office:body></office:document-content>'})

ODS = _zip({"content.xml": f'<office:document-content {ODF}><office:body><office:spreadsheet>'
            '<table:table table:name="Feuille1"><table:table-row>'
            '<table:table-cell><text:p>x</text:p></table:table-cell>'
            '<table:table-cell><text:p>42</text:p></table:table-cell>'
            '</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>'})


class TestOfficeText(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, name, data):
        path = self.dir / name
        path.write_bytes(data)
        return file_text.extract(path)

    def test_each_format_gives_its_text(self):
        self.assertEqual(self.read("cr.docx", DOCX).splitlines(),
                         ["# Compte rendu", "Intro", "- Point A", "## Détails", "a\tb"])
        self.assertEqual(self.read("budget.xlsx", XLSX).splitlines(),
                         ["## Budget", "Poste | Montant", "Loyer | 850"])
        self.assertEqual(self.read("deck.pptx", PPTX).splitlines(),
                         ["## Slide 1", "First", "## Slide 2", "Second"])
        self.assertEqual(self.read("odj.odt", ODT).splitlines(), ["## Ordre du jour", "un  deux\ttrois"])
        self.assertEqual(self.read("calc.ods", ODS).splitlines(), ["## Feuille1", "x | 42"])

    def test_what_is_not_read(self):
        self.assertIsNone(self.read("broken.docx", b"not a zip"))
        self.assertIsNone(self.read("other.docx", _zip({"word/other.xml": "<x/>"})))
        bomb = '<!DOCTYPE x [<!ENTITY a "aaaa">]><w:document ' + W + '/>'
        self.assertIsNone(self.read("bomb.docx", _zip({"word/document.xml": bomb})))
        self.assertIsNone(self.read("notes.pdf", b"%PDF"))


def _pdf(content: bytes, font: bytes, *extra: bytes, trailer: bytes = b"") -> bytes:
    """A one-page PDF: catalog, pages, the page, its font (object 4), its content (5), then
    `extra` objects numbered from 6."""
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            font, content, *extra]
    out = b"%PDF-1.4\n"
    for n, body in enumerate(objs, 1):
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    return out + b"trailer\n<< /Root 1 0 R " + trailer + b">>\n%%EOF\n"


def _stream(data: bytes, flate=False) -> bytes:
    if flate:
        data = zlib.compress(data)
    return b"<< /Length %d%s >>\nstream\n" % (len(data), b" /Filter /FlateDecode" if flate else b"") + data + b"\nendstream"


HELVETICA = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
# A browser's way: a two-byte font mapped back to Unicode, each glyph placed by its own move.
GLYPHS = b"<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>"
WIDTHS = b"<< /Type /Font /Subtype /CIDFontType2 /DW 1000 /W [1 [600 300 500 500]] >>"
CMAP = (b"begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange "
        b"2 beginbfchar <0001> <0048> <0002> <0069> endbfchar "
        b"1 beginbfrange <0003> <0004> [<0079> <006F>] endbfrange endcmap")


class TestPdfText(unittest.TestCase):
    def test_lines_kerning_and_an_8_bit_font(self):
        content = b"BT /F1 12 Tf 72 720 Td (Caf\\351 cr\\350me) Tj 0 -14 Td [(Sec)20(ond)-300(line)] TJ ET"
        self.assertEqual(file_text.pdf_text.extract(_pdf(_stream(content), HELVETICA)),
                         "## Page 1\nCafé crème\nSecond line")

    def test_words_come_back_when_each_glyph_is_placed_alone(self):
        content = (b"BT /F1 10 Tf 1 0 0 -1 50 100 Tm <0001> Tj 6 0 Td <0002> Tj "
                   b"8 0 Td <0003> Tj 5 0 Td <0004> Tj ET")
        pdf = _pdf(_stream(content, flate=True), GLYPHS, WIDTHS, _stream(CMAP))
        self.assertEqual(file_text.pdf_text.extract(pdf), "## Page 1\nHi yo")

    def test_the_drawing_around_the_text_is_passed_over(self):
        # A form's way: boxes and rules drawn between the lines, a matrix set right before the text;
        # and a long number given to a text operator, which a reader that could split a number in
        # two would never finish passing over.
        content = (b"q 0.9 g 50 690 500 40 re f Q 1 0 0 RG 0.5 w 50 688 m 550 688 l S "
                   b"BT /F1 12 Tf 1 0 0 1 72 700 Tm (Total) Tj ET 0 0 1 rg 72 650 m 72 640 l h f* "
                   b"BT 72 620.000000000000000000000000000000 Td (due) Tj ET")
        self.assertEqual(file_text.pdf_text.extract(_pdf(_stream(content), HELVETICA)), "## Page 1\nTotal\ndue")

    def test_a_scan_or_a_locked_file_gives_nothing(self):
        scan = _pdf(_stream(b"q 600 0 0 800 0 0 cm /Im1 Do Q"), b"<< >>").replace(b"/Font << /F1 4 0 R >>", b"")
        self.assertIsNone(file_text.pdf_text.extract(scan))
        locked = _pdf(_stream(b"BT /F1 12 Tf (x) Tj ET"), HELVETICA, trailer=b"/Encrypt 9 0 R ")
        self.assertIsNone(file_text.pdf_text.extract(locked))
        self.assertIsNone(file_text.pdf_text.extract(b"not a pdf"))


class TestTextKept(unittest.TestCase):
    """A file's text is taken out once: after a restart it is read back from the store."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir, self.store = Path(tmp.name), Path(tmp.name) / "store"
        for patch in (mock.patch.object(file_text._s, "CONFIG", SimpleNamespace(store_dir=self.store)),
                      mock.patch.object(file_text, "_SEEN", set())):
            patch.start()
            self.addCleanup(patch.stop)
        self.restart()
        self.addCleanup(file_text._extract.cache_clear)

    def restart(self):
        file_text._extract.cache_clear()
        file_text._SEEN.clear()

    def pdf(self, name, content):
        path = self.dir / name
        path.write_bytes(_pdf(_stream(content), HELVETICA))
        return path

    def test_a_restart_reads_the_text_back(self):
        text, scan = self.pdf("a.pdf", b"BT /F1 12 Tf (kept) Tj ET"), self.pdf("scan.pdf", b"q Q")
        with mock.patch.object(file_text.pdf_text, "extract", wraps=file_text.pdf_text.extract) as taken:
            for _ in range(2):
                self.assertEqual(file_text.extract(text), "## Page 1\nkept")
                self.assertIsNone(file_text.extract(scan))  # nothing to read: kept as that too
                self.restart()
        self.assertEqual(taken.call_count, 2)

    def test_the_store_keeps_only_what_the_mind_still_holds(self):
        kept, gone = self.pdf("kept.pdf", b"BT /F1 12 Tf (one) Tj ET"), self.pdf("gone.pdf", b"BT /F1 12 Tf (two) Tj ET")
        file_text.extract(kept), file_text.extract(gone)
        older = self.store / "text-cache" / "an-older-reader"
        older.mkdir(parents=True)
        self.restart()
        gone.unlink()
        file_text.extract(kept)
        file_text.prune()
        self.assertEqual(len(list((self.store / "text-cache").rglob("*.json"))), 1)
        self.assertFalse(older.exists())


class TestFileLinks(unittest.TestCase):
    def test_a_link_names_one_file_until_it_expires(self):
        secret = SimpleNamespace(CONFIG=SimpleNamespace(session_secret=b"k"))
        with mock.patch.object(file_links, "_s", secret):
            link = file_links.make("a/scan.pdf", now=1000)
            self.assertEqual(file_links.verify(link, now=1000), "a/scan.pdf")
            self.assertIsNone(file_links.verify(link, now=1000 + file_links.TTL + 1))
            self.assertIsNone(file_links.verify(link.replace("scan", "other"), now=1000))


class TestFilesForTheAI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        files = {"cr.docx": DOCX, "scan.pdf": b"%PDF-1.4 scan", "budget.csv": b"a,b\n1,2\n",
                 "cv.pdf": _pdf(_stream(b"BT /F1 12 Tf 72 720 Td (Responsable technique) Tj ET"), HELVETICA)}
        (cls.srv.content_root / "bureau").mkdir()
        for name, data in files.items():
            (cls.srv.content_root / "bureau" / name).write_bytes(data)
        cls.token = _seed_api_token(cls.srv)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def call(self, tool, **arguments):
        resp = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": arguments}})
        self.assertEqual(resp.status, 200)
        return resp.json()["result"]

    def test_read_doc_gives_the_text_of_an_office_file(self):
        result = self.call("read_doc", path="bureau/cr.docx", section="Détails")
        self.assertFalse(result.get("isError"), result)
        self.assertIn("a\tb", result["content"][0]["text"])
        self.assertIn("read-only", result["content"][1]["text"])
        self.assertIn("1,2", self.call("read_doc", path="bureau/budget.csv")["content"][0]["text"])

    def test_read_doc_gives_the_text_of_a_pdf(self):
        result = self.call("read_doc", path="bureau/cv.pdf", section="Page 1")
        self.assertFalse(result.get("isError"), result)
        self.assertIn("Responsable technique", result["content"][0]["text"])

    def test_search_finds_words_inside_office_files_and_pdfs(self):
        hits = self.call("search_docs", q="Compte rendu")["structuredContent"]["hits"]
        self.assertIn("bureau/cr.docx", [h["path"] for h in hits])
        hits = self.call("search_docs", q="responsable technique")["structuredContent"]["hits"]
        self.assertIn("bureau/cv.pdf", [h["path"] for h in hits])

    def test_a_scanned_pdf_comes_as_a_link_that_opens_it_for_an_hour(self):
        text = self.call("read_doc", path="bureau/scan.pdf")["content"][0]["text"]
        self.assertIn("no text in it", text)
        link = urlsplit(text.rsplit(" ", 1)[-1]).path
        resp = self.srv.get(link)
        self.assertEqual((resp.status, resp.body), (200, b"%PDF-1.4 scan"))
        self.assertEqual(resp.headers.get("Content-Type"), "application/pdf")
        self.assertEqual(self.srv.get(link.replace("scan.pdf", "cr.docx")).status, 404)

    def test_an_expired_or_forged_link_opens_nothing(self):
        self.assertEqual(self.srv.get(f"/f/{int(time.time()) - 5}.{secrets.token_hex(16)}/bureau/scan.pdf").status, 404)
        self.assertEqual(self.srv.get(f"/f/{int(time.time()) + 600}.{secrets.token_hex(16)}/bureau/scan.pdf").status, 404)


if __name__ == "__main__":
    unittest.main()
