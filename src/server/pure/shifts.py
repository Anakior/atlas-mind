"""Then and now: what the mind said about a topic at a past date, next to what it says today.
The engine gathers the evidence from git (each doc's passages on the topic then and now, docs
since deleted or moved included, the dates the topic moved); the model pairs the claims; and
before the view shows a pair, every quote is checked word for word against the version it
cites, so a claim the mind never made cannot be put in its mouth."""
import datetime as dt
import re

import server as _s
from server.pure import contradictions, provenance
from server.pure.queries import _api_search, _visible

_DOCS = 8              # docs read on each side
_DOC_CHARS = 1400      # passages kept per doc and side
_PASSAGE_CHARS = 420
_MOMENTS = 12          # dates the topic moved, the latest kept
_MOMENT_COMMITS = 300  # commits scanned for them
_DEFAULT_DAYS = 90     # `at` when none is given
_BADGES = ("reversed", "refined", "held", "dropped", "new")
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ITEM_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)")
_RULE_RE = re.compile(r"^\s*\|[\s:|-]+\|\s*$")
_ELLIPSIS_RE = re.compile(r"\[\s*(?:…|\.\.\.)\s*\]|…|\.\.\.")


def _terms(topic: str) -> list:
    """The topic's words as git and the passages look for them: folded and as typed, a plural
    trimmed so 'embeddings' finds 'embedding'."""
    words = [w.lower() for w in re.findall(r"\w+", topic)]
    folded = contradictions._tokenize(topic)
    out = []
    for w in folded + [w for w in words if _s._normalize_text(w) in folded]:
        w = w[:-1] if len(w) > 4 and w.endswith("s") else w
        if w not in out:
            out.append(w)
    if not out:
        raise ValueError("The topic needs a word to look for (stop words alone match everything).")
    return out[:8]


def _day(at: str) -> str:
    at = (at or "").strip()[:10]
    if not at:
        return (dt.date.today() - dt.timedelta(days=_DEFAULT_DAYS)).isoformat()
    if not _DAY_RE.match(at):
        raise ValueError(f"'at' must be a date, YYYY-MM-DD: {at}")
    return at


def _rev_at(day: str) -> str:
    sha = _s.git("rev-list", "-1", f"--before={day}T23:59:59", "HEAD").stdout.strip()
    if not sha:
        first = _s.git("log", "--reverse", "--format=%cs", "HEAD").stdout.split("\n", 1)[0]
        raise ValueError(f"The mind has no history on or before {day}"
                         + (f": it starts on {first}." if first else "."))
    return sha


def _show(rev: str, repo_rel: str):
    out = _s.git("show", f"{rev}:{repo_rel}")
    return out.stdout if out.returncode == 0 else None


def _hidden(rel: str, ctx) -> bool:
    names = _s._import_build().EXCLUDED_NAMES
    return (not rel.endswith(".md") or any(part in names for part in rel.split("/"))
            or not _visible(rel, ctx))


def _blocks(text: str):
    """(line, section, text) for each paragraph, list item and table row, frontmatter and code
    aside."""
    lines = text.split("\n")
    start = 0
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        start = end + 1 if end is not None else 0
    section, block, first, fenced = "", [], 0, False
    for i in range(start, len(lines) + 1):
        line = lines[i] if i < len(lines) else ""
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            line = ""
        heading = None if fenced else _HEADING_RE.match(line)
        row = line.lstrip().startswith("|")
        if fenced or not line.strip() or heading or row or _ITEM_RE.match(line):
            if block:
                yield first + 1, section, " ".join(block)
                block = []
            if heading:
                section = heading.group(2).strip()
            if row and not _RULE_RE.match(line):
                yield i + 1, section, " · ".join(c.strip() for c in line.strip().strip("|").split("|"))
            if fenced or heading or row or not line.strip():
                continue
        if not block:
            first = i
        block.append(line.strip())


def _passages(text: str, terms: list) -> list:
    """The doc's passages on the topic, within a budget: the ones naming it first, then the rest
    of a section whose title names it (its conclusion rarely repeats the word)."""
    words, scored = {_s._normalize_text(t) for t in terms}, []
    for line, section, block in _blocks(text):
        hits = sum(1 for w in words if w in _s._normalize_text(block))
        under = sum(1 for w in words if w in _s._normalize_text(section))
        if hits or under:
            if len(block) > _PASSAGE_CHARS:
                block = block[:_PASSAGE_CHARS].rsplit(" ", 1)[0] + " …"
            scored.append((2 * hits + under, line, section, block))
    scored.sort(key=lambda s: (-s[0], s[1]))
    kept, room = [], _DOC_CHARS
    for _, line, section, block in scored:
        if len(block) > room:
            break
        kept.append((line, section, block))
        room -= len(block)
    return [{"line": line, "section": section, "text": block} if section else {"line": line, "text": block}
            for line, section, block in sorted(kept)]


def _last_change(rev: str, repo_rel: str) -> str:
    return _last_changes(rev, [repo_rel]).get(repo_rel, "")


def _last_changes(rev: str, repo_paths: list) -> dict:
    """{path: day of its last commit up to `rev`}, in one walk of the history."""
    out = _s.git("log", "--format=%x1e%cs", "--name-only", rev, "--", *repo_paths)
    days = {}
    for record in out.stdout.split("\x1e")[1:]:
        day, *paths = [row.strip() for row in record.split("\n") if row.strip()] or [""]
        for path in paths:
            days.setdefault(path, day)
    return days


def _then_paths(terms: list, rev: str) -> list:
    """Docs holding the topic's words at `rev`, the most mentions first: they may be gone now."""
    args = ["grep", "-I", "-i", "-c", "-F"]
    for t in terms:
        args += ["-e", t]
    out = _s.git(*args, rev, "--", "content")
    counts = []
    for row in out.stdout.splitlines():
        path, _, n = row.partition(f"{rev}:")[2].rpartition(":")
        if path.startswith("content/") and n.isdigit():
            counts.append((int(n), path[len("content/"):]))
    return [rel for _, rel in sorted(counts, key=lambda c: (-c[0], c[1]))]


def _renames(rev: str) -> dict:
    """{path at `rev`: its path now} for the docs moved since."""
    out = _s.git("diff", "-M", "--name-status", rev, "HEAD", "--", "content")
    moves = {}
    for row in out.stdout.splitlines():
        status, *paths = row.split("\t")
        if status.startswith("R") and len(paths) == 2:
            moves[paths[0][len("content/"):]] = paths[1][len("content/"):]
    return moves


def _moments(terms: list, paths, ctx) -> list:
    """The days the topic's lines changed in `paths`, with the docs they changed in: the docs
    found, not the whole mind, whose every diff -G would read."""
    pattern = "|".join(t for t in terms if re.fullmatch(r"\w+", t))
    paths = sorted({"content/" + rel for rel in paths})
    if not pattern or not paths:
        return []
    out = _s.git("log", "-i", "-G" + pattern, "-n", str(_MOMENT_COMMITS), "--format=%x1e%cs",
                 "--name-only", "--", *paths)
    days = {}
    for record in out.stdout.split("\x1e")[1:]:
        rows = [p.strip() for p in record.split("\n") if p.strip()]
        if not rows:
            continue
        day, paths = rows[0], rows[1:]
        docs = [p[len("content/"):] for p in paths if p.startswith("content/")]
        docs = [rel for rel in docs if not _hidden(rel, ctx)]
        if docs:
            seen = days.setdefault(day, [])
            seen += [rel for rel in docs if rel not in seen]
    return [{"date": day, "docs": docs} for day, docs in sorted(days.items())][-_MOMENTS:]


def evidence(topic: str, at: str, ctx=None) -> dict:
    terms, day = _terms(topic), _day(at)
    rev = _rev_at(day)
    head = _s.git("rev-parse", "HEAD").stdout.strip()
    moves = _renames(rev)
    back = {now: then for then, now in moves.items()}
    pairs = [(rel, moves.get(rel, rel)) for rel in _then_paths(terms, rev) if not _hidden(rel, ctx)][:_DOCS]
    now_paths = [h["path"] for h in _api_search(topic, _DOCS * 2, ctx) if not _hidden(h["path"], ctx)]
    pairs += [(back.get(rel, rel), rel) for rel in now_paths[:_DOCS]]
    pairs = list(dict.fromkeys(pairs))
    then_days = _last_changes(rev, sorted({"content/" + then for then, _ in pairs}))
    now_days = _last_changes(head, sorted({"content/" + now for _, now in pairs}))
    docs = []
    for then_rel, now_rel in pairs:
        then_text = _show(rev, "content/" + then_rel)
        now_text = _show(head, "content/" + now_rel)
        then = _passages(then_text, terms) if then_text else []
        now = _passages(now_text, terms) if now_text else []
        if not then and not now:
            continue
        doc = {"path": now_rel if now_text is not None else then_rel, **provenance.mark(now_rel)}
        if then:
            doc["then"] = {"date": then_days.get("content/" + then_rel, ""), "passages": then}
            if then_rel != doc["path"]:
                doc["then"]["path"] = then_rel
        if now:
            doc["now"] = {"date": now_days.get("content/" + now_rel, "")}
            # Unchanged on the topic: said once, the model reads it as held.
            doc["now"].update({"same_as_then": True} if now == then else {"passages": now})
        if now_text is None:
            doc["gone"] = True
        docs.append(doc)
    found = [d["path"] for d in docs] + [d["then"]["path"] for d in docs if "path" in d.get("then", {})]
    # The next step first: with the passages in hand, a model is tempted to write the answer out.
    return {"hint": ("Now call show_shift with the claims paired, one then and one now, each quoted word "
                     "for word from a passage below (… to skip words): it is how the user sees the answer. "
                     "A doc still saying what the mind no longer holds goes in `lagging`. Then reply in a "
                     "line or two."),
            "topic": topic, "at": day, "rev": rev[:12], "moments": _moments(terms, found, ctx), "docs": docs}


# ── show_shift: the pairs, each quote checked against the version it cites ──

def _flat(text: str) -> str:
    """Text as compared: no Markdown marks, typographic quotes made plain, spaces collapsed."""
    text = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", lambda m: m.group(2) or m.group(1), text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"(?m)^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)", "", text)
    text = re.sub(r"[*_`]", "", text)  # emphasis and code marks, on both sides alike
    text = text.translate(str.maketrans("’‘“”«»  ", "''\"\"\"\"  "))
    return " ".join(text.split()).casefold()


def _found(quote: str, text: str):
    """The first part of `quote`, as compared, when every part (split at its ellipses) is in
    `text`, in order; else None."""
    flat, at = _flat(text), 0
    parts = [_flat(p).strip(" '\"") for p in _ELLIPSIS_RE.split(quote)]
    parts = [p for p in parts if p]
    if not parts:
        return None
    for part in parts:
        i = flat.find(part, at)
        if i < 0:
            return None
        at = i + len(part)
    return parts[0]


def _line_of(start: str, text: str):
    probe = start[:24]
    for i, line in enumerate(text.split("\n")):
        if probe in _flat(line):
            return i + 1
    return None


def _blame(rev: str, repo_rel: str, line: int) -> dict:
    out = _s.git("blame", "--porcelain", "-L", f"{line},{line}", rev, "--", repo_rel)
    if out.returncode != 0:
        return {}
    sha = out.stdout.split(" ", 1)[0]
    fields = dict(row.split(" ", 1) for row in out.stdout.splitlines()[1:] if " " in row)
    when = fields.get("author-time", "")
    return {"sha": sha[:8], "author": fields.get("author", ""),
            "date": dt.datetime.fromtimestamp(int(when)).date().isoformat() if when.isdigit() else ""}


def _check(side: dict, rev: str, ctx, rejected: list, kind: str):
    """A quoted claim as shown: verified against `rev`, dated by the commit that wrote it."""
    if not isinstance(side, dict):
        return None
    rel, quote = (side.get("path") or "").strip(), (side.get("quote") or "").strip()
    if _s._validate_doc_path(rel) is None or _hidden(rel, ctx) or not quote:
        rejected.append({"side": kind, "path": rel, "quote": quote, "reason": "no such doc"})
        return None
    text = _show(rev, "content/" + rel)
    start = _found(quote, text) if text else None
    if start is None:
        rejected.append({"side": kind, "path": rel, "quote": quote,
                         "reason": "not found word for word" if text else "no such doc at that date"})
        return None
    line = _line_of(start, text)
    written = _blame(rev, "content/" + rel, line) if line else {}
    return {"path": rel, "quote": quote, "line": line, **written,
            "date": written.get("date") or _last_change(rev, "content/" + rel)}


def verify(args: dict, ctx=None) -> dict:
    topic = (args.get("topic") or "").strip()
    terms, day = _terms(topic), _day(args.get("at") or "")
    rev, head = _rev_at(day), _s.git("rev-parse", "HEAD").stdout.strip()
    shifts, rejected = [], []
    for pair in args.get("shifts") or []:
        badge = pair.get("badge") if isinstance(pair, dict) else None
        if badge not in _BADGES:
            rejected.append({"side": "pair", "reason": f"badge must be one of {', '.join(_BADGES)}"})
            continue
        then = _check(pair.get("then"), rev, ctx, rejected, "then") if badge != "new" else None
        now = _check(pair.get("now"), head, ctx, rejected, "now") if badge != "dropped" else None
        if (badge != "new" and then is None) or (badge != "dropped" and now is None):
            continue
        shown = {"badge": badge, "then": then, "now": now}
        if (pair.get("note") or "").strip():
            shown["note"] = pair["note"].strip()
        shifts.append(shown)
    lagging = []
    for doc in args.get("lagging") or []:
        checked = _check(doc, head, ctx, rejected, "lagging")
        if checked:
            checked["last_modified"] = _last_change(head, "content/" + checked["path"])
            lagging.append(checked)
    cited = [side["path"] for pair in shifts for side in (pair["then"], pair["now"]) if side]
    cited += [doc["path"] for doc in lagging]
    return {"topic": topic, "at": day, "today": dt.date.today().isoformat(),
            "moments": _moments(terms, cited, ctx), "shifts": shifts, "lagging": lagging,
            "rejected": rejected}
