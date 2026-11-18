"""The reader (open_doc): a doc as it stands, with its history laid on its passages, for the
view beside the conversation. From the doc's own git log: each version split into passages (a
heading, a paragraph, a quote paragraph, a list item, a table, a code block), who last changed
each passage (blame), what changed since the reader last touched or confirmed the doc, the
passages a commit removed that never came back (ghosts), and each passage's life back through
the versions. Stdlib only (difflib); the history part is cached per doc and HEAD."""
import base64
import datetime
import difflib
import mimetypes
import posixpath
import re
import threading
from collections import OrderedDict
from urllib.parse import unquote

import server as _s
from server.pure import attestations, docs
from server.pure.queries import _corpus, _reader_memo, _visible

MAX_VERSIONS = 40  # the newest ones; an older passage still gets its author from blame
_MAX_CHARS = 250_000  # the versions' distinct passages, all sent to the view: past it, the oldest go
_KEEP = .55  # alike enough to be the same passage reworded, against the doc as it stands
_STEP = .5  # the same, from one version to the next
_REWORDED = .3  # a passage a rewrite wrote in place of one it removed
_REWRITE = .4  # a commit removing this share of the doc rewrote it: one ghost, not dozens
_MIN_WORDS = 4  # shorter passages match word for word or not at all
_MAX_IMAGE = 1 << 20
_MAX_IMAGES = 2 << 20

# A separator keeps the trailer from ending its value with a line feed, which ends the header.
_LOG_FORMAT = "%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%(trailers:key=X-Atlas-Author,valueonly,separator=%x2C)%x1f%s"
_BLAME_RE = re.compile(r"^[0-9a-f]{40} \d+ \d+")
_LIST_RE = re.compile(r"^ ?([-*+]|\d+[.)])\s")
_RULE_RE = re.compile(r"^(-{3,}|\*{3,}|_{3,})\s*$")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\((<[^>\n]+>|[^)\s]+)\)")
_EXTERNAL_RE = re.compile(r"^[a-z][a-z0-9+.-]*:|^/|^#", re.I)

_cache: OrderedDict = OrderedDict()
_CACHE_SIZE = 16
_lock = threading.Lock()


def passages(text: str) -> list:
    """(passage, first line, last line) of a Markdown doc, its frontmatter left out."""
    lines = text.split("\n")
    start = 0
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        start = end + 1 if end is not None else 0
    out, cur, first, fence = [], [], 0, False

    def flush(last):
        if cur:
            out.append(("\n".join(cur), first, last))
        cur.clear()

    for i in range(start, len(lines)):
        line = lines[i]
        if fence:
            cur.append(line)
            if line.lstrip().startswith(("```", "~~~")):
                fence = False
                flush(i)
            continue
        if line.lstrip().startswith(("```", "~~~")):
            flush(i - 1)
            cur.append(line)
            first, fence = i, True
            continue
        if not line.strip() or line.strip() == ">":
            flush(i - 1)
            continue
        single = line.startswith("#") or bool(_RULE_RE.match(line))
        kind_changes = cur and (cur[0].startswith(">") != line.startswith(">")
                                or cur[0].startswith("|") != line.startswith("|"))
        if single or _LIST_RE.match(line) or kind_changes or not cur:
            flush(i - 1)
            cur.append(line)
            first = i
        else:
            cur.append(line)
        if single:
            flush(i)
    flush(len(lines) - 1)
    return out


def _norm(text: str) -> str:
    return " ".join(text.split())


class _Matcher:
    """Finds a passage again in a version: word for word first, else the closest one worded
    alike enough. Each pool's index is built once (and the pool kept, so its id stays its own)."""

    def __init__(self):
        self._index = {}

    def find(self, text: str, pool: list, floor: float):
        entry = self._index.get(id(pool))
        if entry is None:
            entry = self._index[id(pool)] = (pool, {t: j for j, t in reversed(list(enumerate(pool)))})
        if text in entry[1]:
            return entry[1][text]
        words = text.split(" ")
        if len(words) < _MIN_WORDS:
            return None
        best, at = floor, None
        for j, other in enumerate(pool):
            other_words = other.split(" ")
            if len(other_words) < _MIN_WORDS:
                continue
            m = difflib.SequenceMatcher(None, words, other_words, autojunk=False)
            if m.real_quick_ratio() >= best and m.quick_ratio() >= best:
                ratio = m.ratio()
                if ratio >= best:
                    best, at = ratio, j
        return at


def word_diff(old: str, new: str, context: int = 9) -> list:
    """[op, words] runs, op '=', '-' or '+'; long unchanged runs cut to their ends."""
    a, b = old.split(" "), new.split(" ")
    runs = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == "equal":
            words = a[i1:i2]
            if len(words) > 2 * context:
                words = (words[:context] if runs else []) + ["…"] + words[-context:]
            runs.append(["=", " ".join(words)])
            continue
        if i2 > i1:
            runs.append(["-", " ".join(a[i1:i2])])
        if j2 > j1:
            runs.append(["+", " ".join(b[j1:j2])])
    if runs and runs[-1][0] == "=":
        tail = runs[-1][1].split(" ")
        if len(tail) > context:
            runs[-1][1] = " ".join(tail[:context] + ["…"])
    return runs


def _commit(fields: list) -> dict:
    sha, date, author, email, trailer, subject = (fields + [""] * 6)[:6]
    try:
        t = int(datetime.datetime.fromisoformat(date).timestamp())
    except ValueError:
        t = 0
    return {"sha": sha, "date": date, "t": t, "author": author, "email": email.lower(),
            "ai": _s.parse_ai_trailer(trailer.split(",")[0]), "subject": subject}


def _log(repo_rel: str) -> list:
    """The doc's newest MAX_VERSIONS commits, oldest first, each with the doc's text after it,
    in ONE git call: with a context wider than any doc, each commit's diff holds the whole file.
    A commit that changed no line (a move) keeps the text before it."""
    result = _s.git("log", "--follow", f"-n{MAX_VERSIONS}", "-p", "--unified=10000000",
                    "--no-color", "--no-ext-diff", "--format=" + _LOG_FORMAT, "--", repo_rel)
    if result.returncode != 0:
        return []
    commits = []
    for record in result.stdout.split("\x1e")[1:]:
        head, _, diff = record.partition("\n")
        hunk = diff.split("\n@@", 1)
        text, plus, minus = None, 0, 0
        if len(hunk) == 2:
            kept = []
            for line in hunk[1].split("\n")[1:]:
                mark = line[:1]
                plus += mark == "+"
                minus += mark == "-"
                if mark in (" ", "+"):
                    kept.append(line[1:])
            text = "\n".join(kept).replace("\r", "")
        commits.append({**_commit(head.split("\x1f")), "plus": plus, "minus": minus, "text": text})
    commits.reverse()
    for i, commit in enumerate(commits):
        if commit["text"] is None:
            commit["text"] = commits[i - 1]["text"] if i else ""
    return commits


def _blame(repo_rel: str) -> list:
    """The sha that last changed each line of the doc at HEAD."""
    result = _s.git("blame", "--line-porcelain", "HEAD", "--", repo_rel)
    if result.returncode != 0:
        return []
    return [line[:40] for line in result.stdout.split("\n") if _BLAME_RE.match(line)]


def _runs(indices: list) -> list:
    groups = []
    for i in indices:
        if groups and groups[-1][-1] == i - 1:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


class _History:
    """The versions of one doc, passage by passage, and what links them."""

    def __init__(self, log: list, complete: bool):
        self.complete = complete  # the oldest version is the doc's first
        self.raw = [[p for p, _, _ in passages(c["text"])] for c in log]
        self.norm = [[_norm(p) for p in v] for v in self.raw]
        self.head = self.norm[-1]
        self.head_set = set(self.head)
        self.match = _Matcher()
        self.strings, self._ids, self._fates, self._removed, self._written = [], {}, {}, {}, {}

    def sid(self, text: str) -> int:
        if text not in self._ids:
            self._ids[text] = len(self.strings)
            self.strings.append(text)
        return self._ids[text]

    def fate(self, text: str) -> str:
        """k: still in the doc word for word; c: reworded since; r: removed since."""
        if text not in self._fates:
            self._fates[text] = ("k" if text in self.head_set
                                 else "c" if self.match.find(text, self.head, _KEEP) is not None else "r")
        return self._fates[text]

    def removed(self, v: int) -> list:
        """The passages of version v-1 that version v removed for good."""
        if v not in self._removed:
            self._removed[v] = [t for t in self.norm[v - 1]
                                if self.fate(t) == "r" and self.match.find(t, self.norm[v], _STEP) is None]
        return self._removed[v]

    def written(self, v: int) -> list:
        """The passages version v wrote, found in no form in the version before."""
        if v not in self._written:
            self._written[v] = [t for t in self.norm[v] if self.match.find(t, self.norm[v - 1], _STEP) is None]
        return self._written[v]

    def ghosts(self) -> list:
        """The runs of passages a commit removed for good. One the same commit rewrote in place
        is no ghost: the passage written instead shows it in its life."""
        out = []
        for v in range(1, len(self.norm)):
            before = self.norm[v - 1]
            gone_set, written = set(self.removed(v)), self.written(v)
            gone = [i for i, t in enumerate(before)
                    if t in gone_set and self.match.find(t, written, _REWORDED) is None]
            if len(gone) > _REWRITE * len(before):
                out.append({"c": v, "after": -1, "rewrite": True, "s": [self.sid(self.raw[v - 1][i]) for i in gone]})
                continue
            for group in _runs(gone):
                after_unit = self._anchor(before, group[0])
                last = out[-1] if out else None
                ids = [self.sid(self.raw[v - 1][i]) for i in group]
                if last and last["c"] == v and last["after"] == after_unit and not last.get("rewrite"):
                    last["s"] += ids
                else:
                    out.append({"c": v, "after": after_unit, "s": ids})
        return out

    def _anchor(self, before: list, start: int) -> int:
        """The passage of the doc as it stands that a removed run followed: the nearest one
        before it that survived and says enough to be found again (-1: the top)."""
        for k in range(start - 1, -1, -1):
            text = before[k]
            if self.fate(text) != "r" and len(text.split(" ")) >= _MIN_WORDS:
                found = self.match.find(text, self.head, _KEEP)
                return -1 if found is None else found
        return -1

    def life(self, h: int) -> list:
        """A passage of the doc as it stands, back through the versions: each rewording, the
        passage a rewrite put it in place of, and its first version (`c` None when it
        predates the versions kept)."""
        events, cur, v = [], self.head[h], len(self.norm) - 1
        while v > 0:
            pool = self.norm[v - 1]
            at = self.match.find(cur, pool, _STEP)
            if at is None:  # absent from the version before: written in place of a passage removed then?
                removed = self.removed(v)
                found = self.match.find(cur, removed, _REWORDED)
                if found is None:
                    break
                at = pool.index(removed[found])
                events.append({"c": v, "from": self.sid(self.raw[v - 1][at]), "diff": word_diff(pool[at], cur)})
            elif pool[at] != cur:
                events.append({"c": v, "diff": word_diff(pool[at], cur)})
            cur, v = pool[at], v - 1
        events.append({"c": v if v > 0 or self.complete else None, "born": True})
        return events[::-1]


def _history(rel: str) -> dict:
    """The part of the reader that depends only on the doc and HEAD."""
    repo_rel = "content/" + rel
    log = _log(repo_rel)
    if not log:
        return {"commits": [], "strings": [], "versions": [], "passages": [], "ghosts": [], "complete": False}
    complete = len(log) < MAX_VERSIONS
    seen, chars, keep = set(), 0, 0
    for c in reversed(log):  # the newest versions first, while their distinct passages fit
        new = {p for p, _, _ in passages(c["text"])} - seen
        chars += sum(map(len, new))
        if keep and chars > _MAX_CHARS:
            log, complete = log[len(log) - keep:], False
            break
        seen |= new
        keep += 1
    commits = [{k: v for k, v in c.items() if k != "text"} for c in log]
    by_sha = {c["sha"]: i for i, c in enumerate(commits)}
    blame = _blame(repo_rel)
    older = sorted({sha for sha in blame if sha not in by_sha})
    if older:  # lines older than the versions kept: their commits, without a version
        shown = _s.git("show", "-s", "--format=" + _LOG_FORMAT, *older)
        for record in shown.stdout.split("\x1e")[1:] if shown.returncode == 0 else []:
            commit = _commit(record.strip("\n").split("\x1f"))
            by_sha[commit["sha"]] = len(commits)
            commits.append({**commit, "plus": None, "minus": None})

    hist = _History(log, complete)
    versions = [{"c": i, "s": [hist.sid(p) for p in hist.raw[i]], "fate": "".join(hist.fate(t) for t in hist.norm[i])}
                for i in range(len(log))]
    ghosts = hist.ghosts()
    line_commit = [by_sha.get(sha) for sha in blame]
    rows = []
    for h, (text, first, last) in enumerate(passages(log[-1]["text"])):
        touched = {line_commit[k] for k in range(first, min(last + 1, len(line_commit)))} - {None}
        newest = max(touched, key=lambda i: commits[i]["t"]) if touched else None
        rows.append({"s": hist.sid(text), "c": newest, "life": hist.life(h)})
    return {"commits": commits, "strings": hist.strings, "versions": versions, "passages": rows,
            "ghosts": ghosts, "complete": complete}


def history(rel: str) -> dict:
    head = _s.git("rev-parse", "HEAD").stdout.strip()
    with _lock:
        hit = _cache.get((rel, head))
        if hit is not None:
            _cache.move_to_end((rel, head))
            return hit
    result = _history(rel)
    with _lock:
        _cache[(rel, head)] = result
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return result


def _person(ctx):
    primary = getattr(ctx, "primary", None) or ""
    return primary[len("user:"):].lower() if primary.startswith("user:") else None


def _last_look(rel: str, commits: list, you) -> dict:
    """The reader's last look at the doc: their last own edit, or a person's confirmation
    (a confirmation does not say whose), whichever came last."""
    own = [i for i, c in enumerate(commits) if you and c["email"] == you and not c["ai"]]
    edit = max(own, key=lambda i: commits[i]["t"]) if own else None
    entry = attestations.load().get(rel)
    confirmed = entry.get("at") if entry and entry.get("by") == "human" else None
    if confirmed and (edit is None or confirmed > commits[edit]["t"]):
        return {"how": "confirm", "at": confirmed, "commit": None}
    if edit is not None:
        return {"how": "edit", "at": commits[edit]["t"], "commit": edit}
    return {"how": None, "at": None, "commit": None}


def _images(rel: str, texts: list, ctx) -> dict:
    """The pictures the doc shows, beside it in the mind and readable here, inlined: the view
    reaches nothing. Past the budget, the view shows their alt text."""
    out, total = {}, 0
    for text in texts:
        for m in _IMAGE_RE.finditer(text):
            dest = m.group(1).strip("<>")
            if dest in out or _EXTERNAL_RE.match(dest):
                continue
            path = posixpath.normpath(posixpath.join(posixpath.dirname(rel), unquote(dest)))
            target = docs.content_file(path, _s.CONFIG.content_root)
            mime = mimetypes.guess_type(path)[0] or ""
            if target is None or not mime.startswith("image/") or not _visible(path, ctx):
                continue
            size = target.stat().st_size
            if size > _MAX_IMAGE or total + size > _MAX_IMAGES:
                continue
            total += size
            out[dest] = f"data:{mime};base64," + base64.b64encode(target.read_bytes()).decode("ascii")
    return out


def _links(texts: list, ctx) -> dict:
    """Each [[wikilink]] of the doc (lowercased) → the path it opens, when the reader may read it."""
    build = _s._import_build()
    corpus = _corpus(_reader_memo(ctx), ctx)
    by_path = {p.lower(): p for p, _, _ in corpus}
    by_stem = {}
    for p, name, _ in corpus:
        by_stem.setdefault(re.sub(r"\.md$", "", name, flags=re.I).lower(), p)
    out = {}
    for text in texts:
        for m in build._WIKILINK_RE.finditer(text):
            target = m.group(1).split("|", 1)[0].strip()
            path = build._resolve_wikilink(target, by_path, by_stem)
            if path:
                out[target.lower()] = path
    return out


def open_doc(rel: str, version: str, ctx) -> dict:
    """What the reader view shows of `rel` for `ctx`: its history, the reader's last look and
    what changed since, its pictures and links resolved."""
    hist = history(rel)
    commits = hist["commits"]
    you = _person(ctx)
    look = _last_look(rel, commits, you)

    def since_look(i):
        return (i is not None and look["at"] is not None and commits[i]["t"] > look["at"]
                and not (commits[i]["email"] == you and not commits[i]["ai"]))

    head = [hist["strings"][p["s"]] for p in hist["passages"]]
    return {**hist, "path": rel, "version": version, "look": look,
            # The view tells the reader's own changes apart; it needs nobody's email for that.
            "commits": [{**{k: v for k, v in c.items() if k != "email"},
                         "you": bool(you) and c["email"] == you and not c["ai"]} for c in commits],
            "title": next((t[2:].strip() for t in head if t.startswith("# ")), rel.rsplit("/", 1)[-1]),
            "passages": [{**p, "since": since_look(p["c"])} for p in hist["passages"]],
            "ghosts": [{**g, "since": since_look(g["c"])} for g in hist["ghosts"]],
            "images": _images(rel, head, ctx), "links": _links(head, ctx)}


def summary(view: dict) -> str:
    """What the model reads of the view: where it is and what changed, not the doc."""
    commits = view["commits"]
    changed = [p for p in view["passages"] if p["since"]]
    removed = sum(len(g["s"]) for g in view["ghosts"] if g["since"])
    lines = [f"Showing {view['path']} (\"{view['title']}\") to the user in a view: "
             f"{len(view['versions'])} versions shown, version {view['version']}."]
    look = view["look"]
    if look["at"] is None:
        lines.append("The user never edited or confirmed this doc.")
    elif changed or removed:
        who = sorted({commits[p["c"]]["ai"] or commits[p["c"]]["author"] for p in changed})
        lines.append(f"Since the user last {'confirmed' if look['how'] == 'confirm' else 'edited'} it: "
                     f"{len(changed)} passages changed (by {', '.join(who) or 'others'}), {removed} removed.")
    else:
        lines.append("Nothing changed since the user last edited or confirmed it.")
    heads = [view["strings"][p["s"]].lstrip("#").strip() for p in view["passages"]
             if view["strings"][p["s"]].startswith("#")]
    if heads:
        lines.append("Outline: " + " / ".join(heads[:24]))
    lines.append("The view shows the doc and its history; read_doc reads its text. Reply in a line or two.")
    return "\n".join(lines)
