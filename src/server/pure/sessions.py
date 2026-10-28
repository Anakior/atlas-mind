"""Session saves: what an AI writes at the end of a work session so a later one can pick it up,
recognised by their "how to resume" section (the engine's ai-sessions/TEMPLATE.md and a mind's
own model share it). resume_session rebuilds what a resumption needs: the resume line, the open
points and how long each has been carried, what changed in the mind since (the docs the save
points to first), and the other saves its links tie it to."""
import datetime as dt
import re
from collections import Counter

import server as _s
from server.pure import provenance
from server.pure.git_history import _attributed_log, _doc_diff_between, _scrub_commits
from server.pure.prompts import PROMPTS_DIR
from server.pure.queries import _api_search, _headings, _visible

_RESUME_RE = re.compile(r"^#{1,3}\s+(?:\d+\.\s*)?(?:comment reprendre|how to resume)\b", re.I | re.M)
_OPEN_RE = re.compile(r"suspens|clarifier|loose ends?|open (?:points?|questions?)|reprendre la suite|"
                      r"ordre (?:exact )?de reprise|reprise du plan|prochaine?s? (?:étapes?|pas|actions?)|"
                      r"next steps?|non résolu|not resolved|todo|reste|restant|à faire|à décider|réserves|"
                      r"ne pas oublier|remaining|still to", re.I)
_TEMPLATES = {"template", "modele", "modèle", "model"}  # the models themselves have the section too
_ITEM_RE = re.compile(r"^(?:[-*+]|\d+[.)])\s+(.+)")
_SUBHEADING_RE = re.compile(r"^#{2,6}\s+(.+)")
_FOOTER_RE = re.compile(r"^\*Session (?:du|of|on)\s+(\d{4}-\d{2}-\d{2})\s*(?:\(([^)\n]*)\))?\.?\s*(.*?)\*\s*$",
                        re.M | re.S)
_FIELDS = {"machine": re.compile(r"\*\*Machine[^*\n]*\*\*\s*:\s*`([^`\n]+)`"),
           "project": re.compile(r"\*\*(?:Projet|Project)\*\*\s*:\s*`([^`\n]+)`"),
           "resume": re.compile(r"`([^`\n]*--resume[^`\n]*)`")}
_HISTORY_DEPTH = 30  # versions of a save read back to date its open points
_LISTED = 20  # pieces of work listed, each one line however many saves it took
_EXCERPT_LINES = 8  # changed lines shown per linked doc


def _is_save(rel: str, text: str) -> bool:
    """A doc with a resume section, but not a model of one nor a prompt that writes one."""
    stem = rel.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
    return (rel.endswith(".md") and stem not in _TEMPLATES and not rel.startswith(PROMPTS_DIR + "/")
            and _RESUME_RE.search(text) is not None)


def _clean(text: str, limit: int = 240) -> str:
    """Markdown as one plain line: [[a|b]] → b, [[a]] → a, no emphasis or code marks."""
    text = re.sub(r"\[\[([^\]|\n]+)\|([^\]\n]+)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]\n]+)\]\]", r"\1", text)
    text = " ".join(re.sub(r"[*_`]", "", text).split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def _key(text: str) -> str:
    """A point's identity across versions of its save."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", _s._normalize_text(text)).split())[:80]


def _spans(lines: list, pattern) -> list:
    """(start, end) line spans of the sections whose heading matches, nested matches folded in."""
    heads = list(_headings(lines))
    spans = []
    for k, (i, level, title) in enumerate(heads):
        if spans and i < spans[-1][1]:
            continue
        if pattern.search(title):
            spans.append((i, next((j for j, lv, _ in heads[k + 1:] if lv <= level), len(lines))))
    return spans


def _points(text: str) -> list:
    """The open points of a save: each list item of its open sections (its wrapped lines
    joined back), and each sub-heading that holds no list (a sub-heading over a list only
    groups it), with the wikilinks of its whole block."""
    lines = text.splitlines()
    wikilink = _s._import_build()._WIKILINK_RE
    points, seen = [], set()
    for start, end in _spans(lines, _OPEN_RE):
        group = current = lead = None
        fenced = False
        for line in lines[start + 1:end]:
            if line.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
                continue
            if fenced:
                continue
            heading, item = _SUBHEADING_RE.match(line), _ITEM_RE.match(line)
            nested = _ITEM_RE.match(line.lstrip()) if line[:1].isspace() else None
            if heading:
                group = _clean(heading.group(1))
                current = {"text": group, "links": [], "heading": True, "open": False}
                lead = None
                points.append(current)
            elif item:
                current = lead = {"text": item.group(1), "links": [], "open": True}
                if group:
                    current["group"] = group
                points.append(current)
            elif nested and lead is not None and _clean(lead["text"]).endswith(":"):
                # An item ending with a colon introduces a list: its sub-items are the points.
                lead["parent"] = True
                current = {"text": nested.group(1), "links": [], "open": True,
                           "group": _clean(lead["text"]).rstrip(" :")}
                points.append(current)
            elif current is not None and current["open"]:
                # A wrapped line continues the item; a blank line or a nested list ends its text.
                if line.strip() and not _ITEM_RE.match(line.lstrip()):
                    current["text"] += " " + line.strip()
                else:
                    current["open"] = False
            if current is not None:
                current["links"] += wikilink.findall(line)
    groups = {p.get("group") for p in points}
    out = []
    for p in points:
        is_heading, p["text"] = p.pop("heading", False), _clean(p["text"])
        is_parent = p.pop("parent", False)
        del p["open"]
        if is_parent or (is_heading and p["text"] in groups) or not p["text"] or _key(p["text"]) in seen:
            continue
        seen.add(_key(p["text"]))
        out.append(p)
    return out


def _parse(rel: str, text: str) -> dict:
    """What a save says about itself: title, summary, resume line, session date and state."""
    lines = text.splitlines()
    title = next((t for _, level, t in _headings(lines) if level == 1), rel)
    info = {"path": rel, "title": re.sub(r"^save(?: claude)?\s*[—:-]\s*", "", title, flags=re.I).strip()}
    quote = []
    for line in lines[next((i for i, ln in enumerate(lines) if ln.startswith("# ")), 0) + 1:]:
        if line.startswith(">"):
            quote.append(line.lstrip("> ").strip())
        elif quote or (line.strip() and not line.startswith("#")):
            break
    if quote:
        info["summary"] = _clean(" ".join(quote), 400)
    resume = next(iter(_spans(lines, re.compile(r"comment reprendre|how to resume", re.I))), None)
    where = "\n".join(lines[resume[0]:resume[1]]) if resume else text
    for name, rx in _FIELDS.items():
        m = rx.search(where)
        if m:
            info[name] = m.group(1).strip()
    footers = list(_FOOTER_RE.finditer(text))
    if footers:
        date, model, state = footers[-1].groups()
        info["session_date"] = date
        if model:
            info["model"] = model.strip()
        state = re.sub(r"^(?:État|Etat|State)\s*:\s*", "", " ".join(state.split()), flags=re.I)
        if state:
            info["state"] = state[:300]
    return info


def _versions(rel: str) -> list:
    """[(sha, ISO date)] of the commits that touched the save, newest first."""
    out = _s.git("log", "--follow", f"-n{_HISTORY_DEPTH}", "--format=%H%x1f%cI", "--",
                  "content/" + rel).stdout
    return [tuple(line.split("\x1f")) for line in out.splitlines() if "\x1f" in line]


def _carried(rel: str, current: list, versions: list) -> tuple:
    """Date each current point by the first version of the save that held it, and list the
    points an earlier version held that are gone now (closed, with when)."""
    first, closed, alive = {}, {}, {}
    for sha, date in reversed(versions):
        show = _s.git("show", f"{sha}:{_s._doc_path_at('content/' + rel, sha)}")
        keys = {_key(p["text"]): p["text"] for p in _points(show.stdout)} if show.returncode == 0 else {}
        for key, text in keys.items():
            first.setdefault(key, date)
            closed.pop(key, None)
        for key in set(alive) - set(keys):
            closed[key] = {"text": alive[key], "closed": date[:10]}
        alive = keys
    now = {_key(p["text"]) for p in current}
    for p in current:
        if _key(p["text"]) in first:
            p["since"] = first[_key(p["text"])][:10]
    return current, [c for k, c in closed.items() if k not in now]


def _resolve(targets, by_path: dict, by_stem: dict) -> list:
    resolve = _s._import_build()._resolve_wikilink
    return list(dict.fromkeys(p for p in (resolve(t, by_path, by_stem) for t in targets) if p))


def _what_changed(rel: str, base: str, head: str) -> dict:
    """How a doc moved between the save and now: +added −removed and its first changed lines,
    so the agent needn't run doc_diff to know whether it matters."""
    diff, added, removed = _doc_diff_between("content/" + rel, base, head)
    lines = [ln[:160] for ln in (diff or "").splitlines()
             if ln[:1] in "+-" and not ln.startswith(("+++", "---")) and ln[1:].strip()]
    out = {"diff": f"+{added} −{removed}"}
    if lines:
        out["excerpt"] = lines[:_EXCERPT_LINES]
    return out


def _days(iso: str) -> int:
    return (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(iso)).days


def _find_saves(ctx) -> tuple:
    """The saves ctx can read ({path: text}) and the path / stem maps that resolve wikilinks."""
    docs = [(rel, path) for rel, path in _s._iter_doc_files() if _visible(rel, ctx)]
    saves = {}
    for rel, path in docs:
        # The search cache already holds every doc folded: only a likely save is read in full.
        entry = _s._doc_entry(rel, path) if rel.endswith(".md") else None
        if entry and ("comment reprendre" in entry["content_n"] or "how to resume" in entry["content_n"]):
            text = path.read_text(encoding="utf-8")
            if _is_save(rel, text):
                saves[rel] = text
    by_path = {rel.lower(): rel for rel, _ in docs}
    by_stem = {}
    for rel, _ in docs:
        by_stem.setdefault(rel.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower(), rel)
    return saves, by_path, by_stem


def _chain(target: str, links: dict) -> set:
    """The saves tied to `target` by wikilinks, either way, step by step."""
    chain, todo = {target}, [target]
    while todo:
        rel = todo.pop()
        for other in links:
            if other not in chain and (other in links[rel] or rel in links[other]):
                chain.add(other)
                todo.append(other)
    return chain


def resume(args: dict, ctx) -> dict:
    """The resume_session payload. Raises ValueError with an actionable message."""
    from server.pure.mcp_call import _contested, _doc_changes, _last_commits  # lazy: mcp_call imports us
    saves, by_path, by_stem = _find_saves(ctx)
    wikilink = _s._import_build()._WIKILINK_RE
    links = {rel: _resolve(wikilink.findall(text), by_path, by_stem) for rel, text in saves.items()}
    last = _last_commits(list(saves))

    def card(rel, full=False):
        """A save in full (the one resumed), or as a line in a list (the others)."""
        info = _parse(rel, saves[rel])
        if not full:
            info = {k: info[k] for k in ("path", "title", "session_date", "state", "machine", "project") if k in info}
            if "state" in info:
                info["state"] = _clean(info["state"], 160)
        info["open_points"] = len(_points(saves[rel]))
        if rel in last:
            info["last_commit"] = dt.datetime.fromtimestamp(last[rel][0], dt.timezone.utc).strftime("%Y-%m-%d")
        return {**info, **provenance.mark(rel)}

    def recency(rel):  # when the save was last written: every save has it, not every footer
        return last.get(rel, (0,))[0]

    path, topic = (args.get("path") or "").strip(), (args.get("topic") or "").strip()
    if not saves:
        raise ValueError("No session save in this mind (a save is a doc with a 'How to resume' "
                         "section, e.g. from the save-session prompt).")
    candidates = []
    if path:
        if path.lower() not in by_path:
            raise ValueError(f"Document not found: {path}. Call resume_session without arguments "
                             "to list the saves.")
        if path not in saves:
            raise ValueError(f"{path} is not a session save (it has no 'How to resume' section).")
        target = path
    elif topic:
        hits = [h["path"] for h in _api_search(topic, len(saves), ctx, only=set(saves))]
        if not hits:
            raise ValueError(f"No session save matches '{topic}'. Call resume_session without "
                             "arguments to list the saves.")
        # The best match may be an older step of the same work: newer saves come first, for
        # the agent to judge (scores alone can't tell a continuation from a namesake).
        target = hits[0]
        newer = sorted((p for p in hits if recency(p) > recency(target)), key=recency, reverse=True)
        candidates = (newer + [p for p in hits[1:] if p not in newer])[:5]
    else:
        # One line per piece of work: a chain of saves shows as its latest step.
        works, seen = [], set()
        for rel in sorted(saves, key=recency, reverse=True):
            if len(works) == _LISTED:
                break
            if rel not in seen:
                chain = _chain(rel, links)
                seen |= chain
                works.append({**card(rel), **({"steps": len(chain)} if len(chain) > 1 else {})})
        return {"saves": works,
                "hint": "One line per piece of work, its latest save first (`steps`: how many saves "
                        "it took). Pass one as path (or a topic) to get its resumption."}

    text = saves[target]
    save = card(target, full=True)
    versions = _versions(target)
    if versions:
        save["paused_days"] = _days(versions[0][1])
    points, closed = _carried(target, _points(text), versions)
    commits = _scrub_commits(_attributed_log(f"{versions[0][0]}..HEAD") or [], ctx) if versions else []
    changed = {d["path"]: d for d in _doc_changes(commits) if d["path"] != target}
    for p in points:
        refs = _resolve(p.pop("links"), by_path, by_stem)
        if refs:
            p["refs"] = refs
            moved = [{"path": r, "date": changed[r]["date"][:10]} for r in refs if r in changed]
            if moved:
                p["refs_changed"] = moved
    linked = [r for r in links[target] if r != target]
    head = _s.git("rev-parse", "HEAD").stdout.strip()
    ai = Counter(c["ai"] for c in commits if c.get("ai"))
    since = {"commits": len(commits), "by_ai": dict(ai), "by_humans": len(commits) - sum(ai.values()),
             "linked": [{"path": r, "change": changed[r]["change"], "date": changed[r]["date"][:10],
                         **{k: changed[r][k] for k in ("last_editor", "ai") if k in changed[r]},
                         **(_what_changed(r, versions[0][0], head) if changed[r]["change"] == "modified" else {}),
                         **provenance.mark(r)}
                        for r in linked if r in changed],
             "unchanged": [r for r in linked if r not in changed] if versions else [],
             "elsewhere": len([r for r in changed if r not in linked])}
    contested = _contested(set(linked), ctx)
    if contested:
        since["contested"] = contested
    chain = _chain(target, links)
    payload = {"save": save, "open_points": points}
    if closed:
        payload["closed_points"] = closed
    payload["since"] = since
    if len(chain) > 1:
        payload["chain"] = [{**card(rel), **({"this": True} if rel == target else {})}
                            for rel in sorted(chain, key=recency)]
    if candidates:
        payload["other_matches"] = [{**{k: c[k] for k in ("path", "title", "last_commit") if k in c},
                                     **({"newer": True} if recency(c["path"]) > recency(target) else {})}
                                    for c in map(card, candidates)]
    return payload
