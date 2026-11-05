"""The text inside a file that is not a note, for an AI to read and for search to find, with
the stdlib: .docx, .xlsx and .pptx (Office Open XML) and their OpenDocument cousins are zips of
XML; a PDF goes through server.pure.pdf_text. Headings come out as `#` lines (a PDF's pages as
`## Page N`), so a part can be asked for by name like a note's section; a sheet's rows come out
as `a | b | c`. Read-only: the file itself is never rewritten."""
import hashlib
import json
import os
import re
import shutil
import zipfile
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path
from posixpath import dirname, join, normpath

import server as _s
from server.pure import pdf_text

EXTS = (".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".pdf")
MAX_CHARS = 1_000_000
_MAX_PART = 50 << 20
_MAX_COLUMNS = 16384  # a sheet's last column (XFD) in Excel and LibreOffice alike

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
_T = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
_TB = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_D = "{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}"


def extract(path):
    """The file's text, or None when it is not one of EXTS or cannot be read."""
    try:
        st = path.stat()
    except OSError:
        return None
    return _extract(str(path), st.st_mtime_ns, st.st_size)


@lru_cache(maxsize=32)
def _extract(path, _mtime, size):
    ext = path[path.rfind("."):].lower()
    if ext == ".pdf":
        if size > pdf_text.MAX_BYTES:
            return None
    elif ext not in _READERS:
        return None
    key = _digest(path)
    if key is None:
        return None
    kept = _kept(key)
    if kept is not _NOT_KEPT:
        return kept
    text = _pdf(path) if ext == ".pdf" else _office(path, _READERS[ext])
    _keep(key, text)
    return text


def _office(path, reader):
    lines, size = [], 0
    try:
        with zipfile.ZipFile(path) as zf:
            for line in reader(zf):
                if line.strip():
                    lines.append(line)
                    size += len(line) + 1
                    if size > MAX_CHARS:  # the rest would be cut anyway
                        break
    except (zipfile.BadZipFile, KeyError, IndexError, ET.ParseError, OSError, ValueError):
        return None
    return "\n".join(lines)[:MAX_CHARS]


def _pdf(path):
    try:
        with open(path, "rb") as f:
            text = pdf_text.extract(f.read())
    except Exception:  # a damaged or unusual file never breaks a read or a search
        return None
    return text[:MAX_CHARS] if text else None


# A text taken out of a file is kept in the store under the file's content hash, so a restart or a
# deploy reads it back instead of taking every PDF apart again. It is only as good as the code that
# took it out: each version of that code keeps its own.
_READER = hashlib.sha256(Path(__file__).read_bytes() + Path(pdf_text.__file__).read_bytes()).hexdigest()[:16]
_NOT_KEPT = object()
_SEEN = set()  # the content hashes read since the start: what prune() keeps


def _kept_dir():
    store = getattr(_s.CONFIG, "store_dir", None)
    return Path(store) / "text-cache" / _READER if store else None


def _digest(path):
    try:
        with open(path, "rb") as f:
            key = hashlib.file_digest(f, "sha256").hexdigest()
    except OSError:
        return None
    _SEEN.add(key)
    return key


def _kept(key):
    folder = _kept_dir()
    try:
        return json.loads((folder / f"{key}.json").read_text(encoding="utf-8")) if folder else _NOT_KEPT
    except (OSError, ValueError):
        return _NOT_KEPT


def _keep(key, text):
    folder = _kept_dir()
    if folder is None:
        return
    try:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / f"{key}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(text), encoding="utf-8")
        os.replace(tmp, folder / f"{key}.json")
    except OSError:
        pass  # a store that can't be written to only means taking the text out again next time


def prune():
    """Drop the texts kept for files no longer in the mind, and those of an older reader. Call it
    after a pass over every file, once each one's hash has been seen."""
    folder = _kept_dir()
    if folder is None or not folder.parent.is_dir():
        return
    for other in folder.parent.iterdir():
        if other != folder:
            shutil.rmtree(other, ignore_errors=True)
    for kept in folder.glob("*.json"):
        if kept.stem not in _SEEN:
            kept.unlink(missing_ok=True)


def _xml(zf, name):
    info = zf.getinfo(name)
    if info.file_size > _MAX_PART:
        raise ValueError("part too large")
    data = zf.read(info)
    if b"<!DOCTYPE" in data[:4096]:  # never in these formats: entity tricks only
        raise ValueError("doctype")
    root = ET.fromstring(data)
    for parent in root.iter():  # a text box is written twice, once as a fallback drawing
        for child in [c for c in parent if c.tag == _MC_FALLBACK]:
            parent.remove(child)
    return root


def _targets(zf, part):
    """{relationship id: part name} of an OOXML part. A target is relative to the part, or to
    the package's root when it starts with "/" (openpyxl writes them so)."""
    rels = join(dirname(part), "_rels", part.rsplit("/", 1)[-1] + ".rels")
    return {r.get("Id"): normpath(join(dirname(part), r.get("Target", ""))).lstrip("/")
            for r in _xml(zf, rels).iter(_REL + "Relationship")}


def _column(ref, next_column):
    """0-based column of a cell reference ("C2" -> 2), or `next_column` when it has none."""
    letters = re.match(r"[A-Z]*", ref or "").group()
    if not letters:
        return next_column
    n = 0
    for letter in letters:
        n = n * 26 + ord(letter) - ord("A") + 1
    return min(n - 1, _MAX_COLUMNS)


_W_BREAKS = {_W + "tab": "\t", _W + "br": "\n", _W + "cr": "\n"}


def _docx(zf):
    for p in _xml(zf, "word/document.xml").iter(_W + "p"):
        text = "".join((n.text or "") if n.tag == _W + "t" else _W_BREAKS[n.tag]
                       for n in p.iter() if n.tag == _W + "t" or n.tag in _W_BREAKS)
        style = p.find(f"{_W}pPr/{_W}pStyle")
        style = (style.get(_W + "val") or "") if style is not None else ""
        m = re.match(r"(?i)(?:heading|titre)\s*(\d)$", style)
        if m or style.lower() in ("title", "titre"):
            yield "#" * int(m.group(1) if m else 1) + " " + text
        elif p.find(f"{_W}pPr/{_W}numPr") is not None:
            yield "- " + text
        else:
            yield text


def _pptx(zf):
    deck = "ppt/presentation.xml"
    targets = _targets(zf, deck)
    for n, sld in enumerate(_xml(zf, deck).iter(_P + "sldId"), 1):
        yield f"## Slide {n}"
        for p in _xml(zf, targets[sld.get(_R + "id")]).iter(_A + "p"):
            yield "".join(t.text or "" for t in p.iter(_A + "t"))


def _xlsx(zf):
    book = "xl/workbook.xml"
    shared = []
    if "xl/sharedStrings.xml" in zf.namelist():
        shared = ["".join(t.text or "" for t in si.iter(_S + "t"))
                  for si in _xml(zf, "xl/sharedStrings.xml").iter(_S + "si")]
    targets = _targets(zf, book)
    for sheet in _xml(zf, book).iter(_S + "sheet"):
        yield "## " + (sheet.get("name") or "")
        for row in _xml(zf, targets[sheet.get(_R + "id")]).iter(_S + "row"):
            cells = []
            for c in row.iter(_S + "c"):
                # An empty cell is left out of the file: its neighbour's reference keeps the gap.
                cells += [""] * (_column(c.get("r"), len(cells)) - len(cells))
                v = c.find(_S + "v")
                if c.get("t") == "s" and v is not None:
                    cells.append(shared[int(v.text)])
                elif c.get("t") == "inlineStr":
                    cells.append("".join(t.text or "" for t in c.iter(_S + "t")))
                else:
                    cells.append((v.text or "") if v is not None else "")
            yield " | ".join(cells).rstrip(" |")


def _odf_text(el):
    parts = [el.text or ""]
    for c in el:
        if c.tag == _T + "s":
            parts.append(" " * int(c.get(_T + "c", "1")))
        elif c.tag == _T + "tab":
            parts.append("\t")
        elif c.tag == _T + "line-break":
            parts.append("\n")
        else:
            parts.append(_odf_text(c))
        parts.append(c.tail or "")
    return "".join(parts)


def _odf_lines(el, sheets):
    for c in el:
        if c.tag == _T + "h":
            yield "#" * int(c.get(_T + "outline-level", "1")) + " " + _odf_text(c)
        elif c.tag == _T + "p":
            yield _odf_text(c)
        elif c.tag == _TB + "table-row":
            cells = []
            for cell in c:  # equal neighbours, empty ones included, are written once with their count
                repeat = int(cell.get(_TB + "number-columns-repeated", "1"))
                cells += [_odf_text(cell).strip()] * min(repeat, _MAX_COLUMNS - len(cells))
            yield " | ".join(cells).rstrip(" |")
        else:
            if (c.tag == _TB + "table" and sheets) or c.tag == _D + "page":
                yield "## " + (c.get(_TB + "name") or c.get(_D + "name") or "")
            yield from _odf_lines(c, sheets)


_READERS = {
    ".docx": _docx,
    ".pptx": _pptx,
    ".xlsx": _xlsx,
    ".odt": lambda zf: _odf_lines(_xml(zf, "content.xml"), False),
    ".odp": lambda zf: _odf_lines(_xml(zf, "content.xml"), False),
    ".ods": lambda zf: _odf_lines(_xml(zf, "content.xml"), True),
}
