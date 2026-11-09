"""L'huissier: every quotation in a doc checked word for word against the other files of the mind
(notes, and the text inside PDFs page by page, slides, office files). Each one gets a state:
found (the file, its line and the part it sits in), altered (a file says nearly the same: its own
words come along) or missing (nowhere in the mind that the reader can see). Deterministic: both
sides are compared as their words alone (no Markdown marks nor punctuation, case and accents
folded). The search cache names the few files holding a quote's words; only those are read word
by word, and kept while they don't change."""
import difflib
import re
import unicodedata
from bisect import bisect_right
from collections import Counter, OrderedDict

import server as _s
from server.pure import provenance
from server.pure.queries import SEARCHED, _readable, _reader_memo
from server.pure.shifts import _ELLIPSIS_RE

MIN_WORDS = 4  # below that a quoted phrase is mostly a name or a label, not a quotation
_QUOTE_RE = re.compile(r"«\s*((?:(?!\n\s*\n)[^«»])+?)\s*»"
                       r"|“((?:(?!\n\s*\n)[^“”])+?)”"
                       r"|(?<![\w=])\"([^\"\n]+?)\"(?![\w:])")
_BLOCK_RE = re.compile(r"\A---\n.*?\n---\n|^(```|~~~).*?^\1", re.M | re.S)  # frontmatter, code blocks
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_WORD_RE = re.compile(r"[a-z0-9]+")
_ACCENT_RE = re.compile(r"[\u0300-\u036f]")
_LINK_RE = re.compile(r"\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]|!?\[([^\]\n]*)\]\([^)\n]*\)")
_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")  # the search cache's tokens
_WIKILINK_RE = re.compile(r"\[\[([^\]|#\n]+)")
_HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$")
_MAX_CHARS = 600
_COVERAGE = 0.6  # share of a quote's words a file must hold to be compared with it
_EXACT_FILES = 12  # files holding all its words, searched for the quote as it is
_NEAR_FILES = 3  # files holding most of them, searched for it altered
_NEAR = 0.8  # word similarity, both ways, from which a passage is the quote altered
_NEAR_WORDS = 6  # words in common at least: a shorter match is a common phrase, not a quotation
_RUN = 4  # words per anchor when looking for an altered quote
_WORDS = OrderedDict()
_MAX_WORDS = 256  # files kept read word by word


def _folded(text: str) -> str:
    """`text` as compared: a link as its label, lowercase, unaccented. Every other mark (Markdown,
    punctuation, typographic quotes) falls away with the words kept: [a-z0-9] runs."""
    text = _LINK_RE.sub(lambda m: m.group(2) or m.group(1) or m.group(3) or "", text)
    text = _ACCENT_RE.sub("", unicodedata.normalize("NFKD", text.casefold()))
    return text.encode("ascii", "replace").decode()  # ’ « — × …: separators, like ' " - x


def _words(text: str) -> str:
    """The words of `text`, as compared, one space apart."""
    return " ".join(_WORD_RE.findall(_folded(text)))


def extract(text: str) -> list:
    """[{line, text}] of the quotations in a note: between « », “ ” or straight quotes, outside
    code blocks and frontmatter, MIN_WORDS words or more. Inline code inside a quotation is part
    of it (« dès qu'un `completed` existera »); a quote mark inside inline code opens nothing."""
    masked = _BLOCK_RE.sub(lambda m: re.sub(r"[^\n]", " ", m.group()), text)
    code = [m.span() for m in _INLINE_CODE_RE.finditer(masked)]
    out = []
    for m in _QUOTE_RE.finditer(masked):
        if any(a <= m.start() < b for a, b in code):
            continue
        quote = " ".join(next(g for g in m.groups() if g).split())
        # Words as written, apart at the spaces: « c'est-à-dire » is one, not four.
        words = [w for w in _ELLIPSIS_RE.sub(" ", quote).split() if any(c.isalnum() for c in w)]
        if len(words) >= MIN_WORDS and len(quote) <= _MAX_CHARS:
            out.append({"line": masked.count("\n", 0, m.start()) + 1, "text": quote})
    return out


def _file_words(rel: str, path, mtime) -> tuple:
    """(" w1 w2 … ", [(offset, line number)] of each line that has words, the file's lines)."""
    key = (str(path), mtime)
    if key in _WORDS:
        _WORDS.move_to_end(key)
        return _WORDS[key]
    text = _s._doc_text(rel, path) or ""
    lines = text.split("\n")
    parts, starts, at = [], [], 1
    for n, line in enumerate(_folded(text).split("\n"), 1):
        words = " ".join(_WORD_RE.findall(line))
        if words:
            parts.append(words)
            starts.append((at, n))
            at += len(words) + 1
    _WORDS[key] = (" " + " ".join(parts) + " ", starts, lines)
    if len(_WORDS) > _MAX_WORDS:
        _WORDS.popitem(last=False)
    return _WORDS[key]


def _find(parts: list, text: str):
    """(start, end) of the parts in `text`, whole words, in order and close together; else None."""
    start = text.find(f" {parts[0]} ")
    while start >= 0:
        at = end = start + len(parts[0]) + 1
        for part in parts[1:]:
            i = text.find(f" {part} ", at, at + 4 * sum(map(len, parts)) + 400)
            if i < 0:
                break
            at = end = i + len(part) + 1
        else:
            return start + 1, end
        start = text.find(f" {parts[0]} ", start + 1)
    return None


def _near(quote: str, text: str):
    """(similarity, start, end) of the passage of `text` closest to `quote`, word by word, located
    by the runs of words they share; None when they share no run or too few words, or when they
    differ by swapped words only: two messages of one template (« module stats » / « module
    hero »), not a quotation altered, which drops or adds words. That also lets one changed word
    through unseen, the price of not crying wolf."""
    words = quote.split()
    votes = Counter()
    for i in range(len(words) - _RUN + 1):
        run, offset = " ".join(words[i:i + _RUN]), len(" ".join(words[:i]))
        at, seen = text.find(f" {run} "), 0
        while at >= 0 and seen < 20:
            votes[(at - offset) // 40] += 1
            at, seen = text.find(f" {run} ", at + 1), seen + 1
    if not votes:
        return None
    bucket = max(votes, key=lambda b: votes[b - 1] + votes[b] + votes[b + 1])
    lo = max(0, bucket * 40 - 40 - len(quote) // 4)
    window = text[lo:lo + len(quote) * 3 // 2 + 160]
    blocks = [b for b in difflib.SequenceMatcher(None, quote, window, autojunk=False).get_matching_blocks()
              if b.size >= 3]
    if not blocks:
        return None
    start = text.rfind(" ", 0, lo + blocks[0].b) + 1
    end = text.find(" ", lo + blocks[-1].b + blocks[-1].size)
    passage = text[start:end].split()
    match = difflib.SequenceMatcher(None, words, passage, autojunk=False)
    if sum(b.size for b in match.get_matching_blocks()) < _NEAR_WORDS:
        return None
    tags = {tag for tag, *_ in match.get_opcodes()}
    if "replace" in tags and not tags & {"insert", "delete"}:
        return None
    return match.ratio(), start, end


def _where(rel: str, words: tuple, start: int, end: int) -> tuple:
    """(source, passage, quoted) of a match: the file, its line and the part it sits in (a note's
    section, a PDF's page, a slide); the passage as the file writes it; whether the file quotes it
    itself, a source at second hand."""
    flat, starts, lines = words
    offsets = [s for s, _ in starts]
    first = bisect_right(offsets, start) - 1
    last = bisect_right(offsets, max(start, end - 1)) - 1
    line = starts[first][1]
    source = {"path": rel, "line": line}
    part = next((m.group(1) for ln in reversed(lines[:line]) if (m := _HEADING_RE.match(ln))), None)
    if part:
        source["section"] = part
    pieces, before, after = [], "", ""
    for i in range(first, last + 1):
        offset, n = starts[i]
        text = lines[n - 1]
        folded = _folded(text)
        spans = [m.span() for m in _WORD_RE.finditer(folded)]
        lo = len(flat[offset:start].split()) if i == first else 0
        hi = len(flat[offset:end].split()) if i == last else len(spans)
        # Folding keeps a line's length unless a link lost its target: then the whole line.
        a, b = (spans[lo][0], spans[hi - 1][1]) if len(folded) == len(text) else (0, len(text))
        before = text[:a] if i == first else before
        after = text[b:] if i == last else after
        pieces.append(text[a:b].strip(" *_`"))
    passage = " ".join(pieces)
    cut = len(passage) > _MAX_CHARS
    if cut:
        passage = passage[:_MAX_CHARS].rsplit(" ", 1)[0]
    passage = ("…" if _WORD_RE.search(_folded(before)) else "") + passage \
        + ("…" if cut or _WORD_RE.search(_folded(after)) else "")
    tail = before.rstrip()
    return source, passage, bool(tail) and tail[-1] in "«“\""


def _verdict(quote: str, pool: list, linked: frozenset = frozenset()) -> dict:
    parts = [w for w in (_words(p) for p in _ELLIPSIS_RE.split(quote)) if w]
    tokens = set(_TOKEN_RE.findall(_s._normalize_text(quote)))
    if not parts or not tokens:
        return {"state": "missing"}
    held = []
    for rel, path, entry in pool:
        share = len(tokens & entry["tokens"]) / len(tokens)
        if share >= _COVERAGE:
            held.append((share, rel, path, entry))
    # The source the quoting line links to first, then the files that are not notes before the
    # notes that may quote them; a file that quotes the passage itself only when no other has it.
    whole = sorted((h for h in held if h[0] == 1), key=lambda h: (h[1] not in linked, h[1].endswith(".md"), h[1]))
    found = []
    for share, rel, path, entry in whole[:_EXACT_FILES]:
        words = _file_words(rel, path, entry["mtime"])
        span = _find(parts, words[0])
        if span:
            source, _, quoted = _where(rel, words, *span)
            found.append((rel not in linked, quoted, len(found), source))
            if rel in linked or not quoted:
                break  # the linked ones come first: none further can be better
    if found:
        return {"state": "found", "source": min(found)[3]}
    likeliest = sorted(held, key=lambda h: (-h[0], h[1].endswith(".md"), h[1]))[:_NEAR_FILES]
    near = []
    for share, rel, path, entry in likeliest + [h for h in held if h[1] in linked and h not in likeliest]:
        words = _file_words(rel, path, entry["mtime"])
        match = _near(" ".join(parts), words[0])
        if match and match[0] >= _NEAR:
            source, passage, quoted = _where(rel, words, match[1], match[2])
            near.append((rel not in linked, quoted, -match[0], len(near), source, passage))
    if not near:
        return {"state": "missing"}
    *_, ratio, _, source, passage = min(near)
    if ratio == -1:  # the same words, other marks
        return {"state": "found", "source": source}
    return {"state": "altered", "similarity": round(-ratio, 2), "source": {**source, "says": passage}}


def check(rel: str, text: str, ctx=None, lines=None, skip=()) -> list:
    """[{line, text, state, source?, similarity?}] for each quotation of the note `rel` (on
    `lines`, (first, last), if given; not those in `skip`), checked against the other files
    `ctx` can read. Kept in the reader's memo, which goes with the next change of content or
    rights."""
    quotes = [q for q in extract(text) if (lines is None or lines[0] <= q["line"] <= lines[1])
              and q["text"] not in skip]
    if not quotes:
        return []
    memo = _reader_memo(ctx).setdefault("quotes", {})
    if "pool" not in memo:
        memo["pool"] = [(r, p, e) for r, p in _readable(ctx, SEARCHED) if (e := _s._doc_entry(r, p))]
        memo["names"] = _names(r for r, _, _ in memo["pool"])
    lines_of = text.split("\n")
    pool = None
    out = []
    for q in quotes:
        linked = frozenset(memo["names"][k] for t in _WIKILINK_RE.findall(lines_of[q["line"] - 1])
                           if (k := t.strip().lower()) in memo["names"])
        key = (rel, q["text"], linked)
        if key not in memo:
            pool = pool or [entry for entry in memo["pool"] if entry[0] != rel]
            memo[key] = _verdict(q["text"], pool, linked)
        out.append({**q, **memo[key]})
    return out


def _names(rels) -> dict:
    """{how a wikilink may name a file (its path or its name, with or without .md): its path}."""
    names = {}
    for rel in rels:
        low = rel.lower()
        for name in (low, low.rsplit("/", 1)[-1]):
            names.setdefault(name, rel)
            if name.endswith(".md"):
                names.setdefault(name[:-3], rel)
    return names


def summary(results: list) -> Counter:
    return Counter(r["state"] for r in results)


def tally(results: list) -> str:
    n = summary(results)
    return f"quotes: {n['found']} found, {n['altered']} altered, {n['missing']} nowhere in the mind"


def report(results: list, nowhere: bool = False, limit: int = 5) -> str:
    """The huissier's word for an agent: each altered quote with what its file says and, with
    `nowhere`, the lines of the quotes no file holds. Empty when there is nothing to say."""
    out = []
    altered = [r for r in results if r["state"] == "altered"]
    if altered:
        out.append("Altered quotes, the file they come from says otherwise:")
        for r in altered[:limit]:
            src = r["source"]
            where = ", ".join(x for x in (src.get("section"), f"line {src['line']}") if x)
            out.append(f"- line {r['line']} « {r['text']} »: {src['path']} ({where}) says "
                       f"« {provenance.fence(src['says'], src['path'])} »")
        if len(altered) > limit:
            out.append(f"- and {len(altered) - limit} more")
    missing = [str(r["line"]) for r in results if r["state"] == "missing"]
    if nowhere and missing:
        out.append("Quotes no file of the mind holds (a capture, a source outside, or invented?): line "
                   + ", ".join(missing[:10]) + (f" and {len(missing) - 10} more" if len(missing) > 10 else ""))
    return "\n".join(out)
