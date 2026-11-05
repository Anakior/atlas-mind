"""The text of a PDF with the stdlib only (zlib, re): an AI's client cannot open the file
itself (claude.ai fetches only allow-listed domains), so read_doc and search read it here.

A small reader: the objects (object streams included), the page tree, each font's map back
to Unicode (its ToUnicode CMap, else its 8-bit encoding), and the text operators of each
page. Pages come out as `## Page N` lines, so a page can be asked for like a section. A scan
holds no text to give (no OCR here) and an encrypted file is left alone: both give None, and
the AI gets the file itself instead."""
import re
import unicodedata
import zlib
from collections import namedtuple

MAX_BYTES = 25 << 20
MAX_PAGES = 1000
_MAX_STREAM = 64 << 20

Ref = namedtuple("Ref", "num gen")


class Name(str):
    """/Name"""


class Op(str):
    """A bare word: an operator in a page's content, `R` or `obj` in an object."""


_SEP = rb"\s\x00()<>\[\]{}/%"
_TOKEN = re.compile(rb"[\s\x00]+|%[^\r\n]*|(<<)|(>>)|(\[)|(\])|/([^" + _SEP + rb"]*)|<([0-9A-Fa-f\s]*)>"
                    rb"|(\()|([^" + _SEP + rb"]+)|(.)", re.S)
_NUMBER = re.compile(rb"[+-]?(?:\d+\.?\d*|\.\d+)\Z")
_INLINE_IMAGE_END = re.compile(rb"\sEI(?=[\s\x00]|\Z)")
# Drawing in a page's content (paths, colours, clipping, the graphics state) with its numbers, read
# in one match: none of it is text. A match ends on a drawing operator, so the numbers given to a
# text operator are left to it; each number ends on a space, so a run reads one way only.
_DRAWING = re.compile(rb"(?:(?:[+-]?(?:\d+\.?\d*|\.\d+)[\s\x00]+)*"
                      rb"(?:re|[mlcvyhn]|[fFbBWsS]\*?|cm|[wJjMdi]|ri|gs|[gG]|rg|RG|[kK]|cs|CS|scn?|SCN?|sh|[qQ])"
                      rb"(?=[\s\x00/\[\]<>()%]|\Z)[\s\x00]*)+")
_ESCAPES = {ord("n"): b"\n", ord("r"): b"\r", ord("t"): b"\t", ord("b"): b"\b", ord("f"): b"\f"}


def _literal(data, i):
    """A (string) starting at data[i] == '(' → (bytes, index after it)."""
    out, depth, i, n = bytearray(), 1, i + 1, len(data)
    while i < n:
        c = data[i]
        if c == 0x5C:  # backslash
            e = data[i + 1] if i + 1 < n else 0
            m = re.match(rb"[0-7]{1,3}", data[i + 1:i + 4])
            if m:
                out.append(int(m.group(), 8) & 0xFF)
                i += 1 + len(m.group())
                continue
            if e in _ESCAPES:
                out += _ESCAPES[e]
            elif e == 0x0D:  # a line continuation
                i += 1 if data[i + 2:i + 3] == b"\n" else 0
            elif e != 0x0A:
                out.append(e)
            i += 2
            continue
        if c == 0x28:
            depth += 1
        elif c == 0x29:
            depth -= 1
            if not depth:
                return bytes(out), i + 1
        out.append(c)
        i += 1
    return bytes(out), n


def _tokens(data, skip=None):
    """The tokens of PDF syntax: "<<" ">>" "[" "]" (plain str), Name, bytes for strings,
    int/float, Op for every other word. An inline image's binary data is passed over, and so
    is what `skip` matches where an operator's operands start."""
    i, n, start = 0, len(data), True
    while i < n:
        if start and skip is not None:
            drawn = skip.match(data, i)
            if drawn:
                i = drawn.end()
                continue
        m = _TOKEN.match(data, i)
        i = m.end()
        start = start and m.lastindex is None  # a space or a comment keeps it
        dopen, dclose, aopen, aclose, name, hexa, lit, word, _ = m.groups()
        if dopen:
            yield "<<"
        elif dclose:
            yield ">>"
        elif aopen:
            yield "["
        elif aclose:
            yield "]"
        elif name is not None:
            yield Name(re.sub(rb"#([0-9A-Fa-f]{2})", lambda h: bytes([int(h.group(1), 16)]), name)
                       .decode("latin-1"))
        elif hexa is not None:
            digits = re.sub(rb"\s", b"", hexa)
            yield bytes.fromhex((digits + b"0" * (len(digits) % 2)).decode())
        elif lit:
            s, i = _literal(data, m.start())
            yield s
        elif word:
            if _NUMBER.match(word):
                yield float(word) if b"." in word else int(word)
            else:
                yield Op(word.decode("latin-1"))
                start = True
                if word == b"ID":
                    end = _INLINE_IMAGE_END.search(data, i)
                    i = end.end() if end else n


def _value(toks, i):
    """The object at toks[i] → (value, next index): dict, list, Ref, or the token itself."""
    t = toks[i]
    if type(t) is str:
        close = {"<<": ">>", "[": "]"}.get(t)
        if close is None:
            return None, i + 1
        items, i = [], i + 1
        while i < len(toks) and not (type(toks[i]) is str and toks[i] == close):
            v, i = _value(toks, i)
            items.append(v)
        if close == "]":
            return items, i + 1
        return {k: v for k, v in zip(items[::2], items[1::2]) if isinstance(k, Name)}, i + 1
    if (isinstance(t, int) and i + 2 < len(toks) and isinstance(toks[i + 1], int)
            and isinstance(toks[i + 2], Op) and toks[i + 2] == "R"):
        return Ref(t, toks[i + 1]), i + 3
    return t, i + 1


def _parse(data):
    toks = list(_tokens(data))
    return _value(toks, 0)[0] if toks else None


def _inflate(raw):
    for wbits in (15, -15):
        try:
            return zlib.decompressobj(wbits).decompress(raw, _MAX_STREAM)
        except zlib.error:
            continue
    return None


class _Doc:
    # Bounded, and never from inside a number: a long run of digits made it quadratic.
    _OBJ = re.compile(rb"(?<!\d)(\d{1,10})\s+(\d{1,5})\s+obj\b")
    _STREAM = re.compile(rb"\bstream\r?\n|\bendobj\b")

    def __init__(self, data):
        self.objs = {}  # num → (value, raw stream or None); a later definition wins (updates)
        skip = 0
        for m in self._OBJ.finditer(data):
            if m.start() < skip:
                continue  # inside a stream
            k = self._STREAM.search(data, m.end())
            if k is None:
                break
            value = _parse(data[m.end():k.start()])
            raw = None
            if k.group().startswith(b"stream"):
                length = value.get("Length") if isinstance(value, dict) else None
                start = k.end()
                end = start + length if isinstance(length, int) else -1
                if end < 0 or data[end:end + 12].lstrip()[:9] != b"endstream":
                    end = data.find(b"endstream", start)
                    end = len(data) if end < 0 else end
                raw = data[start:end]
                skip = end
            else:
                skip = k.end()
            self.objs[int(m.group(1))] = (value, raw)
        for value, raw in list(self.objs.values()):
            if isinstance(value, dict) and value.get("Type") == "ObjStm":
                self._unpack(value, raw)
        self.fonts = {}

    def _unpack(self, d, raw):
        """The objects packed in an object stream (PDF 1.5+)."""
        data = self.decode(d, raw) or b""
        first = d.get("First")
        if not isinstance(first, int):
            return
        head = [int(x) for x in re.findall(rb"\d+", data[:first])]
        pairs = list(zip(head[::2], head[1::2]))
        for k, (num, off) in enumerate(pairs):
            end = first + pairs[k + 1][1] if k + 1 < len(pairs) else len(data)
            if num not in self.objs:
                self.objs[num] = (_parse(data[first + off:end]), None)

    def get(self, v, depth=0):
        while isinstance(v, Ref) and depth < 32:
            v, depth = self.objs.get(v.num, (None, None))[0], depth + 1
        return v

    def stream(self, ref):
        value, raw = self.objs.get(ref.num, (None, None)) if isinstance(ref, Ref) else (None, None)
        return self.decode(value, raw) if isinstance(value, dict) and raw is not None else None

    def decode(self, d, raw):
        filters = self.get(d.get("Filter"))
        for f in filters if isinstance(filters, list) else [filters] if filters else []:
            f = self.get(f)
            if f in ("FlateDecode", "Fl"):
                raw = _inflate(raw)
            elif f in ("ASCIIHexDecode", "AHx"):
                digits = re.sub(rb"[^0-9A-Fa-f]", b"", raw.split(b">")[0])
                raw = bytes.fromhex((digits + b"0" * (len(digits) % 2)).decode())
            else:
                return None  # images and the rare others: no text there
            if raw is None:
                return None
        return raw

    def pages(self):
        """(page dict, resources) in reading order: the page tree, else every page found."""
        root = next((v for v, _ in reversed(list(self.objs.values()))
                     if isinstance(v, dict) and v.get("Type") == "Catalog"), None)
        out, seen = [], set()

        def walk(node, resources):
            node = self.get(node)
            if not isinstance(node, dict) or id(node) in seen or len(out) >= MAX_PAGES:
                return
            seen.add(id(node))
            resources = self.get(node.get("Resources")) or resources
            if node.get("Type") == "Page" or "Contents" in node:
                out.append((node, resources))
            for kid in self.get(node.get("Kids")) or []:
                walk(kid, resources)

        if root:
            walk(root.get("Pages"), None)
        if not out:
            out = [(v, self.get(v.get("Resources"))) for _, (v, _) in sorted(self.objs.items())
                   if isinstance(v, dict) and v.get("Type") == "Page"][:MAX_PAGES]
        return out

    def font(self, resources, name):
        fonts = self.get((resources or {}).get("Font")) or {}
        ref = fonts.get(name)
        key = ref.num if isinstance(ref, Ref) else id(ref)
        if key not in self.fonts:
            d = self.get(ref)
            self.fonts[key] = _Font(self, d) if isinstance(d, dict) else None
        return self.fonts[key]


# Glyph names an 8-bit font's /Differences may use, beyond `uniXXXX` and plain letters.
_GLYPHS = {
    "space": " ", "exclam": "!", "quotedbl": '"', "numbersign": "#", "dollar": "$", "percent": "%",
    "ampersand": "&", "quotesingle": "'", "quoteright": "’", "quoteleft": "‘", "parenleft": "(",
    "parenright": ")", "asterisk": "*", "plus": "+", "comma": ",", "hyphen": "-", "period": ".",
    "slash": "/", "colon": ":", "semicolon": ";", "less": "<", "equal": "=", "greater": ">",
    "question": "?", "at": "@", "bracketleft": "[", "backslash": "\\", "bracketright": "]",
    "asciicircum": "^", "underscore": "_", "grave": "`", "braceleft": "{", "bar": "|",
    "braceright": "}", "asciitilde": "~", "quotedblleft": "“", "quotedblright": "”",
    "quotesinglbase": "‚", "quotedblbase": "„", "endash": "–", "emdash": "—", "bullet": "•",
    "ellipsis": "…", "Euro": "€", "fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl",
    "oe": "œ", "OE": "Œ", "ae": "æ", "AE": "Æ", "germandbls": "ß", "guillemotleft": "«",
    "guillemotright": "»", "degree": "°", "section": "§", "copyright": "©", "registered": "®",
    "trademark": "™", "nbspace": " ", "minus": "−", "multiply": "×", "periodcentered": "·",
    "dotlessi": "ı", "exclamdown": "¡", "questiondown": "¿", "sterling": "£", "yen": "¥",
    "cent": "¢", "paragraph": "¶", "dagger": "†", "daggerdbl": "‡", "perthousand": "‰",
    **{w: str(d) for d, w in enumerate("zero one two three four five six seven eight nine".split())},
}
_MARKS = {"acute": "ACUTE", "grave": "GRAVE", "circumflex": "CIRCUMFLEX", "dieresis": "DIAERESIS",
          "tilde": "TILDE", "cedilla": "CEDILLA", "ring": "RING ABOVE", "caron": "CARON"}


def _glyph(name):
    if name in _GLYPHS:
        return _GLYPHS[name]
    if len(name) == 1:
        return name
    m = re.fullmatch(r"(?:uni|u)([0-9A-Fa-f]{4,6})", name)
    if m:
        return chr(int(m.group(1), 16))
    m = re.fullmatch(r"([A-Za-z])(" + "|".join(_MARKS) + ")", name)
    if m:
        case = "CAPITAL" if m.group(1).isupper() else "SMALL"
        try:
            return unicodedata.lookup(f"LATIN {case} LETTER {m.group(1).upper()} WITH {_MARKS[m.group(2)]}")
        except KeyError:
            return ""
    return ""


def _utf16(hexa):
    raw = bytes.fromhex((hexa + b"0" * (len(hexa) % 2)).decode())
    return raw.decode("utf-16-be", "replace")


class _Font:
    """How one font's codes read as text."""
    _CODECS = {"WinAnsiEncoding": "cp1252", "MacRomanEncoding": "mac_roman"}

    def __init__(self, doc, d):
        self.map, self.width, self.codec = {}, 1, "latin-1"
        encoding = doc.get(d.get("Encoding"))
        if d.get("Subtype") == "Type0":
            self.width = 2
            if isinstance(encoding, str) and re.search(r"UCS2|UTF16", encoding):
                self.codec = "utf-16-be"
        elif isinstance(encoding, dict):
            self.codec = self._CODECS.get(encoding.get("BaseEncoding"), self.codec)
            code = 0
            for item in encoding.get("Differences") or []:
                if isinstance(item, int):
                    code = item
                elif isinstance(item, str):
                    self.map[code] = _glyph(item)
                    code += 1
        elif isinstance(encoding, str):
            self.codec = self._CODECS.get(encoding, self.codec)
        cmap = doc.stream(d.get("ToUnicode"))
        if cmap:
            self._read_cmap(cmap)
        self.widths, self.default = {}, 500
        if self.width == 2:
            desc = doc.get((doc.get(d.get("DescendantFonts")) or [None])[0]) or {}
            dw = desc.get("DW")
            self.default = dw if isinstance(dw, (int, float)) else 1000
            w, k = doc.get(desc.get("W")) or [], 0
            while k + 1 < len(w):  # `c [w1 w2 …]` or `first last w`
                if isinstance(w[k], int) and isinstance(doc.get(w[k + 1]), list):
                    self.widths.update((w[k] + j, x) for j, x in enumerate(doc.get(w[k + 1])))
                    k += 2
                elif k + 2 < len(w) and all(isinstance(x, (int, float)) for x in w[k:k + 3]):
                    self.widths.update((c, w[k + 2]) for c in range(int(w[k]), int(w[k + 1]) + 1))
                    k += 3
                else:
                    break
        else:
            first, widths = d.get("FirstChar"), doc.get(d.get("Widths"))
            if isinstance(first, int) and isinstance(widths, list):
                self.widths = {first + j: x for j, x in enumerate(widths) if isinstance(x, (int, float))}

    def _read_cmap(self, data):
        space = re.search(rb"begincodespacerange\s*<([0-9A-Fa-f]+)>", data)
        if space and self.width > 1:  # an 8-bit font's codes stay one byte, whatever its map says
            self.width = max(1, len(space.group(1)) // 2)
        for block in re.findall(rb"beginbfchar(.*?)endbfchar", data, re.S):
            for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", block):
                self.map[int(src, 16)] = _utf16(dst)
        for block in re.findall(rb"beginbfrange(.*?)endbfrange", data, re.S):
            for lo, hi, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])",
                                          block):
                lo, hi = int(lo, 16), int(hi, 16)
                if dst.startswith(b"["):
                    for k, each in enumerate(re.findall(rb"<([0-9A-Fa-f]*)>", dst)):
                        self.map[lo + k] = _utf16(each)
                elif hi - lo < 0x10000:
                    first = _utf16(dst[1:-1])
                    for k in range(hi - lo + 1):
                        self.map[lo + k] = first[:-1] + chr(ord(first[-1]) + k) if first else ""

    def codes(self, s):
        w = self.width
        return list(s) if w == 1 else [int.from_bytes(s[k:k + w], "big") for k in range(0, len(s) - w + 1, w)]

    def text(self, s):
        if self.width == 1:
            return "".join(self.map[c] if c in self.map else s[k:k + 1].decode(self.codec, "replace")
                           for k, c in enumerate(s))
        if not self.map:
            return s.decode(self.codec, "ignore") if self.codec == "utf-16-be" else ""
        return "".join(self.map.get(c, "") for c in self.codes(s))

    def advance(self, s):
        """How far `s` moves the pen, in thousandths of the font size."""
        return sum(self.widths.get(c, self.default) for c in self.codes(s))


class _Page:
    """The lines a page's content draws. The pen is followed (where the last text ended, where
    the next starts), because many writers place each glyph on its own: a jump wider than a
    fifth of the font's size is a space, a move down a new line."""

    def __init__(self, doc):
        self.doc, self.lines, self.line = doc, [], []
        self.font, self.size = None, 0.0
        self.scale = (1.0, 1.0)  # the text matrix's own x / y scale
        self.origin = (0.0, 0.0)  # the start of the current text line
        self.x = self.y = self.end = None

    def newline(self):
        text = " ".join("".join(self.line).split())
        if text:
            self.lines.append(text)
        self.line, self.end = [], None

    def space(self):
        if self.line and not self.line[-1].endswith(" "):
            self.line.append(" ")

    def em(self):
        return abs(self.size * self.scale[0]) or 1.0

    def goto(self, x, y):
        if self.y is not None and abs(y - self.y) > 0.4 * self.em():
            self.newline()
        elif self.end is not None and abs(x - self.end) > 0.2 * self.em():
            self.space()
        self.origin, self.x, self.y = (x, y), x, y

    def show(self, s):
        if self.font is None:
            return
        self.line.append(self.font.text(s))
        if self.x is not None:
            self.x += self.font.advance(s) * self.size * self.scale[0] / 1000
            self.end = self.x

    def run(self, content, resources, depth=0):
        stack, operands = [], []
        for tok in _tokens(content, _DRAWING):
            if type(tok) is str:
                if tok in ("[", "<<"):
                    stack.append(operands)
                    operands = []
                elif stack:
                    inner, operands = operands, stack.pop()
                    operands.append(inner)
                continue
            if not isinstance(tok, Op) or stack:
                operands.append(tok)
                continue
            args, operands = operands, []
            nums = [a for a in args if isinstance(a, (int, float))]
            if tok == "BT":
                self.scale, self.origin = (1.0, 1.0), (0.0, 0.0)
            elif tok == "Tf" and len(args) >= 2:
                self.font = self.doc.font(resources, args[-2])
                self.size = float(nums[-1]) if nums else 0.0
            elif tok in ("Td", "TD") and len(nums) >= 2:
                (ox, oy), (sx, sy) = self.origin, self.scale
                self.goto(ox + nums[-2] * sx, oy + nums[-1] * sy)
            elif tok == "Tm" and len(nums) >= 6:
                a, b, c, d, e, f = nums[-6:]
                sy = (c * c + d * d) ** 0.5 or 1.0
                self.scale = ((a * a + b * b) ** 0.5 or 1.0, -sy if d < 0 else sy)
                self.goto(e, f)
            elif tok == "T*":
                self.newline()
            elif tok in ("Tj", "'", '"') and args and isinstance(args[-1], bytes):
                if tok != "Tj":
                    self.newline()
                self.show(args[-1])
            elif tok == "TJ" and args and isinstance(args[-1], list):
                for item in args[-1]:
                    if isinstance(item, bytes):
                        self.show(item)
                    elif isinstance(item, (int, float)):
                        if item < -200:
                            self.space()  # a gap wider than a fifth of the font's size
                        if self.x is not None:
                            self.x -= item * self.size * self.scale[0] / 1000
                            self.end = self.x
            elif tok == "Do" and args and depth < 4:
                xobjects = self.doc.get((resources or {}).get("XObject")) or {}
                ref = xobjects.get(args[-1])
                form = self.doc.get(ref)
                if isinstance(form, dict) and form.get("Subtype") == "Form":
                    inner = self.doc.stream(ref)
                    if inner:
                        font, size, scale = self.font, self.size, self.scale
                        self.run(inner, self.doc.get(form.get("Resources")) or resources, depth + 1)
                        self.font, self.size, self.scale = font, size, scale


def extract(data: bytes):
    """The text of the PDF `data`, page by page, or None (a scan, encrypted, unreadable)."""
    if not data.startswith(b"%PDF") or len(data) > MAX_BYTES or re.search(rb"/Encrypt\s*[\d<]", data):
        return None
    doc = _Doc(data)
    out, found = [], False
    for n, (page, resources) in enumerate(doc.pages(), 1):
        out.append(f"## Page {n}")
        xobjects = doc.get((resources or {}).get("XObject")) or {}
        if not doc.get((resources or {}).get("Font")) and not any(
                (doc.get(x) or {}).get("Subtype") == "Form" for x in xobjects.values()):
            continue  # no font to write with: a scanned page, nothing to read
        contents = doc.get(page.get("Contents"))
        refs = page.get("Contents") if not isinstance(contents, list) else contents
        streams = [doc.stream(r) for r in (refs if isinstance(refs, list) else [refs])]
        reader = _Page(doc)
        reader.run(b"\n".join(s for s in streams if s), resources)
        reader.newline()
        out.extend(reader.lines)
        found = found or bool(reader.lines)
    return "\n".join(out) if found else None
