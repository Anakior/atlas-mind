"""Then and now: what the mind said about a topic at a past date, next to what it says today.
The engine gathers the evidence from git (each doc's passages on the topic then and now, docs
since deleted or moved included, the dates the topic moved); the model pairs the claims; and
before the view shows a pair, every quote is checked word for word against the version it
cites, so a claim the mind never made cannot be put in its mouth."""
import datetime as dt
import re
from itertools import zip_longest

import server as _s
from server.pure import contradictions, provenance
from server.pure.queries import _api_search, _visible

_DOCS = 8              # docs read on each side
_DOC_CHARS = 900       # passages kept per doc and side
_TOTAL_CHARS = 7000    # and in all: the docs past it are named, not quoted
_PASSAGE_CHARS = 420
_MOMENTS = 12          # dates the topic moved, the latest kept
_BADGES = ("reversed", "refined", "held", "dropped", "new")
_ECHOED = ("reversed", "refined", "dropped")  # the claims a lagging doc can still repeat
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
    if not _DAY_RE.match(at):
        raise ValueError(f"'at' must be a date, YYYY-MM-DD: {at or '(none)'}")
    return at


def _rev_at(day: str) -> str:
    sha = _s.git("rev-list", "-1", f"--before={day}T23:59:59", "HEAD").stdout.strip()
    if not sha:
        first = _s.git("log", "--reverse", "--format=%cs", "HEAD").stdout.split("\n", 1)[0]
        raise ValueError(f"The mind has no history on or before {day}"
                         + (f": it starts on {first}." if first else "."))
    return sha


def _git(*args):
    """git with paths as they are: by default it escapes non-ASCII ones in its output."""
    return _s.git("-c", "core.quotepath=false", *args)


def _show(rev: str, repo_rel: str):
    out = _git("show", f"{rev}:{repo_rel}")
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
    out, current = [], ""
    for line, section, block in sorted(kept):
        out.append({"line": line, "text": block} if section == current else
                   {"line": line, "section": section, "text": block})  # said once for its passages
        current = section
    return out


def _history(paths, terms: list, day: str = "") -> tuple:
    """One walk of the paths' history, diffs included: the day each was last changed (today, and
    on `day` when given) and the days the topic's lines changed in them. On a big mind a walk
    costs about a second whatever it reads, so this one does the work of three."""
    out = _git("log", "-p", "--unified=0", "--no-renames", "--format=%x1e%cs", "HEAD", "--",
               *sorted({"content/" + rel for rel in paths}))
    words = {_s._normalize_text(t) for t in terms}
    now_days, then_days, moved = {}, {}, {}
    for record in out.stdout.split("\x1e")[1:]:
        lines = record.split("\n")
        when, path = lines[0].strip(), None
        for line in lines[1:]:
            if line.startswith(("--- a/content/", "+++ b/content/")):
                path = line[len("--- a/content/"):].rstrip("\t")
                now_days.setdefault(path, when)
                if day and when <= day:
                    then_days.setdefault(path, when)
            elif path and line[:1] in ("+", "-") and not line.startswith(("+++", "---")):
                if any(w in _s._normalize_text(line) for w in words) and path not in moved.setdefault(when, []):
                    moved[when].append(path)
    moments = [{"date": when, "docs": docs} for when, docs in sorted(moved.items())]
    return now_days, then_days, moments[-_MOMENTS:]


def _then_paths(terms: list, rev: str) -> list:
    """Docs holding the topic's words at `rev`, the most mentions first: they may be gone now."""
    args = ["grep", "-I", "-i", "-c", "-F"]
    for t in terms:
        args += ["-e", t]
    out = _git(*args, rev, "--", "content")
    counts = []
    for row in out.stdout.splitlines():
        path, _, n = row.partition(f"{rev}:")[2].rpartition(":")
        if path.startswith("content/") and n.isdigit():
            counts.append((int(n), path[len("content/"):]))
    return [rel for _, rel in sorted(counts, key=lambda c: (-c[0], c[1]))]


def _renames(rev: str) -> dict:
    """{path at `rev`: its path now} for the docs moved since."""
    out = _git("diff", "-M", "--name-status", rev, "HEAD", "--", "content")
    moves = {}
    for row in out.stdout.splitlines():
        status, *paths = row.split("\t")
        if status.startswith("R") and len(paths) == 2:
            moves[paths[0][len("content/"):]] = paths[1][len("content/"):]
    return moves


def evidence(topic: str, at: str, ctx=None) -> dict:
    terms = _terms(topic)
    if not (at or "").strip():
        # No date to compare with: a fixed default would miss a change of mind made last week or
        # last year alike. The days the topic moved let the model pick the one the question means.
        found = [h["path"] for h in _api_search(topic, _DOCS, ctx) if not _hidden(h["path"], ctx)]
        return {"hint": ("No date given: pick the day to compare with from `moments`, usually the day "
                         "before the change the question is about (often the latest), and call "
                         "then_and_now again with it as `at`."),
                "topic": topic, "moments": _history(found, terms)[2]}
    day = _day(at)
    rev = _rev_at(day)
    head = _s.git("rev-parse", "HEAD").stdout.strip()
    moves = _renames(rev)
    back = {now: then for then, now in moves.items()}
    then_docs = [(rel, moves.get(rel, rel)) for rel in _then_paths(terms, rev) if not _hidden(rel, ctx)][:_DOCS]
    found_now = [h["path"] for h in _api_search(topic, _DOCS * 2, ctx) if not _hidden(h["path"], ctx)]
    now_docs = [(back.get(rel, rel), rel) for rel in found_now[:_DOCS]]
    # Then and now taken in turn, so the budget can't spend itself on one side before the other.
    pairs = list(dict.fromkeys(pair for both in zip_longest(then_docs, now_docs) for pair in both if pair))
    now_days, then_days, moments = _history({rel for pair in pairs for rel in pair}, terms, day)
    docs, more, room = [], [], _TOTAL_CHARS
    for then_rel, now_rel in pairs:
        then_text = _show(rev, "content/" + then_rel)
        now_text = _show(head, "content/" + now_rel)
        then = _passages(then_text, terms) if then_text else []
        now = _passages(now_text, terms) if now_text else []
        if not then and not now:
            continue
        path = now_rel if now_text is not None else then_rel
        size = sum(len(p["text"]) for p in then + ([] if now == then else now))
        if size > room:  # named, so the model knows it is there, but not quoted
            more.append(path)
            continue
        room -= size
        doc = {"path": path, **provenance.mark(now_rel)}
        if then:
            doc["then"] = {"date": then_days.get(then_rel, ""), "passages": then}
            if then_rel != path:
                doc["then"]["path"] = then_rel
        if now:
            doc["now"] = {"date": now_days.get(now_rel, "")}
            # Unchanged on the topic: said once, the model reads it as held.
            doc["now"].update({"same_as_then": True} if now == then else {"passages": now})
        if now_text is None:
            doc["gone"] = True
        docs.append(doc)
    found = {d["path"] for d in docs} | {d["then"]["path"] for d in docs if "path" in d.get("then", {})}
    moments = [{"date": m["date"], "docs": kept} for m in moments
               if (kept := [rel for rel in m["docs"] if rel in found])]
    # The next step first: with the passages in hand, a model is tempted to write the answer out.
    out = {"hint": ("Now call show_shift with the claims paired, one then and one now, each quoted word "
                    "for word from a passage below (… to skip words): it is how the user sees the answer. "
                    "A doc still stating the old side of a reversed, refined or dropped claim goes in "
                    "`lagging`, naming that claim in `echoes`. Then reply in a line or two."),
           "topic": topic, "at": day, "rev": rev[:12], "moments": moments, "docs": docs}
    if more:
        out["more"] = more
    return out


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
    """A quoted claim as shown: verified against `rev`, dated by the commit that wrote it (verify
    dates it by its doc's last change when blame can't tell)."""
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
    return {"path": rel, "quote": quote, "line": line, "date": "", **written}


def verify(args: dict, ctx=None) -> dict:
    topic = (args.get("topic") or "").strip()
    terms, day = _terms(topic), _day(args.get("at") or "")
    rev, head = _rev_at(day), _s.git("rev-parse", "HEAD").stdout.strip()
    shifts, rejected, shown_as = [], [], {}
    for i, pair in enumerate(args.get("shifts") or []):
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
        shown_as[i] = len(shifts)
        shifts.append(shown)
    lagging = []
    for doc in args.get("lagging") or []:
        # A doc is behind only if it still states the old side of a claim that moved: naming that
        # claim keeps an old doc that happens to agree with today from being flagged for its age.
        doc = doc if isinstance(doc, dict) else {}
        echoes = shown_as.get(doc.get("echoes"))
        if echoes is None or shifts[echoes]["badge"] not in _ECHOED:
            rejected.append({"side": "lagging", "path": doc.get("path", ""), "quote": doc.get("quote", ""),
                             "reason": "`echoes` must name the reversed, refined or dropped claim it repeats"})
            continue
        checked = _check(doc, head, ctx, rejected, "lagging")
        if checked:
            checked["echoes"] = echoes
            lagging.append(checked)
    sides = [(pair[kind], kind) for pair in shifts for kind in ("then", "now") if pair[kind]]
    sides += [(doc, "now") for doc in lagging]
    now_days, then_days, moments = _history({side["path"] for side, _ in sides}, terms, day)
    for side, kind in sides:
        side["date"] = side["date"] or (then_days if kind == "then" else now_days).get(side["path"], "")
    for doc in lagging:
        doc["last_modified"] = now_days.get(doc["path"], "")
    return {"topic": topic, "at": day, "today": dt.date.today().isoformat(), "moments": moments,
            "shifts": shifts, "lagging": lagging, "rejected": rejected}
